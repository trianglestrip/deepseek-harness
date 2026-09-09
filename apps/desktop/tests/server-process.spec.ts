import { describe, expect, it } from 'vitest'
import { buildTreeKillArgs, parseLaunchLine } from '../src/server-process'

describe('parseLaunchLine', () => {
  it('parses the authenticated announce URL', () => {
    const url = parseLaunchLine('dsh web: http://127.0.0.1:3080/?token=abc123')
    expect(url?.origin).toBe('http://127.0.0.1:3080')
    expect(url?.searchParams.get('token')).toBe('abc123')
  })

  it('takes the first URL when a LAN suffix is appended', () => {
    const url = parseLaunchLine('dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.5:3080/?token=abc)')
    expect(url?.host).toBe('127.0.0.1:3080')
    expect(url?.searchParams.get('token')).toBe('abc')
  })

  it('accepts https origins', () => {
    expect(parseLaunchLine('dsh web: https://example.test/?token=abc')?.protocol).toBe('https:')
  })

  it('rejects the companion browser-open line', () => {
    expect(parseLaunchLine('dsh web: opening the default browser; pass --no-open to disable')).toBeNull()
  })

  it('rejects lines without the announce prefix', () => {
    expect(parseLaunchLine('[loader] mounted @deepseek-ai/dsh-base')).toBeNull()
    expect(parseLaunchLine('')).toBeNull()
  })

  it('rejects non-http tokens and an empty body', () => {
    expect(parseLaunchLine('dsh web: file:///etc/passwd')).toBeNull()
    expect(parseLaunchLine('dsh web: javascript:alert(1)')).toBeNull()
    expect(parseLaunchLine('dsh web: ')).toBeNull()
  })
})

describe('buildTreeKillArgs', () => {
  it('builds the Windows tree kill', () => {
    expect(buildTreeKillArgs(4242, 'win32')).toEqual({ command: 'taskkill', args: ['/pid', '4242', '/T', '/F'] })
  })

  it('returns null where the detached process group covers the tree', () => {
    expect(buildTreeKillArgs(4242, 'linux')).toBeNull()
    expect(buildTreeKillArgs(4242, 'darwin')).toBeNull()
  })
})
