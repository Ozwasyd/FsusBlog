import { t, type MessageKey } from '../siteLocale'
import { computed, ref } from 'vue'
import { authoringWorkspace, type AuthoringWorkspaceVersion } from '../../../Contracts/authoring-workspace'
import { ApiError } from '../../../Contracts/client'
import type { SavedWorkspaceLayout } from './workspaceRegistry'

const offlineLayoutNotice = 'author.helper.offline'

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
  const noticeKey = ref<MessageKey | ''>('')
  const notice = computed(() => noticeKey.value ? t(noticeKey.value) : '')
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
    noticeKey.value = ''
  }

  function offline() {
    if (!currentHandle || disconnected) return
    disconnected = true
    abortWrites()
    noticeKey.value = offlineLayoutNotice
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
      if (skipped + value.skipped > 0) noticeKey.value = 'author.helper.unavailableArticles'
      else if (value.schemaVersion === 1) noticeKey.value = 'author.helper.inspectorUpgrade'
    } catch {
      if (scope.aborted) return
      if (currentHandle && currentHandle !== handle)
        return restore(currentHandle, restoreLayout)
      noticeKey.value = 'author.helper.restoreFailed'
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
        if (saved.skipped) noticeKey.value = 'author.helper.skippedArticles'
      } catch (error) {
        if (scope.aborted || session !== handle) return
        session = undefined
        noticeKey.value = error instanceof ApiError && error.status === 409
          ? 'author.helper.layoutConflict'
          : 'author.helper.saveFailed'
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
