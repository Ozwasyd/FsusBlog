import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {createProductionBuildReceipt, materializeProductionBuildDomains, registerProductionBuildConsumer} = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const {bindReservationServer, verifySealedPortLeaseManifest} = await import(new URL('../../tools/test-matrix/production-fresh-port-lease.mjs', import.meta.url));
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);
const portLeaseModule = path.join(
    root,
    "tools/test-matrix/production-fresh-port-lease.mjs"
);
const sourceState = {
    commit: "a".repeat(40),
    worktreeFingerprint: "b".repeat(64)
};
const producer = {
    workflow: "Quality Gate",
    runId: "42",
    runAttempt: 1,
    job: "production-build-artifacts"
};
const toolchain = {
    node: "v24",
    npm: "11",
    dotnet: "10",
    vite: "7",
    vitest: "4",
    playwright: "1.58",
    emsdk: "4"
};

function write(rootDirectory, relative, content)
{
    const file = path.join(rootDirectory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function productionBuildAssignments(runId)
{
    const result = spawnSync(
        "node",
        [
            "tools/test/export-production-build-environment.mjs",
            "--root",
            root,
            "--run-id",
            runId
        ],
        { cwd: root, encoding: "buffer" }
    );
    assert.equal(result.status, 0, result.stderr.toString("utf8"));
    assert.ok(
        result.stdout.length > 0,
        "the canonical production-build environment CLI must execute in the current worktree path"
    );
    return Object.fromEntries(
        result.stdout
            .toString("utf8")
            .split("\0")
            .filter(Boolean)
            .map((assignment) => assignment.split(/=(.*)/su).slice(0, 2))
    );
}

function readEnvironment(file)
{
    return Object.fromEntries(
        fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) =>
            {
                const separator = line.indexOf("=");
                return [line.slice(0, separator), line.slice(separator + 1)];
            })
    );
}

function exactOwnerIsAlive(owner)
{
    try
    {
        process.kill(owner.pid, 0);
    }
    catch (error)
    {
        if (error?.code === "ESRCH")
        {
            return false;
        }
        throw error;
    }
    try
    {
        const stat = fs.readFileSync(`/proc/${owner.pid}/stat`, "utf8");
        const tail = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/u);
        return tail[19] === owner.processStartIdentity;
    }
    catch (error)
    {
        if (error?.code === "ENOENT")
        {
            return false;
        }
        if (process.platform !== "linux")
        {
            return owner.processStartIdentity === String(owner.pid);
        }
        throw error;
    }
}

async function unavailableLeasePorts(ports)
{
    const unavailable = [];
    for (const port of ports)
    {
        const reservations = [];
        try
        {
            reservations.push(
                await bindReservationServer({ host: "127.0.0.1", port })
            );
            reservations.push(
                await bindReservationServer({
                    host: "::1",
                    port,
                    ipv6Only: true
                })
            );
        }
        catch
        {
            unavailable.push(port);
        }
        finally
        {
            await Promise.all(
                reservations.map((reservation) => reservation.close())
            );
        }
    }
    return unavailable;
}

function readRunOwnedPortLease({
    namespace,
    runId,
    manifestPath,
    tokenFilePath,
    pidFilePath,
    controlSocketPath
})
{
    const manifest = verifySealedPortLeaseManifest(
        JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    );
    assert.equal(
        manifest.runId,
        runId,
        "cleanup refuses a lease from another run"
    );
    assert.equal(
        manifest.namespace,
        namespace,
        "cleanup refuses a lease from another namespace"
    );
    assert.equal(manifest.reservationOwnerIdentity.runId, runId);
    assert.equal(manifest.reservationOwnerIdentity.namespace, namespace);
    assert.equal(manifest.tokenFilePath, tokenFilePath);
    assert.equal(manifest.pidFilePath, pidFilePath);
    assert.equal(manifest.controlSocketPath, controlSocketPath);
    assert.equal(
        Number(fs.readFileSync(pidFilePath, "utf8").trim()),
        manifest.reservationOwnerIdentity.pid
    );
    assert.ok(
        fs.statSync(controlSocketPath).isSocket(),
        "run-owned lease control socket must be live before release"
    );
    assert.equal(
        exactOwnerIsAlive(manifest.reservationOwnerIdentity),
        true,
        "run-owned lease daemon must be live before release"
    );
    assert.ok(manifest.leases.length > 0);
    assert.ok(
        manifest.leases.every(
            (lease) =>
                lease.reservationOwnerIdentity.instanceId ===
                manifest.reservationOwnerIdentity.instanceId
        )
    );
    return manifest;
}

