import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
    computeClosure,
    materialize,
    assertDockerfile
} = await import(new URL('../../tools/docker/ssr-runtime-closure.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryPath = path.join(root, 'config/build/ssr-runtime-inputs.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));

function writeFixture(rootDir, files)
{
    for (const [rel, contents] of Object.entries(files))
    {
        const file = path.join(rootDir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
}

function writeDistFixture(distRoot)
{
    writeFixture(distRoot, {
        'server/server-public-ssr.bundle.mjs': 'import "./server-public-ssr.worker-core.mjs"\nimport "./public-ssr.mjs"\n',
        'server/server-public-ssr.worker-core.mjs': 'import { createInterface } from "node:readline"\nexport {}\n',
        'server/public-ssr.mjs': 'import "./assets/chunk-a.js"\nexport const entry = true\n',
        'server/renderPublicPage.js': 'export {}\n',
        'server/package.json': '{"private":true,"type":"module"}\n',
        'server/public-shell-emergency.css': 'body{}\n',
        'server/assets/chunk-a.js': 'export const chunk = 1\n',
        'server/dist/markdown_simd.js': 'export {}\n',
        'server/dist/markdown_simd.wasm': 'wasm',
        'server/dist/markdown_basic.js': 'export {}\n',
        'server/dist/markdown_basic.wasm': 'wasm',
        'server/.vite/manifest.json': '{}\n',
        'index.html': '<!doctype html>\n',
        'assets/client.js': 'export {}\n'
    });
}

test('computeClosure covers the whole SSR payload subtree bidirectionally', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        const closure = computeClosure(dist, inventory);
        assert.equal(closure.payloadRoot, 'server');
        assert.equal(closure.fileCount, 12);
        assert.ok(closure.payloadDigest.startsWith('sha256:'));
        assert.deepEqual(
            closure.moduleClosure.sort(),
            [
                'assets/chunk-a.js',
                'public-ssr.mjs',
                'server-public-ssr.bundle.mjs',
                'server-public-ssr.worker-core.mjs'
            ]);
        assert.equal(closure.sourceFileCount, 12);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('computeClosure fails closed when a declared entry is missing', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        fs.rmSync(path.join(dist, 'server', 'public-ssr.mjs'));
        assert.throws(
            () => computeClosure(dist, inventory),
            /entry is missing/u);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('computeClosure fails closed on undeclared payload files', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        fs.writeFileSync(path.join(dist, 'server', 'leftover.js'), 'export {}\n');
        assert.throws(
            () => computeClosure(dist, inventory),
            /outside the declared closure/u);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('computeClosure fails closed on external package imports', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        fs.writeFileSync(
            path.join(dist, 'server', 'public-ssr.mjs'),
            'import x from "left-pad"\nimport "./assets/chunk-a.js"\nexport {}\n');
        assert.throws(
            () => computeClosure(dist, inventory),
            /external packages outside the sealed payload/u);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('computeClosure fails closed on unresolved relative imports', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        fs.writeFileSync(
            path.join(dist, 'server', 'public-ssr.mjs'),
            'import "./assets/chunk-a.js"\nimport "./assets/missing.js"\nexport {}\n');
        assert.throws(
            () => computeClosure(dist, inventory),
            /import target is missing/u);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('computeClosure fails closed on forbidden payload content', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        const sourceDir = path.join(dist, 'server', 'src');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'main.ts'), 'export {}\n');
        assert.throws(
            () => computeClosure(dist, inventory),
            /forbidden segment src|outside the declared closure/u);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('computeClosure fails closed when a declared rule matches nothing', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        writeDistFixture(dist);
        fs.rmSync(path.join(dist, 'server', 'dist'), { recursive: true });
        assert.throws(
            () => computeClosure(dist, inventory),
            /runtime tree matched no payload files/u);
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('materialize stages only the sealed payload and package metadata', () =>
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-ssr-closure-'));
    try
    {
        const dist = path.join(tmp, 'dist');
        const client = path.join(tmp, 'client');
        const output = path.join(tmp, 'ClientRuntime');
        writeDistFixture(dist);
        writeFixture(client, {
            'package.json': '{"name":"fixture"}\n',
            'package-lock.json': '{}\n'
        });
        const closure = materialize(dist, client, inventory, output);
        assert.ok(fs.existsSync(path.join(output, 'server', 'server-public-ssr.bundle.mjs')));
        assert.ok(fs.existsSync(path.join(output, 'server', 'public-ssr.mjs')));
        assert.ok(fs.existsSync(path.join(output, 'server', 'assets', 'chunk-a.js')));
        assert.ok(fs.existsSync(path.join(output, 'server', 'dist', 'markdown_simd.wasm')));
        assert.ok(fs.existsSync(path.join(output, 'package', 'package.json')));
        assert.ok(fs.existsSync(path.join(output, 'package', 'package-lock.json')));
        assert.ok(fs.existsSync(path.join(output, 'manifest.json')));
        assert.equal(closure.fileCount, 12);
        const staged = [];
        const walk = (dir) =>
        {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
            {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory())
                {
                    walk(full);
                }
                else
                {
                    staged.push(path.relative(output, full).split(path.sep).join('/'));
                }
            }
        };
        walk(output);
        assert.ok(!staged.some(rel => rel.startsWith('index.html') || rel === 'assets/client.js'));
    }
    finally
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('dockerfile final stage copies the sealed payload and never the build root', () =>
{
    assert.doesNotThrow(() => assertDockerfile(root));
    const dockerfile = fs.readFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    assert.doesNotMatch(dockerfile, /COPY --from=frontend-build[^\n]*\/app\s+\.\/FsusBlog\.ClientRuntime/u);
    assert.match(dockerfile, /COPY --from=frontend-build[^\n]*\/ssr-runtime \.\/FsusBlog\.ClientRuntime/u);
});
