#!/usr/bin/env node
/**
 * Independent verifier for per-behavior mutation qualification receipts
 * (#2187, delivery item 11).
 *
 * Re-reads the sealed mutation-evidence receipt, this-round selection,
 * authority (raw report/trace identities), owner receipt, #2185 test
 * bindings, BehaviorCatalog, test plan and #2186 behavior-test evidence, then
 * independently re-derives:
 *   - the reviewed C# runtime-kernel owner closure;
 *   - the exact mutation selection (selector closure digest);
 *   - binding digests and source identity;
 *   - raw result digests from the actual raw report/trace files;
 *   - per-behavior mutant coverage and qualification.
 *
 * Any tamper, cross-run/main/latest evidence, manualOnly required behavior,
 * global-score masking, mutant allowlist, manual override, duplicate/
 * multiple/zero results, selector/binding/source drift, or receipt/raw-result
 * tamper fails closed. Missing tool/runtime/input prints the canonical
 * producer command and fails; the verifier never falls back to manual
 * approval or warning success.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { root as repositoryRoot } from '../contracts/behavior-contract-catalog.mjs';
import {
    forbiddenJoinFields
} from '../contracts/behavior-graph-join.mjs';
import {
    scanBehaviorMutationGovernance
} from '../governance/check-behavior-mutation-governance.mjs';
import {
    expectedAttributionMutantIdsByBehavior,
    qualifyBehaviorMutations
} from '../test/changed-critical-mutation-attribution.mjs';
import { sha256, canonicalJson } from '../test/changed-critical-mutation-identity.mjs';
import {
    selectChangedCriticalMutation,
    selectRequiredBehaviorMutations,
    validateToolPolicy
} from '../test/changed-critical-mutation.mjs';
import { digestValue as receiptDigestValue } from '../test/mutation-evidence-receipt.mjs';

import {
    deriveBehaviorMutationOwners
} from './behavior-mutation-owner.mjs';
import {
    produceBehaviorMutationQualificationCommand,
    canonicalProducerCommand
} from './produce-behavior-mutation-qualification.mjs';
import { loadTestPlan } from './produce-behavior-test-evidence.mjs';


export const verifyBehaviorMutationQualificationCommand =
    'node tools/test-matrix/verify-behavior-mutation-qualification.mjs';
export const verifyBehaviorMutationQualificationReceiptSchema =
    'fsusblog.mutation-evidence-receipt.v1';

const bare = (value) => String(value ?? '').replace(/^sha256:/u, '');
const prefixed = (value) => `sha256:${bare(value)}`;

function isPlainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoForbiddenFields(value, label, errors)
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => assertNoForbiddenFields(entry, `${label}[${index}]`, errors));
        return;
    }
    if (!isPlainObject(value))
    {
        return;
    }
    for (const [key, nested] of Object.entries(value))
    {
        if (forbiddenJoinFields.includes(key))
        {
            errors.push(`${label} contains forbidden join field ${key}; default success cannot satisfy mutation qualification`);
        }
        assertNoForbiddenFields(nested, `${label}.${key}`, errors);
    }
}

function loadJson(repositoryRootValue, filePath, label, errors)
{
    const absolute = path.resolve(repositoryRootValue, filePath);
    if (!fs.existsSync(absolute))
    {
        errors.push(`${label} not found: ${filePath}`);
        return null;
    }
    try
    {
        return JSON.parse(fs.readFileSync(absolute, 'utf8'));
    }
    catch (error)
    {
        errors.push(`${label} is not valid JSON: ${error.message}`);
        return null;
    }
}

function cleanCanonicalTestIds(evidence)
{
    const clean = new Set();
    for (const entry of evidence?.evidence ?? [])
    {
        if (
            entry?.discovered === true
      && entry?.executed === true
      && entry?.outcome === 'passed'
      && entry?.run?.attemptKind !== 'retry'
      && entry?.run?.attemptKind !== 'diagnostic'
        )
        {
            clean.add(entry.canonicalTestId);
        }
    }
    return clean;
}

/**
 * Verify a sealed per-behavior mutation qualification receipt.
 *
 * @param {object} options - CLI/API inputs (see help below)
 * @returns {{ ok: boolean, errors: string[], canonicalCommand: string }}
 */
