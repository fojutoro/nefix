import { pullRemoteChanges } from './pull.ts'
import { pushDirtyRows } from './push.ts'
import { statusFor, syncState, type SyncSummary } from './state.ts'

// pushDirtyRows has a guard of its own, against one push overlapping
// another. This one is a different invariant: it covers the whole cycle, so
// two overlapping runs cannot interleave one run's push with the other's
// pull, which is the ordering everything below depends on.
let running = false

const nothing = (): SyncSummary => ({
  push: { pushed: 0, conflicted: 0, forbidden: 0, failed: 0 },
  pull: { applied: 0, skipped: 0, pages: 0 },
  changed: false,
})

export async function sync(): Promise<SyncSummary> {
  if (running) return nothing()
  running = true
  const summary = nothing()

  try {
    // Push before pull, always. Pull first and a remote version overwrites a
    // local note that has unpushed edits, and those edits are gone with no
    // conflict ever being detected. Pushing first means the server sees the
    // local edit and either accepts it or reports a conflict, which the fork
    // path already handles safely. Do not "simplify" this ordering.
    summary.push = await pushDirtyRows()
    // pushDirtyRows reports its outcome through syncState rather than
    // throwing. A server that has just refused us has nothing to give: the
    // pull would fail the same way and overwrite the reason the push
    // recorded, leaving the user a worse message about the same problem.
    if (syncState.current.status === 'idle') {
      syncState.setState({ status: 'syncing' })
      summary.pull = await pullRemoteChanges()
      syncState.setState({
        status: 'idle',
        lastPull: summary.pull,
        lastSyncedAt: Date.now(),
        lastError: null,
      })
    }
  } catch (error) {
    syncState.setState({
      status: statusFor(error),
      lastPull: summary.pull,
      lastError: error instanceof Error ? error : new Error(String(error)),
    })
  } finally {
    running = false
  }

  summary.changed =
    summary.push.pushed + summary.push.conflicted + summary.pull.applied > 0
  return summary
}
