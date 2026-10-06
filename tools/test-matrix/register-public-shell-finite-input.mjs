#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the canonical source-root and replay identity authority.
import { resolveGitRepositoryAuthority, resolveSourceCommit, runGitRepository } from '../fact-extractors/identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../src/frontend/package.json', import.meta.url));
const { parse } = require('acorn');
const ownerPath = 'tests/browser-contract/public-shell-finite-input-owner.mjs';
const indexPath = 'config/testing/release-final-execution-authority-index.json';
const authorityPath = 'tests/fixtures/test-matrix/release-final-execution-target-authority.json';
const bindingPath = 'artifacts/change-contract/public-shell-finite-input-generated-binding.json';
// This reviewed source identity is an explicit registration, never an automatic refresh.
const reviewedSourceDigest = 'sha256:7087375c2be055460248f44424bc005c28d170286350222780d18d07c6954b20';
const originalIndexDigest = 'sha256:d9b6bd10a5f57a020e5be93273ba80a1499cb40b3f38cf759815a051bed76047';
const reviewedDependencies = Object.freeze([
    "src/frontend/package-lock.json",
    "src/frontend/package.json",
    "src/frontend/src/adapters/binary/localePreferenceAdapter.ts",
    "src/frontend/src/adapters/binary/types.ts",
    "src/frontend/src/api/binaryFrame.ts",
    "src/frontend/src/api/contracts.ts",
    "src/frontend/src/bootstrap/publicAotBinaryPayload.ts",
    "src/frontend/src/codecs/binary/reader.ts",
    "src/frontend/src/components/i18n/projectLocaleSelectorItems.ts",
    "src/frontend/src/generated/releaseIdContract.ts",
    "src/frontend/src/locales/de-DE/admin.ts",
    "src/frontend/src/locales/de-DE/article.ts",
    "src/frontend/src/locales/de-DE/auth.ts",
    "src/frontend/src/locales/de-DE/common.ts",
    "src/frontend/src/locales/de-DE/errors.ts",
    "src/frontend/src/locales/de-DE/identity.ts",
    "src/frontend/src/locales/de-DE/layout.ts",
    "src/frontend/src/locales/de-DE/messages.ts",
    "src/frontend/src/locales/de-DE/public.ts",
    "src/frontend/src/locales/de-DE/security.ts",
    "src/frontend/src/locales/en-US/admin.ts",
    "src/frontend/src/locales/en-US/article.ts",
    "src/frontend/src/locales/en-US/auth.ts",
    "src/frontend/src/locales/en-US/common.ts",
    "src/frontend/src/locales/en-US/errors.ts",
    "src/frontend/src/locales/en-US/identity.ts",
    "src/frontend/src/locales/en-US/layout.ts",
    "src/frontend/src/locales/en-US/messages.ts",
    "src/frontend/src/locales/en-US/public.ts",
    "src/frontend/src/locales/en-US/security.ts",
    "src/frontend/src/locales/es-419/admin.ts",
    "src/frontend/src/locales/es-419/article.ts",
    "src/frontend/src/locales/es-419/auth.ts",
    "src/frontend/src/locales/es-419/common.ts",
    "src/frontend/src/locales/es-419/errors.ts",
    "src/frontend/src/locales/es-419/identity.ts",
    "src/frontend/src/locales/es-419/layout.ts",
    "src/frontend/src/locales/es-419/messages.ts",
    "src/frontend/src/locales/es-419/public.ts",
    "src/frontend/src/locales/es-419/security.ts",
    "src/frontend/src/locales/fr-FR/admin.ts",
    "src/frontend/src/locales/fr-FR/article.ts",
    "src/frontend/src/locales/fr-FR/auth.ts",
    "src/frontend/src/locales/fr-FR/common.ts",
    "src/frontend/src/locales/fr-FR/errors.ts",
    "src/frontend/src/locales/fr-FR/identity.ts",
    "src/frontend/src/locales/fr-FR/layout.ts",
    "src/frontend/src/locales/fr-FR/messages.ts",
    "src/frontend/src/locales/fr-FR/public.ts",
    "src/frontend/src/locales/fr-FR/security.ts",
    "src/frontend/src/locales/ja-JP/admin.ts",
    "src/frontend/src/locales/ja-JP/article.ts",
    "src/frontend/src/locales/ja-JP/auth.ts",
    "src/frontend/src/locales/ja-JP/common.ts",
    "src/frontend/src/locales/ja-JP/errors.ts",
    "src/frontend/src/locales/ja-JP/identity.ts",
    "src/frontend/src/locales/ja-JP/layout.ts",
    "src/frontend/src/locales/ja-JP/messages.ts",
    "src/frontend/src/locales/ja-JP/public.ts",
    "src/frontend/src/locales/ja-JP/security.ts",
    "src/frontend/src/locales/ko-KR/admin.ts",
    "src/frontend/src/locales/ko-KR/article.ts",
    "src/frontend/src/locales/ko-KR/auth.ts",
    "src/frontend/src/locales/ko-KR/common.ts",
    "src/frontend/src/locales/ko-KR/errors.ts",
    "src/frontend/src/locales/ko-KR/identity.ts",
    "src/frontend/src/locales/ko-KR/layout.ts",
    "src/frontend/src/locales/ko-KR/messages.ts",
    "src/frontend/src/locales/ko-KR/public.ts",
    "src/frontend/src/locales/ko-KR/security.ts",
    "src/frontend/src/locales/localeCatalog.ts",
    "src/frontend/src/locales/localeDomainBundleStore.ts",
    "src/frontend/src/locales/localeDomains.ts",
    "src/frontend/src/locales/localeFontCatalog.ts",
    "src/frontend/src/locales/pt-BR/admin.ts",
    "src/frontend/src/locales/pt-BR/article.ts",
    "src/frontend/src/locales/pt-BR/auth.ts",
    "src/frontend/src/locales/pt-BR/common.ts",
    "src/frontend/src/locales/pt-BR/errors.ts",
    "src/frontend/src/locales/pt-BR/identity.ts",
    "src/frontend/src/locales/pt-BR/layout.ts",
    "src/frontend/src/locales/pt-BR/messages.ts",
    "src/frontend/src/locales/pt-BR/public.ts",
    "src/frontend/src/locales/pt-BR/security.ts",
    "src/frontend/src/locales/routeLocaleDomains.ts",
    "src/frontend/src/locales/ru-RU/admin.ts",
    "src/frontend/src/locales/ru-RU/article.ts",
    "src/frontend/src/locales/ru-RU/auth.ts",
    "src/frontend/src/locales/ru-RU/common.ts",
    "src/frontend/src/locales/ru-RU/errors.ts",
    "src/frontend/src/locales/ru-RU/identity.ts",
    "src/frontend/src/locales/ru-RU/layout.ts",
    "src/frontend/src/locales/ru-RU/messages.ts",
    "src/frontend/src/locales/ru-RU/public.ts",
    "src/frontend/src/locales/ru-RU/security.ts",
    "src/frontend/src/locales/zh-CN/admin.ts",
    "src/frontend/src/locales/zh-CN/article.ts",
    "src/frontend/src/locales/zh-CN/auth.ts",
    "src/frontend/src/locales/zh-CN/common.ts",
    "src/frontend/src/locales/zh-CN/errors.ts",
    "src/frontend/src/locales/zh-CN/identity.ts",
    "src/frontend/src/locales/zh-CN/layout.ts",
    "src/frontend/src/locales/zh-CN/messages.ts",
    "src/frontend/src/locales/zh-CN/public.ts",
    "src/frontend/src/locales/zh-CN/security.ts",
    "src/frontend/src/locales/zh-Hant/admin.ts",
    "src/frontend/src/locales/zh-Hant/article.ts",
    "src/frontend/src/locales/zh-Hant/auth.ts",
    "src/frontend/src/locales/zh-Hant/common.ts",
    "src/frontend/src/locales/zh-Hant/errors.ts",
    "src/frontend/src/locales/zh-Hant/identity.ts",
    "src/frontend/src/locales/zh-Hant/layout.ts",
    "src/frontend/src/locales/zh-Hant/messages.ts",
    "src/frontend/src/locales/zh-Hant/public.ts",
    "src/frontend/src/locales/zh-Hant/security.ts",
    "src/frontend/src/public-renderers/generated/publicPageManifest.ts",
    "src/frontend/src/public-renderers/publicFilterSemantics.ts",
    "src/frontend/src/public-renderers/publicFixedPageSemantics.ts",
    "src/frontend/src/public-renderers/publicRouteIdentity.ts",
    "src/frontend/src/public-renderers/publicRoutePaths.ts",
    "src/frontend/src/public-renderers/publicRouteRegistry.ts",
    "src/frontend/src/router/publicSeoHead.ts",
    "src/frontend/src/router/routeTitleContract.ts",
    "src/frontend/src/security/trustedTypesRuntime.ts",
    "src/frontend/src/utils/appError.ts",
    "src/frontend/src/views/Archive.vue",
    "src/frontend/src/views/ArticleDetail.vue",
    "src/frontend/src/views/FilterView.vue",
    "src/frontend/src/views/Home.vue",
    "src/frontend/src/views/PublicDynamicPage.vue",
    "src/frontend/wasm/web/protocol/frame.ts"
]);
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function readCommittedSource(repositoryRoot, authority, sourceCommit, relative)
{
    const git = args => runGitRepository(authority, args, { encoding: null });
    let cursor = repositoryRoot;
    for (const part of relative.split('/'))
    {
        cursor = path.join(cursor, part);
        assert.ok(!fs.lstatSync(cursor).isSymbolicLink(), 'registration source cannot be a symlink');
    }
    const stat = fs.lstatSync(cursor);
    assert.ok(stat.isFile() && stat.nlink === 1, 'registration source must be a regular single-link file');
    const bytes = fs.readFileSync(cursor);
    const head = git(['ls-tree', sourceCommit, '--', relative]).toString('utf8').trim();
    const index = git(['ls-files', '--stage', '--', relative]).toString('utf8').trim();
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(head);
    assert.ok(match && match[3] === relative, 'registration source must belong to a committed regular blob');
    assert.equal(index, `${match[1]} ${match[2]} 0\t${relative}`, 'registration source index differs from HEAD');
    assert.ok(bytes.equals(git(['cat-file', 'blob', match[2]])), 'registration source bytes differ from HEAD');
    return bytes;
}

