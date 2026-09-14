import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {prepareNamespaceEnvironmentIfNeeded} = await import(new URL('../../tools/run-test-matrix.mjs', import.meta.url));
const {currentProcessIdentity} = await import(new URL('../../tools/test/process-identity.mjs', import.meta.url));
const {createArtifactDigestTable} = await import(new URL('../../tools/test-matrix/artifact-digest-table.mjs', import.meta.url));
const {digestDeclaredOutputs, resolveRunBoundArtifactDeclaration} = await import(new URL('../../tools/test-matrix/local-profile.mjs', import.meta.url));
const {assertSafeProductionBuildRunRoot, bindProductionBuildLayoutSource, collectStaleProductionBuildRoots, dotnetProjectLayout, finalizeProductionBuildLayout, prepareProductionBuildLayout, prepareProductionRuntimeLayout, productionBuildEnvironment, productionBuildLayoutDigest, productionDotnetArtifacts, productionRuntimeEnvironment, resolveProductionBuildLayout} = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const {createSchedulerRunOwner, schedulerCandidateIdentityDigest} = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const {snapshotTierOutputs} = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const {resolveFixtureProfile} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
function repositoryFixture(t)
{
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "fsusblog-build-layout-")
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function prepareBoundLayout(root, runId, sourceState)
{
    const namespace = `test:${runId}`;
    const layout = prepareProductionBuildLayout({
        root,
        runId,
        sourceState,
        namespace
    });
    const identity = currentProcessIdentity();
    const lock = path.join(root, ".tmp/test-runs/.locks", `${runId}.lock`);
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(
        path.join(lock, "owner.json"),
        `${JSON.stringify(
            createSchedulerRunOwner({
                runId,
                targetTierId: "fixture",
                candidateIdentityDigest: schedulerCandidateIdentityDigest({
                    runId,
                    targetTierId: "fixture",
                    namespace,
                    sourceState
                }),
                ownerToken: `token-${runId}`,
                identity
            })
        )}\n`
    );
    bindProductionBuildLayoutSource(layout, sourceState);
    return layout;
}

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);

test("official namespace pre-bootstrap binds scheduler run source build and sealed fixture identity without ambient run id", (t) =>
{
    const root = repositoryFixture(t);
    const runId = "browser-contract-scheduler-run";
    const namespace = "browser-contract-scheduler-namespace";
    const sourceState = {
        commit: "a".repeat(40),
        worktreeFingerprint: "b".repeat(64)
    };
    const layout = prepareProductionBuildLayout({
        root,
        runId,
        sourceState,
        namespace
    });
    const environmentRoot = path.join(root, "acceptance-env");
    const artifactRoot = path.join(root, "canonical-production-build");
    const receiptDigest = `sha256:${"c".repeat(64)}`;
    const fixturePlan = resolveFixtureProfile({
        profileId: "acceptance-representative",
        profileSource: "dev-cli",
        freeProfileEnv: ""
    });
    let invocation = null;
    const tier = {
        id: "browser-contract",
        ciJob: "browser-contract",
        fixtureProfile: fixturePlan.profileId,
        resourceClass: "browser",
        requiresBootstrap: "full",
        selfBootstraps: true
    };

    prepareNamespaceEnvironmentIfNeeded([tier], namespace, {
        runId,
        sourceState,
        buildLayout: layout,
        environment: {
            FSUSBLOG_ACCEPTANCE_ENV_ROOT: environmentRoot,
            FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: artifactRoot,
            FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: receiptDigest,
            FSUSBLOG_CI_PRODUCTION_DOMAINS: "ambient-consumer-domains"
        },
        ambientEnvironment: {
            FSUSBLOG_TEST_RUN_ID: "ambient-run-must-not-win",
            FSUSBLOG_TEST_SOURCE_COMMIT: "d".repeat(40),
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: "e".repeat(64),
            FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: "ambient-profile-must-not-win"
        },
        repositoryRoot: root,
        spawn(command, args, options)
        {
            invocation = { command, args, options };
            return { status: 0, stdout: "", stderr: "" };
        }
    });

    assert.ok(invocation);
    assert.equal(invocation.command, "bash");
    assert.deepEqual(invocation.args, [
        path.join(root, "tools/bootstrap-acceptance-env.sh"),
        "--prepare-env-only"
    ]);
    assert.equal(invocation.options.env.FSUSBLOG_TEST_RUN_ID, runId);
    assert.equal(invocation.options.env.FSUSBLOG_TEST_NAMESPACE, namespace);
    assert.equal(
        invocation.options.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        sourceState.commit
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT,
        sourceState.worktreeFingerprint
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT,
        artifactRoot
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST,
        receiptDigest
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_CI_PRODUCTION_DOMAINS,
        "ambient-consumer-domains"
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_PRODUCTION_BUILD_ROOT,
        layout.runRoot
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_BACKEND_SERVER_DLL,
        layout.artifacts.serverDll
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_BACKEND_TEST_BIN_DIR,
        layout.artifacts.tests.outputDirectory
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_FRONTEND_DIST_ROOT,
        layout.frontendDist
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_FRONTEND_WASM_ROOT,
        layout.frontendWasm
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_BACKEND_WEBROOT,
        layout.backendWebRoot
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_GENERATED_OUTPUT_ROOT,
        layout.generatedRoot
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID,
        fixturePlan.profileId
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_FIXTURE_PROFILE_SOURCE,
        "matrix"
    );
    assert.equal(
        invocation.options.env.FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS,
        "browser"
    );
    assert.match(
        invocation.options.env.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST,
        /^sha256:[a-f0-9]{64}$/u
    );
    assert.match(
        invocation.options.env.FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST,
        /^sha256:[a-f0-9]{64}$/u
    );
    assert.equal(invocation.options.env.FSUSBLOG_FIXTURE_PROFILE, "");
});

