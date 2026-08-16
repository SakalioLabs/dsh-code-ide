import { describe, expect, it } from 'vitest'
import { IdeHostError } from '../../src/host/errors.js'
import { WorkspaceResources } from '../../src/host/workspace-resources.js'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise(done => { resolve = done }), resolve }
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation
    expect.unreachable(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(IdeHostError)
    expect((error as IdeHostError).code).toBe(code)
  }
}

describe('WorkspaceResources mutation coordinator', () => {
  it('serializes one workspace, permits another, and enforces queue capacity', async () => {
    const resources = new WorkspaceResources({ list: () => [] }, { maxQueuedMutations: 3 })
    const firstGate = deferred()
    const otherGate = deferred()
    const firstEntered = deferred()
    const otherEntered = deferred()
    let secondEntered = false
    const workspace = { id: 'one', path: 'unused', title: 'One' }
    const other = { id: 'two', path: 'unused', title: 'Two' }
    const first = resources.runMutation(workspace, async () => {
      firstEntered.resolve()
      await firstGate.promise
      return 1
    })
    await firstEntered.promise
    const second = resources.runMutation(workspace, async () => { secondEntered = true; return 2 })
    const otherRun = resources.runMutation(other, async () => {
      otherEntered.resolve()
      await otherGate.promise
      return 4
    })
    await otherEntered.promise
    expect(secondEntered).toBe(false)
    await expectCode(resources.runMutation(workspace, async () => 3), 'MUTATION_QUEUE_FULL')
    otherGate.resolve()
    expect(await otherRun).toBe(4)
    firstGate.resolve()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    await resources.dispose()
  })

  it('cancels queued work and waits for the active critical section during dispose', async () => {
    const resources = new WorkspaceResources({ list: () => [] }, { maxQueuedMutations: 4 })
    const workspace = { id: 'one', path: 'unused', title: 'One' }
    const gate = deferred()
    const entered = deferred()
    const active = resources.runMutation(workspace, async () => { entered.resolve(); await gate.promise; return 'done' })
    await entered.promise
    const queued = resources.runMutation(workspace, async () => 'must-not-run')
    let disposed = false
    const disposing = resources.dispose().then(() => { disposed = true })
    await expectCode(queued, 'MUTATION_SERVICE_STOPPING')
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    expect(await active).toBe('done')
    await disposing
    expect(disposed).toBe(true)
    await expectCode(resources.runMutation(workspace, async () => 'late'), 'MUTATION_SERVICE_STOPPING')
  })
})
