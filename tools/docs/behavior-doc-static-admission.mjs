#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    digestCatalog,
    loadCatalog,
    root,
    validateBehaviorReferences,
    validateCatalog
} from '../contracts/behavior-contract-catalog.mjs';
import {
    sealDocClaimVerificationReceipt,
    sealGeneratedSectionCheckReceipt,
    sealOwnerBindingReceipt
} from '../contracts/behavior-graph-join.mjs';
import {
    formatOwnerBindingReport,
    scanBehaviorOwnerBindings
} from '../contracts/behavior-owner-binding.mjs';
import {
    scanRepositoryFactExtractorGovernance
} from '../fact-extractors/governance.mjs';
import {
    digestPath,
    digestValue,
    sealSourceIdentity
} from '../fact-extractors/identity.mjs';
import { semanticDigestFromReceipt } from '../fact-extractors/receipt.mjs';
import {
    loadRegistry,
    validateOwnershipAgainstBehaviorCatalog,
    validateRegistry
} from '../fact-extractors/registry.mjs';
import { runExtractor } from '../fact-extractors/runner.mjs';

import {
    runMinimalContractBuild
} from './behavior-doc-minimal-contract-build.mjs';
import {
    behaviorDocAdmissionReceiptSchema,
    behaviorDocGlobalClaimExactnessComponent,
    defaultBehaviorDocAdmissionComponentsDirectory,
    defaultBehaviorDocAdmissionReceipt,
    readBehaviorDocStaticAdmissionReceipt,
    validateBehaviorDocStaticAdmissionReceipt
} from './behavior-doc-static-admission-contract.mjs';
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
import { validateRepositoryMigrationLedger } from './check-document-claim-migration-ledger.mjs';
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
import {
    formatGovernanceViolations as formatProseGovernanceViolations,
    scanProseClaimGovernance
} from './prose-claim-verifier/governance.mjs';
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs';



export const behaviorDocAdmissionTierId = 'behavior-doc-static-admission';
export {
    behaviorDocAdmissionReceiptSchema,
    behaviorDocGlobalClaimExactnessComponent,
    defaultBehaviorDocAdmissionComponentsDirectory,
    defaultBehaviorDocAdmissionReceipt,
    readBehaviorDocStaticAdmissionReceipt,
    validateBehaviorDocStaticAdmissionReceipt
} from './behavior-doc-static-admission-contract.mjs';

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
    const startedAt = Date.now();
    const globalClaimExactnessFile = path.join(
        componentsDirectory,
        behaviorDocGlobalClaimExactnessComponent
    );
    fs.rmSync(globalClaimExactnessFile, { force: true });
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

        const {
            buildGlobalClaimExactnessReceipt,
            validateGlobalClaimExactnessReceipt
        } = await import('./global-claim-exactness-final.mjs');
        const globalClaimExactnessReceipt = await buildGlobalClaimExactnessReceipt({
            repositoryRoot,
            observationReceiptPaths: observationReceipts,
            runId: base.run.id,
            sourceCommit: sourceIdentity.sourceCommit,
            worktreeFingerprint: sourceIdentity.worktreeFingerprint
        });
        validateGlobalClaimExactnessReceipt(globalClaimExactnessReceipt);

        writeReceipt(path.join(componentsDirectory, 'behavior-owner-binding.json'), ownerReceipt);
        writeReceipt(path.join(componentsDirectory, 'doc-claim-parse.json'), claimReceipt);
        writeReceipt(path.join(componentsDirectory, 'doc-claim-verification.json'), proseReceipt);
        writeReceipt(path.join(componentsDirectory, 'generated-section-check.json'), generatedReceipt);
        writeReceipt(globalClaimExactnessFile, globalClaimExactnessReceipt);

        base.status = 'ok';
    }
    catch (error)
    {
        fs.rmSync(globalClaimExactnessFile, { force: true });
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
        expectedWorktree: repositoryRoot
    });
    return {
        receipt,
        receiptFile: outputFile,
        globalClaimExactnessFile
    };
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
