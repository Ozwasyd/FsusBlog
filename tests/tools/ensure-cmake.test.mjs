import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const installerPath = path.join(root, 'tools/frontend/ensure-cmake.sh');
const installer = fs.readFileSync(installerPath, 'utf8');
const cmakeVersion = '4.3.3';
const x86Sha256 = '927b2368a946c37269c3a66225ab00544e756459cdd0b5d0da438694fb9ff802';
const armSha256 = '9ea38356dbd3e32e51029a3e09a0f2f8e117ef4fbcaad7a21ffb36409bbd5cb4';

function writeExecutable(filePath, contents)
{
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
}

function createHarness(t, scenario, architecture = 'x86_64')
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ensure-cmake-'));
    const fakeBin = path.join(fixtureRoot, 'bin');
    const stateRoot = path.join(fixtureRoot, 'state');
    const cacheRoot = path.join(fixtureRoot, 'cache');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'scenario'), `${scenario}\n`);
    fs.writeFileSync(path.join(stateRoot, 'architecture'), `${architecture}\n`);
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

    writeExecutable(path.join(fakeBin, 'uname'), `#!/usr/bin/env bash
set -euo pipefail
FAKE_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
/bin/cat "\${FAKE_ROOT}/state/architecture"
`);

    writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
FAKE_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
SCENARIO="$(/bin/cat "\${FAKE_ROOT}/state/scenario")"
printf '%s\\n' "$*" >>"\${FAKE_ROOT}/state/curl.log"

output=""
url=""
while [[ "$#" -gt 0 ]]; do
    case "$1" in
        -o)
            output="$2"
            shift 2
            ;;
        https://*)
            url="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

[[ -n "\${output}" && -n "\${url}" ]]
if [[ "\${url}" == https://cmake.org/* ]]; then
    sourceName="primary"
elif [[ "\${url}" == https://github.com/Kitware/CMake/releases/* ]]; then
    sourceName="fallback"
else
    exit 90
fi

case "\${SCENARIO}:\${sourceName}" in
    primary-success:primary | missing-cmake:primary | publish-conflict:primary)
        printf 'verified-archive\\n' >"\${output}"
        ;;
    primary-success-slow:primary)
        sleep 0.2
        printf 'verified-archive\\n' >"\${output}"
        ;;
    primary-success:fallback | primary-success-slow:fallback | missing-cmake:fallback | publish-conflict:fallback)
        exit 91
        ;;
    primary-fail-fallback-success:primary | primary-fail-fallback-mismatch:primary | both-fail:primary)
        printf 'partial-primary\\n' >"\${output}"
        exit 28
        ;;
    primary-fail-fallback-success:fallback | primary-mismatch-fallback-success:fallback)
        printf 'verified-archive\\n' >"\${output}"
        ;;
    primary-fail-fallback-mismatch:fallback)
        printf 'tampered-fallback\\n' >"\${output}"
        ;;
    primary-mismatch-fallback-success:primary)
        printf 'tampered-primary\\n' >"\${output}"
        ;;
    both-fail:fallback)
        printf 'partial-fallback\\n' >"\${output}"
        exit 28
        ;;
    *)
        exit 92
        ;;
esac
`);

    writeExecutable(path.join(fakeBin, 'sha256sum'), `#!/usr/bin/env bash
set -euo pipefail
FAKE_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
ARCHITECTURE="$(/bin/cat "\${FAKE_ROOT}/state/architecture")"
read -r expected archive
case "\${ARCHITECTURE}" in
    x86_64)
        [[ "\${expected}" == "${x86Sha256}" ]]
        ;;
    aarch64)
        [[ "\${expected}" == "${armSha256}" ]]
        ;;
    *)
        exit 93
        ;;
esac
[[ "$(/bin/cat "\${archive}")" == "verified-archive" ]]
`);

    writeExecutable(path.join(fakeBin, 'tar'), `#!/usr/bin/env bash
set -euo pipefail
FAKE_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
SCENARIO="$(/bin/cat "\${FAKE_ROOT}/state/scenario")"
destination=""
while [[ "$#" -gt 0 ]]; do
    case "$1" in
        -C)
            destination="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done
