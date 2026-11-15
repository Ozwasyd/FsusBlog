import { ref } from 'vue'
import { authoringWorkspace } from '../../../Contracts/authoring-workspace'
import { ApiError } from '../../../Contracts/client'
import type { SavedWorkspaceLayout } from './workspaceRegistry'

const layoutKey = (layout: SavedWorkspaceLayout, legacy: boolean) =>
  `${layout.activeArticleId}:${layout.tabs.join(',')}:${legacy ? '' : layout.inspectorOpen === true}`

export function workspacePersistence(layout: () => SavedWorkspaceLayout, canSaveLayout: () => boolean = () => true) {
  let lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let session: string | undefined
  let currentHandle: string | undefined
  let revision = 0n
  let legacy = false
  let stored = ''
  let writing: Promise<void> | undefined
  const notice = ref('')

  function reset() {
    lifetime.abort()
    lifetime = new AbortController()
    clearTimeout(timer)
    writing = undefined
    session = undefined
    currentHandle = undefined
    notice.value = ''
  }

  async function restore(handle: string, restoreLayout: (layout: SavedWorkspaceLayout, signal: AbortSignal) => Promise<number | undefined>): Promise<void> {
    currentHandle = handle
    const scope = lifetime.signal
    const signal = AbortSignal.any([scope, AbortSignal.timeout(5_000)])
    try {
      const value = await authoringWorkspace(handle, signal)
      if (signal.aborted) return
      const skipped = await restoreLayout(value, signal)
      if (scope.aborted) return
      if (skipped === undefined) throw new Error('Workspace restoration was interrupted')
      revision = value.revision
      session = currentHandle
      legacy = value.schemaVersion === 1
      stored = layoutKey(layout(), legacy)
      if (skipped + value.skipped > 0) notice.value = 'Some articles from the saved workspace are unavailable.'
      else if (legacy) notice.value = 'The Inspector setting stays in this tab until workspace storage is upgraded.'
    } catch {
      if (scope.aborted) return
      if (currentHandle && currentHandle !== handle)
        return restore(currentHandle, restoreLayout)
      notice.value = 'The saved workspace could not be restored. Layout changes stay in this tab.'
    }
  }

  function rebind(handle: string) {
    currentHandle = handle
    if (session) session = handle
    changed()
  }

  function changed() {
    if (!session || writing || !canSaveLayout() || layoutKey(layout(), legacy) === stored) return
    clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, 175)
  }

  async function flush() {
    clearTimeout(timer)
    if (writing) {
      const scope = lifetime.signal
      await writing
      if (!scope.aborted) await flush()
      return
    }
    const handle = session
    const desired = layout()
    if (!handle || !canSaveLayout() || layoutKey(desired, legacy) === stored) return
    const scope = lifetime.signal
    const signal = AbortSignal.any([scope, AbortSignal.timeout(3_000)])
    writing = (async () => {
      try {
        const saved = await authoringWorkspace(handle, signal, { ...desired, inspectorOpen: desired.inspectorOpen === true,
          expectedRevision: revision }, legacy)
        if (signal.aborted) return
        revision = saved.revision
        // Suppress repeated writes of the same stale positions if the server had to filter them out.
        stored = layoutKey(desired, legacy)
        if (saved.skipped) notice.value = 'Some articles could not be included in the saved workspace.'
      } catch (error) {
        if (scope.aborted || session !== handle) return
        session = undefined
        notice.value = error instanceof ApiError && error.status === 409
          ? 'The saved workspace changed elsewhere. Reload the workspace to use that layout.'
          : 'This workspace layout could not be saved. Layout changes stay in this tab.'
      } finally {
        if (!scope.aborted) {
          writing = undefined
          changed()
        }
      }
    })()
    await writing
  }

  return { reset, restore, rebind, changed, flush, notice }
}
