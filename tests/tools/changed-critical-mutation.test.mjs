import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
    attributeMutantsToBehaviors,
    qualifyBehaviorMutations,
} from "../../tools/test/changed-critical-mutation-attribution.mjs";
import {
    createChangedCriticalStrykerConfig,
    selectChangedCriticalMutation,
    validateToolPolicy,
} from "../../tools/test/changed-critical-mutation.mjs";
import { scopeChangedCriticalMutationReport } from "../../tools/test/changed-critical-mutation-evidence.mjs";
import { sealMutationEvidenceReceipt } from "../../tools/test/mutation-evidence-receipt.mjs";
import {
    executeChangedCriticalSelection,
    findTraceLog,
} from "../../tools/test/run-changed-critical-mutation.mjs";

const rawToolPolicy = readFileSync(
    new URL(
        "../../config/testing/mutation/changed-critical-domains.v1.json",
        import.meta.url,
    ),
);
const toolPolicy = JSON.parse(rawToolPolicy);

const sourceState = {
    commit: "a".repeat(40),
    worktreeFingerprint: "b".repeat(64),
};

// Fixture: behavior catalog with mutationPolicy
function makeBehaviorCatalog() {
    return {
        schema: "fsusblog.behavior-contract-catalog.v1",
        digest: "c".repeat(64),
        contracts: [
            {
                id: "authentication-session-permission",
                domain: "security",
                risk: "critical",
                status: "active",
                mutationPolicy: {
                    mutationRequired: true,
                    minimumMutationScore: 70,
                    requireExecutedMutants: true,
                    allowedEquivalentMutantPolicy: "none",
                },
            },
            {
                id: "binary-api-aeds-contract",
                domain: "api",
                risk: "critical",
                status: "active",
                mutationPolicy: {
                    mutationRequired: true,
                    minimumMutationScore: 70,
                    requireExecutedMutants: true,
                    allowedEquivalentMutantPolicy: "none",
                },
            },
            {
                id: "code-intent-governance",
                domain: "governance",
                risk: "high",
                status: "active",
                // No mutationPolicy — not mutation-required
            },
        ],
    };
}

// Fixture: owner receipt with bindings
function makeOwnerReceipt() {
    return {
        schema: "fsusblog.behavior-owner-binding-receipt.v1",
        contentDigest: "d".repeat(64),
        bindings: [
            {
                behaviorId: "authentication-session-permission",
                language: "csharp",
                sourcePath:
                    "src/backend/Infrastructure/Auth/AccountSubjectHasher.cs",
                symbol: "AccountSubjectHasher",
                bindingKind: "attribute",
                status: "ok",
            },
            {
                behaviorId: "binary-api-aeds-contract",
                language: "csharp",
                sourcePath:
                    "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
                symbol: "ArticleRightsCanonicalHashV1",
                bindingKind: "attribute",
                status: "ok",
            },
            {
                behaviorId: "code-intent-governance",
                language: "javascript",
                sourcePath: "tools/governance/check-code-intent.mjs",
                symbol: "checkCodeIntent",
                bindingKind: "marker",
                status: "ok",
            },
        ],
        errors: [],
    };
}

// Fixture: test binding scan
function makeTestBindingScan() {
    return {
        catalogDigest: "c".repeat(64),
        bindings: [
            {
                behaviorId: "authentication-session-permission",
                testKind: "positive",
                fullyQualifiedName: "AccountSubjectHasherMutationTests.Run",
                canonicalTestId:
                    "xunit-trx:AccountSubjectHasherMutationTests#Run",
            },
            {
                behaviorId: "authentication-session-permission",
                testKind: "negative",
                fullyQualifiedName:
                    "AuthCookieServiceSecurityTests.RejectsExpired",
                canonicalTestId:
                    "xunit-trx:AuthCookieServiceSecurityTests#RejectsExpired",
            },
            {
                behaviorId: "binary-api-aeds-contract",
                testKind: "positive",
                fullyQualifiedName: "ArticleRightsCanonicalHashTests.Run",
                canonicalTestId:
                    "xunit-trx:ArticleRightsCanonicalHashTests#Run",
            },
            {
                behaviorId: "code-intent-governance",
                testKind: "positive",
                fullyQualifiedName: "CodeIntentTests.Valid",
                canonicalTestId:
                    "node-tap:tests/tools/code-intent.test.mjs#valid",
            },
        ],
    };
}

