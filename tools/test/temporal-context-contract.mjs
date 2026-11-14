import { createHash } from 'node:crypto';

export const TEMPORAL_CONTEXT_SCHEMA = 'fsusblog.test-temporal-context.v1';
export const TEMPORAL_PLAN_SCHEMA = 'fsusblog.test-temporal-plan.v1';
export const TEMPORAL_ACTUAL_SCHEMA = 'fsusblog.test-temporal-actual.v1';
export const TEMPORAL_RECEIPT_SCHEMA = 'fsusblog.test-temporal-receipt.v1';
export const TEMPORAL_LEDGER_SCHEMA = 'fsusblog.temporal-callsite-ledger.v1';


const contextFields = Object.freeze([
    'sourceCommit',
    'sourceFingerprint',
    'producerId',
    'schedulerRunId',
    'businessEpochUtc',
    'businessClockMode',
    'businessClockStepPolicy',
    'timezone',
    'locale',
    'uiLocale',
    'backendCulture',
    'postgresTimezone',
    'nodeTimezone',
    'calendar',
    'firstDayOfWeek',
    'monotonicClockSource',
    'timeoutPolicyDigest',
    'temporalPolicyDigest',
    'ledgerSource'
]);

const unresolvedDispositions = new Set(['unknown', 'requires-explicit']);

