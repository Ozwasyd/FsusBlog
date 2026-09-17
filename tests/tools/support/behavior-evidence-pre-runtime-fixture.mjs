import { createHash } from "node:crypto";
import {
    digestValue,
    sealDocClaimVerificationReceipt,
    sealGeneratedSectionCheckReceipt,
    sealOwnerBindingReceipt,
} from "../../../tools/contracts/behavior-graph-join.mjs";
import {
    buildReceipt,
    sealReceipt,
} from "../../../tools/fact-extractors/receipt.mjs";
import { sealMutationEvidenceReceipt } from "../../../tools/test/mutation-evidence-receipt.mjs";
import { joinBehaviorEvidencePreRuntime } from "../../../tools/test-matrix/behavior-evidence-pre-runtime.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const WORKTREE_FP = "b".repeat(64);
const EXTRACTOR_DIGEST = "c".repeat(64);
const INPUT_DIGEST = "e".repeat(64);
const RUN_ID = "round-1";

function stable(value) {
    if (Array.isArray(value)) {
        return value.map(stable);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, stable(value[key])]),
        );
    }
    return value;
}

function digestReceipt(receipt) {
    const content = structuredClone(receipt);
    delete content.contentDigest;
    return `sha256:${createHash("sha256")
        .update(JSON.stringify(stable(content)), "utf8")
        .digest("hex")}`;
}

function digestReceiptWithNullField(receipt) {
    const content = structuredClone(receipt);
    content.contentDigest = null;
    return createHash("sha256")
        .update(JSON.stringify(stable(content)), "utf8")
        .digest("hex");
}

function makeCatalog(overrides = {}) {
    return {
        schema: "fsusblog.behavior-contract-catalog.v1",
        digestAlgorithm: "sha256",
        canonicalSerialization: "json-utf8-v1",
        domains: ["testing"],
        extractors: [
            { id: "alpha-fact-extractor", path: "tools/alpha/extract.mjs" },
            { id: "beta-fact-extractor", path: "tools/beta/extract.mjs" },
        ],
        contracts: [
            {
                id: "alpha-behavior",
                domain: "testing",
                risk: "high",
                status: "active",
                implementationOwnerCardinality: "one",
                allowedImplementationOwnerRoles: [],
                factExtractorId: "alpha-fact-extractor",
                requiredTestKinds: ["positive", "boundary"],
                documentationPolicy: "required",
                documentationRationale: "Public alpha contract.",
                allowedClaimTypes: ["behavioral"],
                releaseQualification: true,
                evidenceStage: "pre-runtime",
                coverageIds: ["alpha-behavior"],
                documents: ["docs/alpha.md"],
                mutationPolicy: {
                    mutationRequired: true,
                    minimumMutationScore: 70,
                    requireExecutedMutants: true,
                    allowedEquivalentMutantPolicy: "documented",
                },
            },
            {
                id: "beta-behavior",
                domain: "documentation",
                risk: "medium",
                status: "active",
                implementationOwnerCardinality: "one",
                allowedImplementationOwnerRoles: [],
                factExtractorId: "beta-fact-extractor",
                requiredTestKinds: ["positive"],
                documentationPolicy: "required",
                documentationRationale: "Public beta contract.",
                allowedClaimTypes: ["behavioral"],
                releaseQualification: true,
                evidenceStage: "pre-runtime",
                coverageIds: ["beta-behavior"],
                documents: ["docs/beta.md"],
            },
        ],
        ...overrides,
    };
}

function catalogDigest(catalog) {
    return digestValue(catalog);
}

function makeFactExtractorRegistry(
    catalog = makeCatalog(),
    compiledArtifacts = {},
) {
    return {
        schema: "fsusblog.behavior-fact-extractor-registry.v1",
        digestAlgorithm: "sha256",
        canonicalSerialization: "json-utf8-v1",
        extractors: catalog.extractors.map((entry) => {
            const requiredBuildArtifact = compiledArtifacts[entry.id] ?? null;
            return {
                id: entry.id,
                kind:
                    requiredBuildArtifact == null
                        ? "canonical-catalog"
                        : "compiled-assembly",
                entrypoint: entry.path,
                consumedInputs: [entry.path],
                outputSchema: "fsusblog.fact-observation-receipt.v1",
                requiredBuildArtifact,
                hermeticPolicy:
                    requiredBuildArtifact == null
                        ? "declared-inputs"
                        : "exact-build-receipt",
                ownedBehaviorIds: catalog.contracts
                    .filter((contract) => contract.factExtractorId === entry.id)
                    .map((contract) => contract.id),
            };
        }),
    };
}

