/**
 * The desktop API the shell installs in every page it owns.
 *
 * This replaces the preload bridge the Electron shell exposed as `window.dsh`:
 * the loading page, the plugin window, and the Host-served application document
 * all reach the shell through it. The global is defined without a setter, so a
 * page script cannot replace the API the shell installed.
 *
 * Commands land here as their implementation arrives: `locale` and `backend`
 * exist today, and the plugin and update groups follow the recovery actions,
 * the plugin transactions, and the updater.
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
    },
    writable: false,
    configurable: false,
    enumerable: true,
  })
})()
