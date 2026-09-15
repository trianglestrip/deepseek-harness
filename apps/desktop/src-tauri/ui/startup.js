// Startup and recovery page the shell serves while the backend boots or fails.
// `window.dsh` is installed by the shell before this document runs.
const { messages } = await window.dsh.locale()
const title = document.getElementById('title')
const message = document.getElementById('message')
const advice = document.getElementById('advice')
const retry = document.getElementById('retry')
const disable = document.getElementById('disable')
const reset = document.getElementById('reset')
const restart = document.getElementById('restart')
const started = Date.now()
let failed = false

retry.textContent = messages.retry
disable.textContent = messages.disableAll
reset.textContent = messages.resetConfiguration
restart.textContent = messages.restartApplication

/** Render one shell action's outcome, keeping the non-destructive actions. */
const report = (label, action) => {
  title.textContent = messages.startupFailed
  message.textContent = label
  advice.textContent = messages.startupReinstallAdvice
  retry.hidden = true
  disable.hidden = true
  reset.hidden = true
  restart.hidden = false
  action().catch((error) => {
    message.textContent = error === null || error === undefined ? messages.unknownError : String(error)
  })
}

const renderProgress = () => {
  if (failed) return
  const seconds = Math.floor((Date.now() - started) / 1000)
  const elapsed = seconds === 0 ? '' : ' (' + String(seconds) + 's)'
  title.textContent = messages.startupLoading
  message.textContent = messages.startupLoadingDescription + elapsed
  advice.textContent = ''
}

// The shell reports a failed or exited backend through the fragment, so the
// text survives a reload and a same-document navigation.
const renderFragment = async () => {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('message')
  if (fragment === null) {
    failed = false
    retry.hidden = true
    disable.hidden = true
    reset.hidden = true
    restart.hidden = true
    renderProgress()
    return
  }
  failed = true
  let state = { phase: 'error', profileRecovery: false }
  try {
    state = await window.dsh.backend.status()
  } catch {
    // The shell answers nothing while it is starting; the fragment still carries the failure.
  }
  const recovery = state.profileRecovery === true
  title.textContent = messages.startupFailed
  message.textContent = (state.message ?? fragment) + '\n\n' + messages.recoveryDescription
  advice.textContent = recovery ? messages.startupConfigurationAdvice : messages.startupReinstallAdvice
  retry.hidden = false
  disable.hidden = !recovery
  reset.hidden = !recovery
  restart.hidden = false
}

retry.addEventListener('click', () => {
  retry.hidden = true
  disable.hidden = true
  reset.hidden = true
  restart.hidden = true
  failed = false
  renderProgress()
  window.dsh.backend.retry().catch((error) => {
    const detail = error === null || error === undefined ? messages.unknownError : String(error)
    title.textContent = messages.startupFailed
    message.textContent = detail
    retry.hidden = false
    restart.hidden = false
  })
})
disable.addEventListener('click', () => {
  report(messages.changingActivation, () => window.dsh.plugins.disableAll())
})
reset.addEventListener('click', () => {
  report(messages.changingActivation, () => window.dsh.resetConfiguration())
})
restart.addEventListener('click', () => {
  report(messages.startupLoading, () => window.dsh.restart())
})

window.addEventListener('hashchange', () => { void renderFragment() })
void renderFragment()
setInterval(renderProgress, 1000)
