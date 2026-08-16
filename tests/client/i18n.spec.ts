import { describe, expect, it } from 'vitest'
import {
  IDE_LOCALE_MESSAGE_TYPE,
  ideLocaleFromMessage,
  ideLocaleFromSearch,
  normalizeIdeLocale,
} from '../../src/client/i18n.tsx'

describe('IDE locale bridge', () => {
  it('normalizes only the supported Harness locales and keeps standalone English', () => {
    expect(normalizeIdeLocale('zh')).toBe('zh')
    expect(normalizeIdeLocale('zh-CN')).toBe('zh')
    expect(normalizeIdeLocale('en-US')).toBe('en')
    expect(normalizeIdeLocale('fr')).toBeUndefined()
    expect(ideLocaleFromSearch('?embedded=1&locale=zh')).toBe('zh')
    expect(ideLocaleFromSearch('?embedded=1&locale=fr')).toBe('en')
    expect(ideLocaleFromSearch('')).toBe('en')
  })

  it('admits only an exact parent source, origin, message type, and locale', () => {
    const parent = {} as MessageEventSource
    const event = {
      origin: 'http://127.0.0.1:3080',
      source: parent,
      data: { type: IDE_LOCALE_MESSAGE_TYPE, locale: 'zh' },
    }
    expect(ideLocaleFromMessage(
      event,
      'http://127.0.0.1:3080',
      parent,
    )).toBe('zh')
    expect(ideLocaleFromMessage(
      { ...event, origin: 'http://example.test' },
      'http://127.0.0.1:3080',
      parent,
    )).toBeUndefined()
    expect(ideLocaleFromMessage(
      { ...event, source: {} as MessageEventSource },
      'http://127.0.0.1:3080',
      parent,
    )).toBeUndefined()
    expect(ideLocaleFromMessage(
      { ...event, data: { type: 'other', locale: 'zh' } },
      'http://127.0.0.1:3080',
      parent,
    )).toBeUndefined()
    expect(ideLocaleFromMessage(
      { ...event, data: { type: IDE_LOCALE_MESSAGE_TYPE, locale: 'fr' } },
      'http://127.0.0.1:3080',
      parent,
    )).toBeUndefined()
  })
})
