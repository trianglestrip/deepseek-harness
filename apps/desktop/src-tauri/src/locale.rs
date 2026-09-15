//! Copy owned by the desktop shell and read by its pages and its tray.
//!
//! The replaced Electron shell kept this dictionary in its main process and
//! served it to pages through `localeGet`; the Tauri shell keeps the same
//! arrangement so the tray, the loading page, and the plugin window cannot
//! drift apart. Pages pass the language tags their WebView reports, which is
//! the same source the Harness Web UI reads, so both resolve alike.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;

/// Locale identifier the pages receive.
type LocaleId = &'static str;

/// English copy; every other locale supplies this complete key set.
const EN: &[(&str, &str)] = &[
    ("application", "Application"),
    ("startupFailed", "DeepSeek Harness could not start"),
    ("startupLoading", "Starting DeepSeek Harness…"),
    ("startupLoadingDescription", "Your workspace will open when it is ready."),
    ("startupErrorDescription", "Choose a recovery action below. Disabling third-party plugins retains their files."),
    ("startupReinstallAdvice", "If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately."),
    ("startupConfigurationAdvice", "Reset Desktop deletes all Desktop profile configuration and third-party plugins without a backup, then starts a fresh profile. Shared tasks and settings are retained."),
    ("restartApplication", "Close and restart"),
    ("retry", "Retry startup"),
    ("disableAll", "Disable all plugins and retry"),
    ("resetConfiguration", "Reset Desktop and retry"),
    ("recoveryDescription", "The backend could not start. Update or disable incompatible plugins, then retry. Installed plugins and configuration are retained."),
    ("unknownError", "Unknown error"),
    ("pluginManagerTitle", "Desktop Plugins"),
    ("pluginWindowTitle", "DeepSeek Harness — Desktop Plugins"),
    ("pluginManagerDescription", "Plugins are installed only in the Desktop node_modules and are managed by the bundled pnpm."),
    ("loadingPlugins", "Reading Desktop plugins…"),
    ("noPlugins", "No Desktop plugins are installed."),
    ("refresh", "Refresh"),
    ("refreshing", "Refreshing…"),
    ("refreshed", "Plugin list refreshed."),
    ("enable", "Enable"),
    ("disable", "Disable"),
    ("disabled", "Disabled"),
    ("changingActivation", "Changing plugin activation…"),
    ("npmPackage", "npm package"),
    ("install", "Install"),
    ("installed", "Installed"),
    ("remove", "Remove"),
    ("update", "Update"),
    ("targetVersion", "Enter the target version for {name}"),
    ("removing", "Removing {name}…"),
    ("updating", "Updating {name}…"),
    ("installing", "Installing {spec}…"),
    ("operationComplete", "Done. The Desktop backend has restarted."),
];

/// Chinese copy.
const ZH_CN: &[(&str, &str)] = &[
    ("application", "应用"),
    ("startupFailed", "DeepSeek Harness 无法启动"),
    ("startupLoading", "正在启动 DeepSeek Harness…"),
    ("startupLoadingDescription", "准备就绪后将自动打开工作区。"),
    ("startupErrorDescription", "请选择下方的恢复操作。禁用第三方插件会保留插件文件。"),
    ("startupReinstallAdvice", "如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。"),
    ("startupConfigurationAdvice", "重置 Desktop 会删除桌面端的全部 profile 配置和第三方插件，不保留备份，然后重新初始化并启动。共享任务和设置会保留。"),
    ("restartApplication", "关闭并重启"),
    ("retry", "重试启动"),
    ("disableAll", "禁用全部插件并重试"),
    ("resetConfiguration", "重置 Desktop 并重试"),
    ("recoveryDescription", "后端无法启动。请更新或禁用不兼容插件，然后重试。已安装插件和配置会保留。"),
    ("unknownError", "未知错误"),
    ("pluginManagerTitle", "桌面插件"),
    ("pluginWindowTitle", "DeepSeek Harness — 桌面插件"),
    ("pluginManagerDescription", "插件只安装到桌面端自己的 node_modules，并由内置 pnpm 管理。"),
    ("loadingPlugins", "正在读取桌面插件…"),
    ("noPlugins", "还没有安装桌面插件。"),
    ("refresh", "刷新"),
    ("refreshing", "正在刷新…"),
    ("refreshed", "插件列表已刷新。"),
    ("enable", "启用"),
    ("disable", "禁用"),
    ("disabled", "已禁用"),
    ("changingActivation", "正在更改插件启用状态…"),
    ("npmPackage", "npm 包"),
    ("install", "安装"),
    ("installed", "已安装"),
    ("remove", "移除"),
    ("update", "更新"),
    ("targetVersion", "输入 {name} 的目标版本"),
    ("removing", "正在移除 {name}…"),
    ("updating", "正在更新 {name}…"),
    ("installing", "正在安装 {spec}…"),
    ("operationComplete", "操作完成，桌面后端已重新启动。"),
];

