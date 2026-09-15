//! Desktop update checks and installs.
//!
//! The replaced Electron shell ran `electron-updater` behind a coordinator that
//! reported `idle`, `checking`, `available`, `installing`, `ready`, and `error`,
//! announced a version only once a check had verified it, and installed nothing
//! it had not announced. This module keeps that state machine over the Tauri
//! updater. A build without an update endpoint answers `idle` rather than
//! failing, matching the Electron coordinator, which reported `idle` when its
//! build carried no update configuration.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Phase a page or dialog renders.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    /// Nothing checked yet, no release available, or this build cannot update.
    Idle,
    /// A check is in flight.
    Checking,
    /// A verified release is available.
    Available,
    /// The verified release is downloading or installing.
    Installing,
    /// The release installed and the application is restarting.
    Ready,
    /// The check or the install failed.
    Error,
}

/// Serializable update state published to pages and dialogs.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// Current phase.
    pub phase: UpdatePhase,
    /// Release version the phase refers to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Failure diagnostics, present in the error phase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl UpdateState {
    fn idle() -> Self {
        Self { phase: UpdatePhase::Idle, version: None, message: None }
    }

    fn checking() -> Self {
        Self { phase: UpdatePhase::Checking, version: None, message: None }
    }

    fn available(version: String) -> Self {
        Self { phase: UpdatePhase::Available, version: Some(version), message: None }
    }

    fn installing(version: String) -> Self {
        Self { phase: UpdatePhase::Installing, version: Some(version), message: None }
    }

    fn ready(version: String) -> Self {
        Self { phase: UpdatePhase::Ready, version: Some(version), message: None }
    }

    fn error(message: String, version: Option<String>) -> Self {
        Self { phase: UpdatePhase::Error, version, message: Some(message) }
    }
}

/// Update state shared by the commands, the menu, and the pages.
pub struct UpdateStatus(Mutex<UpdateState>);

impl Default for UpdateStatus {
    fn default() -> Self {
        Self(Mutex::new(UpdateState::idle()))
    }
}

impl UpdateStatus {
    /// Replace the published state and answer with it.
    fn publish(&self, state: UpdateState) -> UpdateState {
        *self.0.lock().unwrap() = state.clone();
        state
    }

    /// Current state.
    fn current(&self) -> UpdateState {
        self.0.lock().unwrap().clone()
    }
}

/// Check the configured release stream for a newer version.
///
/// @returns the resulting state; failures are reported in the state rather than
/// as command errors, because every caller renders the phase.
#[tauri::command]
pub async fn updates_check(app: AppHandle) -> UpdateState {
    let status = app.state::<UpdateStatus>();
    status.publish(UpdateState::checking());
    let Ok(updater) = app.updater() else {
        // A build without an endpoint cannot update itself.
        return status.publish(UpdateState::idle());
    };
    match updater.check().await {
        Ok(Some(update)) => status.publish(UpdateState::available(update.version.to_string())),
        Ok(None) => status.publish(UpdateState::idle()),
        Err(error) => status.publish(UpdateState::error(error.to_string(), None)),
    }
}

/// Install the release the last check announced, then restart the application.
///
/// @returns the resulting state; a successful install restarts the application
/// instead of returning.
#[tauri::command]
pub async fn updates_install(app: AppHandle) -> UpdateState {
    let status = app.state::<UpdateStatus>();
    let version = match requested_install(&status.current()) {
        Ok(version) => version,
        Err(state) => return status.publish(state),
    };
    status.publish(UpdateState::installing(version.clone()));
    let Ok(updater) = app.updater() else {
        return status.publish(UpdateState::error(
            "desktop update: this build carries no update endpoint".to_string(),
            Some(version),
        ));
    };
    let update = match updater.check().await {
        Ok(Some(update)) if update.version.to_string() == version => update,
        Ok(_) => {
            return status.publish(UpdateState::error(
                "desktop update: the announced release is no longer available".to_string(),
                Some(version),
            ))
        }
        Err(error) => return status.publish(UpdateState::error(error.to_string(), Some(version))),
    };
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            status.publish(UpdateState::ready(version));
            app.restart()
        }
        Err(error) => status.publish(UpdateState::error(error.to_string(), Some(version))),
    }
}

