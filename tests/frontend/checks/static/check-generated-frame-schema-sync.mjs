#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
    assert,
    loadBackendGoldenCatalog,
    loadMatrix,
    loadProtocol,
    root
} from '../support/crossStackMatrix.mjs';

const matrix = loadMatrix();
const protocol = loadProtocol();
const golden = loadBackendGoldenCatalog();
const frontendDecoder = readFileSync(resolve(root, matrix.schema.frontendDecoder), 'utf8');
const backendEnum = readFileSync(resolve(root, matrix.schema.backendEnum), 'utf8');
const cppHeaderPath = resolve(root, 'src/frontend/wasm/aeds/include/aeds_frame.hpp');
const cppHeader = readFileSync(cppHeaderPath, 'utf8');

const protocolFrames = new Map(protocol.frameTypes.map(frame => [frame.name, frame.value]));
const goldenFrames = new Map(golden.frames.map(frame => [frame.name, frame.value]));
const cppFrames = new Map(
    [...cppHeader.matchAll(/^ {4}([A-Z][A-Za-z0-9]*) = (\d+),$/gmu)]
        .map(match => [match[1], Number(match[2])])
);

const generated = spawnSync(process.execPath, ['tools/frontend/generate-aeds-protocol.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000
});
assert(generated.status === 0, `AEDS generated protocol drift: ${generated.stderr || generated.stdout}`);

for (const [name, value] of protocolFrames)
{
    assert(backendEnum.includes(`${name} = ${value}`), `backend enum missing ${name}=${value}`);
    assert(goldenFrames.get(name) === value, `backend golden catalog mismatch for ${name}`);
    assert(cppFrames.get(name) === value, `C++ frame enum mismatch for ${name}`);
}

for (const [name] of goldenFrames)
{
    assert(protocolFrames.has(name), `backend golden catalog has stale frame ${name}`);
}
for (const [name] of cppFrames)
{
    assert(protocolFrames.has(name), `C++ frame enum has stale frame ${name}`);
}
assert(cppFrames.size === protocolFrames.size, 'C++ frame enum count differs from the protocol manifest');

assert(frontendDecoder.includes('aeds-protocol.json'), 'frontend test decoder must read shared protocol JSON');
assert(!/const\s+FRAME_[A-Z0-9_]+\s*=\s*\d+/g.test(frontendDecoder), 'frontend test decoder contains hard-coded frame numbers');
assert(!/const\s+AEDS_VERSION\s*=\s*\d+/g.test(frontendDecoder), 'frontend test decoder contains hard-coded AEDS version');
assert(!/const\s+AEDS_HEADER_LENGTH\s*=\s*\d+/g.test(frontendDecoder), 'frontend test decoder contains hard-coded AEDS header length');

const temp = mkdtempSync(resolve(tmpdir(), 'fsusblog-aeds-cpp-contract-'));
try
{
    const executable = resolve(temp, 'aeds-protocol-contract');
    const include = resolve(root, 'src/frontend/wasm/aeds/include');
    const compile = spawnSync(process.env.CXX || 'c++', [
        '-std=c++23', '-Wall', '-Wextra', '-Werror',
        `-I${include}`,
        resolve(root, 'tests/frontend/fixtures/aeds-protocol-cpp-contract.cpp'),
        resolve(root, 'src/frontend/wasm/aeds/src/aeds_decode.cpp'),
        resolve(root, 'src/frontend/wasm/aeds/src/aeds_crc32.cpp'),
        resolve(root, 'src/frontend/wasm/aeds/src/pod_parse_article.cpp'),
        '-o', executable
    ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert(compile.status === 0, `C++ AEDS contract probe failed to compile: ${compile.stderr || compile.stdout}`);

    const activeFrames = protocol.frameTypes.filter(frame => !frame.name.startsWith('Retired'));
    const namedRetiredFrames = protocol.frameTypes.filter(frame => frame.name.startsWith('Retired'));
    const allFrames = spawnSync(executable, ['all', ...activeFrames.map(frame => String(frame.value))], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
    assert(allFrames.status === 0, `C++ decoder did not recognize every generated frame: ${allFrames.stderr || allFrames.stdout}`);

    const retiredFrames = spawnSync(executable, [
        'retired',
        ...protocol.retiredFrameValues.map(frame => String(frame.value)),
        ...namedRetiredFrames.map(frame => String(frame.value))
    ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert(retiredFrames.status === 0, `C++ decoder accepted a retired frame: ${retiredFrames.stderr || retiredFrames.stdout}`);

    const rejectedFrame = spawnSync(executable, ['reject', '65535'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
    assert(rejectedFrame.status === 0, `C++ decoder accepted an unknown frame: ${rejectedFrame.stderr || rejectedFrame.stdout}`);

    const fixtureHex = readFileSync(resolve(root, 'tests/fixtures/protocol/mutation-id-frame.hex'), 'utf8').replace(/\s+/gu, '');
    const roundTrip = spawnSync(executable, ['decode', fixtureHex, String(protocolFrames.get('MutationId')), '0102030405'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000
    });
    assert(roundTrip.status === 0, `C# golden frame did not round-trip through the C++ decoder: ${roundTrip.stderr || roundTrip.stdout}`);

    const canvasGolden = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/protocol/authoring-canvas-wire-golden.json'), 'utf8'));
    const canvasSchema = JSON.parse(readFileSync(resolve(root, 'src/shared/Contracts/Validation/authoring-canvas-wire.json'), 'utf8'));
    for (const frame of canvasSchema.roots)
    {
        assert(protocolFrames.get(frame.type) === frame.frameType, `Canvas frame owner drift: ${frame.type}`);
        assert(canvasGolden.cases.some(row => row.frameType === frame.frameType && row.valid), `Canvas positive golden missing: ${frame.type}`);
        assert(canvasGolden.cases.some(row => row.frameType === frame.frameType && !row.valid), `Canvas negative golden missing: ${frame.type}`);
    }
    const canvasPayloads = spawnSync(executable, ['canvas-payloads'], {
        cwd: root,
        input: canvasGolden.cases.map(row => `${row.frameType} ${row.valid ? 1 : 0} ${row.payloadHex}`).join('\n') + '\n',
        encoding: 'utf8',
        timeout: 30_000
    });
    assert(canvasPayloads.status === 0, `Canvas goldens failed through production C++ decoder: ${canvasPayloads.stderr || canvasPayloads.stdout}`);
    console.log(canvasPayloads.stdout.trim());
}
finally
{
    rmSync(temp, { recursive: true, force: true });
}

console.log(`[generated-frame-schema-sync] ok frames=${protocol.frameTypes.length}`);