test("namespace plan-only bootstrap succeeds without a production artifact receipt", (t) =>
{
    const temporary = repositoryFixture(t);
    const runId = `plan-only-${process.pid}`;
    const namespace = `plan-only-${process.pid}`;
    const sourceState = {
        commit: "a".repeat(40),
        worktreeFingerprint: "b".repeat(64)
    };
    const layout = prepareProductionBuildLayout({
        root: temporary,
        runId,
        sourceState,
        namespace
    });
    const fixturePlan = resolveFixtureProfile({
        profileId: "acceptance-representative",
        profileSource: "dev-cli",
        freeProfileEnv: ""
    });
    const environmentRoot = path.join(temporary, "env");
    prepareNamespaceEnvironmentIfNeeded(
        [
            {
                id: "local-production-runtime-browser",
                ciJob: "local-production",
                fixtureProfile: fixturePlan.profileId,
                resourceClass: "browser",
                requiresBootstrap: "full",
                selfBootstraps: true
            }
        ],
        namespace,
        {
            runId,
            sourceState,
            buildLayout: layout,
            environment: {
                FSUSBLOG_ACCEPTANCE_ENV_ROOT: environmentRoot,
                FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: path.join(
                    temporary,
                    "fixtures"
                ),
                FSUSBLOG_DATA_ROOT: path.join(temporary, "data"),
                FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: path.join(
                    temporary,
                    "missing-artifact-root"
                ),
                FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: `sha256:${"c".repeat(64)}`,
                FSUSBLOG_CI_PRODUCTION_DOMAINS: "backend-runtime"
            },
            repositoryRoot,
            consumeProductionBuildArtifacts: false
        }
    );
    assert.ok(fs.existsSync(path.join(environmentRoot, `${namespace}.env`)));
});

test("MSBuild policy excludes legacy project-tree bin/obj after relocating the SDK intermediate root", () =>
{
    const props = fs.readFileSync(
        path.join(repositoryRoot, "Directory.Build.props"),
        "utf8"
    );
    assert.match(
        props,
        /BaseOutputPath[\s\S]*?BaseIntermediateOutputPath[\s\S]*?MSBuildProjectExtensionsPath/u
    );
    assert.match(
        props,
        /DefaultItemExcludes>\$\(DefaultItemExcludes\);bin\/\*\*;obj\/\*\*/u
    );
});