const REGISTRY_DIGEST = digestValue(makeFactExtractorRegistry());

function makeFact({
    extractorId = "alpha-fact-extractor",
    behaviorIds = ["alpha-behavior"],
    observations = { limit: 10 },
    status = "ok",
    sourceCommit = SOURCE_COMMIT,
    worktreeFingerprint = WORKTREE_FP,
    buildIdentity = null,
    registryDigest = REGISTRY_DIGEST,
} = {}) {
    return sealReceipt(
        buildReceipt({
            extractorId,
            behaviorIds,
            sourceCommit,
            worktreeFingerprint,
            buildIdentity,
            extractorDigest: EXTRACTOR_DIGEST,
            registryDigest,
            consumedInputDigests: [
                { path: "tools/alpha/extract.mjs", digest: INPUT_DIGEST },
            ],
            observations: status === "ok" ? observations : {},
            status,
            failureReasons: status === "ok" ? [] : ["extractor failed"],
        }),
    );
}

function makeOwner({
    catalog,
    behaviorIds = ["alpha-behavior", "beta-behavior"],
    errors = [],
} = {}) {
    const digest = catalogDigest(catalog);
    const bindings = behaviorIds.map((id, index) => ({
        behaviorId: id,
        language: "javascript",
        sourcePath: `tools/${id.split("-")[0]}/extract.mjs`,
        symbol: "extract",
        bindingKind: "marker",
        sourceDigest: String(index + 1).repeat(64),
        status: "ok",
    }));
    return sealOwnerBindingReceipt({
        schema: "fsusblog.behavior-owner-binding-receipt.v1",
        catalogDigest: digest,
        worktreeDigest: SOURCE_COMMIT,
        status: errors.length === 0 ? "ok" : "failed",
        bindingCount: bindings.length,
        bindings: bindings.map((binding) => ({
            ...binding,
            catalogDigest: digest,
            worktreeDigest: SOURCE_COMMIT,
        })),
        errors,
    });
}

function makeTestEvidence({ catalog, evidence, errors = [] } = {}) {
    const digest = catalogDigest(catalog);
    const rows = evidence ?? [];
    const coverage = catalog.contracts
        .filter((contract) => contract.status === "active")
        .map((contract) => {
            const satisfied = contract.requiredTestKinds.filter((kind) =>
                rows.some(
                    (row) =>
                        row.behaviorId === contract.id &&
                        row.testKind === kind &&
                        row.discovered &&
                        row.executed &&
                        row.outcome === "passed",
                ),
            );
            const missing = contract.requiredTestKinds.filter(
                (kind) => !satisfied.includes(kind),
            );
            return {
                behaviorId: contract.id,
                requiredTestKinds: [...contract.requiredTestKinds],
                satisfiedTestKinds: satisfied,
                missingTestKinds: missing,
                status: missing.length === 0 ? "ok" : "failed",
            };
        });
    const receipt = {
        schema: "fsusblog.behavior-test-evidence-receipt.v1",
        catalogDigest: digest,
        worktreeDigest: SOURCE_COMMIT,
        run: {
            id: RUN_ID,
            attemptKind: "primary",
            evidenceClass: "correctness",
        },
        sourceState: {
            commit: SOURCE_COMMIT,
            worktreeFingerprint: `sha256:${WORKTREE_FP}`,
        },
        sourceClosureDigest: `sha256:${"f".repeat(64)}`,
        rawResultDigest: `sha256:${"9".repeat(64)}`,
        bindings: rows.map((row) => ({
            behaviorId: row.behaviorId,
            testKind: row.testKind,
            canonicalTestId: row.canonicalTestId,
            framework: "node-tap",
            sourcePath: row.sourcePath,
            fullyQualifiedName: row.fullyQualifiedName,
            invariantIds: [],
            reasonId: null,
            concurrencyHarness: null,
            bindingKind: "helper",
            line: 1,
        })),
        evidence: rows,
        coverage,
        errors,
        testPlanDigest: `sha256:${"7".repeat(64)}`,
        testPlanCommit: SOURCE_COMMIT,
        plannedTestIds: rows.map((row) => row.canonicalTestId).sort(),
        unplannedBoundTestIds: [],
        extraExecutedTestIds: [],
        runtimeCandidateSpawnCountBeforeReceipt: 0,
        producer: {
            command:
                "node tools/test-matrix/produce-behavior-test-evidence.mjs",
            schema: "fsusblog.behavior-test-evidence-receipt.v1",
        },
        contentDigest: null,
    };
    receipt.contentDigest = digestReceipt(receipt);
    return receipt;
}

