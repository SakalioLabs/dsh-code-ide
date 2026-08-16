import { describe, expect, it, vi } from 'vitest'
import {
  COMMAND_PALETTE_MRU_LIMIT,
  COMMAND_PALETTE_RESULT_LIMIT,
  CommandPaletteController,
  CommandPaletteStore,
  rankCommandPaletteItems,
  scoreCommandPaletteItem,
} from '../../src/client/commands/palette.ts'
import { CommandRegistry } from '../../src/client/commands/registry.ts'
import type { WorkbenchCommandView } from '../../src/client/commands/types.ts'

function view(
  id: string,
  title: string,
  overrides: Partial<WorkbenchCommandView> = {},
): WorkbenchCommandView {
  return { id, title, keybindings: [], enabled: true, running: false, ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('command palette ranking', () => {
  it('orders exact, boundary, contiguous and subsequence matches deterministically', () => {
    const ranked = rankCommandPaletteItems([
      view('workbench.subsequence', 'Search Available Extensions'),
      view('workbench.contiguous', 'Autosave'),
      view('workbench.boundary', 'Save All'),
      view('workbench.exact', 'Save'),
    ], '  SAVE  ')

    expect(ranked.map(item => item.id)).toEqual([
      'workbench.exact',
      'workbench.boundary',
      'workbench.contiguous',
      'workbench.subsequence',
    ])
    expect(ranked.map(item => item.score)).toEqual([...ranked.map(item => item.score)].sort((a, b) => b - a))
  })

  it('searches category, combined label and humanized command id', () => {
    const category = view('workbench.navigate', 'Go to File', { category: 'Navigation' })
    const combined = view('file.save', 'Save', { category: 'File' })
    const id = view('workbench.action.showCommands', 'Palette')

    expect(scoreCommandPaletteItem(category, 'navigation')).toBeDefined()
    expect(scoreCommandPaletteItem(combined, 'file save')).toBeDefined()
    expect(scoreCommandPaletteItem(id, 'show commands')).toBeDefined()
    expect(scoreCommandPaletteItem(id, 'missing')).toBeUndefined()
  })

  it('uses MRU only as a tie-break and otherwise retains registration order', () => {
    const commands = [
      view('workbench.first', 'Same'),
      view('workbench.second', 'Same'),
      view('workbench.third', 'Same'),
    ]
    expect(rankCommandPaletteItems(commands, '').map(item => item.id)).toEqual([
      'workbench.first', 'workbench.second', 'workbench.third',
    ])
    expect(rankCommandPaletteItems(commands, '', ['workbench.third']).map(item => item.id)).toEqual([
      'workbench.third', 'workbench.first', 'workbench.second',
    ])
  })

  it('bounds the projected result set to 200 commands', () => {
    const commands = Array.from({ length: COMMAND_PALETTE_RESULT_LIMIT + 25 }, (_, index) => (
      view(`workbench.command${String(index)}`, `Command ${String(index)}`)
    ))
    const ranked = rankCommandPaletteItems(commands, '')
    expect(ranked).toHaveLength(COMMAND_PALETTE_RESULT_LIMIT)
    expect(ranked.at(-1)?.id).toBe('workbench.command199')
  })
})

describe('CommandPaletteStore', () => {
  it('publishes external-store snapshots and preserves an active id across refreshes', () => {
    const store = new CommandPaletteStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.refresh([
      view('workbench.first', 'First'),
      view('workbench.second', 'Second'),
      view('workbench.third', 'Third'),
    ])
    store.selectIndex(1)
    store.refresh([
      view('workbench.second', 'Second', { enabled: false, disabledReason: 'No workspace.' }),
      view('workbench.third', 'Third'),
      view('workbench.first', 'First'),
    ])

    expect(store.getSnapshot()).toMatchObject({ activeIndex: 0, activeId: 'workbench.second' })
    expect(store.activeItem()).toMatchObject({ enabled: false, disabledReason: 'No workspace.' })
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    store.setQuery('third')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('supports wrapped item movement, clamped page movement and direct selection', () => {
    const store = new CommandPaletteStore()
    store.refresh(Array.from({ length: 6 }, (_, index) => (
      view(`workbench.item${String(index)}`, `Item ${String(index)}`)
    )))

    expect(store.moveSelection(-1)?.id).toBe('workbench.item5')
    expect(store.moveSelection(1)?.id).toBe('workbench.item0')
    expect(store.movePage(1, 4)?.id).toBe('workbench.item4')
    expect(store.movePage(1, 4)?.id).toBe('workbench.item5')
    expect(store.movePage(-1, 3)?.id).toBe('workbench.item2')
    expect(store.selectId('workbench.item3')?.id).toBe('workbench.item3')
    expect(store.selectIndex(99)).toBeUndefined()
    expect(store.activeItem()?.id).toBe('workbench.item3')
  })

  it('keeps at most fifty completed commands in process-local MRU order', () => {
    const store = new CommandPaletteStore()
    const commands = Array.from({ length: COMMAND_PALETTE_MRU_LIMIT + 2 }, (_, index) => (
      view(`workbench.item${String(index)}`, `Item ${String(index)}`)
    ))
    store.refresh(commands)
    for (let index = 0; index <= COMMAND_PALETTE_MRU_LIMIT; index += 1) {
      store.recordCompleted(`workbench.item${String(index)}`)
    }

    const ids = store.getSnapshot().items.map(item => item.id)
    expect(ids.slice(0, COMMAND_PALETTE_MRU_LIMIT)).toEqual(
      Array.from({ length: COMMAND_PALETTE_MRU_LIMIT }, (_, index) => (
        `workbench.item${String(COMMAND_PALETTE_MRU_LIMIT - index)}`
      )),
    )
    expect(ids[COMMAND_PALETTE_MRU_LIMIT]).toBe('workbench.item0')
  })
})

describe('CommandPaletteController', () => {
  it('projects effective user bindings live instead of exposing only raw defaults', async () => {
    const registry = new CommandRegistry(() => undefined)
    registry.register({
      id: 'workbench.open', title: 'Open',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'p' }] }],
      run: () => undefined,
    })
    const controller = new CommandPaletteController(registry)
    expect(controller.store.activeItem()?.shortcut).toMatchObject({ labels: ['Ctrl+P'], state: 'default' })

    await registry.keybindings.unbindDefault('workbench.open', 'primary')
    await registry.keybindings.addUserBinding({
      commandId: 'workbench.open', sequence: [{ primary: true, key: 'o' }],
    })
    expect(controller.store.activeItem()?.shortcut).toMatchObject({
      labels: ['Ctrl+O'], customized: true, state: 'customized',
    })
    controller.dispose()
    await registry.dispose()
  })

  it('refreshes live context while retaining selection and disabled reasons', () => {
    const context = { enabled: false, visible: true }
    const registry = new CommandRegistry(() => context)
    registry.register({
      id: 'workbench.first', title: 'First', run: () => undefined,
    })
    registry.register({
      id: 'workbench.live', title: 'Live',
      when: value => value.visible,
      enablement: value => value.enabled
        ? { enabled: true }
        : { enabled: false, reason: 'Live context is disabled.' },
      run: () => undefined,
    })
    const controller = new CommandPaletteController(registry)
    controller.selectIndex(1)
    expect(controller.store.activeItem()).toMatchObject({
      id: 'workbench.live', enabled: false, disabledReason: 'Live context is disabled.',
    })

    context.enabled = true
    registry.contextChanged()
    expect(controller.store.activeItem()).toMatchObject({ id: 'workbench.live', enabled: true })
    context.visible = false
    registry.contextChanged()
    expect(controller.store.getSnapshot().items.map(item => item.id)).toEqual(['workbench.first'])
    controller.dispose()
  })

  it('delegates execution and records MRU only for admitted successful completions', async () => {
    const registry = new CommandRegistry(() => undefined)
    registry.register({ id: 'workbench.first', title: 'First', run: () => undefined })
    registry.register({ id: 'workbench.success', title: 'Success', run: () => undefined })
    registry.register({
      id: 'workbench.disabled', title: 'Disabled',
      enablement: () => ({ enabled: false, reason: 'Unavailable now.' }), run: () => undefined,
    })
    registry.register({ id: 'workbench.failure', title: 'Failure', run: () => { throw new Error('failed') } })
    const controller = new CommandPaletteController(registry)

    await expect(controller.execute('workbench.disabled')).resolves.toMatchObject({ status: 'disabled' })
    await expect(controller.execute('workbench.failure')).resolves.toMatchObject({ status: 'failed' })
    expect(controller.store.getSnapshot().items[0]?.id).toBe('workbench.first')
    await expect(controller.execute('workbench.success')).resolves.toMatchObject({ status: 'completed' })
    expect(controller.store.getSnapshot().items[0]?.id).toBe('workbench.success')
    controller.dispose()
  })

  it('unsubscribes on disposal and rejects state changes from a late completion', async () => {
    const gate = deferred<void>()
    const registry = new CommandRegistry(() => undefined)
    registry.register({ id: 'workbench.first', title: 'First', run: () => undefined })
    registry.register({ id: 'workbench.slow', title: 'Slow', run: async () => { await gate.promise } })
    const controller = new CommandPaletteController(registry)
    const listener = vi.fn()
    controller.store.subscribe(listener)

    const execution = controller.execute('workbench.slow')
    const finalSnapshot = controller.store.getSnapshot()
    const callsAtDisposal = listener.mock.calls.length
    controller.dispose()
    registry.register({ id: 'workbench.late', title: 'Late registration', run: () => undefined })
    gate.resolve()

    await expect(execution).resolves.toMatchObject({ status: 'completed' })
    expect(controller.store.getSnapshot()).toBe(finalSnapshot)
    expect(listener).toHaveBeenCalledTimes(callsAtDisposal)
    await expect(controller.execute('workbench.first')).resolves.toMatchObject({ status: 'unavailable' })
    await registry.dispose()
  })
})
