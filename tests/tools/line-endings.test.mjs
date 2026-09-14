import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(root, 'tools/style/line-ending-invariant.mjs');

function run(command, argumentsList, options = {})
{
    const result = spawnSync(command, argumentsList, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: { ...process.env, ...(options.env ?? {}) }
    });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
}

function runGit(fixtureRoot, argumentsList)
{
    const result = run('git', argumentsList, { cwd: fixtureRoot });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
}

function writeFixture(fixtureRoot, relativePath, content)
{
    const target = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function createFixture()
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-line-endings-'));
    runGit(fixtureRoot, ['init', '--quiet']);
    runGit(fixtureRoot, ['config', 'core.autocrlf', 'false']);
    runGit(fixtureRoot, ['config', 'core.eol', 'lf']);
    runGit(fixtureRoot, ['config', 'core.safecrlf', 'false']);
    writeFixture(fixtureRoot, '.gitattributes', '* text=auto eol=lf\n*.cmd text eol=crlf\n');
    return fixtureRoot;
}

function runChecker(fixtureRoot)
{
    return run(process.execPath, [checker, '--root', fixtureRoot], { cwd: fixtureRoot });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

function withFixture(callback)
{
    const fixtureRoot = createFixture();
    try
    {
        callback(fixtureRoot);
    }
    finally
    {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

test('repository publishes the LF policy, Windows diagnostics and static governance entry point', () =>
{
    const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
    const documentation = fs.readFileSync(
        path.join(root, 'docs/development/native-tooling-style-enforcement.md'),
        'utf8'
    );
    const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');

    assert.match(attributes, /^\* text=auto eol=lf$/mu);
    assert.match(documentation, /git config --show-origin --get core\.autocrlf/u);
    assert.match(documentation, /git ls-files --eol/u);
    assert.match(documentation, /node tools\/style\/line-ending-invariant\.mjs/u);
    assert.match(lane, /tools\/style\/line-ending-invariant\.mjs/u);
});

test('line-ending gate accepts LF text, an explicit CRLF exception and binary bytes', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'sample/readme.txt', 'first\nsecond\n');
        writeFixture(fixtureRoot, 'sample/windows.cmd', '@echo off\r\necho fixture\r\n');
        writeFixture(
            fixtureRoot,
            'sample/binary.dat',
            Buffer.from([0x00, 0x0d, 0x0a, 0x0d, 0xff])
        );
        runGit(fixtureRoot, ['add', '.']);

        const result = runChecker(fixtureRoot);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /crlfExceptions=1/u);
        assert.match(result.stdout, /binary=1/u);
    });
});

test('line-ending gate rejects every LF-policy CRLF file in stable path order', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'z-last.txt', 'valid\n');
        writeFixture(fixtureRoot, 'a-first.txt', 'valid\n');
        runGit(fixtureRoot, ['add', '.']);
        writeFixture(fixtureRoot, 'z-last.txt', 'first\r\nsecond\r\n');
        writeFixture(fixtureRoot, 'a-first.txt', 'first\r\nsecond\r\n');

        const result = runChecker(fixtureRoot);
        assert.equal(result.status, 1, output(result));
        const first = result.stderr.indexOf('a-first.txt: expected LF');
        const last = result.stderr.indexOf('z-last.txt: expected LF');
        assert.ok(first >= 0, result.stderr);
        assert.ok(last > first, result.stderr);
        assert.match(result.stderr, /violations=2/u);
    });
});

test('line-ending gate rejects mixed LF and CRLF endings', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'mixed.txt', 'valid\n');
        runGit(fixtureRoot, ['add', '.']);
        writeFixture(fixtureRoot, 'mixed.txt', 'first\r\nsecond\n');

        const result = runChecker(fixtureRoot);
        assert.equal(result.status, 1, output(result));
        assert.match(result.stderr, /mixed\.txt: contains mixed line endings \(CRLF=1, LF=1\)/u);
    });
});

test('line-ending gate rejects a lone carriage return', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'lone-cr.txt', 'valid\n');
        runGit(fixtureRoot, ['add', '.']);
        writeFixture(fixtureRoot, 'lone-cr.txt', 'first\rsecond\n');

        const result = runChecker(fixtureRoot);
        assert.equal(result.status, 1, output(result));
        assert.match(result.stderr, /lone-cr\.txt: contains 1 lone carriage-return byte/u);
    });
});

test('line-ending gate is read-only', () =>
{
    withFixture((fixtureRoot) =>
    {
        const invalid = Buffer.from('first\r\nsecond\r\n');
        writeFixture(fixtureRoot, 'read-only.txt', 'valid\n');
        runGit(fixtureRoot, ['add', '.']);
        writeFixture(fixtureRoot, 'read-only.txt', invalid);

        const result = runChecker(fixtureRoot);
        assert.equal(result.status, 1, output(result));
        assert.deepEqual(fs.readFileSync(path.join(fixtureRoot, 'read-only.txt')), invalid);
    });
});
