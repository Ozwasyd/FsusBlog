#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { root, loadCatalog, catalogRelative } from '../contracts/behavior-contract-catalog.mjs';
import {
    canonicalObservationTestId,
    joinBehaviorTestEvidence,
    resolveWorktreeDigest,
    scanBehaviorTestBindings,
    validateExactBehaviorCoverage,
    evidenceReceiptSchema
} from '../contracts/behavior-test-binding.mjs';
import { canonicalize } from '../test-observations/source-identity.mjs';
import { observationArtifactSchema, validateObservationArtifact } from '../test-observations/validation.mjs';

export const produceBehaviorTestEvidenceTierId = 'produce-behavior-test-evidence';
export const produceBehaviorTestEvidenceReceiptSchema = evidenceReceiptSchema;
export const produceBehaviorTestEvidenceCommand =
    'node tools/test-matrix/produce-behavior-test-evidence.mjs';
export const produceBehaviorTestEvidenceReceiptPath =
    '.tmp/behavior-test-evidence/receipt.json';
export const testPlanSchema = 'fsusblog.release-evidence.test-plan.v1';

const defaultOutDir = '.tmp/behavior-test-evidence';

const historicalRawResultPattern = /(?:^|[\\/])TestResults[\\/]|(?:^|[\\/])latest[\\/]|\.trx(?:\.json)?$/iu;

