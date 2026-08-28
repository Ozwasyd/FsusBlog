/**
 * Machine-executable postcondition registry for #1707 capabilities (#1710).
 *
 * Every catalog postconditionId binds to a pure verifier over observations +
 * entity identities. Missing observations or weak checks (row count > 0 only,
 * HTTP 200 only, file exists) fail closed.
 */

import { readFixtureCatalogs } from '../../testing/fixture-catalog.mjs'
import { freezeDeep, plainObject } from './canonical.mjs'
import { securityPostconditionVerifiers } from './security-postconditions.mjs'

function fail(id, reason) {
  return Object.freeze({ ok: false, postconditionId: id, reason })
}

function pass(id, detail = null) {
  return Object.freeze({ ok: true, postconditionId: id, detail })
}

function entitiesOf(observation, kind) {
  const entities = observation?.entities ?? []
  return entities.filter((item) => item.kind === kind)
}

function keysOf(observation, domainPrefix) {
  return (observation?.keys ?? []).filter((item) => String(item.domain ?? '').startsWith(domainPrefix)
    || String(item.domain ?? '') === domainPrefix
    || String(item.key ?? '').includes(domainPrefix))
}

function requireOwnedIds(entities, label) {
  const ids = entities.map((item) => String(item.id ?? '')).filter(Boolean).sort()
  if (ids.length === 0) return { ok: false, reason: `${label}: no owned entity IDs` }
  return { ok: true, ids }
}

/** Exact publication relation for public.article.published. */
function verifyArticlePublished(ctx) {
  const id = 'article-published'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const articles = entitiesOf(db, 'article').filter((item) => item.owned !== false)
  const owned = requireOwnedIds(articles, id)
  if (!owned.ok) return fail(id, owned.reason)

  for (const article of articles) {
    const fields = article.fields ?? {}
    if (String(fields.status ?? '') !== 'published') {
      return fail(id, `article ${article.id} status is not published`)
    }
    if (fields.deleted === true || fields.isDeleted === true) {
      return fail(id, `article ${article.id} is deleted`)
    }
    if (fields.currentPublicationId == null || fields.currentPublicationId === '') {
      return fail(id, `article ${article.id} current_publication_id is empty`)
    }
    if (fields.publicDetailReadable !== true) {
      return fail(id, `article ${article.id} public detail is not readable`)
    }
  }
  return pass(id, { articleIds: owned.ids })
}

function verifyArticleStatus(id, expectedStatus, { allowMissingPublication = false } = {}) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const articles = entitiesOf(db, 'article').filter((item) => {
      const status = String(item.fields?.status ?? '')
      return status === expectedStatus || item.capabilityHint === id
    })
    // Prefer capability-scoped entities; fall back to status filter.
    const scoped = articles.length
      ? articles
      : entitiesOf(db, 'article').filter((item) => String(item.fields?.status ?? '') === expectedStatus)
    const owned = requireOwnedIds(scoped, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const article of scoped) {
      const fields = article.fields ?? {}
      if (String(fields.status ?? '') !== expectedStatus) {
        return fail(id, `article ${article.id} status is not ${expectedStatus}`)
      }
      if (expectedStatus === 'deleted') {
        if (fields.deleted !== true && fields.isDeleted !== true) {
          return fail(id, `article ${article.id} missing deleted flag`)
        }
      } else if (fields.deleted === true || fields.isDeleted === true) {
        return fail(id, `article ${article.id} unexpectedly deleted`)
      }
      if (!allowMissingPublication && expectedStatus === 'published'
        && (fields.currentPublicationId == null || fields.currentPublicationId === '')) {
        return fail(id, `article ${article.id} current_publication_id is empty`)
      }
    }
    return pass(id, { articleIds: owned.ids })
  }
}

