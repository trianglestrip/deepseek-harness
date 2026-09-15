/**
 * Copy owned by the desktop shell's own pages and typed by `locale.spec.js`.
 *
 * The shell renders its startup, recovery, and plugin pages in a WebView, so the
 * dictionary lives here instead of in Rust: the page resolves the locale from
 * `navigator.language`, which is the same source the replaced Electron shell read
 * through `app.getLocale()`. The tray menu keeps literal English labels because
 * Rust builds it before any page exists.
 */

/** English copy; every other locale supplies this complete key set. */
export const en = {
  application: 'Application',
  startupFailed: 'DeepSeek Harness could not start',
  startupLoading: 'Starting DeepSeek Harness…',
  startupLoadingDescription: 'Your workspace will open when it is ready.',
  startupErrorDescription: 'Choose a recovery action below. Disabling third-party plugins retains their files.',
  startupReinstallAdvice: 'If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.',
  startupConfigurationAdvice: 'Reset Desktop deletes all Desktop profile configuration and third-party plugins without a backup, then starts a fresh profile. Shared tasks and settings are retained.',
  restartApplication: 'Close and restart',
  retry: 'Retry startup',
  disableAll: 'Disable all plugins and retry',
  resetConfiguration: 'Reset Desktop and retry',
  recoveryDescription: 'The backend could not start. Update or disable incompatible plugins, then retry. Installed plugins and configuration are retained.',
  unknownError: 'Unknown error',
  pluginManagerTitle: 'Desktop Plugins',
  pluginWindowTitle: 'DeepSeek Harness — Desktop Plugins',
  pluginManagerDescription: 'Plugins are installed only in the Desktop node_modules and are managed by the bundled pnpm.',
  loadingPlugins: 'Reading Desktop plugins…',
  noPlugins: 'No Desktop plugins are installed.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  refreshed: 'Plugin list refreshed.',
  enable: 'Enable',
  disable: 'Disable',
  disabled: 'Disabled',
  changingActivation: 'Changing plugin activation…',
  npmPackage: 'npm package',
  install: 'Install',
  installed: 'Installed',
  remove: 'Remove',
  update: 'Update',
  targetVersion: 'Enter the target version for {name}',
  removing: 'Removing {name}…',
  updating: 'Updating {name}…',
  installing: 'Installing {spec}…',
  operationComplete: 'Done. The Desktop backend has restarted.',
}

/** Locales the shell ships, keyed by the identifier its pages report. */
export const locales = {
  en: { id: 'en', messages: en },
  'zh-CN': {
    id: 'zh-CN',
    messages: {
      application: '应用',
      startupFailed: 'DeepSeek Harness 无法启动',
      startupLoading: '正在启动 DeepSeek Harness…',
      startupLoadingDescription: '准备就绪后将自动打开工作区。',
      startupErrorDescription: '请选择下方的恢复操作。禁用第三方插件会保留插件文件。',
      startupReinstallAdvice: '如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。',
      startupConfigurationAdvice: '重置 Desktop 会删除桌面端的全部 profile 配置和第三方插件，不保留备份，然后重新初始化并启动。共享任务和设置会保留。',
      restartApplication: '关闭并重启',
      retry: '重试启动',
      disableAll: '禁用全部插件并重试',
      resetConfiguration: '重置 Desktop 并重试',
      recoveryDescription: '后端无法启动。请更新或禁用不兼容插件，然后重试。已安装插件和配置会保留。',
      unknownError: '未知错误',
      pluginManagerTitle: '桌面插件',
      pluginWindowTitle: 'DeepSeek Harness — 桌面插件',
      pluginManagerDescription: '插件只安装到桌面端自己的 node_modules，并由内置 pnpm 管理。',
      loadingPlugins: '正在读取桌面插件…',
      noPlugins: '还没有安装桌面插件。',
      refresh: '刷新',
      refreshing: '正在刷新…',
      refreshed: '插件列表已刷新。',
      enable: '启用',
      disable: '禁用',
      disabled: '已禁用',
      changingActivation: '正在更改插件启用状态…',
      npmPackage: 'npm 包',
      install: '安装',
      installed: '已安装',
      remove: '移除',
      update: '更新',
      targetVersion: '输入 {name} 的目标版本',
      removing: '正在移除 {name}…',
      updating: '正在更新 {name}…',
      installing: '正在安装 {spec}…',
      operationComplete: '操作完成，桌面后端已重新启动。',
    },
  },
}

/**
 * Resolve one shipped locale from a WebView language tag.
 * @param {string} language - `navigator.language` or any BCP 47 tag.
 * @returns {{ id: string, messages: Record<string, string> }} the shipped locale.
 */
export function resolveLocale(language) {
  return typeof language === 'string' && language.toLowerCase().startsWith('zh')
    ? locales['zh-CN']
    : locales.en
}

/**
 * Replace named placeholders in one locale-owned message.
 * @param {string} message - message carrying `{name}` placeholders.
 * @param {Record<string, string>} values - replacement values.
 * @returns {string} the message with every known placeholder replaced.
 */
export function formatMessage(message, values) {
  return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key) => values[key] ?? placeholder)
}
