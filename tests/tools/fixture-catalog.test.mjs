import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    linkSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const {canonicalDigest: currentSchemaCanonicalDigest, runtimeReadyReceiptPath, runtimeReadySchema} = await import(new URL('../../tools/db/verify-current-schema-test-materialization-receipt.mjs', import.meta.url));
const {buildFixtureReceipt, writeFixtureReceipt} = await import(new URL('../../tools/test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
const {applySealedFixtureProfileEnvironment, buildFixtureVariantPlan, buildProducerFixtureVariantPlan, currentSchemaRuntimeTopologyAdmissionBinding, expandFixtureProfile, fixtureCatalogDigest, fixtureCatalogFiles, matrixConsumerObservationContent, observeFixtureConsumerSource, planFixtureMutation, resolveFixtureVariants, resolveFixtureProfile, scanFixtureSourceDeclarations, sealMatrixFixtureProfile, validateFixtureAuthoritySources, validateFixtureCatalogs, validateFixtureVariantEvidence, validateFixtureSentinelRegistry, validateNoneFixtureTier, verifyCurrentSchemaRuntimeTopologyAdmission, verifyCurrentSchemaTerminalDag, writeAcceptanceRuntimeTopology, writeCurrentSchemaRuntimeTopologyAdmission, writeFixtureProfileReceipt} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const {parseMatrix} = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
);
const names = ["capability", "profile", "producer", "inventory", "variant"];

function fixture(change)
{
    const directory = mkdtempSync(path.join(tmpdir(), "fixture-catalog-"));
    const files = Object.fromEntries(
        names.map((name) => [name, path.join(directory, `${name}.json`)])
    );
    const data = Object.fromEntries(
        names.map((name) => [
            name,
            JSON.parse(readFileSync(fixtureCatalogFiles[name], "utf8"))
        ])
    );
    change(data);
    for (const name of names)
    {
        writeFileSync(files[name], JSON.stringify(data[name]));
    }
    return { directory, files };
}

function rejects(change, pattern)
{
    const sample = fixture(change);
    try
    {
        assert.match(
            validateFixtureCatalogs({
                files: sample.files,
                validateRepositoryAuthority: false
            }).join("\n"),
            pattern
        );
    }
    finally
    {
        rmSync(sample.directory, { recursive: true, force: true });
    }
}

test("fixture catalogs are valid and profiles expand deterministically", () =>
{
    assert.deepEqual(validateFixtureCatalogs(), []);
    assert.deepEqual(expandFixtureProfile("scale-xs").capabilities, [
        "public.article.published",
        "scale.article-comment.xs"
    ]);
    assert.deepEqual(expandFixtureProfile("none").capabilities, []);
    assert.deepEqual(expandFixtureProfile("runtime-cache-pagination").capabilities, [
        "public.article.pagination-deep",
        "public.article.published"
    ]);
});

test("fixture variant catalog resolves typed plans and fails closed on sentinel or shape drift", () =>
{
    assert.deepEqual(
        resolveFixtureVariants(["public.article.published"], "runtime"),
        ["canonical.public.article.published"]
    );
    assert.deepEqual(
        resolveFixtureVariants(
            ["public.article.pagination-deep", "public.article.published"],
            "runtime"
        ),
        [
            "canonical.public.article.pagination-deep",
            "canonical.public.article.published"
        ]
    );
    assert.deepEqual(
        resolveFixtureVariants(["scale.article-comment.xs"], "load"),
        ["scale.scale.article-comment.xs"]
    );
    assert.deepEqual(
        resolveFixtureVariants(["development.demo.dataset"], "development"),
        ["diagnostic.development.demo.dataset"]
    );
    assert.deepEqual(
        resolveFixtureVariants(["development.demo.dataset"], "diagnostic"),
        ["diagnostic.development.demo.dataset"]
    );
    assert.deepEqual(
        resolveFixtureVariants(
            ["comment.threaded", "session.single-device"],
            "diagnostic"
        ),
        [
            "migration.comment-threaded-legacy-author",
            "migration.session-single-device-legacy-authentication"
        ]
    );
    assert.deepEqual(
        resolveFixtureVariants(
            ["public.article.published"],
            "security",
            undefined,
            {
                requestedVariantIds: [
                    "negative.public-article-published-rights-recompute"
                ]
            }
        ),
        ["negative.public-article-published-rights-recompute"]
    );
    assert.throws(
        () =>
            resolveFixtureVariants(["comment.threaded"], "browser", undefined, {
                requestedVariantIds: [
                    "migration.comment-threaded-legacy-author"
                ]
            }),
        /rejects execution class browser/
    );
    assert.throws(
        () =>
            resolveFixtureVariants(
                ["public.article.published"],
                "security",
                undefined,
                {
                    requestedVariantIds: [
                        "canonical.public.article.published",
                        "negative.public-article-published-rights-recompute"
                    ]
                }
            ),
        /one-to-one/
    );
    const negativePlan = buildFixtureVariantPlan([
        "negative.public-article-published-rights-recompute"
    ]);
    const negativeProducerPlan = buildProducerFixtureVariantPlan({
        producerId: "public-content",
        variantIds: negativePlan.variants.map((item) => item.id),
        fixtureVariantIds: negativePlan.variants.map((item) => item.id),
        fixtureVariantPlanDigest: negativePlan.variantPlanDigest
    });
    assert.equal(negativePlan.byProducer[0].producerId, "public-content");
    assert.equal(
        negativePlan.byProducer[0].variants[0].validityClass,
        "negative-invalid"
    );
    assert.ok(negativePlan.variantPlanDigest.startsWith("sha256:"));
    assert.ok(
        negativeProducerPlan.producerVariantPlanDigest.startsWith("sha256:")
    );
    assert.equal(
        negativeProducerPlan.fixtureVariantPlanDigest,
        negativePlan.variantPlanDigest
    );
    assert.equal(Object.isFrozen(negativePlan.byProducer[0].variants[0]), true);
    assert.equal(Object.isFrozen(negativeProducerPlan), true);
    assert.throws(
        () =>
            buildProducerFixtureVariantPlan({
                producerId: "public-content",
                variantIds: negativePlan.variants.map((item) => item.id),
                fixtureVariantIds: negativePlan.variants.map((item) => item.id),
                fixtureVariantPlanDigest: `sha256:${"0".repeat(64)}`
            }),
        /digest is forged/
    );
    assert.throws(
        () =>
            buildProducerFixtureVariantPlan({
                producerId: "public-content",
                variantIds: ["unregistered.fixture.variant"],
                fixtureVariantIds: ["unregistered.fixture.variant"],
                fixtureVariantPlanDigest: negativePlan.variantPlanDigest
            }),
        /unregistered variant/
    );
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "canonical.public.article.published"
        );
        variant.forbiddenSentinelIds = variant.forbiddenSentinelIds.filter(
            (id) => id !== "rights-v3-policy-hash-recompute"
        );
    }, /must reject every registered canonical-forbidden sentinel/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "canonical.public.article.published"
        );
        variant.contentShapeIds = ["unknown-shape"];
    }, /unknown id unknown-shape/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) =>
                item.id ===
                "negative.public-article-published-rights-recompute"
        );
        variant.requiredDerivedStateIds.push("production-derived-state");
        variant.requiredDerivedStateIds.sort();
    }, /must violate exactly one invariant/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "canonical.public.article.published"
        );
        variant.validityClass = ["canonical-positive", "diagnostic-only"];
    }, /invalid validityClass/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "canonical.public.article.published"
        );
        variant.capabilityId = "unknown.capability";
    }, /unknown capability/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "scale.scale.article-comment.xs"
        );
        variant.expectedBoundary = "equivalent: schema only";
    }, /must declare production graph equivalence boundary/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) =>
                item.id ===
                "negative.public-article-published-rights-recompute"
        );
        variant.defaultExecutionClasses = ["security"];
    }, /must have exactly one catalog default variant/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "migration.comment-threaded-legacy-author"
        );
        variant.allowedExecutionClasses = ["diagnostic", "load"];
    }, /must exactly match catalog execution policy diagnostic/);
    rejects((data) =>
    {
        const sentinel = data.variant.sentinels.find(
            (item) => item.id === "legacy-unverified"
        );
        sentinel.profileScope = "registered-profiles";
        sentinel.allowedProfiles = ["unknown-profile"];
    }, /allowedProfiles references unknown id unknown-profile/);
    rejects((data) =>
    {
        const variant = data.variant.variants.find(
            (item) =>
                item.id ===
                "negative.public-article-published-rights-recompute"
        );
        variant.injectedSentinelId = "rights-v3-content-hash-recompute";
    }, /must allow negative-invalid/);
});

