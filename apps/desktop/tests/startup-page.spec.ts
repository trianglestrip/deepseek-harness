/**
 * The startup and recovery page the shell serves, which replaced the Electron
 * startup renderer: it renders progress while the backend boots, renders a
 * failure the shell reports through the fragment, gates the profile-recovery
 * actions on `profileRecovery`, and reports each action's outcome.
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** The copy keys the page reads, with one distinguishable value each. */
const messages = {
  retry: 'MSG retry',
  disableAll: 'MSG disableAll',
  resetConfiguration: 'MSG resetConfiguration',
  restartApplication: 'MSG restartApplication',
  startupLoading: 'MSG startupLoading',
  startupLoadingDescription: 'MSG startupLoadingDescription',
  startupFailed: 'MSG startupFailed',
  startupConfigurationAdvice: 'MSG startupConfigurationAdvice',
  startupReinstallAdvice: 'MSG startupReinstallAdvice',
  recoveryDescription: 'MSG recoveryDescription',
  changingActivation: 'MSG changingActivation',
  unknownError: 'MSG unknownError',
} as const

/** The shape of `window.dsh` the page reads. */
interface ShellApi {
  locale(): Promise<{ messages: typeof messages }>
  readonly backend: { status(): Promise<unknown>; retry(): Promise<unknown> }
  readonly plugins: { disableAll(): Promise<unknown> }
  resetConfiguration(): Promise<unknown>
  restart(): Promise<unknown>
}

const backendStatus = vi.fn<() => Promise<unknown>>()
const backendRetry = vi.fn<() => Promise<unknown>>()
const disableAll = vi.fn<() => Promise<unknown>>()
const resetConfiguration = vi.fn<() => Promise<unknown>>()
const restart = vi.fn<() => Promise<unknown>>()

const shellApi: ShellApi = {
  locale: () => Promise.resolve({ messages }),
  backend: { status: backendStatus, retry: backendRetry },
  plugins: { disableAll },
  resetConfiguration,
  restart,
}

const text = (id: string): string => {
  const element = document.getElementById(id)
  if (element === null || element.textContent === null) throw new Error(`missing #${id}`)
  return element.textContent
}

const hidden = (id: string): boolean => {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`missing #${id}`)
  return element.hidden === true
}

/** Navigate the page to a failure fragment and wait for the async render. */
const showFragment = async (message: string): Promise<void> => {
  window.location.hash = `message=${encodeURIComponent(message)}`
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await vi.waitFor(() => { expect(text('message')).toContain('MSG recoveryDescription') })
}

const click = async (id: string): Promise<void> => {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`missing #${id}`)
  element.click()
  await Promise.resolve()
}

beforeAll(async () => {
  const page = readFileSync(join(process.cwd(), 'apps/desktop/src-tauri/ui/index.html'), 'utf8')
  document.body.innerHTML = page.slice(page.indexOf('<main>'), page.indexOf('</main>') + '</main>'.length)
  ;(window as unknown as { dsh: ShellApi }).dsh = shellApi
  await import('../src-tauri/ui/startup.js')
})

beforeEach(() => {
  backendStatus.mockReset().mockRejectedValue(new Error('starting'))
  backendRetry.mockReset()
  disableAll.mockReset().mockResolvedValue(undefined)
  resetConfiguration.mockReset().mockResolvedValue(undefined)
  restart.mockReset().mockResolvedValue(undefined)
})

describe('startup page', () => {
  it('labels the buttons and renders progress while the backend boots', () => {
    expect(text('title')).toBe(messages.startupLoading)
    expect(text('message')).toContain(messages.startupLoadingDescription)
    expect(text('retry')).toBe(messages.retry)
    expect(text('reset')).toBe(messages.resetConfiguration)
    for (const id of ['retry', 'disable', 'reset', 'restart']) {
      expect(hidden(id), id).toBe(true)
    }
  })

  it('renders a fragment failure with every action hidden but retry and restart', async () => {
    await showFragment('composition failed')
    expect(text('title')).toBe(messages.startupFailed)
    expect(text('message')).toContain('composition failed')
    expect(text('advice')).toBe(messages.startupReinstallAdvice)
    expect(hidden('retry')).toBe(false)
    expect(hidden('disable')).toBe(true)
    expect(hidden('reset')).toBe(true)
    expect(hidden('restart')).toBe(false)
  })

  it('prefers the state message over the fragment when the shell answers', async () => {
    backendStatus.mockResolvedValue({ phase: 'error', message: 'from status', profileRecovery: false })
    await showFragment('from fragment')
    expect(text('message')).toContain('from status')
    expect(text('message')).not.toContain('from fragment')
  })

  it('offers the profile-recovery actions only when profileRecovery holds', async () => {
    backendStatus.mockResolvedValue({ phase: 'error', profileRecovery: true })
    await showFragment('broken profile')
    expect(text('advice')).toBe(messages.startupConfigurationAdvice)
    expect(hidden('disable')).toBe(false)
    expect(hidden('reset')).toBe(false)
  })

  it('returns to progress when the fragment clears', async () => {
    await showFragment('composition failed')
    window.location.hash = ''
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await vi.waitFor(() => { expect(text('title')).toBe(messages.startupLoading) })
    expect(hidden('retry')).toBe(true)
    expect(hidden('restart')).toBe(true)
  })

  it('hides the actions while retrying and reports a failed retry', async () => {
    await showFragment('composition failed')
    backendRetry.mockRejectedValue(new Error('still broken'))
    await click('retry')
    expect(backendRetry).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(text('message')).toBe('Error: still broken') })
    expect(text('title')).toBe(messages.startupFailed)
    expect(hidden('retry')).toBe(false)
    expect(hidden('restart')).toBe(false)
    expect(hidden('disable')).toBe(true)
  })

  it('reports the disable-all outcome and keeps restart available', async () => {
    await showFragment('composition failed')
    await click('disable')
    expect(disableAll).toHaveBeenCalledOnce()
    expect(text('title')).toBe(messages.startupFailed)
    expect(text('message')).toBe(messages.changingActivation)
    expect(text('advice')).toBe(messages.startupReinstallAdvice)
    expect(hidden('restart')).toBe(false)
    expect(hidden('retry')).toBe(true)
  })

  it('reports an unknown failure as the unknown-error copy', async () => {
    await showFragment('composition failed')
    disableAll.mockRejectedValue(undefined)
    await click('disable')
    await vi.waitFor(() => { expect(text('message')).toBe(messages.unknownError) })
  })
})
