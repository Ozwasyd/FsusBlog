import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policyPath = path.join(repositoryRoot, 'config/testing/temporal-policy.json');
const ledgerPath = path.join(repositoryRoot, 'config/testing/temporal-callsite-dispositions.json');
function readTemporalPolicy()
{
    return JSON.parse(readFileSync(immutableRegularFile(path.relative(repositoryRoot, policyPath), 'temporal policy'), 'utf8'));
}

const policy = readTemporalPolicy();


import {
    TEMPORAL_CONTEXT_SCHEMA,
    TEMPORAL_PLAN_SCHEMA,
    TEMPORAL_ACTUAL_SCHEMA,
    TEMPORAL_RECEIPT_SCHEMA,
    sha256,
    digestCanonical,
    assertMonotonicMeasurementSource,
    createTemporalContract,
    fail,
    plainObject,
    requiredText,
    requireBusinessEpochObservation,
    validateBusinessEpochUtc
} from './temporal-context-contract.mjs';

export {
    TEMPORAL_CONTEXT_SCHEMA,
    TEMPORAL_PLAN_SCHEMA,
    TEMPORAL_ACTUAL_SCHEMA,
    TEMPORAL_RECEIPT_SCHEMA,
    TEMPORAL_LEDGER_SCHEMA,
    TemporalContractError,
    canonicalJson,
    sha256,
    digestCanonical,
    assertMonotonicMeasurementSource
} from './temporal-context-contract.mjs';

export const temporalClockKinds = Object.freeze([...policy.clockKinds]);
export const temporalAuthorityKinds = Object.freeze([...policy.authorityKinds]);
export const temporalReasonCodes = Object.freeze([...policy.reasonCodes]);

export function readTemporalReplayAuthority()
{
    return { policy: readTemporalPolicy(), ledger: readTemporalLedger() };
}

export function validateTemporalLedgerDocument(document)
{
    return createTemporalContract({ policy: readTemporalPolicy() }).validateTemporalLedgerDocument(document);
}

export function validateTemporalContext(value, options)
{
    return createTemporalContract(readTemporalReplayAuthority()).validateTemporalContext(value, options);
}

export function validateTemporalObservations(context, observations)
{
    return createTemporalContract(readTemporalReplayAuthority()).validateTemporalObservations(context, observations);
}

export function verifyTemporalReplay(binding)
{
    return createTemporalContract(readTemporalReplayAuthority()).verifyTemporalReplay(binding);
}

function immutableRegularFile(file, label)
{
    const resolved = path.resolve(repositoryRoot, file);
    if (lstatSync(resolved).isSymbolicLink())
    {
        fail('temporal.ledger-source-mismatch', `${label} must not be a symlink`);
    }
    const realRoot = realpathSync(repositoryRoot);
    const realFile = realpathSync(resolved);
    if (!realFile.startsWith(`${realRoot}${path.sep}`))
    {
        fail('temporal.ledger-source-mismatch', `${label} escapes repository`);
    }
    const stat = statSync(realFile);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        fail('temporal.ledger-source-mismatch', `${label} must be a regular file`);
    }
    return realFile;
}

export function readTemporalLedger(file = ledgerPath)
{
    const resolved = immutableRegularFile(path.relative(repositoryRoot, file), 'temporal ledger');
    const bytes = readFileSync(resolved);
    const { document, unresolved } = validateTemporalLedgerDocument(JSON.parse(bytes.toString('utf8')));
    return {
        document,
        digest: sha256(bytes),
        unresolved,
        path: path.relative(repositoryRoot, resolved).replaceAll(path.sep, '/')
    };
}

export function qualificationTemporalContext(input)
{
    const { policy: currentPolicy, ledger } = readTemporalReplayAuthority();
    return validateTemporalContext({
        schema: TEMPORAL_CONTEXT_SCHEMA,
        ...currentPolicy.qualificationDefaults,
        ...input,
        temporalPolicyDigest: digestCanonical(currentPolicy),
        ledgerSource: {
            authorityKind: 'immutable-ledger',
            path: ledger.path,
            digest: ledger.digest
        }
    });
}