test("fixture variant JSON Schema rejects unknown implementation-bearing fields at every closed boundary", () =>
{
    rejects((data) =>
    {
        data.variant.unexpectedImplementationCommand =
            "psql tools/dev/demo-seed.sql";
    }, /fixture variant schema: \$ has additional property unexpectedImplementationCommand/);
    rejects((data) =>
    {
        data.variant.validityClasses[0].unexpectedImplementationCommand =
            "psql tools/dev/demo-seed.sql";
    }, /fixture variant schema: \$\.validityClasses\[0\] has additional property unexpectedImplementationCommand/);
    rejects((data) =>
    {
        data.variant.sentinels[0].unexpectedImplementationCommand =
            "psql tools/dev/demo-seed.sql";
    }, /fixture variant schema: \$\.sentinels\[0\] has additional property unexpectedImplementationCommand/);
    rejects((data) =>
    {
        data.variant.variants[0].unexpectedImplementationCommand =
            "psql tools/dev/demo-seed.sql";
    }, /fixture variant schema: \$\.variants\[0\] has additional property unexpectedImplementationCommand/);
});

test("fresh process rejects an internally consistent whole-catalog validity vocabulary rewrite", () =>
{
    const sample = fixture((data) =>
    {
        const replacements = new Map([
            ["canonical-positive", "mostly-valid"],
            ["diagnostic-only", "temporary.diagnostic-only"],
            ["migration-legacy", "temporary.migration-legacy"],
            ["negative-invalid", "temporary.negative-invalid"],
            ["scale-synthetic", "temporary.scale-synthetic"]
        ]);
        for (const item of data.variant.validityClasses)
        {
            item.id = replacements.get(item.id);
        }
        for (const item of data.variant.sentinels)
        {
            item.allowedValidityClasses = item.allowedValidityClasses
                .map((id) => replacements.get(id))
                .sort();
        }
        for (const item of data.variant.variants)
        {
            item.validityClass = replacements.get(item.validityClass);
        }
    });
    try
    {
        const moduleUrl = pathToFileURL(
            path.join(root, "tools/testing/fixture-catalog.mjs")
        ).href;
        const script = `
      import { validateFixtureCatalogs } from ${JSON.stringify(moduleUrl)}
      const files = JSON.parse(process.env.FSUSBLOG_TEST_FIXTURE_CATALOG_FILES)
      console.log(validateFixtureCatalogs({ files, validateRepositoryAuthority: false }).join('\\n'))
    `;
        const child = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", script],
            {
                encoding: "utf8",
                env: {
                    ...process.env,
                    FSUSBLOG_TEST_FIXTURE_CATALOG_FILES: JSON.stringify(
                        sample.files
                    )
                }
            }
        );
        assert.equal(child.status, 0, child.stderr);
        assert.match(
            child.stdout,
            /validity classes must exactly match canonical-positive/
        );
        assert.match(child.stdout, /invalid validityClass mostly-valid/);
    }
    finally
    {
        rmSync(sample.directory, { recursive: true, force: true });
    }
});

test("fixture variant evidence rejects a cover entity when catalog labels it no-media", () =>
{
    const sample = fixture((data) =>
    {
        const variant = data.variant.variants.find(
            (item) => item.id === "canonical.public.article.published"
        );
        variant.mediaShapeIds = ["no-media"];
    });
    try
    {
        const catalogs = Object.fromEntries(
            names.map((name) => [
                name,
                JSON.parse(readFileSync(sample.files[name], "utf8"))
            ])
        );
        assert.match(
            validateFixtureVariantEvidence({
                catalogs,
                variantIds: ["canonical.public.article.published"],
                result: {
                    enforceVariantEvidence: true,
                    observations: {
                        database: {
                            entities: [
                                {
                                    id: "article-1",
                                    variantId:
                                        "canonical.public.article.published",
                                    fields: { hasCover: true }
                                }
                            ]
                        }
                    },
                    variantEvidence: {
                        variants: [
                            {
                                variantId: "canonical.public.article.published",
                                source: "live-service",
                                entityIds: ["article-1"]
                            }
                        ]
                    }
                }
            }).join("\n"),
            /no-media variant canonical\.public\.article\.published observed a cover entity/
        );
    }
    finally
    {
        rmSync(sample.directory, { recursive: true, force: true });
    }
});

test("fixture sentinel registry rejects new unregistered legacy fixture values", () =>
{
    const source = "tools/test-fixtures/producers/demo-public-producer.mjs";
    const original = readFileSync(path.join(root, source), "utf8");
    assert.match(
        validateFixtureSentinelRegistry({
            sourceOverrides: new Map([
                [source, `${original}\n-- legacy_future_fixture_state\n`]
            ])
        }).join("\n"),
        /legacy_future_fixture_state is not registered/
    );
});

test("fixture catalog rejects duplicate API and DB ownership", () =>
    rejects((data) =>
    {
        const producer = data.producer.producers.find(
            (item) => item.id === "scale-data"
        );
        producer.provides.push("public.article.published");
        producer.provides.sort();
    }, /public\.article\.published must have exactly owner public-content|mixed producer strategies/));

test("fixture catalog rejects auth ownership of a ban capability", () =>
    rejects((data) =>
    {
        const capability = data.capability.capabilities.find(
            (item) => item.id === "security.subject.banned"
        );
        capability.ownerProducerId = "auth-session";
        const producer = data.producer.producers.find(
            (item) => item.id === "auth-session"
        );
        producer.provides.push("security.subject.banned");
        producer.provides.sort();
    }, /security capability security\.subject\.banned must be owned by security-state/));

test("fixture catalog rejects unknown profile capability and state domain", () =>
{
    rejects(
        (data) =>
            data.profile.profiles
                .find((item) => item.id === "auth-basic")
                .capabilities.push("unknown.capability"),
        /unknown capability/
    );
    rejects((data) =>
    {
        const item = data.capability.capabilities.find(
            (candidate) => candidate.id === "auth.user.active"
        );
        item.stateDomains.push("postgres.everything");
        item.stateDomains.sort();
    }, /unknown id postgres\.everything/);
});

test("fixture catalog rejects unregistered producer output and inventory none lie", () =>
{
    rejects(
        (data) =>
            data.producer.producers
                .find((item) => item.id === "auth-session")
                .provides.push("unknown.capability"),
        /unknown id unknown\.capability/
    );
    rejects((data) =>
    {
        const entry = data.inventory.consumers.find(
            (item) => item.requiredCapabilities.length
        );
        entry.profileId = "none";
        entry.profileIds = ["none"];
    }, /cannot use none profile/);
});

test("fixture catalog rejects dependency cycles, destructive none, and broad acceptance data", () =>
{
    rejects((data) =>
    {
        const item = data.capability.capabilities.find(
            (candidate) => candidate.id === "auth.user.active"
        );
        item.dependsOn.push("auth.user.mfa-enabled");
    }, /dependency cycle/);
    rejects(
        (data) =>
            (data.profile.profiles.find(
                (item) => item.id === "none"
            ).isDestructive = true),
        /none profile must declare/
    );
    rejects((data) =>
    {
        const item = data.capability.capabilities.find(
            (candidate) => candidate.id === "public.article.published"
        );
        item.id = "acceptance.all-data";
    }, /broad fixture capability is forbidden/);
});

