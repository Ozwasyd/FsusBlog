import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise the finite production-source owner without execution qualification.
import { createPublicShellFiniteInputOwner, mutateFinitePublicShellDomainResource, publicShellFiniteModuleGraph } from '../browser-contract/public-shell-finite-input-owner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
const catalogPath = publicShellFiniteModuleGraph.localeCatalog.file;

async function fixture(context)
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-finite-owner-test-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const files = [...Object.values(publicShellFiniteModuleGraph).map(item => item.file),
        'tests/browser-contract/public-shell-finite-input-owner.mjs',
        'tests/tools/public-shell-finite-input-fixture-child.mjs',
        'tools/fact-extractors/identity.mjs', 'tools/fact-extractors/lib/canonicalize.mjs',
        'src/frontend/package.json', 'src/frontend/package-lock.json'];
    for (const file of new Set(files))
    {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await copyFile(path.join(root, file), path.join(directory, file));
    }
    const git = arguments_ => execFileSync('git', ['-C', directory, ...arguments_], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    await writeFile(path.join(directory, '.gitignore'), '/src/frontend/node_modules\n');
    await symlink(await realpath(path.join(root, 'src/frontend/node_modules')), path.join(directory, 'src/frontend/node_modules'));
    git(['add', '.']);
    git(['-c', 'user.name=Finite Owner Test', '-c', 'user.email=finite-owner@test.invalid', 'commit', '-qm', 'actual source fixture']);
    const child = fork(path.join(directory, 'tests/tools/public-shell-finite-input-fixture-child.mjs'), [],
        { cwd: directory, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    context.after(async () =>
    {
        if (child.exitCode === null)
        {
            child.disconnect();
            await once(child, 'exit');
        }
    });
    const [ready] = await once(child, 'message');
    assert.equal(ready.ready, true);
    let sequence = 0;
    const pending = new Map();
    child.on('message', message =>
    {
        const response = pending.get(message.id);
        assert.ok(response, 'finite fixture response has no owned request');
        pending.delete(message.id);
        if (message.error)
        {
            response.reject(new Error(message.error));
        }
        else
        {
            response.resolve(message.value);
        }
    });
    function request(action, moduleId)
    {
        return new Promise((resolve, reject) =>
        {
            const id = sequence++;
            pending.set(id, { resolve, reject });
            child.send({ id, action, moduleId });
        });
    }
    const commit = () => git(['-c', 'user.name=Finite Owner Test', '-c', 'user.email=finite-owner@test.invalid', 'commit', '-qm', 'new actual source candidate']);
    const owner = { load: id => request('load', id), refs: () => request('refs'),
        schemaBindings: () => request('schema'), refresh: () => request('refresh') };
    return { directory, git, commit, owner };
}

test('closed IDs load all actual TS projections and all hundred locale/domain source identities', async () =>
{
    const owner = await createPublicShellFiniteInputOwner(root);
    assert.equal(Object.keys(publicShellFiniteModuleGraph).length, 24);
    for (const id of Object.keys(publicShellFiniteModuleGraph))
    {
        assert.ok(await owner.load(id));
        assert.ok(Object.isFrozen(publicShellFiniteModuleGraph[id].imports));
        assert.ok(Object.isFrozen(publicShellFiniteModuleGraph[id].deferred));
    }
    const catalog = await owner.load('localeCatalog');
    const domains = await owner.load('localeDomains');
    for (const locale of catalog.ENABLED_LOCALES)
    {
        for (const domain of domains.LOCALE_DOMAINS)
        {
            const production = await owner.loadDomain(locale.code, domain);
            assert.deepEqual(production.localeDomainIdentity, { locale: locale.code, domain });
        }
    }
    assert.equal(owner.qualificationEligible, false);
    assert.equal(owner.policyPromotion, false);
    assert.ok(Object.isFrozen(owner));
    assert.ok(owner.refs().every(item => /^sha256:[a-f0-9]{64}$/u.test(item.digest)));
    await assert.rejects(owner.load('constructor'), /unknown finite/u);
    await assert.rejects(owner.load('../../outside'), /unknown finite/u);
    await assert.rejects(owner.loadDomain('unknown', 'public'), /unknown finite domain locale/u);
    await assert.rejects(owner.loadDomain('zh-CN', 'unknown'), /unknown finite domain/u);
});

test('source cache requires committed candidate bytes and a fresh owner after real HEAD changes', async context =>
{
    const { directory, git, commit, owner } = await fixture(context);
    const before = await owner.load('localeCatalog');
    const refBefore = (await owner.refs()).find(item => item.path === catalogPath);
    const original = await readFile(path.join(directory, catalogPath), 'utf8');
    await writeFile(path.join(directory, catalogPath), original.replace('简体中文', '有限输入缓存更新'));
    await assert.rejects(owner.load('localeCatalog'), /bytes differ from the captured Git index/u);
    git(['add', '--', catalogPath]);
    await assert.rejects(owner.load('localeCatalog'), /index identity changed/u);
    await owner.refresh();
    await assert.rejects(owner.load('localeCatalog'), /committed candidate blob/u);
    commit();
    await assert.rejects(owner.load('localeCatalog'), /replay identity changed/u);
    await owner.refresh();
    const after = await owner.load('localeCatalog');
    assert.notEqual(after, before);
    assert.equal(after.LOCALE_CATALOG[0].nativeName, '有限输入缓存更新');
    assert.notEqual((await owner.refs()).find(item => item.path === catalogPath).digest, refBefore.digest);
    assert.deepEqual(await owner.load('localeCatalog'), after);
    git(['-c', 'user.name=Finite Owner Test', '-c', 'user.email=finite-owner@test.invalid', 'commit', '--allow-empty', '-qm', 'changed replay']);
    await assert.rejects(owner.load('localeCatalog'), /replay identity changed/u);
});

test('finite root refuses lexical aliases, symlink aliases and Git subdirectories', async context =>
{
    const { directory } = await fixture(context);
    await assert.rejects(createPublicShellFiniteInputOwner(directory + '/.'), /canonical/u);
    const alias = directory + '-alias';
    context.after(() => rm(alias, { force: true }));
    await symlink(directory, alias);
    await assert.rejects(createPublicShellFiniteInputOwner(alias), /symlink alias/u);
    await assert.rejects(createPublicShellFiniteInputOwner(directory), /executing owner checkout/u);
    await assert.rejects(createPublicShellFiniteInputOwner(path.join(directory, 'src')), /executing owner checkout/u);
});

for (const kind of ['symlink', 'hardlink', 'fifo', 'invalid-utf8', 'bom'])
{
    test(`actual source refuses ${kind} without executing input`, async context =>
    {
        const { directory, owner } = await fixture(context);
        const file = path.join(directory, catalogPath);
        if (kind === 'symlink')
        {
            await rm(file);
            await symlink(path.join(root, catalogPath), file);
        }
        else if (kind === 'hardlink')
        {
            await link(file, file + '.link');
        }
        else if (kind === 'fifo')
        {
            await rm(file);
            execFileSync('mkfifo', [file]);
        }
        else
        {
            await writeFile(file, kind === 'bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(file)]) : Buffer.from([0xff]));
        }
        await assert.rejects(owner.load('localeCatalog'), /symlink|regular single-link|encoded data|BOM|captured Git index/u);
    });
}

test('production graph requires exact owned imports, including quote-independent replacements', async context =>
{
    const { directory, git, commit, owner } = await fixture(context);
    const file = path.join(directory, publicShellFiniteModuleGraph.selector.file);
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace("'@/locales'", '"@/locales"'));
    git(['add', '--', publicShellFiniteModuleGraph.selector.file]);
    commit();
    await owner.refresh();
    assert.ok(await owner.load('selector'));
    await writeFile(file, original.replace("'@/locales'", "'@/locales/other'"));
    git(['add', '--', publicShellFiniteModuleGraph.selector.file]);
    commit();
    await owner.refresh();
    await assert.rejects(owner.load('selector'), /unowned production import/u);
    await writeFile(file, original + '\nawait import("node:fs");\n');
    git(['add', '--', publicShellFiniteModuleGraph.selector.file]);
    commit();
    await owner.refresh();
    await assert.rejects(owner.load('selector'), /unowned deferred production import/u);
    await writeFile(file, original.replace("import { ENABLED_LOCALES } from '@/locales';", ''));
    git(['add', '--', publicShellFiniteModuleGraph.selector.file]);
    commit();
    await owner.refresh();
    await assert.rejects(owner.load('selector'), /replacement graph drift/u);
});

test('schema projection refuses missing actual production owner functions', async context =>
{
    const { directory, git, commit, owner } = await fixture(context);
    const file = path.join(directory, publicShellFiniteModuleGraph.localeSchema.file);
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('function leafKind(', 'function otherLeafKind('));
    git(['add', '--', publicShellFiniteModuleGraph.localeSchema.file]);
    commit();
    await owner.refresh();
    await assert.rejects(owner.schemaBindings(), /schema functions missing/u);
});

test('source removed from the current Git index cannot retain captured ownership', async context =>
{
    const { git, owner } = await fixture(context);
    git(['rm', '--cached', '--', catalogPath]);
    await assert.rejects(owner.load('localeCatalog'), /current tracked owner changed/u);
});

test('sealed recipes require real immutable schema bindings, exact identity and inert original bytes', async () =>
{
    const owner = await createPublicShellFiniteInputOwner(root);
    const domains = await owner.schemaBindings();
    assert.ok(Object.isFrozen(domains.exportNames));
    assert.ok(Object.isFrozen(domains.schemaDigests));
    const identity = { kind: 'domain', locale: 'zh-CN', domain: 'public', exportName: domains.exportNames.public, schemaDigest: domains.schemaDigests.public };
    const body = Buffer.from(stripTypeScriptTypes(await readFile(path.join(root, 'src/frontend/src/locales/zh-CN/public.ts'), 'utf8')));
    const input = { body, identity, domains, mode: 'invalid-digest' };
    for (const [field, value] of [['locale', 'unknown'], ['domain', 'unknown'], ['kind', 'font'], ['exportName', 'other'], ['schemaDigest', 'fnv1a64:0000000000000000']])
    {
        await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, identity: { ...identity, [field]: value } }));
    }
    await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, domains: { ...domains } }), /finite source owner/u);
    await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, mode: 'callback' }), /unknown domain mutation/u);
    await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, identity: { ...identity, extra: true } }), /unknown finite domain identity/u);
    await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, identity: { ...identity, [Symbol('unknown')]: true } }), /unknown finite domain identity/u);
    const getter = { ...identity };
    Object.defineProperty(getter, 'locale', { get: () => assert.fail('accessor executed') });
    await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, identity: getter }), /accessors/u);
    for (const prefix of ['globalThis.__finiteUnowned = true;', 'const unowned = (() => { throw Error("executed"); })();', 'import "node:fs";', 'const unowned = { get value() { throw Error("executed"); } };'])
    {
        await assert.rejects(mutateFinitePublicShellDomainResource({ ...input, body: Buffer.concat([Buffer.from(prefix), body]) }), /sealed resource|standalone/u);
    }
    assert.equal(globalThis.__finiteUnowned, undefined);
    for (const mode of ['invalid-content', 'invalid-schema', 'invalid-digest'])
    {
        const mutation = await mutateFinitePublicShellDomainResource({ ...input, mode });
        assert.equal(mutation.mutation.schemaDigest, identity.schemaDigest);
        if (mode === 'invalid-content')
        {
            assert.throws(() => domains.parse(Buffer.from(mutation.body).toString('utf8')));
        }
        else if (mode === 'invalid-schema')
        {
            assert.notEqual(mutation.mutation.mutatedSchemaDigest, identity.schemaDigest);
        }
        else
        {
            assert.equal(mutation.mutation.mutatedSchemaDigest, identity.schemaDigest);
        }
    }
});