async function waitForRunOwnedPortLeaseZero(manifest, timeoutMs = 5_000)
{
    const deadline = Date.now() + timeoutMs;
    let unavailable = manifest.leases.map((lease) => lease.port);
    while (Date.now() < deadline)
    {
        unavailable = await unavailableLeasePorts(
            manifest.leases.map((lease) => lease.port)
        );
        if (
            !exactOwnerIsAlive(manifest.reservationOwnerIdentity) &&
            !fs.existsSync(manifest.controlSocketPath) &&
            unavailable.length === 0
        )
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(
        `port lease cleanup did not reach zero: ` +
            `ownerAlive=${exactOwnerIsAlive(manifest.reservationOwnerIdentity)} ` +
            `socketPresent=${fs.existsSync(manifest.controlSocketPath)} ` +
            `unavailablePorts=${unavailable.join(",")}`
    );
}

async function releaseRunOwnedPortLease(context)
{
    const manifest = readRunOwnedPortLease(context);
    const result = spawnSync(
        process.execPath,
        [
            portLeaseModule,
            "release-all",
            "--manifest",
            context.manifestPath,
            "--token-file",
            context.tokenFilePath,
            "--reason",
            "production-build-bootstrap-test-cleanup"
        ],
        { cwd: root, encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    await waitForRunOwnedPortLeaseZero(manifest);
    const receipt = JSON.parse(
        fs.readFileSync(manifest.terminalReceiptPath, "utf8")
    );
    assert.equal(receipt.runId, context.runId);
    assert.equal(receipt.namespace, context.namespace);
    assert.equal(
        receipt.reservationOwnerIdentity.instanceId,
        manifest.reservationOwnerIdentity.instanceId
    );
    assert.equal(receipt.terminalState, "released");
    assert.equal(receipt.reason, "production-build-bootstrap-test-cleanup");
    assert.ok(
        receipt.leases.every((lease) => lease.handoffState === "released")
    );
}

function createBootstrapHarness(t)
{
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), "fsusblog-ci-bootstrap-artifact-")
    );
    const namespace = `ci-artifact-${randomUUID().slice(0, 8)}`;
    const runId = `consumer-${namespace}`;
    const targetRoot = path.join(
        root,
        ".tmp",
        `ci-bootstrap-materialized-${randomUUID()}`
    );
    const acceptanceRoot = path.join(root, ".tmp/acceptance", namespace);
    const envFile = path.join(root, ".tmp/env", `${namespace}.env`);
    const evidenceFile = path.join(
        root,
        ".tmp/release-evidence/jobs",
        `ci-build-materialization-${namespace}.json`
    );
    const lease = {
        namespace,
        runId,
        manifestPath: path.join(acceptanceRoot, "port-leases.json"),
        tokenFilePath: path.join(acceptanceRoot, "port-lease.token"),
        pidFilePath: path.join(acceptanceRoot, "port-lease.pid"),
        controlSocketPath: path.join(
            os.tmpdir(),
            `fsusb-pbb-${randomUUID().slice(0, 12)}.sock`
        )
    };
    let releaseRequired = false;
    t.after(async () =>
    {
        if (releaseRequired)
        {
            await releaseRunOwnedPortLease(lease);
        }
        fs.rmSync(temporary, { recursive: true, force: true });
        fs.rmSync(`${temporary}.state`, { recursive: true, force: true });
        fs.rmSync(targetRoot, { recursive: true, force: true });
        fs.rmSync(acceptanceRoot, { recursive: true, force: true });
        fs.rmSync(path.join(root, ".tmp/fixtures", namespace), {
            recursive: true,
            force: true
        });
        fs.rmSync(envFile, { force: true });
        fs.rmSync(evidenceFile, { force: true });
    });

    write(temporary, "payload/backend-runtime/FsusBlog.Server.dll", "server");
    write(temporary, "payload/test-runtime/FsusBlog.Server.Tests.dll", "tests");
    write(
        temporary,
        "payload/frontend-dist/index.html",
        "<main>immutable</main>"
    );
    write(
        temporary,
        "payload/frontend-dist/server/server-public-ssr.bundle.mjs",
        "worker"
    );
    write(
        temporary,
        "payload/frontend-dist/server/server-public-ssr.worker-core.mjs",
        "core"
    );
    write(temporary, "payload/frontend-dist/server/public-ssr.mjs", "renderer");
    write(
        temporary,
        "payload/frontend-dist/server/renderPublicPage.js",
        "render"
    );
    write(
        temporary,
        "payload/frontend-dist/server/package.json",
        '{"type":"module"}'
    );
    write(
        temporary,
        "payload/frontend-dist/server/public-shell-emergency.css",
        "body{}"
    );
    write(
        temporary,
        "payload/frontend-dist/server/assets/chunk.js",
        "export {}"
    );
    write(
        temporary,
        "payload/frontend-dist/server/dist/markdown.js",
        "export {}"
    );
    write(temporary, "payload/frontend-dist/server/.vite/manifest.json", "{}");
    write(temporary, "payload/wasm/aeds.wasm", "wasm");
    write(temporary, "payload/generated-contracts/fsusblog.openapi.json", "{}");
    write(temporary, "input.json", "{}");
    const receipt = createProductionBuildReceipt({
        root: temporary,
        artifactRoot: temporary,
        sourceState,
        producer,
        toolchain,
        inputPaths: ["input.json"],
        domains: [
            { name: "backend-runtime", path: "payload/backend-runtime" },
            {
                name: "test-runtime",
                path: "payload/test-runtime",
                consumerMode: "copy-before-write"
            },
            { name: "frontend-dist", path: "payload/frontend-dist" },
            { name: "wasm", path: "payload/wasm" },
            {
                name: "generated-contracts",
                path: "payload/generated-contracts"
            }
        ]
    });
    fs.rmSync(path.join(temporary, "input.json"));

    releaseRequired = true;
    const result = spawnSync(
        "bash",
        ["tools/bootstrap-acceptance-env.sh", "--prepare-env-only"],
        {
            cwd: root,
            encoding: "utf8",
            env: {
                ...process.env,
                FSUSBLOG_TEST_NAMESPACE: namespace,
                FSUSBLOG_TEST_RUN_ID: runId,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT:
                    sourceState.worktreeFingerprint,
                FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: temporary,
                FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: receipt.contentDigest,
                FSUSBLOG_RUNTIME_NO_BUILD: "1",
                FSUSBLOG_PORT_LEASE_CONTROL_SOCKET: lease.controlSocketPath,
                GITHUB_WORKFLOW: producer.workflow,
                GITHUB_RUN_ID: producer.runId,
                GITHUB_RUN_ATTEMPT: String(producer.runAttempt),
                FSUSBLOG_BACKEND_SERVER_DLL: path.join(
                    targetRoot,
                    "backend/FsusBlog.Server.dll"
                ),
                FSUSBLOG_BACKEND_TEST_BIN_DIR: path.join(targetRoot, "tests"),
                FSUSBLOG_FRONTEND_DIST_ROOT: path.join(
                    targetRoot,
                    "frontend/dist"
                ),
                FSUSBLOG_FRONTEND_WASM_ROOT: path.join(
                    targetRoot,
                    "frontend/wasm"
                ),
                FSUSBLOG_GENERATED_OUTPUT_ROOT: path.join(
                    targetRoot,
                    "generated"
                ),
                FSUSBLOG_BACKEND_WEBROOT: path.join(
                    targetRoot,
                    "backend-wwwroot"
                )
            }
        }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = readRunOwnedPortLease(lease);
    const environment = readEnvironment(envFile);
    assert.equal(
        Number(environment.FSUSBLOG_PORT_LEASE_DAEMON_PID),
        manifest.reservationOwnerIdentity.pid
    );
    assert.equal(
        environment.FSUSBLOG_PORT_LEASED_ROLES,
        manifest.leases.map((entry) => entry.role).join(",")
    );

    return {
        temporary,
        namespace,
        targetRoot,
        envFile,
        evidenceFile,
        result,
        lease,
        manifest,
        async release()
        {
            await releaseRunOwnedPortLease(lease);
            releaseRequired = false;
        }
    };
}

test("acceptance bootstrap materializes verified domains into its current run-bound roots and forces no-build", async (t) =>
{
    const harness = createBootstrapHarness(t);
    const { temporary, targetRoot, envFile, evidenceFile, result } = harness;
    // Inputs belong to producer identity, not the uploaded artifact payload.
    // Recreate the exact uploaded root by removing the producer-only input before verification.
    // The receipt does not list it as an artifact.
    assert.match(
        result.stdout,
        /materialized verified immutable CI production domains/u
    );
    assert.equal(
        fs.readFileSync(
            path.join(targetRoot, "backend/FsusBlog.Server.dll"),
            "utf8"
        ),
        "server"
    );
    assert.equal(
        fs.readFileSync(
            path.join(targetRoot, "tests/FsusBlog.Server.Tests.dll"),
            "utf8"
        ),
        "tests"
    );
    assert.equal(
        fs.readFileSync(
            path.join(targetRoot, "frontend/dist/index.html"),
            "utf8"
        ),
        "<main>immutable</main>"
    );
    assert.equal(
        fs.readFileSync(
            path.join(targetRoot, "backend-wwwroot/index.html"),
            "utf8"
        ),
        "<main>immutable</main>"
    );
    assert.notEqual(
        fs.realpathSync(path.join(targetRoot, "frontend/dist")),
        fs.realpathSync(path.join(targetRoot, "backend-wwwroot"))
    );
    fs.writeFileSync(
        path.join(targetRoot, "backend-wwwroot/runtime-generated.txt"),
        "runtime"
    );
    assert.equal(
        fs.existsSync(
            path.join(temporary, "payload/frontend-dist/runtime-generated.txt")
        ),
        false
    );
    assert.equal(
        fs.readFileSync(
            path.join(targetRoot, "frontend/wasm/aeds.wasm"),
            "utf8"
        ),
        "wasm"
    );
    assert.equal(
        fs.readFileSync(
            path.join(
                targetRoot,
                "generated/ci-contracts/fsusblog.openapi.json"
            ),
            "utf8"
        ),
        "{}"
    );
    const runtimeEnvironment = fs.readFileSync(envFile, "utf8");
    assert.match(runtimeEnvironment, /^FSUSBLOG_RUNTIME_NO_BUILD=1$/mu);
    const stagedSsrRoot = path.join(targetRoot, "frontend/ssr-runtime");
    assert.ok(
        runtimeEnvironment
            .split("\n")
            .includes(`PublicAot__SsrClientRoot=${stagedSsrRoot}`)
    );
    assert.equal(
        fs.readFileSync(
            path.join(stagedSsrRoot, "server/server-public-ssr.bundle.mjs"),
            "utf8"
        ),
        "worker"
    );
    assert.equal(fs.existsSync(path.join(stagedSsrRoot, "index.html")), false);
    assert.equal(
        fs.existsSync(path.join(stagedSsrRoot, "manifest.json")),
        true
    );
    assert.match(
        runtimeEnvironment,
        /^PublicAot__SsrWorkerScript=\.\/server\/server-public-ssr\.bundle\.mjs$/mu
    );
    const acceptanceKeys = [
        "HumanReadProof__SigningKey",
        "HumanReadProof__Dedup__CurrentKey",
        "ReadAnalyticsPrivacy__NoiseKey"
    ].map((key) =>
    {
        const value = runtimeEnvironment.match(
            new RegExp(`^${key}=(.+)$`, "mu")
        )?.[1];
        assert.ok(
            value,
            `${key} must be present in the private runtime environment`
        );
        assert.equal(Buffer.from(value, "base64").byteLength, 32);
        return value;
    });
    assert.equal(new Set(acceptanceKeys).size, acceptanceKeys.length);
    assert.deepEqual(
        acceptanceKeys.filter((value) =>
            [
                "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8=",
                "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8=",
                "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8="
            ].includes(value)
        ),
        []
    );
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    assert.equal(evidence.status, "success");
    assert.equal(evidence.consumerLease.status, "active");
    const backendMaterializations = evidence.materialization.domains
        .filter((domain) => domain.name === "backend-runtime")
        .map((domain) => domain.method);
    assert.ok(
        ["reflink", "copy-fallback"].includes(backendMaterializations[0]),
        "backend runtime must use a writable copy-up layer"
    );
    assert.ok(
        evidence.materialized.some((value) =>
            value.endsWith("backend/FsusBlog.Server.dll")
        )
    );
    const frontendMaterializations = evidence.materialization.domains
        .filter((domain) => domain.name === "frontend-dist")
        .map((domain) => domain.method);
    assert.equal(frontendMaterializations[0], "reference");
    assert.ok(
        ["reflink", "copy-fallback"].includes(frontendMaterializations[1])
    );
    await harness.release();
});

test("production build bootstrap cleanup fails closed on mismatched run ownership", async (t) =>
{
    const harness = createBootstrapHarness(t);
    await assert.rejects(
        releaseRunOwnedPortLease({
            ...harness.lease,
            runId: `foreign-${harness.lease.runId}`
        }),
        /cleanup refuses a lease from another run/u
    );
    assert.equal(
        exactOwnerIsAlive(harness.manifest.reservationOwnerIdentity),
        true
    );
    assert.ok(fs.statSync(harness.manifest.controlSocketPath).isSocket());
    await harness.release();
});

test("CI bootstrap source keeps backend-only consumers free of frontend startup and forbids rebuild fallback", () =>
{
    const source = fs.readFileSync(
        path.join(root, "tools/bootstrap-acceptance-env.sh"),
        "utf8"
    );
    assert.match(
        source,
        /CiProductionHasDomain frontend-dist[\s\S]*runtimeApplications\+=\(release-preview EnsureReleasePreview debug-frontend EnsureDebugFrontend\)/u
    );
    assert.match(
        source,
        /FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT[\s\S]*vite preview/u
    );
    assert.match(
        source,
        /runtimeArgs="-c \$runtimeConfiguration --no-build --no-restore"/u
    );
    assert.match(
        source,
        /local -x PublicAot__SsrClientRoot="\$PUBLIC_AOT_SSR_CLIENT_ROOT"/u
    );
    assert.match(
        source,
        /--run-id "\$\{FSUSBLOG_TEST_RUN_ID:-[^}]*\}"[\s\S]*--source-commit "\$\{FSUSBLOG_TEST_SOURCE_COMMIT:\?fixture orchestrator source commit is required\}"[\s\S]*--source-fingerprint "sha256:\$\{FSUSBLOG_TEST_SOURCE_FINGERPRINT#sha256:\}"/u
    );
    assert.match(
        source,
        /ConfigureLocalPublicContentFixture\(\)[\s\S]*FIXTURE_REQUIRES_PUBLIC[\s\S]*export FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET="\$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET"[\s\S]*export fsus__allowLocalPublicContentFixture=true[\s\S]*export fsus__localPublicContentFixtureSecret="\$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET"/u
    );
    assert.doesNotMatch(
        source,
        /runArgs\+=\([^)]*localPublicContentFixtureSecret/su
    );
    assert.match(
        source,
        /currentFingerprint" == "\$nextFingerprint"[\s\S]*debug backend already healthy/u
    );
    assert.doesNotMatch(source, /CI production[^\n]*fallback[^\n]*build/iu);
});

test("current-schema consumers resolve one run-bound candidate assembly and reject ambient or stale paths", (t) =>
{
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    const temporary = fs.mkdtempSync(
        path.join(root, ".tmp/current-schema-candidate-")
    );
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const runId = "candidate-assembly-run";
    const inheritedEnvironment = { ...process.env };
    delete inheritedEnvironment.FSUSBLOG_PRODUCTION_BUILD_ROOT;
    delete inheritedEnvironment.FSUSBLOG_BACKEND_SERVER_DLL;
    const source = String.raw`
        source "$1/tools/bootstrap-acceptance-env.sh"
        if [[ -n "$FSUSBLOG_RESOLVER_CI_ARTIFACT_ROOT" ]]; then
            export FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT="$FSUSBLOG_RESOLVER_CI_ARTIFACT_ROOT"
            export FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST="$FSUSBLOG_RESOLVER_CI_RECEIPT_DIGEST"
            export FSUSBLOG_RELEASE_EVIDENCE_DIR="$FSUSBLOG_RESOLVER_CI_EVIDENCE_ROOT"
        fi
        ResolveCurrentSchemaCandidateAssembly Release
        printf '%s' "$CURRENT_SCHEMA_CANDIDATE_ASSEMBLY"
    `;
    const invoke = ({
        buildRoot,
        candidateAssembly,
        candidateRunId = runId,
        candidateNamespace = `candidate-${randomUUID().slice(0, 8)}`,
        environment = {}
    }) =>
        spawnSync(
            "bash",
            ["-c", source, "current-schema-candidate-resolver", root],
            {
                cwd: root,
                encoding: "utf8",
                env: {
                    ...inheritedEnvironment,
                    FSUSBLOG_BOOTSTRAP_SOURCE_ONLY: "1",
                    FSUSBLOG_TEST_NAMESPACE: candidateNamespace,
                    FSUSBLOG_TEST_RUN_ID: candidateRunId,
                    FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
                    FSUSBLOG_TEST_SOURCE_FINGERPRINT:
                        sourceState.worktreeFingerprint,
                    FSUSBLOG_RUNTIME_CONFIGURATION: "Release",
                    FSUSBLOG_RESOLVER_CI_ARTIFACT_ROOT: "",
                    FSUSBLOG_RESOLVER_CI_RECEIPT_DIGEST: "",
                    FSUSBLOG_RESOLVER_CI_EVIDENCE_ROOT: "",
                    ...(buildRoot === undefined
                        ? {}
                        : { FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot }),
                    ...(candidateAssembly === undefined
                        ? {}
                        : { FSUSBLOG_BACKEND_SERVER_DLL: candidateAssembly }),
                    FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT: path.join(
                        temporary,
                        "acceptance"
                    ),
                    FSUSBLOG_ACCEPTANCE_ENV_ROOT: path.join(temporary, "env"),
                    FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: path.join(
                        temporary,
                        "fixtures"
                    ),
                    ...environment
                }
            }
        );
    const canonical = productionBuildAssignments(runId);
    const canonicalRoot = canonical.FSUSBLOG_PRODUCTION_BUILD_ROOT;
    const canonicalAssembly = canonical.FSUSBLOG_BACKEND_SERVER_DLL;
    write(root, path.relative(root, canonicalAssembly), "candidate");
    t.after(() => fs.rmSync(canonicalRoot, { recursive: true, force: true }));

    const accepted = invoke({
        buildRoot: canonicalRoot,
        candidateAssembly: canonicalAssembly
    });
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    assert.equal(accepted.stdout, canonicalAssembly);

    const unsetRoot = invoke({
        buildRoot: undefined,
        candidateAssembly: canonicalAssembly
    });
    assert.equal(unsetRoot.status, 2);
    assert.match(
        unsetRoot.stdout,
        /production build root must be an absolute non-symlink path/u
    );

    const missingRoot = path.join(temporary, "missing-build");
    fs.mkdirSync(missingRoot, { recursive: true });
    const missingAssembly = path.join(
        missingRoot,
        "dotnet/FsusBlog.Server/bin/Release/net10.0/FsusBlog.Server.dll"
    );
    const missing = invoke({
        buildRoot: missingRoot,
        candidateAssembly: missingAssembly
    });
    assert.equal(missing.status, 2);
    assert.match(
        missing.stdout,
        /candidate assembly is missing or not a regular file/u
    );

    const ambientAssembly = path.join(temporary, "ambient/FsusBlog.Server.dll");
    write(temporary, path.relative(temporary, ambientAssembly), "ambient");
    const ambient = invoke({
        buildRoot: canonicalRoot,
        candidateAssembly: ambientAssembly
    });
    assert.equal(ambient.status, 2);
    assert.match(
        ambient.stdout,
        /does not match the canonical production build layout/u
    );

    const outsideLayoutAssembly = path.join(
        canonicalRoot,
        "other/FsusBlog.Server.dll"
    );
    write(
        temporary,
        path.relative(temporary, outsideLayoutAssembly),
        "outside-layout"
    );
    const outsideLayout = invoke({
        buildRoot: canonicalRoot,
        candidateAssembly: outsideLayoutAssembly
    });
    assert.equal(outsideLayout.status, 2);
    assert.match(
        outsideLayout.stdout,
        /does not match the canonical production build layout/u
    );

    const staleRoot = path.join(temporary, "different-run");
    const staleAssembly = path.join(
        staleRoot,
        "dotnet/FsusBlog.Server/bin/Release/net10.0/FsusBlog.Server.dll"
    );
    write(temporary, path.relative(temporary, staleAssembly), "stale");
    const stale = invoke({
        buildRoot: canonicalRoot,
        candidateAssembly: staleAssembly
    });
    assert.equal(stale.status, 2);
    assert.match(
        stale.stdout,
        /does not match the canonical production build layout/u
    );

    const stalePair = productionBuildAssignments("self-consistent-stale-run");
    write(
        root,
        path.relative(root, stalePair.FSUSBLOG_BACKEND_SERVER_DLL),
        "stale-pair"
    );
    t.after(() =>
        fs.rmSync(stalePair.FSUSBLOG_PRODUCTION_BUILD_ROOT, {
            recursive: true,
            force: true
        })
    );
    const selfConsistentStale = invoke({
        buildRoot: stalePair.FSUSBLOG_PRODUCTION_BUILD_ROOT,
        candidateAssembly: stalePair.FSUSBLOG_BACKEND_SERVER_DLL
    });
    assert.equal(selfConsistentStale.status, 2);
    assert.match(
        selfConsistentStale.stdout,
        /does not match the current production build run/u
    );

    const browserConsumerRoot = path.join(
        temporary,
        "browser-fixture/production-build"
    );
    const browserConsumerAssembly = path.join(
        browserConsumerRoot,
        "dotnet/FsusBlog.Server/bin/Release/net10.0/FsusBlog.Server.dll"
    );
    const browserArtifactRoot = path.join(temporary, "browser-artifact");
    const browserEvidenceRoot = path.join(temporary, "browser-evidence");
    const browserNamespace = "browser-candidate-consumer";
    write(
        browserArtifactRoot,
        "payload/backend-runtime/FsusBlog.Server.dll",
        "browser-candidate"
    );
    write(browserArtifactRoot, "input.json", "{}");
    const browserReceipt = createProductionBuildReceipt({
        root: browserArtifactRoot,
        artifactRoot: browserArtifactRoot,
        sourceState,
        producer,
        toolchain,
        inputPaths: ["input.json"],
        domains: [{ name: "backend-runtime", path: "payload/backend-runtime" }]
    });
    fs.rmSync(path.join(browserArtifactRoot, "input.json"));
    const browserLease = registerProductionBuildConsumer({
        artifactRoot: browserArtifactRoot,
        runId,
        consumerId: browserNamespace
    });
    const browserMaterialization = materializeProductionBuildDomains({
        artifactRoot: browserArtifactRoot,
        destinationRoot: root,
        mappings: [
            {
                name: "backend-runtime",
                destination: path.relative(
                    root,
                    path.dirname(browserConsumerAssembly)
                )
            }
        ],
        verification: {
            expectedSourceState: sourceState,
            expectedProducer: producer,
            expectedReceiptDigest: browserReceipt.contentDigest
        }
    });
    const browserEvidenceFile = path.join(
        browserEvidenceRoot,
        "jobs",
        `ci-build-materialization-${browserNamespace}.json`
    );
    write(
        browserEvidenceRoot,
        path.relative(browserEvidenceRoot, browserEvidenceFile),
        `${JSON.stringify(
            {
                ...browserMaterialization.evidence,
                materialized: browserMaterialization.copied,
                consumerLease: browserLease
            },
            null,
            2
        )}\n`
    );
    const browserConsumer = invoke({
        buildRoot: browserConsumerRoot,
        candidateAssembly: browserConsumerAssembly,
        candidateNamespace: browserNamespace,
        environment: {
            FSUSBLOG_RESOLVER_CI_ARTIFACT_ROOT: browserArtifactRoot,
            FSUSBLOG_RESOLVER_CI_RECEIPT_DIGEST: browserReceipt.contentDigest,
            FSUSBLOG_RESOLVER_CI_EVIDENCE_ROOT: browserEvidenceRoot
        }
    });
    assert.equal(
        browserConsumer.status,
        0,
        `${browserConsumer.stdout}\n${browserConsumer.stderr}`
    );
    assert.equal(browserConsumer.stdout, browserConsumerAssembly);

    const directRunId = "homogeneous-direct-run";
    const directAssignments = productionBuildAssignments(directRunId);
    assert.equal(
        directAssignments.FSUSBLOG_BACKEND_SERVER_DLL,
        path.join(
            directAssignments.FSUSBLOG_PRODUCTION_BUILD_ROOT,
            "dotnet/FsusBlog.Server/bin/Release/net10.0/FsusBlog.Server.dll"
        )
    );
    write(
        root,
        path.relative(root, directAssignments.FSUSBLOG_BACKEND_SERVER_DLL),
        "direct-candidate"
    );
    t.after(() =>
        fs.rmSync(directAssignments.FSUSBLOG_PRODUCTION_BUILD_ROOT, {
            recursive: true,
            force: true
        })
    );
    const directCandidate = invoke({
        buildRoot: directAssignments.FSUSBLOG_PRODUCTION_BUILD_ROOT,
        candidateAssembly: directAssignments.FSUSBLOG_BACKEND_SERVER_DLL,
        candidateRunId: directRunId
    });
    assert.equal(
        directCandidate.status,
        0,
        `${directCandidate.stdout}\n${directCandidate.stderr}`
    );
    assert.equal(
        directCandidate.stdout,
        directAssignments.FSUSBLOG_BACKEND_SERVER_DLL
    );

    const symlinkRoot = path.join(temporary, "symlink-build");
    fs.symlinkSync(canonicalRoot, symlinkRoot, "dir");
    const rootSymlink = invoke({
        buildRoot: symlinkRoot,
        candidateAssembly: path.join(
            symlinkRoot,
            "dotnet/FsusBlog.Server/bin/Release/net10.0/FsusBlog.Server.dll"
        )
    });
    assert.equal(rootSymlink.status, 2);
    assert.match(
        rootSymlink.stdout,
        /production build root must be an absolute non-symlink path/u
    );

    fs.rmSync(canonicalAssembly);
    const symlinkTarget = path.join(
        path.dirname(canonicalAssembly),
        "candidate-target.dll"
    );
    fs.writeFileSync(symlinkTarget, "candidate");
    fs.symlinkSync(symlinkTarget, canonicalAssembly);
    const symlink = invoke({
        buildRoot: canonicalRoot,
        candidateAssembly: canonicalAssembly
    });
    assert.equal(symlink.status, 2);
    assert.match(
        symlink.stdout,
        /candidate assembly is missing or not a regular file/u
    );
});
