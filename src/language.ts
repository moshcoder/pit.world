/**
 * Which language results come in. Pages default to English; /settings keeps a visitor's choice in their own
 * browser and sends it as `?lang=`, so the choice needs no cookie and no account.
 *
 * Most sources cannot be asked for a language (feeds, ours included), so rows are also read: franc scores a
 * row's title and snippet against only the languages we offer, which is what keeps it accurate on short text.
 * A row is hidden only when it is confidently in another language. Too short to tell means it stays.
 */
import { franc } from 'franc-min'

export type Language = { code: string; label: string; franc: string; gdelt: string }

export const LANGUAGES: Language[] = [
  { code: 'en', label: 'English', franc: 'eng', gdelt: 'english' },
  { code: 'es', label: 'Español', franc: 'spa', gdelt: 'spanish' },
  { code: 'fr', label: 'Français', franc: 'fra', gdelt: 'french' },
  { code: 'de', label: 'Deutsch', franc: 'deu', gdelt: 'german' },
  { code: 'pt', label: 'Português', franc: 'por', gdelt: 'portuguese' },
  { code: 'it', label: 'Italiano', franc: 'ita', gdelt: 'italian' },
  { code: 'nl', label: 'Nederlands', franc: 'nld', gdelt: 'dutch' },
  { code: 'pl', label: 'Polski', franc: 'pol', gdelt: 'polish' },
  { code: 'tr', label: 'Türkçe', franc: 'tur', gdelt: 'turkish' },
  { code: 'ru', label: 'Русский', franc: 'rus', gdelt: 'russian' },
  { code: 'uk', label: 'Українська', franc: 'ukr', gdelt: 'ukrainian' },
  { code: 'ar', label: 'العربية', franc: 'arb', gdelt: 'arabic' },
  { code: 'hi', label: 'हिन्दी', franc: 'hin', gdelt: 'hindi' },
  { code: 'id', label: 'Bahasa Indonesia', franc: 'ind', gdelt: 'indonesian' },
  { code: 'vi', label: 'Tiếng Việt', franc: 'vie', gdelt: 'vietnamese' },
  { code: 'zh', label: '中文', franc: 'cmn', gdelt: 'chinese' },
  { code: 'ja', label: '日本語', franc: 'jpn', gdelt: 'japanese' },
  { code: 'ko', label: '한국어', franc: 'kor', gdelt: 'korean' },
]

/** Pages. The API and MCP default to ALL_LANGUAGES: an agent that asked for nothing should not lose rows. */
export const DEFAULT_LANGUAGE = 'en'
export const ALL_LANGUAGES = 'any'

const CANDIDATES = LANGUAGES.map((l) => l.franc)
const BY_FRANC = new Map(LANGUAGES.map((l) => [l.franc, l.code]))
/** Under this, franc is guessing. */
const MIN_CHARS = 30

export const languageOf = (code: string): Language | undefined => LANGUAGES.find((l) => l.code === code)

/** A language code we offer, `any`, or the fallback for anything else. */
export function parseLanguage(value: string | undefined | null, fallback = DEFAULT_LANGUAGE): string {
  return value === ALL_LANGUAGES || languageOf(value ?? '') ? value! : fallback
}

/** Our code for a piece of text's language, or null when it cannot be told. */
export function detectLanguage(text: string): string | null {
  const plain = text.replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim()
  return BY_FRANC.get(franc(plain, { only: CANDIDATES, minLength: MIN_CHARS })) ?? null
}

/** The rows in a language. If that would leave nothing (the search itself is in another language), all of them, and says so. */
export function inLanguage<T>(rows: T[], lang: string, text: (row: T) => string): { rows: T[]; hidden: number; fellBack: boolean } {
  if (lang === ALL_LANGUAGES || !rows.length) return { rows, hidden: 0, fellBack: false }
  const kept = rows.filter((row) => {
    const found = detectLanguage(text(row))
    return !found || found === lang
  })
  if (!kept.length) return { rows, hidden: 0, fellBack: true }
  return { rows: kept, hidden: rows.length - kept.length, fellBack: false }
}
