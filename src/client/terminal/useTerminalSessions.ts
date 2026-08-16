import { useSyncExternalStore } from 'react'
import type { TerminalSessionStore, TerminalSessionsSnapshot } from './session.ts'

export function useTerminalSessions(store: TerminalSessionStore): TerminalSessionsSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
