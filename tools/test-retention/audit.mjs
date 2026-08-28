import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isInventoryPath } from '../test-inventory/adapters.mjs';
import { snapshotGitWorktree } from '../test-matrix/scheduler.mjs';

function tierExecutionDependencies(tier)
{
    return tier?.executionDependsOn ?? tier?.dependsOn ?? [];
}

const safetyRiskPatterns = [
    ['security', /security|auth|permission|passkey|pow|csrf|credential|privacy|anonymous/iu],
    ['protocol', /aeds|binary|protocol|codec|contract|frame/iu],
    ['migration', /migration|schema|legacy|backup|restore/iu],
    ['concurrency', /concurr|race|atomic|idempoten|deadlock|lock/iu],
    ['release', /release|publish|artifact|evidence|supply.chain/iu],
    ['mutation', /mutation|stryker/iu],
    ['performance', /perf|benchmark|load|soak|latency|qps/iu],
    ['runtime', /runtime|integration|browser|playwright|resilience|fault/iu]
];

function shortHash(value)
{
    return createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function sha256(value)
{
    return createHash('sha256').update(String(value)).digest('hex');
}

function sortedUnique(values)
{
    return [...new Set((values ?? []).filter((value) => String(value ?? '').trim()).map(String))].sort();
}

const compactBaselineSchema = 'fsusblog.test-retention-baseline.v3';
const compactHashEncoding = 'sha256-128-base64url-fixed-22';
const compactHashWidth = 22;

export function compactRetentionKey(value)
{
    return createHash('sha256')
        .update(String(value))
        .digest()
        .subarray(0, 16)
        .toString('base64url');
}

function contentDigest(value)
{
    return `sha256:${sha256(JSON.stringify(value))}`;
}

function compactStringIndex(values, label)
{
    const normalized = sortedUnique(values);
    const keys = normalized.map(compactRetentionKey).sort();
    if (new Set(keys).size !== normalized.length)
    {
        throw new Error(`${label} contains a truncated SHA-256 collision`);
    }
    return {
        count: keys.length,
        width: compactHashWidth,
        values: keys.join(''),
        fullSetDigest: contentDigest(normalized)
    };
}

export function decodeCompactRetentionIndex(index, label = 'compact retention index')
{
    const count = Number(index?.count);
    const width = Number(index?.width);
    const values = String(index?.values ?? '');
    if (!Number.isInteger(count) || count < 0 || width !== compactHashWidth)
    {
        throw new Error(`${label} count/width is invalid`);
    }
    if (values.length !== count * width || !/^[A-Za-z0-9_-]*$/u.test(values))
    {
        throw new Error(`${label} fixed-width payload is invalid`);
    }
    const decoded = Array.from({ length: count }, (_, indexValue) => (
        values.slice(indexValue * width, (indexValue + 1) * width)
    ));
    if (new Set(decoded).size !== decoded.length
    || decoded.some((value, indexValue) => indexValue > 0 && decoded[indexValue - 1] >= value))
    {
        throw new Error(`${label} values must be unique and sorted`);
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(index?.fullSetDigest ?? '')))
    {
        throw new Error(`${label} full-set digest is invalid`);
    }
    return decoded;
}

export function isCompactRetentionBaseline(value)
{
    return value?.schema === compactBaselineSchema;
}

export function validateCompactRetentionBaseline(baseline)
{
    if (!isCompactRetentionBaseline(baseline))
    {
        throw new Error(`before snapshot requires ${compactBaselineSchema}, got ${baseline?.schema ?? 'missing'}`);
    }
    if (baseline.snapshotRole !== 'before-test-reduction')
    {
        throw new Error('before snapshot role must be before-test-reduction');
    }
    const commit = String(baseline?.sourceState?.commit ?? '');
    const worktreeFingerprint = String(baseline?.sourceState?.worktreeFingerprint ?? '');
    if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('before snapshot source state must contain a full commit and worktree fingerprint');
    }
    if (baseline.hashEncoding !== compactHashEncoding)
    {
        throw new Error(`before snapshot hash encoding must be ${compactHashEncoding}`);
    }
    const testKeys = decodeCompactRetentionIndex(baseline.testIndex, 'before snapshot test index');
    const assertionKeys = decodeCompactRetentionIndex(baseline.assertionIndex, 'before snapshot assertion index');
    const pathKeys = decodeCompactRetentionIndex(baseline.pathIndex, 'before snapshot path index');
    const owners = baseline?.assertionIndex?.owners;
    if (!Array.isArray(owners) || owners.length !== testKeys.length)
    {
        throw new Error('before snapshot assertion ownership index is incomplete');
    }
    const ownerTestIndexes = new Set();
    for (const owner of owners)
    {
        if (!Array.isArray(owner) || owner.length !== 3)
        {
            throw new Error('before snapshot assertion owner tuple is invalid');
        }
        const [testIndex, pathIndex, assertionIndexes] = owner;
        if (!Number.isInteger(testIndex) || testIndex < 0 || testIndex >= testKeys.length
      || !Number.isInteger(pathIndex) || pathIndex < 0 || pathIndex >= pathKeys.length
      || !Array.isArray(assertionIndexes)
      || assertionIndexes.some((value) => !Number.isInteger(value) || value < 0 || value >= assertionKeys.length)
      || new Set(assertionIndexes).size !== assertionIndexes.length)
        {
            throw new Error('before snapshot assertion owner tuple points outside an index');
        }
        if (ownerTestIndexes.has(testIndex))
        {
            throw new Error('before snapshot assertion ownership repeats a test index');
        }
        ownerTestIndexes.add(testIndex);
    }
    if (Number(baseline?.retainedEvidence?.testRecordCount) !== testKeys.length
    || Number(baseline?.retainedEvidence?.uniqueAssertionTargetCount) !== assertionKeys.length)
    {
        throw new Error('before snapshot retained-evidence counts do not match compact indexes');
    }
    for (const field of [
        'frameworks',
        'riskTags',
        'tierIds',
        'coverageIds'
    ])
    {
        if (!Array.isArray(baseline?.recordDimensions?.[field]))
        {
            throw new Error(`before snapshot record dimension ${field} is missing`);
        }
    }
    for (const field of [
        'matrixTierIds',
        'productionRequiredTierIds',
        'matrixArtifactPaths',
        'matrixEvidencePaths',
        'coverageIds',
        'requirementIds',
        'releaseEvidencePaths'
    ])
    {
        if (!Array.isArray(baseline?.catalogSnapshot?.[field]))
        {
            throw new Error(`before snapshot catalog is missing ${field}`);
        }
    }
    decodeCompactRetentionIndex(
        baseline?.replacementManifestBaseline?.deletedTestIndex,
        'before snapshot historical deletion index'
    );
    decodeCompactRetentionIndex(
        baseline?.replacementManifestBaseline?.assertionBeforeIndex,
        'before snapshot historical assertion index'
    );
    if (!Array.isArray(baseline?.replacementManifestBaseline?.tierFromIds))
    {
        throw new Error('before snapshot replacement manifest baseline is missing tierFromIds');
    }
    const mutation = baseline?.optimizationEvidence?.criticalMutationSlice;
    if (mutation?.evidenceMode !== 'scope-identity'
    || !Array.isArray(mutation?.scopeIds)
    || mutation.scopeIds.length === 0)
    {
        throw new Error('before snapshot critical mutation scope identity is missing');
    }
    decodeCompactRetentionIndex(mutation?.testIdIndex, 'before snapshot critical mutation test index');
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(baseline?.historySummary?.digest ?? ''))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(baseline?.contentDigest ?? '')))
    {
        throw new Error('before snapshot deterministic summary digest is missing or invalid');
    }
    const unsigned = { ...baseline };
    delete unsigned.contentDigest;
    if (contentDigest(unsigned) !== baseline.contentDigest)
    {
        throw new Error('before snapshot content digest does not match its deterministic payload');
    }
    return baseline;
}

