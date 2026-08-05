import { useState, useEffect } from 'react'

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'unauthenticated'
  | 'error'

export type PushSummary = {
  pushed: number
  conflicted: number
  forbidden: number
  failed: number
}

export type SyncStateValue = {
  status: SyncStatus
  lastSummary: PushSummary | null
  lastSyncedAt: number | null
  lastError: Error | null
}

type Listener = (state: SyncStateValue) => void

class SyncStateObservable {
  private state: SyncStateValue = {
    status: 'idle',
    lastSummary: null,
    lastSyncedAt: null,
    lastError: null,
  }

  private listeners: Set<Listener> = new Set()

  get current(): SyncStateValue {
    return this.state
  }

  setState(update: Partial<SyncStateValue>) {
    this.state = { ...this.state, ...update }
    this.listeners.forEach((listener) => listener(this.state))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const syncState = new SyncStateObservable()

export function useSyncState(): SyncStateValue {
  const [state, setState] = useState(() => syncState.current)

  useEffect(() => {
    return syncState.subscribe(setState)
  }, [])

  return state
}