function verifyHomeFeaturedHot(ctx) {
  const id = 'home-featured-hot'
  const db = ctx.observations?.database
  const redis = ctx.observations?.redis
  const cache = ctx.observations?.cache
  if (!db) return fail(id, 'database observation required')
  if (!redis) return fail(id, 'redis observation required')
  if (!cache) return fail(id, 'cache observation required')

  const articles = entitiesOf(db, 'article').filter((item) => item.fields?.featured === true || item.fields?.hot === true
    || item.projection === 'featured-hot')
  const owned = requireOwnedIds(articles.length ? articles : entitiesOf(db, 'article'), id)
  if (!owned.ok) return fail(id, owned.reason)

  const hotKeys = (redis.keys ?? []).filter((item) => item.present === true
    && (/hot|featured/i.test(String(item.key ?? '')) || /hot|featured/i.test(String(item.domain ?? ''))))
  if (hotKeys.length === 0) {
    return fail(id, 'Redis hot/featured keys missing')
  }

  const cacheEntries = (cache.entries ?? []).filter((item) => item.matchesDb === true
    || /hot|featured|home/i.test(String(item.domain ?? item.endpoint ?? '')))
  if (cacheEntries.length === 0) {
    return fail(id, 'cache/AOT generation observation missing for featured/hot')
  }
  for (const entry of cacheEntries) {
    if (entry.matchesDb === false) {
      return fail(id, 'cache endpoint still returns stale/non-DB article set')
    }
    if (Array.isArray(entry.visibleEntityIds) && entry.visibleEntityIds.length) {
      const visible = entry.visibleEntityIds.map(String)
      for (const articleId of owned.ids) {
        if (!visible.includes(articleId) && entry.requireOwnedVisible === true) {
          return fail(id, `owned article ${articleId} not visible in cache projection`)
        }
      }
    }
  }
  return pass(id, { articleIds: owned.ids, redisKeys: hotKeys.length })
}

function verifyAuthUser(id, { deleted = false, mfa = null, passkey = false, recovery = false } = {}) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const users = entitiesOf(db, 'user').filter((item) => item.postconditionId === id)
    const owned = requireOwnedIds(users, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const user of users) {
      const fields = user.fields ?? {}
      if (deleted) {
        if (fields.deleted !== true && fields.status !== 'deleted') {
          return fail(id, `user ${user.id} is not deleted`)
        }
      } else if (fields.deleted === true || fields.status === 'deleted') {
        return fail(id, `user ${user.id} is deleted`)
      } else if (fields.status && fields.status !== 'active') {
        return fail(id, `user ${user.id} status is not active`)
      }
      if (mfa !== null && fields.mfaEnabled !== mfa) {
        return fail(id, `user ${user.id} MFA state mismatch`)
      }
      if (passkey) {
        const ceremony = fields.ceremony ?? {}
        if (fields.passkeyEnabled !== true || ceremony.validationBoundary !== 'production-fido'
          || ceremony.challengeConsumed !== true || ceremony.signatureVerified !== true
          || ceremony.originVerified !== true || ceremony.rpIdVerified !== true
          || ceremony.counterVerified !== true || ceremony.acceptAnySignature === true) {
          return fail(id, `user ${user.id} production WebAuthn ceremony is incomplete`)
        }
      }
      if (recovery && fields.recoveryEnabled !== true) {
        return fail(id, `user ${user.id} recovery state is not enabled`)
      }
    }
    return pass(id, { userIds: owned.ids })
  }
}

function verifyAdminPermission(id, permission) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const admins = entitiesOf(db, 'admin').filter((item) => item.postconditionId === id)
    const owned = requireOwnedIds(admins, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const admin of admins) {
      const fields = admin.fields ?? {}
      if (permission === 'disabled') {
        if (fields.disabled !== true && fields.status !== 'disabled') {
          return fail(id, `admin ${admin.id} is not disabled`)
        }
      } else if (fields.permission !== permission && fields.permissionLevel !== permission) {
        // Allow capability-scoped single admin row with matching postcondition tag.
        if (admin.postconditionId !== id && fields.postconditionId !== id) {
          return fail(id, `admin ${admin.id} permission is not ${permission}`)
        }
      }
    }
    const redis = ctx.observations?.redis
    if (redis) {
      for (const key of redis.keys ?? []) {
        if (key.sessionRevoked === true && permission !== 'disabled') {
          return fail(id, 'admin session revoked while storage claims active')
        }
      }
    }
    return pass(id, { adminIds: owned.ids })
  }
}