export function buildRetentionCatalogSnapshot({
    matrix,
    coverageRegistry,
    requirementCatalog,
    sourceTexts = {}
})
{
    const tiers = matrix?.tiers ?? [];
    const tiersById = new Map(tiers.map((tier) => [tier?.id, tier]));
    const summariesByAuthority = new Map();
    for (const tier of tiers)
    {
        if (tier?.executionMode !== 'summary' || !String(tier.summaryAuthority ?? '').trim())
        {
            continue;
        }
        const siblingIds = summariesByAuthority.get(tier.summaryAuthority) ?? [];
        siblingIds.push(tier.id);
        summariesByAuthority.set(tier.summaryAuthority, siblingIds);
    }
    const productionRequiredTierIds = new Set();
    const visitProductionDependency = (tierId) =>
    {
        if (!tierId || productionRequiredTierIds.has(tierId))
        {
            return;
        }
        productionRequiredTierIds.add(tierId);
        const tier = tiersById.get(tierId);
        for (const siblingId of summariesByAuthority.get(tier?.summaryAuthority) ?? [])
        {
            visitProductionDependency(siblingId);
        }
        for (const dependencyId of [
            ...tierExecutionDependencies(tier),
            ...(tier?.requiresEvidenceFrom ?? [])
        ])
        {
            visitProductionDependency(dependencyId);
        }
    };
    visitProductionDependency('production');
    const matrixArtifactPaths = sortedUnique(tiers.flatMap((tier) => tier?.artifacts ?? []));
    const matrixEvidencePaths = sortedUnique(tiers.flatMap((tier) => tier?.evidence ?? []));
    const coverageEvidencePaths = sortedUnique((coverageRegistry?.entries ?? []).flatMap((entry) => entry?.evidencePaths ?? []));
    const releaseEvidencePaths = sortedUnique([
        ...matrixArtifactPaths,
        ...matrixEvidencePaths,
        ...coverageEvidencePaths
    ].filter((item) => /(?:^|\/)(?:release-evidence|release|jobs)(?:\/|$)|manifest/iu.test(item)));

    return {
        matrixTierIds: sortedUnique(tiers.map((tier) => tier?.id)),
        productionRequiredTierIds: sortedUnique([...productionRequiredTierIds]),
        matrixArtifactPaths,
        matrixEvidencePaths,
        coverageIds: sortedUnique((coverageRegistry?.entries ?? []).map((entry) => entry?.id)),
        requirementIds: sortedUnique((requirementCatalog?.requirements ?? []).map((entry) => entry?.id)),
        requirementProfileIds: sortedUnique((requirementCatalog?.profiles ?? []).map((entry) => entry?.id)),
        requirementEvidencePaths: sortedUnique((requirementCatalog?.requirements ?? []).flatMap((entry) => entry?.evidencePaths ?? [])),
        releaseEvidencePaths,
        sourceDigests: Object.fromEntries(Object.entries(sourceTexts)
            .map(([id, value]) => [id, `sha256:${sha256(value)}`])
            .sort(([left], [right]) => left.localeCompare(right)))
    };
}

