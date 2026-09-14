import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const observationRelative = '.tmp/contracts/auth-session/auth-session-permission-observation.json';
const expectedArtifactId = 'auth-session-permission-observation';
const expectedSchema = 'fsusblog.auth-session-permission-observation.v2';
const expectedRelationSchema = 'fsusblog.auth-session-relation-catalog.v1';

const requiredFactKeys = Object.freeze([
    'auth.authentication-methods',
    'auth.authentication-strengths',
    'auth.session.duration-modes',
    'auth.session.idle-expiry-policy',
    'auth.session.absolute-expiry-policy',
    'auth.refresh.context-preservation',
    'auth.step-up.freshness',
    'auth.step-up.binding',
    'auth.step-up.consume-once',
    'auth.passkey.states',
    'auth.mfa.states',
    'auth.recovery.states',
    'auth.credential-session-revocation',
    'auth.relations',
    'admin.permissions.all',
    'admin.permissions.read-only',
    'admin.permissions.partial-policy',
    'admin.disabled-access'
]);

function failResult(reasons)
{
    return {
        status: 'failed',
        failureReasons: reasons.map(String),
        observations: {}
    };
}

function isSortedUniqueStrings(values)
{
    if (!Array.isArray(values) || values.length === 0)
    {
        return false;
    }
    if (values.some((value) => typeof value !== 'string' || value.length === 0))
    {
        return false;
    }
    if (new Set(values).size !== values.length)
    {
        return false;
    }
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sorted.every((value, index) => value === values[index]);
}

function isDuration(value)
{
    return value != null
    && typeof value === 'object'
    && typeof value.value === 'number'
    && Number.isFinite(value.value)
    && typeof value.unit === 'string'
    && value.unit.length > 0;
}

function validateRelations(relations, failureReasons)
{
    if (relations?.schema !== expectedRelationSchema || relations?.version !== 1 || relations?.closed !== true)
    {
        failureReasons.push(`auth.relations must be closed ${expectedRelationSchema}`);
        return;
    }
    if (!Array.isArray(relations.entries) || relations.entries.length === 0)
    {
        failureReasons.push('auth.relations.entries must be non-empty');
        return;
    }
    const expected = new Set([
        'auth.relation.mfa-enabled-step-up-method',
        'auth.relation.passkey-auth-strength',
        'auth.relation.passkey-is-not-totp',
        'auth.relation.recovery-auth-strength',
        'auth.relation.recovery-does-not-mint-step-up',
        'auth.relation.step-up-binding',
        'auth.relation.step-up-consume-once',
        'auth.relation.refresh-preserves-auth-context',
        'auth.relation.refresh-does-not-rebuild-step-up',
        'auth.relation.passkey-delete-revokes-bound-sessions',
        'auth.relation.passkey-delete-does-not-revoke-unbound-sessions'
    ]);
    const required = new Set(expected);
    const ids = new Set();
    for (const relation of relations.entries)
    {
        const id = relation?.relationId;
        if (typeof id !== 'string' || !/^auth\.relation\.[a-z0-9-]+$/u.test(id))
        {
            failureReasons.push('auth relation missing stable relationId');
            continue;
        }
        if (ids.has(id))
        {
            failureReasons.push(`duplicate auth relation ${id}`);
        }
        if (!expected.has(id))
        {
            failureReasons.push(`unexpected auth relation ${id}`);
        }
        ids.add(id);
        required.delete(id);
        for (const key of ['subject', 'predicate', 'object', 'direction', 'condition', 'sourceOwner', 'sourceRange'])
        {
            if (typeof relation[key] !== 'string' || relation[key].length === 0)
            {
                failureReasons.push(`${id} missing ${key}`);
            }
        }
        if (!['true', 'false', 'conditional', 'unknown', 'not-applicable'].includes(relation.truthValue))
        {
            failureReasons.push(`${id} has invalid truthValue`);
        }
        if (relation.scope == null || typeof relation.scope !== 'object' || Array.isArray(relation.scope))
        {
            failureReasons.push(`${id} missing typed scope`);
        }
        if (!isSortedUniqueStrings(relation.proofTests))
        {
            failureReasons.push(`${id} missing proofTests`);
        }
    }
    for (const id of required)
    {
        failureReasons.push(`missing required auth relation ${id}`);
    }
}

/**
 * compiled-assembly extractor for auth/session/MFA/admin-permission facts.
 * Reads only the sealed observation artifact produced by FsusBlog.AuthSessionObservation
 * for this exact build identity. Never reads docs, fixtures, example JWTs, or frontend copy.
 */
