import { resolve } from 'node:path';
import { MUTATION_BUDGETS } from '../shared/workspace-mutations.js';
import { IdeHostError } from './errors.js';
import { resolveWorkspaceRoot, } from './path-policy.js';
function wireWorkspaceId(workspace) {
    return String(workspace.id);
}
/**
 * Internal resource boundary shared by every workspace writer.
 *
 * One FIFO per workspace makes parent/child mutations serializable while
 * preserving concurrency between independent workspaces. Root identity is
 * pinned for the lifetime of this provider epoch and revalidated on each use.
 */
export class WorkspaceResources {
    registry;
    queues = new Map();
    active = new Set();
    roots = new Map();
    maxQueuedMutations;
    pendingCount = 0;
    accepting = true;
    constructor(registry, options = {}) {
        this.registry = registry;
        this.maxQueuedMutations = options.maxQueuedMutations ?? 64;
        if (!Number.isSafeInteger(this.maxQueuedMutations)
            || this.maxQueuedMutations <= 0
            || this.maxQueuedMutations > 4_096) {
            throw new Error('dsh-code-ide: maxQueuedMutations must be between 1 and 4096');
        }
    }
    requireWorkspace(value) {
        if (typeof value !== 'string'
            || Buffer.byteLength(value, 'utf8') === 0
            || Buffer.byteLength(value, 'utf8') > MUTATION_BUDGETS.maxWorkspaceIdBytes) {
            throw new IdeHostError('INVALID_WORKSPACE_ID', 'workspaceId must be a non-empty bounded string.');
        }
        const workspace = this.registry.list().find(item => wireWorkspaceId(item) === value);
        if (workspace === undefined)
            throw new IdeHostError('WORKSPACE_NOT_FOUND', 'Unknown workspace.', 404);
        return workspace;
    }
    async resolveRoot(workspace) {
        const id = wireWorkspaceId(workspace);
        const registeredPath = resolve(workspace.path);
        const cached = this.roots.get(id);
        if (cached !== undefined && cached.registeredPath !== registeredPath) {
            throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace registration changed.', 409);
        }
        const root = await resolveWorkspaceRoot(registeredPath, cached?.identity);
        if (cached === undefined) {
            this.roots.set(id, { registeredPath: root.registeredPath, identity: root.identity });
        }
        return root;
    }
    async runMutation(workspace, operation, signal) {
        if (!this.accepting) {
            throw new IdeHostError('MUTATION_SERVICE_STOPPING', 'Workspace mutations are stopping.', 503);
        }
        if (signal?.aborted) {
            throw new IdeHostError('MUTATION_CANCELLED', 'The mutation was cancelled before commit.', 409);
        }
        if (this.pendingCount >= this.maxQueuedMutations) {
            throw new IdeHostError('MUTATION_QUEUE_FULL', 'The workspace mutation queue is full.', 429);
        }
        const key = wireWorkspaceId(workspace);
        const queue = this.queues.get(key) ?? { running: false, items: [] };
        this.queues.set(key, queue);
        this.pendingCount += 1;
        return await new Promise((resolvePromise, rejectPromise) => {
            let item;
            let abort;
            if (signal !== undefined) {
                const operationSignal = signal;
                abort = () => {
                    const index = queue.items.indexOf(item);
                    if (index === -1)
                        return;
                    queue.items.splice(index, 1);
                    this.pendingCount -= 1;
                    operationSignal.removeEventListener('abort', abort);
                    rejectPromise(new IdeHostError('MUTATION_CANCELLED', 'The mutation was cancelled before commit.', 409));
                    this.removeIdleQueue(key, queue);
                };
            }
            item = {
                operation,
                resolve: resolvePromise,
                reject: rejectPromise,
                signal,
                abort,
            };
            queue.items.push(item);
            if (abort !== undefined && signal !== undefined)
                signal.addEventListener('abort', abort, { once: true });
            this.pump(key, queue);
        });
    }
    /** Stop admission, reject work that never started, then drain active critical sections. */
    async dispose() {
        if (!this.accepting && this.pendingCount === 0)
            return;
        this.accepting = false;
        for (const [key, queue] of this.queues) {
            const queued = queue.items.splice(0);
            for (const item of queued) {
                item.signal?.removeEventListener('abort', item.abort);
                this.pendingCount -= 1;
                item.reject(new IdeHostError('MUTATION_SERVICE_STOPPING', 'Workspace mutations are stopping.', 503));
            }
            this.removeIdleQueue(key, queue);
        }
        while (this.active.size > 0)
            await Promise.allSettled([...this.active]);
        this.roots.clear();
    }
    pump(key, queue) {
        if (queue.running)
            return;
        const item = queue.items.shift();
        if (item === undefined) {
            this.removeIdleQueue(key, queue);
            return;
        }
        queue.running = true;
        item.signal?.removeEventListener('abort', item.abort);
        const active = Promise.resolve()
            .then(item.operation)
            .then(item.resolve, item.reject)
            .finally(() => {
            queue.running = false;
            this.pendingCount -= 1;
            this.active.delete(active);
            this.pump(key, queue);
        });
        this.active.add(active);
    }
    removeIdleQueue(key, queue) {
        if (!queue.running && queue.items.length === 0 && this.queues.get(key) === queue) {
            this.queues.delete(key);
        }
    }
}
