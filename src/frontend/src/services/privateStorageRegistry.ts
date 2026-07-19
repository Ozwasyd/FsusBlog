export type PrivateStorageScope = 'local' | 'session'
export type PrivateStorageMatcher = Readonly<{
  id: string
  scope: PrivateStorageScope
  match: 'exact' | 'prefix'
  value: string
  dataClass: 'auth-state' | 'challenge-proof' | 'private-draft' | 'upload-session' | 'identity-preference' | 'local-fixture'
}>

export const PRIVATE_STORAGE_REGISTRY: readonly PrivateStorageMatcher[] = Object.freeze([
  { id: 'legacy-account-cache', scope: 'local', match: 'exact', value: 'fsus_user_storage', dataClass: 'auth-state' },
  { id: 'notification-guest-pow', scope: 'session', match: 'exact', value: 'notification_stream_guest_pow', dataClass: 'challenge-proof' },
  { id: 'article-drafts', scope: 'local', match: 'prefix', value: 'fsus:article-draft:', dataClass: 'private-draft' },
  { id: 'comment-drafts', scope: 'local', match: 'prefix', value: 'fsus:comment-draft:v1:', dataClass: 'private-draft' },
  { id: 'image-upload-sessions', scope: 'local', match: 'prefix', value: 'fsus:image-upload-session:', dataClass: 'upload-session' },
  { id: 'console-welcome-identity', scope: 'local', match: 'prefix', value: 'fsus:console-welcome-callout:dismissed:', dataClass: 'identity-preference' },
  { id: 'local-fixture-account', scope: 'session', match: 'exact', value: 'fsusblog_local_fixture_session', dataClass: 'local-fixture' },
  { id: 'local-fixture-admin', scope: 'session', match: 'exact', value: 'fsusblog_local_fixture_admin_session', dataClass: 'local-fixture' }
])

export interface PrivateStorageCleanupResult {
  removed: readonly string[]
  failed: readonly string[]
}

function registeredKeys(storage: Storage, matcher: PrivateStorageMatcher): string[] {
  if (matcher.match === 'exact') {
    return storage.getItem(matcher.value) === null ? [] : [matcher.value]
  }
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(matcher.value)) {
      keys.push(key)
    }
  }
  return keys
}

export function clearRegisteredPrivateStorage(options: {
  local?: Storage
  session?: Storage
} = {}): PrivateStorageCleanupResult {
  const local = options.local ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const session = options.session ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
  const removed: string[] = []
  const failed: string[] = []

  for (const matcher of PRIVATE_STORAGE_REGISTRY) {
    const storage = matcher.scope === 'local' ? local : session
    if (!storage) continue
    try {
      for (const key of registeredKeys(storage, matcher)) {
        storage.removeItem(key)
        removed.push(key)
      }
    } catch {
      failed.push(matcher.id)
    }
  }

  return { removed, failed }
}