test("generated inventory and profile documentation have no drift", () =>
{
    const result = spawnSync(
        process.execPath,
        ["tools/testing/generate-fixture-catalog-artifacts.mjs", "--check"],
        { cwd: root, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
});

test("matrix consumers cannot omit fixture profile bindings", () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), "fixture-matrix-"));
    try
    {
        const source = readFileSync(
            path.join(root, "tests/matrix.yml"),
            "utf8"
        );
        const missing = source.replace(
            "      fixtureProfile: acceptance-representative\n      fixtureProfileReason: binds-acceptance-representative\n      fixtureProfileProof: tests/tools/matrix-fixture-profile.test.mjs\n      fixtureMutatorAllowed: true\n",
            ""
        );
        const file = path.join(directory, "matrix.yml");
        writeFileSync(file, missing);
        assert.match(
            validateFixtureCatalogs({
                matrixFile: file,
                validateRepositoryAuthority: false
            }).join("\n"),
            /matrix tier bootstrap must bind fixtureProfile/
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("producer registry and implementation declarations are bidirectionally exact", () =>
{
    rejects(
        (data) =>
            data.producer.producers
                .find((item) => item.id === "scale-data")
                .implementationPaths.pop(),
        /producer registry and source implementations must bidirectionally exact match/
    );
    const source = "tools/data-scale/cleanup.sh";
    const original = readFileSync(path.join(root, source), "utf8");
    assert.throws(
        () =>
            scanFixtureSourceDeclarations({
                sourceOverrides: new Map([
                    [
                        source,
                        original.replace(
                            /^# fixture-catalog: producer scale-data\n/mu,
                            ""
                        )
                    ]
                ])
            }),
        /has no declaration/
    );
    const hiddenSource = "tests/frontend/fixtures/hidden-fixture-owner.mjs";
    assert.equal(
        scanFixtureSourceDeclarations({
            sourceOverrides: new Map([
                [hiddenSource, "// fixture-catalog: producer auth-session\n"]
            ])
        }).producers.some((item) => item.source === hiddenSource),
        true
    );
});

test("repository authority gate rejects aliases, second profile lists, and free-string capabilities", () =>
{
    const source = "tools/bootstrap-acceptance-env.sh";
    const original = readFileSync(path.join(root, source), "utf8");
    const violations = validateFixtureAuthoritySources({
        sourceOverrides: new Map([
            [
                source,
                `${original}\nfixtureProfileAlias=legacy\nfixtureVariantAlias=legacy\nfixtureProfiles=['auth-basic']\nfixtureCapabilities=['auth.user.active']\n`
            ]
        ])
    }).join("\n");
    assert.match(violations, /fixture profile alias is forbidden/);
    assert.match(violations, /fixture variant alias is forbidden/);
    assert.match(violations, /second fixture profile list is forbidden/);
    assert.match(
        violations,
        /free-string fixture capability list is forbidden/
    );
});

test("catalog field shape and source inventory bindings fail closed", () =>
{
    rejects(
        (data) => delete data.capability.capabilities[0].resetContractId,
        /must declare a stable reset contract/
    );
    rejects((data) =>
    {
        data.profile.profiles.find(
            (item) => item.id === "auth-basic"
        ).isDestructive = "no";
    }, /mutation and namespace flags must be boolean/);
    rejects((data) =>
    {
        data.producer.producers
            .find((item) => item.id === "auth-session")
            .receiptPostconditions.pop();
    }, /receiptPostconditions must exactly match/);
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === "source:auth-smoke-fixture"
        );
        consumer.profileId = "acceptance-representative";
        consumer.profileIds = ["acceptance-representative"];
    }, /source auth-smoke-fixture and generated inventory profile binding differ/);
});

test("none profile rejects hidden fixture preparation and security reset", () =>
{
    const tier = {
        id: "none-negative",
        command: "tools/test/lanes/none-negative.sh",
        fixtureProfile: "none"
    };
    const sourceOverrides = new Map([
        [
            "tools/test/lanes/none-negative.sh",
            'ResetSecurityRuntimeState "hidden reset"\nInvokeLaneFixtureOrchestrator\n'
        ]
    ]);
    assert.deepEqual(validateNoneFixtureTier(tier, { sourceOverrides }), [
        "matrix tier none-negative none profile cannot execute security state reset",
        "matrix tier none-negative none profile cannot execute business fixture preparation"
    ]);
});