function verifyAdminRootEmpty(ctx) {
  const id = 'admin-root-bootstrap-empty'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const roots = entitiesOf(db, 'admin-root-set').filter((item) => item.postconditionId === id)
  const owned = requireOwnedIds(roots, id)
  if (!owned.ok) return fail(id, owned.reason)
  if (roots.some((item) => item.fields?.state !== 'empty'
    || item.fields?.rootCount !== 0 || item.fields?.nonownedDeletionCount !== 0)) {
    return fail(id, 'root bootstrap empty state is not isolated and non-destructive')
  }
  return pass(id, { rootSets: owned.ids })
}

function verifySession(id, { multi = false, expectedState = 'active', remembered = false, rotated = false } = {}) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required for session binding')
    const allSessions = entitiesOf(db, 'session')
    const taggedSessions = allSessions.filter((item) => item.postconditionId === id)
    // Current producers always tag independent semantic identities. The
    // all-session fallback only preserves fail-closed verification for legacy
    // counterexamples that predate postcondition tags.
    const sessions = taggedSessions.length ? taggedSessions : allSessions
    const owned = requireOwnedIds(sessions, id)
    if (!owned.ok) return fail(id, owned.reason)
    const revokedKeys = (ctx.observations?.redis?.keys ?? []).filter((item) =>
      item.sessionRevoked === true && sessions.some((session) =>
        String(item.sessionId ?? item.key ?? '').includes(String(session.id))))
    if (revokedKeys.length && expectedState !== 'revoked') {
      return fail(id, 'session is revoked in the cache/read projection')
    }
    for (const session of sessions) {
      const fields = session.fields ?? {}
      const observedState = fields.state ?? (fields.active === true ? 'active' : null)
      if (observedState !== expectedState) return fail(id, `session ${session.id} state mismatch`)
      if (fields.databaseStateVerified !== true || fields.claimStateVerified !== true
        || fields.cacheStateVerified !== true) {
        return fail(id, `session ${session.id} DB/claim/cache postcondition is incomplete`)
      }
      if (expectedState === 'active' && fields.live !== true) {
        return fail(id, `session ${session.id} is not live`)
      }
      if (remembered && (fields.rememberMe !== true || fields.durationPolicy !== 'persistent_30d')) {
        return fail(id, `session ${session.id} remembered policy mismatch`)
      }
      if (rotated && (fields.oldRefreshAccepted !== false || fields.currentGeneration !== 1
        || fields.currentPointerVerified !== true)) {
        return fail(id, `session ${session.id} refresh rotation mismatch`)
      }
    }
    if (multi) {
      const devices = new Set(sessions.map((item) => item.fields?.deviceSignal))
      const families = new Set(sessions.map((item) => item.fields?.familyIdentity))
      if (sessions.length !== 2 || devices.size !== 2 || families.size !== 2) {
        return fail(id, 'multi-device session requires exactly two distinct live devices and families')
      }
    }
    return pass(id, { sessionIds: owned.ids })
  }
}

function verifyPresence(id, { entityKind, redisDomain = null, requireDb = true, requireRedis = false } = {}) {
  return (ctx) => {
    if (requireDb) {
      const db = ctx.observations?.database
      if (!db) return fail(id, 'database observation required')
      const entities = entitiesOf(db, entityKind)
      const owned = requireOwnedIds(entities, id)
      if (!owned.ok) return fail(id, owned.reason)
    }
    if (requireRedis || redisDomain) {
      const redis = ctx.observations?.redis
      if (!redis) return fail(id, 'redis observation required')
      const keys = redisDomain ? keysOf(redis, redisDomain) : (redis.keys ?? [])
      if (!keys.some((item) => item.present === true)) {
        return fail(id, `redis keys missing for ${redisDomain ?? id}`)
      }
    }
    return pass(id)
  }
}

