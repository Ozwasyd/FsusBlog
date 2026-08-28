function fail(id, reason)
{
    return Object.freeze({ ok: false, postconditionId: id, reason });
}

function pass(id, detail = null)
{
    return Object.freeze({ ok: true, postconditionId: id, detail });
}

function requireOwnedIds(entities, label)
{
    const ids = entities.map((item) => String(item.id ?? '')).filter(Boolean).sort();
    return ids.length === 0
        ? { ok: false, reason: `${label}: no owned entity IDs` }
        : { ok: true, ids };
}

function verifySecurity(id, capabilityId, expectedDecision, { clean = false, counter = null } = {})
{
    return (context) =>
    {
        const db = context.observations?.database;
        const redis = context.observations?.redis;
        const cache = context.observations?.cache;
        if (!db || !redis || !cache)
        {
            return fail(id, 'database, Redis, and service/cache observations are required');
        }
        const subjects = (db.entities ?? []).filter((item) => item.fields?.capabilityId === capabilityId);
        const owned = requireOwnedIds(subjects, id);
        if (!owned.ok)
        {
            return fail(id, owned.reason);
        }
        for (const subject of subjects)
        {
            const fields = subject.fields ?? {};
            if (fields.databasePresent !== !clean || fields.redisPresent !== !clean
              || fields.hashVersion !== 'sha256-v1' || fields.version == null
              || typeof fields.reason !== 'string' || !fields.reason
              || typeof fields.windowStartUtc !== 'string'
              || fields.serviceDecision !== expectedDecision || fields.serviceObserved !== true
              || !Number.isInteger(fields.cacheGeneration) || fields.cacheInvalidationObserved !== true
              || fields.auditPresent !== true)
            {
                return fail(id, `security subject ${subject.id} has incomplete exact postconditions`);
            }
            if (!clean && (typeof fields.expiresAtUtc !== 'string'
              || Date.parse(fields.expiresAtUtc) <= Date.parse(fields.windowStartUtc)
              || !Number.isInteger(fields.redisTtlSeconds) || fields.redisTtlSeconds <= 0))
            {
                return fail(id, `security subject ${subject.id} has invalid TTL/window evidence`);
            }
            if (counter === 'near-limit'
              && (fields.counter?.blocked !== false || fields.counter?.current !== fields.counter?.limit - 1))
            {
                return fail(id, 'near-limit counter is not exactly limit - 1');
            }
            if (counter === 'blocked'
              && (fields.counter?.blocked !== true || fields.counter?.current < fields.counter?.limit))
            {
                return fail(id, 'blocked counter is below its exact limit');
            }
        }
        const keys = (redis.keys ?? []).filter((item) => item.capabilityId === capabilityId);
        if (keys.length !== subjects.length || keys.some((item) => item.present !== !clean
          || item.namespace !== redis.namespace || item.hashVersion !== 'sha256-v1'
          || (!clean && (!Number.isInteger(item.ttlSeconds) || item.ttlSeconds <= 0))))
        {
            return fail(id, 'security Redis key/TTL/namespace evidence is not exact');
        }
        const decisions = (cache.entries ?? []).filter((item) => item.capabilityId === capabilityId);
        if (decisions.length !== subjects.length || decisions.some((item) => item.serviceDecision !== expectedDecision
          || item.serviceObserved !== true || item.invalidationObserved !== true || item.matchesDb !== true))
        {
            return fail(id, 'security service decision/cache evidence is not exact');
        }
        return pass(id, { ids: owned.ids, redisKeys: keys.length, serviceDecisions: decisions.length });
    };
}

export const securityPostconditionVerifiers = Object.freeze({
    'audit-active-window': verifySecurity('audit-active-window', 'security.audit.active-window', 'active-window'),
    'credential-active': verifySecurity('credential-active', 'security.credential.active', 'accepted'),
    'credential-revoked': verifySecurity('credential-revoked', 'security.credential.revoked', 'rejected'),
    'issuance-replay-observed': verifySecurity('issuance-replay-observed', 'security.issuance.replay-observed', 'replay-rejected'),
    'nullifier-blocked': verifySecurity('nullifier-blocked', 'security.nullifier.blocked', 'rejected'),
    'pow-elevated': verifySecurity('pow-elevated', 'security.pow.elevated', 'elevated'),
    'rate-limit-blocked': verifySecurity('rate-limit-blocked', 'security.rate-limit.blocked', 'blocked', { counter: 'blocked' }),
    'rate-limit-near-limit': verifySecurity('rate-limit-near-limit', 'security.rate-limit.near-limit', 'near-limit', { counter: 'near-limit' }),
    'risk-escalated': verifySecurity('risk-escalated', 'security.risk.escalated', 'escalated'),
    'risk-low': verifySecurity('risk-low', 'security.risk.low', 'low'),
    'security-clean': verifySecurity('security-clean', 'security.clean', 'clean', { clean: true }),
    'subject-banned': verifySecurity('subject-banned', 'security.subject.banned', 'rejected'),
    'subject-unbanned': verifySecurity('subject-unbanned', 'security.subject.unbanned', 'accepted')
});
