import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
const faultLane = fs.readFileSync(path.join(root, 'tools/test/lanes/fault-injection.sh'), 'utf8');
const runtimeProbe = fs.readFileSync(path.join(root, 'tools/test/lanes/runtime-evidence-probe.mjs'), 'utf8');

test('fresh no-build runtime reuses the production Release backend instead of a deleted Debug output', () =>
{
    assert.match(
        bootstrap,
        /FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0\}" == "1"[\s\S]*?POSTGRES_PORT=[\s\S]*?DEBUG_FRONTEND_PORT=[\s\S]*?RELEASE_PREVIEW_PORT=/u
    );
    assert.match(
        bootstrap,
        /FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0\}" == "1"[\s\S]*?else\s+AcquireProductionFreshPortLeases/u
    );
    assert.match(bootstrap, /FSUSBLOG_RUNTIME_NO_BUILD[\s\S]*?runtimeConfiguration="Release"/u);
    assert.match(bootstrap, /runtimeArgs="-c \$runtimeConfiguration --no-build --no-restore"/u);
    assert.match(bootstrap, /Debug \| Release/u);
    assert.doesNotMatch(bootstrap, /runtimeArgs="-c Debug --no-build --no-restore"/u);
});

test('acceptance runtime isolates release-derived Public AOT state under the namespace data root', () =>
{
    assert.match(
        bootstrap,
        /FSUSBLOG_RELEASE_DERIVED_ROOT="\$\{FSUSBLOG_RELEASE_DERIVED_ROOT:-\$TEST_DATA_ROOT\/release-derived\}"/u
    );
    assert.match(bootstrap, /export FSUSBLOG_RELEASE_DERIVED_ROOT FSUSBLOG_RELEASE_ID/u);
    assert.match(bootstrap, /mkdir -p "\$FSUSBLOG_RELEASE_DERIVED_ROOT"/u);
    assert.match(bootstrap, /^FSUSBLOG_RELEASE_DERIVED_ROOT=\$FSUSBLOG_RELEASE_DERIVED_ROOT$/mu);
    assert.match(bootstrap, /^FSUSBLOG_RELEASE_ID=\$FSUSBLOG_RELEASE_ID$/mu);
    assert.match(bootstrap, /new Date\(epoch \* 1000\).*commit\.slice\(0, 12\)/su);
});