/// One locale and its complete message set, as a page receives it.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct DesktopLocale {
    /// Locale identifier, `en` or `zh-CN`.
    pub id: LocaleId,
    /// Every message of that locale, keyed as the pages read it.
    pub messages: BTreeMap<&'static str, &'static str>,
}

fn locale_of(id: LocaleId, table: &'static [(&'static str, &'static str)]) -> DesktopLocale {
    DesktopLocale { id, messages: table.iter().copied().collect() }
}

/// Copy for the locale the shell's pages last requested.
///
/// Menu and dialog actions run without a page, so they read the copy the pages
/// resolved; a shell that never served a page answers in English.
/// @returns the most recently requested locale.
pub fn current() -> DesktopLocale {
    let id = *CURRENT_LOCALE.lock().unwrap();
    if id == "zh-CN" { locale_of("zh-CN", ZH_CN) } else { locale_of("en", EN) }
}

/// Resolve one shipped locale from the WebView's ordered language tags.
///
/// The first tag whose primary subtag matches a shipped locale wins, so an exact
/// regional language still resolves and anything else falls back to English.
/// @param languages - `navigator.languages`, with `navigator.language` last.
/// @returns the closest shipped locale.
pub fn resolve(languages: &[String]) -> DesktopLocale {
    for tag in languages {
        let primary = tag.split(['-', '_']).next().unwrap_or_default();
        if primary.eq_ignore_ascii_case("zh") {
            return locale_of("zh-CN", ZH_CN);
        }
        if primary.eq_ignore_ascii_case("en") {
            return locale_of("en", EN);
        }
    }
    locale_of("en", EN)
}

/// Locale the last page requested, which the tray and dialogs read because no
/// page is reachable from a menu action.
static CURRENT_LOCALE: Mutex<LocaleId> = Mutex::new("en");

/// Logs the first page that asked for copy, which is how a development run
/// proves the shell API reached its pages.
static FIRST_LOCALE_REQUEST: AtomicBool = AtomicBool::new(true);

/// Report one locale to a page.
/// @param languages - ordered WebView language tags.
/// @returns the resolved locale and its complete message set.
#[tauri::command]
pub fn locale_get(languages: Vec<String>) -> DesktopLocale {
    let locale = resolve(&languages);
    *CURRENT_LOCALE.lock().unwrap() = locale.id;
    if FIRST_LOCALE_REQUEST.swap(false, Ordering::Relaxed) {
        crate::supervisor::boot_log(&format!("first page requested locale: {}", locale.id));
    }
    locale
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn ships_a_chinese_dictionary_with_every_english_key() {
        let en: Vec<&str> = EN.iter().map(|(key, _)| *key).collect();
        let zh: Vec<&str> = ZH_CN.iter().map(|(key, _)| *key).collect();
        assert_eq!(en, zh);
    }

    #[test]
    fn leaves_no_message_empty() {
        for (key, message) in EN.iter().chain(ZH_CN.iter()) {
            assert!(!message.is_empty(), "empty message for {key}");
        }
    }

    #[test]
    fn resolves_a_chinese_tag_and_falls_back_to_english() {
        assert_eq!(resolve(&tags(&["zh-CN"])).id, "zh-CN");
        assert_eq!(resolve(&tags(&["zh-Hant-TW"])).id, "zh-CN");
        assert_eq!(resolve(&tags(&["de", "zh"])).id, "zh-CN");
        assert_eq!(resolve(&tags(&["en-US"])).id, "en");
        assert_eq!(resolve(&tags(&["de", "fr"])).id, "en");
        assert_eq!(resolve(&[]).id, "en");
    }

    #[test]
    fn formats_the_placeholders_the_pages_use() {
        let locale = resolve(&tags(&["en"]));
        let template = locale.messages["targetVersion"];
        assert_eq!(template.replace("{name}", "dsh-plugin-x"), "Enter the target version for dsh-plugin-x");
    }
}
