#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {digestCatalog, loadCatalog, root, validateBehaviorReferences, validateCatalog} = await import(new URL('../contracts/behavior-contract-catalog.mjs', import.meta.url));
const {sealDocClaimVerificationReceipt, sealGeneratedSectionCheckReceipt, sealOwnerBindingReceipt} = await import(new URL('../contracts/behavior-graph-join.mjs', import.meta.url));
const {formatOwnerBindingReport, scanBehaviorOwnerBindings} = await import(new URL('../contracts/behavior-owner-binding.mjs', import.meta.url));
const {scanRepositoryFactExtractorGovernance} = await import(new URL('../fact-extractors/governance.mjs', import.meta.url));
const {digestPath, digestValue, sealSourceIdentity} = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const {semanticDigestFromReceipt} = await import(new URL('../fact-extractors/receipt.mjs', import.meta.url));
const {loadRegistry, validateOwnershipAgainstBehaviorCatalog, validateRegistry} = await import(new URL('../fact-extractors/registry.mjs', import.meta.url));
const {runExtractor} = await import(new URL('../fact-extractors/runner.mjs', import.meta.url));
import { validateMinimalContractBuildReceipt } from './behavior-doc-minimal-contract-build-v3-contract.mjs';
import {
    runMinimalContractBuild
} from './behavior-doc-minimal-contract-build.mjs';
import {
    behaviorDocAdmissionReceiptSchema,
    defaultBehaviorDocAdmissionComponentsDirectory,
    defaultBehaviorDocAdmissionReceipt,
    behaviorDocGlobalClaimExactnessComponent
} from './behavior-doc-static-admission-contract.mjs';
export {
    behaviorDocAdmissionReceiptSchema,
    defaultBehaviorDocAdmissionComponentsDirectory,
    defaultBehaviorDocAdmissionReceipt,
    behaviorDocGlobalClaimExactnessComponent
} from './behavior-doc-static-admission-contract.mjs';
import { readBehaviorDocStaticAdmissionReceipt, validateBehaviorDocStaticAdmissionReceipt } from './behavior-doc-static-admission-reader.mjs';
import { validateRepositoryMigrationLedger } from './check-document-claim-migration-ledger.mjs';
import {
    formatGovernanceViolations as formatMutationGovernanceViolations,
    runStalenessMutationGovernance
} from './doc-claim-staleness-mutation/governance.mjs';
import {
    assertCaseResult,
    runAllMutationCases
} from './doc-claim-staleness-mutation/runner.mjs';
import {
    assertNoClaimSchemaDuplication,
    loadDocClaimSchema,
    parseRepositoryClaims,
    scanDocClaimGovernance,
    validateDocClaimSchemaContract
} from './doc-claim.mjs';
import {
    loadCatalog as loadGeneratedSectionCatalog
} from './generated-fact-sections/catalog.mjs';
import {
    indexReceiptsByExtractor,
    processGeneratedFactSections
} from './generated-fact-sections/generator.mjs';
import {
    formatGovernanceViolations as formatGeneratedGovernanceViolations,
    scanGeneratedFactSectionGovernance
} from './generated-fact-sections/governance.mjs';
import { globalExactnessScopeId, validateGlobalClaimExactnessReceipt } from './global-claim-exactness-final.mjs';
import {
    formatGovernanceViolations as formatProseGovernanceViolations,
    scanProseClaimGovernance
} from './prose-claim-verifier/governance.mjs';
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs';