export function compactRetentionBaseline(audit, { optimizationEvidence = audit?.optimizationEvidence } = {})
{
    if (isCompactRetentionBaseline(audit))
    {
        return validateCompactRetentionBaseline(audit);
    }
    if (audit?.schema !== 'fsusblog.test-retention-audit.v2')
    {
        throw new Error(`before snapshot requires fsusblog.test-retention-audit.v2, got ${audit?.schema ?? 'missing'}`);
    }
    const commit = String(audit?.sourceState?.commit ?? '');
    const worktreeFingerprint = String(audit?.sourceState?.worktreeFingerprint ?? '');
    if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('before snapshot source state must contain a full commit and worktree fingerprint');
    }
    if (!Array.isArray(audit?.testRecords) || audit.testRecords.length === 0)
    {
        throw new Error('before snapshot requires test records');
    }
    const requiredCatalogFields = [
        'matrixTierIds',
        'productionRequiredTierIds',
        'matrixArtifactPaths',
        'matrixEvidencePaths',
        'coverageIds',
        'requirementIds',
        'releaseEvidencePaths'
    ];
    for (const field of requiredCatalogFields)
    {
        if (!Array.isArray(audit?.catalogSnapshot?.[field]))
        {
            throw new Error(`before snapshot catalog is missing ${field}`);
        }
    }
    for (const scope of ['backend', 'frontend', 'merged'])
    {
        const summary = optimizationEvidence?.coverage?.[scope]?.summary;
        if (!Number.isFinite(Number(summary?.linecoverage)) || !Number.isFinite(Number(summary?.branchcoverage)))
        {
            throw new Error(`before snapshot optimization evidence is missing ${scope} line/branch coverage`);
        }
    }
    if (optimizationEvidence?.criticalMutationSlice?.evidenceMode !== 'scope-identity'
    || !Array.isArray(optimizationEvidence?.criticalMutationSlice?.testIds)
    || optimizationEvidence.criticalMutationSlice.testIds.length === 0
    || !Array.isArray(optimizationEvidence?.criticalMutationSlice?.scopeIds)
    || optimizationEvidence.criticalMutationSlice.scopeIds.length === 0)
    {
        throw new Error('before snapshot optimization evidence is missing the critical mutation scope identity');
    }
    const replacementManifestBaseline = audit?.replacementManifestBaseline ?? {
        deletedTestIds: sortedUnique((audit.deletedTests ?? []).map((entry) => entry?.id)),
        assertionBeforeTargets: sortedUnique((audit.assertionReplacements ?? []).map((entry) => entry?.before)),
        tierFromIds: sortedUnique((audit.tierReplacements ?? []).map((entry) => entry?.from))
    };
    for (const field of ['deletedTestIds', 'assertionBeforeTargets', 'tierFromIds'])
    {
        if (!Array.isArray(replacementManifestBaseline[field]))
        {
            throw new Error(`before snapshot replacement manifest baseline is missing ${field}`);
        }
    }

    const testIds = sortedUnique(audit.testRecords.map((record) => record?.id));
    const assertionTargets = sortedUnique(audit.testRecords.flatMap((record) => record?.assertionTargets ?? []));
    const paths = sortedUnique(audit.testRecords.map((record) => record?.path));
    const testIndex = compactStringIndex(testIds, 'before snapshot test IDs');
    const assertionIndex = compactStringIndex(assertionTargets, 'before snapshot assertion targets');
    const pathIndex = compactStringIndex(paths, 'before snapshot paths');
    const testKeyToIndex = new Map(decodeCompactRetentionIndex(testIndex).map((value, index) => [value, index]));
    const assertionKeyToIndex = new Map(decodeCompactRetentionIndex(assertionIndex).map((value, index) => [value, index]));
    const pathKeyToIndex = new Map(decodeCompactRetentionIndex(pathIndex).map((value, index) => [value, index]));
    assertionIndex.owners = audit.testRecords
        .map((record) => [
            testKeyToIndex.get(compactRetentionKey(record.id)),
            pathKeyToIndex.get(compactRetentionKey(record.path)),
            sortedUnique(record.assertionTargets)
                .map((target) => assertionKeyToIndex.get(compactRetentionKey(target)))
                .sort((left, right) => left - right)
        ])
        .sort((left, right) => left[0] - right[0]);

    const normalizedHistory = audit.testRecords
        .map((record) => [
            compactRetentionKey(record.id),
            Number(record?.tierInvocationCount ?? record?.invocationCount ?? 0),
            Number(record?.timing?.samples ?? 0),
      Number.isFinite(Number(record?.timing?.p50Ms)) ? Number(record.timing.p50Ms) : null,
      Number.isFinite(Number(record?.timing?.p95Ms)) ? Number(record.timing.p95Ms) : null,
      Number(record?.failureHistory?.runs ?? 0),
      Number(record?.failureHistory?.failures ?? 0)
        ])
        .sort((left, right) => left[0].localeCompare(right[0]));

    const compactOptimizationEvidence = {
        coverageBaseline: {
            path: String(optimizationEvidence?.coverageBaselinePath ?? 'tests/test-coverage-retention-baseline.json'),
            sourceDigest: audit?.catalogSnapshot?.sourceDigests?.optimizationCoverageBaseline ?? null,
            scopes: ['backend', 'frontend', 'merged'],
            summaryDigest: contentDigest(optimizationEvidence?.coverage ?? {})
        },
        criticalMutationSlice: {
            evidenceMode: 'scope-identity',
            testIdIndex: compactStringIndex(
                optimizationEvidence?.criticalMutationSlice?.testIds,
                'before snapshot critical mutation test IDs'
            ),
            scopeIds: sortedUnique(optimizationEvidence?.criticalMutationSlice?.scopeIds),
            identityDigest: contentDigest({
                testIds: sortedUnique(optimizationEvidence?.criticalMutationSlice?.testIds),
                scopeIds: sortedUnique(optimizationEvidence?.criticalMutationSlice?.scopeIds)
            })
        }
    };

    const baseline = {
        schema: compactBaselineSchema,
        snapshotRole: 'before-test-reduction',
        sourceState: audit.sourceState,
        hashEncoding: compactHashEncoding,
        testIndex,
        assertionIndex,
        pathIndex,
        recordDimensions: {
            frameworks: sortedUnique(audit.testRecords.map((record) => record?.framework)),
            riskTags: sortedUnique(audit.testRecords.flatMap((record) => record?.riskTags ?? [])),
            tierIds: sortedUnique(audit.testRecords.flatMap((record) => record?.tierIds ?? [])),
            coverageIds: sortedUnique(audit.testRecords.flatMap((record) => record?.coverageIds ?? []))
        },
        historySummary: {
            timingRecordCount: audit.testRecords.filter((record) => Number(record?.timing?.samples ?? 0) > 0).length,
            timingSampleCount: audit.testRecords.reduce((total, record) => total + Number(record?.timing?.samples ?? 0), 0),
            tierInvocationCount: audit.testRecords.reduce(
                (total, record) => total + Number(record?.tierInvocationCount ?? record?.invocationCount ?? 0),
                0
            ),
            failureRunCount: audit.testRecords.reduce((total, record) => total + Number(record?.failureHistory?.runs ?? 0), 0),
            failureCount: audit.testRecords.reduce((total, record) => total + Number(record?.failureHistory?.failures ?? 0), 0),
            digest: contentDigest(normalizedHistory)
        },
        retainedEvidence: {
            coverageIds: sortedUnique(audit?.retainedEvidence?.coverageIds),
            testRecordCount: testIds.length,
            uniqueAssertionTargetCount: assertionTargets.length,
            reviewedTestCount: Number(audit?.retainedEvidence?.reviewedTestCount ?? 0),
            reviewedCandidateCount: Number(audit?.retainedEvidence?.reviewedCandidateCount ?? 0),
            unreviewedCandidateCount: Number(audit?.retainedEvidence?.unreviewedCandidateCount ?? 0)
        },
        catalogSnapshot: audit.catalogSnapshot,
        replacementManifestBaseline: {
            deletedTestIndex: compactStringIndex(
                replacementManifestBaseline.deletedTestIds,
                'before snapshot historical deletion IDs'
            ),
            assertionBeforeIndex: compactStringIndex(
                replacementManifestBaseline.assertionBeforeTargets,
                'before snapshot historical assertion targets'
            ),
            tierFromIds: sortedUnique(replacementManifestBaseline.tierFromIds)
        },
        optimizationEvidence: compactOptimizationEvidence
    };
    baseline.contentDigest = contentDigest(baseline);
    return validateCompactRetentionBaseline(baseline);
}