test("inventory records public-content transaction-fixture without API→DB or env discovery", () =>
{
    const producer = readFileSync(
        path.join(
            root,
            "tools/test-fixtures/producers/public-content-producer.mjs"
        ),
        "utf8"
    );
    const observed = observeFixtureConsumerSource(
        "tools/test-fixtures/producers/public-content-producer.mjs",
        producer
    );
    assert.match(observed, /transaction-fixture domain-port composition root/u);
    assert.doesNotMatch(
        observed,
        /admin API public seed falls back to direct-DB seed/u
    );
    assert.doesNotMatch(
        observed,
        /reuses public content already present in the running env/u
    );
    assert.doesNotMatch(
        producer,
        /seedPublicFixturesViaApi|buildSeededArticleFallback|function seedPublicFixtures\s*\(/u
    );

    const inventory = JSON.parse(
        readFileSync(fixtureCatalogFiles.inventory, "utf8")
    );
    const publicProducer =
        inventory.producerImplementations?.find?.(
            (item) =>
                item.id === "public-content" ||
                item.producerId === "public-content" ||
                String(item.source ?? item.path ?? "").includes(
                    "public-content-producer"
                )
        ) ??
        inventory.consumers.find((item) =>
            String(item.source ?? "").includes("public-content-producer")
        );
    assert.ok(publicProducer || inventory.producerImplementations);

    const sessions = inventory.consumers.find(
        (item) => item.consumerId === "source:auth-session-runtime"
    );
    assert.ok(sessions);
    assert.match(
        sessions.currentFallback,
        /persists auth fixture files when FSUSBLOG_PERSIST_AUTH_FIXTURES/u
    );
});

test("scale observations bind specific generator scripts rather than unrelated words", () =>
{
    const expected = /scale data is produced by the scale-data generator/u;
    for (const source of [
        "tools/data-scale/seed.sh",
        "tools/data-scale/cleanup.sh",
        "tools/data-scale/probe.sh",
        "tools/test/lanes/data-scale.sh"
    ])
    {
        assert.match(observeFixtureConsumerSource(source, readFileSync(path.join(root, source), "utf8")), expected);
    }
    assert.match(observeFixtureConsumerSource("tools/test/lanes/custom.sh",
        'bash "$ROOT_DIR/tools/data-scale/seed.sh" "$TIER"'), expected);
    for (const content of [
        "data-scale-runtime-caller.mjs; seed auth fixtures; probe readiness",
        "scale.article-comment; seed auth fixtures",
        "tools/data-scale/seed.sh.backup; cleanup auth",
        "not-data-scale/seed.sh; probe readiness"
    ])
    {
        assert.doesNotMatch(observeFixtureConsumerSource("tools/bootstrap-acceptance-env.sh", content), expected);
    }
});

test("shared bootstrap resource helpers do not imply scale fixture generation", () =>
{
    const bootstrap = readFileSync(path.join(root, "tools/bootstrap-acceptance-env.sh"), "utf8");
    assert.match(bootstrap, /data-scale-runtime-caller\.mjs/u);
    const expected = /scale data is produced by the scale-data generator/u;
    assert.doesNotMatch(observeFixtureConsumerSource("tools/bootstrap-acceptance-env.sh", bootstrap), expected);
    const matrix = parseMatrix(readFileSync(path.join(root, "tests/matrix.yml"), "utf8"));
    for (const id of ["bootstrap", "browser-contract", "runtime-cache-public-hot-read", "production"])
    {
        const tier = matrix.tiers.find((candidate) => candidate.id === id);
        assert.ok(tier, id);
        assert.doesNotMatch(observeFixtureConsumerSource(tier.command,
            matrixConsumerObservationContent(tier)), expected, id);
    }
});

test("inventory rejects hardcoded no-fallback while source reuses env data", () =>
    rejects((data) =>
    {
        const consumer = data.inventory.consumers.find(
            (item) => item.consumerId === "source:auth-session-runtime"
        );
        consumer.currentFallback =
            "no catalog alias or undeclared capability fallback";
        consumer.implicitSource =
            "reuses public content already present in the running env when list/home discovery succeeds";
    }, /hardcodes no-fallback while source reuses env data|currentFallback is stale or untruthful/));

test("dev-cli and matrix resolve share digests and none is zero-mutation", () =>
{
    const none = resolveFixtureProfile({
        profileId: "none",
        profileSource: "dev-cli",
        freeProfileEnv: ""
    });
    assert.equal(none.profileId, "none");
    assert.equal(none.mutationPolicy, "zero-mutation");
    assert.deepEqual(none.capabilities, []);
    assert.deepEqual(none.producers, []);
    assert.equal(none.requiresAuthFixtures, false);
    assert.equal(none.requiresLocalAuthBypass, false);
    assert.equal(none.catalogDigest, fixtureCatalogDigest());

    const demo = resolveFixtureProfile({
        profileId: "demo-public",
        profileSource: "dev-cli",
        freeProfileEnv: ""
    });
    assert.equal(demo.requiresDemoSeed, true);
    assert.equal(demo.requiresLocalAuthBypass, false);

    const acceptance = planFixtureMutation("acceptance-representative");
    assert.equal(acceptance.requiresAuthFixtures, true);
    assert.equal(acceptance.requiresPublicFixtures, true);

    const sealed = sealMatrixFixtureProfile({
        id: "bootstrap",
        fixtureProfile: "acceptance-representative",
        resourceClass: "database",
        requiresBootstrap: "full",
        selfBootstraps: true
    });
    assert.equal(sealed.profileSource, "matrix");
    assert.equal(sealed.profileId, "acceptance-representative");
    const env = applySealedFixtureProfileEnvironment({}, sealed);
    assert.equal(
        env.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID,
        "acceptance-representative"
    );
    assert.equal(env.FSUSBLOG_FIXTURE_PROFILE, "");
    assert.equal(
        env.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST,
        sealed.catalogDigest
    );
    assert.equal(
        env.FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS,
        JSON.stringify(sealed.variantIds)
    );
    assert.equal(
        env.FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST,
        sealed.variantPlanDigest
    );
});

test("matrix resolve fail-closes free profile override and digest drift", () =>
{
    assert.throws(
        () =>
            resolveFixtureProfile({
                profileId: "none",
                profileSource: "matrix",
                freeProfileEnv: "demo-public",
                sealed: {
                    fixtureProfileId: "none",
                    fixtureCatalogDigest: fixtureCatalogDigest(),
                    expandedCapabilityDigest: resolveFixtureProfile({
                        profileId: "none",
                        profileSource: "dev-cli",
                        freeProfileEnv: ""
                    }).expandedCapabilityDigest,
                    executionClass: "runtime"
                }
            }),
        /cannot be overridden by FSUSBLOG_FIXTURE_PROFILE/
    );
    assert.throws(
        () =>
            resolveFixtureProfile({
                profileId: "unknown-profile",
                profileSource: "dev-cli",
                freeProfileEnv: ""
            }),
        /unknown fixture profile/
    );
    const live = resolveFixtureProfile({
        profileId: "public-minimal",
        profileSource: "dev-cli",
        freeProfileEnv: ""
    });
    assert.throws(
        () =>
            resolveFixtureProfile({
                profileId: "public-minimal",
                profileSource: "matrix",
                freeProfileEnv: "",
                sealed: {
                    ...live.sealed,
                    fixtureProfileId: "public-minimal",
                    fixtureCatalogDigest:
                        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    expandedCapabilityDigest: live.expandedCapabilityDigest,
                    fixtureVariantIds: live.variantIds,
                    fixtureVariantPlanDigest: live.variantPlanDigest,
                    executionClass: live.executionClass
                }
            }),
        /catalog digest drifted/
    );
    assert.throws(
        () =>
            resolveFixtureProfile({
                profileId: "public-minimal",
                profileSource: "matrix",
                freeProfileEnv: "",
                sealed: {
                    ...live.sealed,
                    fixtureProfileId: "public-minimal",
                    fixtureCatalogDigest: live.catalogDigest,
                    expandedCapabilityDigest:
                        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    fixtureVariantIds: live.variantIds,
                    fixtureVariantPlanDigest: live.variantPlanDigest,
                    executionClass: live.executionClass
                }
            }),
        /capability digest drifted/
    );
});

test("planned and environment-ready receipts record profile identity", () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), "fixture-receipt-"));
    const currentSchema = currentSchemaAdmissionFixture();
    try
    {
        const plan = resolveFixtureProfile({
            profileId: "none",
            profileSource: "dev-cli",
            freeProfileEnv: ""
        });
        const planned = currentSchema.profilePlan;
        const fixtureReceipt = path.join(directory, "fixture-receipt.json");
        const ready = currentSchema.environmentReady;
        // #1710: kind=fixture-receipt removed; FixtureReceipt v2 is the sole authority.
        assert.throws(
            () =>
                writeFixtureProfileReceipt(fixtureReceipt, plan, {
                    kind: "fixture-receipt",
                    extra: { zeroData: true, mutations: [] }
                }),
            /deleted|FixtureReceipt v2/
        );
        const fixtureReceiptDocument = {
            schema: "fsusblog.fixture-receipt.v2",
            terminalStatus: "verified",
            receiptDigest: `sha256:${"ab".repeat(32)}`,
            profileIdentity: {
                profileId: plan.profileId,
                profileSource: plan.profileSource,
                executionClass: plan.executionClass
            },
            executionIdentity: JSON.parse(
                readFileSync(currentSchema.runtimeTopologyInput, "utf8")
            ).fixtureExecutionIdentity,
            catalogDigest: plan.catalogDigest,
            expandedCapabilityDigest: plan.expandedCapabilityDigest,
            fixtureVariantIds: plan.variantIds,
            variantPlanDigest: plan.variantPlanDigest
        };
        writeCurrentSchemaRuntimeTopologyAdmission(
            currentSchema.admission,
            currentSchema.options
        );
        writeFixtureProfileReceipt(
            ready,
            JSON.parse(readFileSync(planned, "utf8")),
            {
                kind: "environment-ready",
                fixtureReceiptPath: fixtureReceipt,
                fixtureReceiptDigest: fixtureReceiptDocument.receiptDigest,
                fixtureReceiptTerminalStatus: "verified",
                fixtureReceiptDocument,
                currentSchemaRuntimeTopologyAdmissionFile:
                    currentSchema.admission,
                currentSchemaAdmissionOptions: currentSchema.options,
                profilePlanFile: planned
            }
        );
        const readyJson = JSON.parse(readFileSync(ready, "utf8"));
        assert.equal(readyJson.profileId, "none");
        assert.equal(readyJson.profileSource, "dev-cli");
        assert.equal(readyJson.mutationPolicy, "zero-mutation");
        assert.ok(readyJson.catalogDigest.startsWith("sha256:"));
        assert.deepEqual(readyJson.capabilityIds, []);
        assert.deepEqual(readyJson.producerIds, []);
        assert.equal(readyJson.fixtureReceiptPath, fixtureReceipt);
        assert.equal(readyJson.fixtureReceiptTerminalStatus, "verified");
        assert.equal(readyJson.schema, "fsusblog.fixture-environment-ready.v2");
        assert.deepEqual(
            readyJson.currentSchemaRuntimeTopologyAdmission,
            currentSchemaRuntimeTopologyAdmissionBinding(
                currentSchema.admission,
                JSON.parse(readFileSync(currentSchema.admission, "utf8"))
            )
        );
        assert.throws(
            () =>
                writeFixtureProfileReceipt(
                    path.join(directory, "fabricated-environment-ready.json"),
                    JSON.parse(readFileSync(planned, "utf8")),
                    {
                        kind: "environment-ready",
                        currentSchemaRuntimeTopologyAdmission:
                            readyJson.currentSchemaRuntimeTopologyAdmission,
                        profilePlanFile: planned
                    }
                ),
            /requires a verified current schema runtime topology admission/u
        );
        assert.throws(
            () =>
                writeFixtureProfileReceipt(
                    ready,
                    JSON.parse(readFileSync(planned, "utf8")),
                    {
                        kind: "environment-ready",
                        fixtureReceiptPath: fixtureReceipt,
                        fixtureReceiptTerminalStatus: "verified",
                        fixtureReceiptDocument: {
                            ...fixtureReceiptDocument,
                            profileIdentity: {
                                ...fixtureReceiptDocument.profileIdentity,
                                executionClass: "runtime"
                            }
                        },
                        currentSchemaRuntimeTopologyAdmissionFile:
                            currentSchema.admission,
                        currentSchemaAdmissionOptions: currentSchema.options,
                        profilePlanFile: planned
                    }
                ),
            /execution class does not match/
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
        rmSync(currentSchema.directory, { recursive: true, force: true });
    }
});

