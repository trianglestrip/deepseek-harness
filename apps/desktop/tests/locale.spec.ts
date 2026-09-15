/**
 * The desktop shell's own copy: every shipped locale covers the English key set,
 * and the WebView language tag selects one of them.
 */

import { describe, expect, it } from 'vitest'
import { en, formatMessage, locales, resolveLocale } from '../src-tauri/ui/locale.js'

describe('desktop shell locale', () => {
  const message = (key: string): string => {
    const value = en[key]
    if (value === undefined) throw new Error(`missing English message ${key}`)
    return value
  }

  it('ships a Chinese dictionary with every English key', () => {
    expect(Object.keys(locales['zh-CN'].messages).sort()).toEqual(Object.keys(en).sort())
  })

  it('leaves no message empty', () => {
    for (const locale of Object.values(locales)) {
      for (const [key, message] of Object.entries(locale.messages)) {
        expect(message.length, `${locale.id}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('resolves a Chinese language tag and falls back for every other one', () => {
    expect(resolveLocale('zh-CN').id).toBe('zh-CN')
    expect(resolveLocale('zh-Hant-TW').id).toBe('zh-CN')
    expect(resolveLocale('en-US').id).toBe('en')
    expect(resolveLocale('de').id).toBe('en')
    expect(resolveLocale(undefined).id).toBe('en')
  })

  it('replaces named placeholders and leaves unknown ones in place', () => {
    expect(formatMessage(message('targetVersion'), { name: 'dsh-plugin-x' })).toBe('Enter the target version for dsh-plugin-x')
    expect(formatMessage('{keep} {other}', { other: 'value' })).toBe('{keep} value')
  })
})
