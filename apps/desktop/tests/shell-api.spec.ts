/**
 * The shell API `window.dsh` installs, which replaces the preload bridge the
 * Electron shell exposed: every group maps to exactly one shell command.
 */

import { beforeAll, describe, expect, it } from 'vitest'

/** One recorded command call. */
type Call = [string, unknown]

/** The shape the shell installs, as the pages read it. */
interface ShellApi {
  readonly protocolVersion: number
  locale(): Promise<unknown>
  readonly backend: { status(): Promise<unknown>; retry(): Promise<unknown> }
  readonly plugins: {
    list(): Promise<unknown>
    add(spec: string): Promise<unknown>
    remove(name: string): Promise<unknown>
    update(name: string, version: string): Promise<unknown>
    toggle(name: string, enabled: boolean): Promise<unknown>
    disableAll(): Promise<unknown>
  }
  readonly updates: { check(): Promise<unknown>; install(): Promise<unknown>; state(): Promise<unknown> }
  resetConfiguration(): Promise<unknown>
  restart(): Promise<unknown>
  openPluginWindow(): Promise<unknown>
}

const calls: Call[] = []

function api(): ShellApi {
  return (globalThis as unknown as { dsh: ShellApi }).dsh
}

beforeAll(async () => {
  (globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (command: string, args: unknown) => {
      calls.push([command, args])
      return Promise.resolve({ command })
    },
  }
  await import('../src-tauri/shell-api.js')
})

describe('desktop shell API', () => {
  it('is installed without a setter, so a page cannot replace it', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'dsh')
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(api().protocolVersion).toBe(1)
  })

  it('asks for copy with the language tags the WebView reports', async () => {
    calls.length = 0
    await api().locale()
    const [command, args] = calls[0] ?? []
    expect(command).toBe('locale_get')
    expect(args).toMatchObject({ languages: expect.any(Array) })
  })

  it('maps every group to its command and arguments', async () => {
    calls.length = 0
    await api().backend.status()
    await api().backend.retry()
    await api().plugins.list()
    await api().plugins.add('dsh-plugin-x@1.2.3')
    await api().plugins.remove('dsh-plugin-x')
    await api().plugins.update('dsh-plugin-x', '2.0.0')
    await api().plugins.toggle('dsh-plugin-x', false)
    await api().plugins.disableAll()
    await api().updates.check()
    await api().updates.install()
    await api().updates.state()
    await api().resetConfiguration()
    await api().restart()
    await api().openPluginWindow()
    expect(calls).toEqual([
      ['backend_status', undefined],
      ['backend_retry', undefined],
      ['plugins_list', undefined],
      ['plugins_add', { spec: 'dsh-plugin-x@1.2.3' }],
      ['plugins_remove', { name: 'dsh-plugin-x' }],
      ['plugins_update', { name: 'dsh-plugin-x', version: '2.0.0' }],
      ['plugins_toggle', { name: 'dsh-plugin-x', enabled: false }],
      ['plugins_disable_all', undefined],
      ['updates_check', undefined],
      ['updates_install', undefined],
      ['updates_state', undefined],
      ['configuration_reset', undefined],
      ['application_restart', undefined],
      ['open_plugin_window', undefined],
    ])
  })
})