/** Reproduce one reviewed semantic roster in the unchanged execution-index format. */
export function preparePublicShellFiniteInputRegistration(repositoryRoot = root)
{
    const authority = resolveGitRepositoryAuthority(repositoryRoot);
    const sourceCommit = resolveSourceCommit(repositoryRoot, authority);
    const source = readCommittedSource(repositoryRoot, authority, sourceCommit, ownerPath);
    assert.equal(digest(source), reviewedSourceDigest, 'finite source changed; a new independent review is required');
    const ast = parse(source.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    const imports = [];
    function visit(node)
    {
        if (!node || typeof node !== 'object')
        {
            return;
        }
        if (node.type === 'ImportExpression')
        {
            imports.push(node);
        }
        for (const value of Object.values(node))
        {
            if (Array.isArray(value))
            {
                value.forEach(visit);
            }
            else if (value && typeof value === 'object')
            {
                visit(value);
            }
        }
    }
    visit(ast);
    assert.equal(imports.length, 1, 'finite source must have one private native import sink');
    const expression = source.toString('utf8').slice(imports[0].start, imports[0].end);
    assert.equal(expression, 'import(moduleUrls.get(identity))', 'finite native sink changed');
    assert.equal(reviewedDependencies.length, 131, 'finite dependency roster must retain the reviewed closure');
    for (const dependency of reviewedDependencies)
    {
        readCommittedSource(repositoryRoot, authority, sourceCommit, dependency);
    }
    const entry = { owner: ownerPath, sourceDigest: digest(source), expressionDigest: digest(expression),
        kind: 'runtime-module-path', dependencies: [...reviewedDependencies] };
    const index = JSON.parse(fs.readFileSync(path.join(repositoryRoot, indexPath), 'utf8'));
    const existing = index.runtimeDynamicImports.filter(item => item.owner === ownerPath);
    assert.ok(existing.length <= 1, 'finite native sink registration is duplicated');
    if (existing.length)
    {
        assert.deepEqual(existing[0], entry, 'existing finite registration differs from the reviewed roster');
    }
    const original = { ...index, runtimeDynamicImports: index.runtimeDynamicImports.filter(item => item.owner !== ownerPath) };
    assert.equal(original.runtimeDynamicImports.length, 47, 'original dynamic import entries must be retained');
    assert.equal(original.runtimeDynamicShellSources.length, 2, 'original dynamic shell entries must be retained');
    assert.equal(digest(JSON.stringify(original)), originalIndexDigest, 'original execution index authority changed');
    if (!existing.length)
    {
        index.runtimeDynamicImports.push(entry);
    }
    assert.equal(resolveSourceCommit(repositoryRoot, authority), sourceCommit, 'registration source replay identity changed');
    return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    assert.ok(process.argv.length === 3 && ['--check', '--write', '--bind'].includes(process.argv[2]),
        'usage: node tools/test-matrix/register-public-shell-finite-input.mjs --check|--write|--bind');
    const registered = `${JSON.stringify(preparePublicShellFiniteInputRegistration(), null, 4)}\n`;
    const destination = path.join(root, indexPath);
    if (process.argv[2] === '--write')
    {
        fs.writeFileSync(destination, registered);
        console.log('[public-shell-finite-input-registration] wrote reviewed exact execution-index entry');
    }
    else
    {
        assert.equal(fs.readFileSync(destination, 'utf8'), registered, 'finite input registration is absent or stale');
        if (process.argv[2] === '--bind')
        {
            const authorityBytes = fs.readFileSync(path.join(root, authorityPath));
            const authority = JSON.parse(authorityBytes);
            assert.equal(authority.schema, 'fsusblog.release-final-execution-target-authority.v2', 'canonical authority schema');
            assert.equal(authority.producer, 'node tools/test-matrix/generate-release-final-execution-authority.mjs', 'canonical authority producer');
            assert.equal(authority.sourceIndexDigest, digest(registered), 'canonical authority does not bind the current index');
            const binding = {
                schema: 'fsusblog.generated-output-binding.v1',
                sources: [ownerPath, 'tools/test-matrix/register-public-shell-finite-input.mjs'],
                outputs: [
                    { path: indexPath, sha256: digest(registered).slice(7) },
                    { path: authorityPath, sha256: digest(authorityBytes).slice(7) }
                ]
            };
            fs.writeFileSync(path.join(root, bindingPath), `${JSON.stringify(binding, null, 4)}\n`);
            console.log('[public-shell-finite-input-registration] bound actual index and canonical authority output bytes');
        }
        console.log('[public-shell-finite-input-registration] ok');
    }
}
