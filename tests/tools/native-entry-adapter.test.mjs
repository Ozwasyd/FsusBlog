import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapterEntry = path.join(repositoryRoot, 'tools/test-inventory/native-entry-adapter/index.mjs');
const temporaryRoots = [];

const NATIVE_SMOKE_SOURCE = `
#include "AedsCrc16.h"

int main() {
  ComputeCrc16(0x4B37);
  return 0;
}
`;

const NATIVE_FUZZ_SOURCE = `
#include "AedsCrc16.h"
#include <stddef.h>
#include <stdint.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  ComputeCrc16(0x4B37);
  return 0;
}
`;

const NATIVE_CMAKE_SOURCE = `
add_executable(FsusNativeSmokeTests AedsCrc16SmokeTests.cpp)
add_executable(FsusCrc16Fuzz AedsCrc16Fuzz.cpp)
add_test(NAME FsusNativeSmokeTests COMMAND FsusNativeSmokeTests)
option(FSUSBLOG_ENABLE_FUZZING "enable fuzz builds" ON)
target_compile_options(FsusCrc16Fuzz PRIVATE -fsanitize=address,undefined)
`;

function write(root, relativePath, contents)
{
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
}

function runAdapter(root, files, matrixTiers = [])
{
    const requestPath = path.join(root, '.adapter-request.json');
    writeFileSync(requestPath, JSON.stringify({ root, files, matrixTiers }));
    const result = spawnSync(process.execPath, [adapterEntry, requestPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

function writeNativeFixture(root)
{
    write(root, 'tests/native/AedsCrc16SmokeTests.cpp', NATIVE_SMOKE_SOURCE);
    write(root, 'tests/native/AedsCrc16Fuzz.cpp', NATIVE_FUZZ_SOURCE);
    write(root, 'tests/native/CMakeLists.txt', NATIVE_CMAKE_SOURCE);
    write(root, 'tests/native/corpus/aeds-crc16/seed.bin', '\x00\x01\x02\x03');
    write(root, 'tests/native/corpus/aeds-crc16/aeds.dict', 'crc16="\x4B\x37"\n');
}

function nativeRequestFiles(extra = [])
{
    return [
        { path: 'tests/native/AedsCrc16SmokeTests.cpp', adapter: 'native-smoke', declaredBy: ['matrix:command:unit-native-smoke', 'coverage:unit'] },
        { path: 'tests/native/AedsCrc16Fuzz.cpp', adapter: 'native-fuzz', declaredBy: ['matrix:command:native-fuzz-sanitizer'] },
        { path: 'tests/native/CMakeLists.txt', adapter: 'native-cmake' },
        { path: 'tests/native/corpus/aeds-crc16/seed.bin', adapter: 'native-corpus' },
        { path: 'tests/native/corpus/aeds-crc16/aeds.dict', adapter: 'native-corpus' },
        ...extra
    ];
}

test.after(() =>
{
    for (const root of temporaryRoots)
    {
        rmSync(root, { recursive: true, force: true });
    }
});

test('CTest smoke target binds to the source symbol owner and production reference', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-smoke-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    const tiers = [{ id: 'unit-native-smoke', command: 'node tools/test.sh run native-smoke' }];
    const report = runAdapter(root, nativeRequestFiles(), tiers);
    assert.equal(report.diagnostics.length, 0, JSON.stringify(report.diagnostics));
    const cases = report.testCases;
    assert.equal(cases.length, 2, JSON.stringify(cases.map((entry) => entry.id)));
    const smoke = cases.find((entry) => entry.id === 'native-smoke:aeds-crc16-known-vector');
    assert.ok(smoke);
    assert.equal(smoke.ownerClass, 'FsusNativeSmokeTests');
    assert.equal(smoke.methodName, 'main');
    assert.equal(smoke.kind, 'native-smoke');
    assert.equal(smoke.identity, 'static');
    assert.equal(smoke.ownerFile, 'tests/native/AedsCrc16SmokeTests.cpp');
    assert.ok(smoke.sourceSpan.start.line >= 1);
    assert.ok(smoke.bodySource.includes('ComputeCrc16'));
    assert.ok(smoke.traits.some((trait) => trait.name === 'CMakeTarget' && trait.value === 'FsusNativeSmokeTests'));
    assert.ok(smoke.traits.some((trait) => trait.name === 'CTestName' && trait.value === 'FsusNativeSmokeTests'));
    assert.ok(smoke.traits.some((trait) => trait.name === 'KnownVector' && trait.value === '0x4B37'));
    assert.ok(smoke.traits.some((trait) => trait.name === 'MatrixTier' && trait.value === 'unit-native-smoke'));
    assert.ok(smoke.traits.some((trait) => trait.name === 'MatrixCommand' && trait.value.startsWith('unit-native-smoke::')));
    assert.ok(smoke.traits.some((trait) => trait.name === 'Coverage' && trait.value === 'unit'));
    assert.ok(smoke.methodFacts.productionSymbolReferences.some((ref) => ref.methodName === 'ComputeCrc16' && ref.assemblyKind === 'production'));
});

test('fuzz harness, corpus and dictionary surfaces are distinguished without fake case counts', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-fuzz-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    const report = runAdapter(root, nativeRequestFiles());
    assert.equal(report.diagnostics.length, 0);
    const fuzz = report.testCases.find((entry) => entry.id === 'native-fuzz:aeds-crc16-input-space');
    assert.ok(fuzz);
    assert.equal(fuzz.ownerClass, 'FsusCrc16Fuzz');
    assert.equal(fuzz.methodName, 'LLVMFuzzerTestOneInput');
    assert.equal(fuzz.kind, 'native-fuzz');
    assert.equal(fuzz.fixture, 'tests/native/corpus/aeds-crc16');
    assert.ok(fuzz.traits.some((trait) => trait.name === 'Framework' && trait.value === 'libFuzzer'));
    assert.ok(fuzz.traits.some((trait) => trait.name === 'FuzzEntry' && trait.value === 'LLVMFuzzerTestOneInput'));
    assert.ok(fuzz.traits.some((trait) => trait.name === 'Corpus' && trait.value === 'tests/native/corpus/aeds-crc16'));
    assert.ok(fuzz.traits.some((trait) => trait.name === 'Sanitizers' && trait.value === 'address,undefined'));
    assert.ok(fuzz.traits.some((trait) => trait.name === 'RuntimeBudget'));
    assert.equal(fuzz.traits.some((trait) => trait.name === 'RuntimeReceipt'), true);
    assert.ok(fuzz.methodFacts.productionSymbolReferences.some((ref) => ref.methodName === 'ComputeCrc16'));
    const caseOwners = new Set(report.testCases.map((entry) => entry.ownerFile));
    assert.ok(!caseOwners.has('tests/native/corpus/aeds-crc16/seed.bin'), 'corpus inputs must not become assertion cases');
    assert.ok(!caseOwners.has('tests/native/corpus/aeds-crc16/aeds.dict'), 'dictionary inputs must not become assertion cases');
});

test('matrix shell entry carries tier, child test, receipt and fail-closed aggregation facts', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-shell-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    write(root, 'tools/test/fixture-entrypoint.sh', `
#!/usr/bin/env sh
set -e
node tests/tools/check.test.mjs
node tools/test/check-evidence.mjs
printf '{"ok":true}' > .tmp/release-evidence/fixture-entrypoint.json
`);
    const tiers = [{ id: 'unit-shell-lane', command: 'node tools/test.sh run unit-shell-lane' }];
    const files = nativeRequestFiles([
        { path: 'tools/test/fixture-entrypoint.sh', adapter: 'shell', declaredBy: ['matrix:command:unit-shell-lane', 'coverage:unit'] }
    ]);
    const report = runAdapter(root, files, tiers);
    assert.equal(report.diagnostics.length, 0, JSON.stringify(report.diagnostics));
    const entry = report.testCases.find((item) => item.id === 'shell:tools/test/fixture-entrypoint.sh');
    assert.ok(entry);
    assert.equal(entry.kind, 'shell');
    assert.equal(entry.identity, 'dynamic');
    assert.equal(entry.platform, 'shell');
    assert.ok(entry.traits.some((trait) => trait.name === 'MatrixTier' && trait.value === 'unit-shell-lane'));
    assert.ok(entry.traits.some((trait) => trait.name === 'MatrixCommand' && trait.value.startsWith('unit-shell-lane::')));
    assert.ok(entry.traits.some((trait) => trait.name === 'ChildCommand' && trait.value === 'node tests/tools/check.test.mjs'));
    assert.ok(entry.traits.some((trait) => trait.name === 'ChildTestFile' && trait.value === 'tests/tools/check.test.mjs'));
    assert.ok(entry.traits.some((trait) => trait.name === 'Receipt' && trait.value === '.tmp/release-evidence/fixture-entrypoint.json'));
    assert.ok(entry.traits.some((trait) => trait.name === 'Aggregation' && trait.value === 'true'));
    assert.ok(entry.traits.some((trait) => trait.name === 'FailClosedContract' && trait.value === 'aggregation-with-evidence'));
    assert.ok(entry.dynamicCaseInfo.inventoryObligation.includes('runtime inventory must record every executed child test case id or receipt'));
});