test("run-bound layout isolates every MSBuild project and exposes canonical artifacts", (t) =>
{
    const root = repositoryFixture(t);
    const layout = prepareProductionBuildLayout({
        root,
        runId: "production-current"
    });
    const projects = [
        dotnetProjectLayout(layout, "src/backend/FsusBlog.Server.csproj"),
        dotnetProjectLayout(
            layout,
            "tests/backend/FsusBlog.Server.Tests.csproj"
        ),
        dotnetProjectLayout(
            layout,
            "benchmarks/core/FsusBlog.Core.Benchmarks.csproj"
        )
    ];
    assert.equal(
        new Set(projects.map((project) => project.projectExtensionsPath)).size,
        projects.length
    );
    assert.equal(
        new Set(projects.map((project) => project.baseIntermediateOutputPath))
            .size,
        projects.length
    );
    assert.ok(
        projects.every((project) =>
            project.projectExtensionsPath.startsWith(
                `${layout.dotnetRoot}${path.sep}`
            )
        )
    );

    const artifacts = productionDotnetArtifacts(layout);
    const env = productionBuildEnvironment(layout, { SENTINEL: "kept" });
    assert.equal(env.SENTINEL, "kept");
    assert.equal(env.FSUSBLOG_BACKEND_SERVER_DLL, artifacts.serverDll);
    assert.equal(env.FSUSBLOG_BACKEND_TEST_DLL, artifacts.testDll);
    assert.equal(env.FSUSBLOG_BENCHMARK_DLL, artifacts.benchmarkDll);
    assert.equal(env.ASPNETCORE_WEBROOT, layout.backendWebRoot);
    assert.equal(
        env.FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT,
        layout.frontendSsrRuntime
    );
    assert.equal(
        env.FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT,
        "./server/server-public-ssr.bundle.mjs"
    );
    assert.equal(env.FSUSBLOG_WASM_ARTIFACT_ROOT, layout.wasmArtifacts);
    assert.equal(
        env.FSUSBLOG_ARTIFACT_DIGEST_TABLE,
        path.join(layout.generatedRoot, "artifact-digest-table.json")
    );
});

test("runtime writes use disposable overlays and cannot mutate sealed build roots", (t) =>
{
    const root = repositoryFixture(t);
    const layout = prepareProductionBuildLayout({
        root,
        runId: "production-runtime-overlay"
    });
    for (const directory of [layout.frontendDist, layout.backendWebRoot])
    {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
            path.join(directory, "index.html"),
            "<!doctype html>\n"
        );
    }
    const immutableFrontend = fs.readFileSync(
        path.join(layout.frontendDist, "index.html"),
        "utf8"
    );
    const immutableBackend = fs.readFileSync(
        path.join(layout.backendWebRoot, "index.html"),
        "utf8"
    );
    const artifactTable = createArtifactDigestTable({
        root,
        file: path.join(layout.generatedRoot, "artifact-digest-table.json"),
        runId: layout.runId,
        sourceState: {
            commit: "a".repeat(40),
            worktreeFingerprint: "b".repeat(64)
        }
    });
    artifactTable.digestDeclarations(
        ["src/frontend/dist", "src/backend/wwwroot"],
        {
            env: productionBuildEnvironment(layout, {}),
            producer: {
                bundle: "build-static",
                step: "matrix-runtime-artifacts"
            }
        }
    );

    const runtime = prepareProductionRuntimeLayout(layout);
    const env = productionRuntimeEnvironment(layout, { SENTINEL: "runtime" });
    assert.equal(env.SENTINEL, "runtime");
    assert.equal(env.FSUSBLOG_FRONTEND_DIST_ROOT, runtime.runtimeFrontendDist);
    assert.equal(env.FSUSBLOG_BACKEND_WEBROOT, runtime.runtimeBackendWebRoot);
    assert.equal(env.ASPNETCORE_WEBROOT, runtime.runtimeBackendWebRoot);
    assert.notEqual(env.FSUSBLOG_FRONTEND_DIST_ROOT, layout.frontendDist);
    assert.notEqual(env.FSUSBLOG_BACKEND_WEBROOT, layout.backendWebRoot);

    fs.mkdirSync(path.join(runtime.runtimeFrontendDist, "aot-cache/payloads"), {
        recursive: true
    });
    fs.writeFileSync(
        path.join(
            runtime.runtimeFrontendDist,
            "aot-cache/payloads/runtime.aeds"
        ),
        "runtime"
    );
    fs.mkdirSync(path.join(runtime.runtimeBackendWebRoot, "search"), {
        recursive: true
    });
    fs.writeFileSync(
        path.join(runtime.runtimeBackendWebRoot, "search/index.bin"),
        "runtime"
    );
    assert.equal(
        fs.readFileSync(path.join(layout.frontendDist, "index.html"), "utf8"),
        immutableFrontend
    );
    assert.equal(
        fs.readFileSync(path.join(layout.backendWebRoot, "index.html"), "utf8"),
        immutableBackend
    );
    assert.equal(
        fs.existsSync(path.join(layout.frontendDist, "aot-cache")),
        false
    );
    assert.equal(
        fs.existsSync(path.join(layout.backendWebRoot, "search")),
        false
    );
    assert.doesNotThrow(() => artifactTable.finalize());
});

