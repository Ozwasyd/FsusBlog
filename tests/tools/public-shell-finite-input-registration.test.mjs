import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise only the reviewed semantic-roster producer.
import { preparePublicShellFiniteInputRegistration, verifyPublicShellFiniteInputBinding } from '../../tools/test-matrix/register-public-shell-finite-input.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const indexPath = 'config/testing/release-final-execution-authority-index.json';
const ownerPath = 'tests/browser-contract/public-shell-finite-input-owner.mjs';
const authorityPath = 'tests/fixtures/test-matrix/release-final-execution-target-authority.json';
const registered = preparePublicShellFiniteInputRegistration(root);
const entry = registered.runtimeDynamicImports.find(item => item.owner === ownerPath);

function fixture(context, binding = false)
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-finite-registration-test-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const file of [ownerPath, indexPath, 'tests/matrix.yml', ...entry.dependencies,
        'tools/governance/cross-repository-dependency-acceptance.mjs',
        'tests/tools/test-matrix-scheduler.test.mjs',
        'tools/test/execution-failure-diagnostic.mjs',
        'tools/test/execution-envelope-services.mjs', ...(binding ? [authorityPath] : [])])
    {
        mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        copyFileSync(path.join(root, file), path.join(directory, file));
    }
    if (binding)
    {
        // Negative-only copied DATA keeps the current index binding before testing deeper refusal guards.
        const copiedAuthorityPath = path.join(directory, authorityPath);
        const copiedAuthority = JSON.parse(readFileSync(copiedAuthorityPath, 'utf8'));
        copiedAuthority.sourceIndexDigest = `sha256:${createHash('sha256')
            .update(readFileSync(path.join(directory, indexPath))).digest('hex')}`;
        writeFileSync(copiedAuthorityPath, JSON.stringify(copiedAuthority));
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
    assert.equal(registered.runtimeDynamicImports.length, 50);
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

test('binding rejects a genuinely committed changed closure source under the same index', context =>
{
    const { directory, git } = fixture(context, true);
    const file = 'src/frontend/src/locales/ja-JP/public.ts';
    const beforeIndex = readFileSync(path.join(directory, indexPath));
    const authority = JSON.parse(readFileSync(path.join(directory, authorityPath)));
    const source = authority.closureFiles.find(item => item.path === file);
    assert.ok(source, 'actual canonical authority contains the neighboring production module');
    authority.closureFiles = [source, ...authority.closureFiles.filter(item => item !== source)];
    writeFileSync(path.join(directory, authorityPath), JSON.stringify(authority));
    writeFileSync(path.join(directory, file), `${readFileSync(path.join(directory, file), 'utf8')}\n// genuinely committed next domain candidate\n`);
    git(['add', file]);
    git(['-c', 'user.name=Finite Registration Test', '-c', 'user.email=finite-registration@test.invalid', 'commit', '-qm', 'changed actual domain source']);
    assert.ok(beforeIndex.equals(readFileSync(path.join(directory, indexPath))));
    assert.throws(() => verifyPublicShellFiniteInputBinding(directory), /canonical authority closure bytes are stale/u);
});

test('binding rejects a target digest detached from its actual canonical closure record', context =>
{
    const { directory } = fixture(context, true);
    const authority = JSON.parse(readFileSync(path.join(directory, authorityPath)));
    const target = authority.targets.find(item => authority.closureFiles.some(file => file.path === item.target));
    assert.ok(target, 'actual canonical authority contains a shared target/closure source');
    target.contentDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(path.join(directory, authorityPath), JSON.stringify(authority));
    assert.throws(() => verifyPublicShellFiniteInputBinding(directory), /target differs from its actual closure source/u);
});


test('registration rejects an unknown import appended to the reviewed current prior', context =>
{
    const { directory } = fixture(context);
    const index = JSON.parse(readFileSync(path.join(directory, indexPath), 'utf8'));
    index.runtimeDynamicImports.push({ owner: 'unknown.mjs', sourceDigest: `sha256:${'0'.repeat(64)}`,
        expressionDigest: `sha256:${'1'.repeat(64)}`, kind: 'runtime-module-path', dependencies: [] });
    writeFileSync(path.join(directory, indexPath), JSON.stringify(index));
    assert.throws(() => preparePublicShellFiniteInputRegistration(directory), /reviewed current dynamic import entries/u);
});

test('registration rejects replacing a reviewed scheduler import dependency', context =>
{
    const { directory } = fixture(context);
    const index = JSON.parse(readFileSync(path.join(directory, indexPath), 'utf8'));
    const reviewed = index.runtimeDynamicImports.find(item => item.owner === 'tests/tools/test-matrix-scheduler.test.mjs'
        && item.dependencies.includes('tools/test/execution-failure-diagnostic.mjs'));
    assert.ok(reviewed, 'reviewed diagnostic import is present');
    reviewed.dependencies = ['tools/test/process-identity.mjs'];
    writeFileSync(path.join(directory, indexPath), JSON.stringify(index));
    assert.throws(() => preparePublicShellFiniteInputRegistration(directory), /reviewed current execution index authority changed/u);
});