export function perturbationTemporalContext(input)
{
    const { policy: currentPolicy, ledger } = readTemporalReplayAuthority();
    return validateTemporalContext({
        schema: TEMPORAL_CONTEXT_SCHEMA,
        ...currentPolicy.qualificationDefaults,
        ...input,
        temporalPolicyDigest: digestCanonical(currentPolicy),
        ledgerSource: {
            authorityKind: 'immutable-ledger',
            path: ledger.path,
            digest: ledger.digest
        }
    }, { requireQualificationDefaults: false });
}

export function loadTemporalContext(env = process.env)
{
    const inline = String(env.FSUSBLOG_TEMPORAL_CONTEXT_JSON ?? '').trim();
    const file = String(env.FSUSBLOG_TEMPORAL_CONTEXT_FILE ?? '').trim();
    if (Boolean(inline) === Boolean(file))
    {
        fail('temporal.context-missing', 'exactly one temporal context source is required');
    }
    const document = inline
        ? JSON.parse(inline)
        : JSON.parse(readFileSync(immutableRegularFile(file, 'temporal context'), 'utf8'));
    return validateTemporalContext(document);
}

export function createTemporalPlan(context)
{
    const normalized = validateTemporalContext(context);
    const plan = {
        schema: TEMPORAL_PLAN_SCHEMA,
        source: {
            commit: normalized.sourceCommit,
            fingerprint: normalized.sourceFingerprint
        },
        run: { schedulerRunId: normalized.schedulerRunId },
        producer: { producerId: normalized.producerId },
        temporalContext: normalized
    };
    return Object.freeze({ ...plan, digest: digestCanonical(plan) });
}

export function createTemporalActual(context, observations)
{
    const normalized = validateTemporalContext(context);
    const checkedObservations = validateTemporalObservations(
        normalized,
        requireBusinessEpochObservation(observations)
    );
    const actual = {
        schema: TEMPORAL_ACTUAL_SCHEMA,
        source: {
            commit: normalized.sourceCommit,
            fingerprint: normalized.sourceFingerprint
        },
        run: { schedulerRunId: normalized.schedulerRunId },
        producer: { producerId: normalized.producerId },
        temporalContext: normalized,
        observations: checkedObservations
    };
    return Object.freeze({ ...actual, digest: digestCanonical(actual) });
}

export function semanticOutcomeDigest(outcome)
{
    if (!plainObject(outcome))
    {
        return digestCanonical(outcome);
    }
    const {
        generatedAt,
        artifactMetadata,
        ...semantic
    } = outcome;
    if (generatedAt !== undefined)
    {
        validateArtifactGeneratedAt(generatedAt, 'generatedAt');
    }
    if (artifactMetadata !== undefined)
    {
        if (!plainObject(artifactMetadata))
        {
            fail(
                'temporal.context-invalid',
                'artifactMetadata must use the strict non-business metadata schema'
            );
        }
        const unknown = Object.keys(artifactMetadata)
            .filter((field) => field !== 'generatedAt')
            .sort();
        if (unknown.length > 0)
        {
            fail(
                'temporal.context-invalid',
                `artifactMetadata contains unclassified fields: ${unknown.join(', ')}`,
                { unknown }
            );
        }
        if ('generatedAt' in artifactMetadata)
        {
            validateArtifactGeneratedAt(
                artifactMetadata.generatedAt,
                'artifactMetadata.generatedAt'
            );
        }
    }
    return digestCanonical(semantic);
}

function validateArtifactGeneratedAt(value, field)
{
    const normalized = requiredText(
        value,
        field,
        'temporal.context-invalid'
    );
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u
        .test(normalized)
      || !Number.isFinite(Date.parse(normalized)))
    {
        fail(
            'temporal.context-invalid',
            `${field} must be an RFC3339 UTC artifact timestamp`
        );
    }
}

export function createTemporalReceipt({ plan, actual, outcome, generatedAt })
{
    const receipt = {
        schema: TEMPORAL_RECEIPT_SCHEMA,
        source: plan?.source,
        run: plan?.run,
        producer: plan?.producer,
        planDigest: plan?.digest,
        actualDigest: actual?.digest,
        temporalContextDigest: digestCanonical(plan?.temporalContext),
        semanticOutcomeDigest: semanticOutcomeDigest(outcome),
        artifactMetadata: {
            generatedAt: requiredText(generatedAt, 'generatedAt', 'temporal.receipt-binding-missing')
        }
    };
    return Object.freeze({ ...receipt, digest: digestCanonical(receipt) });
}