test('node:test scripts are refused by the native entry adapter instead of double-recorded', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-nodetest-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    write(root, 'tests/tools/check.test.mjs', "import test from 'node:test'\ntest('case', () => {})\n");
    const files = nativeRequestFiles([
        { path: 'tests/tools/check.test.mjs', adapter: 'node-test' }
    ]);
    const report = runAdapter(root, files);
    assert.ok(!report.testCases.some((entry) => entry.ownerFile === 'tests/tools/check.test.mjs'));
    assert.ok(report.diagnostics.some((entry) => (
        entry.code === 'native-entry-unowned-adapter' && entry.file === 'tests/tools/check.test.mjs'
    )));
});

test('exit-code-only wrappers are distinguished from aggregation wrappers without per-test receipts', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-exitonly-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    write(root, 'tools/test/exit-only.sh', "#!/usr/bin/env sh\nset -e\n./external-binary --check\nexit 0\n");
    write(root, 'tools/test/aggregation-gap.sh', "#!/usr/bin/env sh\nset -e\nnode tests/tools/check.test.mjs\nexit 0\n");
    const files = nativeRequestFiles([
        { path: 'tools/test/exit-only.sh', adapter: 'shell', declaredBy: ['matrix:command:unit-exit-only'] },
        { path: 'tools/test/aggregation-gap.sh', adapter: 'shell', declaredBy: ['matrix:command:unit-aggregation-gap'] }
    ]);
    const report = runAdapter(root, files);
    assert.equal(report.diagnostics.length, 0);
    const exitOnly = report.testCases.find((item) => item.id === 'shell:tools/test/exit-only.sh');
    assert.ok(exitOnly);
    assert.ok(exitOnly.traits.some((trait) => trait.name === 'FailClosedContract' && trait.value === 'exit-code-only'));
    assert.ok(!exitOnly.traits.some((trait) => trait.name === 'Aggregation'));
    assert.ok(!exitOnly.traits.some((trait) => trait.name === 'Receipt'));
    const gap = report.testCases.find((item) => item.id === 'shell:tools/test/aggregation-gap.sh');
    assert.ok(gap);
    assert.ok(gap.traits.some((trait) => trait.name === 'Aggregation' && trait.value === 'true'));
    assert.ok(gap.traits.some((trait) => trait.name === 'ChildTestFile' && trait.value === 'tests/tools/check.test.mjs'));
    assert.ok(gap.traits.some((trait) => trait.name === 'FailClosedContract' && trait.value === 'aggregation-with-evidence'));
    assert.ok(!gap.traits.some((trait) => trait.name === 'Receipt'), 'missing per-test receipts must stay visible as an evidence gap');
});

