export const LAYOUT_GEOMETRY_STORAGE_KEY = 'dsh-code-ide.layout-geometry.v1'
export const LAYOUT_GEOMETRY_SCHEMA = 1

export const EXPLORER_MIN = 180
export const EXPLORER_MAX = 480
export const HARNESS_MIN = 320
export const HARNESS_MAX = 760
export const TERMINAL_MIN = 120

export interface LayoutGeometry {
  readonly explorerWidth: number
  readonly harnessWidth: number
  readonly terminalHeight: number
}

export interface PersistedLayoutGeometryV1 extends LayoutGeometry {
  readonly schema: 1
}

export interface LayoutGeometryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_LAYOUT_GEOMETRY: LayoutGeometry = Object.freeze({
  explorerWidth: 260,
  harnessWidth: 430,
  terminalHeight: 240,
})

const PERSISTED_KEYS = new Set(['schema', 'explorerWidth', 'harnessWidth', 'terminalHeight'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntegerInRange(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isLayoutGeometry(value: unknown): value is LayoutGeometry {
  if (!isRecord(value)) return false
  return isIntegerInRange(value.explorerWidth, EXPLORER_MIN, EXPLORER_MAX)
    && isIntegerInRange(value.harnessWidth, HARNESS_MIN, HARNESS_MAX)
    && isIntegerInRange(value.terminalHeight, TERMINAL_MIN)
}

/** Strictly decodes the one supported wire schema. Unknown and future fields fail closed. */
export function decodeLayoutGeometry(value: unknown): LayoutGeometry | undefined {
  if (!isRecord(value) || Object.keys(value).length !== PERSISTED_KEYS.size
    || Object.keys(value).some(key => !PERSISTED_KEYS.has(key))
    || value.schema !== LAYOUT_GEOMETRY_SCHEMA || !isLayoutGeometry(value)) return undefined
  return {
    explorerWidth: value.explorerWidth,
    harnessWidth: value.harnessWidth,
    terminalHeight: value.terminalHeight,
  }
}

export function parseLayoutGeometry(raw: string): LayoutGeometry | undefined {
  try {
    return decodeLayoutGeometry(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export function encodeLayoutGeometry(geometry: LayoutGeometry): string {
  if (!isLayoutGeometry(geometry)) throw new TypeError('Invalid layout geometry.')
  const persisted: PersistedLayoutGeometryV1 = {
    schema: 1,
    explorerWidth: geometry.explorerWidth,
    harnessWidth: geometry.harnessWidth,
    terminalHeight: geometry.terminalHeight,
  }
  return JSON.stringify(persisted)
}

function browserStorage(): LayoutGeometryStorage {
  // Reading the localStorage property can itself throw in locked-down browsers.
  return {
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value) },
  }
}

/** Storage failures, corrupt records and future schemas all produce safe defaults. */
export function readLayoutGeometry(storage: LayoutGeometryStorage = browserStorage()): LayoutGeometry {
  try {
    const raw = storage.getItem(LAYOUT_GEOMETRY_STORAGE_KEY)
    if (raw === null) return DEFAULT_LAYOUT_GEOMETRY
    return parseLayoutGeometry(raw) ?? DEFAULT_LAYOUT_GEOMETRY
  } catch {
    return DEFAULT_LAYOUT_GEOMETRY
  }
}

/** Best-effort persistence: layout interaction must remain usable when storage is unavailable. */
export function writeLayoutGeometry(
  geometry: LayoutGeometry,
  storage: LayoutGeometryStorage = browserStorage(),
): boolean {
  try {
    storage.setItem(LAYOUT_GEOMETRY_STORAGE_KEY, encodeLayoutGeometry(geometry))
    return true
  } catch {
    return false
  }
}
