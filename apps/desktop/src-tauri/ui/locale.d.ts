/** Typed surface of `locale.js`, which the shell's own pages load as a browser module. */

/** Identifier of a locale the shell ships. */
export type DesktopLocaleId = 'en' | 'zh-CN'

/** One shipped locale and its complete message set. */
export interface DesktopLocale {
  readonly id: DesktopLocaleId
  readonly messages: Readonly<Record<string, string>>
}

/** English copy, the key set every other locale must cover. */
export declare const en: Readonly<Record<string, string>>

/** Every shipped locale keyed by identifier. */
export declare const locales: Readonly<Record<DesktopLocaleId, DesktopLocale>>

/**
 * Resolve one shipped locale from a WebView language tag.
 * @param language - `navigator.language` or any BCP 47 tag.
 * @returns the closest shipped locale.
 */
export declare function resolveLocale(language: string | undefined): DesktopLocale

/**
 * Replace named placeholders in one locale-owned message.
 * @param message - message carrying `{name}` placeholders.
 * @param values - replacement values.
 * @returns the message with every known placeholder replaced.
 */
export declare function formatMessage(message: string, values: Readonly<Record<string, string>>): string
