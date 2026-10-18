import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('actual native generated read parser agrees with complete shared positive and negative witnesses', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsus-property-read-native-'));
    try
    {
        const golden = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/article-property-value-read-wire-golden.json'), 'utf8'));
        const input = path.join(directory, 'cases.txt');
        const executable = path.join(directory, 'native-read-golden');
        writeFileSync(input, golden.cases.map(item => `${item.valid ? 1 : 0} ${item.name} ${item.payloadHex}`).join('\n') + '\n');
        const build = spawnSync(process.env.CXX ?? 'g++', ['-std=c++23', '-Wall', '-Wextra', '-Werror',
            '-I', path.join(root, 'src/frontend/wasm/aeds/include'),
            path.join(root, 'tests/fixtures/protocol/article-property-value-read-wire-native.cpp'),
            path.join(root, 'src/frontend/wasm/aeds/src/aeds_decode.cpp'),
            path.join(root, 'src/frontend/wasm/aeds/src/aeds_crc32.cpp'),
            path.join(root, 'src/frontend/wasm/aeds/src/pod_parse_article.cpp'), '-o', executable], { encoding: 'utf8' });
        assert.equal(build.status, 0, build.stderr || String(build.error));
        const run = spawnSync(executable, [input, String(golden.cases.length)], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, new RegExp(`cases=${golden.cases.length} all matched`));
        assert.match(run.stdout, /production dispatcher\/error13 matched/);
        const mutations = { cases: ['article-property-mutation-wire-golden.json', 'article-property-historical-read-wire-golden.json', 'authoring-extension-approval-wire-golden.json'].flatMap(file => JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol', file), 'utf8')).cases) };
        const mutationInput = path.join(directory, 'mutations.txt');
        writeFileSync(mutationInput, mutations.cases.map(item => `${item.valid ? 1 : 0} ${item.frameType}:${item.name} ${item.payloadHex}`).join('\n') + '\n');
        const mutationRun = spawnSync(executable, [mutationInput, String(mutations.cases.length), 'mutation'], { encoding: 'utf8' });
        assert.equal(mutationRun.status, 0, mutationRun.stderr);
        assert.match(mutationRun.stdout, new RegExp(`cases=${mutations.cases.length} all matched`));
        assert.equal(spawnSync(executable, [input, String(golden.cases.length + 1)]).status, 4, 'Incompletecase count must fail');
        assert.equal(spawnSync(executable, [input, '0']).status, 2, 'An empty witness set cannot establish parity');
        assert.equal(spawnSync(executable, [input, `${golden.cases.length}extra`]).status, 2);
        for (const malformed of ['1 odd 0\n', '1 nonhex gg\n', '1 extra 00 unexpected\n'])
        {
            const malformedInput = path.join(directory, 'malformed.txt');
            writeFileSync(malformedInput, malformed);
            assert.equal(spawnSync(executable, [malformedInput, '1']).status, 2);
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
        assert.equal(existsSync(directory), false);
    }
});