function sha256(data)
{
    return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export function normalizeSha256Digest(value, label = 'digest')
{
    const digest = String(value ?? '');
    if (/^sha256:[a-f0-9]{64}$/u.test(digest))
    {
        return digest;
    }
    if (/^[a-f0-9]{64}$/u.test(digest))
    {
        return `sha256:${digest}`;
    }
    throw new Error(`${label} must be a sha256 digest`);
}


export function isHistoricalRawResultPath(observationPath)
{
    return historicalRawResultPattern.test(observationPath);
}

function canonicalProducerCommand(options)
{
    const args = [produceBehaviorTestEvidenceCommand];
    for (const observation of options.observations)
    {
        args.push('--observations', observation);
    }
    if (options.plan)
    {
        args.push('--plan', options.plan);
    }
    if (options.out)
    {
        args.push('--out', options.out);
    }
    if (options.evidenceRoot)
    {
        args.push('--evidence-root', options.evidenceRoot);
    }
    if (options.expectedSourceCommit)
    {
        args.push('--source-commit', options.expectedSourceCommit);
    }
    if (options.expectedWorktreeFingerprint)
    {
        args.push('--worktree-fingerprint', options.expectedWorktreeFingerprint);
    }
    if (options.expectedClosureDigest)
    {
        args.push('--closure-digest', options.expectedClosureDigest);
    }
    if (options.staticAdmissionReceipt)
    {
        args.push('--static-admission-receipt', options.staticAdmissionReceipt);
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
        observations: [],
        plan: null,
        out: path.join(root, defaultOutDir, 'receipt.json'),
        evidenceRoot: null,
        expectedSourceCommit: null,
        expectedWorktreeFingerprint: null,
        expectedClosureDigest: null,
        staticAdmissionReceipt: null,
        help: false,
        repositoryRoot: root
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--observations')
        {
            options.observations.push(argv[++index] ?? '');
        }
        else if (argument === '--plan')
        {
            options.plan = argv[++index] ?? null;
        }
        else if (argument === '--out')
        {
            options.out = argv[++index] ?? options.out;
        }
        else if (argument === '--evidence-root')
        {
            options.evidenceRoot = argv[++index] ?? null;
        }
        else if (argument === '--source-commit')
        {
            options.expectedSourceCommit = argv[++index] ?? null;
        }
        else if (argument === '--worktree-fingerprint')
        {
            options.expectedWorktreeFingerprint = argv[++index] ?? null;
        }
        else if (argument === '--closure-digest')
        {
            options.expectedClosureDigest = argv[++index] ?? null;
        }
        else if (argument === '--static-admission-receipt')
        {
            options.staticAdmissionReceipt = argv[++index] ?? null;
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
    console.log(`Usage: node tools/test-matrix/produce-behavior-test-evidence.mjs [options]

Produces a behavior-test-evidence receipt from current-run observation artifacts
and formal source bindings (#2185). Validates same-source/worktree/build/catalog/run
identity across all inputs and fails closed on any mismatch.

Options:
  --observations <path>        Observation artifact file (repeatable; required)
  --plan <path>                Current-run test plan receipt (release-evidence test-plan v1; required)
  --out <path>                 Receipt output path (default: .tmp/behavior-test-evidence/receipt.json)
  --evidence-root <path>       Root for producer report digest verification
  --source-commit <sha>        Expected Git commit SHA (40 hex chars)
  --worktree-fingerprint <fp>  Expected worktree fingerprint
  --closure-digest <digest>    Expected source closure digest
  --repository-root <path>      Repository root for fixture/testing
  --static-admission-receipt <path>  Path to #1752 static admission receipt
`);
}

/**
 * Load and validate the explicit current-run test plan receipt. The plan is
 * the authority for which bound test files were planned this round; missing or
 * mismatched plans fail closed instead of silently skipping exact-match.
 */
export function loadTestPlan(planPath, { repositoryRoot = root } = {})
{
    const errors = [];
    if (!planPath)
    {
        return {
            plan: null,
            planPath: null,
            testPlanDigest: null,
            errors: ['test plan input is required (--plan <path>); executed-set exact-match cannot be verified without a current-run test plan']
        };
    }
    const absolute = path.resolve(repositoryRoot, planPath);
    if (!fs.existsSync(absolute))
    {
        return { plan: null, planPath: absolute, testPlanDigest: null, errors: [`test plan not found: ${planPath}`] };
    }
    let plan;
    let raw;
    try
    {
        raw = fs.readFileSync(absolute, 'utf8');
        plan = JSON.parse(raw);
    }
    catch (err)
    {
        return { plan: null, planPath: absolute, testPlanDigest: null, errors: [`test plan is not valid JSON: ${err.message}`] };
    }
    if (plan?.schema !== testPlanSchema)
    {
        errors.push(`test plan schema mismatch: expected ${testPlanSchema}, got ${plan?.schema ?? '<missing>'}`);
    }
    if (!/^[a-f0-9]{40}$/u.test(String(plan?.commit ?? '')))
    {
        errors.push('test plan commit must be a full lowercase commit SHA');
    }
    if (!Array.isArray(plan?.tiers) || plan.tiers.length === 0)
    {
        errors.push('test plan tiers must be a non-empty array');
    }
    const seenTierIds = new Set();
    for (const [index, tier] of (Array.isArray(plan?.tiers) ? plan.tiers : []).entries())
    {
        const label = tier && typeof tier === 'object' && typeof tier.id === 'string' && tier.id
            ? tier.id
            : `<tier[${index}]>`;
        if (!tier || typeof tier !== 'object' || typeof tier.id !== 'string' || !tier.id)
        {
            errors.push(`test plan tier ${label} requires a non-empty id`);
        }
        else if (seenTierIds.has(tier.id))
        {
            errors.push(`test plan tier id is duplicated: ${tier.id}`);
        }
        else
        {
            seenTierIds.add(tier.id);
        }
        if (!Array.isArray(tier?.evidence))
        {
            errors.push(`test plan tier ${label} evidence must be an array`);
        }
        else
        {
            for (const [entryIndex, entry] of tier.evidence.entries())
            {
                if (typeof entry !== 'string' || entry.trim() === '')
                {
                    errors.push(`test plan tier ${label} evidence[${entryIndex}] must be a non-empty string`);
                }
            }
        }
    }
    return { plan, planPath: absolute, testPlanDigest: sha256(raw), errors };
}

/**
 * Derive the bound-test closure from the test plan: a binding is planned when
 * its source file appears in any plan tier's evidence list. Bound tests whose
 * files the plan omits are reported as unplanned and fail closed.
 */
export function planBoundClosure(plan, scan)
{
    const plannedFiles = new Set();
    if (plan && Array.isArray(plan.tiers))
    {
        for (const tier of plan.tiers)
        {
            for (const entry of tier.evidence ?? [])
            {
                if (typeof entry === 'string' && entry)
                {
                    plannedFiles.add(String(entry).replaceAll('\\', '/'));
                }
            }
        }
    }
    const plannedTestIds = new Set();
    const unplannedBoundTestIds = [];
    for (const binding of scan.bindings)
    {
        if (plannedFiles.has(binding.sourcePath))
        {
            plannedTestIds.add(binding.canonicalTestId);
        }
        else
        {
            unplannedBoundTestIds.push(binding.canonicalTestId);
        }
    }
    unplannedBoundTestIds.sort((left, right) => left.localeCompare(right));
    return { plannedFiles, plannedTestIds, unplannedBoundTestIds };
}

function observedSourceFile(testId)
{
    const match = /^(node-tap|vitest|playwright):(.+)$/u.exec(String(testId ?? ''));
    return match ? match[2].split('#')[0] : null;
}

function xunitClassMatchesPlannedFile(testId, plannedFiles)
{
    const match = /^xunit-trx:([^#]+)#/u.exec(String(testId ?? ''));
    if (!match)
    {
        return false;
    }
    const className = match[1];
    return [...plannedFiles].some((file) =>
    {
        if (!/\.cs$/u.test(file))
        {
            return false;
        }
        return file.split('/').at(-1).replace(/\.cs$/u, '') === className;
    });
}

export function extraExecutedTestIdsFor(executedTestIds, plannedTestIds, plannedFiles)
{
    const extra = [];
    for (const testId of executedTestIds)
    {
        if (plannedTestIds.has(canonicalObservationTestId(testId)))
        {
            continue;
        }
        const sourceFile = observedSourceFile(testId);
        if (sourceFile && plannedFiles.has(sourceFile))
        {
            continue;
        }
        if (xunitClassMatchesPlannedFile(testId, plannedFiles))
        {
            continue;
        }
        extra.push(testId);
    }
    extra.sort((left, right) => left.localeCompare(right));
    return extra;
}

function loadStaticAdmissionReceipt(filePath)
{
    if (!fs.existsSync(filePath))
    {
        throw new Error(`static admission receipt not found: ${filePath}`);
    }
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (receipt?.schema !== 'fsusblog.behavior-doc-static-admission-receipt.v1')
    {
        throw new Error('static admission receipt schema mismatch');
    }
    return receipt;
}

function produceBehaviorTestEvidence(options)
{
    const errors = [];
    const repositoryRoot = options.repositoryRoot ?? root;

    // 1. Load and validate all observation artifacts.
    const artifacts = [];
    const runIds = new Set();
    const sourceCommits = new Set();
    const worktreeFingerprints = new Set();
    const closureDigests = new Set();

    for (const observationPath of options.observations)
    {
        if (isHistoricalRawResultPath(observationPath))
        {
            errors.push(`historical raw result path cannot satisfy current-run evidence: ${observationPath}`);
            continue;
        }
        if (!fs.existsSync(observationPath))
        {
            errors.push(`observation artifact not found: ${observationPath}`);
            continue;
        }
        const artifact = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
        const validationErrors = validateObservationArtifact(artifact, {
            evidenceRoot: options.evidenceRoot ?? repositoryRoot,
            expectedSourceState: options.expectedSourceCommit
                ? { commit: options.expectedSourceCommit, worktreeFingerprint: options.expectedWorktreeFingerprint ?? '' }
                : null,
            expectedClosureDigest: options.expectedClosureDigest ?? null
        });
        errors.push(...validationErrors);
        if (artifact.schema === observationArtifactSchema)
        {
            artifacts.push(artifact);
            runIds.add(artifact.run?.id);
            sourceCommits.add(artifact.sourceState?.commit);
            worktreeFingerprints.add(artifact.sourceState?.worktreeFingerprint);
            closureDigests.add(artifact.sourceClosureDigest);
        }
    }

    // 2. Fail closed on no artifacts.
    if (artifacts.length === 0)
    {
        errors.push('no valid observation artifacts; cannot produce evidence');
    }

    // 3. Identity checks.
    if (options.expectedSourceCommit && sourceCommits.size > 0)
    {
        const commits = [...sourceCommits];
        if (commits.length > 1)
        {
            errors.push('observation artifacts span multiple source commits');
        }
        else if (commits[0] !== options.expectedSourceCommit)
        {
            errors.push(`source commit mismatch: expected ${options.expectedSourceCommit}, got ${commits[0]}`);
        }
    }

    if (options.expectedWorktreeFingerprint && worktreeFingerprints.size > 0)
    {
        const fingerprints = [...worktreeFingerprints];
        if (fingerprints.length > 1)
        {
            errors.push('observation artifacts span multiple worktree fingerprints');
        }
        else if (fingerprints[0] !== options.expectedWorktreeFingerprint)
        {
            errors.push(`worktree fingerprint mismatch: expected ${options.expectedWorktreeFingerprint}, got ${fingerprints[0]}`);
        }
    }

    if (options.expectedClosureDigest && closureDigests.size > 0)
    {
        const digests = [...closureDigests];
        if (digests.length > 1)
        {
            errors.push('observation artifacts span multiple source closure digests');
        }
        else if (digests[0] !== options.expectedClosureDigest)
        {
            errors.push(`source closure digest mismatch: expected ${options.expectedClosureDigest}, got ${digests[0]}`);
        }
    }

    // 4. Run identity: all artifacts must share the same run.
    if (runIds.size > 1)
    {
        errors.push('observation artifacts span multiple run identities; historical TRX cannot satisfy this round');
    }

    // 5. Scan bindings.
    const catalog = loadCatalog(path.join(repositoryRoot, catalogRelative));
    const worktreeDigest = options.expectedWorktreeFingerprint ?? resolveWorktreeDigest(repositoryRoot);
    const scan = scanBehaviorTestBindings({
        repositoryRoot,
        catalog,
        worktreeDigest
    });

    // 6. Load the explicit current-run test plan and bind the planned closure.
    const planResult = loadTestPlan(options.plan, { repositoryRoot });
    errors.push(...planResult.errors);
    const plan = planResult.plan;
    const testPlanDigest = planResult.testPlanDigest;
    const closure = plan ? planBoundClosure(plan, scan) : {
    plannedFiles: new Set(),
    plannedTestIds: new Set(),
    unplannedBoundTestIds: []
  };
    if (plan && sourceCommits.size > 0)
    {
        const commits = [...sourceCommits];
        if (commits.length === 1 && commits[0] !== plan.commit)
        {
            errors.push(`test plan commit mismatch: plan declares ${plan.commit}, observations are for ${commits[0]}`);
        }
        else if (commits.length > 1 && !commits.includes(plan.commit))
        {
            errors.push(`test plan commit mismatch: plan declares ${plan.commit}, observations span ${commits.join(', ')}`);
        }
    }
    if (plan && options.expectedSourceCommit && plan.commit !== options.expectedSourceCommit)
    {
        errors.push(`test plan commit mismatch: expected ${options.expectedSourceCommit}, got ${plan.commit}`);
    }
    if (closure.unplannedBoundTestIds.length > 0)
    {
        errors.push(`bound test(s) not planned by test plan: ${closure.unplannedBoundTestIds.join(', ')}`);
    }

    // 7. Verify no skipped/blocked/diagnostic observations satisfy evidence.
    const observedTestIds = new Set();
    for (const artifact of artifacts)
    {
        for (const observation of artifact.observations)
        {
            if (observedTestIds.has(observation.testId))
            {
                errors.push(`duplicate testId in observation artifacts: ${observation.testId}`);
            }
            observedTestIds.add(observation.testId);

            if (observation.outcome === 'skipped')
            {
                errors.push(`${observation.testId} was skipped and cannot satisfy behavior evidence`);
            }
            if (observation.outcome === 'blocked')
            {
                errors.push(`${observation.testId} was blocked and cannot satisfy behavior evidence`);
            }
            if (observation.run?.attemptKind === 'retry')
            {
                errors.push(`${observation.testId} is a retry attempt and cannot satisfy clean behavior evidence`);
            }
            if (observation.run?.attemptKind === 'diagnostic')
            {
                errors.push(`${observation.testId} is diagnostic and cannot satisfy behavior evidence`);
            }
        }
    }

    // 8. Join evidence using existing authority.
    let receipt;
    try
    {
        receipt = joinBehaviorTestEvidence({
            repositoryRoot,
            catalog,
            bindingsScan: scan,
            observations: options.observations.map((p) => path.resolve(p)),
            evidenceRoot: options.evidenceRoot ?? repositoryRoot,
            worktreeDigest
        });
    }
    catch (err)
    {
        errors.push(`joinBehaviorTestEvidence failed: ${err.message}`);
        return { receipt: null, errors: [...new Set(errors)].sort((a, b) => a.localeCompare(b)) };
    }

    // 9. Validate exact coverage (fail-closed).
    try
    {
        validateExactBehaviorCoverage(receipt);
    }
    catch (err)
    {
        errors.push(err.message);
    }

    // 10. Reject retry/diagnostic evidence for primary requirements.
    for (const entry of receipt.evidence)
    {
        if (entry.run?.attemptKind === 'retry')
        {
            errors.push(`${entry.canonicalTestId} retry evidence cannot substitute for primary run evidence`);
        }
        if (entry.run?.attemptKind === 'diagnostic')
        {
            errors.push(`${entry.canonicalTestId} diagnostic evidence cannot satisfy behavior requirement`);
        }
    }

    // 11. Verify observation-bindings cross-coverage.
    for (const contract of catalog.contracts)
    {
        if (contract.status !== 'active')
        {
            continue;
        }
        const bound = scan.bindings.filter((b) => b.behaviorId === contract.id);
        for (const binding of bound)
        {
            const covered = receipt.evidence.some(
                (e) => e.canonicalTestId === binding.canonicalTestId && e.executed === true
            );
            if (!covered)
            {
                errors.push(`${contract.id}: bound test ${binding.canonicalTestId} not covered by this round's observations`);
            }
        }
    }

    // 12. Exact-match the executed set against the planned bound closure.
    const extraExecutedTestIds = extraExecutedTestIdsFor(
        [...observedTestIds],
        closure.plannedTestIds,
        closure.plannedFiles
    );
    if (extraExecutedTestIds.length > 0)
    {
        errors.push(`extra executed test(s) beyond plan closure: ${extraExecutedTestIds.join(', ')}`);
    }

    // 13. Attach #1752 static admission identity if provided.
    if (options.staticAdmissionReceipt)
    {
        try
        {
            const staticReceipt = loadStaticAdmissionReceipt(options.staticAdmissionReceipt);
            receipt.staticAdmissionDigest = normalizeSha256Digest(
                staticReceipt.contentDigest,
                'static admission contentDigest'
            );
            receipt.staticAdmissionStatus = staticReceipt.status ?? 'missing';
        }
        catch (err)
        {
            errors.push(`static admission receipt error: ${err.message}`);
        }
    }

    // 14. Attach test plan identity and closure fields to the receipt.
    receipt.testPlanDigest = testPlanDigest;
    receipt.testPlanCommit = plan?.commit ?? null;
    receipt.plannedTestIds = [...closure.plannedTestIds].sort((a, b) => a.localeCompare(b));
    receipt.unplannedBoundTestIds = closure.unplannedBoundTestIds;
    receipt.extraExecutedTestIds = extraExecutedTestIds;

    // 15. Finalize.
    receipt.runtimeCandidateSpawnCountBeforeReceipt = 0;
    receipt.producer = {
        command: produceBehaviorTestEvidenceCommand,
        schema: produceBehaviorTestEvidenceReceiptSchema
    };
    receipt.contentDigest = (() =>
    {
        const copy = structuredClone(receipt);
        delete copy.contentDigest;
        return sha256(JSON.stringify(canonicalize(copy)));
    })();

    return { receipt, errors: [...new Set(errors)].sort((a, b) => a.localeCompare(b)) };
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
        if (options.observations.length === 0)
        {
            console.error('[produce-behavior-test-evidence] --observations is required (at least one observation artifact)');
            process.exit(2);
        }
        if (!options.plan)
        {
            console.error('[produce-behavior-test-evidence] --plan is required (release-evidence test-plan v1); a missing plan must fail closed, never silently skip exact-match');
            process.exit(2);
        }

        const { receipt, errors } = produceBehaviorTestEvidence(options);

        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(receipt, null, 2)}\n`);

        if (errors.length > 0)
        {
            console.error('[produce-behavior-test-evidence] FAILED');
            console.error(`  canonical command: ${canonicalProducerCommand(options)}`);
            for (const error of errors)
            {
                console.error(`  ${error}`);
            }
            process.exitCode = 1;
        }
        else
        {
            console.log(`[produce-behavior-test-evidence] ok receipt=${options.out} behaviors=${receipt.coverage?.length ?? 0}`);
        }
    }
    catch (error)
    {
        console.error(`[produce-behavior-test-evidence] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    }
}

export { produceBehaviorTestEvidence };
