import { useSyncExternalStore } from 'react'
import type { DocumentSessionStore, DocumentSessionsSnapshot } from './session.ts'

export function useDocumentSessions(store: DocumentSessionStore): DocumentSessionsSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