function currentSchemaAdmissionFixture()
{
    const directory = mkdtempSync(
        path.join(tmpdir(), "fixture-current-schema-admission-")
    );
    const runId = "current-schema-admission-run";
    const sourceCommit = "a".repeat(40);
    const runtimeReady = runtimeReadyReceiptPath(directory, runId);
    const suffix = path
        .basename(runtimeReady)
        .replace(/^current-schema-runtime-ready-/u, "")
        .replace(/\.json$/u, "");
    const admission = path.join(
        directory,
        `current-schema-runtime-topology-admission-${suffix}.json`
    );
    const profilePlan = path.join(directory, "planned-profile.json");
    const environmentReady = path.join(directory, "environment-ready.json");
    const runtimeTopologyInput = path.join(
        directory,
        "runtime-topology-input.json"
    );
    const canonicalPlan = resolveFixtureProfile({
        profileId: "none",
        profileSource: "dev-cli",
        freeProfileEnv: ""
    });
    writeFixtureProfileReceipt(profilePlan, canonicalPlan, {
        kind: "planned-profile"
    });
    const plan = JSON.parse(readFileSync(profilePlan, "utf8"));
    writeFileSync(
        runtimeTopologyInput,
        `${JSON.stringify(
            {
                namespace: "current-schema-dag",
                backendUrl: "http://127.0.0.1:24000",
                frontendUrl: "http://127.0.0.1:26000",
                previewUrl: "http://127.0.0.1:28000",
                containers: {
                    postgres: "fsusblog-test-postgres",
                    redis: "fsusblog-test-redis"
                },
                environmentReadyReceiptPath: environmentReady,
                fixtureExecutionIdentity: {
                    runId,
                    namespace: "current-schema-dag",
                    source: {
                        commit: sourceCommit,
                        worktreeFingerprint: `sha256:${"d".repeat(64)}`
                    },
                    serviceGeneration: `sha256:${"e".repeat(64)}`
                },
                fixtureProfile: {
                    profileId: plan.profileId,
                    profileSource: plan.profileSource,
                    catalogDigest: plan.catalogDigest,
                    expandedCapabilityDigest: plan.expandedCapabilityDigest,
                    capabilityIds: plan.capabilityIds,
                    producerIds: plan.producerIds,
                    mutationPolicy: plan.mutationPolicy
                }
            },
            null,
            2
        )}\n`
    );
    const document = {
        schema: runtimeReadySchema,
        status: "verified",
        qualificationEligible: true,
        runId,
        sourceCommit,
        canonicalIdentity: {
            modelVersion: "fsusblog.current-schema.v2",
            extractorVersion: "fsusblog.current-schema-reflection.v2",
            generatorVersion: "fsusblog.current-schema-projection.v2",
            sourceDigest: "b".repeat(64),
            contentDigest: "c".repeat(64)
        },
        contentDigest: null
    };
    const rewriteRuntimeReady = () =>
    {
        document.contentDigest = currentSchemaCanonicalDigest({
            ...document,
            contentDigest: null
        });
        writeFileSync(runtimeReady, `${JSON.stringify(document, null, 2)}\n`);
    };
    rewriteRuntimeReady();
    const options = {
        receiptRoot: directory,
        runId,
        sourceCommit,
        assembly: path.join(directory, "FsusBlog.Server.dll"),
        serviceCatalog: path.join(directory, "service-catalog.json"),
        serviceEnvelope: path.join(directory, "service-envelope.json"),
        profilePlan,
        runtimeTopologyInput,
        environmentReady,
        verifyRuntimeReady()
        {
            return { terminal: JSON.parse(JSON.stringify(document)) };
        }
    };
    return {
        directory,
        runtimeReady,
        admission,
        profilePlan,
        environmentReady,
        runtimeTopologyInput,
        document,
        options,
        rewriteRuntimeReady
    };
}