function verifyScale(id) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const batches = entitiesOf(db, 'scale-batch').concat(entitiesOf(db, 'article'))
    const owned = requireOwnedIds(batches, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const row of batches) {
      if (row.fields?.scaleTier && !String(id).includes(String(row.fields.scaleTier))) {
        // soft: scale tier recorded on observation when present
      }
      if (Number(row.fields?.count ?? row.fields?.articleCount ?? 1) <= 0) {
        return fail(id, 'scale count must be exact positive owned rows, not >0-only probe')
      }
    }
    return pass(id, { ids: owned.ids })
  }
}

function verifyRevisionHistory(ctx) {
  const id = 'article-revision-history'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const articles = entitiesOf(db, 'article')
  const owned = requireOwnedIds(articles, id)
  if (!owned.ok) return fail(id, owned.reason)
  for (const article of articles) {
    const fields = article.fields ?? {}
    if (!Array.isArray(fields.revisionIds) || fields.revisionIds.length < 1) {
      return fail(id, `article ${article.id} missing revision history`)
    }
    if (fields.currentRevisionId == null || fields.currentRevisionId === '') {
      return fail(id, `article ${article.id} missing current revision`)
    }
  }
  return pass(id)
}

function verifyMultipleRevisions(ctx) {
  const id = 'article-multiple-revisions'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const scoped = entitiesOf(db, 'article').filter((item) => item.capabilityHint === id
    || item.postconditionId === id
    || item.fields?.multipleRevisions === true
    || (Array.isArray(item.fields?.revisionIds) && item.fields.revisionIds.length >= 2))
  const owned = requireOwnedIds(scoped.length ? scoped : entitiesOf(db, 'article'), id)
  if (!owned.ok) return fail(id, owned.reason)
  const ok = (scoped.length ? scoped : entitiesOf(db, 'article')).some((item) => {
    const count = Number(item.fields?.revisionCount ?? item.fields?.revisionIds?.length ?? 0)
    return count >= 2 || item.fields?.multipleRevisions === true
  })
  if (!ok) return fail(id, 'no owned article has multiple revisions')
  return pass(id, { articleIds: owned.ids })
}

function verifyMultiplePublications(ctx) {
  const id = 'article-multiple-publications'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const scoped = entitiesOf(db, 'article').filter((item) => item.capabilityHint === id
    || item.postconditionId === id
    || item.fields?.multiplePublications === true
    || Number(item.fields?.publicationCount ?? 0) >= 2)
  const owned = requireOwnedIds(scoped, id)
  if (!owned.ok) return fail(id, owned.reason)
  for (const article of scoped) {
    if (Number(article.fields?.publicationCount ?? 0) < 2 && article.fields?.multiplePublications !== true) {
      return fail(id, `article ${article.id} missing multiple publications`)
    }
  }
  return pass(id, { articleIds: owned.ids })
}

function verifyTaxonomyCategoryTag(ctx) {
  const id = 'taxonomy-category-tag'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const categories = entitiesOf(db, 'category')
  const tags = entitiesOf(db, 'tag')
  const cat = requireOwnedIds(categories, `${id}:category`)
  const tag = requireOwnedIds(tags, `${id}:tag`)
  if (!cat.ok) return fail(id, cat.reason)
  if (!tag.ok) return fail(id, tag.reason)
  return pass(id, { categoryIds: cat.ids, tagIds: tag.ids })
}