/// Report the last update state to a page.
#[tauri::command]
pub fn updates_state(status: tauri::State<'_, UpdateStatus>) -> UpdateState {
    status.current()
}

/// The release an install applies to: the version the last check announced and
/// published, or the error state to publish when nothing verified is available.
///
/// The install path never downloads a release a check did not announce, which
/// is what the replaced Electron coordinator guaranteed.
fn requested_install(current: &UpdateState) -> Result<String, UpdateState> {
    match &current.version {
        Some(version) => Ok(version.clone()),
        None => Err(UpdateState::error(
            "desktop update: no verified update is available".to_string(),
            None,
        )),
    }
}

/// Check for updates from the tray and offer the install, as the Electron menu did.
pub fn check_and_prompt(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let messages = crate::locale::current().messages;
        let state = updates_check(app.clone()).await;
        match state.phase {
            UpdatePhase::Available => {
                let version = state.version.clone().unwrap_or_default();
                let message = format!(
                    "{}\n\n{}",
                    messages["updateAvailable"],
                    messages["updateDetail"].replace("{version}", &version),
                );
                let prompt = app.clone();
                app.dialog()
                    .message(message)
                    .title(messages["updateTitle"])
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        messages["installAndRestart"].to_string(),
                        messages["later"].to_string(),
                    ))
                    .show(move |install| {
                        if !install {
                            return;
                        }
                        let install_app = prompt.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = updates_install(install_app.clone()).await;
                            if state.phase == UpdatePhase::Error {
                                let messages = crate::locale::current().messages;
                                install_app
                                    .dialog()
                                    .message(state.message.unwrap_or_else(|| messages["unknownError"].to_string()))
                                    .title(messages["updateFailedTitle"])
                                    .kind(MessageDialogKind::Error)
                                    .show(|_| {});
                            }
                        });
                    });
            }
            UpdatePhase::Error => {
                app.dialog()
                    .message(state.message.unwrap_or_else(|| messages["unknownError"].to_string()))
                    .title(messages["updateCheckFailedTitle"])
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
            _ => {
                app.dialog()
                    .message(messages["updateCurrent"])
                    .title(messages["updateCheckTitle"])
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_the_announced_release() {
        let status = UpdateStatus::default();
        assert_eq!(status.current().phase, UpdatePhase::Idle);
        let available = status.publish(UpdateState::available("0.2.0".to_string()));
        assert_eq!(available.phase, UpdatePhase::Available);
        assert_eq!(status.current().version.as_deref(), Some("0.2.0"));
    }

    #[test]
    fn reports_phases_the_pages_render() {
        let json = serde_json::to_value(UpdateState::error("no endpoint".to_string(), None)).unwrap();
        assert_eq!(json["phase"], "error");
        assert_eq!(json["message"], "no endpoint");
        assert_eq!(json.get("version"), None);
        assert_eq!(serde_json::to_value(UpdateState::checking()).unwrap()["phase"], "checking");
        let installing = serde_json::to_value(UpdateState::installing("0.2.0".to_string())).unwrap();
        assert_eq!(installing["phase"], "installing");
        assert_eq!(installing["version"], "0.2.0");
    }

    #[test]
    fn installs_only_the_release_a_check_announced() {
        let version = requested_install(&UpdateState::available("0.2.0".to_string())).unwrap();
        assert_eq!(version, "0.2.0");
    }

    #[test]
    fn refuses_an_install_without_an_announced_release() {
        for current in [UpdateState::idle(), UpdateState::error("check failed".to_string(), None)] {
            let error = requested_install(&current).unwrap_err();
            assert_eq!(error.phase, UpdatePhase::Error);
            assert_eq!(error.message.as_deref(), Some("desktop update: no verified update is available"));
            assert_eq!(error.version, None);
        }
    }
}
