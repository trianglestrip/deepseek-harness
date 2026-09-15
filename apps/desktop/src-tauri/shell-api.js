/**
 * The desktop API the shell installs in every page it owns.
 *
 * This replaces the preload bridge the Electron shell exposed as `window.dsh`:
 * the loading page, the plugin window, and the Host-served application document
 * all reach the shell through it. The global is defined without a setter, so a
 * page script cannot replace the API the shell installed.
 *
 * Commands land here as their implementation arrives: the copy, the backend state,
 * the plugin transactions, and the recovery actions exist today; the update group
 * follows the updater.
 */
;(function () {
  /**
   * Tauri's IPC internals; resolved on use, because an initialization script may
   * run before the runtime installs them.
   * @returns {object} the Tauri IPC internals.
   */
  function internals() {
    const value = globalThis.__TAURI_INTERNALS__
    if (value === undefined) throw new Error('desktop api: Tauri IPC is unavailable')
    return value
  }

  /**
   * Invoke one shell command.
   * @param {string} command - registered command name.
   * @param {object} [args] - command arguments.
   * @returns {Promise<unknown>} the command result.
   */
  function invoke(command, args) {
    return internals().invoke(command, args)
  }

  /** @returns {string[]} the tags the WebView reports, best match first. */
  function preferredLanguages() {
    const languages = navigator !== undefined && Array.isArray(navigator.languages) ? navigator.languages : []
    const tags = [...languages]
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') tags.push(navigator.language)
    return tags
  }

  Object.defineProperty(globalThis, 'dsh', {
    value: {
      protocolVersion: 1,
      /** @returns {Promise<{id: string, messages: Record<string, string>}>} shell copy for this locale. */
      locale: () => invoke('locale_get', { languages: preferredLanguages() }),
      backend: {
        /** @returns {Promise<{phase: string, message?: string, profileRecovery: boolean}>} backend availability. */
        status: () => invoke('backend_status'),
        /** @returns {Promise<void>} completion once the backend boots again. */
        retry: () => invoke('backend_retry'),
      },
      plugins: {
        /** @returns {Promise<Array<{name: string, version: string, enabled: boolean}>>} installed plugins. */
        list: () => invoke('plugins_list'),
        /** @param {string} spec - npm package spec. @returns {Promise<void>} */
        add: (spec) => invoke('plugins_add', { spec }),
        /** @param {string} name - installed package name. @returns {Promise<void>} */
        remove: (name) => invoke('plugins_remove', { name }),
        /** @param {string} name - installed package name. @param {string} version - target version. @returns {Promise<void>} */
        update: (name, version) => invoke('plugins_update', { name, version }),
        /** @param {string} name - installed package name. @param {boolean} enabled - activation state. @returns {Promise<void>} */
        toggle: (name, enabled) => invoke('plugins_toggle', { name, enabled }),
        /** @returns {Promise<void>} completion after every third-party plugin is disabled. */
        disableAll: () => invoke('plugins_disable_all'),
      },
      updates: {
        /** @returns {Promise<{phase: string, version?: string, message?: string}>} the check result. */
        check: () => invoke('updates_check'),
        /** @returns {Promise<{phase: string, version?: string, message?: string}>} the install result. */
        install: () => invoke('updates_install'),
        /** @returns {Promise<{phase: string, version?: string, message?: string}>} the last reported state. */
        state: () => invoke('updates_state'),
      },
      /** @returns {Promise<unknown>} completion after the desktop profile is rebuilt. */
      resetConfiguration: () => invoke('configuration_reset'),
      /** @returns {Promise<never>} never resolves; the application relaunches. */
      restart: () => invoke('application_restart'),
      /** @returns {Promise<void>} completion once the plugin window is open. */
      openPluginWindow: () => invoke('open_plugin_window'),
    },
    writable: false,
    configurable: false,
    enumerable: true,
  })
})()