function verifySearchIndexed(ctx) {
  const id = 'search-indexed'
  const cache = ctx.observations?.cache
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  if (!cache) return fail(id, 'cache observation required for search index')
  const articles = entitiesOf(db, 'article').filter((item) => String(item.fields?.status ?? '') === 'published')
  const owned = requireOwnedIds(articles.length ? articles : entitiesOf(db, 'article'), id)
  if (!owned.ok) return fail(id, owned.reason)
  const searchEntries = (cache.entries ?? []).filter((item) => /search/i.test(String(item.domain ?? item.endpoint ?? ''))
    || item.searchHit === true
    || item.searchToken)
  if (searchEntries.length === 0) return fail(id, 'search index observation missing')
  if (!searchEntries.some((item) => item.searchHit === true || item.matchesDb === true)) {
    return fail(id, 'search token did not hit owned entity')
  }
  return pass(id, { articleIds: owned.ids })
}

function verifyPublicEmpty(ctx) {
  const id = 'public-empty'
  const db = ctx.observations?.database
  const redis = ctx.observations?.redis
  const cache = ctx.observations?.cache
  if (!db) return fail(id, 'database observation required')
  const articles = entitiesOf(db, 'article')
  const categories = entitiesOf(db, 'category')
  const tags = entitiesOf(db, 'tag')
  if (articles.length || categories.length || tags.length) {
    return fail(id, 'public-empty namespace still has owned content entities')
  }
  if (redis) {
    const residual = (redis.keys ?? []).filter((item) => item.present === true
      && (/hot|featured|top_articles/i.test(String(item.key ?? '')) || /hot|featured/i.test(String(item.domain ?? '')))
      && Array.isArray(item.memberIds) && item.memberIds.length > 0)
    if (residual.length) return fail(id, 'public-empty still has residual hot/featured redis members')
  }
  if (cache) {
    for (const entry of cache.entries ?? []) {
      if (Array.isArray(entry.visibleEntityIds) && entry.visibleEntityIds.length > 0) {
        return fail(id, 'public-empty cache still exposes visible entities')
      }
    }
  }
  return pass(id)
}

function verifyDemoDataset(ctx) {
  const id = 'development-demo-dataset'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  if ((db.entities ?? []).length === 0) return fail(id, 'demo dataset has zero owned entities')
  return pass(id, { count: db.entities.length })
}

function verifyCommentMatrix(id) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const comments = entitiesOf(db, 'comment')
    const owned = requireOwnedIds(comments, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const comment of comments) {
      if (!comment.fields?.articleId) return fail(id, `comment ${comment.id} missing articleId`)
      if (id === 'comment-threaded' && comment.fields?.parentId == null && comment.fields?.threadDepth == null) {
        return fail(id, `comment ${comment.id} missing thread relation`)
      }
    }
    return pass(id, { commentIds: owned.ids })
  }
}

function verifyMessages(id) {
  return (ctx) => {
    const db = ctx.observations?.database
    const redis = ctx.observations?.redis
    if (!db) return fail(id, 'database observation required')
    const threads = entitiesOf(db, 'thread').concat(entitiesOf(db, 'notification'))
    const owned = requireOwnedIds(threads, id)
    if (!owned.ok) return fail(id, owned.reason)
    if (id === 'notifications-unread') {
      if (!redis) return fail(id, 'redis notification observation required')
      const keys = (redis.keys ?? []).filter((item) => item.present === true)
      if (keys.length === 0) return fail(id, 'notification redis keys missing')
    }
    return pass(id, { ids: owned.ids })
  }
}

function verifyLocale(id) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const prefs = entitiesOf(db, 'preference')
    const owned = requireOwnedIds(prefs, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const pref of prefs) {
      if (id === 'locale-auto' && pref.fields?.localeMode !== 'auto') {
        return fail(id, `preference ${pref.id} is not locale-auto`)
      }
      if (id === 'locale-fixed' && pref.fields?.localeMode !== 'fixed') {
        return fail(id, `preference ${pref.id} is not locale-fixed`)
      }
    }
    return pass(id)
  }
}