export function monotonicNow(source = policy.qualificationDefaults.monotonicClockSource)
{
    const normalized = assertMonotonicMeasurementSource(source);
    if (normalized === 'performance-now')
    {
        return performance.now();
    }
    if (normalized === 'process-hrtime-bigint')
    {
        return Number(process.hrtime.bigint()) / 1_000_000;
    }
    fail('temporal.mixed-clock', `unsupported Node monotonic source: ${normalized}`);
}

export function formatBusinessEpochUtc(ms, minimumFractionDigits = 3)
{
    if (!Number.isSafeInteger(ms))
    {
        fail('temporal.context-invalid', 'business wall clock instant is invalid');
    }
    if (!Number.isInteger(minimumFractionDigits)
        || minimumFractionDigits < 0 || minimumFractionDigits > 7)
    {
        fail('temporal.context-invalid', 'business wall clock fraction shape is invalid');
    }
    const actualInstant = new Date(ms);
    if (!Number.isFinite(actualInstant.getTime()))
    {
        fail('temporal.context-invalid', 'business wall clock instant is outside the ECMAScript range');
    }
    const instant = actualInstant.toISOString();
    if (!/^\d{4}-/u.test(instant) || instant.startsWith('0000-'))
    {
        fail('temporal.context-invalid', 'business wall clock instant is outside the backend calendar range');
    }
    const [whole, fraction] = instant.slice(0, -1).split('.');
    const significantFraction = fraction.replace(/0+$/u, '');
    const formattedFraction = significantFraction.padEnd(
        Math.max(significantFraction.length, minimumFractionDigits), '0');
    return `${whole}${formattedFraction ? `.${formattedFraction}` : ''}Z`;
}

/**
 * Injectable business wall clock. Measurement code must continue to use monotonicNow().
 */
export function createBusinessWallClock(context)
{
    const normalized = validateTemporalContext(context);
    const fractionDigits = normalized.businessEpochUtc.match(/\.(\d+)Z$/u)?.[1].length ?? 0;
    let currentMs = Date.parse(normalized.businessEpochUtc);
    if (!Number.isFinite(currentMs))
    {
        fail('temporal.context-invalid', 'businessEpochUtc is not parseable');
    }
    return Object.freeze({
        businessClockMode: normalized.businessClockMode,
        businessClockStepPolicy: normalized.businessClockStepPolicy,
        nowMs: () => currentMs,
        nowIso: () => formatBusinessEpochUtc(currentMs, fractionDigits),
        epochSeconds: () => Math.floor(currentMs / 1000),
        advanceMs(deltaMs)
        {
            if (!Number.isSafeInteger(deltaMs) || deltaMs < 0)
            {
                fail('temporal.context-invalid', 'business wall clock requires nonnegative exact millisecond steps');
            }
            if (normalized.businessClockStepPolicy === 'none' && deltaMs !== 0)
            {
                fail('temporal.context-invalid', 'business wall clock step policy forbids advancement');
            }
            if (normalized.businessClockMode === 'fixed' && deltaMs !== 0
          && normalized.businessClockStepPolicy !== 'explicit-only')
            {
                fail('temporal.context-invalid', 'fixed business clocks require explicit-only step policy');
            }
            const advancedMs = currentMs + deltaMs;
            const observed = formatBusinessEpochUtc(advancedMs, fractionDigits);
            currentMs = advancedMs;
            return observed;
        }
    });
}

export function materializeTemporalEnvironment(context)
{
    const normalized = validateTemporalContext(context);
    return Object.freeze({
        FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: normalized.businessEpochUtc,
        FSUSBLOG_TEST_BACKEND_CULTURE: normalized.backendCulture,
        FSUSBLOG_TEST_POSTGRES_TIMEZONE: normalized.postgresTimezone,
        FSUSBLOG_TEST_NODE_TIMEZONE: normalized.nodeTimezone,
        FSUSBLOG_TEST_UI_LOCALE: normalized.uiLocale,
        FSUSBLOG_TEST_LOCALE: normalized.locale,
        FSUSBLOG_TEST_TIMEZONE: normalized.timezone,
        TZ: normalized.nodeTimezone,
        FSUSBLOG_TEMPORAL_CONTEXT_JSON: JSON.stringify(normalized)
    });
}