export function verifyBehaviorMutationQualification(options)
{
    const errors = [];
    const repositoryRootValue = options.repositoryRoot ?? repositoryRoot;
    const canonicalCommand = canonicalProducerCommand({
        scope: options.scope ?? null,
        changedPaths: options.changedPaths ?? null,
        catalog: options.catalog ?? null,
        sourceCommit: options.sourceCommit ?? null,
        worktreeFingerprint: options.worktreeFingerprint ?? null,
        runId: options.runId ?? null,
        attemptId: options.attemptId ?? null,
        ownerReceipt: options.ownerReceipt ?? null,
        behaviorCatalog: options.behaviorCatalog ?? null,
        testBindings: options.testBindings ?? null,
        testPlan: options.testPlan ?? null,
        behaviorTestEvidence: options.behaviorTestEvidence ?? null,
        ownerCatalog: options.ownerCatalog ?? null,
        repositoryRoot: options.repositoryRoot ?? null
    });

    // 0. Required inputs — missing tool/runtime/input fails with the canonical
    // producer command; never manual approval or warning success.
    const missing = [];
    if (!options.receipt)
    {
        missing.push('--receipt');
    }
    if (!options.selection)
    {
        missing.push('--selection');
    }
    if (!options.authority)
    {
        missing.push('--authority');
    }
    if (!options.ownerReceipt)
    {
        missing.push('--owner-receipt');
    }
    if (!options.testBindings)
    {
        missing.push('--test-bindings');
    }
    if (!options.testPlan)
    {
        missing.push('--test-plan');
    }
    if (!options.behaviorTestEvidence)
    {
        missing.push('--behavior-test-evidence');
    }
    if (!options.sourceCommit)
    {
        missing.push('--source-commit');
    }
    if (!options.worktreeFingerprint)
    {
        missing.push('--worktree-fingerprint');
    }
    if (!options.runId)
    {
        missing.push('--run-id');
    }
    if (missing.length > 0)
    {
        return {
            ok: false,
            errors: [`missing required input(s): ${missing.join(', ')}`],
            canonicalCommand
        };
    }

    // 0b. Static governance (manualOnly required behavior, requiredFor none,
    // global score pass, history reuse, mutant allowlist, manual override).
    const governance = scanBehaviorMutationGovernance({
        repositoryRoot: repositoryRootValue,
        ...(typeof options.governanceMatrixYaml === 'string'
            ? { matrixYaml: options.governanceMatrixYaml }
            : {}),
        ...(isPlainObject(options.governanceCatalog)
            ? { catalog: options.governanceCatalog }
            : {})
    });
    if (!governance.ok)
    {
        errors.push(
            `static behavior-mutation governance failed: ${governance.violations.join('; ')}`
        );
    }

    // 1. Receipt identity + tamper.
    const receipt = loadJson(repositoryRootValue, options.receipt, 'mutation evidence receipt', errors);
    if (receipt)
    {
        if (receipt.schema !== verifyBehaviorMutationQualificationReceiptSchema)
        {
            errors.push(
                `mutation evidence schema mismatch: expected ${verifyBehaviorMutationQualificationReceiptSchema}, got ${receipt.schema ?? '<missing>'}`
            );
        }
        assertNoForbiddenFields(receipt, 'receipt', errors);
        const payload = structuredClone(receipt);
        delete payload.contentDigest;
        const expected = receiptDigestValue(payload);
        if (bare(receipt.contentDigest) !== expected)
        {
            errors.push('mutation evidence contentDigest mismatch (tamper or second producer)');
        }
        if (receipt.sourceCommit !== options.sourceCommit)
        {
            errors.push(`mutation evidence source commit mismatch: expected ${options.sourceCommit}, got ${receipt.sourceCommit ?? '<missing>'}`);
        }
        if (bare(receipt.worktreeFingerprint) !== bare(options.worktreeFingerprint))
        {
            errors.push(`mutation evidence worktree fingerprint mismatch: expected ${options.worktreeFingerprint}, got ${receipt.worktreeFingerprint ?? '<missing>'}`);
        }
        if (receipt.runId !== options.runId)
        {
            errors.push(`mutation evidence run identity mismatch: expected ${options.runId}, got ${receipt.runId ?? '<missing>'}`);
        }
        if (!receipt.attemptId)
        {
            errors.push('mutation evidence attempt identity is missing');
        }
        if (receipt.scope !== 'pr' && receipt.scope !== 'release')
        {
            errors.push(`mutation evidence scope must be pr or release, got ${receipt.scope ?? '<missing>'}`);
        }
        for (const field of [
            'selectionDigest',
            'ownerReceiptDigest',
            'testBindingScanDigest',
            'rawReportDigest',
            'rawTraceDigest',
            'testPlanDigest',
            'behaviorTestEvidenceDigest',
            'implementationOwnerClosureDigest'
        ])
        {
            if (!/^[a-f0-9]{64}$/u.test(bare(receipt[field] ?? '')))
            {
                errors.push(`mutation evidence ${field} must be a SHA-256 digest`);
            }
        }
        if (receipt.status !== 'ok' && receipt.status !== 'failed')
        {
            errors.push(`mutation evidence status must be ok or failed, got ${receipt.status ?? '<missing>'}`);
        }
        if (receipt.status === 'ok' && (receipt.blockedCount !== 0 || receipt.failureReasons.length !== 0))
        {
            errors.push('mutation evidence status=ok cannot carry blocked or failed mutations');
        }
    }

    // 2. Test plan identity.
    const planResult = loadTestPlan(options.testPlan, { repositoryRoot: repositoryRootValue });
    errors.push(...planResult.errors.map((entry) => `test plan: ${entry}`));
    const testPlanDigest = planResult.testPlanDigest;
    if (receipt && testPlanDigest && bare(receipt.testPlanDigest) !== bare(testPlanDigest))
    {
        errors.push(
            `mutation evidence testPlanDigest mismatch: expected ${bare(testPlanDigest)}, got ${bare(receipt.testPlanDigest)}`
        );
    }

    // 3. #2186 behavior-test evidence (raw-result identity, clean-test map).
    const behaviorTestEvidence = loadJson(
        repositoryRootValue,
        options.behaviorTestEvidence,
        'behavior-test evidence receipt',
        errors
    );
    if (behaviorTestEvidence)
    {
        if (behaviorTestEvidence.schema !== 'fsusblog.behavior-test-evidence-receipt.v1')
        {
            errors.push(`behavior-test evidence schema mismatch: got ${behaviorTestEvidence.schema ?? '<missing>'}`);
        }
        const evidencePayload = structuredClone(behaviorTestEvidence);
        delete evidencePayload.contentDigest;
        const expectedEvidenceDigest = prefixed(receiptDigestValue(evidencePayload));
        if (bare(behaviorTestEvidence.contentDigest) !== bare(expectedEvidenceDigest))
        {
            errors.push('behavior-test evidence contentDigest mismatch (tamper or second producer)');
        }
        if (behaviorTestEvidence.producer?.command !== 'node tools/test-matrix/produce-behavior-test-evidence.mjs')
        {
            errors.push('behavior-test evidence producer is not canonical');
        }
        if (behaviorTestEvidence?.sourceState?.commit !== options.sourceCommit)
        {
            errors.push('behavior-test evidence source commit mismatch (cross-run evidence refused)');
        }
        if (bare(behaviorTestEvidence?.sourceState?.worktreeFingerprint) !== bare(options.worktreeFingerprint))
        {
            errors.push('behavior-test evidence worktree fingerprint mismatch (cross-run evidence refused)');
        }
        if (behaviorTestEvidence?.run?.id && behaviorTestEvidence.run.id !== options.runId)
        {
            errors.push('behavior-test evidence run identity mismatch (cross-run evidence refused)');
        }
        for (const entry of behaviorTestEvidence?.evidence ?? [])
        {
            if (entry?.run?.attemptKind === 'retry')
            {
                errors.push(`${entry.canonicalTestId} retry evidence cannot satisfy clean mutation qualification`);
            }
            if (entry?.run?.attemptKind === 'diagnostic')
            {
                errors.push(`${entry.canonicalTestId} diagnostic evidence cannot satisfy clean mutation qualification`);
            }
        }
        if (receipt && bare(receipt.behaviorTestEvidenceDigest) !== bare(behaviorTestEvidence.contentDigest))
        {
            errors.push('mutation evidence behaviorTestEvidenceDigest does not match the #2186 receipt');
        }
    }

    // 4. Tool policy + catalog + #2185 binding scan.
    const catalogPath = options.catalog
        ? path.resolve(repositoryRootValue, options.catalog)
        : path.join(repositoryRootValue, 'config/testing/mutation/changed-critical-domains.v1.json');
    let toolPolicy = null;
    let rawToolPolicy = null;
    let behaviorCatalog = null;
    let testBindingScan = null;
    let rawTestBindingScan = null;
    if (!fs.existsSync(catalogPath))
    {
        errors.push(`tool policy not found: ${catalogPath}`);
    }
    else
    {
        rawToolPolicy = fs.readFileSync(catalogPath);
        try
        {
            toolPolicy = JSON.parse(rawToolPolicy);
            validateToolPolicy(toolPolicy);
        }
        catch (error)
        {
            errors.push(`tool policy invalid: ${error.message}`);
        }
    }
    behaviorCatalog = loadJson(
        repositoryRootValue,
        options.behaviorCatalog ?? 'config/contracts/behavior-contracts.json',
        'behavior catalog',
        errors
    );
    const bindingsAbsolute = path.resolve(repositoryRootValue, options.testBindings);
    if (!fs.existsSync(bindingsAbsolute))
    {
        errors.push(`test binding scan not found: ${options.testBindings}`);
    }
    else
    {
        rawTestBindingScan = fs.readFileSync(bindingsAbsolute);
        try
        {
            testBindingScan = JSON.parse(rawTestBindingScan);
        }
        catch (error)
        {
            errors.push(`test binding scan is not valid JSON: ${error.message}`);
        }
        if (testBindingScan?.schema !== 'fsusblog.behavior-test-binding-scan.v1')
        {
            errors.push('test binding input must be a behavior-test-binding scan (v1)');
        }
    }

    // 5. Owner receipt digest + re-derived implementation-owner closure.
    const ownerReceipt = loadJson(repositoryRootValue, options.ownerReceipt, 'owner receipt', errors);
    if (ownerReceipt)
    {
        if (ownerReceipt.schema !== 'fsusblog.behavior-owner-binding-receipt.v1')
        {
            errors.push('owner receipt schema mismatch');
        }
        const ownerPayload = structuredClone(ownerReceipt);
        delete ownerPayload.contentDigest;
        const expectedOwnerDigest = receiptDigestValue(ownerPayload);
        if (bare(ownerReceipt.contentDigest) !== expectedOwnerDigest)
        {
            errors.push('owner receipt contentDigest mismatch (tamper)');
        }
        if (receipt && bare(receipt.ownerReceiptDigest) !== bare(ownerReceipt.contentDigest))
        {
            errors.push('mutation evidence ownerReceiptDigest does not match the scanned owner receipt');
        }
    }

    const ownerCatalog = loadJson(
        repositoryRootValue,
        options.ownerCatalog ?? 'config/testing/mutation/behavior-mutation-owners.v2.json',
        'mutation owner catalog',
        errors
    );
    let implementationOwnerClosure = null;
    if (behaviorCatalog && ownerCatalog)
    {
        const derived = deriveBehaviorMutationOwners({
            behaviorCatalog,
            ownerCatalog,
            sourceProjects: toolPolicy?.sourceProjects,
            repositoryRoot: repositoryRootValue,
            worktreeDigest: options.worktreeFingerprint
        });
        if (derived.errors.length > 0)
        {
            errors.push(`implementation-owner closure re-derivation failed: ${derived.errors.join('; ')}`);
        }
        else
        {
            implementationOwnerClosure = derived.closure;
            if (receipt && bare(receipt.implementationOwnerClosureDigest) !== bare(implementationOwnerClosure.contentDigest))
            {
                errors.push('mutation evidence implementationOwnerClosureDigest does not match the re-derived closure');
            }
        }
    }

    // 6. Re-run the exact selector and compare closure digests.
    const selection = loadJson(repositoryRootValue, options.selection, 'mutation selection', errors);
    if (selection && toolPolicy && behaviorCatalog && testBindingScan && rawTestBindingScan)
    {
        const common = {
            toolPolicy,
            rawToolPolicy,
            sourceState: {
                commit: selection.sourceState?.commit ?? options.sourceCommit,
                worktreeFingerprint: selection.sourceState?.worktreeFingerprint ?? options.worktreeFingerprint
            },
            ownerReceipt,
            implementationOwnerClosure,
            behaviorCatalog,
            testBindingScan,
            rawTestBindingScan
        };
        try
        {
            const rederived = selection.scope === 'release'
                ? selectRequiredBehaviorMutations(common)
                : selectChangedCriticalMutation({
            ...common,
            changedPaths: Array.isArray(selection.changedPaths) ? selection.changedPaths : []
          });
            if (bare(rederived.closureDigest) !== bare(selection.closureDigest))
            {
                errors.push('selector closure digest drift: re-derived selection does not match the sealed selection');
            }
            if (receipt && bare(receipt.selectionDigest) !== bare(selection.closureDigest))
            {
                errors.push('mutation evidence selectionDigest does not match the sealed selection');
            }
            if (rederived.status !== 'selected')
            {
                errors.push('re-derived mutation selection is not selected (required behaviors missing)');
            }
            for (const behavior of rederived.behaviors)
            {
                if (!Array.isArray(behavior.mutateFiles) || behavior.mutateFiles.length === 0)
                {
                    errors.push(`${behavior.behaviorId} has no C# mutation source in the re-derived selection`);
                }
            }
            if (receipt?.scope === 'release'
        && rederived.behaviors.length !== receipt.qualifications?.length)
            {
                errors.push(
                    `release qualification count mismatch: selection has ${rederived.behaviors.length} behaviors, receipt has ${receipt.qualifications?.length ?? 0}`
                );
            }
        }
        catch (error)
        {
            errors.push(`selector re-derivation failed: ${error.message}`);
        }
    }
    if (testBindingScan && rawTestBindingScan && receipt)
    {
        const scanDigest = sha256(rawTestBindingScan);
        if (bare(receipt.testBindingScanDigest) !== bare(scanDigest))
        {
            errors.push('mutation evidence testBindingScanDigest does not match the current scan bytes');
        }
    }

    // 7. Raw results: authority identity + re-hash of actual raw report/trace.
    const authority = loadJson(repositoryRootValue, options.authority, 'mutation authority', errors);
    if (authority)
    {
        if (authority.schema !== 'fsusblog.changed-critical-mutation-authority.v2')
        {
            errors.push('mutation authority schema mismatch');
        }
        if (authority.closureDigest && selection && bare(authority.closureDigest) !== bare(selection.closureDigest))
        {
            errors.push('mutation authority closure digest does not match the selection');
        }
        if (authority.sourceState?.commit !== options.sourceCommit)
        {
            errors.push('mutation authority source commit mismatch (cross-run authority refused)');
        }
        if (bare(authority.sourceState?.worktreeFingerprint) !== bare(options.worktreeFingerprint))
        {
            errors.push('mutation authority worktree fingerprint mismatch (cross-run authority refused)');
        }
        if (authority.runId !== options.runId)
        {
            errors.push('mutation authority run identity mismatch (cross-run authority refused)');
        }
        if (authority.mutants?.executed === 0)
        {
            errors.push('mutation authority executed zero mutants for a non-empty closure');
        }
        for (const run of authority.physicalRuns ?? [])
        {
            for (const kind of ['rawReport', 'rawTrace'])
            {
                const entry = run[kind];
                const absolute = path.resolve(repositoryRootValue, entry?.path ?? '');
                if (!fs.existsSync(absolute))
                {
                    errors.push(`${run.runKey} ${kind} file missing: ${entry?.path ?? '<missing>'}`);
                    continue;
                }
                const actual = sha256(fs.readFileSync(absolute));
                if (bare(actual) !== bare(entry?.sha256))
                {
                    errors.push(`${run.runKey} ${kind} file tamper: digest mismatch on ${entry?.path}`);
                }
            }
        }
        const digestRuns = (kind) => canonicalJson(
            (authority.physicalRuns ?? [])
                .map(({ runKey, sourceProject, ...run }) => ({
                    runKey,
                    sourceProject,
                    ...run[kind]
                }))
                .sort((left, right) => left.runKey.localeCompare(right.runKey))
        );
        if (receipt)
        {
            const rawReportDigest = sha256(digestRuns('rawReport'));
            const rawTraceDigest = sha256(digestRuns('rawTrace'));
            if (bare(receipt.rawReportDigest) !== bare(authority.rawReportDigest)
        || bare(authority.rawReportDigest) !== bare(rawReportDigest))
            {
                errors.push('mutation evidence rawReportDigest does not match the authority/raw files');
            }
            if (bare(receipt.rawTraceDigest) !== bare(authority.rawTraceDigest)
        || bare(authority.rawTraceDigest) !== bare(rawTraceDigest))
            {
                errors.push('mutation evidence rawTraceDigest does not match the authority/raw files');
            }
        }
    }

    // 8. Mutant coverage + per-behavior qualification recompute.
    if (receipt && selection && authority && behaviorCatalog && testBindingScan)
    {
        const expectedByBehavior = expectedAttributionMutantIdsByBehavior(selection, authority);
        const cleanCanonical = cleanCanonicalTestIds(behaviorTestEvidence);
        const bindingByTestId = Object.fromEntries(
            [...new Map(
                (testBindingScan.bindings ?? []).map((binding) => [binding.canonicalTestId, binding])
            ).values()].map((binding) => [binding.canonicalTestId, binding])
        );
        const testIdentityByRawId = Object.fromEntries(
            (authority.testIdentities ?? []).map((entry) => [entry.rawTestId, entry.fullyQualifiedName])
        );
        const cleanTestIdsByBehavior = {};
        for (const behavior of selection.behaviors)
        {
            cleanTestIdsByBehavior[behavior.behaviorId] = (behavior.testBindings ?? [])
                .map((binding) => binding.canonicalTestId)
                .filter((testId) => cleanCanonical.has(testId));
        }
        const recomputed = qualifyBehaviorMutations({
            attributions: receipt.attributions ?? [],
            blocked: [],
            behaviorCatalog,
            behaviorIds: selection.behaviors.map(({ behaviorId }) => behaviorId),
            qualificationOptions: {
                expectedMutantIdsByBehavior: expectedByBehavior,
                cleanTestIdsByBehavior,
                bindingByTestId,
                testIdentityByRawId
            }
        });
        if (recomputed.failed)
        {
            errors.push(
                'per-behavior qualification recompute failed: '
        + recomputed.qualifications.flatMap((entry) => entry.failures).join('; ')
            );
        }

        const receiptByBehavior = new Map(
            (receipt.qualifications ?? []).map((entry) => [entry.behaviorId, entry])
        );
        for (const behavior of selection.behaviors)
        {
            const behaviorId = behavior.behaviorId;
            const expectedIds = expectedByBehavior[behaviorId] ?? [];
            if (expectedIds.length === 0)
            {
                errors.push(`${behaviorId} has zero required mutants (exact required closure missing)`);
            }
            const attributed = (receipt.attributions ?? []).filter((entry) => entry.behaviorId === behaviorId);
            const attributedIds = attributed.map((entry) => entry.mutantId);
            const seen = new Map();
            let duplicates = 0;
            for (const mutantId of attributedIds)
            {
                if (seen.has(mutantId))
                {
                    duplicates += 1;
                }
                seen.set(mutantId, true);
            }
            if (duplicates > 0)
            {
                errors.push(`${behaviorId} has ${duplicates} duplicate/multiple mutant result(s)`);
            }
            const missing = expectedIds.filter((mutantId) => !seen.has(mutantId));
            if (missing.length > 0)
            {
                errors.push(`${behaviorId} missing required mutant result(s): ${missing.sort().join(', ')}`);
            }
            const extra = attributedIds.filter((mutantId) => !expectedIds.includes(mutantId));
            if (extra.length > 0)
            {
                errors.push(`${behaviorId} has unexpected mutant result(s): ${[...new Set(extra)].sort().join(', ')}`);
            }
            const recorded = receiptByBehavior.get(behaviorId);
            if (!recorded)
            {
                errors.push(`${behaviorId} missing qualification record`);
                continue;
            }
            if (recorded.requiredMutants !== expectedIds.length)
            {
                errors.push(`${behaviorId} qualification requiredMutants mismatch: expected ${expectedIds.length}, got ${recorded.requiredMutants}`);
            }
            if (recorded.recordedMutants !== attributed.length)
            {
                errors.push(`${behaviorId} qualification recordedMutants mismatch: expected ${attributed.length}, got ${recorded.recordedMutants}`);
            }
            const recomputedEntry = recomputed.qualifications.find((entry) => entry.behaviorId === behaviorId);
            if (recomputedEntry && (recomputedEntry.qualified !== recorded.qualified))
            {
                errors.push(`${behaviorId} qualification tamper: recomputed qualified=${recomputedEntry.qualified}, receipt says ${recorded.qualified}`);
            }
            if (recomputedEntry && canonicalJson(recomputedEntry.failures) !== canonicalJson(recorded.failures ?? []))
            {
                errors.push(`${behaviorId} qualification failure list tamper`);
            }
        }

        // Per-mutant expected test evidence must match the binding contract.
        const expectedByBehaviorMap = new Map(
            selection.behaviors.map((behavior) => [
                behavior.behaviorId,
                {
                    testIds: [...new Set((behavior.testBindings ?? []).map((binding) => binding.canonicalTestId))].sort(),
                    testKinds: [...new Set((behavior.testBindings ?? []).map((binding) => binding.testKind))].sort()
                }
            ])
        );
        for (const attribution of receipt.attributions ?? [])
        {
            const expected = expectedByBehaviorMap.get(attribution.behaviorId);
            if (!expected)
            {
                errors.push(`attribution references unknown behavior ${attribution.behaviorId}`);
                continue;
            }
            if (canonicalJson([...(attribution.expectedKilledTestIds ?? [])].sort())
        !== canonicalJson(expected.testIds))
            {
                errors.push(`${attribution.mutantId} expectedKilledTestIds tamper`);
            }
            if (canonicalJson([...(attribution.expectedTestKinds ?? [])].sort())
        !== canonicalJson(expected.testKinds))
            {
                errors.push(`${attribution.mutantId} expectedTestKinds tamper`);
            }
            if (!attribution.attempt || !attribution.provenance)
            {
                errors.push(`${attribution.mutantId} missing attempt/provenance`);
            }
            if (attribution.provenance !== options.runId)
            {
                errors.push(`${attribution.mutantId} provenance is not this run (${attribution.provenance ?? '<missing>'})`);
            }
        }
    }

    return {
        ok: errors.length === 0,
        errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right)),
        canonicalCommand
    };
}

