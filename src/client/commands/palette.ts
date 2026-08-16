import { CommandRegistry } from './registry.ts'
import type { CommandExecutionOutcome, WorkbenchCommandView } from './types.ts'

export const COMMAND_PALETTE_RESULT_LIMIT = 200
export const COMMAND_PALETTE_MRU_LIMIT = 50

export interface CommandPaletteItem extends WorkbenchCommandView {
  /** Larger values are a better match. Only meaningful within one query. */
  readonly score: number
}

export interface CommandPaletteSnapshot {
  readonly query: string
  readonly items: readonly CommandPaletteItem[]
  readonly activeIndex: number
  readonly activeId?: string
}

type Listener = () => void

interface RankedItem extends CommandPaletteItem {
  readonly sourceIndex: number
  readonly recentIndex: number
}

interface Field {
  readonly value: string
  readonly boost: number
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function isWordBoundary(value: string, index: number): boolean {
  if (index === 0) return true
  const previous = value[index - 1]
  const current = value[index]
  if (previous === undefined || current === undefined) return false
  if (!/[\p{L}\p{N}]/u.test(previous)) return true
  return /[a-z\d]/u.test(previous) && /[A-Z]/u.test(current)
}

/**
 * Scores one field in descending match classes: exact, boundary-contiguous,
 * contiguous, then ordered subsequence. The large gaps keep those classes
 * deterministic even for long command labels.
 */
function scoreField(value: string, needle: string): number | undefined {
  const candidate = normalized(value)
  if (candidate.length === 0) return undefined
  if (candidate === needle) return 4_000_000

  let contiguous = candidate.indexOf(needle)
  if (contiguous >= 0) {
    let boundary = contiguous
    while (boundary >= 0 && !isWordBoundary(value, boundary)) {
      boundary = candidate.indexOf(needle, boundary + 1)
    }
    if (boundary >= 0) {
      return 3_000_000 - Math.min(100_000, boundary * 100 + candidate.length - needle.length)
    }
    return 2_000_000 - Math.min(100_000, contiguous * 100 + candidate.length - needle.length)
  }

  let cursor = 0
  let first = -1
  let previous = -2
  let adjacency = 0
  let boundaries = 0
  for (const character of needle) {
    const position = candidate.indexOf(character, cursor)
    if (position < 0) return undefined
    if (first < 0) first = position
    if (position === previous + 1) adjacency += 1
    if (isWordBoundary(value, position)) boundaries += 1
    previous = position
    cursor = position + 1
  }

  const span = previous - first + 1
  return 1_000_000
    + boundaries * 2_000
    + adjacency * 500
    - Math.min(100_000, first * 100 + span * 10 + candidate.length - needle.length)
}

function commandFields(command: WorkbenchCommandView): Field[] {
  const category = command.category
  const combined = category === undefined ? command.title : `${category}: ${command.title}`
  const wordsFromId = command.id
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/[._-]+/gu, ' ')
  return [
    { value: command.title, boost: 40_000 },
    { value: combined, boost: 30_000 },
    ...(category === undefined ? [] : [{ value: category, boost: 20_000 }]),
    { value: command.id, boost: 10_000 },
    { value: wordsFromId, boost: 9_000 },
  ]
}

export function scoreCommandPaletteItem(command: WorkbenchCommandView, query: string): number | undefined {
  const needle = normalized(query)
  if (needle.length === 0) return 0
  let best: number | undefined
  for (const field of commandFields(command)) {
    const score = scoreField(field.value, needle)
    if (score === undefined) continue
    const weighted = score + field.boost
    if (best === undefined || weighted > best) best = weighted
  }
  return best
}

/** Stable command ranking with relevance first, MRU second, registration order last. */
export function rankCommandPaletteItems(
  commands: readonly WorkbenchCommandView[],
  query: string,
  recentCommandIds: readonly string[] = [],
): readonly CommandPaletteItem[] {
  const recent = new Map<string, number>()
  for (const [index, id] of recentCommandIds.slice(0, COMMAND_PALETTE_MRU_LIMIT).entries()) {
    if (!recent.has(id)) recent.set(id, index)
  }

  return Object.freeze(commands.flatMap((command, sourceIndex): RankedItem[] => {
    const score = scoreCommandPaletteItem(command, query)
    if (score === undefined) return []
    return [{
      ...command,
      score,
      sourceIndex,
      recentIndex: recent.get(command.id) ?? Number.MAX_SAFE_INTEGER,
    }]
  }).sort((left, right) => right.score - left.score
      || left.recentIndex - right.recentIndex
      || left.sourceIndex - right.sourceIndex)
    .slice(0, COMMAND_PALETTE_RESULT_LIMIT)
    .map(({ sourceIndex: _sourceIndex, recentIndex: _recentIndex, ...item }) => Object.freeze(item)))
}

function snapshot(
  query: string,
  items: readonly CommandPaletteItem[],
  activeIndex: number,
): CommandPaletteSnapshot {
  const activeId = items[activeIndex]?.id
  const base = { query, items, activeIndex }
  return Object.freeze(activeId === undefined ? base : { ...base, activeId })
}

function ownCommandView(command: WorkbenchCommandView): WorkbenchCommandView {
  return Object.freeze({
    ...command,
    keybindings: Object.freeze(command.keybindings.map(binding => Object.freeze({ ...binding }))),
    ...(command.effectiveKeybindings === undefined ? {} : {
      effectiveKeybindings: Object.freeze([...command.effectiveKeybindings]),
    }),
    ...(command.keybindingConflicts === undefined ? {} : {
      keybindingConflicts: Object.freeze([...command.keybindingConflicts]),
    }),
    ...(command.shortcut === undefined ? {} : {
      shortcut: Object.freeze({
        ...command.shortcut,
        labels: Object.freeze([...command.shortcut.labels]),
        conflictIds: Object.freeze([...command.shortcut.conflictIds]),
      }),
    }),
  })
}

