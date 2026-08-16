import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_GEOMETRY,
  LAYOUT_GEOMETRY_STORAGE_KEY,
  decodeLayoutGeometry,
  encodeLayoutGeometry,
  readLayoutGeometry,
  writeLayoutGeometry,
  type LayoutGeometryStorage,
} from '../../src/client/layout/geometry.ts'

class MemoryStorage implements LayoutGeometryStorage {
  value: string | null = null
  getItem(key: string): string | null {
    expect(key).toBe(LAYOUT_GEOMETRY_STORAGE_KEY)
    return this.value
  }
  setItem(key: string, value: string): void {
    expect(key).toBe(LAYOUT_GEOMETRY_STORAGE_KEY)
    this.value = value
  }
}

describe('layout geometry persistence', () => {
  it('strictly round-trips the supported desired geometry', () => {
    const storage = new MemoryStorage()
    const geometry = { explorerWidth: 312, harnessWidth: 544, terminalHeight: 288 }
    expect(writeLayoutGeometry(geometry, storage)).toBe(true)
    expect(readLayoutGeometry(storage)).toEqual(geometry)
    expect(decodeLayoutGeometry(JSON.parse(encodeLayoutGeometry(geometry)))).toEqual(geometry)
  })

  it('falls back for corrupt, future, non-exact and inaccessible storage', () => {
    for (const value of [
      '{bad json',
      JSON.stringify({ schema: 2, explorerWidth: 260, harnessWidth: 430, terminalHeight: 240 }),
      JSON.stringify({ schema: 1, explorerWidth: 260, harnessWidth: 430, terminalHeight: 240, extra: true }),
      JSON.stringify({ schema: 1, explorerWidth: 1, harnessWidth: 430, terminalHeight: 240 }),
    ]) {
      const storage = new MemoryStorage()
      storage.value = value
      expect(readLayoutGeometry(storage)).toEqual(DEFAULT_LAYOUT_GEOMETRY)
    }
    expect(readLayoutGeometry({
      getItem: () => { throw new DOMException('blocked', 'SecurityError') },
      setItem: () => {},
    })).toEqual(DEFAULT_LAYOUT_GEOMETRY)
    expect(writeLayoutGeometry(DEFAULT_LAYOUT_GEOMETRY, {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
    })).toBe(false)
  })
})
