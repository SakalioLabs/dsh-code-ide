import { describe, expect, it } from 'vitest'
import {
  QuickOpenController,
  QuickOpenStore,
  type DebounceScheduler,
} from '../../src/client/search/quick-open.ts'
import type { FindFilesResponse } from '../../src/shared/workspace-search.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

class AdversarialScheduler implements DebounceScheduler {
  readonly callbacks: Array<() => void> = []

  after(_milliseconds: number, callback: () => void): () => void {
    this.callbacks.push(callback)
    // Deliberately retain the callback after cancellation. A timer callback can
    // already be queued when clearTimeout races it; the intent fence must still
    // reject that obsolete generation.
    return () => {}
  }

  run(index: number): void {
    this.callbacks[index]?.()
  }
}

const response = (path: string): FindFilesResponse => ({
  items: [{ path }], incomplete: false, limit: 200,
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Quick Open concurrency regressions', () => {
  it('rejects a cancelled debounce callback even if it was already queued', async () => {
    const scheduler = new AdversarialScheduler()
    const calls: string[] = []
    const store = new QuickOpenStore()
    const controller = new QuickOpenController(store, {
      findFiles: async (_workspaceId, query) => {
        calls.push(query)
        return response(`${query}.ts`)
      },
    }, { scheduler })

    controller.selectWorkspace('workspace')
    controller.setQuery('old')
    controller.setQuery('new')

    scheduler.run(0)
    await flushMicrotasks()
    expect(calls).toEqual([])
    expect(store.getSnapshot()).toMatchObject({ query: 'new', status: 'debouncing' })

    scheduler.run(1)
    await flushMicrotasks()
    expect(calls).toEqual(['new'])
    expect(store.activeItem()?.path).toBe('new.ts')
    controller.dispose()
  })

  it('fences the same query across a W1 to W2 to W1 ABA switch', async () => {
    const scheduler = new AdversarialScheduler()
    const oldRequest = deferred<FindFilesResponse>()
    const newRequest = deferred<FindFilesResponse>()
    const signals: AbortSignal[] = []
    let callCount = 0
    const store = new QuickOpenStore()
    const controller = new QuickOpenController(store, {
      findFiles: async (_workspaceId, _query, signal) => {
        signals.push(signal!)
        callCount += 1
        return await (callCount === 1 ? oldRequest.promise : newRequest.promise)
      },
    }, { scheduler })

    controller.selectWorkspace('w1')
    controller.setQuery('same')
    scheduler.run(0)
    expect(callCount).toBe(1)

    controller.selectWorkspace('w2')
    controller.selectWorkspace('w1')
    expect(signals[0]?.aborted).toBe(true)
    controller.setQuery('same')
    scheduler.run(1)
    expect(callCount).toBe(2)

    oldRequest.resolve(response('stale-same.ts'))
    await flushMicrotasks()
    expect(store.getSnapshot()).toMatchObject({ workspaceId: 'w1', query: 'same', status: 'running', items: [] })

    newRequest.resolve(response('current-same.ts'))
    await flushMicrotasks()
    expect(store.getSnapshot()).toMatchObject({ workspaceId: 'w1', query: 'same', status: 'complete' })
    expect(store.activeItem()?.path).toBe('current-same.ts')
    controller.dispose()
  })
})