function parseArgs(argv)
{
    const options = {
        receipt: null,
        selection: null,
        authority: null,
        ownerReceipt: null,
        testBindings: null,
        behaviorCatalog: null,
        ownerCatalog: null,
        catalog: null,
        testPlan: null,
        behaviorTestEvidence: null,
        sourceCommit: null,
        worktreeFingerprint: null,
        runId: null,
        scope: null,
        attemptId: null,
        changedPaths: null,
        repositoryRoot: null,
        help: false
    };
    const names = new Map([
        ['--receipt', 'receipt'],
        ['--selection', 'selection'],
        ['--authority', 'authority'],
        ['--owner-receipt', 'ownerReceipt'],
        ['--test-bindings', 'testBindings'],
        ['--behavior-catalog', 'behaviorCatalog'],
        ['--owner-catalog', 'ownerCatalog'],
        ['--catalog', 'catalog'],
        ['--test-plan', 'testPlan'],
        ['--behavior-test-evidence', 'behaviorTestEvidence'],
        ['--source-commit', 'sourceCommit'],
        ['--worktree-fingerprint', 'worktreeFingerprint'],
        ['--run-id', 'runId'],
        ['--scope', 'scope'],
        ['--attempt-id', 'attemptId'],
        ['--changed-paths', 'changedPaths'],
        ['--repository-root', 'repositoryRoot']
    ]);
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h')
        {
            options.help = true;
            continue;
        }
        const key = names.get(argument);
        if (!key)
        {
            throw new Error(`unknown argument: ${argument}`);
        }
        options[key] = argv[++index] ?? null;
    }
    return options;
}