export const behaviorDocAdmissionTierId = 'behavior-doc-static-admission';
const directFile = fileURLToPath(import.meta.url);
function seal(value)
{
    const receipt = { ...value, contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

function dotnetVersion(repositoryRoot)
{
    const result = spawnSync('dotnet', ['--version'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000
    });
    if (result.status !== 0)
    {
        const reason = result.error?.code === 'ETIMEDOUT'
            ? 'probe timed out'
            : String(result.stderr ?? '').trim() || `exit ${result.status}`;
        throw new Error(`dotnet toolchain is unavailable: ${reason}`);
    }
    return String(result.stdout).trim();
}

function authorityDigests(repositoryRoot, catalog, claimReceipt)
{
    return {
        catalog: digestCatalog(catalog),
        claim: claimReceipt.contentDigest,
        extractorRegistry: digestPath(
            repositoryRoot,
            'config/contracts/behavior-fact-extractors.json'
        ),
        generatedSectionCatalog: digestPath(
            repositoryRoot,
            'config/contracts/generated-fact-sections.json'
        ),
        generatedRenderer: digestPath(
            repositoryRoot,
            'tools/docs/generated-fact-sections/renderers.mjs'
        ),
        proseRenderer: digestPath(
            repositoryRoot,
            'tools/docs/prose-claim-verifier/renderers.mjs'
        ),
        mutationCatalog: digestPath(
            repositoryRoot,
            'tools/docs/doc-claim-staleness-mutation/catalog.mjs'
        )
    };
}

export {
    readBehaviorDocStaticAdmissionReceipt,
    validateBehaviorDocStaticAdmissionReceipt
} from './behavior-doc-static-admission-reader.mjs';

function writeReceipt(file, receipt)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

export function writeFactObservationReceipts(componentsDirectory, observationReceipts)
{
    for (const observationReceipt of observationReceipts)
    {
        writeReceipt(
            path.join(
                componentsDirectory,
                'fact-observations',
                `${observationReceipt.extractorId}.json`
            ),
            observationReceipt
        );
    }
}

function invalidateOwnedGlobalClaimTerminal(componentsDirectory, runId)
{
    const directory = path.resolve(componentsDirectory);
    const terminal = path.join(directory, behaviorDocGlobalClaimExactnessComponent);
    const file = fs.lstatSync(terminal, { throwIfNoEntry: false, bigint: true });
    if (!file)
    {
        return;
    }
    const parent = fs.lstatSync(directory, { bigint: true });
    const uid = BigInt(process.getuid());
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n
        || file.uid !== uid || !parent.isDirectory() || parent.uid !== uid
        || (parent.mode & 0o022n) !== 0n || fs.realpathSync(directory) !== directory
        || file.size < 1n || file.size > 8388608n)
    {
        throw new Error('global claim terminal is not the current owned regular output');
    }
    const epoch = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    const sameEpoch = (first, second) => epoch.every((field) => first[field] === second[field]);
    const descriptor = fs.openSync(terminal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const held = fs.fstatSync(descriptor, { bigint: true });
        if (!held.isFile() || !sameEpoch(held, file))
        {
            throw new Error('global claim terminal changed before owned invalidation');
        }
        const bytes = Buffer.alloc(Number(held.size));
        let offset = 0;
        while (offset < bytes.length)
        {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
            {
                throw new Error('global claim terminal changed during bounded invalidation read');
            }
            offset += count;
        }
        if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0)
        {
            throw new Error('global claim terminal grew during bounded invalidation read');
        }
        const receipt = JSON.parse(bytes.toString('utf8'));
        validateGlobalClaimExactnessReceipt(receipt, { expectedRunId: String(runId) });
        if (receipt.scopeId !== globalExactnessScopeId)
        {
            throw new Error('global claim terminal is not the original task output family');
        }
        if (BigInt(bytes.length) !== held.size
            || !sameEpoch(held, fs.fstatSync(descriptor, { bigint: true }))
            || !sameEpoch(held, fs.lstatSync(terminal, { bigint: true }))
            || !sameEpoch(parent, fs.lstatSync(directory, { bigint: true })))
        {
            throw new Error('global claim terminal changed before owned invalidation');
        }
        fs.unlinkSync(terminal);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

export async function runBehaviorDocStaticAdmission({
    repositoryRoot = root,
    runId = process.env.FSUSBLOG_TEST_RUN_ID || `local-${process.pid}`,
    outputFile = path.join(repositoryRoot, defaultBehaviorDocAdmissionReceipt),
    componentsDirectory = path.join(
        repositoryRoot,
        defaultBehaviorDocAdmissionComponentsDirectory
    ),
    candidateSpawnCountBeforeReceipt = 0
} = {})
{
    const directory = path.resolve(componentsDirectory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid()
        || (parent.mode & 0o022) !== 0 || fs.realpathSync(directory) !== directory)
    {
        throw new Error('BehaviorDoc admission output reservation requires its private task-owned directory');
    }
    const lock = path.join(directory, '.behavior-doc-admission-writer.lock');
    const descriptor = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let held;
    try
    {
        held = fs.fstatSync(descriptor, { bigint: true });
    }
    catch (error)
    {
        fs.closeSync(descriptor);
        throw error;
    }
    let result;
    let failure;
    let failed = false;
    try
    {
        result = await runReservedBehaviorDocStaticAdmission({ repositoryRoot, runId, outputFile, componentsDirectory, candidateSpawnCountBeforeReceipt });
    }
    catch (error)
    {
        failure = error;
        failed = true;
    }
    try
    {
        try
        {
            const current = fs.lstatSync(lock, { bigint: true });
            if (!current.isFile() || current.nlink !== 1n
                || !['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((field) => current[field] === held[field]))
            {
                throw new Error('BehaviorDoc admission output reservation changed');
            }
            fs.unlinkSync(lock);
        }
        finally
        {
            fs.closeSync(descriptor);
        }
    }
    catch (error)
    {
        if (!failed)
        {
            failure = error;
            failed = true;
        }
        else
        {
            failure = new AggregateError([failure, error], 'BehaviorDoc admission failed with unresolved output reservation', { cause: failure });
        }
    }
    if (failed)
    {
        throw failure;
    }
    return result;
}

async function runReservedBehaviorDocStaticAdmission({
    repositoryRoot = root,
    runId = process.env.FSUSBLOG_TEST_RUN_ID || `local-${process.pid}`,
    outputFile = path.join(repositoryRoot, defaultBehaviorDocAdmissionReceipt),
    componentsDirectory = path.join(
        repositoryRoot,
        defaultBehaviorDocAdmissionComponentsDirectory
    ),
    candidateSpawnCountBeforeReceipt = 0
} = {})
{
    invalidateOwnedGlobalClaimTerminal(componentsDirectory, runId);
    const startedAt = Date.now();
    const sourceIdentity = sealSourceIdentity(repositoryRoot);
    const toolchain = {
        node: process.version,
        dotnet: 'unavailable',
        platform: process.platform,
        architecture: process.arch,
        directoryBuildPropsDigest: digestPath(repositoryRoot, 'Directory.Build.props')
    };
    const base = {
        schema: behaviorDocAdmissionReceiptSchema,
        run: { id: String(runId) },
        source: {
            commit: sourceIdentity.sourceCommit,
            worktreeFingerprint: sourceIdentity.worktreeFingerprint
        },
        worktree: { root: path.resolve(repositoryRoot) },
        toolchain,
        authorityDigests: {},
        implementationOwner: { status: 'failed', bindingCount: 0, contentDigest: null },
        factObservations: {},
        minimalContractBuild: null,
        generated: { status: 'failed', contentDigest: null },
        prose: { status: 'failed', contentDigest: null },
        mutationFixtures: { status: 'failed', caseCount: 0, contentDigest: null },
        candidateSpawnCountBeforeReceipt,
        status: 'failed',
        failureReasons: [],
        durationMs: 0
    };

    try
    {
        if (candidateSpawnCountBeforeReceipt !== 0)
        {
            throw new Error('candidate process spawned before BehaviorDoc admission');
        }
        toolchain.dotnet = dotnetVersion(repositoryRoot);
        const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'));
        validateCatalog(catalog, repositoryRoot);
        validateBehaviorReferences(catalog, repositoryRoot);
        const catalogBehaviorIds = new Set(catalog.contracts.map((contract) => contract.id));
        const BehaviorId = (value) =>
        {
            if (!catalogBehaviorIds.has(value))
            {
                throw new Error(`unknown behavior contract: ${value}`);
            }
            return value;
        };

        validateDocClaimSchemaContract(loadDocClaimSchema());
        assertNoClaimSchemaDuplication(repositoryRoot);
        const claimViolations = scanDocClaimGovernance(repositoryRoot);
        if (claimViolations.length > 0)
        {
            throw new Error(`DocClaim governance failed: ${claimViolations[0].message}`);
        }
        const claimReceipt = parseRepositoryClaims(repositoryRoot);
        validateRepositoryMigrationLedger(repositoryRoot);
        base.authorityDigests = authorityDigests(repositoryRoot, catalog, claimReceipt);

        const owner = formatOwnerBindingReport(scanBehaviorOwnerBindings({
            repositoryRoot,
            catalog
        }));
        if (owner.errors.length > 0)
        {
            throw new Error(owner.errors.join('; '));
        }
        const ownerReceipt = sealOwnerBindingReceipt(owner);
        base.implementationOwner = {
            status: owner.status,
            bindingCount: owner.bindingCount,
            contentDigest: ownerReceipt.contentDigest
        };

        const registry = loadRegistry(
            path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json')
        );
        validateRegistry(registry, repositoryRoot);
        validateOwnershipAgainstBehaviorCatalog(registry, catalog, repositoryRoot);
        const extractorGovernance = scanRepositoryFactExtractorGovernance(repositoryRoot);
        if (extractorGovernance.errors.length > 0)
        {
            throw new Error(extractorGovernance.errors.join('; '));
        }

        const minimalBuild = runMinimalContractBuild({
            repositoryRoot,
            runId,
            sourceIdentity
        });
        base.minimalContractBuild = minimalBuild.receipt;

        const observationReceipts = [];
        for (const extractor of registry.extractors)
        {
            const buildIdentity = extractor.requiredBuildArtifact === null
                ? null
                : minimalBuild.buildIdentities[extractor.requiredBuildArtifact];
            const result = await runExtractor({
                extractorId: extractor.id,
                repositoryRoot,
                registry,
                buildIdentity,
                buildReceiptPath: extractor.requiredBuildArtifact === null
                    ? null
                    : minimalBuild.identityReceiptFile,
                minimalBuildReceiptValidator: validateMinimalContractBuildReceipt,
                useCache: false
            });
            if (result.receipt.status !== 'ok')
            {
                throw new Error(`${extractor.id}: ${result.receipt.failureReasons.join('; ')}`);
            }
            observationReceipts.push(result.receipt);
            base.factObservations[extractor.id] = {
                status: result.receipt.status,
                extractorDigest: result.receipt.extractorDigest,
                semanticDigest: semanticDigestFromReceipt(result.receipt),
                contentDigest: result.receipt.contentDigest
            };
        }
        // Preserve successful current-source observations before downstream
        // generated-section admission. A drift failure must retain the exact
        // receipts required by the canonical generator without weakening the
        // admission result or discovering a different/latest observation.
        writeFactObservationReceipts(componentsDirectory, observationReceipts);

        const generatedGovernance = scanGeneratedFactSectionGovernance(repositoryRoot);
        if (generatedGovernance.length > 0)
        {
            throw new Error(formatGeneratedGovernanceViolations(generatedGovernance)[0]);
        }
        const generatedResult = processGeneratedFactSections({
            repositoryRoot,
            mode: 'check',
            receiptsByExtractor: indexReceiptsByExtractor(observationReceipts),
            expectedIdentity: sourceIdentity
        });
        const generatedCatalog = loadGeneratedSectionCatalog(repositoryRoot);
        const factObservationDigests = observationReceipts.map((receipt) => ({
            extractorId: receipt.extractorId,
            contentDigest: receipt.contentDigest
        }));
        const generatedReceipt = sealGeneratedSectionCheckReceipt({
            sourceCommit: sourceIdentity.sourceCommit,
            worktreeFingerprint: sourceIdentity.worktreeFingerprint,
            catalogDigest: digestCatalog(catalog),
            sectionCatalogDigest: base.authorityDigests.generatedSectionCatalog,
            factObservationDigests,
            sections: generatedCatalog.sections.map((section) => ({
                sectionId: section.sectionId,
                behaviorId: BehaviorId(section.behaviorId),
                documentPath: section.documentPath,
                factPath: section.factPath,
                status: 'ok',
                reason: 'generated section matches current fact observation'
            })),
            status: 'ok',
            failureReasons: []
        });
        base.generated = {
            status: generatedResult.status,
            documentCount: generatedResult.documents.length,
            contentDigest: generatedReceipt.contentDigest
        };

        const proseGovernance = scanProseClaimGovernance(repositoryRoot);
        if (proseGovernance.length > 0)
        {
            throw new Error(formatProseGovernanceViolations(proseGovernance)[0]);
        }
        const proseResult = verifyProseClaims({
            claims: claimReceipt.claims,
            receipts: observationReceipts
        });
        if (!proseResult.ok)
        {
            throw new Error(`prose verification failed: ${proseResult.diagnostics[0]?.message}`);
        }
        const proseClaims = claimReceipt.claims
            .filter((claim) => claim.declaration.claimType !== 'generated-section');
        const proseReceipt = sealDocClaimVerificationReceipt({
            sourceCommit: sourceIdentity.sourceCommit,
            worktreeFingerprint: sourceIdentity.worktreeFingerprint,
            catalogDigest: digestCatalog(catalog),
            parseReceiptDigest: claimReceipt.contentDigest,
            factObservationDigests,
            results: proseClaims
                .map((claim) => ({
                    claimId: claim.declaration.claimId,
                    behaviorId: BehaviorId(claim.declaration.behaviorId),
                    claimType: claim.declaration.claimType,
                    documentPath: claim.location.documentPath,
                    documentStatus: claim.location.documentStatus,
                    factPath: claim.declaration.factPath ?? null,
                    status: 'verified',
                    reason: 'claim matches current fact observation'
                })),
            status: 'ok',
            failureReasons: []
        });
        base.prose = {
            status: 'ok',
            verifiedClaimCount: proseClaims.length,
            contentDigest: proseReceipt.contentDigest
        };

        const mutationGovernance = runStalenessMutationGovernance(repositoryRoot);
        if (mutationGovernance.length > 0)
        {
            throw new Error(formatMutationGovernanceViolations(mutationGovernance)[0]);
        }
        const mutationResults = runAllMutationCases();
        mutationResults.forEach(assertCaseResult);
        base.mutationFixtures = {
            status: 'ok',
            caseCount: mutationResults.length,
            contentDigest: digestValue(mutationResults)
        };

        writeReceipt(path.join(componentsDirectory, 'behavior-owner-binding.json'), ownerReceipt);
        writeReceipt(path.join(componentsDirectory, 'doc-claim-parse.json'), claimReceipt);
        writeReceipt(path.join(componentsDirectory, 'doc-claim-verification.json'), proseReceipt);
        writeReceipt(path.join(componentsDirectory, 'generated-section-check.json'), generatedReceipt);

        base.status = 'ok';
    }
    catch (error)
    {
        base.failureReasons.push(error instanceof Error ? error.message : String(error));
    }

    base.durationMs = Date.now() - startedAt;
    const receipt = seal(base);
    writeReceipt(outputFile, receipt);
    if (receipt.status !== 'ok')
    {
        const error = new Error(`BehaviorDoc static admission failed: ${receipt.failureReasons.join('; ')}`);
        error.receipt = receipt;
        error.receiptFile = outputFile;
        throw error;
    }
    validateBehaviorDocStaticAdmissionReceipt(receipt, {
        expectedRunId: String(runId),
        expectedSourceIdentity: sourceIdentity,
        expectedWorktree: repositoryRoot,
        artifactRepositoryRoot: repositoryRoot
    });
    return { receipt, receiptFile: outputFile };
}

function parseArgs(argv)
{
    const options = { outputFile: null, verifyFile: null, runId: null };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--out')
        {
            options.outputFile = argv[++index];
        }
        else if (argument === '--verify')
        {
            options.verifyFile = argv[++index];
        }
        else if (argument === '--run-id')
        {
            options.runId = argv[++index];
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

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    if (options.help)
    {
        console.log('Usage: node tools/docs/behavior-doc-static-admission.mjs [--out path] [--run-id id] [--verify receipt]');
        return;
    }
    if (options.verifyFile)
    {
        const receipt = readBehaviorDocStaticAdmissionReceipt(
            path.resolve(root, options.verifyFile),
            {
                ...(options.runId ? { expectedRunId: options.runId } : {}),
                expectedSourceIdentity: sealSourceIdentity(root),
                expectedWorktree: root
            }
        );
        console.log(`[behavior-doc-static-admission] verified ${receipt.contentDigest}`);
        return;
    }
    const result = await runBehaviorDocStaticAdmission({
        repositoryRoot: root,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.outputFile ? { outputFile: path.resolve(root, options.outputFile) } : {})
    });
    console.log(
        `[behavior-doc-static-admission] ok facts=${Object.keys(result.receipt.factObservations).length}`
    + ` mutations=${result.receipt.mutationFixtures.caseCount}`
    + ` receipt=${path.relative(root, result.receiptFile)}`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === directFile)
{
    main().catch((error) =>
    {
        console.error(`[behavior-doc-static-admission] ${error.message}`);
        process.exitCode = 1;
    });
}
