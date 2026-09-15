/**
 * The plugin program's argument handling: the shell passes arguments and reads
 * one JSON result, so parsing and transaction mapping are its whole interface.
 */

import { describe, expect, it } from 'vitest'
import { COMMANDS, mutation, parse } from '../src/desktop-plugins.ts'

const BASE = ['--node', 'node', '--pnpm', 'pnpm.mjs', '--dsh', '/dsh'] as const

describe('desktop plugin transactions', () => {
  it('reads the executables, the profile, and the command', () => {
    const parsed = parse([...BASE, '--profile', '/profile', 'list'])
    expect(parsed.options).toEqual({ node: 'node', pnpm: 'pnpm.mjs', dsh: '/dsh', profile: '/profile' })
    expect(parsed.command).toBe('list')
  })

  it('leaves the profile to the shell home when the shell passes none', () => {
    expect(parse([...BASE, 'list']).options.profile).toBeUndefined()
  })

  it('rejects a missing executable and an unknown command', () => {
    expect(() => parse(['--node', 'node', 'list'])).toThrow(/--pnpm/u)
    expect(() => parse([...BASE, 'explode'])).toThrow(/expected one of/u)
  })

  it('maps every transaction command to its mutation', () => {
    expect(mutation('add', ['dsh-plugin-x@1.2.3'])).toEqual({ type: 'plugin-add', spec: 'dsh-plugin-x@1.2.3' })
    expect(mutation('remove', ['dsh-plugin-x'])).toEqual({ type: 'plugin-remove', name: 'dsh-plugin-x' })
    expect(mutation('update', ['dsh-plugin-x', '2.0.0'])).toEqual({ type: 'plugin-update', name: 'dsh-plugin-x', version: '2.0.0' })
    expect(mutation('toggle', ['dsh-plugin-x', 'on'])).toEqual({ type: 'plugin-toggle', name: 'dsh-plugin-x', enabled: true })
    expect(mutation('toggle', ['dsh-plugin-x', 'off'])).toEqual({ type: 'plugin-toggle', name: 'dsh-plugin-x', enabled: false })
    expect(mutation('disable-all', [])).toEqual({ type: 'plugins-disable-all' })
    expect(mutation('list', [])).toBeUndefined()
    expect(mutation('reset', [])).toBeUndefined()
  })

  it('rejects an incomplete transaction and a toggle that is neither on nor off', () => {
    expect(() => mutation('add', [])).toThrow(/add <spec>/u)
    expect(() => mutation('update', ['dsh-plugin-x'])).toThrow(/update <name> <version>/u)
    expect(() => mutation('toggle', ['dsh-plugin-x', 'yes'])).toThrow(/on or off/u)
  })

  it('names every command the program dispatches', () => {
    expect([...COMMANDS]).toEqual(['list', 'add', 'remove', 'update', 'toggle', 'disable-all', 'reset'])
  })
})