test("layout identity binds run, source fingerprint and digest before readiness consumption", (t) =>
{
    const root = repositoryFixture(t);
    const sourceState = {
        commit: "a".repeat(40),
        worktreeFingerprint: "b".repeat(64)
    };
    const layout = prepareBoundLayout(root, "release-final-42", sourceState);
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, "utf8"));
    assert.deepEqual(manifest.sourceState, sourceState);
    const identityDigest = productionBuildLayoutDigest(layout);
    assert.match(identityDigest, /^sha256:[a-f0-9]{64}$/u);

    fs.mkdirSync(layout.frontendDist, { recursive: true });
    fs.writeFileSync(
        path.join(layout.frontendDist, "index.html"),
        "<!doctype html>"
    );
    const canonical = "src/frontend/dist/index.html";
    const actual = path
        .relative(root, path.join(layout.frontendDist, "index.html"))
        .replaceAll(path.sep, "/");
    const env = productionBuildEnvironment(layout, {
        FSUSBLOG_TEST_RUN_ID: layout.runId,
        FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
    });
    assert.equal(
        resolveRunBoundArtifactDeclaration(root, canonical, env),
        actual
    );
    assert.match(
        digestDeclaredOutputs(root, [canonical], env)[canonical],
        /^sha256:/u
    );
    assert.equal(fs.existsSync(env.FSUSBLOG_ARTIFACT_DIGEST_TABLE), true);
    finalizeProductionBuildLayout(layout, { status: "success" });
    assert.equal(productionBuildLayoutDigest(layout), identityDigest);
});

test("a run root cannot be rebound to another source identity while retaining its artifacts", (t) =>
{
    const root = repositoryFixture(t);
    const originalSource = {
        commit: "a".repeat(40),
        worktreeFingerprint: "b".repeat(64)
    };
    const layout = prepareBoundLayout(root, "immutable-source", originalSource);
    fs.mkdirSync(layout.frontendDist, { recursive: true });
    const artifact = path.join(layout.frontendDist, "index.html");
    fs.writeFileSync(artifact, "original-source");
    const originalDigest = productionBuildLayoutDigest(layout);

    assert.deepEqual(
        bindProductionBuildLayoutSource(layout, originalSource).sourceState,
        originalSource
    );
    assert.throws(
        () =>
            bindProductionBuildLayoutSource(layout, {
                commit: "c".repeat(40),
                worktreeFingerprint: "d".repeat(64)
            }),
        /source identity is immutable/u
    );
    assert.equal(productionBuildLayoutDigest(layout), originalDigest);
    assert.equal(fs.readFileSync(artifact, "utf8"), "original-source");
});

test("fresh run never reads an older run root and finalization removes the active marker", (t) =>
{
    const root = repositoryFixture(t);
    const oldLayout = prepareProductionBuildLayout({ root, runId: "old-run" });
    fs.mkdirSync(oldLayout.frontendDist, { recursive: true });
    fs.writeFileSync(path.join(oldLayout.frontendDist, "index.html"), "stale");
    const current = prepareProductionBuildLayout({
        root,
        runId: "current-run"
    });
    assert.equal(
        fs.existsSync(path.join(current.frontendDist, "index.html")),
        false
    );
    assert.notEqual(current.frontendDist, oldLayout.frontendDist);
    const finalized = finalizeProductionBuildLayout(current, {
        status: "cancelled",
        cleanup: { durationMs: 1, traversedEntryCount: 2 },
        wallClockMs: 3
    });
    assert.equal(finalized.status, "cancelled");
    assert.equal(fs.existsSync(current.activeFile), false);
    assert.ok(finalized.metrics.output.inodeCount > 0);
    assert.ok(finalized.metrics.output.byteCount > 0);
});