function slug(value)
{
    return String(value)
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 56) || 'unnamed';
}

export function vitestTestId(file, name, ordinal = 1)
{
    return `vitest:${file}#${slug(name)}-${shortHash(`${name}\n${ordinal}`)}`;
}

function namedJavascriptTestId(framework, file, name, ordinal = 1)
{
    return framework === 'vitest'
        ? vitestTestId(file, name, ordinal)
        : `${framework}:${file}#${slug(name)}-${shortHash(`${name}\n${ordinal}`)}`;
}

function normalizeSemanticSource(source)
{
    return source
        .replace(/\s+/gu, ' ')
        .trim();
}

function riskTagsFor(file, name, source)
{
    const haystack = `${file}\n${name}\n${source}`;
    return safetyRiskPatterns
        .filter(([, pattern]) => pattern.test(haystack))
        .map(([tag]) => tag);
}

function record({ id, file, framework, name, source, tierCategory = undefined, methodHistoryId = null, inventoryObligation = null })
{
    const normalized = normalizeSemanticSource(source);
    const result = {
        id,
        path: file,
        framework,
        assertionTargets: [],
        riskTags: riskTagsFor(file, name, source),
        _tierCategory: tierCategory,
        _semanticSignature: shortHash(`${framework}\n${normalized}`)
    };
    if (methodHistoryId)
    {
        result.methodHistoryId = methodHistoryId;
    }
    if (inventoryObligation)
    {
        result.inventoryObligation = inventoryObligation;
    }
    return result;
}

export function vitestHistoryEntries(root, payload)
{
    const entries = [];
    for (const suite of payload?.testResults ?? [])
    {
        if (!suite?.name)
        {
            continue;
        }
        const relative = path.relative(root, suite.name).split(path.sep).join('/');
        if (relative.startsWith('../') || path.isAbsolute(relative))
        {
            continue;
        }
        const occurrenceByName = new Map();
        for (const assertion of suite.assertionResults ?? [])
        {
            const name = String(assertion?.title ?? assertion?.fullName ?? '').trim();
            if (!name)
            {
                continue;
            }
            const ordinal = (occurrenceByName.get(name) ?? 0) + 1;
            occurrenceByName.set(name, ordinal);
            const durationMs = Number(assertion?.duration);
            entries.push({
                id: vitestTestId(relative, name, ordinal),
                path: relative,
                durationMs: Number.isFinite(durationMs) ? durationMs : null,
                failed: assertion?.status === 'failed' || assertion?.status === 'failure'
            });
        }
    }
    return entries;
}

function decodeXml(value)
{
    return String(value ?? '')
        .replace(/&#x([0-9a-f]+);/giu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
        .replace(/&#([0-9]+);/gu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function xmlAttributes(source)
{
    const attributes = {};
    for (const match of String(source ?? '').matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu))
    {
        attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
    }
    return attributes;
}

function trxDurationMs(value)
{
    const match = String(value ?? '').trim().match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/u);
    if (!match)
    {
        return null;
    }
    const [, rawDays = '0', rawHours, rawMinutes, rawSeconds, rawFraction = ''] = match;
    const fractionMs = rawFraction === '' ? 0 : Number(`0.${rawFraction}`) * 1_000;
    const durationMs = (
        Number(rawDays) * 86_400_000
    + Number(rawHours) * 3_600_000
    + Number(rawMinutes) * 60_000
    + Number(rawSeconds) * 1_000
    + fractionMs
    );
    return Number.isFinite(durationMs) ? durationMs : null;
}

export function xunitMethodHistoryId(className, methodName)
{
    const nestedClass = String(className ?? '').trim().split('+').at(-1) ?? '';
    const simpleClass = nestedClass.split('.').at(-1) ?? '';
    const method = String(methodName ?? '').trim();
    return simpleClass && method ? `xunit-method:${simpleClass}.${method}` : null;
}

export function xunitTrxHistoryEntries(source)
{
    const definitions = new Map();
    for (const match of String(source ?? '').matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu))
    {
        const unit = xmlAttributes(match[1]);
        const methodMatch = match[2].match(/<TestMethod\b([^>]*)\/?\s*>/u);
        if (!unit.id || !methodMatch)
        {
            continue;
        }
        const method = xmlAttributes(methodMatch[1]);
        const id = xunitMethodHistoryId(method.className, method.name);
        if (id)
        {
            definitions.set(unit.id, id);
        }
    }

    const entries = [];
    for (const match of String(source ?? '').matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/gu))
    {
        const result = xmlAttributes(match[1]);
        const id = definitions.get(result.testId);
        const outcome = String(result.outcome ?? '').toLowerCase();
        if (!id || !['passed', 'failed', 'error', 'timeout', 'aborted'].includes(outcome))
        {
            continue;
        }
        entries.push({
            id,
            durationMs: trxDurationMs(result.duration),
            failed: outcome !== 'passed',
            at: result.endTime ?? result.startTime ?? null
        });
    }
    return entries;
}

export async function retentionSourceState(root)
{
    const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (commitResult.status !== 0)
    {
        throw new Error(`cannot resolve retention source commit: ${String(commitResult.stderr ?? '').trim() || `git exited ${commitResult.status}`}`);
    }
    const snapshot = await snapshotGitWorktree(root);
    return {
        commit: commitResult.stdout.trim(),
        worktreeFingerprint: snapshot.fingerprint
    };
}