test('port lease control sockets use a bounded path independent of the checkout depth', () =>
{
    assert.match(bootstrap, /PORT_LEASE_SOCKET_ID="\$\(.*sha256sum.*printf "%.24s"/su);
    assert.match(
        bootstrap,
        /PORT_LEASE_CONTROL_SOCKET="\$\{FSUSBLOG_PORT_LEASE_CONTROL_SOCKET:-\/tmp\/fsusb-pl-\$PORT_LEASE_SOCKET_ID\.sock\}"/u
    );
    assert.doesNotMatch(bootstrap, /PORT_LEASE_CONTROL_SOCKET=.*\$TMP_DIR\/port-lease-control\.sock/u);
});

test('managed Debug bootstrap is a no-build reader of the shared backend producer', t =>
{
    const namespace = `runtime-debug-reader-${process.pid}`;
    t.after(() =>
    {
        fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true });
        fs.rmSync(path.join(root, '.tmp/fixtures', namespace), { recursive: true, force: true });
        fs.rmSync(path.join(root, '.tmp/env', `${namespace}.env`), { force: true });
    });

    const result = childProcess.spawnSync('bash', ['-lc', [
        'export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1',
        `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
        'export FSUSBLOG_RUNTIME_NO_BUILD=0',
        'unset FSUSBLOG_RUNTIME_CONFIGURATION',
        'source ./tools/bootstrap-acceptance-env.sh',
        'ConfigureManagedBackendRuntimeReader',
        'printf "%s|%s|%s\\n" "$FSUSBLOG_RUNTIME_CONFIGURATION" "$FSUSBLOG_RUNTIME_NO_BUILD" "$MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED"'
    ].join('; ')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Debug\|1\|1/u);
    const runtimeEnvironment = fs.readFileSync(path.join(root, '.tmp/env', `${namespace}.env`), 'utf8');
    assert.match(runtimeEnvironment, /^FSUSBLOG_RUNTIME_CONFIGURATION=Debug$/mu);
    assert.match(runtimeEnvironment, /^FSUSBLOG_RUNTIME_NO_BUILD=1$/mu);
    assert.match(bootstrap, /local laneSupport="\$ROOT_DIR\/tools\/test\/lanes\/_lane-collect-support\.sh"[\s\S]*?source "\$laneSupport"[\s\S]*?FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild/u);
    assert.match(bootstrap, /backend-debug-build EnsureManagedBackendSharedDebugBuild/u);
    assert.match(bootstrap, /managed backend startup is read-only and requires FSUSBLOG_RUNTIME_NO_BUILD=1/u);
    assert.match(bootstrap, /FSUSBLOG_RUNTIME_CONFIGURATION="\$runtimeConfiguration"[\s\S]*?FSUSBLOG_RUNTIME_NO_BUILD=1/u);
});

test('release identity writers finish before the managed backend starts', () =>
{
    const preparationIndex = bootstrap.indexOf("AllocateReadinessDeadline 'release bundle preparation'");
    const runtimeIndex = bootstrap.indexOf("AllocateReadinessDeadline 'runtime applications'");
    const prepareFunction = bootstrap.slice(
        bootstrap.indexOf('PrepareReleasePreviewBundle()'),
        bootstrap.indexOf('EnsureReleasePreview()')
    );
    const previewFunction = bootstrap.slice(
        bootstrap.indexOf('EnsureReleasePreview()'),
        bootstrap.indexOf('CurrentPowDifficulty()')
    );

    assert.ok(preparationIndex >= 0 && preparationIndex < runtimeIndex);
    assert.match(prepareFunction, /RunFrontendFastBuildGroup/u);
    assert.match(prepareFunction, /RunFrontendFastBuildGroup[\s\S]*?nextFingerprint="\$\(HashReleaseInputs\)"/u);
    assert.match(prepareFunction, /printf '%s\\n' "\$nextFingerprint" >"\$fingerprintFile"/u);
    assert.doesNotMatch(previewFunction, /RunFrontendFastBuildGroup/u);
    assert.match(previewFunction, /release preview bundle is not prepared for the current source fingerprint/u);
});

test('fault recovery reloads bootstrap mode and cannot restart a managed backend as a build writer', () =>
{
    const loadIndex = faultLane.indexOf('RequireBootstrappedNamespace');
    const producerIndex = faultLane.indexOf('FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild');
    const probeIndex = faultLane.indexOf('runtime-evidence-probe.mjs');
    assert.ok(loadIndex >= 0 && loadIndex < producerIndex);
    assert.ok(producerIndex < probeIndex);
    assert.match(faultLane, /export FSUSBLOG_RUNTIME_CONFIGURATION="\$runtime_configuration"[\s\S]*?export FSUSBLOG_RUNTIME_NO_BUILD=1/u);
    assert.match(runtimeProbe, /managed backend restart requires FSUSBLOG_RUNTIME_NO_BUILD=1 and a shared prebuilt runtime/u);
    assert.match(runtimeProbe, /'run', '--project', 'src\/backend\/FsusBlog\.Server\.csproj'[\s\S]*?'--no-build', '--no-restore'/u);
    assert.doesNotMatch(runtimeProbe, /\.\.\.\(noBuild \? \['--no-build', '--no-restore'\] : \[\]\)/u);
});

test('bootstrap namespace loader preserves values containing and ending with equals signs', t =>
{
    const namespace = `runtime-env-equals-${process.pid}`;
    const environmentFile = path.join(root, '.tmp/env', `${namespace}.env`);
    t.after(() => fs.rmSync(environmentFile, { force: true }));
    fs.mkdirSync(path.dirname(environmentFile), { recursive: true });
    fs.writeFileSync(environmentFile, [
        `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
        'VisitLog__IpPseudonymization__CurrentKey=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        'ConnectionStrings__DefaultConnection=Host=127.0.0.1;Password=value=with=equals',
        ''
    ].join('\n'));

    const result = childProcess.spawnSync('bash', ['-lc', [
        `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
        'source ./tools/test/lanes/_lane-collect-support.sh',
        'RequireBootstrappedNamespace',
        '[[ "$VisitLog__IpPseudonymization__CurrentKey" == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" ]]',
        '[[ "$ConnectionStrings__DefaultConnection" == "Host=127.0.0.1;Password=value=with=equals" ]]'
    ].join('; ')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('managed backend uses the same JWT key version as acceptance fixture tokens', () =>
{
    assert.match(bootstrap, /Jwt__KeyVersion=\$\(printf '%q' "\$JWT_KEY_VERSION"\).*Jwt__SecretKey=/u);
});

test('acceptance backend keeps local fixtures while enforcing the production CSP', () =>
{
    assert.match(bootstrap, /ASPNETCORE_ENVIRONMENT=Development\nTesting__EnforceProductionCsp=true/u);
    assert.match(bootstrap, /starting managed \$\{runtimeConfiguration,,\} backend[\s\S]*?local -x Testing__EnforceProductionCsp=true[\s\S]*?nohup/u);
});

test('managed backend readiness fails immediately when the no-build process exits', t =>
{
    const namespace = `runtime-release-backend-fail-${process.pid}`;
    t.after(() =>
    {
        fs.rmSync(path.join(root, '.tmp/acceptance', namespace), { recursive: true, force: true });
        fs.rmSync(path.join(root, '.tmp/fixtures', namespace), { recursive: true, force: true });
        fs.rmSync(path.join(root, '.tmp/env', `${namespace}.env`), { force: true });
    });
    const startedAt = performance.now();
    const result = childProcess.spawnSync('bash', ['-lc', [
        'export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1',
        `export FSUSBLOG_TEST_NAMESPACE=${namespace}`,
        'export FSUSBLOG_RUNTIME_NO_BUILD=1',
        'export FSUSBLOG_RUNTIME_CONFIGURATION=Debug',
        'export FSUSBLOG_STEP_DEADLINE_MS=10000',
        'source ./tools/bootstrap-acceptance-env.sh',
        'ROOT_DIR=/tmp/fsusblog-intentionally-missing-runtime-root',
        'deadline=$(( $(date +%s%3N) + 15000 ))',
        'EnsureBackend "$deadline"'
    ].join('; ')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 8_000
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /debug backend process exited before becoming ready/u);
    assert.match(`${result.stdout}\n${result.stderr}`, /The specified launch profile.*could not be applied|No such file or directory|not found/u);
    assert.ok(elapsedMs < 5_000, `dead managed backend consumed ${elapsedMs.toFixed(0)}ms of a 15000ms readiness deadline`);
});