/** Framework-neutral external store for palette presentation state. */
export class CommandPaletteStore {
  private commands: readonly WorkbenchCommandView[] = []
  private recentCommandIds: readonly string[] = []
  private current: CommandPaletteSnapshot = snapshot('', [], -1)
  private readonly listeners = new Set<Listener>()
  private disposed = false

  readonly getSnapshot = (): CommandPaletteSnapshot => this.current

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setQuery(query: string): void {
    if (this.disposed || query === this.current.query) return
    this.publishRanked(query, false)
  }

  /** Refreshes registry-backed projections while retaining the active command id. */
  refresh(commands: readonly WorkbenchCommandView[]): void {
    if (this.disposed) return
    this.commands = Object.freeze(commands.map(ownCommandView))
    this.publishRanked(this.current.query, true)
  }

  moveSelection(delta: number): CommandPaletteItem | undefined {
    const { items, activeIndex } = this.current
    if (this.disposed || items.length === 0 || !Number.isFinite(delta)) return undefined
    const origin = activeIndex < 0 ? 0 : activeIndex
    const next = ((origin + Math.trunc(delta)) % items.length + items.length) % items.length
    if (next !== activeIndex) this.publish(snapshot(this.current.query, items, next))
    return items[next]
  }

  movePage(direction: number, pageSize = 8): CommandPaletteItem | undefined {
    const { items, activeIndex } = this.current
    if (this.disposed || items.length === 0 || !Number.isFinite(direction)
      || !Number.isSafeInteger(pageSize) || pageSize < 1) return undefined
    const origin = activeIndex < 0 ? 0 : activeIndex
    const pages = Math.trunc(direction)
    const next = Math.max(0, Math.min(items.length - 1, origin + pages * pageSize))
    if (next !== activeIndex) this.publish(snapshot(this.current.query, items, next))
    return items[next]
  }

  selectIndex(index: number): CommandPaletteItem | undefined {
    if (this.disposed || !Number.isSafeInteger(index) || index < 0 || index >= this.current.items.length) {
      return undefined
    }
    if (index !== this.current.activeIndex) {
      this.publish(snapshot(this.current.query, this.current.items, index))
    }
    return this.current.items[index]
  }

  selectId(commandId: string): CommandPaletteItem | undefined {
    return this.selectIndex(this.current.items.findIndex(item => item.id === commandId))
  }

  activeItem(): CommandPaletteItem | undefined {
    return this.current.items[this.current.activeIndex]
  }

  /** Records only an execution completion already admitted by the registry. */
  recordCompleted(commandId: string): void {
    if (this.disposed) return
    this.recentCommandIds = Object.freeze([
      commandId,
      ...this.recentCommandIds.filter(id => id !== commandId),
    ].slice(0, COMMAND_PALETTE_MRU_LIMIT))
    this.publishRanked(this.current.query, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private publishRanked(query: string, preserveActiveId: boolean): void {
    const previousIndex = this.current.activeIndex
    const previousId = preserveActiveId ? this.current.activeId : undefined
    const items = rankCommandPaletteItems(this.commands, query, this.recentCommandIds)
    const retainedIndex = previousId === undefined ? -1 : items.findIndex(item => item.id === previousId)
    const activeIndex = items.length === 0
      ? -1
      : retainedIndex >= 0
        ? retainedIndex
        : preserveActiveId
          ? Math.max(0, Math.min(previousIndex, items.length - 1))
          : 0
    this.publish(snapshot(query, items, activeIndex))
  }

  private publish(next: CommandPaletteSnapshot): void {
    if (this.disposed) return
    this.current = next
    for (const listener of this.listeners) {
      try { listener() } catch { /* A projection subscriber cannot break state mutation. */ }
    }
  }
}

/** Owns the registry subscription and keeps execution authority in the registry. */
export class CommandPaletteController<C> {
  readonly store: CommandPaletteStore
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly registry: CommandRegistry<C>, store = new CommandPaletteStore()) {
    this.store = store
    this.store.refresh(this.registry.list())
    this.unsubscribe = this.registry.subscribe(() => {
      if (!this.disposed) this.store.refresh(this.registry.list())
    })
  }

  setQuery(query: string): void { this.store.setQuery(query) }
  moveSelection(delta: number): CommandPaletteItem | undefined { return this.store.moveSelection(delta) }
  movePage(direction: number, pageSize = 8): CommandPaletteItem | undefined {
    return this.store.movePage(direction, pageSize)
  }
  selectIndex(index: number): CommandPaletteItem | undefined { return this.store.selectIndex(index) }

  async execute(commandId: string): Promise<CommandExecutionOutcome> {
    if (this.disposed) {
      return { commandId, status: 'unavailable', message: 'Command palette is disposed.' }
    }
    let admitted = false
    const outcome = await this.registry.execute(commandId, { onAdmitted: () => { admitted = true } })
    if (!this.disposed && admitted && outcome.status === 'completed') this.store.recordCompleted(commandId)
    return outcome
  }

  executeActive(): Promise<CommandExecutionOutcome | undefined> {
    const command = this.store.activeItem()
    return command === undefined ? Promise.resolve(undefined) : this.execute(command.id)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.store.dispose()
  }
}