// BEHAVIOR-OWNER: authentication-session-permission
export function extract(context)
{
    const buildIdentity = context.buildIdentity;
    if (buildIdentity == null || typeof buildIdentity !== 'object')
    {
        return failResult(['auth-session-permission-fact-extractor requires exact buildIdentity']);
    }
    if (buildIdentity.artifactId !== expectedArtifactId)
    {
        return failResult([`unexpected artifactId ${buildIdentity.artifactId}`]);
    }
    if (/bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.artifactId))
    || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
    {
        return failResult(['refuses ambient bin/Debug or bin/Release observation identity']);
    }

    const absolute = path.join(context.repositoryRoot, observationRelative);
    if (!existsSync(absolute))
    {
        return failResult([`missing sealed observation artifact ${observationRelative}`]);
    }

    const bytes = readFileSync(absolute);
    const artifactDigest = createHash('sha256').update(bytes).digest('hex');
    if (artifactDigest !== buildIdentity.artifactDigest)
    {
        return failResult([
            `observation artifact digest mismatch (refuses unbound or stale build; expected ${buildIdentity.artifactDigest}, got ${artifactDigest})`
        ]);
    }

    let observation;
    try
    {
        observation = JSON.parse(bytes.toString('utf8'));
    }
    catch (error)
    {
        return failResult([`observation JSON parse failed: ${error instanceof Error ? error.message : String(error)}`]);
    }

    if (observation?.schema !== expectedSchema)
    {
        return failResult([`observation schema is not ${expectedSchema}`]);
    }
    if (observation.source === 'checked-in-docs'
    || observation.source === 'test-fixture'
    || observation.source === 'defaultAdminPermissions'
    || observation.generatedFromDocs === true)
    {
        return failResult(['observation must not be reverse-generated from docs, fixtures, or defaultAdminPermissions']);
    }
    if (observation.status === 'failed' || (Array.isArray(observation.failureReasons) && observation.failureReasons.length > 0))
    {
        return failResult([
            'observation host reported coherence failure',
            ...(Array.isArray(observation.failureReasons) ? observation.failureReasons.map(String) : [])
        ]);
    }

    const facts = observation.facts;
    if (facts == null || typeof facts !== 'object' || Array.isArray(facts))
    {
        return failResult(['observation.facts missing']);
    }

    const failureReasons = [];
    for (const key of requiredFactKeys)
    {
        if (!Object.hasOwn(facts, key))
        {
            failureReasons.push(`missing required fact ${key}`);
        }
    }
    if (failureReasons.length > 0)
    {
        return failResult(failureReasons);
    }

    const methods = facts['auth.authentication-methods']?.active;
    if (!isSortedUniqueStrings(methods))
    {
        failureReasons.push('auth.authentication-methods.active must be a sorted unique string set');
    }

    const strengths = facts['auth.authentication-strengths'];
    const activeStrengths = strengths?.active;
    const legacy = strengths?.legacy;
    if (!isSortedUniqueStrings(activeStrengths))
    {
        failureReasons.push('auth.authentication-strengths.active must be a sorted unique string set');
    }
    if (Array.isArray(activeStrengths) && activeStrengths.some((value) => String(value).startsWith('legacy_')))
    {
        failureReasons.push('legacy strengths must not enter active current-auth facts');
    }
    if (legacy == null
    || legacy.writeAllowed !== false
    || legacy.readMigrationOnly !== true
    || !isSortedUniqueStrings(legacy.values))
    {
        failureReasons.push('legacy strengths must declare writeAllowed=false and readMigrationOnly=true');
    }
    if (Array.isArray(legacy?.values) && legacy.values.some((value) => !String(value).startsWith('legacy_')))
    {
        failureReasons.push('legacy.values must only contain legacy_* strengths');
    }

    const durationModes = facts['auth.session.duration-modes'];
    if (!isSortedUniqueStrings(durationModes?.modes))
    {
        failureReasons.push('auth.session.duration-modes.modes must be a sorted unique string set');
    }
    const cookieProjection = durationModes?.cookieProjection;
    if (cookieProjection?.browser_session?.persistentCookie !== false)
    {
        failureReasons.push('browser_session must not project as persistent cookie');
    }
    if (cookieProjection?.persistent_30d?.persistentCookie !== true)
    {
        failureReasons.push('persistent_30d must project as persistent cookie');
    }

    const idlePolicy = facts['auth.session.idle-expiry-policy'];
    const absolutePolicy = facts['auth.session.absolute-expiry-policy'];
    for (const [label, policy] of [
        ['idle.browser_session', idlePolicy?.browser_session],
        ['idle.persistent_30d', idlePolicy?.persistent_30d],
        ['idle.admin', idlePolicy?.admin],
        ['absolute.browser_session', absolutePolicy?.browser_session],
        ['absolute.persistent_30d', absolutePolicy?.persistent_30d],
        ['absolute.admin', absolutePolicy?.admin]
    ])
    {
        if (!isDuration(policy))
        {
            failureReasons.push(`${label} must be typed duration with unit`);
        }
    }

    const freshness = facts['auth.step-up.freshness'];
    for (const key of ['default', 'minimum', 'maximum'])
    {
        if (!isDuration(freshness?.[key]))
        {
            failureReasons.push(`auth.step-up.freshness.${key} must be typed duration`);
        }
    }

    const binding = facts['auth.step-up.binding']?.fields;
    if (!isSortedUniqueStrings(binding))
    {
        failureReasons.push('auth.step-up.binding.fields must be a sorted unique string set');
    }
    else
    {
        for (const required of ['account', 'session', 'action', 'token', 'expiry'])
        {
            if (!binding.includes(required))
            {
                failureReasons.push(`auth.step-up.binding missing field ${required}`);
            }
        }
    }

    if (facts['auth.step-up.consume-once'] !== true)
    {
        failureReasons.push('auth.step-up.consume-once must be true');
    }

    const refresh = facts['auth.refresh.context-preservation'];
    if (!isSortedUniqueStrings(refresh?.preserves)
    || !isSortedUniqueStrings(refresh?.doesNotPreserve)
    || !isSortedUniqueStrings(refresh?.mayUpdate))
    {
        failureReasons.push('auth.refresh.context-preservation must expose sorted preserves/doesNotPreserve/mayUpdate sets');
    }
    if (Array.isArray(refresh?.preserves) && !refresh.preserves.includes('auth_time'))
    {
        failureReasons.push('refresh must preserve auth_time');
    }
    if (Array.isArray(refresh?.preserves) && refresh.preserves.includes('step_up_proof'))
    {
        failureReasons.push('refresh must not preserve step_up_proof');
    }
    if (Array.isArray(refresh?.doesNotPreserve) && !refresh.doesNotPreserve.includes('step_up_proof'))
    {
        failureReasons.push('refresh doesNotPreserve must list step_up_proof');
    }

    if (!isSortedUniqueStrings(facts['auth.mfa.states']))
    {
        failureReasons.push('auth.mfa.states must be a sorted unique string set');
    }
    if (!isSortedUniqueStrings(facts['auth.recovery.states']))
    {
        failureReasons.push('auth.recovery.states must be a sorted unique string set');
    }
    if (!isSortedUniqueStrings(facts['auth.passkey.states']?.enrollment)
    || !isSortedUniqueStrings(facts['auth.passkey.states']?.credentialPresence))
    {
        failureReasons.push('auth.passkey.states enrollment/credentialPresence must be sorted unique sets');
    }

    const revocation = facts['auth.credential-session-revocation'];
    if (!Array.isArray(revocation?.transitions) || revocation.transitions.length === 0)
    {
        failureReasons.push('auth.credential-session-revocation.transitions must be a non-empty transition graph');
    }

    validateRelations(facts['auth.relations'], failureReasons);
    if (!isSortedUniqueStrings(revocation?.failureModes))
    {
        failureReasons.push('auth.credential-session-revocation.failureModes must be a sorted unique set');
    }

    const adminAll = facts['admin.permissions.all'];
    if (!isSortedUniqueStrings(adminAll))
    {
        failureReasons.push('admin.permissions.all must be a sorted unique string set from production catalog');
    }
    if (Array.isArray(adminAll) && !adminAll.includes('audit.investigate'))
    {
        failureReasons.push('admin.permissions.all must include production catalog item audit.investigate');
    }

    const readOnly = facts['admin.permissions.read-only'];
    if (!isSortedUniqueStrings(readOnly))
    {
        failureReasons.push('admin.permissions.read-only must be a sorted unique string set');
    }

    const partial = facts['admin.permissions.partial-policy'];
    if (partial == null || typeof partial !== 'object' || partial.catalogAuthority !== 'AdminPermissions.All')
    {
        failureReasons.push('admin.permissions.partial-policy must reference AdminPermissions.All catalog authority');
    }

    const disabled = facts['admin.disabled-access'];
    if (disabled?.loginAllowed !== false || disabled?.stepUpAllowed !== false || disabled?.status !== 'disabled')
    {
        failureReasons.push('admin.disabled-access must deny login/step-up for status=disabled');
    }

    const coherence = facts.coherence;
    if (coherence != null)
    {
        for (const key of ['loginRefreshIdleTtl', 'durationPolicyCookieProjection', 'jwtSessionValidationClaims'])
        {
            if (coherence[key] === 'inconsistent')
            {
                failureReasons.push(`multi-layer coherence failed: ${key}`);
            }
        }
    }

    // Explicit refuse of second-hand authority surfaces inside observation.
    const serialized = JSON.stringify(observation);
    if (serialized.includes('defaultAdminPermissions')
    || serialized.includes('tests/frontend/support/session-fixtures'))
    {
        failureReasons.push('observation must not reference test defaultAdminPermissions authority');
    }

    if (failureReasons.length > 0)
    {
        return failResult(failureReasons);
    }

    const transitions = Object.fromEntries(
        revocation.transitions.map(({ id, ...transition }) => [id, transition])
    );
    const relations = {
        ...facts['auth.relations'],
        entries: Object.fromEntries(
            facts['auth.relations'].entries.map(({ relationId, ...relation }) => [relationId, { relationId, ...relation }])
        )
    };
    const relationClaims = {
        mfaEnabledStepUpMethod: relations.entries['auth.relation.mfa-enabled-step-up-method'],
        passkeyAuthStrength: relations.entries['auth.relation.passkey-auth-strength'],
        passkeyIsNotTotp: relations.entries['auth.relation.passkey-is-not-totp'],
        recoveryAuthStrength: relations.entries['auth.relation.recovery-auth-strength'],
        recoveryDoesNotMintStepUp: relations.entries['auth.relation.recovery-does-not-mint-step-up'],
        stepUpBinding: relations.entries['auth.relation.step-up-binding'],
        stepUpConsumeOnce: relations.entries['auth.relation.step-up-consume-once'],
        refreshPreservesAuthContext: relations.entries['auth.relation.refresh-preserves-auth-context'],
        refreshDoesNotRebuildStepUp: relations.entries['auth.relation.refresh-does-not-rebuild-step-up'],
        passkeyDeleteRevokesBoundSessions: relations.entries['auth.relation.passkey-delete-revokes-bound-sessions'],
        passkeyDeleteDoesNotRevokeUnboundSessions: relations.entries['auth.relation.passkey-delete-does-not-revoke-unbound-sessions']
    };
    const observationFacts = {
        'auth.authentication-methods': facts['auth.authentication-methods'],
        'auth.authentication-strengths': facts['auth.authentication-strengths'],
        'auth.session.duration-modes': facts['auth.session.duration-modes'],
        'auth.session.idle-expiry-policy': facts['auth.session.idle-expiry-policy'],
        'auth.session.absolute-expiry-policy': facts['auth.session.absolute-expiry-policy'],
        'auth.refresh.context-preservation': facts['auth.refresh.context-preservation'],
        'auth.step-up.freshness': facts['auth.step-up.freshness'],
        'auth.step-up.binding': facts['auth.step-up.binding'],
        'auth.step-up.consume-once': facts['auth.step-up.consume-once'],
        'auth.passkey.states': facts['auth.passkey.states'],
        'auth.mfa.states': facts['auth.mfa.states'],
        'auth.recovery.states': facts['auth.recovery.states'],
        'auth.credential-session-revocation': {
            transitions,
            failureModes: revocation.failureModes
        },
        'auth.relations': relations,
        authRelationClaims: relationClaims,
        'admin.permissions.all': facts['admin.permissions.all'],
        'admin.permissions.read-only': facts['admin.permissions.read-only'],
        'admin.permissions.partial-policy': facts['admin.permissions.partial-policy'],
        'admin.disabled-access': facts['admin.disabled-access']
    };
    const observations = {
        facts: observationFacts,
        observationDigest: String(observation.observationDigest),
        artifactDigest,
        source: String(observation.source ?? 'compiled-production-constants')
    };

    if (facts.coherence != null)
    {
        observations.coherence = facts.coherence;
    }

    return {
        status: 'ok',
        failureReasons: [],
        observations
    };
}
