#!/usr/bin/env node
/**
 * BehaviorEvidencePreRuntime gate (#1753).
 *
 * Joins sealed BehaviorGraph inputs produced by static admission (#1752),
 * backend/frontend test evidence (#1748/#2186), per-behavior mutation
 * qualification (#1751/#2187), and BehaviorGraph join inputs (#1749) into a
 * verified pre-runtime receipt. The receipt proves that every pre-runtime
 * release-qualifying behavior has satisfied its required test kinds and
 * applicable mutation evidence before any runtime/browser/production/release
 * candidate may start.
 *
 * This gate consumes sealed public receipts only. It never imports extractors,
 * parsers, test runners, scanners, or business assemblies, and never re-runs
 * producers. It fails closed: identity drift, missing inputs, partial producer
 * failures, historical/latest evidence, and optional/partial gates are all
 * refused. The output receipt pins runtimeCandidateSpawnCountBeforeReceipt=0,
 * and a runtime-candidate admission guard refuses any spawn while the receipt
 * is missing, failed, or identity-mismatched.
 *
 * Output: a behavior-evidence-pre-runtime receipt with:
 *   - scope=pre-runtime
 *   - behaviorIds[]
 *   - required/observed test kinds
 *   - mutation status per behavior
 *   - static claim verification digest
 *   - missing/orphan/conflict
 *   - runtimeCandidateSpawnCountBeforeReceipt=0
 *   - status/failureReasons/contentDigest
 */


import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {
    joinBehaviorGraph,
    behaviorGraphSchema
} = await import(new URL('../contracts/behavior-graph-join.mjs', import.meta.url));

import { validateJsonSchema } from './schema-validator/validate.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const preRuntimeReceiptSchema = 'fsusblog.behavior-evidence-pre-runtime-receipt.v1';
export const staticAdmissionReceiptSchema = 'fsusblog.behavior-doc-static-admission-receipt.v1';
export const testEvidenceReceiptSchema = 'fsusblog.behavior-test-evidence-receipt.v1';
export const mutationEvidenceReceiptSchema = 'fsusblog.mutation-evidence-receipt.v1';

const canonicalCatalogPath = path.join(root, 'config/contracts/behavior-contracts.json');
const canonicalReceiptSchemaPath = path.join(
    root,
    'config/schemas/behavior-evidence-pre-runtime-receipt.schema.json'
);

const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const prefixedDigestPattern = /^sha256:[a-f0-9]{64}$/u;
const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u;

function fail(message)
{
    throw new Error(`[behavior-evidence-pre-runtime] ${message}`);
}

function stable(value)
{
    if (Array.isArray(value))
    {
        return value.map(stable);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, stable(value[key])])
        );
    }
    return value;
}

function digestValue(value)
{
    return createHash('sha256')
        .update(JSON.stringify(stable(value)), 'utf8')
        .digest('hex');
}

function normalizeDigest(value)
{
    if (typeof value !== 'string' || value.length === 0)
    {
        return null;
    }
    if (prefixedDigestPattern.test(value))
    {
        return value.slice('sha256:'.length);
    }
    if (digestPattern.test(value))
    {
        return value;
    }
    return null;
}

function normalizeFingerprint(value)
{
    return normalizeDigest(value);
}

function loadJson(input)
{
    if (typeof input === 'string')
    {
        return JSON.parse(fs.readFileSync(input, 'utf8'));
    }
    if (input && typeof input === 'object')
    {
        return structuredClone(input);
    }
    fail('input must be a path or object');
}

function requireField(value, label)
{
    if (value == null || value === '')
    {
        fail(`${label} is required`);
    }
    return value;
}

function requireDigestMatch(receipt, label, convention = 'omitted-field')
{
    const content = convention === 'null-field'
        ? { ...receipt, contentDigest: null }
        : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'));
    const expected = digestValue(content);
    const actual = normalizeDigest(receipt.contentDigest);
    if (actual !== expected)
    {
        fail(`${label} contentDigest mismatch`);
    }
}

function isPlainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requirePreRuntimeBehaviorIds(catalog)
{
    if (!isPlainObject(catalog) || !Array.isArray(catalog.contracts))
    {
        fail('catalog must declare a contracts array');
    }
    const preRuntimeIds = [];
    const invalidStageIds = [];
    for (const contract of catalog.contracts)
    {
        if (contract.status !== 'active' || contract.releaseQualification !== true)
        {
            continue;
        }
        const stage = contract.evidenceStage ?? 'pre-runtime';
        if (stage !== 'pre-runtime' && stage !== 'post-runtime')
        {
            invalidStageIds.push(`${contract.id}=${stage}`);
            continue;
        }
        if (stage === 'pre-runtime')
        {
            preRuntimeIds.push(contract.id);
        }
    }
    if (invalidStageIds.length > 0)
    {
        fail(
            'catalog declares invalid evidenceStage on active release-qualifying behavior(s): '
      + invalidStageIds.join(', ')
        );
    }
    return new Set(preRuntimeIds);
}