test('unknown native targets and unknown CTest registrations fail closed with precise diagnostics', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-unknown-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    write(root, 'tests/native/CMakeLists.txt', `
add_executable(FsusNativeSmokeTests AedsCrc16SmokeTests.cpp)
add_executable(FsusCrc16Fuzz AedsCrc16Fuzz.cpp)
add_executable(UnknownNativeTarget unknown.cpp)
add_test(NAME FsusNativeSmokeTests COMMAND FsusNativeSmokeTests)
add_test(NAME UnknownCtest COMMAND UnknownNativeTarget)
`);
    const report = runAdapter(root, nativeRequestFiles());
    assert.ok(report.diagnostics.some((entry) => entry.code === 'native-entry-unknown-target' && entry.message.includes('UnknownNativeTarget')));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'native-entry-unknown-ctest' && entry.message.includes('UnknownCtest')));
});

test('static smoke and fuzz cases carry runtime cross-check obligations for drift detection', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-drift-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    const report = runAdapter(root, nativeRequestFiles());
    const smoke = report.testCases.find((entry) => entry.id === 'native-smoke:aeds-crc16-known-vector');
    const fuzz = report.testCases.find((entry) => entry.id === 'native-fuzz:aeds-crc16-input-space');
    assert.ok(smoke.traits.some((trait) => trait.name === 'RuntimeObligation' && trait.value.includes('runtime CTest listing')));
    assert.ok(fuzz.traits.some((trait) => trait.name === 'RuntimeObligation' && trait.value.includes('runtime fuzz listing')));
});

test('source changes change the SourceDigest so old inventory records become stale', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-digest-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    const first = runAdapter(root, nativeRequestFiles());
    const firstDigest = first.testCases.find((entry) => entry.id === 'native-smoke:aeds-crc16-known-vector')
        .traits.find((trait) => trait.name === 'SourceDigest').value;
    write(root, 'tests/native/AedsCrc16SmokeTests.cpp', NATIVE_SMOKE_SOURCE + '\n// source changed\n');
    const second = runAdapter(root, nativeRequestFiles());
    const secondDigest = second.testCases.find((entry) => entry.id === 'native-smoke:aeds-crc16-known-vector')
        .traits.find((trait) => trait.name === 'SourceDigest').value;
    assert.notEqual(firstDigest, secondDigest);
    assert.match(secondDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('identical inputs produce byte-stable adapter reports', () =>
{
    const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-native-determinism-'));
    temporaryRoots.push(root);
    writeNativeFixture(root);
    const files = nativeRequestFiles([
        { path: 'tools/test/fixture-entrypoint.sh', adapter: 'shell', declaredBy: ['matrix:command:unit-shell-lane'] }
    ]);
    write(root, 'tools/test/fixture-entrypoint.sh', '#!/usr/bin/env sh\nset -e\nnode tests/tools/check.test.mjs\n');
    const first = runAdapter(root, files);
    const second = runAdapter(root, files);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.testCases.length, 3);
    assert.deepEqual(first.testCases.map((entry) => entry.id), second.testCases.map((entry) => entry.id));
});
