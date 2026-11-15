import { computed, ref } from 'vue'
import { authoringWorkspace, type AuthoringWorkspaceVersion } from '../../../Contracts/authoring-workspace'
import { ApiError } from '../../../Contracts/client'
import type { SavedWorkspaceLayout } from './workspaceRegistry'

const offlineLayoutNotice = 'Layout changes stay in this tab while offline. Reload the workspace to resume saving layouts.'

const layoutKey = (layout: SavedWorkspaceLayout, version: AuthoringWorkspaceVersion) =>
  `${layout.activeArticleId}:${layout.tabs.join(',')}:${version === 1 ? '' : layout.inspectorOpen}:${
    version < 3 ? '' : `${layout.focusedGroup}:${layout.secondaryActiveArticleId}:${layout.secondaryTabs.join(',')}`}`

export function workspacePersistence(layout: () => SavedWorkspaceLayout, hasSecondaryGroup: () => boolean) {
  let lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let session: string | undefined
  let currentHandle: string | undefined
  let revision = 0n
  const version = ref<AuthoringWorkspaceVersion>()
  let stored = ''
  let writing: Promise<void> | undefined
  let disconnected = false
  const notice = ref('')
  const supportsGroups = computed(() => version.value === 3)

  function abortWrites() {
    lifetime.abort()
    lifetime = new AbortController()
    clearTimeout(timer)
    writing = undefined
    session = undefined
  }

  function reset() {
    abortWrites()
    currentHandle = undefined
    version.value = undefined
    disconnected = false
    notice.value = ''
  }

  function offline() {
    if (!currentHandle || disconnected) return
    disconnected = true
    abortWrites()
    notice.value = offlineLayoutNotice
  }

  async function restore(handle: string, restoreLayout: (layout: SavedWorkspaceLayout, signal: AbortSignal) => Promise<number | undefined>): Promise<void> {
    currentHandle = handle
    if (!navigator.onLine) offline()
    if (disconnected) return
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
      version.value = value.schemaVersion
      stored = layoutKey(layout(), value.schemaVersion)
      if (skipped + value.skipped > 0) notice.value = 'Some articles from the saved workspace are unavailable.'
      else if (value.schemaVersion === 1) notice.value = 'The Inspector setting stays in this tab until workspace storage is upgraded.'
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
    if (!navigator.onLine) offline()
    const layoutVersion = version.value
    if (!session || !layoutVersion || writing || (layoutVersion < 3 && hasSecondaryGroup()) || layoutKey(layout(), layoutVersion) === stored) return
    clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, 175)
  }

  async function flush() {
    clearTimeout(timer)
    if (!navigator.onLine) offline()
    if (writing) {
      const scope = lifetime.signal
      await writing
      if (!scope.aborted) await flush()
      return
    }
    const handle = session
    const layoutVersion = version.value
    if (!handle || !layoutVersion || (layoutVersion < 3 && hasSecondaryGroup())) return
    const desired = layout()
    if (layoutKey(desired, layoutVersion) === stored) return
    const scope = lifetime.signal
    const signal = AbortSignal.any([scope, AbortSignal.timeout(3_000)])
    writing = (async () => {
      try {
        const saved = await authoringWorkspace(handle, signal, { ...desired, expectedRevision: revision }, layoutVersion)
        if (signal.aborted) return
        revision = saved.revision
        // Suppress repeated writes of the same stale positions if the server had to filter them out.
        stored = layoutKey(desired, layoutVersion)
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

  return { reset, restore, rebind, changed, flush, offline, notice, supportsGroups }
}