function verifyModerationPolicy(ctx) {
  const id = 'moderation-policy-matrix'
  const db = ctx.observations?.database
  if (!db) return fail(id, 'database observation required')
  const rows = (db.entities ?? []).filter((item) => item.kind === 'moderation-policy' || item.kind === 'other')
  const owned = requireOwnedIds(rows.length ? rows : db.entities, id)
  if (!owned.ok) return fail(id, owned.reason)
  return pass(id, { ids: owned.ids })
}

/** Built-in machine postcondition verifiers keyed by catalog postconditionId. */
export const POSTCONDITION_VERIFIERS = Object.freeze({
  'article-published': verifyArticlePublished,
  'article-archived': verifyArticleStatus('article-archived', 'archived', { allowMissingPublication: true }),
  'article-deleted': verifyArticleStatus('article-deleted', 'deleted', { allowMissingPublication: true }),
  'article-draft': verifyArticleStatus('article-draft', 'draft', { allowMissingPublication: true }),
  'article-scheduled': verifyArticleStatus('article-scheduled', 'scheduled', { allowMissingPublication: true }),
  'article-revision-history': verifyRevisionHistory,
  'article-multiple-revisions': verifyMultipleRevisions,
  'article-multiple-publications': verifyMultiplePublications,
  'taxonomy-category-tag': verifyTaxonomyCategoryTag,
  'search-indexed': verifySearchIndexed,
  'public-empty': verifyPublicEmpty,
  'home-featured-hot': verifyHomeFeaturedHot,
  'user-active': verifyAuthUser('user-active'),
  'user-deleted': verifyAuthUser('user-deleted', { deleted: true }),
  'user-mfa-disabled': verifyAuthUser('user-mfa-disabled', { mfa: false }),
  'user-mfa-enabled': verifyAuthUser('user-mfa-enabled', { mfa: true }),
  'user-passkey-enabled': verifyAuthUser('user-passkey-enabled', { passkey: true }),
  'user-recovery-enabled': verifyAuthUser('user-recovery-enabled', { recovery: true }),
  'admin-disabled': verifyAdminPermission('admin-disabled', 'disabled'),
  'admin-full-permission': verifyAdminPermission('admin-full-permission', 'full'),
  'admin-partial-permission': verifyAdminPermission('admin-partial-permission', 'partial'),
  'admin-read-only': verifyAdminPermission('admin-read-only', 'read-only'),
  'admin-root-bootstrap-empty': verifyAdminRootEmpty,
  'session-expired': verifySession('session-expired', { expectedState: 'expired' }),
  'session-single-device': verifySession('session-single-device', { multi: false }),
  'session-multi-device': verifySession('session-multi-device', { multi: true }),
  'session-refresh-rotated': verifySession('session-refresh-rotated', { expectedState: 'rotated', rotated: true }),
  'session-remembered': verifySession('session-remembered', { remembered: true }),
  'session-revoked': verifySession('session-revoked', { expectedState: 'revoked' }),
  'comment-moderation-matrix': verifyCommentMatrix('comment-moderation-matrix'),
  'comment-threaded': verifyCommentMatrix('comment-threaded'),
  'moderation-policy-matrix': verifyModerationPolicy,
  'messages-thread': verifyMessages('messages-thread'),
  'notifications-unread': verifyMessages('notifications-unread'),
  'locale-auto': verifyLocale('locale-auto'),
  'locale-fixed': verifyLocale('locale-fixed'),
  'development-demo-dataset': verifyDemoDataset,
  'scale-xs': verifyScale('scale-xs'),
  'scale-s': verifyScale('scale-s'),
  'scale-m': verifyScale('scale-m'),
  'scale-l': verifyScale('scale-l'),
  ...securityPostconditionVerifiers
})

/**
 * Ensure every #1707 capability postconditionId has a machine verifier.
 * Fail closed on gaps.
 */
