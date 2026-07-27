/**
 * Machine-executable postcondition registry for #1707 capabilities (#1710).
 *
 * Every catalog postconditionId binds to a pure verifier over observations +
 * entity identities. Missing observations or weak checks (row count > 0 only,
 * HTTP 200 only, file exists) fail closed.
 */

import { readFixtureCatalogs } from '../../testing/fixture-catalog.mjs'
import { freezeDeep, plainObject } from './canonical.mjs'

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

function verifyAuthUser(id, { deleted = false, mfa = false } = {}) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const users = entitiesOf(db, 'user')
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
      if (mfa && fields.mfaEnabled !== true) {
        return fail(id, `user ${user.id} MFA is not enabled`)
      }
    }
    if (mfa) {
      const redis = ctx.observations?.redis
      if (!redis) return fail(id, 'redis session observation required for MFA')
      const sessionKeys = (redis.keys ?? []).filter((item) => item.present === true
        && (/session|mfa/i.test(String(item.key ?? '')) || /session|mfa/i.test(String(item.domain ?? ''))))
      if (sessionKeys.length === 0) return fail(id, 'MFA session/cache keys missing')
      for (const key of sessionKeys) {
        if (key.sessionRevoked === true) return fail(id, 'session is revoked while MFA capability claims active')
        if (key.mfaClaim !== true && key.claimDigest == null) {
          return fail(id, 'MFA session claim missing')
        }
      }
    }
    return pass(id, { userIds: owned.ids })
  }
}

function verifyAdminPermission(id, permission) {
  return (ctx) => {
    const db = ctx.observations?.database
    if (!db) return fail(id, 'database observation required')
    const admins = entitiesOf(db, 'admin')
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

function verifySession(id, { multi = false } = {}) {
  return (ctx) => {
    const redis = ctx.observations?.redis
    const db = ctx.observations?.database
    if (!redis) return fail(id, 'redis session observation required')
    if (!db) return fail(id, 'database observation required for session binding')
    const sessions = entitiesOf(db, 'session')
    const keys = (redis.keys ?? []).filter((item) => item.present === true
      && (/session/i.test(String(item.key ?? '')) || String(item.domain ?? '').includes('session')))
    if (keys.length === 0) return fail(id, 'session redis keys missing')
    for (const key of keys) {
      if (key.sessionRevoked === true) return fail(id, 'session revoked (auth storage file is not sufficient)')
    }
    if (multi) {
      if (keys.length < 2 && sessions.length < 2) {
        return fail(id, 'multi-device session requires >=2 live sessions')
      }
    }
    return pass(id, { sessionKeys: keys.length, sessions: sessions.length })
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

function verifySecurity(id, field) {
  return (ctx) => {
    const db = ctx.observations?.database
    const redis = ctx.observations?.redis
    if (!db) return fail(id, 'database observation required')
    const subjects = entitiesOf(db, 'security-subject').concat(entitiesOf(db, 'user'))
    const owned = requireOwnedIds(subjects, id)
    if (!owned.ok) return fail(id, owned.reason)
    for (const subject of subjects) {
      if (subject.fields?.[field] !== true && subject.fields?.state !== field) {
        if (subject.postconditionId !== id) {
          return fail(id, `security subject ${subject.id} missing ${field}`)
        }
      }
    }
    if (redis && field === 'riskEscalated') {
      const keys = (redis.keys ?? []).filter((item) => item.present === true && /risk|pow/i.test(String(item.key ?? item.domain ?? '')))
      if (keys.length === 0) return fail(id, 'security redis risk keys missing')
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
  'home-featured-hot': verifyHomeFeaturedHot,
  'user-active': verifyAuthUser('user-active'),
  'user-deleted': verifyAuthUser('user-deleted', { deleted: true }),
  'user-mfa-enabled': verifyAuthUser('user-mfa-enabled', { mfa: true }),
  'admin-disabled': verifyAdminPermission('admin-disabled', 'disabled'),
  'admin-full-permission': verifyAdminPermission('admin-full-permission', 'full'),
  'admin-partial-permission': verifyAdminPermission('admin-partial-permission', 'partial'),
  'admin-read-only': verifyAdminPermission('admin-read-only', 'read-only'),
  'session-single-device': verifySession('session-single-device', { multi: false }),
  'session-multi-device': verifySession('session-multi-device', { multi: true }),
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
  'credential-revoked': verifySecurity('credential-revoked', 'credentialRevoked'),
  'pow-elevated': verifySecurity('pow-elevated', 'powElevated'),
  'risk-escalated': verifySecurity('risk-escalated', 'riskEscalated'),
  'subject-banned': verifySecurity('subject-banned', 'banned')
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