export class TemporalContractError extends Error
{
    constructor(reasonCode, message, details = {})
    {
        super(`${reasonCode}: ${message}`);
        this.name = 'TemporalContractError';
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

export function fail(reasonCode, message, details)
{
    throw new TemporalContractError(reasonCode, message, details);
}

export function plainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (plainObject(value))
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function sha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function digestCanonical(value)
{
    return sha256(canonicalJson(value));
}

export function requiredText(value, field, reasonCode = 'temporal.context-invalid')
{
    if (typeof value !== 'string' || !value.trim())
    {
        fail(reasonCode, `${field} is required`);
    }
    return value.trim();
}

/** Validate clock purpose without granting producer/run qualification. */
export function validateTemporalClockClassification(entry)
{
    const id = entry.callSiteId;
    const liveAdmission = entry.path === 'tools/test-fixtures/receipt/projection.mjs'
        && ['Date.now', 'new Date(value)'].includes(entry.api);
    const publication = entry.path === 'tests/browser-contract/public-shell-locale-first-response.mjs'
        && entry.api === 'new Date(value)';
    if ((liveAdmission && (entry.clockKind !== 'business-wall' || entry.authorityKind !== 'runtime-business-wall'
            || entry.ingress !== 'runtime-wall' || entry.semanticEffect !== 'included'))
        || (publication && (entry.clockKind !== 'business-wall' || entry.authorityKind !== 'observed-business-value'
            || entry.ingress !== 'observed-business' || entry.semanticEffect !== 'included'))
        || (['file-timestamp', 'performance.timeOrigin'].includes(entry.api)
            && entry.clockKind !== 'runtime-identity'))
    {
        fail('temporal.context-invalid', `${id} live admission, publication or identity cannot be artifact metadata`);
    }
    if (entry.disposition !== entry.clockKind)
    {
        fail('temporal.context-invalid', `${id} disposition differs from clock kind`);
    }
    if (entry.clockKind === 'business-wall')
    {
        const canonical = entry.authorityKind === 'canonical-business-epoch' && entry.ingress === 'canonical-injected';
        const live = entry.authorityKind === 'runtime-business-wall' && entry.ingress === 'runtime-wall'
            && ['Date.now', 'new Date(value)'].includes(entry.api);
        const observed = entry.authorityKind === 'observed-business-value' && entry.ingress === 'observed-business'
            && entry.api === 'new Date(value)';
        if ((!canonical && !live && !observed) || entry.semanticEffect !== 'included')
        {
            fail('temporal.context-invalid', `${id} business clock lacks its explicit included authority`);
        }
    }
    else if (entry.clockKind === 'monotonic-measurement')
    {
        if (entry.authorityKind !== 'runtime-monotonic' || entry.ingress !== 'runtime-monotonic'
            || entry.semanticEffect !== 'excluded'
            || ['Date.now', 'new Date()', 'new Date(value)', 'performance.timeOrigin', 'file-timestamp'].includes(entry.api))
        {
            fail('temporal.mixed-clock', `${id} measurement clock is not runtime monotonic`);
        }
    }
    else if (entry.clockKind === 'runtime-identity')
    {
        const file = entry.api === 'file-timestamp' && entry.authorityKind === 'runtime-file-identity'
            && entry.ingress === 'operability-only';
        const document = entry.api === 'performance.timeOrigin' && entry.authorityKind === 'runtime-document-identity'
            && entry.ingress === 'observed-identity';
        if ((!file && !document) || entry.semanticEffect !== 'included')
        {
            fail('temporal.context-invalid', `${id} runtime identity lacks its included observation authority`);
        }
    }
    else if (entry.clockKind !== 'artifact-metadata'
        || entry.authorityKind !== 'artifact-observation' || entry.semanticEffect !== 'excluded'
        || !['artifact-only', 'operability-only'].includes(entry.ingress))
    {
        fail('temporal.context-invalid', `${id} artifact clock classification is invalid`);
    }
    if (entry.api === 'file-timestamp' && entry.ingress !== 'operability-only')
    {
        fail('temporal.context-invalid', `${id} file timestamps cannot select correctness receipts`);
    }
}

function exactEnum(value, allowed, field)
{
    if (!allowed.includes(value))
    {
        fail('temporal.context-invalid', `${field} is not a stable enum value`, { field, value });
    }
    return value;
}

function validateDigest(value, field)
{
    const normalized = requiredText(value, field);
    if (!/^sha256:[0-9a-f]{64}$/u.test(normalized))
    {
        fail('temporal.context-invalid', `${field} must be a sha256 digest`);
    }
    return normalized;
}

/** Validate the existing RFC3339 UTC ingress without rounding millisecond precision. */
export function validateBusinessEpochUtc(value)
{
    const epoch = requiredText(value, 'businessEpochUtc');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u.test(epoch)
      || !Number.isFinite(Date.parse(epoch)))
    {
        fail('temporal.context-invalid', 'businessEpochUtc must be an RFC3339 UTC instant');
    }
    // Date.parse normalizes impossible calendar dates and 24:00 into another day.
    // A replay input must name the same instant that the backend will admit.
    if (epoch.startsWith('0000-')
        || new Date(Date.parse(epoch)).toISOString().slice(0, 19) !== epoch.slice(0, 19))
    {
        fail('temporal.context-invalid', 'businessEpochUtc must preserve its UTC calendar date and time');
    }
    const fraction = epoch.match(/\.(\d+)Z$/u)?.[1] ?? '';
    if (fraction.length > 3 && /[1-9]/u.test(fraction.slice(3)))
    {
        fail('temporal.precision-loss', 'business epoch exceeds exact millisecond precision');
    }
    return epoch;
}

function sameBinding(expected, actual, fields, reasonCode)
{
    for (const field of fields)
    {
        if (canonicalJson(expected?.[field]) !== canonicalJson(actual?.[field]))
        {
            fail(reasonCode, `${field} binding mismatch`, {
                actual: actual?.[field] ?? null,
                expected: expected?.[field] ?? null,
                field
            });
        }
    }
}

const observationBindings = Object.freeze([
    ['nodeTimezone', 'temporal.node-timezone-mismatch'],
    ['postgresTimezone', 'temporal.postgres-timezone-mismatch'],
    ['backendCulture', 'temporal.backend-culture-mismatch'],
    ['timezone', 'temporal.actual-context-mismatch'],
    ['locale', 'temporal.browser-context-mismatch'],
    ['uiLocale', 'temporal.browser-context-mismatch'],
    ['businessEpochUtc', 'temporal.actual-context-mismatch'],
    ['browserBusinessEpochUtc', 'temporal.actual-context-mismatch', 'businessEpochUtc'],
    ['calendar', 'temporal.actual-context-mismatch'],
    ['firstDayOfWeek', 'temporal.actual-context-mismatch']
]);

export function assertMonotonicMeasurementSource(source)
{
    const normalized = requiredText(source, 'monotonicClockSource', 'temporal.mixed-clock');
    if (['fixed', 'frozen', 'business-wall', 'date-now', 'dotnet-utc-now'].includes(normalized))
    {
        fail('temporal.mixed-clock', 'measurement duration must use a real monotonic source', {
            source: normalized
        });
    }
    if (!['performance-now', 'process-hrtime-bigint', 'dotnet-stopwatch'].includes(normalized))
    {
        fail('temporal.mixed-clock', `unsupported monotonic measurement source: ${normalized}`);
    }
    return normalized;
}

export function requireBusinessEpochObservation(observations)
{
    if (!plainObject(observations))
    {
        fail('temporal.actual-context-missing', 'actual temporal observations are required');
    }
    requiredText(observations.businessEpochUtc, 'businessEpochUtc', 'temporal.actual-context-missing');
    return observations;
}

// Pure verification kernel. The I/O owner supplies current, independently read authorities.
export function createTemporalContract(authority = {})
{
    const { policy, ledger } = authority ?? {};
    if (policy?.schema !== 'fsusblog.test-temporal-policy.v1')
    {
        fail('temporal.context-invalid', 'explicit temporal policy authority is required');
    }
    function validateTemporalLedgerDocument(document)
    {
        if (document.schema !== TEMPORAL_LEDGER_SCHEMA || document.authorityKind !== 'immutable-ledger'
          || !Array.isArray(document.governedSources) || !Array.isArray(document.entries))
        {
            fail('temporal.ledger-source-mismatch', 'temporal ledger header is invalid');
        }
        const ids = new Set();
        for (const entry of document.entries)
        {
            const callSiteId = requiredText(entry?.callSiteId, 'callSiteId');
            if (ids.has(callSiteId))
            {
                fail('temporal.ledger-source-mismatch', `duplicate call-site ID: ${callSiteId}`);
            }
            ids.add(callSiteId);
            requiredText(entry.path, `${callSiteId}.path`);
            requiredText(entry.symbol, `${callSiteId}.symbol`);
            requiredText(entry.sourceAnchor, `${callSiteId}.sourceAnchor`);
            requiredText(entry.api, `${callSiteId}.api`);
            exactEnum(entry.clockKind, policy.clockKinds, `${callSiteId}.clockKind`);
            exactEnum(entry.authorityKind, policy.authorityKinds, `${callSiteId}.authorityKind`);
            exactEnum(entry.disposition, policy.dispositions, `${callSiteId}.disposition`);
            if (!['included', 'excluded'].includes(entry.semanticEffect))
            {
                fail('temporal.ledger-source-mismatch', `${callSiteId}.semanticEffect is invalid`);
            }
            if (!['canonical-injected', 'runtime-monotonic', 'artifact-only', 'operability-only',
                'runtime-wall', 'observed-business', 'observed-identity'].includes(entry.ingress))
            {
                fail('temporal.ledger-source-mismatch', `${callSiteId}.ingress is invalid`);
            }
            if (!unresolvedDispositions.has(entry.disposition))
            {
                validateTemporalClockClassification(entry);
            }
        }
        const unresolved = document.entries.filter((entry) => unresolvedDispositions.has(entry.disposition));
        return { document, unresolved };
    }


    function validateTemporalContext(value, { requireQualificationDefaults = true } = {})
    {
        if (!plainObject(value))
        {
            fail('temporal.context-missing', 'temporal context is required');
        }
        if (value.schema !== TEMPORAL_CONTEXT_SCHEMA)
        {
            fail('temporal.context-invalid', 'temporal context schema is invalid');
        }
        const normalized = { schema: TEMPORAL_CONTEXT_SCHEMA };
        for (const field of contextFields)
        {
            if (!(field in value))
            {
                fail('temporal.context-invalid', `${field} is required`);
            }
            normalized[field] = value[field];
        }
        normalized.sourceCommit = requiredText(normalized.sourceCommit, 'sourceCommit');
        if (!/^[0-9a-f]{40}$/u.test(normalized.sourceCommit))
        {
            fail('temporal.context-invalid', 'sourceCommit must be a full commit');
        }
        normalized.sourceFingerprint = validateDigest(normalized.sourceFingerprint, 'sourceFingerprint');
        normalized.producerId = requiredText(normalized.producerId, 'producerId');
        if (!/^[a-z][a-z0-9-]*$/u.test(normalized.producerId))
        {
            fail('temporal.context-invalid', 'producerId is invalid');
        }
        normalized.schedulerRunId = requiredText(normalized.schedulerRunId, 'schedulerRunId');
        normalized.businessEpochUtc = validateBusinessEpochUtc(normalized.businessEpochUtc);
        exactEnum(normalized.businessClockMode, ['fixed', 'manually-advanced'], 'businessClockMode');
        exactEnum(normalized.businessClockStepPolicy, ['none', 'explicit-only'], 'businessClockStepPolicy');
        exactEnum(normalized.monotonicClockSource, policy.qualificationDefaults.monotonicClockSource === 'performance-now'
            ? ['performance-now', 'process-hrtime-bigint', 'dotnet-stopwatch']
            : policy.clockKinds, 'monotonicClockSource');
        validateDigest(normalized.timeoutPolicyDigest, 'timeoutPolicyDigest');
        validateDigest(normalized.temporalPolicyDigest, 'temporalPolicyDigest');
        for (const field of ['timezone', 'locale', 'uiLocale', 'backendCulture', 'postgresTimezone', 'nodeTimezone', 'calendar', 'firstDayOfWeek'])
        {
            normalized[field] = requiredText(normalized[field], field);
        }
        if (!plainObject(normalized.ledgerSource)
          || normalized.ledgerSource.authorityKind !== 'immutable-ledger'
          || normalized.ledgerSource.path !== 'config/testing/temporal-callsite-dispositions.json')
        {
            fail('temporal.ledger-source-mismatch', 'ledgerSource authority/path is invalid');
        }
        normalized.ledgerSource = {
            authorityKind: 'immutable-ledger',
            path: normalized.ledgerSource.path,
            digest: validateDigest(normalized.ledgerSource.digest, 'ledgerSource.digest')
        };
        if (requireQualificationDefaults)
        {
            for (const field of ['timezone', 'backendCulture', 'postgresTimezone', 'nodeTimezone', 'calendar', 'firstDayOfWeek'])
            {
                if (normalized[field] !== policy.qualificationDefaults[field])
                {
                    fail('temporal.context-invalid', `${field} does not match qualification policy`, {
                        actual: normalized[field],
                        expected: policy.qualificationDefaults[field]
                    });
                }
            }
            if (normalized.businessClockMode !== 'fixed'
            || normalized.businessClockStepPolicy !== 'explicit-only')
            {
                fail('temporal.context-invalid', 'qualification business clock must be fixed and explicitly advanced');
            }
        }
        if (!ledger || !ledger.document || typeof ledger.digest !== 'string')
        {
            fail('temporal.ledger-source-mismatch', 'explicit temporal ledger authority is required');
        }
        const { unresolved } = validateTemporalLedgerDocument(ledger.document);
        if (unresolved.length > 0)
        {
            fail('temporal.ledger-unresolved', 'temporal ledger contains unresolved call sites', {
                callSiteIds: unresolved.map((entry) => entry.callSiteId)
            });
        }
        if (normalized.ledgerSource.digest !== ledger.digest)
        {
            fail('temporal.ledger-source-mismatch', 'temporal ledger digest does not match immutable source');
        }
        const expectedPolicyDigest = digestCanonical(policy);
        if (normalized.temporalPolicyDigest !== expectedPolicyDigest)
        {
            fail('temporal.context-invalid', 'temporal policy digest mismatch');
        }
        return Object.freeze(normalized);
    }


    function validateTemporalObservations(context, observations = {})
    {
        const normalized = validateTemporalContext(context);
        if (!plainObject(observations))
        {
            fail('temporal.actual-context-missing', 'temporal observations must be an object');
        }
        if (observations.observationBoundary === 'browser-runtime')
        {
            for (const field of ['businessEpochUtc', 'browserBusinessEpochUtc', 'timezone',
                'locale', 'uiLocale', 'backendCulture', 'postgresTimezone', 'nodeTimezone'])
            {
                requiredText(observations[field], field, 'temporal.actual-context-missing');
            }
        }
        for (const [field, reasonCode, contextField = field] of observationBindings)
        {
            if (!(field in observations))
            {
                continue;
            }
            if (canonicalJson(observations[field]) !== canonicalJson(normalized[contextField]))
            {
                fail(reasonCode, `${field} observation does not match planned temporal context`, {
                    actual: observations[field],
                    expected: normalized[contextField],
                    field
                });
            }
        }
        if ('monotonicClockSource' in observations)
        {
            const observed = requiredText(observations.monotonicClockSource, 'monotonicClockSource');
            if (observed !== normalized.monotonicClockSource)
            {
                fail('temporal.mixed-clock', 'monotonicClockSource observation does not match planned temporal context', {
                    actual: observed,
                    expected: normalized.monotonicClockSource
                });
            }
            assertMonotonicMeasurementSource(observed);
        }
        return Object.freeze({ ...observations });
    }


    function verifyTemporalReplay({ plan, actual, receipt })
    {
        if (!plainObject(plan) || plan.schema !== TEMPORAL_PLAN_SCHEMA || !plan.digest)
        {
            fail('temporal.plan-binding-missing', 'run-bound temporal plan is missing');
        }
        if (!plainObject(actual) || actual.schema !== TEMPORAL_ACTUAL_SCHEMA || !actual.digest)
        {
            fail('temporal.actual-context-missing', 'temporal actual observation is missing');
        }
        if (!plainObject(receipt) || receipt.schema !== TEMPORAL_RECEIPT_SCHEMA || !receipt.digest)
        {
            fail('temporal.receipt-binding-missing', 'temporal receipt is missing');
        }
        const { digest: planDigest, ...unsignedPlan } = plan;
        const { digest: actualDigest, ...unsignedActual } = actual;
        const { digest: receiptDigest, ...unsignedReceipt } = receipt;
        if (digestCanonical(unsignedPlan) !== planDigest
          || digestCanonical(unsignedActual) !== actualDigest
          || digestCanonical(unsignedReceipt) !== receiptDigest)
        {
            fail('temporal.receipt-binding-mismatch', 'plan, actual or receipt self digest mismatch');
        }
        const normalizedPlanContext = validateTemporalContext(plan.temporalContext);
        const normalizedActualContext = validateTemporalContext(actual.temporalContext);
        for (const [artifact, context] of [[plan, normalizedPlanContext], [actual, normalizedActualContext]])
        {
            sameBinding({ commit: context.sourceCommit, fingerprint: context.sourceFingerprint },
                artifact.source, ['commit', 'fingerprint'], 'temporal.source-binding-mismatch');
            sameBinding({ schedulerRunId: context.schedulerRunId },
                artifact.run, ['schedulerRunId'], 'temporal.run-binding-mismatch');
            sameBinding({ producerId: context.producerId },
                artifact.producer, ['producerId'], 'temporal.producer-binding-mismatch');
        }
        sameBinding(plan.source, actual.source, ['commit', 'fingerprint'], 'temporal.source-binding-mismatch');
        sameBinding(plan.run, actual.run, ['schedulerRunId'], 'temporal.run-binding-mismatch');
        sameBinding(plan.producer, actual.producer, ['producerId'], 'temporal.producer-binding-mismatch');
        sameBinding(normalizedPlanContext, normalizedActualContext, contextFields, 'temporal.actual-context-mismatch');
        sameBinding(plan.source, receipt.source, ['commit', 'fingerprint'], 'temporal.source-binding-mismatch');
        sameBinding(plan.run, receipt.run, ['schedulerRunId'], 'temporal.run-binding-mismatch');
        sameBinding(plan.producer, receipt.producer, ['producerId'], 'temporal.producer-binding-mismatch');
        validateTemporalObservations(normalizedPlanContext, requireBusinessEpochObservation(actual.observations));
        assertMonotonicMeasurementSource(normalizedPlanContext.monotonicClockSource);
        if (receipt.planDigest !== plan.digest
          || receipt.actualDigest !== actual.digest
          || receipt.temporalContextDigest !== digestCanonical(normalizedPlanContext))
        {
            fail('temporal.receipt-binding-mismatch', 'receipt does not bind exact plan/actual/context');
        }
        return {
            qualificationEligible: true,
            reasonCode: 'temporal.ok',
            context: normalizedActualContext,
            receiptDigest: receipt.digest
        };
    }


    return Object.freeze({ validateTemporalLedgerDocument, validateTemporalContext, validateTemporalObservations, verifyTemporalReplay });
}

export function verifyProducerTemporalArtifacts({ producerId, binding }, authority)
{
    const replay = createTemporalContract(authority).verifyTemporalReplay(binding ?? {});
    const catalog = authority.producerBindings;
    const registered = catalog?.schema === 'fsusblog.temporal-producer-bindings.v1'
        && catalog.producerBindings?.find((row) => row.producerId === producerId);
    if (!registered || replay.context.producerId !== producerId
        || binding.plan.producer.producerId !== producerId
        || binding.bindingDigest !== digestCanonical(registered))
    {
        throw new TemporalContractError(
            'temporal.producer-binding-mismatch',
            'temporal artifacts do not bind the exact registered correctness producer'
        );
    }
    return replay;
}
