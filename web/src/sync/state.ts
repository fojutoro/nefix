import { useState, useEffect } from 'react'
import { OfflineError, UnauthenticatedError } from './api.ts'

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

export type PullSummary = {
  applied: number
  // Dirty locally, so left alone. Counted rather than dropped silently:
  // overwriting one is the only way sync can destroy the user's work.
  skipped: number
  pages: number
}

export type SyncSummary = {
  push: PushSummary
  pull: PullSummary
  // Whether anything in IndexedDB moved. A pull that lands notes the list
  // never shows is, to the user, a pull that did not happen, so the UI
  // refreshes on this.
  changed: boolean
}

export type SyncStateValue = {
  status: SyncStatus
  lastSummary: PushSummary | null
  lastPull: PullSummary | null
  lastSyncedAt: number | null
  lastError: Error | null
}

export function statusFor(error: unknown): SyncStatus {
  if (error instanceof OfflineError) return 'offline'
  // The queue simply stops draining until they sign in again. Nothing is
  // cleared, nothing redirects, and someone mid-sentence sees no change.
  if (error instanceof UnauthenticatedError) return 'unauthenticated'
  return 'error'
}

type Listener = (state: SyncStateValue) => void

class SyncStateObservable {
  private state: SyncStateValue = {
    status: 'idle',
    lastSummary: null,
    lastPull: null,
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