[[ -n "\${destination}" ]]
if [[ "\${SCENARIO}" == "publish-conflict" ]]; then
    /bin/mkdir -p "\${FAKE_ROOT}/cache/cmake/${cmakeVersion}"
fi
if [[ "\${SCENARIO}" != "missing-cmake" ]]; then
    /bin/mkdir -p "\${destination}/bin"
    printf '%s\\n' '#!/usr/bin/env bash' 'printf "cmake version ${cmakeVersion}\\\\n"' >"\${destination}/bin/cmake"
    /bin/chmod +x "\${destination}/bin/cmake"
fi
`);

    const childEnvironment = {
        FSUSBLOG_DEPENDENCY_CACHE_ROOT: cacheRoot,
        LC_ALL: 'C',
        PATH: `${fakeBin}:/usr/bin:/bin`
    };

    function run()
    {
        return childProcess.spawnSync('/bin/bash', [installerPath], {
            cwd: root,
            encoding: 'utf8',
            env: childEnvironment,
            timeout: 10_000
        });
    }

    function runAsync()
    {
        return new Promise(resolve =>
        {
            const installerProcess = childProcess.spawn('/bin/bash', [installerPath], {
                cwd: root,
                env: childEnvironment
            });
            let stdout = '';
            let stderr = '';
            installerProcess.stdout.setEncoding('utf8');
            installerProcess.stderr.setEncoding('utf8');
            installerProcess.stdout.on('data', chunk =>
            {
                stdout += chunk;
            });
            installerProcess.stderr.on('data', chunk =>
            {
                stderr += chunk;
            });
            const timer = setTimeout(() => installerProcess.kill('SIGKILL'), 10_000);
            installerProcess.on('close', (status, signal) =>
            {
                clearTimeout(timer);
                resolve({ signal, status, stderr, stdout });
            });
        });
    }

    function curlCalls()
    {
        const logPath = path.join(stateRoot, 'curl.log');
        if (!fs.existsSync(logPath))
        {
            return [];
        }
        return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    }

    return {
        cacheRoot,
        cmakeRoot: path.join(cacheRoot, 'cmake', cmakeVersion),
        cmakeBin: path.join(cacheRoot, 'cmake', cmakeVersion, 'bin/cmake'),
        curlCalls,
        run,
        runAsync
    };
}

function assertBoundedFetch(call)
{
    assert.match(call, /(?:^| )--connect-timeout 5(?: |$)/u);
    assert.match(call, /(?:^| )--max-time 120(?: |$)/u);
    assert.doesNotMatch(call, /(?:^| )--retry(?: |-|=)/u);
}

function installerWorkDirectories(harness)
{
    const cmakeCacheRoot = path.join(harness.cacheRoot, 'cmake');
    if (!fs.existsSync(cmakeCacheRoot))
    {
        return [];
    }
    return fs.readdirSync(cmakeCacheRoot)
        .filter(entry => entry.startsWith(`.${cmakeVersion}.install.`));
}

function assertNoInstallerResidue(harness, options = {})
{
    assert.equal(fs.existsSync(harness.cmakeBin), false);
    if (!options.allowConflictingRoot)
    {
        assert.equal(fs.existsSync(harness.cmakeRoot), false);
    }
    assert.deepEqual(installerWorkDirectories(harness), []);
}

test('bootstrap keeps the fixed version, archive name, checksum, lock, and atomic publish', () =>
{
    assert.match(installer, /CMAKE_VERSION="4\.3\.3"/u);
    assert.match(installer, new RegExp(`ARCHIVE_SHA256="${x86Sha256}"`, 'u'));
    assert.match(installer, new RegExp(`ARCHIVE_SHA256="${armSha256}"`, 'u'));
    assert.match(installer, /ARCHIVE_NAME="cmake-\$\{CMAKE_VERSION\}-linux-\$\{ARCHIVE_ARCH\}\.tar\.gz"/u);
    assert.match(installer, /PRIMARY_ARCHIVE_URL="https:\/\/cmake\.org\/files\/v4\.3\/\$\{ARCHIVE_NAME\}"/u);
    assert.doesNotMatch(installer, /FALLBACK_ARCHIVE_URL/u);
    assert.match(installer, /flock 9/u);
    assert.match(installer, /sha256sum -c -/u);
    assert.ok(installer.indexOf('sha256sum -c -') < installer.indexOf('tar -xzf'));
    assert.match(installer, /mktemp -d "\$\{CACHE_ROOT\}\/cmake\/\.\$\{CMAKE_VERSION\}\.install\.XXXXXX"/u);
    assert.match(installer, /mv "\$\{WORK_DIR\}\/root" "\$\{CMAKE_ROOT\}"/u);
    assert.doesNotMatch(installer, /FSUSBLOG_[A-Z0-9_]*(?:URL|MIRROR|CHECKSUM|TIMEOUT|BYPASS)/u);
});

test('primary success does not contact fallback and publishes a complete cache root', t =>
{
    const harness = createHarness(t, 'primary-success');
    const result = harness.run();

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), harness.cmakeBin);
    assert.equal(fs.statSync(harness.cmakeBin).mode & 0o111, 0o111);
    const calls = harness.curlCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /https:\/\/cmake\.org\/files\/v4\.3\/cmake-4\.3\.3-linux-x86_64\.tar\.gz/u);
    assert.doesNotMatch(calls[0], /github\.com/u);
    assertBoundedFetch(calls[0]);
    assert.deepEqual(installerWorkDirectories(harness), []);
});

test('primary timeout fails after one bounded transfer attempt', t =>
{
    const harness = createHarness(t, 'primary-fail-fallback-success');
    const result = harness.run();

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = harness.curlCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /https:\/\/cmake\.org\/files\/v4\.3\/cmake-4\.3\.3-linux-x86_64\.tar\.gz/u);
    assertBoundedFetch(calls[0]);
    assertNoInstallerResidue(harness);
});

test('a primary checksum mismatch fails closed without contacting fallback', t =>
{
    const harness = createHarness(t, 'primary-mismatch-fallback-success');
    const result = harness.run();

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = harness.curlCalls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /cmake\.org/u);
    assertNoInstallerResidue(harness);
});

for (const [name, scenario] of [
    ['primary failure followed by fallback checksum mismatch', 'primary-fail-fallback-mismatch'],
    ['both source downloads failing', 'both-fail'],
    ['an archive without bin/cmake', 'missing-cmake']
])
{
    test(`${name} fails closed without executable cache or staging residue`, t =>
    {
        const harness = createHarness(t, scenario);
        const result = harness.run();

        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assertNoInstallerResidue(harness);
    });
}

test('an existing executable cache returns without any network access', t =>
{
    const harness = createHarness(t, 'both-fail');
    fs.mkdirSync(path.dirname(harness.cmakeBin), { recursive: true });
    writeExecutable(harness.cmakeBin, '#!/usr/bin/env bash\nexit 0\n');

    const result = harness.run();

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), harness.cmakeBin);
    assert.deepEqual(harness.curlCalls(), []);
});

test('flock serializes concurrent publishers so the follower only observes the complete cache root', async t =>
{
    const harness = createHarness(t, 'primary-success-slow');
    const results = await Promise.all([harness.runAsync(), harness.runAsync()]);

    for (const result of results)
    {
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(result.stdout.trim(), harness.cmakeBin);
    }
    assert.equal(harness.curlCalls().length, 1);
    assert.equal(fs.statSync(harness.cmakeBin).mode & 0o111, 0o111);
    assert.deepEqual(installerWorkDirectories(harness), []);
});

test('x86_64 and aarch64 retain their fixed archive naming and checksum pins', async t =>
{
    await t.test('x86_64', child =>
    {
        const harness = createHarness(child, 'primary-success', 'x86_64');
        const result = harness.run();
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(harness.curlCalls()[0], /cmake-4\.3\.3-linux-x86_64\.tar\.gz/u);
    });
    await t.test('aarch64', child =>
    {
        const harness = createHarness(child, 'primary-success', 'aarch64');
        const result = harness.run();
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const calls = harness.curlCalls();
        assert.equal(calls.length, 1);
        assert.match(calls[0], /cmake-4\.3\.3-linux-aarch64\.tar\.gz/u);
    });
});

test('a publish conflict fails closed instead of nesting the staged root', t =>
{
    const harness = createHarness(t, 'publish-conflict');
    const result = harness.run();

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assertNoInstallerResidue(harness, { allowConflictingRoot: true });
});
