#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { inventorySourceFiles, loadCanonicalInventory } from './test-inventory/api.mjs';
import { buildOracleFacts } from './test-quality/oracle-facts.mjs';
import { evaluateQuality, loadQualityPolicy } from './test-quality/policy.mjs';
import { parseMatrix } from './test-matrix/parse-matrix.mjs';
import {
    auditTestRecords,
    buildRetentionCatalogSnapshot,
    compactRetentionKey,
    compactRetentionBaseline,
    decodeCompactRetentionIndex,
    inferTierIdsForFile,
    normalizeReplacementManifest,
    retentionSourceState,
    reviewCandidateFiles,
    vitestHistoryEntries,
    xunitTrxHistoryEntries
} from './test-retention/audit.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const defaultOut = path.join(root, '.tmp/release-evidence/test-retention-audit.json');
const retentionClasses = new Set([
    'must-keep',
    'conditional',
    'review-candidate',
    'replaceable-candidate',
    'obsolete-candidate',
    'blocked-quality'
]);

function parseArgs(argv)
{
    const options = {
        out: defaultOut,
        runId: String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim() || null,
        captureBefore: null,
        auditInput: null
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--out')
        {
            options.out = path.resolve(root, argv[index + 1] ?? '');
            index += 1;
        }
        else if (arg === '--run-id')
        {
            const value = String(argv[index + 1] ?? '').trim();
            if (!value)
            {
                throw new Error('--run-id requires a non-empty value');
            }
            options.runId = value;
            index += 1;
        }
        else if (arg === '--capture-before')
        {
            options.captureBefore = path.resolve(root, argv[index + 1] ?? '');
            index += 1;
        }
        else if (arg === '--audit-input')
        {
            options.auditInput = path.resolve(root, argv[index + 1] ?? '');
            index += 1;
        }
        else if (arg === '--help' || arg === '-h')
        {
            console.log('Usage: node tools/check-test-retention.mjs [--out .tmp/release-evidence/test-retention-audit.json] [--run-id <production-run-id>] [--capture-before tests/test-retention-before.json] [--audit-input <existing-audit.json>]');
            process.exit(0);
        }
        else
        {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}

function toRepoPath(absolutePath)
{
    return path.relative(root, absolutePath).split(path.sep).join('/');
}

function wildcardToRegExp(pattern)
{
    const escaped = pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`);
}

function pathMatchesPattern(file, pattern)
{
    if (!pattern || pattern.startsWith('.tmp/'))
    {
        return false;
    }
    if (pattern.includes('*'))
    {
        return wildcardToRegExp(pattern).test(file);
    }
    if (file === pattern)
    {
        return true;
    }
    return pattern.endsWith('/') ? file.startsWith(pattern) : file.startsWith(`${pattern}/`);
}

function addMapSet(map, key, value)
{
    if (!key)
    {
        return;
    }
    const bucket = map.get(key) ?? new Set();
    bucket.add(value);
    map.set(key, bucket);
}

function commandReferencedFiles(command)
{
    const refs = [];
    for (const token of String(command ?? '').split(/\s+/))
    {
        const normalized = token.replace(/^['"]|['"]$/g, '').replace(/\\$/, '').replace(/^\.\//, '');
        if (!/^(tools|tests)\//.test(normalized))
        {
            continue;
        }
        if (fs.existsSync(path.join(root, normalized)) && fs.statSync(path.join(root, normalized)).isFile())
        {
            refs.push(normalized);
        }
    }
    return refs;
}

function testCaseEstimate(file, inventory)
{
    if (!/\.(cs|ts|mjs|js)$/.test(file))
    {
        return 0;
    }
    return (inventory?.testCases ?? []).filter((testCase) => testCase.ownerFile === file).length;
}

function buildTextReferenceIndex(files)
{
    const index = new Map();
    const supportTargets = files.filter((file) => (
        file.includes('/support/')
    || file.includes('/fixtures/')
    || file.includes('/Fixtures/')
    ));

    for (const source of files)
    {
        if (!/\.(cs|ts|mjs|js|sh|json|jsonc)$/.test(source))
        {
            continue;
        }
        const text = fs.readFileSync(path.join(root, source), 'utf8');
        for (const target of supportTargets)
        {
            if (source === target)
            {
                continue;
            }
            const basename = path.basename(target);
            if (!text.includes(target) && !text.includes(basename))
            {
                continue;
            }
            addMapSet(index, target, source);
        }
    }

    return index;
}

function retentionClassForTier(tier)
{
    if (retentionClasses.has(tier.retentionClass))
    {
        return tier.retentionClass;
    }
    return tier.requiredFor === 'release-final' || tier.risk === 'critical' ? 'must-keep' : 'conditional';
}

async function buildAudit({ runId = null } = {})
{
    const matrixText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const coverageRegistryText = fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8');
    const requirementCatalogText = fs.readFileSync(path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'), 'utf8');
    const coverageRetentionBaselineText = fs.readFileSync(path.join(root, 'tests/test-coverage-retention-baseline.json'), 'utf8');
    const matrix = parseMatrix(matrixText);
    const coverageRegistry = JSON.parse(coverageRegistryText);
    const requirementCatalog = JSON.parse(requirementCatalogText);
    const fileToCoverage = new Map();
    const fileToTiers = new Map();
    const fileToTierRetention = new Map();
    const fileToCommandTiers = new Map();
    // Membership authority is the canonical test inventory; retention no longer
    // owns a private file walk or discovery predicate.
    const auditedFiles = inventorySourceFiles(root).map((sourceFile) => sourceFile.path).sort();
    const fileToTextReferences = buildTextReferenceIndex(auditedFiles);

    for (const entry of coverageRegistry.entries ?? [])
    {
        for (const evidencePath of entry.evidencePaths ?? [])
        {
            if (evidencePath.startsWith('.tmp/'))
            {
                continue;
            }
            for (const file of auditedFiles)
            {
                if (!pathMatchesPattern(file, evidencePath))
                {
                    continue;
                }
                addMapSet(fileToCoverage, file, entry.id);
                for (const tierId of entry.tierIds ?? [])
                {
                    addMapSet(fileToTiers, file, tierId);
                }
            }
        }
    }

    for (const tier of matrix.tiers)
    {
        const tierRetention = retentionClassForTier(tier);
        for (const ref of commandReferencedFiles(tier.command))
        {
            addMapSet(fileToCommandTiers, ref, tier.id);
        }
        for (const evidencePath of [...(tier.evidence ?? []), ...(tier.artifacts ?? [])])
        {
            if (String(evidencePath).startsWith('.tmp/'))
            {
                continue;
            }
            for (const file of auditedFiles)
            {
                if (!pathMatchesPattern(file, evidencePath))
                {
                    continue;
                }
                addMapSet(fileToTiers, file, tier.id);
                addMapSet(fileToTierRetention, file, tierRetention);
            }
        }
    }

    const canonicalInventory = loadCanonicalInventory(root);
    const files = auditedFiles.map((file) =>
    {
        const coverageIds = [...(fileToCoverage.get(file) ?? [])].sort();
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const tierIds = [...new Set([
            ...(fileToTiers.get(file) ?? []),
            ...(fileToCommandTiers.get(file) ?? []),
            ...inferTierIdsForFile(file, source)
        ])].sort();
        const tierRetention = [...(fileToTierRetention.get(file) ?? [])].sort();
        const textReferences = [...(fileToTextReferences.get(file) ?? [])].sort();
        const reasons = [];

        if (coverageIds.length > 0)
        {
            reasons.push('coverage-registry-evidence');
        }
        if ((fileToCommandTiers.get(file)?.size ?? 0) > 0)
        {
            reasons.push('matrix-command-entrypoint');
        }
        if (textReferences.length > 0)
        {
            reasons.push('test-support-referenced');
        }
        if (tierRetention.includes('must-keep'))
        {
            reasons.push('must-keep-tier-evidence');
        }
        if (tierRetention.includes('conditional'))
        {
            reasons.push('conditional-tier-evidence');
        }
        if (/(Contract|Governance|Security|Auth|Aeds|Binary|Protocol|Policy|Release|QualityGate|Matrix|Coverage|Endpoint|Permission|Po[wW]|Passkey|Privacy|Anonymous|Concurrency|Hydration|Public|Upload|Session)/.test(file))
        {
            reasons.push('review-required-risk-name');
        }
        if (/tests\/frontend\/(e2e|checks\/(perf|resilience|security|runtime)|benchmarks)\//.test(file) || /tools\/test\/lanes\/(backend-qps|load|resilience|visual|acceptance|cross-browser|production|release)/.test(file))
        {
            reasons.push('conditional-heavy-lane-surface');
        }
        if (/obsolete/i.test(file) && coverageIds.length === 0 && tierIds.length === 0 && textReferences.length === 0)
        {
            reasons.push('name-only-obsolete-candidate');
        }

        let retentionClass = 'review-candidate';
        if (reasons.includes('name-only-obsolete-candidate'))
        {
            retentionClass = 'obsolete-candidate';
        }
        if (reasons.includes('conditional-heavy-lane-surface') || reasons.includes('conditional-tier-evidence'))
        {
            retentionClass = 'conditional';
        }
        if (coverageIds.length > 0 || reasons.includes('matrix-command-entrypoint') || reasons.includes('test-support-referenced') || reasons.includes('must-keep-tier-evidence'))
        {
            retentionClass = 'must-keep';
        }

        return {
            path: file,
            retentionClass,
            reasons: reasons.sort(),
            coverageIds,
            tierIds,
            referencedBy: textReferences,
            testCaseEstimate: testCaseEstimate(file, canonicalInventory)
        };
    });
    const fileMetadata = new Map(files.map((file) => [file.path, {
        coverageIds: file.coverageIds,
        tierIds: file.tierIds,
        retentionClass: file.retentionClass
    }]));
    const oracleFacts = buildOracleFacts(canonicalInventory, { root });
    const qualityResult = evaluateQuality({
        inventory: canonicalInventory,
        oracleFacts,
        policy: loadQualityPolicy(root)
    });
    const testRecords = await auditTestRecords({
        root,
        files: auditedFiles,
        fileMetadata,
        timingHistory: loadTimingHistory(),
        failureHistory: loadFailureHistory(),
        inventory: canonicalInventory,
        oracleFacts,
        qualityResult
    });
    const fileClassRank = new Map([
        ['blocked-quality', 0],
        ['must-keep', 1],
        ['conditional', 2],
        ['review-candidate', 3],
        ['replaceable-candidate', 4],
        ['obsolete-candidate', 5]
    ]);
    for (const file of files)
    {
        const ownedRecords = testRecords.filter((record) => record.path === file.path);
        if (ownedRecords.length === 0)
        {
            continue;
        }
        file.caseRetention = ownedRecords.map((record) => ({
            testId: record.id,
            retentionClass: record.retentionClass,
            qualityOutcome: record.qualityOutcome
        }));
        file.retentionClass = ownedRecords
            .map((record) => record.retentionClass)
            .sort((left, right) => (fileClassRank.get(left) ?? 99) - (fileClassRank.get(right) ?? 99))[0];
    }
    const counts = files.reduce((acc, file) =>
    {
        acc[file.retentionClass] = (acc[file.retentionClass] ?? 0) + 1;
        acc.testCaseEstimate += file.testCaseEstimate;
        return acc;
    }, { totalFiles: files.length, testCaseEstimate: 0 });
    const reviewCandidates = files.filter((file) => file.retentionClass === 'review-candidate').map((file) => file.path);
    const candidateReviews = reviewCandidateFiles(reviewCandidates, testRecords);
    const replaceableReviews = candidateReviews.filter((review) => review.decision === 'replaceable');
    const retentionGovernance = matrix.governance?.retention ?? {};
    const replacementManifestPath = path.join(root, retentionGovernance.replacementLedger ?? 'tests/test-retention-replacements.json');
    const replacementManifest = normalizeReplacementManifest(
    fs.existsSync(replacementManifestPath)
        ? JSON.parse(fs.readFileSync(replacementManifestPath, 'utf8'))
        : {},
    testRecords,
    {
        tierIds: matrix.tiers.map((tier) => tier.id),
        coverageIds: (coverageRegistry.entries ?? []).map((entry) => entry.id),
        tierReplacements: matrix.governance?.retiredTiers ?? [],
        historicalAssertionTargetKeys: fs.existsSync(path.join(root, 'tests/test-retention-before.json'))
            ? decodeCompactRetentionIndex(
                JSON.parse(fs.readFileSync(path.join(root, 'tests/test-retention-before.json'), 'utf8'))?.assertionIndex,
                'before snapshot assertion index'
            )
            : []
    }
    );
    const retainedCoverageIds = [...new Set(testRecords.flatMap((record) => record.coverageIds))].sort();
    const uniqueAssertionTargets = new Set(testRecords.flatMap((record) => record.assertionTargets)).size;
    const sourceState = await retentionSourceState(root);
    const generatedAt = new Date().toISOString();
    const catalogSnapshot = buildRetentionCatalogSnapshot({
        matrix,
        coverageRegistry,
        requirementCatalog,
        sourceTexts: {
            matrix: matrixText,
            coverageRegistry: coverageRegistryText,
            requirementCatalog: requirementCatalogText,
            optimizationCoverageBaseline: coverageRetentionBaselineText
        }
    });

    return {
        schema: 'fsusblog.test-retention-audit.v2',
        generatedAt,
        sourceState,
        producer: {
            runId,
            generatedAt,
            sourceState
        },
        policy: {
            automaticDeletion: false,
            deletionRule: 'Delete or merge only records marked replaceable with exact replacement test IDs, identical coverage IDs, no protected risk tags, and no unique assertion evidence.',
            ordinaryPr: 'Run must-keep and PR-default lanes; conditionally select heavy lanes by trigger metadata; record skipped lanes in PR smart gate evidence.',
            releaseFinal: 'Run the full matrix and require release-final evidence before tagging or publishing.'
        },
        counts,
        files,
        testRecords,
        reviewCandidates,
        candidateReviews,
        replaceableCandidates: replaceableReviews.map((review) => review.path),
        deletedCandidates: [],
        deletedTests: replacementManifest.deletedTests,
        assertionReplacements: replacementManifest.assertionReplacements,
        tierReplacements: replacementManifest.tierReplacements,
        obsoleteCandidates: files.filter((file) => file.retentionClass === 'obsolete-candidate').map((file) => file.path),
        retainedEvidence: {
            coverageIds: retainedCoverageIds,
            coverageIdCount: retainedCoverageIds.length,
            uniqueAssertionTargetCount: uniqueAssertionTargets,
            testRecordCount: testRecords.length,
            reviewedTestCount: candidateReviews.reduce((total, review) => total + review.tests.length, 0),
            reviewedCandidateCount: candidateReviews.length,
            unreviewedCandidateCount: candidateReviews.filter((review) => review.reviewed !== true).length
        },
        catalogSnapshot
    };
}

function currentCatalogSnapshot()
{
    const matrixText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const coverageRegistryText = fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8');
    const requirementCatalogText = fs.readFileSync(path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'), 'utf8');
    const coverageRetentionBaselineText = fs.readFileSync(path.join(root, 'tests/test-coverage-retention-baseline.json'), 'utf8');
    return buildRetentionCatalogSnapshot({
        matrix: parseMatrix(matrixText),
        coverageRegistry: JSON.parse(coverageRegistryText),
        requirementCatalog: JSON.parse(requirementCatalogText),
        sourceTexts: {
            matrix: matrixText,
            coverageRegistry: coverageRegistryText,
            requirementCatalog: requirementCatalogText,
            optimizationCoverageBaseline: coverageRetentionBaselineText
        }
    });
}

function baselineOptimizationEvidence(audit)
{
    const coveragePath = path.join(root, 'tests/test-coverage-retention-baseline.json');
    const snapshot = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    if (snapshot?.schema !== 'fsusblog.test-coverage-retention-baseline.v1')
    {
        throw new Error(`unsupported coverage retention baseline schema: ${snapshot?.schema ?? 'missing'}`);
    }
    const scopeIds = ['backend-mutation', 'release-mutation-critical-slice'];
    const testIds = (audit?.testRecords ?? [])
        .filter((record) => (record?.tierIds ?? []).some((tierId) => scopeIds.includes(tierId)))
        .map((record) => record.id)
        .filter(Boolean)
        .sort();
    return {
        coverageBaselinePath: 'tests/test-coverage-retention-baseline.json',
        coverage: snapshot.coverage,
        criticalMutationSlice: {
            evidenceMode: 'scope-identity',
            testIds: [...new Set(testIds)],
            scopeIds
        }
    };
}

function loadAuditInput(file)
{
    if (!fs.existsSync(file))
    {
        throw new Error(`audit input does not exist: ${toRepoPath(file)}`);
    }
    const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (audit?.schema !== 'fsusblog.test-retention-audit.v2')
    {
        throw new Error(`audit input must use fsusblog.test-retention-audit.v2, got ${audit?.schema ?? 'missing'}`);
    }
    const commit = String(audit?.sourceState?.commit ?? '');
    if (!/^[0-9a-f]{40}$/u.test(commit))
    {
        throw new Error('audit input source commit is missing or invalid');
    }
    for (const relative of [
        'tests/matrix.yml',
        'tests/coverage-registry.json',
        'tests/backend/Fixtures/backend-test-requirements.json',
        'tests/test-coverage-retention-baseline.json'
    ])
    {
        const baseline = spawnSync('git', ['show', `${commit}:${relative}`], {
            cwd: root,
            encoding: 'buffer',
            maxBuffer: 16 * 1024 * 1024
        });
        if (baseline.status !== 0)
        {
            throw new Error(`cannot read ${relative} from audit input commit ${commit}`);
        }
        const current = fs.readFileSync(path.join(root, relative));
        if (!baseline.stdout.equals(current))
        {
            throw new Error(`cannot augment audit input because ${relative} differs from source commit ${commit}`);
        }
    }
    return { ...audit, catalogSnapshot: audit.catalogSnapshot ?? currentCatalogSnapshot() };
}

function validateTrackedBeforeSnapshot()
{
    const relative = 'tests/test-retention-before.json';
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute))
    {
        throw new Error(`missing authoritative before snapshot: ${relative}`);
    }
    const baseline = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    compactRetentionBaseline(baseline);
    const sources = {
        matrix: 'tests/matrix.yml',
        coverageRegistry: 'tests/coverage-registry.json',
        requirementCatalog: 'tests/backend/Fixtures/backend-test-requirements.json',
        optimizationCoverageBaseline: 'tests/test-coverage-retention-baseline.json'
    };
    for (const [id, sourcePath] of Object.entries(sources))
    {
        const expected = String(baseline?.catalogSnapshot?.sourceDigests?.[id] ?? '');
        const source = spawnSync('git', ['show', `${baseline.sourceState.commit}:${sourcePath}`], {
            cwd: root,
            encoding: 'buffer',
            maxBuffer: 16 * 1024 * 1024
        });
        if (source.status !== 0)
        {
            throw new Error(`cannot resolve before snapshot source ${sourcePath}`);
        }
        const actual = `sha256:${createHash('sha256').update(source.stdout).digest('hex')}`;
        if (actual !== expected)
        {
            throw new Error(`before snapshot source digest mismatch for ${sourcePath}`);
        }
    }
    return baseline;
}

function visitJsonFiles(dir, files = [])
{
    if (!fs.existsSync(dir))
    {
        return files;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory())
        {
            visitJsonFiles(absolute, files);
        }
        else if (entry.name.endsWith('.json'))
        {
            files.push(absolute);
        }
    }
    return files;
}

function visitTrxFiles(dir, files = [])
{
    if (!fs.existsSync(dir))
    {
        return files;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory())
        {
            visitTrxFiles(absolute, files);
        }
        else if (entry.name.endsWith('.trx'))
        {
            files.push(absolute);
        }
    }
    return files;
}

function addHistory(map, key, value)
{
    if (!key)
    {
        return;
    }
    const values = map.get(key) ?? [];
    values.push(value);
    map.set(key, values);
}

function loadTimingHistory()
{
    const history = new Map();
    for (const file of visitTrxFiles(path.join(root, '.tmp/test-results/backend')))
    {
        try
        {
            for (const result of xunitTrxHistoryEntries(fs.readFileSync(file, 'utf8')))
            {
                if (Number.isFinite(result.durationMs))
                {
                    addHistory(history, result.id, result.durationMs);
                }
            }
        }
        catch
        {
            // Ignore partial TRX files left by an interrupted diagnostic run.
        }
    }
    const roots = [
        path.join(root, '.tmp/test-results/vitest'),
        path.join(root, '.tmp/test-runs')
    ];
    for (const historyRoot of roots)
    {
        for (const file of visitJsonFiles(historyRoot))
        {
            try
            {
                const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const result of vitestHistoryEntries(root, payload))
                {
                    if (Number.isFinite(result.durationMs))
                    {
                        addHistory(history, result.id, result.durationMs);
                    }
                }
                for (const result of payload.testResults ?? [])
                {
                    const key = result.testId ?? result.id ?? result.name ?? result.file ?? result.testFilePath;
                    const durationMs = Number(result.duration ?? result.durationMs);
                    if (Number.isFinite(durationMs))
                    {
                        addHistory(history, key, durationMs);
                    }
                }
                for (const [tierId, completed] of Object.entries(payload.completed ?? {}))
                {
                    const durationMs = Number(completed?.durationMs);
                    if (Number.isFinite(durationMs))
                    {
                        addHistory(history, `tier:${tierId}`, durationMs);
                    }
                }
            }
            catch
            {
                // Ignore unrelated or partial diagnostic JSON.
            }
        }
    }
    return history;
}

function loadFailureHistory()
{
    const history = new Map();
    for (const file of visitTrxFiles(path.join(root, '.tmp/test-results/backend')))
    {
        try
        {
            const observedAt = fs.statSync(file).mtime.toISOString();
            for (const result of xunitTrxHistoryEntries(fs.readFileSync(file, 'utf8')))
            {
                addHistory(history, result.id, {
                    failed: result.failed,
                    at: result.at ?? observedAt
                });
            }
        }
        catch
        {
            // Ignore partial TRX files left by an interrupted diagnostic run.
        }
    }
    const roots = [
        path.join(root, '.tmp/test-results/vitest'),
        path.join(root, '.tmp/test-runs')
    ];
    for (const historyRoot of roots)
    {
        for (const file of visitJsonFiles(historyRoot))
        {
            try
            {
                const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
                const observedAt = payload.generatedAt ?? fs.statSync(file).mtime.toISOString();
                for (const result of vitestHistoryEntries(root, payload))
                {
                    addHistory(history, result.id, {
                        failed: result.failed,
                        at: observedAt
                    });
                }
                for (const result of payload.testResults ?? [])
                {
                    const key = result.testId ?? result.id ?? result.name ?? result.file ?? result.testFilePath;
                    addHistory(history, key, {
                        failed: result.status === 'failed' || result.status === 'failure',
                        at: payload.generatedAt ?? null
                    });
                }
                if (payload.failedAt?.tierId)
                {
                    addHistory(history, `tier:${payload.failedAt.tierId}`, {
                        failed: true,
                        at: payload.failedAt.at ?? payload.updatedAt ?? null
                    });
                }
            }
            catch
            {
                // Ignore unrelated or partial diagnostic JSON.
            }
        }
    }
    return history;
}

try
{
    const options = parseArgs(process.argv.slice(2));
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const authoritativeBeforeRelative = matrix.governance?.retention?.baseline ?? 'tests/test-retention-before.json';
    const authoritativeBefore = path.join(root, authoritativeBeforeRelative);
    if (options.captureBefore && fs.existsSync(authoritativeBefore))
    {
        throw new Error(`authoritative before snapshot already exists: ${authoritativeBeforeRelative}`);
    }
    if (options.captureBefore && path.resolve(options.captureBefore) !== path.resolve(authoritativeBefore))
    {
        throw new Error(`before snapshot must be captured at ${authoritativeBeforeRelative}`);
    }
    if (options.auditInput && !options.captureBefore)
    {
        throw new Error('--audit-input is only valid with --capture-before');
    }
    const audit = options.auditInput
        ? loadAuditInput(options.auditInput)
        : await buildAudit({ runId: options.runId });
    if (!options.captureBefore)
    {
        validateTrackedBeforeSnapshot();
    }
    if (audit.counts.totalFiles === 0)
    {
        throw new Error('no test files were scanned');
    }
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(audit, null, 2)}\n`);
    if (options.captureBefore)
    {
        if (fs.existsSync(options.captureBefore))
        {
            throw new Error(`refusing to overwrite existing before snapshot: ${toRepoPath(options.captureBefore)}`);
        }
        const baseline = compactRetentionBaseline(audit, {
            optimizationEvidence: baselineOptimizationEvidence(audit)
        });
        fs.mkdirSync(path.dirname(options.captureBefore), { recursive: true });
        fs.writeFileSync(options.captureBefore, `${JSON.stringify(baseline)}\n`);
        console.log(`[test-retention] captured before snapshot ${toRepoPath(options.captureBefore)} commit=${baseline.sourceState.commit} fingerprint=${baseline.sourceState.worktreeFingerprint}`);
    }
    console.log(`[test-retention] ok files=${audit.counts.totalFiles} tests=${audit.testRecords.length} testCases=${audit.counts.testCaseEstimate} mustKeep=${audit.counts['must-keep'] ?? 0} conditional=${audit.counts.conditional ?? 0} blockedQuality=${audit.counts['blocked-quality'] ?? 0} review=${audit.counts['review-candidate'] ?? 0} replaceable=${audit.replaceableCandidates.length} obsolete=${audit.counts['obsolete-candidate'] ?? 0}`);
}
catch (error)
{
    console.error(`[test-retention] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