test("runtime topology admission binds and reconsumes the exact current schema terminal before spawn", async () =>
{
    const positive = currentSchemaAdmissionFixture();
    try
    {
        const written = writeCurrentSchemaRuntimeTopologyAdmission(
            positive.admission,
            positive.options
        );
        const verified = verifyCurrentSchemaRuntimeTopologyAdmission(
            positive.admission,
            positive.options
        );
        assert.deepEqual(verified, written);
        assert.equal(written.runId, positive.options.runId);
        assert.equal(written.sourceCommit, positive.options.sourceCommit);
        assert.equal(
            written.schema,
            "fsusblog.current-schema-runtime-topology-admission.v2"
        );
        assert.equal(written.profilePlan.path, positive.profilePlan);
        assert.equal(
            written.runtimeTopologyInput.path,
            positive.runtimeTopologyInput
        );
        assert.equal(
            written.environmentReadyReceiptPath,
            positive.environmentReady
        );
        assert.match(written.profilePlan.fileSha256, /^sha256:[a-f0-9]{64}$/u);
        assert.match(
            written.runtimeTopologyInput.fileSha256,
            /^sha256:[a-f0-9]{64}$/u
        );
        assert.equal(
            written.currentSchemaRuntimeReady.path,
            positive.runtimeReady
        );
        assert.equal(lstatSync(positive.admission).nlink, 1);
        assert.deepEqual(
            readdirSync(path.dirname(positive.admission)).filter((entry) =>
                entry.startsWith(`${path.basename(positive.admission)}.next-`)
            ),
            []
        );
        const publicationAlias = `${positive.admission}.next-concurrent-reader`;
        linkSync(positive.admission, publicationAlias);
        const publisher = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                'import fs from "node:fs"; setTimeout(() => fs.unlinkSync(process.argv[1]), 80)',
                publicationAlias
            ],
            { stdio: "ignore" }
        );
        assert.deepEqual(
            verifyCurrentSchemaRuntimeTopologyAdmission(
                positive.admission,
                positive.options
            ),
            written
        );
        await new Promise((resolve, reject) =>
        {
            publisher.once("error", reject);
            publisher.once("exit", (status) =>
                status === 0
                    ? resolve()
                    : reject(new Error(`publication helper exited ${status}`))
            );
        });
        assert.match(
            written.currentSchemaRuntimeReady.fileSha256,
            /^sha256:[a-f0-9]{64}$/u
        );
        assert.equal(
            written.currentSchemaRuntimeReady.contentDigest,
            positive.document.contentDigest
        );
        assert.deepEqual(
            written.currentSchemaRuntimeReady.canonicalIdentity,
            positive.document.canonicalIdentity
        );
    }
    finally
    {
        rmSync(positive.directory, { recursive: true, force: true });
    }

    const cases = [
        {
            label: "missing admission",
            mutate(value)
            {
                rmSync(value.admission);
            },
            expected: /admission is missing/u
        },
        {
            label: "tampered admission",
            mutate(value)
            {
                const terminal = JSON.parse(
                    readFileSync(value.admission, "utf8")
                );
                terminal.currentSchemaRuntimeReady.fileSha256 = `sha256:${"f".repeat(64)}`;
                writeFileSync(
                    value.admission,
                    `${JSON.stringify(terminal, null, 2)}\n`
                );
            },
            expected: /exact terminal mismatch/u
        },
        {
            label: "stale runtime run",
            mutate(value)
            {
                value.document.runId = "stale-run";
                value.rewriteRuntimeReady();
            },
            expected: /terminal identity is invalid/u
        },
        {
            label: "stale runtime source",
            mutate(value)
            {
                value.document.sourceCommit = "d".repeat(40);
                value.rewriteRuntimeReady();
            },
            expected: /terminal identity is invalid/u
        },
        {
            label: "prepared runtime terminal",
            mutate(value)
            {
                value.document.status = "prepared";
                value.document.qualificationEligible = false;
                value.rewriteRuntimeReady();
            },
            expected: /terminal identity is invalid/u
        },
        {
            label: "prepared runtime sibling",
            mutate(value)
            {
                writeFileSync(`${value.runtimeReady}.prepared`, "{}\n");
            },
            expected: /prepared sibling exists/u
        },
        {
            label: "stale planned profile after admission",
            mutate(value)
            {
                const plan = JSON.parse(
                    readFileSync(value.profilePlan, "utf8")
                );
                plan.mutationPolicy = "stale-plan";
                writeFileSync(
                    value.profilePlan,
                    `${JSON.stringify(plan, null, 2)}\n`
                );
            },
            expected: /canonical catalogs|exact terminal mismatch/u
        },
        {
            label: "stale runtime topology input after admission",
            mutate(value)
            {
                const input = JSON.parse(
                    readFileSync(value.runtimeTopologyInput, "utf8")
                );
                input.previewUrl = "http://127.0.0.1:29998";
                writeFileSync(
                    value.runtimeTopologyInput,
                    `${JSON.stringify(input, null, 2)}\n`
                );
            },
            expected: /exact terminal mismatch/u
        },
        {
            label: "runtime-ready replacement after independent verifier",
            mutate(value)
            {
                const independentlyVerified = JSON.parse(
                    JSON.stringify(value.document)
                );
                value.options.verifyRuntimeReady = () =>
                {
                    value.document.canonicalIdentity = {
                        ...value.document.canonicalIdentity,
                        sourceDigest: "9".repeat(64)
                    };
                    value.rewriteRuntimeReady();
                    return { terminal: independentlyVerified };
                };
            },
            expected: /independently recomputed terminal/u
        }
    ];
    for (const entry of cases)
    {
        const value = currentSchemaAdmissionFixture();
        let candidateSpawns = 0;
        try
        {
            writeCurrentSchemaRuntimeTopologyAdmission(
                value.admission,
                value.options
            );
            entry.mutate(value);
            assert.throws(
                () =>
                {
                    verifyCurrentSchemaRuntimeTopologyAdmission(
                        value.admission,
                        value.options
                    );
                    candidateSpawns += 1;
                },
                entry.expected,
                entry.label
            );
            assert.equal(
                candidateSpawns,
                0,
                `${entry.label} must block candidate spawn`
            );
        }
        finally
        {
            rmSync(value.directory, { recursive: true, force: true });
        }
    }
});

function buildNoneFixtureReceipt(plan, executionIdentity)
{
    return buildFixtureReceipt({
        terminalStatus: "verified",
        executionIdentity,
        profileIdentity: {
            profileId: plan.profileId,
            profileSource: plan.profileSource,
            executionClass: plan.executionClass,
            sealed: false
        },
        catalogDigest: plan.catalogDigest,
        expandedCapabilityDigest: plan.expandedCapabilityDigest,
        fixtureVariantIds: plan.fixtureVariantIds,
        variantPlanDigest: plan.fixtureVariantPlanDigest,
        producerReceipts: [],
        capabilityMap: [],
        outputArtifacts: []
    });
}

function currentSchemaTerminalDagFixture({ withFixtureReceipt = false } = {})
{
    const currentSchema = currentSchemaAdmissionFixture();
    writeCurrentSchemaRuntimeTopologyAdmission(
        currentSchema.admission,
        currentSchema.options
    );
    const planFile = currentSchema.profilePlan;
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    const environmentReady = currentSchema.environmentReady;
    const runtimeTopologyInput = currentSchema.runtimeTopologyInput;
    const runtimeTopology = path.join(
        currentSchema.directory,
        "runtime-topology.json"
    );
    const fixtureReceiptPath = withFixtureReceipt
        ? path.join(currentSchema.directory, "fixture-receipt.json")
        : null;
    const fixtureReceiptDocument = withFixtureReceipt
        ? buildNoneFixtureReceipt(
              plan,
              JSON.parse(readFileSync(runtimeTopologyInput, "utf8"))
                  .fixtureExecutionIdentity
          )
        : null;
    if (fixtureReceiptDocument !== null)
    {
        writeFixtureReceipt(fixtureReceiptPath, fixtureReceiptDocument);
    }
    writeFixtureProfileReceipt(environmentReady, plan, {
        kind: "environment-ready",
        fixtureReceiptPath,
        fixtureReceiptDigest: fixtureReceiptDocument?.receiptDigest ?? null,
        fixtureReceiptTerminalStatus:
            fixtureReceiptDocument === null
                ? "prepared-unverified"
                : "verified",
        fixtureReceiptDocument,
        currentSchemaRuntimeTopologyAdmissionFile: currentSchema.admission,
        currentSchemaAdmissionOptions: currentSchema.options,
        profilePlanFile: planFile
    });
    writeAcceptanceRuntimeTopology(
        runtimeTopology,
        runtimeTopologyInput,
        environmentReady,
        currentSchema.admission,
        currentSchema.options
    );
    return {
        ...currentSchema,
        planFile,
        environmentReady,
        runtimeTopologyInput,
        runtimeTopology,
        fixtureReceiptPath,
        fixtureReceiptDocument,
        dagOptions: {
            admissionFile: currentSchema.admission,
            environmentReadyFile: environmentReady,
            runtimeTopologyFile: runtimeTopology,
            ...currentSchema.options
        }
    };
}

