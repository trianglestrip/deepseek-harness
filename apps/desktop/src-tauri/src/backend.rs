//! Backend availability the shell's own pages render, and the retry they offer.
//!
//! The replaced Electron shell exposed `backendStatus` and `backendRetry` so its
//! startup page could report why the backend was unavailable and retry without
//! relaunching the application. This module owns the same facts for the pages
//! the Tauri shell serves.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::supervisor;

/// Availability phase of the application backend.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendPhase {
    /// The backend is starting or restarting.
    Starting,
    /// The backend accepts application requests.
    Ready,
    /// The backend failed; `message` carries the diagnostics.
    Error,
}

/// Serializable backend availability published to the shell's pages.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendState {
    /// Current phase.
    pub phase: BackendPhase,
    /// Failure diagnostics, present in the error phase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Whether this application can rebuild the desktop profile, which is what
    /// the reset action requires.
    pub profile_recovery: bool,
}

impl BackendState {
    /// Availability while the backend starts.
    pub fn starting() -> Self {
        Self { phase: BackendPhase::Starting, message: None, profile_recovery: false }
    }

    /// Availability once the backend accepts requests.
    pub fn ready() -> Self {
        Self { phase: BackendPhase::Ready, message: None, profile_recovery: false }
    }

    /// Availability after a failure, with the diagnostics a page renders.
    pub fn error(message: &str, profile_recovery: bool) -> Self {
        Self {
            phase: BackendPhase::Error,
            message: Some(message.to_string()),
            profile_recovery,
        }
    }
}

/// Backend availability shared by the shell and every page it serves.
pub struct BackendStatus(Mutex<BackendState>);

impl Default for BackendStatus {
    fn default() -> Self {
        Self(Mutex::new(BackendState::starting()))
    }
}

impl BackendStatus {
    /// Replace the published availability.
    pub fn publish(&self, state: BackendState) {
        *self.0.lock().unwrap() = state;
    }

    /// Current availability.
    pub fn current(&self) -> BackendState {
        self.0.lock().unwrap().clone()
    }
}

/// Whether the packaged runtime this application carries can rebuild a profile.
///
/// A linked development runtime answers `false`, matching the Electron shell,
/// which offered the reset action only in a packaged application.
pub fn profile_recovery_available(app: &AppHandle) -> bool {
    matches!(supervisor::host_launch(app), Some(launch) if !launch.allow_linked)
}

/// Publish availability while the backend starts.
pub fn publish_starting(app: &AppHandle) {
    app.state::<BackendStatus>().publish(BackendState::starting());
}

/// Publish availability once the backend accepts requests.
pub fn publish_ready(app: &AppHandle) {
    app.state::<BackendStatus>().publish(BackendState::ready());
}

/// Publish a failure with the diagnostics a page renders.
pub fn publish_error(app: &AppHandle, message: &str) {
    let state = BackendState::error(message, profile_recovery_available(app));
    app.state::<BackendStatus>().publish(state);
}

/// Report current backend availability to a page.
#[tauri::command]
pub fn backend_status(status: State<'_, BackendStatus>) -> BackendState {
    status.current()
}

/// Stop the backend and start it again, as the startup page's retry action.
#[tauri::command]
pub fn backend_retry(app: AppHandle) {
    crate::shell::restart(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_error_phase_with_its_diagnostics() {
        let state = BackendState::error("composition failed", true);
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["phase"], "error");
        assert_eq!(json["message"], "composition failed");
        assert_eq!(json["profileRecovery"], true);
    }

    #[test]
    fn omits_the_message_outside_the_error_phase() {
        let json = serde_json::to_value(BackendState::starting()).unwrap();
        assert_eq!(json["phase"], "starting");
        assert_eq!(json.get("message"), None);
        assert_eq!(json["profileRecovery"], false);
        assert_eq!(serde_json::to_value(BackendState::ready()).unwrap()["phase"], "ready");
    }

    #[test]
    fn publishes_the_latest_availability() {
        let status = BackendStatus::default();
        assert_eq!(status.current().phase, BackendPhase::Starting);
        status.publish(BackendState::ready());
        assert_eq!(status.current().phase, BackendPhase::Ready);
        status.publish(BackendState::error("broken", false));
        assert_eq!(status.current().message.as_deref(), Some("broken"));
    }
}