function defaultEvidence(catalog) {
    const rows = [];
    for (const contract of catalog.contracts.filter(
        (entry) => entry.status === "active",
    )) {
        for (const kind of contract.requiredTestKinds) {
            rows.push({
                behaviorId: contract.id,
                testKind: kind,
                canonicalTestId: `node-tap:tests/${contract.id}.${kind}.test.mjs#${kind}`,
                framework: "node-tap",
                sourcePath: `tests/${contract.id}.${kind}.test.mjs`,
                fullyQualifiedName: kind,
                discovered: true,
                executed: true,
                outcome: "passed",
                invariantIds: [],
                reasonId: null,
                concurrencyHarness: null,
                run: {
                    id: "round-1",
                    attemptKind: "primary",
                    evidenceClass: "correctness",
                },
                sourceState: {
                    commit: SOURCE_COMMIT,
                    worktreeFingerprint: `sha256:${WORKTREE_FP}`,
                },
                sourceClosureDigest: `sha256:${"f".repeat(64)}`,
                rawResultDigest: `sha256:${"9".repeat(64)}`,
            });
        }
    }
    return rows;
}

function makeParseReceipt({ catalog, claims = [] } = {}) {
    const receipt = {
        schema: "fsusblog.doc-claim-parse-receipt.v1",
        digestAlgorithm: "sha256",
        canonicalSerialization: "json-utf8-v1",
        behaviorCatalogDigest: catalogDigest(catalog),
        claims,
    };
    return { ...receipt, contentDigest: digestValue(receipt) };
}

function makeVerification({
    catalog,
    parseReceipt,
    results = [],
    status = "ok",
    failureReasons = [],
} = {}) {
    return sealDocClaimVerificationReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        parseReceiptDigest: parseReceipt.contentDigest,
        factObservationDigests: [],
        results,
        status,
        failureReasons,
    });
}

function makeGenerated({
    catalog,
    sections = [],
    status = "ok",
    failureReasons = [],
} = {}) {
    return sealGeneratedSectionCheckReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        sectionCatalogDigest: "8".repeat(64),
        factObservationDigests: [],
        sections,
        status,
        failureReasons,
    });
}

function makeStaticAdmission({
    status = "ok",
    candidateSpawnCount = 0,
    sourceCommit = SOURCE_COMMIT,
    runId = RUN_ID,
} = {}) {
    const receipt = {
        schema: "fsusblog.behavior-doc-static-admission-receipt.v1",
        run: { id: runId },
        source: {
            commit: sourceCommit,
            worktreeFingerprint: `sha256:${WORKTREE_FP}`,
        },
        status,
        candidateSpawnCountBeforeReceipt: candidateSpawnCount,
        failureReasons: status === "ok" ? [] : ["admission failure"],
        contentDigest: null,
    };
    receipt.contentDigest = digestReceiptWithNullField(receipt);
    return receipt;
}

function makeClaim(
    behaviorId,
    claimId,
    factPath = "limit",
    documentPath = `docs/${behaviorId.split("-")[0]}.md`,
) {
    return {
        declaration: {
            claimId,
            behaviorId,
            claimType: "scalar",
            factPath,
            render: "scalar-inline",
        },
        location: {
            documentPath,
            claimStartLine: 1,
            claimEndLine: 4,
            documentStatus: "current",
            headingPath: ["Section"],
            bodyKind: "paragraph",
            bodyStartLine: 5,
            bodyEndLine: 5,
            bodyText: `${factPath} is 10`,
        },
    };
}

function makeVerificationResult(
    behaviorId,
    claimId,
    factPath = "limit",
    documentPath,
    status = "verified",
) {
    return {
        claimId,
        behaviorId,
        claimType: "scalar",
        documentPath: documentPath ?? `docs/${behaviorId.split("-")[0]}.md`,
        documentStatus: "current",
        factPath,
        status,
        reason: "ok",
    };
}