function mutateAndResealCurrentSchemaDagReceipt(file, mutate)
{
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    mutate(receipt);
    receipt.contentDigest = currentSchemaCanonicalDigest({
        ...receipt,
        contentDigest: null
    });
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

function sha256File(file)
{
    return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function resealEnvironmentFixtureBinding(
    value,
    fixtureReceiptPath,
    fixtureReceiptDigest
)
{
    mutateAndResealCurrentSchemaDagReceipt(
        value.environmentReady,
        (receipt) =>
        {
            receipt.fixtureReceiptPath = fixtureReceiptPath;
            receipt.fixtureReceiptDigest = fixtureReceiptDigest;
            receipt.fixtureReceiptTerminalStatus = "verified";
        }
    );
    mutateAndResealCurrentSchemaDagReceipt(value.runtimeTopology, (receipt) =>
    {
        receipt.environmentReady.fileSha256 = sha256File(
            value.environmentReady
        );
        receipt.environmentReady.contentDigest = JSON.parse(
            readFileSync(value.environmentReady, "utf8")
        ).contentDigest;
    });
}

test("terminal DAG rejects coordinated cross-run FixtureReceipt identities and path aliases", async () =>
{
    const identityCases = [
        ["runId", (identity) => ({ ...identity, runId: "stale-run" })],
        [
            "namespace",
            (identity) => ({ ...identity, namespace: "stale-namespace" })
        ],
        [
            "source commit",
            (identity) => ({
                ...identity,
                source: { ...identity.source, commit: "f".repeat(40) }
            })
        ],
        [
            "source fingerprint",
            (identity) => ({
                ...identity,
                source: {
                    ...identity.source,
                    worktreeFingerprint: `sha256:${"1".repeat(64)}`
                }
            })
        ],
        [
            "service generation",
            (identity) => ({
                ...identity,
                serviceGeneration: `sha256:${"2".repeat(64)}`
            })
        ]
    ];
    for (const [label, mutateIdentity] of identityCases)
    {
        const value = currentSchemaTerminalDagFixture({
            withFixtureReceipt: true
        });
        try
        {
            const plan = JSON.parse(readFileSync(value.planFile, "utf8"));
            const staleReceipt = buildNoneFixtureReceipt(
                plan,
                mutateIdentity(value.fixtureReceiptDocument.executionIdentity)
            );
            writeFileSync(
                value.fixtureReceiptPath,
                `${JSON.stringify(staleReceipt, null, 2)}\n`
            );
            resealEnvironmentFixtureBinding(
                value,
                value.fixtureReceiptPath,
                staleReceipt.receiptDigest
            );
            await assert.rejects(
                verifyCurrentSchemaTerminalDag(value.dagOptions),
                /execution identity mismatch/u,
                label
            );
        }
        finally
        {
            rmSync(value.directory, { recursive: true, force: true });
        }
    }

    for (const aliasKind of ["hardlink", "parent-symlink"])
    {
        const value = currentSchemaTerminalDagFixture({
            withFixtureReceipt: true
        });
        const parentAlias = `${value.directory}-alias`;
        try
        {
            let alias;
            if (aliasKind === "hardlink")
            {
                alias = path.join(
                    value.directory,
                    "fixture-receipt-hardlink.json"
                );
                linkSync(value.fixtureReceiptPath, alias);
            }
            else
            {
                symlinkSync(value.directory, parentAlias, "dir");
                alias = path.join(
                    parentAlias,
                    path.basename(value.fixtureReceiptPath)
                );
            }
            resealEnvironmentFixtureBinding(
                value,
                alias,
                value.fixtureReceiptDocument.receiptDigest
            );
            await assert.rejects(
                verifyCurrentSchemaTerminalDag(value.dagOptions),
                /canonical regular file/u,
                aliasKind
            );
        }
        finally
        {
            if (aliasKind === "parent-symlink")
            {
                rmSync(parentAlias, { force: true });
            }
            rmSync(value.directory, { recursive: true, force: true });
        }
    }
});

test("environment-ready and runtime topology form an immutable exact terminal DAG", async () =>
{
    const positive = currentSchemaTerminalDagFixture();
    try
    {
        const result = await verifyCurrentSchemaTerminalDag(
            positive.dagOptions
        );
        assert.deepEqual(
            result.environmentReady.currentSchemaRuntimeTopologyAdmission,
            result.binding
        );
        assert.deepEqual(
            result.runtimeTopology.currentSchemaRuntimeTopologyAdmission,
            result.binding
        );
        assert.throws(
            () =>
                writeFixtureProfileReceipt(
                    positive.environmentReady,
                    JSON.parse(readFileSync(positive.planFile, "utf8")),
                    {
                        kind: "environment-ready",
                        currentSchemaRuntimeTopologyAdmissionFile:
                            positive.admission,
                        currentSchemaAdmissionOptions: positive.options,
                        profilePlanFile: positive.planFile
                    }
                ),
            /environment-ready terminal already exists/u
        );
        assert.throws(
            () =>
                writeAcceptanceRuntimeTopology(
                    positive.runtimeTopology,
                    positive.runtimeTopologyInput,
                    positive.environmentReady,
                    positive.admission,
                    positive.options
                ),
            /runtime topology terminal already exists/u
        );
    }
    finally
    {
        rmSync(positive.directory, { recursive: true, force: true });
    }

    const cases = [
        {
            label: "missing environment-ready child",
            mutate(value)
            {
                rmSync(value.environmentReady);
            },
            expected: /environment-ready receipt is missing/u
        },
        {
            label: "missing runtime-topology child",
            mutate(value)
            {
                rmSync(value.runtimeTopology);
            },
            expected: /runtime topology receipt is missing/u
        },
        {
            label: "prepared current-schema parent",
            mutate(value)
            {
                writeFileSync(`${value.runtimeReady}.prepared`, "{}\n");
            },
            expected: /prepared sibling exists/u
        },
        {
            label: "prepared environment-ready child",
            mutate(value)
            {
                mutateAndResealCurrentSchemaDagReceipt(
                    value.environmentReady,
                    (receipt) =>
                    {
                        receipt.status = "prepared";
                        receipt.qualificationEligible = false;
                    }
                );
            },
            expected:
                /environment-ready current schema parent binding mismatch/u
        },
        {
            label: "prepared environment-ready sibling",
            mutate(value)
            {
                writeFileSync(`${value.environmentReady}.prepared`, "{}\n");
            },
            expected: /prepared or publication alias sibling/u
        },
        {
            label: "crash alias environment-ready sibling",
            mutate(value)
            {
                writeFileSync(`${value.environmentReady}.next-crash`, "{}\n");
            },
            expected: /prepared or publication alias sibling/u
        },
        {
            label: "hardlink environment-ready alias",
            mutate(value)
            {
                linkSync(
                    value.environmentReady,
                    `${value.environmentReady}.alias`
                );
            },
            expected: /canonical regular file/u
        },
        {
            label: "prepared runtime-topology child",
            mutate(value)
            {
                mutateAndResealCurrentSchemaDagReceipt(
                    value.runtimeTopology,
                    (receipt) =>
                    {
                        receipt.status = "prepared";
                        receipt.qualificationEligible = false;
                    }
                );
            },
            expected:
                /runtime topology current schema parent binding mismatch/u
        },
        {
            label: "extra environment-ready field",
            mutate(value)
            {
                const receipt = JSON.parse(
                    readFileSync(value.environmentReady, "utf8")
                );
                receipt.secondAuthority = true;
                writeFileSync(
                    value.environmentReady,
                    `${JSON.stringify(receipt, null, 2)}\n`
                );
            },
            expected: /environment-ready key set mismatch/u
        },
        {
            label: "missing runtime-topology field",
            mutate(value)
            {
                const receipt = JSON.parse(
                    readFileSync(value.runtimeTopology, "utf8")
                );
                delete receipt.input;
                writeFileSync(
                    value.runtimeTopology,
                    `${JSON.stringify(receipt, null, 2)}\n`
                );
            },
            expected: /runtime topology key set mismatch/u
        },
        {
            label: "tampered environment-ready parent",
            mutate(value)
            {
                const receipt = JSON.parse(
                    readFileSync(value.environmentReady, "utf8")
                );
                receipt.currentSchemaRuntimeTopologyAdmission.fileSha256 = `sha256:${"9".repeat(64)}`;
                writeFileSync(
                    value.environmentReady,
                    `${JSON.stringify(receipt, null, 2)}\n`
                );
            },
            expected:
                /environment-ready current schema parent binding mismatch/u
        },
        {
            label: "fabricated fixture completeness",
            mutate(value)
            {
                mutateAndResealCurrentSchemaDagReceipt(
                    value.environmentReady,
                    (receipt) =>
                    {
                        receipt.fixtureReceiptPath = path.join(
                            value.directory,
                            "fabricated-fixture-receipt.json"
                        );
                        receipt.fixtureReceiptDigest = `sha256:${"7".repeat(64)}`;
                        receipt.fixtureReceiptTerminalStatus = "verified";
                    }
                );
            },
            expected: /FixtureReceipt|missing/u
        },
        {
            label: "unbound environment-ready timestamp",
            mutate(value)
            {
                mutateAndResealCurrentSchemaDagReceipt(
                    value.environmentReady,
                    (receipt) =>
                    {
                        receipt.generatedAt = new Date().toISOString();
                    }
                );
            },
            expected: /environment-ready key set mismatch/u
        },
        {
            label: "coordinated plan reseal",
            mutate(value)
            {
                const plan = JSON.parse(readFileSync(value.planFile, "utf8"));
                plan.mutationPolicy = "coordinated-reseal";
                writeFileSync(
                    value.planFile,
                    `${JSON.stringify(plan, null, 2)}\n`
                );
            },
            expected: /canonical catalogs|exact terminal mismatch/u
        },
        {
            label: "coordinated runtime topology input reseal",
            mutate(value)
            {
                const input = JSON.parse(
                    readFileSync(value.runtimeTopologyInput, "utf8")
                );
                input.backendUrl = "http://127.0.0.1:29999";
                writeFileSync(
                    value.runtimeTopologyInput,
                    `${JSON.stringify(input, null, 2)}\n`
                );
                mutateAndResealCurrentSchemaDagReceipt(
                    value.runtimeTopology,
                    (receipt) =>
                    {
                        receipt.input.fileSha256 = `sha256:${"6".repeat(64)}`;
                        receipt.topology = input;
                    }
                );
            },
            expected:
                /exact terminal mismatch|not bound by the common admission/u
        },
        {
            label: "tampered runtime-topology parent",
            mutate(value)
            {
                const receipt = JSON.parse(
                    readFileSync(value.runtimeTopology, "utf8")
                );
                receipt.currentSchemaRuntimeTopologyAdmission.contentDigest = `sha256:${"8".repeat(64)}`;
                writeFileSync(
                    value.runtimeTopology,
                    `${JSON.stringify(receipt, null, 2)}\n`
                );
            },
            expected:
                /runtime topology current schema parent binding mismatch/u
        },
        {
            label: "resealed runtime-topology child identity",
            mutate(value)
            {
                mutateAndResealCurrentSchemaDagReceipt(
                    value.runtimeTopology,
                    (receipt) =>
                    {
                        receipt.topology.fixtureProfile.profileSource =
                            "matrix";
                    }
                );
            },
            expected:
                /runtime topology current schema parent binding mismatch/u
        }
    ];
    for (const entry of cases)
    {
        const value = currentSchemaTerminalDagFixture();
        let candidateSpawns = 0;
        try
        {
            entry.mutate(value);
            await assert.rejects(
                async () =>
                {
                    await verifyCurrentSchemaTerminalDag(value.dagOptions);
                    candidateSpawns += 1;
                },
                entry.expected,
                entry.label
            );
            assert.equal(
                candidateSpawns,
                0,
                `${entry.label} must block candidate spawn`
            );
        }
        finally
        {
            rmSync(value.directory, { recursive: true, force: true });
        }
    }

    const left = currentSchemaTerminalDagFixture();
    const right = currentSchemaTerminalDagFixture();
    let swappedCandidateSpawns = 0;
    try
    {
        await assert.rejects(async () =>
        {
            await verifyCurrentSchemaTerminalDag({
                ...left.dagOptions,
                runtimeTopologyFile: right.runtimeTopology
            });
            swappedCandidateSpawns += 1;
        }, /runtime topology current schema parent binding mismatch|environmentReadyReceiptPath/u);
        assert.equal(swappedCandidateSpawns, 0);
    }
    finally
    {
        rmSync(left.directory, { recursive: true, force: true });
        rmSync(right.directory, { recursive: true, force: true });
    }
});

test("bootstrap and start entrypoints no longer hide default fixture injection", () =>
{
    const start = readFileSync(path.join(root, "tools/dev/start.sh"), "utf8");
    const bootstrap = readFileSync(
        path.join(root, "tools/bootstrap-acceptance-env.sh"),
        "utf8"
    );
    assert.doesNotMatch(start, /--seed-demo|SEED_DEMO/u);
    assert.match(start, /FIXTURE_PROFILE="none"/u);
    assert.match(start, /--fixture-profile/u);
    assert.match(
        start,
        /PLAN_RESOLVE_ARGS\+=\(--execution-class development\)/u
    );
    assert.doesNotMatch(start, /--kind environment-ready/u);
    assert.match(
        start,
        /qualification environment-ready receipt: not produced by the development entrypoint/u
    );
    assert.match(start, /fixture-receipt-\$\{PROFILE_ID\}\.json/u);
    assert.match(start, /dev-transition/u);
    for (const identityOption of [
        "--run-id",
        "--namespace",
        "--source-commit",
        "--source-fingerprint",
        "--service-generation"
    ])
    {
        assert.match(start, new RegExp(identityOption, "u"));
    }
    assert.match(start, /fsus__allowLocalDemoFixtureCleanup/u);
    assert.match(start, /tools\/test-fixtures\/cli\.mjs" cleanup/u);
    assert.ok(
        start.indexOf('tools/test-fixtures/cli.mjs" cleanup') <
            start.indexOf("unlinkSync(process.argv[1])"),
        "the prior demo receipt must be deleted only after cleanup succeeds"
    );
    assert.doesNotMatch(start, /preparing persistent local auth fixtures/u);
    assert.match(bootstrap, /ResolveFixtureProfilePlan/u);
    assert.match(bootstrap, /InvokeFixtureOrchestrator/u);
    assert.doesNotMatch(
        bootstrap,
        /RESET_SECURITY_TEST_STATE="\$\{FSUSBLOG_RESET_SECURITY_TEST_STATE:-1\}"/u
    );
    assert.doesNotMatch(bootstrap, /RESET_SECURITY_TEST_STATE=/u);
    assert.doesNotMatch(bootstrap, /FIXTURE_REQUIRES_SECURITY_RESET/u);
    assert.match(bootstrap, /ConfigureLocalAuthFixture/u);
    assert.match(bootstrap, /fsus__allowLocalAuthFixture=true/u);
    assert.match(bootstrap, /FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET/u);
    // Unconditional PrepareFixtures() call must not remain in Main order after WaitForPowReady.
    const mainStart = bootstrap.indexOf("Main()");
    const main = bootstrap.slice(
        mainStart,
        bootstrap.indexOf(
            'if [[ "${FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0}"',
            mainStart
        )
    );
    assert.doesNotMatch(main, /^\s*PrepareFixtures\s*$/mu);
    assert.match(main, /InvokeFixtureOrchestrator/u);
    assert.match(
        main,
        /PrepareReleasePreviewBundle[\s\S]*?-z "\$\{FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-\}"[\s\S]*?date -u[\s\S]*?EnsureFixtureTemporalContext[\s\S]*?RunBootstrapParallel 'runtime applications'[\s\S]*?WaitForPowReady[\s\S]*?InvokeFixtureOrchestrator/u
    );
    assert.match(
        bootstrap,
        /EnsureFixtureTemporalContext\(\)[\s\S]*?write-temporal-context\.mjs[\s\S]*?FSUSBLOG_TEMPORAL_CONTEXT_FILE[\s\S]*?WriteEnvFile/u
    );
});

test("generated document rejects a hand-written validity category absent from the catalog", () =>
{
    const directory = mkdtempSync(path.join(tmpdir(), "fixture-doc-drift-"));
    try
    {
        const document = path.join(directory, "fixture-capability-catalog.md");
        writeFileSync(
            document,
            `${readFileSync(path.join(root, "docs/testing/fixture-capability-catalog.md"), "utf8")}\n| compat-positive | hand-written category |\n`
        );
        const result = spawnSync(
            process.execPath,
            ["tools/testing/generate-fixture-catalog-artifacts.mjs", "--check"],
            {
                cwd: root,
                encoding: "utf8",
                env: {
                    ...process.env,
                    FSUSBLOG_FIXTURE_DOCUMENT_FILE: document
                }
            }
        );
        assert.notEqual(result.status, 0);
        assert.match(
            result.stderr,
            /fixture catalog generated artifacts drift/
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("docs profile table matches catalog profile set exactly", () =>
{
    const catalogs = {
        profile: JSON.parse(readFileSync(fixtureCatalogFiles.profile, "utf8"))
    };
    const document = readFileSync(
        path.join(root, "docs/testing/fixture-capability-catalog.md"),
        "utf8"
    );
    const catalogIds = catalogs.profile.profiles.map((item) => item.id).sort();
    const profileTable = document.slice(document.indexOf("| Profile |"));
    const docIds = [...profileTable.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gmu)]
        .map((match) => match[1])
        .sort();
    assert.deepEqual(docIds, catalogIds);
});