export function extractTestRecords(file, source, inventory = null)
{
    if (file === 'tests/native/CMakeLists.txt')
    {
        return [record({
            id: 'native-cmake:aeds-crc16-target-graph',
            file,
            framework: 'native-cmake',
            name: 'AEDS CRC16 native target graph',
            source,
            inventoryObligation: 'runtime CTest listing must cross-check the static native target graph after native-smoke execution'
        })];
    }
    if (file.startsWith('tests/native/corpus/'))
    {
        return [record({
            id: `native-corpus:${file}`,
            file,
            framework: 'native-corpus',
            name: path.basename(file),
            source,
            inventoryObligation: 'corpus inputs are fuzz evidence dependencies; runtime inventory must record every consumed corpus digest'
        })];
    }
    if (file.endsWith('.cs'))
    {
        if (!inventory)
        {
            throw new Error(`xunit adapter artifact is required for C# retention records: ${file}; consume the canonical test inventory instead of private C# extraction`);
        }
        const cases = (inventory.testCases ?? []).filter((testCase) => testCase.ownerFile === file);
        if (cases.length === 0)
        {
            return [record({
                id: `xunit-support:${file}`,
                file,
                framework: 'xunit-support',
                name: path.basename(file),
                source: source.slice(0, 4000)
            })];
        }
        return cases.map((testCase) => record({
            id: testCase.id,
            file,
            framework: 'xunit',
            name: testCase.displayName,
            source: testCase.bodySource ?? source,
            tierCategory: (testCase.traits ?? []).find((trait) => trait.name === 'Category')?.value,
            methodHistoryId: xunitMethodHistoryId(testCase.ownerClass, testCase.methodName),
            inventoryObligation: testCase.identity === 'dynamic' ? testCase.dynamicCaseInfo?.inventoryObligation ?? null : null
        }));
    }
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file))
    {
        if (!inventory)
        {
            throw new Error(`js/ts adapter artifact is required for JS/TS retention records: ${file}; consume the canonical test inventory instead of private JS extraction`);
        }
        const cases = (inventory.testCases ?? []).filter((testCase) => testCase.ownerFile === file);
        const framework = file.includes('/e2e/') ? 'playwright-dynamic' : 'test-support';
        if (cases.length === 0)
        {
            return [record({
                id: `${framework}:${file}`,
                file,
                framework,
                name: path.basename(file),
                source
            })];
        }
        const records = cases.map((testCase) => record({
            id: testCase.id,
            file,
            framework: testCase.adapter ?? 'vitest',
            name: testCase.displayName,
            source: testCase.bodySource ?? source,
            tierCategory: (testCase.traits ?? []).find((trait) => trait.name === 'Category')?.value,
            inventoryObligation: testCase.identity === 'dynamic' ? testCase.dynamicCaseInfo?.inventoryObligation ?? null : null
        }));
        if (cases.every((testCase) => testCase.identity === 'dynamic'))
        {
            // Files whose cases are all dynamic keep the frozen file-level owner id
            // referenced by the retention replacement ledger; per-case dynamic
            // obligations remain on the case records above.
            records.unshift(record({
                id: `${framework}:${file}`,
                file,
                framework,
                name: path.basename(file),
                source,
                inventoryObligation: `runtime inventory must record every executed case id for ${file} after each run`
            }));
        }
        return records;
    }

    const framework = file.endsWith('.sh') ? 'shell' : file.endsWith('.mjs') || file.endsWith('.js') ? 'node-script' : 'support';
    const name = path.basename(file);
    const cases = (inventory?.testCases ?? []).filter((testCase) => testCase.ownerFile === file);
    if (cases.length > 0)
    {
        return cases.map((testCase) => record({
            id: testCase.id,
            file,
            framework: testCase.kind ?? framework,
            name: testCase.displayName,
            source: testCase.bodySource ?? source,
            tierCategory: (testCase.traits ?? []).find((trait) => trait.name === 'Category')?.value,
            inventoryObligation: testCase.identity === 'dynamic' ? testCase.dynamicCaseInfo?.inventoryObligation ?? null : null
        }));
    }
    return [record({
        id: `${framework}:${file}`,
        file,
        framework,
        name,
        source
    })];
}

export function isTestInventoryPath(file)
{
    // Delegates to the canonical inventory adapter registry; retention no longer
    // owns a private discovery predicate.
    return isInventoryPath(file);
}