function makeMutationEvidence({
    catalog,
    owner,
    status = "ok",
    qualifications,
    attributions = [],
    failureReasons = [],
}) {
    return sealMutationEvidenceReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        selectionDigest: "6".repeat(64),
        ownerReceiptDigest: owner.contentDigest,
        testBindingScanDigest: "7".repeat(64),
        rawReportDigest: "8".repeat(64),
        rawTraceDigest: "9".repeat(64),
        attributions,
        qualifications,
        blockedCount: status === "ok" ? 0 : 0,
        status,
        failureReasons,
        runId: RUN_ID,
        attemptId: "attempt-0001",
        scope: "pr",
    });
}

function happyBundle() {
    const catalog = makeCatalog();
    const factExtractorRegistry = makeFactExtractorRegistry(catalog);
    const owner = makeOwner({ catalog });
    const evidence = defaultEvidence(catalog);
    const testEvidence = makeTestEvidence({ catalog, evidence });
    const claims = [
        makeClaim("alpha-behavior", "alpha.limit", "limit", "docs/alpha.md"),
        makeClaim("beta-behavior", "beta.enabled", "enabled", "docs/beta.md"),
    ];
    const parseReceipt = makeParseReceipt({ catalog, claims });
    const verification = makeVerification({
        catalog,
        parseReceipt,
        results: [
            makeVerificationResult(
                "alpha-behavior",
                "alpha.limit",
                "limit",
                "docs/alpha.md",
            ),
            makeVerificationResult(
                "beta-behavior",
                "beta.enabled",
                "enabled",
                "docs/beta.md",
            ),
        ],
    });
    const generated = makeGenerated({ catalog });
    const facts = [
        makeFact({
            extractorId: "alpha-fact-extractor",
            behaviorIds: ["alpha-behavior"],
            observations: { limit: 10 },
        }),
        makeFact({
            extractorId: "beta-fact-extractor",
            behaviorIds: ["beta-behavior"],
            observations: { enabled: true },
        }),
    ];
    const mutationEvidence = makeMutationEvidence({
        catalog,
        owner,
        attributions: [
            {
                mutantId: "alpha:1",
                behaviorId: "alpha-behavior",
                sourcePath: "tools/alpha/extract.mjs",
                symbol: "extract",
                mutator: "Boolean",
                status: "Killed",
                coveredTestIds: ["a1"],
                killedTestIds: ["a1"],
            },
        ],
        qualifications: [
            {
                behaviorId: "alpha-behavior",
                mutationRequired: true,
                executed: 1,
                killed: 1,
                survived: 0,
                timeout: 0,
                noCoverage: 0,
                compileError: 0,
                requiredMutants: 1,
                recordedMutants: 1,
                score: 100,
                minimumMutationScore: 70,
                qualified: true,
                failures: [],
            },
        ],
        status: "ok",
        failureReasons: [],
    });
    const admission = makeStaticAdmission();

    return {
        catalog,
        factExtractorRegistry,
        ownerReceipt: owner,
        testEvidenceReceipt: testEvidence,
        docClaimParseReceipt: parseReceipt,
        docClaimVerificationReceipt: verification,
        generatedSectionCheckReceipt: generated,
        factObservationReceipts: facts,
        mutationEvidenceReceipt: mutationEvidence,
        staticAdmissionReceipt: admission,
    };
}

function join(inputs, overrides = {}) {
    return joinBehaviorEvidencePreRuntime({
        catalog: inputs.catalog,
        factExtractorRegistry: inputs.factExtractorRegistry,
        ownerReceipt: inputs.ownerReceipt,
        testEvidenceReceipts: [inputs.testEvidenceReceipt],
        docClaimParseReceipt: inputs.docClaimParseReceipt,
        docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
        generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
        factObservationReceipts: inputs.factObservationReceipts,
        mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
        staticAdmissionReceipt: inputs.staticAdmissionReceipt,
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        runIdentity: RUN_ID,
        ...overrides,
    });
}

export {
    SOURCE_COMMIT,
    WORKTREE_FP,
    EXTRACTOR_DIGEST,
    INPUT_DIGEST,
    RUN_ID,
    stable,
    digestReceipt,
    digestReceiptWithNullField,
    makeCatalog,
    catalogDigest,
    makeFactExtractorRegistry,
    REGISTRY_DIGEST,
    makeFact,
    makeOwner,
    makeTestEvidence,
    defaultEvidence,
    makeParseReceipt,
    makeVerification,
    makeGenerated,
    makeStaticAdmission,
    makeClaim,
    makeVerificationResult,
    makeMutationEvidence,
    happyBundle,
    join,
};