function select(changedPaths) {
    return selectChangedCriticalMutation({
        toolPolicy,
        rawToolPolicy,
        changedPaths,
        sourceState,
        ownerReceipt: makeOwnerReceipt(),
        behaviorCatalog: makeBehaviorCatalog(),
        testBindingScan: makeTestBindingScan(),
    });
}

test("tool policy validates schema v2 and rejects old v1 catalog", () => {
    assert.doesNotThrow(() => validateToolPolicy(toolPolicy));
    assert.throws(
        () =>
            validateToolPolicy({
                schema: "fsusblog.changed-critical-mutation-catalog.v1",
                version: 1,
            }),
        /schema v2/u,
    );
});

test("single-behavior change selects only its owner mutate file and binding-derived test filter", () => {
    const selection = select([
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);

    assert.equal(selection.status, "selected");
    assert.equal(selection.behaviors.length, 1);
    assert.equal(selection.behaviors[0].behaviorId, "binary-api-aeds-contract");
    assert.deepEqual(selection.mutateFiles, [
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);
    assert.match(selection.testFilter, /ArticleRightsCanonicalHashTests/u);
    assert.doesNotMatch(selection.testFilter, /AccountSubjectHasher/u);
});

test("cross-behavior selection is deterministic and de-duplicated", () => {
    const forward = select([
        "src/backend/Infrastructure/Auth/AccountSubjectHasher.cs",
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);
    const reverse = select([
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
        "src/backend/Infrastructure/Auth/AccountSubjectHasher.cs",
    ]);

    assert.equal(forward.closureDigest, reverse.closureDigest);
    assert.equal(forward.behaviors.length, 2);
    assert.deepEqual(
        forward.behaviors.map((b) => b.behaviorId),
        ["authentication-session-permission", "binary-api-aeds-contract"],
    );
});

test("non-mutation-required behavior change produces empty selection", () => {
    const selection = select(["tools/governance/check-code-intent.mjs"]);
    assert.equal(selection.status, "empty");
    assert.deepEqual(selection.behaviors, []);
    assert.deepEqual(selection.mutateFiles, []);
});

test("unrelated changes produce empty selection and never start Stryker", () => {
    const selection = select(["README.md", "src/frontend/src/App.vue"]);
    let starts = 0;
    const run = executeChangedCriticalSelection({
        selection,
        spawnStryker: () => {
            starts += 1;
            return { status: 0 };
        },
    });

    assert.equal(selection.status, "empty");
    assert.equal(run.status, "empty");
    assert.equal(run.strykerStarted, false);
    assert.equal(starts, 0);
});

test("docs-only/binding/catalog change triggers the full required behavior closure (never skips)", () => {
    const selection = select(["docs/testing.md"]);

    assert.equal(selection.status, "selected");
    assert.equal(selection.scope, "pr");
    assert.deepEqual(
        selection.behaviors.map((b) => b.behaviorId),
        ["authentication-session-permission", "binary-api-aeds-contract"],
    );
    assert.ok(
        selection.reasons.some((reason) =>
            reason.startsWith("governance-change:"),
        ),
    );
    assert.deepEqual(selection.mutateFiles, [
        "src/backend/Infrastructure/Auth/AccountSubjectHasher.cs",
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);
});

test("binding/catalog config change triggers the full required behavior closure", () => {
    const selection = select(["config/contracts/behavior-contracts.json"]);

    assert.equal(selection.status, "selected");
    assert.deepEqual(
        selection.behaviors.map((b) => b.behaviorId),
        ["authentication-session-permission", "binary-api-aeds-contract"],
    );
});

test("generated config uses binding-derived test filter and owner-derived mutate files", () => {
    const selection = select([
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);
    const generated = createChangedCriticalStrykerConfig(selection, toolPolicy);

    assert.deepEqual(generated["stryker-config"]["test-projects"], [
        "../../tests/backend/FsusBlog.Server.Tests.csproj",
    ]);
    assert.deepEqual(generated["stryker-config"].mutate, [
        "Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);
    assert.match(
        generated["stryker-config"]["test-case-filter"],
        /ArticleRightsCanonicalHashTests/u,
    );
    assert.deepEqual(generated["stryker-config"].thresholds, {
        high: 85,
        low: 70,
        break: 70,
    });
    assert.equal(
        generated["stryker-config"]["break-on-initial-test-failure"],
        true,
    );
});

test("mutant attribution maps each mutant to unique behavior via owner receipt", () => {
    const selection = select([
        "src/core/Integrity/ArticleRightsCanonicalHashV1.cs",
    ]);
    const report = {
        files: {
            "src/core/Integrity/ArticleRightsCanonicalHashV1.cs": {
                language: "cs",
                mutants: [
                    {
                        id: "1",
                        status: "Killed",
                        mutatorName: "Arithmetic",
                        coveredBy: ["t1"],
                        killedBy: ["t1"],
                    },
                    {
                        id: "2",
                        status: "Survived",
                        mutatorName: "Boolean",
                        coveredBy: ["t1"],
                        killedBy: [],
                    },
                ],
            },
        },
    };
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: "src/core",
        ownerReceipt: makeOwnerReceipt(),
        selection,
    });

    assert.equal(attributions.length, 2);
    assert.equal(blocked.length, 0);
    assert.equal(attributions[0].behaviorId, "binary-api-aeds-contract");
    assert.equal(attributions[0].symbol, "ArticleRightsCanonicalHashV1");
    assert.equal(attributions[0].mutator, "Arithmetic");
    assert.equal(attributions[0].status, "Killed");
    assert.deepEqual(attributions[0].killedTestIds, ["t1"]);
    assert.equal(attributions[1].status, "Survived");
});

test("attribution canonicalizes absolute report file keys to repo-relative mutant ids", () => {
    const root = "/repo";
    const ownerReceipt = {
        bindings: [
            {
                behaviorId: "authentication-session-permission",
                sourcePath: "src/backend/Services/Auth.cs",
                symbol: "AuthService",
                status: "ok",
            },
        ],
    };
    const selection = {
        behaviors: [{ behaviorId: "authentication-session-permission" }],
    };
    const report = {
        files: {
            "/repo/src/backend/Services/Auth.cs": {
                mutants: [
                    {
                        id: "42",
                        status: "Killed",
                        mutatorName: "Arithmetic",
                        coveredBy: ["t1"],
                        killedBy: ["t1"],
                    },
                ],
            },
        },
    };
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: "src/backend",
        ownerReceipt,
        selection,
        repositoryRoot: root,
    });

    assert.equal(blocked.length, 0);
    assert.equal(attributions.length, 1);
    assert.equal(attributions[0].mutantId, "src/backend:Services/Auth.cs:42");
    assert.equal(attributions[0].sourcePath, "src/backend/Services/Auth.cs");
    assert.equal(
        attributions[0].behaviorId,
        "authentication-session-permission",
    );
});

test("ambiguous multi-owner file reports blocked mutants", () => {
    const ownerReceipt = {
        bindings: [
            {
                behaviorId: "authentication-session-permission",
                sourcePath: "src/backend/Shared.cs",
                symbol: "SharedA",
                status: "ok",
            },
            {
                behaviorId: "binary-api-aeds-contract",
                sourcePath: "src/backend/Shared.cs",
                symbol: "SharedB",
                status: "ok",
            },
        ],
    };
    const selection = {
        behaviors: [
            { behaviorId: "authentication-session-permission" },
            { behaviorId: "binary-api-aeds-contract" },
        ],
    };
    const report = {
        files: {
            "src/backend/Shared.cs": {
                mutants: [
                    {
                        id: "1",
                        status: "Killed",
                        mutatorName: "Arithmetic",
                        coveredBy: [],
                        killedBy: [],
                    },
                ],
            },
        },
    };
    const { attributions, blocked } = attributeMutantsToBehaviors({
        report,
        sourceProject: "src/backend",
        ownerReceipt,
        selection,
    });

    assert.equal(attributions.length, 0);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason, "ambiguous-owner-boundary");
});

test("report scoping drops rolled-back out-of-closure entry-file mutants but rejects executed ones", () => {
    const mutateFiles = ["Services/Owned.cs"];
    const owned = {
        mutants: [
            {
                id: "1",
                status: "Killed",
                mutatorName: "Arithmetic",
                coveredBy: ["t1"],
                killedBy: ["t1"],
            },
        ],
    };
    const rolledBack = {
        mutants: [
            {
                id: "9",
                status: "CompileError",
                mutatorName: "Statement mutation",
                coveredBy: [],
                killedBy: [],
            },
            {
                id: "8",
                status: "CompileError",
                mutatorName: "Negate expression",
                coveredBy: [],
                killedBy: [],
            },
        ],
    };

    const scoped = scopeChangedCriticalMutationReport(
        {
            schemaVersion: "2",
            files: {
                "/repo/src/backend/Services/Owned.cs": owned,
                "/repo/src/backend/Program.cs": rolledBack,
                "/repo/src/backend/Untouched.cs": { mutants: [] },
            },
        },
        mutateFiles,
        "src/backend",
    );
    assert.deepEqual(Object.keys(scoped.report.files), [
        "/repo/src/backend/Services/Owned.cs",
    ]);
    assert.equal(scoped.report.schemaVersion, "2");
    assert.deepEqual(
        scoped.rolledBackOutOfClosure.map(({ file, mutantId, status }) => ({
            file,
            mutantId,
            status,
        })),
        [
            {
                file: "/repo/src/backend/Program.cs",
                mutantId: "8",
                status: "CompileError",
            },
            {
                file: "/repo/src/backend/Program.cs",
                mutantId: "9",
                status: "CompileError",
            },
        ],
    );

    for (const status of [
        "Killed",
        "Survived",
        "NoCoverage",
        "Timeout",
        "Ignored",
    ]) {
        assert.throws(
            () =>
                scopeChangedCriticalMutationReport(
                    {
                        files: {
                            "/repo/src/backend/Services/Owned.cs": owned,
                            "/repo/src/backend/Program.cs": {
                                mutants: [
                                    {
                                        id: "7",
                                        status,
                                        mutatorName: "Statement mutation",
                                        coveredBy: [],
                                        killedBy: [],
                                    },
                                ],
                            },
                        },
                    },
                    mutateFiles,
                    "src/backend",
                ),
            /planned mutants outside selected closure: \/repo\/src\/backend\/Program\.cs#7/u,
            status,
        );
    }

    assert.throws(
        () =>
            scopeChangedCriticalMutationReport(
                { files: { "/repo/src/backend/Program.cs": rolledBack } },
                mutateFiles,
                "src/backend",
            ),
        /missing selected mutate file src\/backend\/Services\/Owned\.cs/u,
    );
});

test("per-behavior qualification fails on survived mutants regardless of domain score", () => {
    const attributions = [
        {
            mutantId: "m1",
            behaviorId: "binary-api-aeds-contract",
            status: "Killed",
            sourcePath: "a.cs",
            symbol: "A",
            mutator: "Arith",
            coveredTestIds: ["t1"],
            killedTestIds: ["t1"],
        },
        {
            mutantId: "m2",
            behaviorId: "binary-api-aeds-contract",
            status: "Killed",
            sourcePath: "a.cs",
            symbol: "A",
            mutator: "Arith",
            coveredTestIds: ["t1"],
            killedTestIds: ["t1"],
        },
        {
            mutantId: "m3",
            behaviorId: "binary-api-aeds-contract",
            status: "Survived",
            sourcePath: "a.cs",
            symbol: "A",
            mutator: "Bool",
            coveredTestIds: ["t1"],
            killedTestIds: [],
        },
        {
            mutantId: "m4",
            behaviorId: "authentication-session-permission",
            status: "Killed",
            sourcePath: "b.cs",
            symbol: "B",
            mutator: "Arith",
            coveredTestIds: ["t2"],
            killedTestIds: ["t2"],
        },
    ];
    const { qualifications, failed } = qualifyBehaviorMutations({
        attributions,
        blocked: [],
        behaviorCatalog: makeBehaviorCatalog(),
    });

    assert.equal(failed, true);
    const aeds = qualifications.find(
        (q) => q.behaviorId === "binary-api-aeds-contract",
    );
    const auth = qualifications.find(
        (q) => q.behaviorId === "authentication-session-permission",
    );
    assert.equal(aeds.qualified, false);
    assert.equal(aeds.survived, 1);
    assert.ok(aeds.failures.some((f) => /survived/u.test(f)));
    assert.equal(auth.qualified, true);
});

test("documented policy scores executed mutants and gates unexecuted owner files", () => {
    const catalog = makeBehaviorCatalog();
    for (const contract of catalog.contracts) {
        if (contract.mutationPolicy) {
            contract.mutationPolicy.allowedEquivalentMutantPolicy =
                "documented";
        }
    }
    const attribution = (mutantId, behaviorId, status, sourcePath) => ({
        mutantId,
        behaviorId,
        status,
        sourcePath,
        symbol: "S",
        mutator: "Arith",
        coveredTestIds: status === "NoCoverage" ? [] : ["t1"],
        killedTestIds: status === "Killed" ? ["t1"] : [],
    });
    const attributions = [
        // a.cs: 7 killed + 2 survived + 1 timeout -> executed score 8/10 = 80
        ...["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((id) =>
            attribution(id, "binary-api-aeds-contract", "Killed", "a.cs"),
        ),
        attribution("m8", "binary-api-aeds-contract", "Survived", "a.cs"),
        attribution("m9", "binary-api-aeds-contract", "Survived", "a.cs"),
        attribution("m10", "binary-api-aeds-contract", "Timeout", "a.cs"),
        // CompileError/NoCoverage mutants never execute and are excluded from
        // the score but still recorded.
        attribution("m11", "binary-api-aeds-contract", "CompileError", "a.cs"),
        attribution("m12", "binary-api-aeds-contract", "NoCoverage", "a.cs"),
        // b.cs only produced NoCoverage mutants: the owner file has no
        // mutation coverage and must fail closed even though a.cs scored.
        attribution("m13", "binary-api-aeds-contract", "NoCoverage", "b.cs"),
        attribution(
            "m14",
            "authentication-session-permission",
            "Killed",
            "c.cs",
        ),
    ];
    const { qualifications, failed } = qualifyBehaviorMutations({
        attributions,
        blocked: [],
        behaviorCatalog: catalog,
    });

    const aeds = qualifications.find(
        (q) => q.behaviorId === "binary-api-aeds-contract",
    );
    const auth = qualifications.find(
        (q) => q.behaviorId === "authentication-session-permission",
    );
    assert.equal(failed, true);
    assert.equal(aeds.qualified, false);
    assert.equal(aeds.score, 80);
    assert.ok(
        aeds.failures.some(
            (f) => /zero executed mutants/u.test(f) && f.includes("b.cs"),
        ),
    );
    // Under 'documented' survived/timeout/no-coverage/compile-error counts are
    // recorded and scored, never raised as per-mutant failures.
    assert.ok(
        !aeds.failures.some((f) =>
            /survived mutant|timeout mutant|no-coverage mutant|compile-error mutant/u.test(
                f,
            ),
        ),
    );
    assert.equal(auth.qualified, true);
    assert.equal(auth.score, 100);
});

test("kill credit accepts clean bound tests of any selected behavior and rejects unbound tests", () => {
    const catalog = makeBehaviorCatalog();
    for (const contract of catalog.contracts) {
        if (contract.mutationPolicy) {
            contract.mutationPolicy.allowedEquivalentMutantPolicy =
                "documented";
        }
    }
    const binding = (canonicalTestId, behaviorId, fqn) => ({
        canonicalTestId,
        behaviorId,
        fullyQualifiedName: fqn,
    });
    const attributions = [
        {
            // Killed by a clean test bound to a *different* behavior: legal.
            mutantId: "src/backend:Auth.cs:1",
            behaviorId: "authentication-session-permission",
            status: "Killed",
            sourcePath: "src/backend/Auth.cs",
            symbol: "S",
            mutator: "Arith",
            coveredTestIds: ["raw-1"],
            killedTestIds: ["raw-1"],
        },
        {
            // Killed by a namespaced theory observation id: resolves to the
            // bound method identity.
            mutantId: "src/backend:Auth.cs:2",
            behaviorId: "authentication-session-permission",
            status: "Killed",
            sourcePath: "src/backend/Auth.cs",
            symbol: "S",
            mutator: "Arith",
            coveredTestIds: ["raw-2"],
            killedTestIds: ["raw-2"],
        },
        {
            // Killed only by an unbound test: fails closed.
            mutantId: "src/backend:Auth.cs:3",
            behaviorId: "authentication-session-permission",
            status: "Killed",
            sourcePath: "src/backend/Auth.cs",
            symbol: "S",
            mutator: "Arith",
            coveredTestIds: ["raw-3"],
            killedTestIds: ["raw-3"],
        },
    ];
    const { qualifications, failed } = qualifyBehaviorMutations({
        attributions,
        blocked: [],
        behaviorCatalog: catalog,
        behaviorIds: ["authentication-session-permission"],
        qualificationOptions: {
            cleanTestIdsByBehavior: {
                "authentication-session-permission": [
                    "xunit-trx:AuthTests#BoundMethod",
                ],
                "binary-api-aeds-contract": [
                    "xunit-trx:AedsTests#OtherBehaviorTest",
                ],
            },
            bindingByTestId: {
                "xunit-trx:AuthTests#BoundMethod": binding(
                    "xunit-trx:AuthTests#BoundMethod",
                    "authentication-session-permission",
                    "AuthTests.BoundMethod",
                ),
                "xunit-trx:AedsTests#OtherBehaviorTest": binding(
                    "xunit-trx:AedsTests#OtherBehaviorTest",
                    "binary-api-aeds-contract",
                    "AedsTests.OtherBehaviorTest",
                ),
            },
            testIdentityByRawId: {
                "raw-1":
                    "FsusBlog.Server.Tests.Unit.AedsTests.OtherBehaviorTest",
                "raw-2":
                    "FsusBlog.Server.Tests.Unit.AuthTests.BoundMethod(x: 1)",
                "raw-3": "FsusBlog.Server.Tests.Unit.StrayTests.Stray",
            },
        },
    });

    const auth = qualifications.find(
        (q) => q.behaviorId === "authentication-session-permission",
    );
    assert.equal(failed, true);
    assert.equal(auth.qualified, false);
    // Cross-behavior and namespaced kills are clean; only the unbound kill
    // remains as a failure.
    assert.ok(!auth.failures.some((f) => f.includes("Auth.cs:1")));
    assert.ok(!auth.failures.some((f) => f.includes("Auth.cs:2")));
    assert.ok(
        auth.failures.some(
            (f) => f.includes("Auth.cs:3") && f.includes("unbound test"),
        ),
    );
});

test("documented policy still fails below the minimum executed kill rate", () => {
    const catalog = makeBehaviorCatalog();
    for (const contract of catalog.contracts) {
        if (contract.mutationPolicy) {
            contract.mutationPolicy.allowedEquivalentMutantPolicy =
                "documented";
        }
    }
    const attribution = (mutantId, status) => ({
        mutantId,
        behaviorId: "binary-api-aeds-contract",
        status,
        sourcePath: "a.cs",
        symbol: "A",
        mutator: "Arith",
        coveredTestIds: ["t1"],
        killedTestIds: status === "Killed" ? ["t1"] : [],
    });
    const { qualifications, failed } = qualifyBehaviorMutations({
        attributions: [
            ...["m1", "m2", "m3", "m4", "m5", "m6"].map((id) =>
                attribution(id, "Killed"),
            ),
            attribution("m7", "Survived"),
            attribution("m8", "Survived"),
            attribution("m9", "Survived"),
            attribution("m10", "Survived"),
        ],
        blocked: [],
        behaviorCatalog: catalog,
    });

    const aeds = qualifications.find(
        (q) => q.behaviorId === "binary-api-aeds-contract",
    );
    assert.equal(failed, true);
    assert.equal(aeds.qualified, false);
    assert.equal(aeds.score, 60);
    assert.ok(
        aeds.failures.some((f) => /mutation score 60 < minimum 70/u.test(f)),
    );
});

test("mutation evidence receipt seals and validates", () => {
    const receipt = sealMutationEvidenceReceipt({
        sourceCommit: "a".repeat(40),
        worktreeFingerprint: "b".repeat(64),
        catalogDigest: "c".repeat(64),
        selectionDigest: "e".repeat(64),
        ownerReceiptDigest: "f".repeat(64),
        testBindingScanDigest: "1".repeat(64),
        rawReportDigest: "2".repeat(64),
        rawTraceDigest: "3".repeat(64),
        attributions: [
            {
                mutantId: "m1",
                behaviorId: "binary-api-aeds-contract",
                sourcePath: "a.cs",
                symbol: "A",
                mutator: "Arith",
                status: "Killed",
                coveredTestIds: ["t1"],
                killedTestIds: ["t1"],
            },
        ],
        qualifications: [
            {
                behaviorId: "binary-api-aeds-contract",
                mutationRequired: true,
                executed: 1,
                killed: 1,
                survived: 0,
                timeout: 0,
                noCoverage: 0,
                score: 100,
                minimumMutationScore: 70,
                qualified: true,
                failures: [],
            },
        ],
        blockedCount: 0,
        status: "ok",
        failureReasons: [],
    });

    assert.equal(receipt.schema, "fsusblog.mutation-evidence-receipt.v1");
    assert.match(receipt.contentDigest, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.status, "ok");
    assert.equal(receipt.attributions.length, 1);
    assert.equal(receipt.qualifications[0].qualified, true);
});

test("checked-in nightly and fixed release mutation lanes remain present", () => {
    const matrix = readFileSync(
        new URL("../matrix.yml", import.meta.url),
        "utf8",
    );
    const defaults = JSON.parse(
        readFileSync(
            new URL(
                "../../config/testing/mutation/default.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    const critical = JSON.parse(
        readFileSync(
            new URL(
                "../../config/testing/mutation/critical.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );

    assert.match(matrix, /- id: backend-mutation\n/u);
    assert.match(matrix, /- id: release-mutation-critical-slice\n/u);
    assert.ok(defaults["stryker-config"].mutate.length > 1);
    assert.deepEqual(critical["stryker-config"].mutate, [
        "Algorithms/AedsEncoder.cs",
    ]);
});

test("findTraceLog combines rotated log segments in chronological order", () => {
    const physicalOutput = mkdtempSync(resolve(tmpdir(), "stryker-trace-"));
    try {
        const logs = resolve(physicalOutput, "logs");
        mkdirSync(logs, { recursive: true });
        writeFileSync(
            resolve(logs, "log-20260913.txt"),
            "2026-09-13T00:00:02 [DBG] tail segment\n" +
                "2026-09-13T01:19:31 [INF] The final mutation score is 28.47 %\n",
        );
        writeFileSync(
            resolve(logs, "log-20260912.txt"),
            '2026-09-12T23:33:00 [DBG] Stryker starting, version: "4.14.2" (abc123)\n' +
                "2026-09-12T23:59:59 [DBG] head segment\n",
        );
        // Per-runner logs and the combined artifact itself must not be picked
        // up as trace segments.
        writeFileSync(resolve(logs, "Runner 0-log.txt"), "runner log\n");

        const tracePath = findTraceLog(physicalOutput);
        assert.equal(tracePath, resolve(logs, "combined-trace.txt"));
        const combined = readFileSync(tracePath, "utf8");
        assert.ok(
            combined.indexOf("Stryker starting") <
                combined.indexOf("final mutation score"),
        );
        assert.ok(
            combined.indexOf("head segment") < combined.indexOf("tail segment"),
        );

        // A single segment is returned untouched (no combined artifact).
        rmSync(resolve(logs, "log-20260913.txt"));
        rmSync(resolve(logs, "combined-trace.txt"));
        assert.equal(
            findTraceLog(physicalOutput),
            resolve(logs, "log-20260912.txt"),
        );
    } finally {
        rmSync(physicalOutput, { recursive: true, force: true });
    }
});

test("findTraceLog fails closed when no trace log exists", () => {
    const physicalOutput = mkdtempSync(resolve(tmpdir(), "stryker-trace-"));
    try {
        assert.throws(
            () => findTraceLog(physicalOutput),
            /must emit a verbose trace log/u,
        );
        mkdirSync(resolve(physicalOutput, "logs"), { recursive: true });
        writeFileSync(
            resolve(physicalOutput, "logs", "Runner 0-log.txt"),
            "runner log\n",
        );
        assert.throws(
            () => findTraceLog(physicalOutput),
            /must emit a verbose trace log/u,
        );
    } finally {
        rmSync(physicalOutput, { recursive: true, force: true });
    }
});