test("scheduler output validation resolves logical declarations only to the current run root", (t) =>
{
    const root = repositoryFixture(t);
    const oldLayout = prepareProductionBuildLayout({
        root,
        runId: "old-output"
    });
    fs.mkdirSync(oldLayout.frontendDist, { recursive: true });
    fs.writeFileSync(path.join(oldLayout.frontendDist, "index.html"), "old");
    const current = prepareProductionBuildLayout({
        root,
        runId: "current-output"
    });
    const tier = { artifacts: ["src/frontend/dist/index.html"], evidence: [] };
    const env = productionBuildEnvironment(current, {});
    assert.equal(snapshotTierOutputs(root, tier, env).reusable, false);
    fs.mkdirSync(current.frontendDist, { recursive: true });
    fs.writeFileSync(path.join(current.frontendDist, "index.html"), "current");
    const snapshot = snapshotTierOutputs(root, tier, env);
    assert.equal(snapshot.reusable, true);
    assert.notEqual(
        snapshot.entries["src/frontend/dist/index.html"],
        "missing"
    );
});

test("scheduler output validation resolves acceptance evidence only to the active namespace", (t) =>
{
    const root = repositoryFixture(t);
    const currentLog = path.join(
        root,
        ".tmp/acceptance/endpoint-depth-42/backend.log"
    );
    const staleLog = path.join(root, ".tmp/acceptance/stale-run/backend.log");
    fs.mkdirSync(path.dirname(currentLog), { recursive: true });
    fs.mkdirSync(path.dirname(staleLog), { recursive: true });
    fs.writeFileSync(currentLog, "current");
    fs.writeFileSync(staleLog, "stale");
    const tier = {
        artifacts: [".tmp/acceptance"],
        evidence: [".tmp/acceptance/*.log"]
    };
    const env = { FSUSBLOG_TEST_NAMESPACE: "Endpoint Depth/42" };

    assert.equal(
        resolveRunBoundArtifactDeclaration(root, ".tmp/acceptance/*.log", env),
        ".tmp/acceptance/endpoint-depth-42/*.log"
    );
    assert.equal(snapshotTierOutputs(root, tier, env).reusable, true);

    fs.rmSync(currentLog);
    assert.equal(snapshotTierOutputs(root, tier, env).reusable, false);
});

test("stale GC retains current and live runs while reclaiming interrupted inactive runs", (t) =>
{
    const root = repositoryFixture(t);
    for (const runId of ["current", "active", "stale"])
    {
        const layout = resolveProductionBuildLayout({ root, runId });
        fs.mkdirSync(layout.runRoot, { recursive: true });
        fs.writeFileSync(path.join(layout.runRoot, "artifact"), runId);
    }
    const report = collectStaleProductionBuildRoots({
        root,
        currentRunId: "current",
        isRunActive: (runId) => runId === "active"
    });
    assert.deepEqual(report.removed, ["stale"]);
    assert.deepEqual(report.retained, ["active", "current"]);
    assert.equal(report.reclaimed.inodeCount, 1);
    assert.equal(report.reclaimed.byteCount, Buffer.byteLength("stale"));
    assert.ok(report.durationMs >= 0);
    assert.equal(
        fs.existsSync(
            resolveProductionBuildLayout({ root, runId: "stale" }).runRoot
        ),
        false
    );
});

test("GC refuses traversal, repository/root targets and symlinks without deleting outside data", (t) =>
{
    const root = repositoryFixture(t);
    const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), "fsusblog-build-outside-")
    );
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, "keep"), "keep");
    fs.mkdirSync(path.join(root, ".tmp/build"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".tmp/build/linked"), "dir");

    for (const candidate of [
        root,
        path.parse(root).root,
        path.join(root, ".tmp/build"),
        path.join(root, ".tmp/build/../outside")
    ])
    {
        assert.throws(
            () => assertSafeProductionBuildRunRoot(candidate, { root }),
            /refusing unsafe/u
        );
    }
    assert.throws(
        () =>
            collectStaleProductionBuildRoots({ root, currentRunId: "current" }),
        /refusing symlink/u
    );
    assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});
