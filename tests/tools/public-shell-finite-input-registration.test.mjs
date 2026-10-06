import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise only the reviewed semantic-roster producer.
import { preparePublicShellFiniteInputRegistration } from '../../tools/test-matrix/register-public-shell-finite-input.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const indexPath = 'config/testing/release-final-execution-authority-index.json';
const ownerPath = 'tests/browser-contract/public-shell-finite-input-owner.mjs';
const registered = preparePublicShellFiniteInputRegistration(root);
const entry = registered.runtimeDynamicImports.find(item => item.owner === ownerPath);

function fixture(context)
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-finite-registration-test-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const file of [ownerPath, indexPath, ...entry.dependencies])
    {
        mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        copyFileSync(path.join(root, file), path.join(directory, file));
    }
    const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Finite Registration Test', '-c', 'user.email=finite-registration@test.invalid', 'commit', '-qm', 'actual source fixture']);
    return { directory, git };
}

test('registration preserves the original index and emits one exact reviewed sink without writing', () =>
{
    const bytes = readFileSync(path.join(root, indexPath));
    const original = JSON.parse(bytes);
    assert.equal(registered.runtimeDynamicImports.length, 48);
    assert.equal(entry.dependencies.length, 131);
    assert.equal(new Set(entry.dependencies).size, 131);
    assert.deepEqual(registered.runtimeDynamicImports.filter(item => item.owner !== ownerPath),
        original.runtimeDynamicImports.filter(item => item.owner !== ownerPath));
    assert.deepEqual(registered.runtimeDynamicShellSources, original.runtimeDynamicShellSources);
    assert.ok(bytes.equals(readFileSync(path.join(root, indexPath))));
});

test('registration rejects dirty actual source at the same HEAD', context =>
{
    const { directory } = fixture(context);
    const file = path.join(directory, ownerPath);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// changed actual source\n`);
    assert.throws(() => preparePublicShellFiniteInputRegistration(directory), /source bytes differ from HEAD/u);
});

test('registration rejects staged-only changes in a neighboring actual locale dependency', context =>
{
    const { directory, git } = fixture(context);
    const file = 'src/frontend/src/locales/ja-JP/public.ts';
    writeFileSync(path.join(directory, file), `${readFileSync(path.join(directory, file), 'utf8')}\n// staged-only domain\n`);
    git(['add', file]);
    assert.throws(() => preparePublicShellFiniteInputRegistration(directory), /source index differs from HEAD/u);
});

test('registration rejects loss of any original shell admission', context =>
{
    const { directory } = fixture(context);
    const index = JSON.parse(readFileSync(path.join(directory, indexPath), 'utf8'));
    index.runtimeDynamicShellSources.pop();
    writeFileSync(path.join(directory, indexPath), JSON.stringify(index));
    assert.throws(() => preparePublicShellFiniteInputRegistration(directory), /original dynamic shell entries/u);
});

test('registration rejects an existing sink with a shortened dependency graph', context =>
{
    const { directory } = fixture(context);
    const index = structuredClone(registered);
    index.runtimeDynamicImports.find(item => item.owner === ownerPath).dependencies.pop();
    writeFileSync(path.join(directory, indexPath), JSON.stringify(index));
    assert.throws(() => preparePublicShellFiniteInputRegistration(directory), /existing finite registration differs/u);
});
