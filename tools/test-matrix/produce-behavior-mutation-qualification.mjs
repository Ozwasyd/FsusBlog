#!/usr/bin/env node
/**
 * Canonical per-behavior mutation qualification producer (#2187).
 *
 * Converges the release-manual changed-critical mutation path into an
 * automatically executable/sealable producer that:
 *
 *   1. Selects exact mutants/test commands from the BehaviorCatalog,
 *      #2185 behavior-test bindings and the implementation-owner receipt.
 *      scope=pr  : affected behaviors (plus a fail-closed full required
 *                  closure whenever governance-sensitive paths change).
 *      scope=release : every active mutation-required behavior (the four
 *                  required release behaviors) with zero manual-only or
 *                  changed-only omission.
 *   2. Runs the physical Stryker closures on this round's clean source,
 *      worktree and build, and consumes this round's test plan receipt plus
 *      the #2186 behavior-test evidence receipt as raw-result identities.
 *      Cross-run/main/latest evidence is rejected.
 *   3. Attributes every mutant to a behavior, qualifies each behavior
 *      independently, and fails closed on survived/error/timeout/missing/
 *      unclean-kill evidence. Global score, manual approval, history reuse
 *      and mutant allowlists can never mask a per-behavior failure.
 *   4. Seals the existing #1751 `fsusblog.mutation-evidence-receipt.v1`
 *      schema (no second format) with exact required-mutant records.
 *
 * Missing tool/runtime/input fails with the canonical producer command; the
 * producer never falls back to manual approval or a warning success.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { root } from '../contracts/behavior-contract-catalog.mjs';
import {
    evidenceReceiptSchema as behaviorTestEvidenceReceiptSchema,
    scanBehaviorTestBindings
} from '../contracts/behavior-test-binding.mjs';
import { scanBehaviorMutationGovernance } from '../governance/check-behavior-mutation-governance.mjs';
import {
    attributeMutantsToBehaviors,
    attachExpectedTestEvidence,
    expectedAttributionMutantIdsByBehavior,
    qualifyBehaviorMutations
} from '../test/changed-critical-mutation-attribution.mjs';
import { createChangedCriticalMutationAuthority } from '../test/changed-critical-mutation-evidence.mjs';
import { readChangedPaths, repoRelative } from '../test/changed-critical-mutation-support.mjs';
import {
    selectChangedCriticalMutation,
    selectRequiredBehaviorMutations,
    validateToolPolicy
} from '../test/changed-critical-mutation.mjs';
import { sealMutationEvidenceReceipt } from '../test/mutation-evidence-receipt.mjs';
import { runChangedCriticalPhysicalMutations } from '../test/run-changed-critical-mutation.mjs';

import {
    deriveBehaviorMutationOwners,
    loadBehaviorMutationOwnerCatalog,
    loadFactExtractorRegistry
} from './behavior-mutation-owner.mjs';
import { loadTestPlan } from './produce-behavior-test-evidence.mjs';


export const produceBehaviorMutationQualificationCommand =
    'node tools/test-matrix/produce-behavior-mutation-qualification.mjs';
export const behaviorMutationQualificationTierId = 'backend-mutation-changed-critical';
export const mutationEvidenceReceiptSchema = 'fsusblog.mutation-evidence-receipt.v1';
export const defaultOutputRoot = '.tmp/mutation/changed-critical';

function sha256(data)
{
    return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function bareDigest(value)
{
    return String(value ?? '').replace(/^sha256:/u, '');
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function digestValue(value)
{
    return sha256(JSON.stringify(canonicalize(value)));
}

function writeJsonAtomic(filePath, value)
{
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const next = `${filePath}.next-${process.pid}`;
    fs.writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(next, filePath);
}

export function canonicalProducerCommand(options)
{
    const args = [produceBehaviorMutationQualificationCommand];
    args.push('--scope', options.scope ?? 'pr');
    if (options.changedPaths)
    {
        args.push('--changed-paths', options.changedPaths);
    }
    if (options.catalog)
    {
        args.push('--catalog', options.catalog);
    }
    if (options.sourceCommit)
    {
        args.push('--source-commit', options.sourceCommit);
    }
    if (options.worktreeFingerprint)
    {
        args.push('--worktree-fingerprint', options.worktreeFingerprint);
    }
    if (options.outputRoot)
    {
        args.push('--output-root', options.outputRoot);
    }
    if (options.runId)
    {
        args.push('--run-id', options.runId);
    }
    if (options.attemptId)
    {
        args.push('--attempt-id', options.attemptId);
    }
    if (options.ownerReceipt)
    {
        args.push('--owner-receipt', options.ownerReceipt);
    }
    if (options.behaviorCatalog)
    {
        args.push('--behavior-catalog', options.behaviorCatalog);
    }
    if (options.testBindings)
    {
        args.push('--test-bindings', options.testBindings);
    }
    if (options.testPlan)
    {
        args.push('--test-plan', options.testPlan);
    }
    if (options.behaviorTestEvidence)
    {
        args.push('--behavior-test-evidence', options.behaviorTestEvidence);
    }
    if (options.factExtractorRegistry)
    {
        args.push('--fact-extractor-registry', options.factExtractorRegistry);
    }
    if (options.ownerCatalog)
    {
        args.push('--owner-catalog', options.ownerCatalog);
    }
    if (options.governanceMatrix)
    {
        args.push('--governance-matrix', options.governanceMatrix);
    }
    if (options.governanceCatalog)
    {
        args.push('--governance-catalog', options.governanceCatalog);
    }
    if (options.repositoryRoot && options.repositoryRoot !== root)
    {
        args.push('--repository-root', options.repositoryRoot);
    }
    return args.join(' ');
}

function parseArgs(argv)
{
    const options = {
        scope: null,
        changedPaths: null,
        catalog: null,
        sourceCommit: null,
        worktreeFingerprint: null,
        outputRoot: null,
        runId: null,
        attemptId: null,
        ownerReceipt: null,
        behaviorCatalog: null,
        testBindings: null,
        testPlan: null,
        behaviorTestEvidence: null,
        factExtractorRegistry: null,
        ownerCatalog: null,
        governanceMatrix: null,
        governanceCatalog: null,
        repositoryRoot: root,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--scope')
        {
            options.scope = argv[++index] ?? null;
        }
        else if (argument === '--changed-paths')
        {
            options.changedPaths = argv[++index] ?? null;
        }
        else if (argument === '--catalog')
        {
            options.catalog = argv[++index] ?? null;
        }
        else if (argument === '--source-commit')
        {
            options.sourceCommit = argv[++index] ?? null;
        }
        else if (argument === '--worktree-fingerprint')
        {
            options.worktreeFingerprint = argv[++index] ?? null;
        }
        else if (argument === '--output-root')
        {
            options.outputRoot = argv[++index] ?? null;
        }
        else if (argument === '--run-id')
        {
            options.runId = argv[++index] ?? null;
        }
        else if (argument === '--attempt-id')
        {
            options.attemptId = argv[++index] ?? null;
        }
        else if (argument === '--owner-receipt')
        {
            options.ownerReceipt = argv[++index] ?? null;
        }
        else if (argument === '--behavior-catalog')
        {
            options.behaviorCatalog = argv[++index] ?? null;
        }
        else if (argument === '--test-bindings')
        {
            options.testBindings = argv[++index] ?? null;
        }
        else if (argument === '--test-plan')
        {
            options.testPlan = argv[++index] ?? null;
        }
        else if (argument === '--behavior-test-evidence')
        {
            options.behaviorTestEvidence = argv[++index] ?? null;
        }
        else if (argument === '--fact-extractor-registry')
        {
            options.factExtractorRegistry = argv[++index] ?? null;
        }
        else if (argument === '--owner-catalog')
        {
            options.ownerCatalog = argv[++index] ?? null;
        }
        else if (argument === '--governance-matrix')
        {
            options.governanceMatrix = argv[++index] ?? null;
        }
        else if (argument === '--governance-catalog')
        {
            options.governanceCatalog = argv[++index] ?? null;
        }
        else if (argument === '--repository-root')
        {
            options.repositoryRoot = argv[++index] ?? root;
        }
        else if (argument === '--help' || argument === '-h')
        {
            options.help = true;
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

function printHelp()
{
    console.log(`Usage: node tools/test-matrix/produce-behavior-mutation-qualification.mjs [options]

Produces the sealed per-behavior mutation qualification receipt
(fsusblog.mutation-evidence-receipt.v1) for the required release behaviors.
scope=pr selects the changed behavior closure (with a fail-closed full
required closure for governance-sensitive changes); scope=release runs every
active mutation-required behavior.

Options:
  --scope <pr|release>             Qualification scope (required)
  --changed-paths <path>           Changed-paths file (required for scope=pr)
  --catalog <path>                 Changed-critical tool policy (default repo path)
  --source-commit <sha>            Current-run git commit (required)
  --worktree-fingerprint <fp>      Current-run worktree fingerprint (required)
  --output-root <path>             Run output root (default .tmp/mutation/changed-critical)
  --run-id <id>                    Current-run identity (required)
  --attempt-id <id>                Attempt identity (default attempt-0001)
  --owner-receipt <path>           ImplementationOwner receipt (required)
  --behavior-catalog <path>        BehaviorCatalog (default config/contracts/behavior-contracts.json)
  --test-bindings <path>           #2185 behavior-test binding scan (required)
  --test-plan <path>               Current-run test plan receipt (required)
  --behavior-test-evidence <path>  #2186 behavior-test evidence receipt (required)
  --fact-extractor-registry <path> Behavior fact-extractor registry (default repo path)
  --owner-catalog <path>           Reviewed mutation-owner catalog (default repo path)
  --governance-matrix <path>       Matrix fixture for static-governance preflight (tests)
  --governance-catalog <path>      Catalog fixture for static-governance preflight (tests)
  --repository-root <path>         Repository root for fixtures
`);
}

function loadJson(repositoryRoot, filePath, label)
{
    const absolute = path.resolve(repositoryRoot, filePath);
    if (!fs.existsSync(absolute))
    {
        throw new Error(`${label} not found: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function loadBehaviorTestEvidence(repositoryRoot, filePath, expected)
{
    const receipt = loadJson(repositoryRoot, filePath, 'behavior-test evidence receipt');
    const errors = [];
    if (receipt?.schema !== behaviorTestEvidenceReceiptSchema)
    {
        errors.push(`behavior-test evidence schema mismatch: expected ${behaviorTestEvidenceReceiptSchema}, got ${receipt?.schema ?? '<missing>'}`);
    }
    if (receipt?.producer?.command !== 'node tools/test-matrix/produce-behavior-test-evidence.mjs')
    {
        errors.push(`behavior-test evidence producer is not canonical: ${receipt?.producer?.command ?? '<missing>'}`);
    }
    if (typeof receipt?.contentDigest !== 'string')
    {
        errors.push('behavior-test evidence missing contentDigest');
    }
    else
    {
        const payload = structuredClone(receipt);
        delete payload.contentDigest;
        if (receipt.contentDigest !== digestValue(payload))
        {
            errors.push('behavior-test evidence contentDigest mismatch (tamper or second producer)');
        }
    }
    if (expected.sourceCommit && receipt?.sourceState?.commit !== expected.sourceCommit)
    {
        errors.push(`behavior-test evidence source commit mismatch: expected ${expected.sourceCommit}, got ${receipt?.sourceState?.commit ?? '<missing>'}`);
    }
    if (
        expected.worktreeFingerprint
        && bareDigest(receipt?.sourceState?.worktreeFingerprint) !== bareDigest(expected.worktreeFingerprint)
    )
    {
        errors.push(`behavior-test evidence worktree fingerprint mismatch: expected ${expected.worktreeFingerprint}, got ${receipt?.sourceState?.worktreeFingerprint ?? '<missing>'}`);
    }
    if (expected.testPlanDigest && receipt?.testPlanDigest !== expected.testPlanDigest)
    {
        errors.push(`behavior-test evidence testPlanDigest mismatch: expected ${expected.testPlanDigest}, got ${receipt?.testPlanDigest ?? '<missing>'}`);
    }
    if (expected.runId && receipt?.run?.id && receipt.run.id !== expected.runId)
    {
        errors.push(`behavior-test evidence run identity mismatch: expected ${expected.runId}, got ${receipt.run.id}`);
    }
    for (const entry of receipt?.evidence ?? [])
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
    return { receipt, errors };
}

function cleanCanonicalTestIds(receipt)
{
    const clean = new Set();
    for (const entry of receipt?.evidence ?? [])
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

function produceBehaviorMutationQualification(options)
{
    const errors = [];
    const repositoryRoot = options.repositoryRoot ?? root;

    // 0. Required input identity (missing input fails closed with the canonical command).
    const missing = [];
    if (options.scope !== 'pr' && options.scope !== 'release')
    {
        missing.push('--scope <pr|release>');
    }
    if (options.scope === 'pr' && !options.changedPaths)
    {
        missing.push('--changed-paths');
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
    if (missing.length > 0)
    {
        return {
            receipt: null,
            errors: [`missing required input(s): ${missing.join(', ')}`],
            canonicalCommand: canonicalProducerCommand(options)
        };
    }

    const runDirectory = path.join(options.outputRoot, options.runId);
    const selectionPath = path.join(runDirectory, 'selection.json');
    const runManifestPath = path.join(runDirectory, 'run-manifest.json');
    const runPath = path.join(runDirectory, 'run.json');
    const authorityPath = path.join(runDirectory, 'authority.json');
    const receiptPath = path.join(runDirectory, 'mutation-evidence.json');

    // 0b. Static governance preflight (delivery item 12): the producer must
    // reject manualOnly required behaviors, requiredFor none, global-score
    // pass, history reuse, mutant allowlists and manual override before any
    // mutation work is started; it never downgrades to manual approval.
    let governanceMatrixYaml = null;
    let governanceCatalogValue = null;
    try
    {
        if (options.governanceMatrix)
        {
            governanceMatrixYaml = fs.readFileSync(
                path.resolve(repositoryRoot, options.governanceMatrix),
                'utf8'
            );
        }
        if (options.governanceCatalog)
        {
            governanceCatalogValue = JSON.parse(
                fs.readFileSync(path.resolve(repositoryRoot, options.governanceCatalog), 'utf8')
            );
        }
    }
    catch (error)
    {
        errors.push(`governance fixture load failure: ${error.message}`);
    }
    if (errors.length === 0)
    {
        const governance = scanBehaviorMutationGovernance({
            repositoryRoot,
            ...(governanceMatrixYaml !== null ? { matrixYaml: governanceMatrixYaml } : {}),
            ...(governanceCatalogValue !== null ? { catalog: governanceCatalogValue } : {})
        });
        if (!governance.ok)
        {
            errors.push(
                `static behavior-mutation governance failed: ${governance.violations.join('; ')}`
            );
        }
    }
    if (errors.length > 0)
    {
        return {
            receipt: null,
            errors: [...new Set(errors)].sort(),
            canonicalCommand: canonicalProducerCommand(options)
        };
    }

    // 1. Load tool policy, owner receipt, catalog, binding scan.
    let toolPolicy;
    let rawToolPolicy;
    let ownerReceipt;
    let behaviorCatalog;
    let testBindingScan;
    let rawTestBindingScan;
    let factExtractorRegistry;
    let ownerCatalog;
    try
    {
        const catalogPath = options.catalog
            ? path.resolve(repositoryRoot, options.catalog)
            : path.join(repositoryRoot, 'config/testing/mutation/changed-critical-domains.v1.json');
        rawToolPolicy = fs.readFileSync(catalogPath);
        toolPolicy = JSON.parse(rawToolPolicy);
        validateToolPolicy(toolPolicy);
        ownerReceipt = loadJson(repositoryRoot, options.ownerReceipt, 'owner receipt');
        behaviorCatalog = loadJson(
            repositoryRoot,
            options.behaviorCatalog ?? 'config/contracts/behavior-contracts.json',
            'behavior catalog'
        );
        rawTestBindingScan = fs.readFileSync(path.resolve(repositoryRoot, options.testBindings));
        testBindingScan = JSON.parse(rawTestBindingScan);
        if (testBindingScan?.schema !== 'fsusblog.behavior-test-binding-scan.v1')
        {
            throw new Error('test binding input must be a behavior-test-binding scan (v1)');
        }
        factExtractorRegistry = loadJson(
            repositoryRoot,
            options.factExtractorRegistry ?? 'config/contracts/behavior-fact-extractors.json',
            'fact extractor registry'
        );
        ownerCatalog = loadJson(
            repositoryRoot,
            options.ownerCatalog ?? 'config/testing/mutation/behavior-mutation-owners.v1.json',
            'mutation owner catalog'
        );
    }
    catch (error)
    {
        errors.push(`input load failure: ${error.message}`);
        return { receipt: null, errors, canonicalCommand: canonicalProducerCommand(options) };
    }

    // 2. Load current-run test plan and #2186 behavior-test evidence.
    const planResult = loadTestPlan(options.testPlan, { repositoryRoot });
    errors.push(...planResult.errors.map((entry) => `test plan: ${entry}`));
    const plan = planResult.plan;
    const testPlanDigest = planResult.testPlanDigest;

    let behaviorTestEvidence;
    if (errors.length === 0)
    {
        const loaded = loadBehaviorTestEvidence(repositoryRoot, options.behaviorTestEvidence, {
            sourceCommit: options.sourceCommit,
            worktreeFingerprint: options.worktreeFingerprint,
            testPlanDigest,
            runId: options.runId
        });
        behaviorTestEvidence = loaded.receipt;
        errors.push(...loaded.errors.map((entry) => `behavior-test evidence: ${entry}`));
    }

    // 3. Derive the exact C# implementation-owner mutation closure and build
    // the selection (release scope never omits a required behavior).
    const ownerClosureResult = deriveBehaviorMutationOwners({
        behaviorCatalog,
        factExtractorRegistry,
        ownerCatalog,
        repositoryRoot,
        worktreeDigest: options.worktreeFingerprint
    });
    if (ownerClosureResult.errors.length > 0)
    {
        errors.push(
            'implementation-owner closure failure: '
            + ownerClosureResult.errors.join('; ')
        );
    }
    const implementationOwnerClosure = ownerClosureResult.closure;
    let selection = null;
    try
    {
        const common = {
            toolPolicy,
            rawToolPolicy,
            sourceState: {
                commit: options.sourceCommit,
                worktreeFingerprint: options.worktreeFingerprint
            },
            ownerReceipt,
            implementationOwnerClosure,
            behaviorCatalog,
            testBindingScan,
            rawTestBindingScan
        };
        selection = options.scope === 'release'
            ? selectRequiredBehaviorMutations(common)
            : selectChangedCriticalMutation({
                ...common,
                changedPaths: readChangedPaths(path.resolve(repositoryRoot, options.changedPaths))
            });
    }
    catch (error)
    {
        errors.push(`selection failure: ${error.message}`);
        selection = null;
    }

    if (errors.length > 0)
    {
        return { receipt: null, errors: [...new Set(errors)].sort(), canonicalCommand: canonicalProducerCommand(options) };
    }

    // PR scope with a truly unrelated closure is allowed to be empty; release
    // scope must always run the full required closure.
    if (selection.status === 'empty')
    {
        if (options.scope === 'release')
        {
            return {
                receipt: null,
                errors: ['release mutation scope produced an empty selection; required behaviors are missing'],
                canonicalCommand: canonicalProducerCommand(options)
            };
        }
        writeJsonAtomic(selectionPath, selection);
        writeJsonAtomic(runPath, {
            schema: 'fsusblog.changed-critical-mutation-run.v1',
            status: 'empty',
            closureDigest: selection.closureDigest,
            strykerStarted: false
        });
        return {
            receipt: null,
            empty: true,
            selectionPath: repoRelative(repositoryRoot, selectionPath),
            runPath: repoRelative(repositoryRoot, runPath),
            errors: [],
            canonicalCommand: canonicalProducerCommand(options)
        };
    }

    writeJsonAtomic(selectionPath, selection);
    const rawSelection = fs.readFileSync(selectionPath);

    // 4. Physical Stryker execution (current-run, clean source/worktree/build).
    // `physicalRunner` is an API-only injection seam used by focused tests so
    // the full producer chain (selection -> authority -> attribution ->
    // qualification -> receipt) can be exercised without a Stryker physical
    // run; production callers always use the canonical Stryker runner.
    const physical = (options.physicalRunner ?? runChangedCriticalPhysicalMutations)({
        selection,
        toolPolicy,
        runDirectory,
        root: repositoryRoot
    });
    if (physical.status !== 0)
    {
        errors.push(`Stryker physical run failed with exit code ${physical.status}`);
        return {
            receipt: null,
            errors,
            canonicalCommand: canonicalProducerCommand(options),
            selectionPath: repoRelative(repositoryRoot, selectionPath)
        };
    }
    writeJsonAtomic(runPath, {
        schema: 'fsusblog.changed-critical-mutation-run.v1',
        status: 'completed',
        closureDigest: selection.closureDigest,
        strykerStarted: true
    });

    // 5. Build run authority (binds raw report/trace/config and current identity).
    const authorityRuns = physical.physicalRuns.map((physicalRun) =>
    {
        const rawConfig = fs.readFileSync(physicalRun.configPath);
        const rawReport = fs.readFileSync(physicalRun.reportPath);
        const rawTrace = fs.readFileSync(physicalRun.tracePath);
        return {
            runKey: physicalRun.runKey,
            behaviors: physicalRun.behaviors,
            sourceProject: physicalRun.sourceProject,
            config: physicalRun.config,
            rawConfig,
            report: JSON.parse(rawReport),
            rawReport,
            reportAbsolutePath: physicalRun.reportPath,
            rawTrace,
            paths: {
                config: repoRelative(repositoryRoot, physicalRun.configPath),
                report: repoRelative(repositoryRoot, physicalRun.reportPath),
                trace: repoRelative(repositoryRoot, physicalRun.tracePath)
            }
        };
    });
    writeJsonAtomic(runManifestPath, {
        schema: 'fsusblog.changed-critical-mutation-run-manifest.v2',
        runs: authorityRuns.map((physicalRun) => ({
            runKey: physicalRun.runKey,
            behaviors: physicalRun.behaviors,
            sourceProject: physicalRun.sourceProject,
            config: physicalRun.paths.config,
            report: physicalRun.paths.report,
            trace: physicalRun.paths.trace
        }))
    });
    let authority;
    try
    {
        authority = createChangedCriticalMutationAuthority({
            selection,
            rawSelection,
            catalog: toolPolicy,
            rawCatalog: rawToolPolicy,
            runs: authorityRuns,
            selectionPath: repoRelative(repositoryRoot, selectionPath),
            runId: options.runId,
            generatedAt: new Date().toISOString(),
            repositoryRoot
        });
    }
    catch (error)
    {
        errors.push(`mutation authority failure: ${error.message}`);
        return {
            receipt: null,
            errors,
            canonicalCommand: canonicalProducerCommand(options),
            selectionPath: repoRelative(repositoryRoot, selectionPath)
        };
    }
    writeJsonAtomic(authorityPath, authority);

    // 6. Attribute mutants to behaviors and attach expected test contracts.
    const attributionOwners = {
        ...ownerReceipt,
        bindings: [
            ...(ownerReceipt?.bindings ?? []),
            ...(implementationOwnerClosure?.bindings ?? [])
        ]
    };
    const attributed = authorityRuns.map((physicalRun) => attributeMutantsToBehaviors({
        report: physicalRun.report,
        sourceProject: physicalRun.sourceProject,
        ownerReceipt: attributionOwners,
        selection
    }));
    const attributions = attachExpectedTestEvidence({
        attributions: attributed.flatMap(({ attributions: entries }) => entries),
        selection
    });
    const blocked = attributed.flatMap(({ blocked: entries }) => entries);

    // 7. Clean-test identity map from the #2186 receipt (raw → canonical).
    const bindingByTestId = new Map();
    for (const binding of testBindingScan.bindings)
    {
        if (!bindingByTestId.has(binding.canonicalTestId))
        {
            bindingByTestId.set(binding.canonicalTestId, binding);
        }
    }
    const bindingByTestIdObject = Object.fromEntries(bindingByTestId);
    const testIdentityByRawId = Object.fromEntries(
        (authority.testIdentities ?? []).map((entry) => [entry.rawTestId, entry.fullyQualifiedName])
    );
    const cleanCanonical = cleanCanonicalTestIds(behaviorTestEvidence);
    const cleanTestIdsByBehavior = {};
    for (const behavior of selection.behaviors)
    {
        cleanTestIdsByBehavior[behavior.behaviorId] = (behavior.testBindings ?? [])
            .map((binding) => binding.canonicalTestId)
            .filter((testId) => cleanCanonical.has(testId));
    }

    // 8. Per-behavior qualification with exact required mutants.
    const expectedByBehavior = expectedAttributionMutantIdsByBehavior(selection, authority);
    const qualification = qualifyBehaviorMutations({
        attributions,
        blocked,
        behaviorCatalog,
        behaviorIds: selection.behaviors.map(({ behaviorId }) => behaviorId),
        qualificationOptions: {
            expectedMutantIdsByBehavior: expectedByBehavior,
            cleanTestIdsByBehavior,
            bindingByTestId: bindingByTestIdObject,
            testIdentityByRawId
        }
    });

    const failureReasons = [
        ...blocked.map((entry) => `${entry.mutantId} attribution blocked: ${entry.reason}`),
        ...qualification.qualifications.flatMap((entry) => entry.failures)
    ].sort();
    if (qualification.qualifications.length !== selection.behaviors.length)
    {
        failureReasons.push(
            `required behavior qualification count mismatch: expected ${selection.behaviors.length}, got ${qualification.qualifications.length}`
        );
    }
    const attemptId = options.attemptId ?? 'attempt-0001';
    const mutationEvidence = sealMutationEvidenceReceipt({
        sourceCommit: selection.sourceState.commit,
        worktreeFingerprint: selection.sourceState.worktreeFingerprint,
        catalogDigest: selection.behaviorCatalogDigest,
        selectionDigest: selection.closureDigest,
        ownerReceiptDigest: selection.ownerReceiptDigest,
        testBindingScanDigest: selection.testBindingScanDigest,
        rawReportDigest: authority.rawReportDigest,
        rawTraceDigest: authority.rawTraceDigest,
        attributions: attributions.map((entry) =>
        {
            const physicalRun = authorityRuns.find((run) => entry.sourcePath.startsWith(`${run.sourceProject}/`));
            return {
                ...entry,
                rawResult: physicalRun
                    ? {
                        project: physicalRun.sourceProject,
                        report: physicalRun.paths.report,
                        trace: physicalRun.paths.trace
                    }
                    : null,
                attempt: attemptId,
                provenance: options.runId
            };
        }),
        qualifications: qualification.qualifications,
        blockedCount: blocked.length,
        status: qualification.failed ? 'failed' : 'ok',
        failureReasons,
        runId: options.runId,
        attemptId,
        scope: options.scope,
        testPlanDigest,
        behaviorTestEvidenceDigest: behaviorTestEvidence?.contentDigest ?? null,
        implementationOwnerClosureDigest: selection.implementationOwnerClosureDigest ?? null
    });
    writeJsonAtomic(receiptPath, mutationEvidence);

    return {
        receipt: mutationEvidence,
        selectionPath: repoRelative(repositoryRoot, selectionPath),
        authorityPath: repoRelative(repositoryRoot, authorityPath),
        receiptPath: repoRelative(repositoryRoot, receiptPath),
        errors,
        canonicalCommand: canonicalProducerCommand(options)
    };
}

// CLI entry point — only runs when invoked directly, not when imported.
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
        const result = produceBehaviorMutationQualification(options);
        if (result.errors.length > 0 || !result.receipt)
        {
            console.error('[produce-behavior-mutation-qualification] FAILED');
            console.error(`  canonical command: ${result.canonicalCommand}`);
            for (const error of result.errors)
            {
                console.error(`  ${error}`);
            }
            process.exitCode = 1;
        }
        else if (result.empty)
        {
            console.log('[produce-behavior-mutation-qualification] empty closure (unrelated PR change)');
            console.log(`  selection=${result.selectionPath}`);
        }
        else
        {
            console.log(
                `[produce-behavior-mutation-qualification] ok scope=${options.scope} `
                + `closure=${result.receipt.selectionDigest} `
                + `behaviors=${result.receipt.qualifications.length} `
                + `receipt=${result.receiptPath}`
            );
        }
    }
    catch (error)
    {
        console.error(`[produce-behavior-mutation-qualification] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    }
}

export { produceBehaviorMutationQualification };