export function inferTierIdsForFile(file, source = '', explicitCategory = undefined)
{
    const tiers = new Set();
    if (/^tests\/frontend\/unit\/.*\.test\.[cm]?[jt]sx?$/u.test(file))
    {
        tiers.add('frontend-unit-shard');
        tiers.add('coverage-frontend');
    }
    if (/^tests\/frontend\/(?:property|model|benchmarks)\/.*\.test\.[cm]?[jt]sx?$/u.test(file))
    {
        tiers.add('frontend-property-model-perf');
    }
    if (file === 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts')
    {
        tiers.add('ux-viewport-smoke');
        tiers.add('ux-viewport-visual');
        tiers.add('ux-viewport-boundaries');
    }
    if (/^tests\/backend\/.*\.cs$/u.test(file))
    {
        const category = explicitCategory === undefined
            ? String(source).match(/\[Trait\(\s*"Category"\s*,\s*"([^"]+)"\s*\)\]/u)?.[1] ?? null
            : explicitCategory;
        if (category === 'Integration')
        {
            tiers.add('integration');
        }
        else if (category === 'Concurrency')
        {
            tiers.add('backend-concurrency');
            tiers.add('backend-nightly');
        }
        else if (category === 'Property')
        {
            tiers.add('backend-property');
            tiers.add('backend-nightly');
        }
        else if (category === 'SecurityStateMachine')
        {
            tiers.add('backend-auth-state-machine');
            tiers.add('backend-nightly');
        }
        else if (category === 'ApiIntegration')
        {
            tiers.add('backend-api-integration');
            tiers.add('backend-nightly');
        }
        else if (category === 'GoldenContract')
        {
            tiers.add('backend-golden');
            tiers.add('backend-nightly');
        }
        else if (category === 'Performance')
        {
            tiers.add('backend-perf');
            tiers.add('backend-nightly');
        }
        else
        {
            tiers.add('backend-unit');
            tiers.add('coverage-backend');
        }
    }
    return [...tiers].sort();
}

const tierReplacementScopes = new Set(['tier', 'production-membership']);
const tierReplacementCatalogFields = new Set([
    'matrixArtifactPaths',
    'matrixEvidencePaths',
    'productionRequiredTierIds',
    'coverageIds',
    'requirementIds',
    'requirementProfileIds',
    'requirementEvidencePaths',
    'releaseEvidencePaths'
]);

export function tierReplacementStructureErrors(entry)
{
    const from = String(entry?.from ?? '').trim();
    const to = String(entry?.to ?? '').trim();
    const scope = entry?.scope === undefined ? 'tier' : String(entry.scope);
    const errors = [];
    if (!tierReplacementScopes.has(scope))
    {
        errors.push(`unsupported replacement scope: ${scope || 'missing'}`);
    }

    const rawCatalogReplacements = entry?.catalogReplacements;
    if (rawCatalogReplacements !== undefined
    && (rawCatalogReplacements === null || typeof rawCatalogReplacements !== 'object' || Array.isArray(rawCatalogReplacements)))
    {
        errors.push('catalogReplacements must be an object');
        return errors;
    }

    const catalogReplacements = rawCatalogReplacements ?? {};
    const fields = Object.keys(catalogReplacements);
    if (scope === 'production-membership' && !fields.includes('productionRequiredTierIds'))
    {
        errors.push('production-membership requires a productionRequiredTierIds mapping');
    }

    for (const [field, mappings] of Object.entries(catalogReplacements))
    {
        if (!tierReplacementCatalogFields.has(field))
        {
            errors.push(`unknown catalog replacement field: ${field}`);
            continue;
        }
        if (scope === 'production-membership' && field !== 'productionRequiredTierIds')
        {
            errors.push(`production-membership cannot authorize ${field}`);
        }
        if (!Array.isArray(mappings))
        {
            errors.push(`${field} catalog replacements must be an array`);
            continue;
        }
        if (mappings.length === 0)
        {
            errors.push(`${field} catalog replacements must not be empty`);
            continue;
        }
        if (scope === 'production-membership' && field === 'productionRequiredTierIds' && mappings.length !== 1)
        {
            errors.push('production-membership requires exactly one productionRequiredTierIds mapping');
        }

        const seenSources = new Set();
        for (const mapping of mappings)
        {
            const mappingFrom = String(mapping?.from ?? '').trim();
            const mappingTo = String(mapping?.to ?? '').trim();
            if (!mappingFrom || !mappingTo)
            {
                errors.push(`${field} catalog replacement requires non-empty from and to`);
                continue;
            }
            if (mappingFrom === mappingTo)
            {
                errors.push(`${field} catalog replacement ${mappingFrom} must change value`);
            }
            if (seenSources.has(mappingFrom))
            {
                errors.push(`${field} catalog replacement source is duplicated: ${mappingFrom}`);
            }
            seenSources.add(mappingFrom);
            if (scope === 'production-membership'
        && field === 'productionRequiredTierIds'
        && (mappingFrom !== from || mappingTo !== to))
            {
                errors.push('production-membership mapping must match the declared tier from and to');
            }
        }
    }
    return errors;
}

export function normalizeReplacementManifest(manifest, currentRecords, catalog = {})
{
    if (Object.keys(manifest ?? {}).length > 0 && manifest?.schema !== 'fsusblog.test-retention-replacements.v1')
    {
        throw new Error(`replacement manifest schema must be fsusblog.test-retention-replacements.v1, got ${manifest?.schema ?? 'missing'}`);
    }
    const currentTestIds = new Set((currentRecords ?? []).map((record) => record.id));
    const currentAssertionTargets = new Set((currentRecords ?? []).flatMap((record) => record.assertionTargets ?? []));
    const historicalAssertionTargetKeys = new Set(catalog.historicalAssertionTargetKeys ?? []);
    const deletedTests = manifest?.deletedTests ?? [];
    const assertionReplacements = manifest?.assertionReplacements ?? [];
    const tierReplacements = catalog.tierReplacements ?? manifest?.tierReplacements ?? [];
    const seenDeletedIds = new Set();
    const seenAssertionTargets = new Set();
    const deletedTestById = new Map(deletedTests.map((entry) => [entry?.id, entry]));
    const errors = [];
    const fail = (message) => errors.push(message);

    function resolvesLegacyJavascriptTestId(id)
    {
        const value = String(id);
        const match = value.match(/^(node-test|vitest|playwright):(.+)#(.+)$/u);
        if (!match || /-[0-9a-f]{10}$/u.test(value))
        {
            return false;
        }
        const canonicalPrefix = `${match[1]}:${match[2]}#${slug(match[3])}`;
        const compatiblePrefixes = new Set([canonicalPrefix]);
        if (match[1] === 'playwright')
        {
            compatiblePrefixes.add(`vitest:${match[2]}#${slug(match[3])}`);
        }
        const matches = [...currentTestIds].filter((currentId) =>
        {
            const canonical = String(currentId).match(/^((?:node-test|vitest|playwright):.+#[a-z0-9-]+)-[0-9a-f]{10}$/u);
            return canonical && compatiblePrefixes.has(canonical[1]);
        });
        return matches.length === 1;
    }

    function resolvesLegacyXunitTestId(id)
    {
        const value = String(id);
        const match = value.match(/^xunit:(.+)#([^#]+)$/u);
        if (!match)
        {
            return false;
        }
        const [, legacyFile, legacyMethod] = match;
        const methodHistoryKey = `xunit-method:${legacyMethod}`;
        return (currentRecords ?? []).some((record) => (
            record.path === legacyFile
      && record.methodHistoryId === methodHistoryKey
        ));
    }

    function resolvesToCurrentTest(id, visiting = new Set())
    {
        if (currentTestIds.has(id))
        {
            return true;
        }
        if (resolvesLegacyJavascriptTestId(id))
        {
            return true;
        }
        if (resolvesLegacyXunitTestId(id))
        {
            return true;
        }
        if (visiting.has(id))
        {
            return false;
        }
        const deleted = deletedTestById.get(id);
        if (!deleted || !Array.isArray(deleted.replacementTestIds) || deleted.replacementTestIds.length === 0)
        {
            return false;
        }
        const nextVisiting = new Set(visiting).add(id);
        return deleted.replacementTestIds.every((replacementId) => resolvesToCurrentTest(replacementId, nextVisiting));
    }

    for (const entry of deletedTests)
    {
        if (!String(entry?.id ?? '').trim())
        {
            fail('deleted test entry lacks id');
        }
        if (seenDeletedIds.has(entry.id))
        {
            fail(`duplicate deleted test id: ${entry.id}`);
        }
        seenDeletedIds.add(entry.id);
        if (!String(entry?.path ?? '').trim())
        {
            fail(`deleted test ${entry.id} lacks path`);
        }
        if (!String(entry?.reason ?? '').trim())
        {
            fail(`deleted test ${entry.id} lacks reason`);
        }
        if (!Array.isArray(entry?.replacementTestIds) || entry.replacementTestIds.length === 0)
        {
            fail(`deleted test ${entry.id} lacks replacementTestIds`);
            continue;
        }
        for (const replacementId of entry.replacementTestIds)
        {
            if (!resolvesToCurrentTest(replacementId))
            {
                fail(`deleted test ${entry.id} references missing replacement test: ${replacementId}`);
            }
        }
    }

    for (const entry of assertionReplacements)
    {
        if (!String(entry?.before ?? '').trim())
        {
            fail('assertion replacement lacks before target');
        }
        if (seenAssertionTargets.has(entry.before))
        {
            fail(`duplicate assertion replacement: ${entry.before}`);
        }
        seenAssertionTargets.add(entry.before);
        if (!String(entry?.reason ?? '').trim())
        {
            fail(`assertion replacement ${entry.before} lacks reason`);
        }
        if (!Array.isArray(entry?.replacementTestIds) || entry.replacementTestIds.length === 0)
        {
            fail(`assertion replacement ${entry.before} lacks replacementTestIds`);
        }
        else
        {
            for (const replacementId of entry.replacementTestIds)
            {
                if (!resolvesToCurrentTest(replacementId))
                {
                    fail(`assertion replacement ${entry.before} references missing replacement test: ${replacementId}`);
                }
            }
        }
        if (!Array.isArray(entry?.after) || entry.after.length === 0)
        {
            fail(`assertion replacement ${entry.before} lacks after targets`);
        }
        else
        {
            for (const target of entry.after)
            {
                if (!currentAssertionTargets.has(target)
                    && !historicalAssertionTargetKeys.has(compactRetentionKey(target)))
                {
                    fail(`assertion replacement ${entry.before} references missing replacement assertion target: ${target}`);
                }
            }
        }
    }

    const currentTierIds = new Set([
        ...(currentRecords ?? []).flatMap((record) => record.tierIds ?? []),
        ...(catalog.tierIds ?? [])
    ]);
    const currentCoverageIds = new Set([
        ...(currentRecords ?? []).flatMap((record) => record.coverageIds ?? []),
        ...(catalog.coverageIds ?? [])
    ]);
    const seenTierReplacements = new Set();
    for (const entry of tierReplacements)
    {
        if (!String(entry?.from ?? '').trim() || !String(entry?.to ?? '').trim())
        {
            fail('tier replacement requires from and to');
        }
        if (entry.from === entry.to)
        {
            fail(`tier replacement ${entry.from} must change tier id`);
        }
        if (seenTierReplacements.has(entry.from))
        {
            fail(`duplicate tier replacement: ${entry.from}`);
        }
        seenTierReplacements.add(entry.from);
        const structureErrors = tierReplacementStructureErrors(entry);
        if (structureErrors.length > 0)
        {
            fail(`tier replacement ${entry.from} is invalid: ${structureErrors.join('; ')}`);
        }
        const replacementScope = entry.scope ?? 'tier';
        if (replacementScope === 'production-membership' && !currentTierIds.has(entry.from))
        {
            fail(`production-membership replacement ${entry.from} requires the source tier to remain standalone`);
        }
        if (!currentTierIds.has(entry.to))
        {
            fail(`tier replacement ${entry.from} references missing replacement tier: ${entry.to}`);
        }
        if (!String(entry?.reason ?? '').trim())
        {
            fail(`tier replacement ${entry.from} lacks reason`);
        }
        if (!Array.isArray(entry?.coverageIds) || entry.coverageIds.length === 0)
        {
            fail(`tier replacement ${entry.from} lacks coverageIds`);
        }
        else
        {
            for (const coverageId of entry.coverageIds)
            {
                if (!currentCoverageIds.has(coverageId))
                {
                    fail(`tier replacement ${entry.from} references missing coverage id: ${coverageId}`);
                }
            }
        }
    }

    if (errors.length > 0)
    {
        throw new Error(`replacement manifest invalid (${errors.length} errors):\n${errors.map((error) => `- ${error}`).join('\n')}`);
    }

    return { deletedTests, assertionReplacements, tierReplacements };
}

export function percentile(values, requestedPercentile)
{
    const finite = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    if (finite.length === 0)
    {
        return null;
    }
    const index = Math.max(0, Math.min(finite.length - 1, Math.ceil((requestedPercentile / 100) * finite.length) - 1));
    return finite[index];
}

function historyFor(map, id, file)
{
    const xunitMethodId = String(id).startsWith('xunit:') && String(id).includes('#')
        ? `xunit-method:${String(id).slice(String(id).indexOf('#') + 1)}`
        : null;
    const direct = map.get(id) ?? (xunitMethodId ? map.get(xunitMethodId) : undefined) ?? map.get(file) ?? [];
    return Array.isArray(direct) ? direct : [];
}

function applyEquivalence(records)
{
    const retentionRank = new Map([
        ['must-keep', 0],
        ['conditional', 1],
        ['review-candidate', 2],
        ['replaceable-candidate', 3],
        ['obsolete-candidate', 4],
        ['blocked-quality', 5]
    ]);
    const groups = new Map();
    for (const item of records)
    {
        if (item.qualityOutcome === 'failed' || item.qualityOutcome === 'unresolved-failed')
        {
            item.uniqueEvidence = true;
            item.equivalentTo = null;
            continue;
        }
        const key = [
            item.framework,
            item._semanticSignature,
            item.coverageIds.join('|'),
            item.tierIds.join('|'),
            item.productionSymbols.join('|'),
            item.assertionTargets.join('|'),
            item.runtimeBoundary
        ].join('\n');
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
    }

    for (const group of groups.values())
    {
        group.sort((left, right) => (
            (retentionRank.get(left._retentionClass) ?? Number.MAX_SAFE_INTEGER)
      - (retentionRank.get(right._retentionClass) ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
        ));
        const canonical = group[0];
        canonical.uniqueEvidence = true;
        canonical.equivalentTo = null;
        for (const duplicate of group.slice(1))
        {
            duplicate.uniqueEvidence = false;
            duplicate.equivalentTo = canonical.id;
            duplicate.replacementTestIds = [canonical.id];
            duplicate.retentionClass = 'replaceable-candidate';
        }
    }
}

function factAssertionTargets(fact)
{
    return sortedUnique((fact?.assertions ?? []).map((assertion) => [
        assertion.apiId,
        assertion.actual?.text ?? '<none>',
        assertion.operator,
        assertion.expected?.text ?? '<none>'
    ].join(':')));
}

function retentionClassForCase({ metadata, fact, qualityOutcome, riskTags })
{
    if (qualityOutcome === 'failed' || qualityOutcome === 'unresolved-failed')
    {
        return { retentionClass: 'blocked-quality', retentionReasons: ['quality-outcome-blocks-retirement'] };
    }
    const reasons = [];
    if (riskTags.length > 0)
    {
        reasons.push('review-required-risk-name');
    }
    if ((metadata.coverageIds?.length ?? 0) > 0)
    {
        reasons.push('coverage-owner');
    }
    if ((metadata.tierIds?.length ?? 0) > 0)
    {
        reasons.push('matrix-runtime-owner');
    }
    const productionSymbols = (fact?.calls?.production ?? []).length;
    const assertions = (fact?.assertions ?? []).length;
    if (productionSymbols > 0)
    {
        reasons.push('production-symbol-owner');
    }
    if (assertions > 0)
    {
        reasons.push('resolved-oracle-owner');
    }
    if (productionSymbols === 0 && assertions > 0)
    {
        reasons.push('self-model-review');
    }
    if (reasons.includes('coverage-owner') || reasons.includes('matrix-runtime-owner'))
    {
        return { retentionClass: 'must-keep', retentionReasons: reasons.sort() };
    }
    if (productionSymbols > 0 && assertions > 0)
    {
        return { retentionClass: 'conditional', retentionReasons: reasons.sort() };
    }
    return { retentionClass: 'review-candidate', retentionReasons: reasons.sort() };
}

export async function auditTestRecords({
    root,
    files,
    fileMetadata,
    timingHistory,
    failureHistory,
    inventory = null,
    oracleFacts = null,
    qualityResult = null
})
{
    const records = [];
    const factsById = new Map((oracleFacts?.cases ?? []).map((item) => [item.testId, item]));
    const qualityById = new Map((qualityResult?.cases ?? []).map((item) => [item.testId, item]));
    for (const file of files)
    {
        const source = await readFile(path.join(root, file), 'utf8');
        const metadata = fileMetadata.get(file) ?? {};
        for (const extracted of extractTestRecords(file, source, inventory))
        {
            const historyId = extracted.methodHistoryId ?? extracted.id;
            const timings = historyFor(timingHistory, historyId, file);
            const failures = historyFor(failureHistory, historyId, file);
            const inferredRecordTiers = extracted.framework === 'xunit' && /^tests\/backend\/.*\.cs$/u.test(file)
                ? inferTierIdsForFile(file, '', extracted._tierCategory ?? null)
                : metadata.tierIds ?? [];
            const tierIds = [...new Set(inferredRecordTiers)].sort();
            const coverageIds = [...new Set(metadata.coverageIds ?? [])].sort();
            const fact = factsById.get(extracted.id) ?? null;
            const quality = qualityById.get(extracted.id) ?? null;
            const qualityOutcome = quality?.outcome ?? (fact === null ? 'not-applicable' : 'unresolved-failed');
            const classification = retentionClassForCase({
                metadata: { ...metadata, coverageIds, tierIds },
                fact,
                qualityOutcome,
                riskTags: extracted.riskTags ?? []
            });
            records.push({
                ...extracted,
                assertionTargets: factAssertionTargets(fact),
                productionSymbols: sortedUnique((fact?.calls?.production ?? []).map((call) => (
                    `${call.assembly ?? '<unknown>'}:${call.containingType ?? '<unknown>'}.${call.methodName}`
                ))),
                qualityOutcome,
                qualityViolations: sortedUnique((quality?.violations ?? []).map((item) => item.ruleId)),
                retentionClass: classification.retentionClass,
                retentionReasons: classification.retentionReasons,
                runtimeBoundary: `${extracted.framework}:${fact?.identity ?? 'support'}:${fact?.controlFlow?.dynamicObligation ?? 'static'}`,
                coverageIds,
                tierIds,
                invocationCount: tierIds.length,
                tierInvocationCount: tierIds.length,
                timing: {
                    samples: timings.length,
                    p50Ms: percentile(timings.map((entry) => typeof entry === 'number' ? entry : entry.durationMs), 50),
                    p95Ms: percentile(timings.map((entry) => typeof entry === 'number' ? entry : entry.durationMs), 95)
                },
                failureHistory: {
                    runs: failures.length,
                    failures: failures.filter((entry) => entry === true || entry?.failed === true).length,
                    lastFailureAt: failures.filter((entry) => entry?.failed === true && entry?.at).map((entry) => entry.at).sort().at(-1) ?? null
                },
                replacementTestIds: [],
                _retentionClass: classification.retentionClass === 'blocked-quality'
                    ? 'blocked-quality'
                    : metadata.retentionClass ?? classification.retentionClass
            });
        }
    }

    applyEquivalence(records);
    return records.map(({ _semanticSignature, _retentionClass, _tierCategory, ...item }) => item);
}

export function reviewCandidateFiles(candidateFiles, records)
{
    return candidateFiles.map((file) =>
    {
        const fileRecords = records.filter((item) => item.path === file);
        const riskTags = [...new Set(fileRecords.flatMap((item) => item.riskTags ?? []))].sort();
        const replacementTestIds = [...new Set(fileRecords.flatMap((item) => item.replacementTestIds ?? (item.equivalentTo ? [item.equivalentTo] : [])))].sort();
        const allReplaceable = fileRecords.length > 0
      && fileRecords.every((item) => item.uniqueEvidence === false && item.equivalentTo)
      && replacementTestIds.length > 0
      && riskTags.length === 0;

        const tests = fileRecords.map((item) => ({
            id: item.id,
            framework: item.framework,
            tierIds: item.tierIds ?? [],
            tierInvocationCount: Number(item.tierInvocationCount ?? item.invocationCount ?? 0),
            timing: item.timing ?? { samples: 0, p50Ms: null, p95Ms: null },
            coverageIds: item.coverageIds ?? [],
            assertionTargets: item.assertionTargets ?? [],
            failureHistory: item.failureHistory ?? { runs: 0, failures: 0, lastFailureAt: null },
            uniqueEvidence: item.uniqueEvidence !== false,
            replacementTestIds: item.replacementTestIds ?? (item.equivalentTo ? [item.equivalentTo] : [])
        }));

        return {
            path: file,
            decision: allReplaceable ? 'replaceable' : 'retain',
            reason: allReplaceable
                ? 'all tests have exact semantic, coverage, and framework replacements'
                : fileRecords.length === 0
          ? 'no auditable test record was extracted; retain fail-closed'
        : riskTags.length > 0
          ? `protected risk evidence: ${riskTags.join(', ')}`
          : `contains unique assertion or coverage evidence: ${fileRecords.filter((item) => item.uniqueEvidence !== false).map((item) => item.id).join(', ') || 'replacement set is incomplete'}`,
            testIds: fileRecords.map((item) => item.id).sort(),
            tests,
            replacementTestIds,
            riskTags,
            reviewed: true
        };
    });
}