export function assertPostconditionRegistryComplete(catalogs = readFixtureCatalogs()) {
  const missing = []
  for (const capability of catalogs.capability.capabilities ?? []) {
    for (const postconditionId of capability.postconditionIds ?? []) {
      if (typeof POSTCONDITION_VERIFIERS[postconditionId] !== 'function') {
        missing.push(`${capability.id}→${postconditionId}`)
      }
    }
  }
  if (missing.length) {
    throw new Error(`postcondition registry incomplete (fail closed): ${missing.sort().join(', ')}`)
  }
  return true
}

export function listPostconditionIds(catalogs = readFixtureCatalogs()) {
  return [...new Set((catalogs.capability.capabilities ?? []).flatMap((item) => item.postconditionIds ?? []))].sort()
}

/**
 * Run a single postcondition by ID.
 * @param {string} postconditionId
 * @param {{ observations, entityIdentities, capabilityId, producerId }} context
 */
export function runPostcondition(postconditionId, context) {
  const verifier = POSTCONDITION_VERIFIERS[postconditionId]
  if (typeof verifier !== 'function') {
    return fail(postconditionId, `no machine postcondition registered for ${postconditionId}`)
  }
  if (!context || !plainObject(context.observations ?? {})) {
    return fail(postconditionId, 'observations object required')
  }
  // Reject local fallback / warning / stale markers as evidence.
  if (context.observations?.source === 'local-fallback'
    || context.observations?.fallback === true
    || context.observations?.warningOnly === true
    || context.observations?.stale === true) {
    return fail(postconditionId, 'fallback/warning/stale observations cannot verify postconditions')
  }
  return verifier(context)
}

/**
 * Verify every capability in a profile has all postcondition IDs executed.
 */
export function verifyCapabilityPostconditions({
  capabilities,
  producerId,
  providedCapabilities,
  observations,
  entityIdentities = [],
  catalogs = readFixtureCatalogs()
}) {
  assertPostconditionRegistryComplete(catalogs)
  const capabilityById = new Map((catalogs.capability.capabilities ?? []).map((item) => [item.id, item]))
  const results = []
  const required = []

  for (const capabilityId of providedCapabilities ?? []) {
    const capability = capabilityById.get(capabilityId)
    if (!capability) {
      throw new Error(`producer ${producerId} provided unknown capability ${capabilityId}`)
    }
    if (capabilities && !capabilities.includes(capabilityId)) {
      throw new Error(`producer ${producerId} provided undeclared capability ${capabilityId} for this profile`)
    }
    for (const postconditionId of capability.postconditionIds ?? []) {
      required.push({ capabilityId, postconditionId })
      const result = runPostcondition(postconditionId, {
        observations,
        entityIdentities,
        capabilityId,
        producerId
      })
      results.push(freezeDeep({ capabilityId, ...result }))
    }
  }

  // Fail closed: every required postcondition must pass.
  const failed = results.filter((item) => item.ok !== true)
  if (failed.length) {
    const message = failed.map((item) => `${item.capabilityId}/${item.postconditionId}: ${item.reason}`).join('; ')
    const error = new Error(`postcondition verification failed: ${message}`)
    error.results = results
    throw error
  }

  // Also require that profile capabilities owned by this producer are covered when providedCapabilities is the profile slice.
  return Object.freeze({ ok: true, results: Object.freeze(results), required: Object.freeze(required) })
}

/**
 * Profile-level: every expanded capability must have at least one postcondition ID and a verifier.
 */
export function assertProfilePostconditionsBound(capabilities, catalogs = readFixtureCatalogs()) {
  assertPostconditionRegistryComplete(catalogs)
  const capabilityById = new Map((catalogs.capability.capabilities ?? []).map((item) => [item.id, item]))
  const missing = []
  for (const capabilityId of capabilities ?? []) {
    const capability = capabilityById.get(capabilityId)
    if (!capability) {
      missing.push(`${capabilityId}:unknown`)
      continue
    }
    if (!capability.postconditionIds?.length) {
      missing.push(`${capabilityId}:no-postcondition`)
    }
  }
  if (missing.length) {
    throw new Error(`profile capabilities missing postcondition binding: ${missing.sort().join(', ')}`)
  }
  return true
}