function printHelp()
{
    console.log(`Usage: node tools/test-matrix/verify-behavior-mutation-qualification.mjs [options]

Independently verifies a sealed per-behavior mutation qualification receipt
(fsusblog.mutation-evidence-receipt.v1). Any tamper, cross-run/main/latest
evidence, manualOnly required behavior, global-score masking, mutant
exclusion-list fields, manual override, duplicate/multiple/0 results,
selector/binding/
source drift, or receipt/raw-result tamper fails closed. Missing input prints
the canonical producer command.

Options:
  --receipt <path>                 Sealed mutation evidence receipt (required)
  --selection <path>               Sealed selection.json (required)
  --authority <path>               Changed-critical authority.json (required)
  --owner-receipt <path>           Scanned ImplementationOwner receipt (required)
  --test-bindings <path>           #2185 behavior-test binding scan (required)
  --test-plan <path>               Current-run test plan receipt (required)
  --behavior-test-evidence <path>  #2186 behavior-test evidence receipt (required)
  --source-commit <sha>            Expected current-run commit (required)
  --worktree-fingerprint <fp>      Expected current-run fingerprint (required)
  --run-id <id>                    Expected current-run identity (required)
  --scope <pr|release>             Expected receipt scope (for canonical command)
  --behavior-catalog <path>        BehaviorCatalog (default repo path)
  --owner-catalog <path>           Mutation-owner catalog (default repo path)
  --catalog <path>                 Changed-critical tool policy (default repo path)
  --repository-root <path>         Repository root for fixtures
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        if (options.help)
        {
            printHelp();
            process.exit(0);
        }
        const result = verifyBehaviorMutationQualification(options);
        if (!result.ok)
        {
            console.error('[verify-behavior-mutation-qualification] FAILED');
            console.error(`  canonical command: ${result.canonicalCommand}`);
            for (const error of result.errors)
            {
                console.error(`  ${error}`);
            }
            process.exitCode = 1;
        }
        else
        {
            console.log(
                `[verify-behavior-mutation-qualification] ok receipt=${options.receipt}`
            );
        }
    }
    catch (error)
    {
        console.error(
            `[verify-behavior-mutation-qualification] ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 2;
    }
}

export { produceBehaviorMutationQualificationCommand };