function requireExactKeys(value, expectedKeys, label)
{
    if (!isPlainObject(value))
    {
        fail(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (actual.join('\0') !== expected.join('\0'))
    {
        fail(`${label} must exactly cover current pre-runtime behaviorIds`);
    }
}

function requireCurrentRunIdentity(entries)
{
    const present = entries.filter((entry) => entry.value != null && entry.value !== '');
    if (present.length === 0)
    {
        return null;
    }
    for (const entry of present)
    {
        if (typeof entry.value !== 'string')
        {
            fail(`${entry.label} run identity is invalid`);
        }
    }
    const expected = present[0].value;
    const mismatched = present.filter((entry) => entry.value !== expected);
    if (mismatched.length > 0)
    {
        fail(
            `run identity mismatch: expected ${expected}; `
      + present.map((entry) => `${entry.label}=${entry.value}`).join(', ')
        );
    }
    return expected;
}

/**
 * Merge multiple sealed test-evidence receipts into one joinable receipt.
 * This is a pure join of sealed receipts; it never reads raw results, scans
 * bindings, or re-runs the #2186 producer.
 */
function mergeTestEvidenceReceipts(receipts, sourceCommit, worktreeFingerprint)
{
    if (receipts.length === 0)
    {
        fail('no test evidence receipts to join');
    }
    const fp = normalizeFingerprint(worktreeFingerprint);
    if (!fp)
    {
        fail('worktreeFingerprint invalid');
    }

    const first = receipts[0];
    const catalogDigest = normalizeDigest(first.catalogDigest);
    if (!catalogDigest)
    {
        fail('test evidence catalogDigest invalid');
    }

    const runIds = new Set();
    const rawResultDigests = [];
    const sourceClosureDigests = new Set();
    for (const [index, receipt] of receipts.entries())
    {
        if (receipt.schema !== testEvidenceReceiptSchema)
        {
            fail(`test evidence receipt ${index} has unexpected schema: ${receipt.schema}`);
        }
        requireDigestMatch(receipt, `test evidence receipt ${index}`);
        if (normalizeDigest(receipt.catalogDigest) !== catalogDigest)
        {
            fail(
                `test evidence receipt ${index} catalogDigest does not match ${catalogDigest}`
            );
        }
        if (receipt.sourceState?.commit !== sourceCommit
      || normalizeFingerprint(receipt.sourceState?.worktreeFingerprint) !== fp)
        {
            fail(
                `test evidence receipt ${index} source identity does not match this-round source`
            );
        }
        if (receipt.run?.attemptKind === 'diagnostic')
        {
            fail(`test evidence receipt ${index} run attemptKind=diagnostic cannot qualify`);
        }
        runIds.add(receipt.run?.id);
        const raw = normalizeDigest(receipt.rawResultDigest);
        if (!raw)
        {
            fail(`test evidence receipt ${index} rawResultDigest invalid`);
        }
        rawResultDigests.push(`sha256:${raw}`);
        if (receipt.sourceClosureDigest)
        {
            sourceClosureDigests.add(normalizeDigest(receipt.sourceClosureDigest));
        }
    }
    if (runIds.size !== 1)
    {
        fail(`test evidence receipts span multiple run identities: ${[...runIds].join(', ')}`);
    }

    const mergedEvidence = [];
    const mergedBindings = [];
    const mergedCoverage = [];
    const mergedErrors = [];
    const seenCanonicalIds = new Set();

    for (const receipt of receipts)
    {
        for (const row of receipt.evidence ?? [])
        {
            if (seenCanonicalIds.has(row.canonicalTestId))
            {
                continue;
            }
            seenCanonicalIds.add(row.canonicalTestId);
            mergedEvidence.push(row);
        }
        for (const binding of receipt.bindings ?? [])
        {
            if (!mergedBindings.some((entry) => entry.canonicalTestId === binding.canonicalTestId))
            {
                mergedBindings.push(binding);
            }
        }
        for (const coverage of receipt.coverage ?? [])
        {
            const existing = mergedCoverage.find((entry) => entry.behaviorId === coverage.behaviorId);
            if (!existing)
            {
                mergedCoverage.push(structuredClone(coverage));
            }
            else
            {
                for (const kind of coverage.satisfiedTestKinds ?? [])
                {
                    if (!existing.satisfiedTestKinds.includes(kind))
                    {
                        existing.satisfiedTestKinds.push(kind);
                    }
                }
                existing.missingTestKinds = (existing.requiredTestKinds ?? []).filter(
                    (kind) => !existing.satisfiedTestKinds.includes(kind)
                );
                existing.status = existing.missingTestKinds.length === 0 ? 'ok' : 'failed';
            }
        }
        mergedErrors.push(...(receipt.errors ?? []));
    }

    const merged = {
        schema: testEvidenceReceiptSchema,
        catalogDigest: first.catalogDigest,
        worktreeDigest: first.worktreeDigest,
        run: structuredClone(first.run),
        sourceState: structuredClone(first.sourceState),
        sourceClosureDigest: sourceClosureDigests.size === 1
            ? `sha256:${[...sourceClosureDigests][0]}`
            : first.sourceClosureDigest,
        rawResultDigest: `sha256:${createHash('sha256')
            .update([...new Set(rawResultDigests)].sort().join('\0'), 'utf8')
            .digest('hex')}`,
        bindings: mergedBindings,
        evidence: mergedEvidence,
        coverage: mergedCoverage,
        errors: [...new Set(mergedErrors)].sort((left, right) => left.localeCompare(right)),
        testPlanDigest: first.testPlanDigest,
        testPlanCommit: first.testPlanCommit,
        plannedTestIds: [...new Set(receipts.flatMap((receipt) => receipt.plannedTestIds ?? []))].sort(),
        unplannedBoundTestIds: [...new Set(receipts.flatMap((receipt) => receipt.unplannedBoundTestIds ?? []))].sort(),
        extraExecutedTestIds: [...new Set(receipts.flatMap((receipt) => receipt.extraExecutedTestIds ?? []))].sort(),
        runtimeCandidateSpawnCountBeforeReceipt: 0,
        producer: structuredClone(first.producer),
        contentDigest: null
    };
    merged.contentDigest = `sha256:${digestValue(
        Object.fromEntries(Object.entries(merged).filter(([key]) => key !== 'contentDigest'))
    )}`;
    return merged;
}

function resolveTestEvidenceReceipt(inputs, sourceCommit, worktreeFingerprint)
{
    const receipts = (inputs.testEvidenceReceipts ?? []).map((entry, index) =>
    {
        const receipt = loadJson(entry);
        if (receipt.schema !== testEvidenceReceiptSchema)
        {
            fail(`test evidence receipt ${index} has unexpected schema: ${receipt.schema}`);
        }
        return receipt;
    });
    if (receipts.length === 0)
    {
        fail('at least one test evidence receipt is required');
    }
    if (receipts.length === 1)
    {
        const receipt = receipts[0];
        requireDigestMatch(receipt, 'test evidence receipt');
        if (receipt.sourceState?.commit !== sourceCommit
      || normalizeFingerprint(receipt.sourceState?.worktreeFingerprint)
        !== normalizeFingerprint(worktreeFingerprint))
        {
            fail('test evidence receipt source identity does not match this-round source');
        }
        if (receipt.run?.attemptKind === 'diagnostic')
        {
            fail('test evidence receipt run attemptKind=diagnostic cannot qualify');
        }
        return { receipt, rawResultDigest: receipt.rawResultDigest };
    }
    return {
        receipt: mergeTestEvidenceReceipts(receipts, sourceCommit, worktreeFingerprint),
        rawResultDigest: null
    };
}

/**
 * Join sealed pre-runtime evidence into a verified receipt.
 *
 * @param {object} options
 * @param {object|string} options.catalog
 * @param {object|string} options.ownerReceipt
 * @param {object|string} options.staticAdmissionReceipt
 * @param {Array<object|string>} options.testEvidenceReceipts
 * @param {object|string} options.docClaimParseReceipt
 * @param {object|string} options.docClaimVerificationReceipt
 * @param {object|string} options.generatedSectionCheckReceipt
 * @param {Array<object|string>} options.factObservationReceipts
 * @param {object|string} [options.mutationEvidenceReceipt]
 * @param {string} options.sourceCommit
 * @param {string} options.worktreeFingerprint
 * @param {string} [options.runIdentity]
 */
export function joinBehaviorEvidencePreRuntime(options = {})
{
    const sourceCommit = requireField(options.sourceCommit, 'sourceCommit');
    if (!commitPattern.test(sourceCommit))
    {
        fail('sourceCommit invalid');
    }
    const fp = normalizeFingerprint(requireField(options.worktreeFingerprint, 'worktreeFingerprint'));
    if (!fp)
    {
        fail('worktreeFingerprint invalid');
    }

    // 1. Static admission receipt (#1752).
    const admission = loadJson(requireField(options.staticAdmissionReceipt, 'staticAdmissionReceipt'));
    if (admission.schema !== staticAdmissionReceiptSchema)
    {
        fail('static admission receipt schema mismatch');
    }
    requireDigestMatch(admission, 'static admission receipt', 'null-field');
    if (admission.status !== 'ok')
    {
        fail(`static admission receipt status is not ok: ${admission.status}`);
    }
    if (admission.candidateSpawnCountBeforeReceipt !== 0)
    {
        fail(
            `static admission receipt records non-zero candidate spawns before receipt: `
      + `${admission.candidateSpawnCountBeforeReceipt}`
        );
    }
    if (admission.source?.commit !== sourceCommit
    || normalizeFingerprint(admission.source?.worktreeFingerprint) !== fp)
    {
        fail('static admission receipt source identity does not match this-round source');
    }
    const admissionDigest = normalizeDigest(admission.contentDigest);
    if (!admissionDigest)
    {
        fail('static admission receipt contentDigest invalid');
    }

    // 2. Test evidence receipts (#1748/#2186).
    const { receipt: testEvidence, rawResultDigest: mergedRawDigest } = resolveTestEvidenceReceipt(
        options,
        sourceCommit,
        fp
    );
    const rawTestDigest = normalizeDigest(testEvidence.rawResultDigest ?? mergedRawDigest);
    if (!rawTestDigest)
    {
        fail('test evidence rawResultDigest invalid');
    }
    const testEvidenceDigests = (options.testEvidenceReceipts ?? []).map((entry, index) =>
    {
        const receipt = loadJson(entry);
        const digest = normalizeDigest(receipt.contentDigest)
            ?? fail(`test evidence receipt ${index} contentDigest invalid`);
        return `sha256:${digest}`;
    });

    // 3. Mutation evidence receipt (#1751/#2187).
    let mutationDigest = null;
    let mutationRawDigest = null;
    let mutationRunIdentity = null;
    if (options.mutationEvidenceReceipt != null)
    {
        const mutation = loadJson(options.mutationEvidenceReceipt);
        if (mutation.schema !== mutationEvidenceReceiptSchema)
        {
            fail('mutation evidence receipt schema mismatch');
        }
        requireDigestMatch(mutation, 'mutation evidence receipt');
        if (mutation.sourceCommit !== sourceCommit
      || normalizeFingerprint(mutation.worktreeFingerprint) !== fp)
        {
            fail('mutation evidence receipt source identity does not match this-round source');
        }
        mutationDigest = normalizeDigest(mutation.contentDigest);
        if (!mutationDigest)
        {
            fail('mutation evidence receipt contentDigest invalid');
        }
        mutationRawDigest = `${normalizeDigest(mutation.rawReportDigest)}/${normalizeDigest(mutation.rawTraceDigest)}`;
        mutationRunIdentity = mutation.runId ?? null;
    }

    // 4. BehaviorGraph join (#1749). The join validates every remaining sealed
    // receipt identity (owner, facts, doc claims, generated sections, mutation).
    const catalog = loadJson(requireField(options.catalog, 'catalog'));
    const preRuntimeBehaviorIds = requirePreRuntimeBehaviorIds(catalog);

    const graphInputs = {
        catalog,
        factExtractorRegistry: requireField(
            options.factExtractorRegistry,
            'factExtractorRegistry'
        ),
        ownerReceipt: requireField(options.ownerReceipt, 'ownerReceipt'),
        testEvidenceReceipt: testEvidence,
        docClaimParseReceipt: requireField(options.docClaimParseReceipt, 'docClaimParseReceipt'),
        docClaimVerificationReceipt: requireField(
            options.docClaimVerificationReceipt,
            'docClaimVerificationReceipt'
        ),
        generatedSectionCheckReceipt: requireField(
            options.generatedSectionCheckReceipt,
            'generatedSectionCheckReceipt'
        ),
        factObservationReceipts: options.factObservationReceipts ?? [],
        ...(mutationDigest != null
            ? { mutationEvidenceReceipt: loadJson(options.mutationEvidenceReceipt) }
            : {})
    };

    let graph;
    try
    {
        graph = joinBehaviorGraph(graphInputs);
    }
    catch (error)
    {
        fail(`BehaviorGraph join failed: ${error.message}`);
    }
    if (graph.schema !== behaviorGraphSchema)
    {
        fail('BehaviorGraph join returned unexpected schema');
    }
    const graphDigest = normalizeDigest(graph.contentDigest);
    if (!graphDigest)
    {
        fail('BehaviorGraph receipt contentDigest invalid');
    }
    const runIdentity = requireCurrentRunIdentity([
        { label: 'requested', value: options.runIdentity ?? null },
        { label: 'BehaviorGraph', value: graph.runIdentity?.id ?? null },
        { label: 'static admission', value: admission.run?.id ?? null },
        { label: 'test evidence', value: testEvidence.run?.id ?? null },
        { label: 'mutation evidence', value: mutationRunIdentity }
    ]);

    // 5. Aggregate per-behavior evidence from the joined graph.
    const requiredTestKinds = {};
    const observedTestKinds = {};
    const mutationStatus = {};
    const missing = [];
    const orphans = [];
    const conflicts = [];
    const failures = [...graph.failureReasons];

    const nodesByBehavior = new Map(
        graph.behaviorNodes.map((node) => [node.behaviorId, node])
    );
    const testEdgesByBehavior = new Map();
    for (const edge of graph.testEdges ?? [])
    {
        if (!testEdgesByBehavior.has(edge.behaviorId))
        {
            testEdgesByBehavior.set(edge.behaviorId, []);
        }
        testEdgesByBehavior.get(edge.behaviorId).push(edge);
    }

    for (const contract of catalog.contracts)
    {
        const behaviorId = contract.id;
        if (!preRuntimeBehaviorIds.has(behaviorId))
        {
            continue;
        }
        requiredTestKinds[behaviorId] = [...(contract.requiredTestKinds ?? [])];
        observedTestKinds[behaviorId] = [...new Set(
            (testEdgesByBehavior.get(behaviorId) ?? [])
                .filter((edge) => edge.status === 'ok')
                .map((edge) => edge.testKind)
        )].sort();

        const node = nodesByBehavior.get(behaviorId);
        if (!node)
        {
            missing.push({ kind: 'missing-behavior', behaviorId, anchor: `behavior:${behaviorId}`, reason: `${behaviorId} missing from BehaviorGraph` });
            failures.push(`${behaviorId} is pre-runtime release-qualifying but missing from BehaviorGraph`);
            mutationStatus[behaviorId] = { behaviorId, mutationRequired: contract.mutationPolicy?.mutationRequired === true, mutationStatus: 'missing', qualified: false, failures: ['missing behavior node'] };
            continue;
        }
        if (node.qualification !== 'qualified')
        {
            failures.push(
                `${behaviorId} pre-runtime behavior qualification failed: `
        + (node.failureReasons?.join('; ') ?? 'unknown')
            );
        }

        const required = contract.mutationPolicy?.mutationRequired === true;
        const status = node.mutationStatus ?? 'missing';
        const qualified = required ? status === 'ok' : status !== 'failed';
        mutationStatus[behaviorId] = {
            behaviorId,
            mutationRequired: required,
            mutationStatus: status,
            qualified,
            failures: required && status !== 'ok'
                ? [(`${behaviorId} mutation evidence is not qualified: ${status}`)]
                : []
        };
        if (required && status !== 'ok')
        {
            failures.push(
                `${behaviorId} per-behavior mutation evidence failed (global score cannot mask this): ${status}`
            );
        }
    }

    // 6. Scope missing/orphan/conflict anchors to the pre-runtime set plus
    // cross-cutting identity/input failures.
    const scoped = (entries) => entries.filter((entry) =>
        entry.behaviorId == null
    || preRuntimeBehaviorIds.has(entry.behaviorId)
    || entry.kind === 'identity-mismatch'
    || entry.kind === 'input-failed'
    );
    missing.push(...scoped(graph.missing ?? []));
    orphans.push(...scoped(graph.orphans ?? []));
    conflicts.push(...scoped(graph.conflicts ?? []));

    // 7. Per-behavior mutation failure must not be masked by any global score.
    const behaviorIds = [...preRuntimeBehaviorIds].sort();
    const uniqueFailures = [...new Set(failures)].sort((left, right) => left.localeCompare(right));
    const status = uniqueFailures.length === 0 ? 'ok' : 'failed';

    const receipt = {
        schema: preRuntimeReceiptSchema,
        scope: 'pre-runtime',
        runIdentity,
        sourceIdentity: {
            commit: sourceCommit,
            worktreeFingerprint: `sha256:${fp}`
        },
        buildIdentities: graph.buildIdentities ?? {},
        catalogDigest: `sha256:${normalizeDigest(graph.catalogDigest)}`,
        registryDigest: `sha256:${normalizeDigest(graph.registryDigest)}`,
        staticAdmissionDigest: `sha256:${admissionDigest}`,
        behaviorGraphDigest: `sha256:${graphDigest}`,
        testEvidenceDigests: [...new Set(testEvidenceDigests)].sort(),
        rawResultDigests: {
            testEvidence: `sha256:${rawTestDigest}`,
            ...(mutationRawDigest != null ? { mutation: mutationRawDigest } : {})
        },
        mutationEvidenceDigest: mutationDigest != null ? `sha256:${mutationDigest}` : null,
        behaviorIds,
        requiredTestKinds,
        observedTestKinds,
        mutationStatus,
        staticClaimVerificationDigest: graph.inputDigests?.docClaimVerificationReceipt ?? null,
        missing: [...missing].sort((left, right) =>
            `${left.kind}\0${left.behaviorId ?? ''}\0${left.anchor}`.localeCompare(
                `${right.kind}\0${right.behaviorId ?? ''}\0${right.anchor}`
            )
        ),
        orphans: [...orphans].sort((left, right) =>
            `${left.kind}\0${left.behaviorId ?? ''}\0${left.anchor}`.localeCompare(
                `${right.kind}\0${right.behaviorId ?? ''}\0${right.anchor}`
            )
        ),
        conflicts: [...conflicts].sort((left, right) =>
            `${left.kind}\0${left.behaviorId ?? ''}\0${left.anchor}`.localeCompare(
                `${right.kind}\0${right.behaviorId ?? ''}\0${right.anchor}`
            )
        ),
        runtimeCandidateSpawnCountBeforeReceipt: 0,
        status,
        failureReasons: uniqueFailures,
        contentDigest: null
    };
    receipt.contentDigest = `sha256:${digestValue(
        Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    )}`;
    validatePreRuntimeReceipt(receipt, {
        behaviorCatalog: catalog,
        factExtractorRegistry: options.factExtractorRegistry
    });
    return receipt;
}

/**
 * Validate a sealed pre-runtime receipt.
 */
export function validatePreRuntimeReceipt(receipt, options = {})
{
    if (!isPlainObject(receipt))
    {
        fail('receipt must be an object');
    }
    const receiptSchema = loadJson(canonicalReceiptSchemaPath);
    const schemaErrors = validateJsonSchema(receipt, receiptSchema);
    if (schemaErrors.length > 0)
    {
        fail(`receipt schema validation failed: ${schemaErrors.join('; ')}`);
    }
    if (receipt.schema !== preRuntimeReceiptSchema)
    {
        fail(`unexpected schema: ${receipt.schema}`);
    }
    if (receipt.scope !== 'pre-runtime')
    {
        fail('scope must be pre-runtime');
    }
    if (receipt.runtimeCandidateSpawnCountBeforeReceipt !== 0)
    {
        fail('runtimeCandidateSpawnCountBeforeReceipt must be 0');
    }
    const expectedDigest = digestValue(
        Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    );
    const actual = normalizeDigest(receipt.contentDigest);
    if (actual !== expectedDigest
    && receipt.contentDigest !== expectedDigest
    && receipt.contentDigest !== `sha256:${expectedDigest}`)
    {
        fail('contentDigest mismatch');
    }
    if (receipt.status !== 'ok' && receipt.status !== 'failed')
    {
        fail('status must be ok or failed');
    }
    if (receipt.status === 'ok' && receipt.failureReasons.length !== 0)
    {
        fail('status=ok cannot include failureReasons');
    }
    if (receipt.status === 'failed' && receipt.failureReasons.length === 0)
    {
        fail('status=failed requires failureReasons');
    }
    if (!Array.isArray(receipt.behaviorIds))
    {
        fail('behaviorIds must be an array');
    }
    if (!isPlainObject(receipt.buildIdentities))
    {
        fail('buildIdentities must be an object');
    }
    for (const [extractorId, identity] of Object.entries(receipt.buildIdentities))
    {
        if (!behaviorIdPattern.test(extractorId)
      || !isPlainObject(identity)
      || Object.keys(identity).sort().join('\0') !== ['artifactDigest', 'artifactId', 'receiptDigest'].join('\0')
      || typeof identity.artifactId !== 'string'
      || identity.artifactId.length === 0
      || !digestPattern.test(String(identity.receiptDigest ?? ''))
      || !digestPattern.test(String(identity.artifactDigest ?? '')))
        {
            fail(`buildIdentities.${extractorId} is invalid`);
        }
    }
    if (!prefixedDigestPattern.test(String(receipt.registryDigest ?? '')))
    {
        fail('registryDigest must be a prefixed sha256 digest');
    }

    if (options.behaviorCatalog != null)
    {
        const catalog = loadJson(options.behaviorCatalog);
        const expectedIds = [...requirePreRuntimeBehaviorIds(catalog)].sort();
        const actualIds = [...receipt.behaviorIds].sort();
        if (actualIds.join('\0') !== expectedIds.join('\0'))
        {
            fail('behaviorIds do not exactly match current pre-runtime catalog authority');
        }
        requireExactKeys(receipt.requiredTestKinds, expectedIds, 'requiredTestKinds');
        requireExactKeys(receipt.observedTestKinds, expectedIds, 'observedTestKinds');
        requireExactKeys(receipt.mutationStatus, expectedIds, 'mutationStatus');
        for (const behaviorId of expectedIds)
        {
            const contract = catalog.contracts.find((entry) => entry.id === behaviorId);
            const requiredKinds = [...(contract.requiredTestKinds ?? [])].sort();
            if ([...receipt.requiredTestKinds[behaviorId]].sort().join('\0') !== requiredKinds.join('\0'))
            {
                fail(`${behaviorId} requiredTestKinds differs from current catalog authority`);
            }
            const mutation = receipt.mutationStatus[behaviorId];
            const mutationRequired = contract.mutationPolicy?.mutationRequired === true;
            if (mutation.behaviorId !== behaviorId || mutation.mutationRequired !== mutationRequired)
            {
                fail(`${behaviorId} mutation policy differs from current catalog authority`);
            }
            if (receipt.status === 'ok'
                && (requiredKinds.some((kind) => !receipt.observedTestKinds[behaviorId].includes(kind))
                    || mutation.qualified !== true || mutation.failures.length > 0
                    || (mutationRequired && mutation.mutationStatus !== 'ok')
                    || mutation.mutationStatus === 'failed'))
            {
                fail(`${behaviorId} status=ok requires qualified test and mutation evidence`);
            }
        }
        if (receipt.status === 'ok'
      && (receipt.missing.length > 0 || receipt.orphans.length > 0 || receipt.conflicts.length > 0))
        {
            fail('status=ok requires empty missing, orphan, and conflict sets');
        }
    }

    if (options.factExtractorRegistry != null)
    {
        const registry = loadJson(options.factExtractorRegistry);
        if (registry?.schema !== 'fsusblog.behavior-fact-extractor-registry.v1'
      || !Array.isArray(registry.extractors))
        {
            fail('fact extractor registry authority is invalid');
        }
        const expectedRegistryDigest = digestValue(registry);
        if (normalizeDigest(receipt.registryDigest) !== expectedRegistryDigest)
        {
            fail('registryDigest does not match fact extractor registry authority');
        }
        const expectedCompiled = new Map();
        for (const extractor of registry.extractors)
        {
            if (extractor.requiredBuildArtifact == null)
            {
                if (Object.hasOwn(receipt.buildIdentities, extractor.id))
                {
                    fail(`source-only extractor ${extractor.id} must not have a build identity`);
                }
                continue;
            }
            expectedCompiled.set(extractor.id, extractor.requiredBuildArtifact);
        }
        const actualIds = Object.keys(receipt.buildIdentities).sort();
        const expectedIds = [...expectedCompiled.keys()].sort();
        if (actualIds.join('\0') !== expectedIds.join('\0'))
        {
            fail('buildIdentities do not exactly cover required compiled extractor authorities');
        }
        for (const [extractorId, artifactId] of expectedCompiled)
        {
            if (receipt.buildIdentities[extractorId].artifactId !== artifactId)
            {
                fail(`buildIdentities.${extractorId}.artifactId does not match registry authority`);
            }
        }
    }
    return receipt;
}

/**
 * Assert the receipt is qualified (status=ok).
 */
export function assertPreRuntimeQualified(receipt, options = {})
{
    validatePreRuntimeReceipt(receipt, options);
    if (receipt.status !== 'ok')
    {
        fail(
            `${receipt.failureReasons.length} failure(s)\n`
      + receipt.failureReasons.map((reason) => `- ${reason}`).join('\n')
        );
    }
    return receipt;
}

/**
 * Runtime/browser/production/release candidate admission guard.
 *
 * Refuses to start a candidate while the verified pre-runtime receipt is
 * missing, failed, tampered, or identity-mismatched. This keeps
 * runtimeCandidateSpawnCountBeforeReceipt at 0 even if the scheduler edge is
 * bypassed.
 */
export function assertRuntimeCandidateAdmissionAllowed({
    receipt,
    expectedCommit,
    expectedWorktreeFingerprint,
    behaviorCatalog = canonicalCatalogPath,
    factExtractorRegistry = path.join(root, 'config/contracts/behavior-fact-extractors.json')
} = {})
{
    if (typeof receipt === 'string' && !fs.existsSync(receipt))
    {
        fail('runtime candidate admission refused: pre-runtime receipt is missing');
    }
    const loaded = loadJson(receipt);
    validatePreRuntimeReceipt(loaded, { behaviorCatalog, factExtractorRegistry });
    if (loaded.status !== 'ok')
    {
        fail(
            `runtime candidate admission refused: pre-runtime receipt failed `
      + `(${loaded.failureReasons.length} failure(s))`
        );
    }
    if (!commitPattern.test(String(expectedCommit ?? '')))
    {
        fail('runtime candidate admission requires an exact expected source commit');
    }
    const expectedFp = normalizeFingerprint(String(expectedWorktreeFingerprint ?? ''));
    if (!expectedFp)
    {
        fail('runtime candidate admission requires an exact expected worktree fingerprint');
    }
    if (loaded.sourceIdentity?.commit !== expectedCommit)
    {
        fail(
            `runtime candidate admission refused: receipt source commit ${loaded.sourceIdentity?.commit} `
      + `does not match expected ${expectedCommit}`
        );
    }
    if (normalizeFingerprint(loaded.sourceIdentity?.worktreeFingerprint) !== expectedFp)
    {
        fail('runtime candidate admission refused: receipt worktree fingerprint does not match expected');
    }
    return loaded;
}

// CLI entry point — only runs when invoked directly, not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h'))
    {
        console.log(`Usage: node tools/test-matrix/behavior-evidence-pre-runtime.mjs [options]

Join sealed BehaviorGraph inputs and produce a pre-runtime evidence receipt.

Required options:
  --catalog <path>
  --fact-extractor-registry <path>
  --owner <path>
  --static-admission <path>
  --test-evidence <path>      (repeatable for backend + frontend)
  --doc-claim-parse <path>
  --doc-claim-verification <path>
  --generated-section-check <path>
  --fact-observation <path>   (repeatable)
  --source-commit <sha>
  --worktree-fingerprint <hex>

Optional:
  --mutation-evidence <path>
  --run-id <id>
  --out <path>
  --json
  --assert

Runtime-candidate guard (refuses spawn unless receipt is verified):
  --guard-runtime-candidate <receipt-path> --source-commit <sha> --worktree-fingerprint <hex>
`);
        process.exit(0);
    }

    function resolveArg(name)
    {
        const index = args.indexOf(`--${name}`);
        if (index < 0)
        {
            return null;
        }
        const value = args[index + 1];
        if (!value)
        {
            fail(`--${name} requires a value`);
        }
        return value;
    }

    function resolveRepeatable(name)
    {
        const result = [];
        for (let index = 0; index < args.length; index += 1)
        {
            if (args[index] === `--${name}`)
            {
                const value = args[index + 1];
                if (!value)
                {
                    fail(`--${name} requires a value`);
                }
                result.push(value);
                index += 1;
            }
        }
        return result;
    }

    try
    {
        const guardPath = resolveArg('guard-runtime-candidate');
        if (guardPath != null)
        {
            assertRuntimeCandidateAdmissionAllowed({
                receipt: guardPath,
                expectedCommit: requireField(resolveArg('source-commit'), '--source-commit'),
                expectedWorktreeFingerprint: requireField(
                    resolveArg('worktree-fingerprint'),
                    '--worktree-fingerprint'
                ),
                factExtractorRegistry: resolveArg('fact-extractor-registry')
                    ?? path.join(root, 'config/contracts/behavior-fact-extractors.json')
            });
            console.log('[behavior-evidence-pre-runtime] runtime candidate admission allowed (receipt verified)');
            process.exit(0);
        }

        const receipt = joinBehaviorEvidencePreRuntime({
            catalog: requireField(resolveArg('catalog'), '--catalog'),
            factExtractorRegistry: requireField(
                resolveArg('fact-extractor-registry'),
                '--fact-extractor-registry'
            ),
            ownerReceipt: requireField(resolveArg('owner'), '--owner'),
            staticAdmissionReceipt: requireField(resolveArg('static-admission'), '--static-admission'),
            testEvidenceReceipts: resolveRepeatable('test-evidence'),
            docClaimParseReceipt: requireField(resolveArg('doc-claim-parse'), '--doc-claim-parse'),
            docClaimVerificationReceipt: requireField(
                resolveArg('doc-claim-verification'),
                '--doc-claim-verification'
            ),
            generatedSectionCheckReceipt: requireField(
                resolveArg('generated-section-check'),
                '--generated-section-check'
            ),
            factObservationReceipts: resolveRepeatable('fact-observation'),
            mutationEvidenceReceipt: resolveArg('mutation-evidence'),
            sourceCommit: requireField(resolveArg('source-commit'), '--source-commit'),
            worktreeFingerprint: requireField(
                resolveArg('worktree-fingerprint'),
                '--worktree-fingerprint'
            ),
            runIdentity: resolveArg('run-id')
        });

        const out = resolveArg('out');
        if (out)
        {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
        }

        if (args.includes('--json'))
        {
            process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
        }
        else if (receipt.status === 'ok')
        {
            console.log(
                `[behavior-evidence-pre-runtime] ok behaviors=${receipt.behaviorIds.length} `
        + `digest=${receipt.contentDigest.slice(0, 20)}`
            );
        }
        else
        {
            console.error(
                `[behavior-evidence-pre-runtime] failed reasons=${receipt.failureReasons.length}`
            );
            for (const reason of receipt.failureReasons)
            {
                console.error(`- ${reason}`);
            }
        }

        if (args.includes('--assert'))
        {
            assertPreRuntimeQualified(receipt);
        }
        else if (receipt.status !== 'ok')
        {
            process.exitCode = 1;
        }
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 1;
    }
}


export const requiredEvidenceVerifier = Object.freeze({
    version: 1, successStatuses: Object.freeze(['ok']),
    describe: async (receipt) => (await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url))).describeOwnerReceipt(receipt, {
        identity: { namespace: 'namespace', runId: 'runIdentity', sourceCommit: 'sourceIdentity.commit',
            worktreeFingerprint: 'sourceIdentity.worktreeFingerprint' },
        status: 'status', contentDigest: 'contentDigest'
    }),
    async verify({ receipt })
    {
        const { verifiedOwnerResult } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        assertPreRuntimeQualified(receipt);
        return verifiedOwnerResult({ schema: receipt.schema, contentDigest: receipt.contentDigest });
    }
});