export function playwrightTemporalContextOptions(context)
{
    const normalized = validateTemporalContext(context, { requireQualificationDefaults: false });
    return Object.freeze({
        locale: normalized.uiLocale,
        timezoneId: normalized.timezone
    });
}

export function formatTemporalLocalDate(context)
{
    const normalized = validateTemporalContext(context, { requireQualificationDefaults: false });
    const parts = new Intl.DateTimeFormat(normalized.locale, {
        calendar: normalized.calendar,
        timeZone: normalized.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date(normalized.businessEpochUtc));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

export function resolveDataScaleTierCounts(tier)
{
    switch (tier)
    {
        case 'scale-xs':
            return { articleCount: 1, commentCount: 0 };
        case 'scale-s':
            return { articleCount: 100, commentCount: 1000 };
        case 'scale-m':
            return { articleCount: 10_000, commentCount: 100_000 };
        case 'scale-l-nightly':
            return { articleCount: 100_000, commentCount: 1_000_000 };
        default:
            fail('temporal.context-invalid', `unknown data-scale tier: ${tier}`);
    }
}

function articleStatus(seed, articleCount)
{
    if (articleCount === 1)
    {
        return 2;
    }
    if (seed % 20 === 0)
    {
        return 4;
    }
    if (seed % 10 === 0)
    {
        return 3;
    }
    if (seed % 7 === 0)
    {
        return 1;
    }
    return 2;
}

/**
 * Pure projection of data-scale business timestamps from an injected epoch.
 * Matches tools/data-scale/seed.sh business wall formulas (not measurement clocks).
 */
/**
 * Pure projection of session-fixture JWT/session business timestamps from an injected epoch.
 * Matches tests/frontend/support/session-fixtures.mjs business wall formulas.
 */
export function projectSessionFixtureBusinessOutcome({
    businessEpochUtc,
    accessTokenExpiresMinutes = 15,
    rememberMe = false
} = {})
{
    const epoch = validateBusinessEpochUtc(businessEpochUtc);
    const fractionDigits = epoch.match(/\.(\d+)Z$/u)?.[1].length ?? 0;
    const epochMs = Date.parse(epoch);
    if (!Number.isFinite(epochMs))
    {
        fail('temporal.context-invalid', 'businessEpochUtc is not parseable for session-fixture projection');
    }
    const authenticatedAtEpochSeconds = Math.floor(epochMs / 1000);
    const accessTokenExpiresAtEpochSeconds = authenticatedAtEpochSeconds + (accessTokenExpiresMinutes * 60);
    const businessNow = formatBusinessEpochUtc(epochMs, fractionDigits);
    return Object.freeze({
        status: 'ok',
        strategy: 'canonical-business-epoch-projection',
        businessEpochUtc: businessNow,
        authenticatedAtEpochSeconds,
        accessTokenExpiresAtEpochSeconds,
        accessTokenExpiresMinutes,
        rememberMe,
        userSession: Object.freeze({
            idleExpiresOffsetSeconds: rememberMe ? 30 * 86_400 : 2 * 3_600,
            absoluteExpiresOffsetSeconds: 30 * 86_400
        }),
        adminSession: Object.freeze({
            idleExpiresOffsetSeconds: rememberMe ? 24 * 3_600 : 2 * 3_600,
            absoluteExpiresOffsetSeconds: rememberMe ? 30 * 86_400 : 12 * 3_600
        })
    });
}

export function projectDataScaleBusinessOutcome({
    businessEpochUtc,
    tier = 'scale-xs',
    namespace = 'local',
    articleCount,
    commentCount
} = {})
{
    const counts = articleCount == null || commentCount == null
        ? resolveDataScaleTierCounts(tier)
        : { articleCount, commentCount };
    const epoch = validateBusinessEpochUtc(businessEpochUtc);
    const fractionDigits = epoch.match(/\.(\d+)Z$/u)?.[1].length ?? 0;
    const epochMs = Date.parse(epoch);
    if (!Number.isFinite(epochMs))
    {
        fail('temporal.context-invalid', 'businessEpochUtc is not parseable for data-scale projection');
    }
    const businessNow = formatBusinessEpochUtc(epochMs, fractionDigits);
    const articles = [];
    for (let seed = 1; seed <= counts.articleCount; seed += 1)
    {
        const status = articleStatus(seed, counts.articleCount);
        articles.push({
            seed,
            status,
            createTime: formatBusinessEpochUtc(epochMs - (seed * 1000)),
            metadataUpdatedAt: businessNow,
            scheduledPublishAt: status === 1 ? formatBusinessEpochUtc(epochMs + (7 * 86_400_000)) : null,
            publishedAt: status === 2 ? formatBusinessEpochUtc(epochMs - 86_400_000) : null,
            archivedAt: status === 3 ? formatBusinessEpochUtc(epochMs - 3_600_000) : null,
            deletedAt: status === 4 ? formatBusinessEpochUtc(epochMs - 60_000) : null
        });
    }
    const comments = [];
    const rootCount = Math.floor((counts.commentCount + 1) / 2);
    const nestedCount = counts.commentCount - rootCount;
    for (let seq = 1; seq <= rootCount; seq += 1)
    {
        comments.push({
            seq,
            kind: 'root',
            createTime: formatBusinessEpochUtc(epochMs - (seq * 1000))
        });
    }
    for (let seq = 1; seq <= nestedCount; seq += 1)
    {
        const absoluteSeq = rootCount + seq;
        comments.push({
            seq: absoluteSeq,
            kind: 'nested',
            createTime: formatBusinessEpochUtc(epochMs - (absoluteSeq * 1000))
        });
    }
    const published = articles.filter((row) => row.status === 2).length;
    const scheduled = articles.filter((row) => row.status === 1).length;
    const archived = articles.filter((row) => row.status === 3).length;
    const deleted = articles.filter((row) => row.status === 4).length;
    return Object.freeze({
        status: 'ok',
        tier,
        namespace,
        strategy: 'canonical-business-epoch-projection',
        businessEpochUtc: businessNow,
        declared: Object.freeze({ articles: counts.articleCount, comments: counts.commentCount }),
        expected: Object.freeze({
            articles: counts.articleCount,
            comments: counts.commentCount,
            rootComments: rootCount,
            nestedComments: nestedCount
        }),
        observed: Object.freeze({
            articles: counts.articleCount,
            comments: counts.commentCount,
            published,
            scheduled,
            archived,
            deleted,
            rootComments: rootCount,
            nestedComments: nestedCount
        }),
        businessTimestamps: Object.freeze({
            articles,
            comments
        })
    });
}

export function observeRuntimeTemporalContext(context, overrides = {})
{
    const normalized = validateTemporalContext(context);
    return validateTemporalObservations(normalized, {
        businessEpochUtc: normalized.businessEpochUtc,
        timezone: normalized.timezone,
        locale: normalized.locale,
        uiLocale: normalized.uiLocale,
        backendCulture: normalized.backendCulture,
        postgresTimezone: normalized.postgresTimezone,
        nodeTimezone: process.env.TZ || process.env.FSUSBLOG_TEST_NODE_TIMEZONE || normalized.nodeTimezone,
        calendar: normalized.calendar,
        firstDayOfWeek: normalized.firstDayOfWeek,
        monotonicClockSource: normalized.monotonicClockSource,
        ...overrides
    });
}

export function bindProducerTemporalArtifacts({
    contextInput,
    outcome,
    observations,
    generatedAt
})
{
    const context = qualificationTemporalContext(contextInput);
    const plan = createTemporalPlan(context);
    const actual = createTemporalActual(context, observations);
    const receipt = createTemporalReceipt({
        plan,
        actual,
        outcome,
        generatedAt: requiredText(generatedAt, 'generatedAt', 'temporal.receipt-binding-missing')
    });
    const verification = verifyTemporalReplay({ plan, actual, receipt });
    return Object.freeze({ context, plan, actual, receipt, verification });
}

export function defaultTimeoutPolicyDigest()
{
    const budgetPath = path.join(repositoryRoot, 'config/testing/correctness-budget-policy.json');
    return sha256(readFileSync(budgetPath));
}
