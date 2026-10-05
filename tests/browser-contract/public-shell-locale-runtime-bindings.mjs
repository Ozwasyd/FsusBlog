import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Consume the immutable build admission owner without repairing its seal.
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the canonical AEDS v2 envelope reader, not another framing implementation.
import { decodeAedsFrame, decodeApiErrorFrame } from '../frontend/support/aeds-envelope.mjs';

import { validatePublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Resolve all first-response routes with the existing production route functions and owned IDs. */
export async function resolvePublicShellLocalePublishedRoute({ root, scene, fixture })
{
    assert.ok(scene.issue === 2083 && scene.stage === 'first-response', 'first-response route required');
    const refs = [];
    async function module(file, replacements = {})
    {
        const bytes = await readFile(path.join(root, file));
        refs.push({ path: file, digest: sha256(bytes) });
        let source = stripTypeScriptTypes(bytes.toString('utf8'));
        for (const [specifier, url] of Object.entries(replacements))
        {
            source = source.replaceAll(`'${specifier}'`, `'${url}'`);
        }
        const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
        return url;
    }
    const generated = '@/public-renderers/generated/publicPageManifest';
    const fixed = '@/public-renderers/publicFixedPageSemantics';
    const paths = '@/public-renderers/publicRoutePaths';
    const registry = '@/public-renderers/publicRouteRegistry';
    const filters = '@/public-renderers/publicFilterSemantics';
    const titles = '@/router/routeTitleContract';
    const manifestUrl = await module('src/frontend/src/public-renderers/generated/publicPageManifest.ts');
    const fixedUrl = await module('src/frontend/src/public-renderers/publicFixedPageSemantics.ts', { [generated]: manifestUrl });
    const pathsUrl = await module('src/frontend/src/public-renderers/publicRoutePaths.ts', {
        [generated]: manifestUrl, [fixed]: fixedUrl
    });
    const titleUrl = await module('src/frontend/src/router/routeTitleContract.ts');
    const registryUrl = await module('src/frontend/src/public-renderers/publicRouteRegistry.ts', {
        [generated]: manifestUrl, [paths]: pathsUrl, [titles]: titleUrl
    });
    const filterUrl = await module('src/frontend/src/public-renderers/publicFilterSemantics.ts');
    const routeUrl = await module('src/frontend/src/public-renderers/publicRouteIdentity.ts', {
        [generated]: manifestUrl, [fixed]: fixedUrl, [registry]: registryUrl, [filters]: filterUrl
    });
    const routes = await import(routeUrl);
    const fixedOwner = await import(fixedUrl);
    const manifest = await import(manifestUrl);
    const descriptor = manifest.PUBLIC_PAGE_MANIFEST[scene.route];
    assert.ok(descriptor?.seoEligible && descriptor.aotShellReady, 'published route is not production SEO/AOT eligible');
    let selectedPath;
    let routeKey;
    const ownedId = (value) => typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
        && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647;
    if (scene.route === 'ArticleDetail')
    {
        assert.ok(ownedId(fixture.publicArticle.id), 'owned article identity required');
        selectedPath = routes.buildPublicArticleHref(fixture.publicArticle.id);
        routeKey = routes.buildPublicArticleRouteKey(fixture.publicArticle.id);
        assert.equal(new URL(fixture.publicArticle.url, fixture.baseUrl).href, new URL(selectedPath, fixture.baseUrl).href,
            'owned article route differs from production route');
    }
    else if (scene.route === 'Filter')
    {
        assert.ok(ownedId(fixture.category.id), 'owned category identity required');
        selectedPath = routes.buildPublicCategoryHref(fixture.category.id);
        routeKey = routes.buildPublicFilterRouteKey({ filterType: 'category', filterId: fixture.category.id });
    }
    else
    {
        assert.ok(Object.values(fixedOwner.PUBLIC_FIXED_PAGE_KIND).includes(scene.route), 'unsupported fixed route');
        selectedPath = fixedOwner.buildPublicFixedPath(scene.route);
        routeKey = fixedOwner.buildPublicFixedRouteKey(scene.route);
    }
    const url = new URL(selectedPath, fixture.baseUrl);
    assert.ok(url.origin === new URL(fixture.baseUrl).origin && !url.search && !url.hash,
        'published route crosses the owned runtime');
    return Object.freeze({ path: selectedPath, routeKey, refs });
}

/** Pure production schema authority plus a parser for sealed emitted modules. No runtime hooks. */
export async function loadPublicShellLocaleDomainBindings(root)
{
    const file = 'src/frontend/src/locales/localeDomainBundleStore.ts';
    const bytes = await readFile(path.join(root, file));
    const require = createRequire(path.join(root, 'src/frontend/package.json'));
    const ts = require('typescript');
    const ast = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true);
    const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
        && ['leafKind', 'localeDomainSchemaDigest'].includes(node.name?.text));
    assert.equal(functions.length, 2, 'production schema functions missing/ambiguous');
    const names = ast.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
        .filter((node) => node.name.getText(ast) === 'EXPORT_NAMES');
    assert.equal(names.length, 1, 'production domain export map missing/ambiguous');
    const schemas = ast.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
        .filter((node) => node.name.getText(ast) === 'LOCALE_DOMAIN_SCHEMA_DIGESTS');
    assert.equal(schemas.length, 1, 'production schema digest map missing/ambiguous');
    const code = stripTypeScriptTypes(`${functions.map((node) => node.getText(ast)).join('\n')}\nexport const exportNames = ${names[0].initializer.getText(ast)};
export const schemaDigests = ${schemas[0].initializer.getText(ast)};`);
    const production = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    const { parse } = require('acorn');
    return Object.freeze({ schemaDigest: production.localeDomainSchemaDigest, exportNames: production.exportNames,
        schemaDigests: production.schemaDigests,
        parse: (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' }),
        refs: [{ path: file, digest: sha256(bytes) }] });
}

/** Mutate the admitted module, not a hand-written replacement or a product-state hook.
 * invalid-content is explicitly a syntax error; invalid-schema removes one actual own key;
 * invalid-digest changes one actual translated string while preserving the production schema.
 */
export async function mutatePublicShellLocaleDomainResource({ body, identity, mode, domains })
{
    assert.ok(domains?.parse && domains.schemaDigest && domains.exportNames, 'production domain bindings required');
    assert.ok(['invalid-content', 'invalid-schema', 'invalid-digest'].includes(mode), 'unknown domain mutation');
    const source = Buffer.from(body).toString('utf8');
    assert.ok(Buffer.from(source).equals(Buffer.from(body)), 'sealed JS is not canonical UTF-8');
    const ast = domains.parse(source);
    assert.equal(ast.body.filter((node) => node.type === 'ImportDeclaration'
        || (node.type.startsWith('Export') && node.source)).length, 0, 'mutation requires a standalone sealed module');
    const hasDynamicImport = (node) => node && typeof node === 'object' && (node.type === 'ImportExpression'
        || Object.values(node).some((value) => Array.isArray(value) ? value.some(hasDynamicImport) : hasDynamicImport(value)));
    assert.equal(hasDynamicImport(ast), false, 'mutation must not introduce/execute dependency requests');
    const exportName = domains.exportNames[identity.domain];
    assert.ok(exportName, 'production export map has no domain');
    const exports = ast.body.filter((node) => node.type === 'ExportNamedDeclaration');
    const names = exports.flatMap((node) => node.declaration?.declarations?.map((item) => item.id.name)
        ?? node.specifiers.map((item) => item.exported.name));
    assert.deepEqual([...names].sort(), [exportName, 'localeDomainIdentity'].sort(), 'sealed domain export set');
    const original = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.deepEqual(original.localeDomainIdentity, { locale: identity.locale, domain: identity.domain }, 'sealed module identity');
    const schemaDigest = domains.schemaDigest(original[exportName]);
    assert.equal(schemaDigest, identity.schemaDigest, 'sealed module schema differs from production loader');
    const edits = [];
    let suffix;
    if (mode === 'invalid-content')
    {
        suffix = '\n/* fsusblog: invalid-content syntax boundary */\nconst = ;\n';
    }
    else
    {
        const reference = exports.flatMap((node) => node.specifiers ?? [])
            .filter((item) => item.exported.name === exportName);
        let local;
        if (reference.length)
        {
            assert.equal(reference.length, 1, 'ambiguous exported artifact binding');
            local = reference[0].local.name;
            edits.push({ start: reference[0].start, end: reference[0].end, text: `__fsusFaultArtifact as ${exportName}` });
        }
        else
        {
            const declarations = exports.filter((node) => node.declaration?.declarations?.some((item) => item.id.name === exportName));
            assert.equal(declarations.length, 1, 'artifact has no mutable export binding');
            const node = declarations[0];
            local = exportName;
            edits.push({ start: node.start, end: node.declaration.start, text: '' });
            const other = node.declaration.declarations.map((item) => item.id.name).filter((name) => name !== exportName);
            edits.push({ start: source.length, end: source.length,
                text: `\nexport { __fsusFaultArtifact as ${exportName}${other.map((name) => `, ${name}`).join('')} };\n` });
        }
        assert.ok(!source.includes('__fsusFaultArtifact'), 'mutation binding collides with sealed module');
        if (mode === 'invalid-schema')
        {
            assert.ok(Object.keys(original[exportName]).length > 0, 'domain has no removable own key');
            suffix = `\nconst __fsusFaultArtifact = Object.fromEntries(Object.entries(${local}).slice(1));\n`;
        }
        else
        {
            suffix = `\nlet __fsusFaultChanged = false;
const __fsusFaultTransform = value => {
  if (typeof value === 'string' && !__fsusFaultChanged) { __fsusFaultChanged = true; return value + ' [fsus-content-mutation]'; }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(__fsusFaultTransform);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'kind' && item === 'plural' ? item : __fsusFaultTransform(item)]));
};
const __fsusFaultArtifact = __fsusFaultTransform(${local});
if (!__fsusFaultChanged) throw new Error('domain has no translated string');\n`;
        }
    }
    let changed = source;
    for (const edit of [...edits].sort((left, right) => right.start - left.start))
    {
        changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
    }
    changed += suffix;
    let mutatedSchemaDigest = null;
    if (mode !== 'invalid-content')
    {
        const mutated = await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
        assert.deepEqual(mutated.localeDomainIdentity, original.localeDomainIdentity, 'mutation changed artifact identity');
        mutatedSchemaDigest = domains.schemaDigest(mutated[exportName]);
        if (mode === 'invalid-schema')
        {
            assert.notEqual(mutatedSchemaDigest, schemaDigest, 'schema mutation did not change schema');
        }
        else
        {
            assert.equal(mutatedSchemaDigest, schemaDigest, 'digest mutation changed schema instead of content');
        }
    }
    return { body: new Uint8Array(Buffer.from(changed)), mutation: { mode, recipe: 'sealed-module-ast',
        targetDigest: sha256(body), originalLength: body.length, edits, suffix, schemaDigest, mutatedSchemaDigest } };
}

/** Load pure production codec modules only; no browser runtime, locale state or storage hooks. */
export async function loadPublicShellLocalePreferenceBindings(root)
{
    const refs = [];
    async function source(relative)
    {
        const bytes = await readFile(path.join(root, relative));
        refs.push({ path: relative, digest: sha256(bytes) });
        return bytes.toString('utf8');
    }
    async function module(relative, replacements = {})
    {
        let code = stripTypeScriptTypes(await source(relative));
        for (const [specifier, replacement] of Object.entries(replacements))
        {
            code = code.replaceAll(`'${specifier}'`, `'${replacement}'`);
        }
        return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    }
    const errors = await module('src/frontend/src/utils/appError.ts');
    const reader = await module('src/frontend/src/codecs/binary/reader.ts', { '@/utils/appError': errors });
    const types = await module('src/frontend/src/adapters/binary/types.ts');
    const mapper = await import(await module('src/frontend/src/adapters/binary/localePreferenceAdapter.ts', {
        '@/codecs/binary/reader': reader, '@/utils/appError': errors, './types': types
    }));
    const frame = await module('src/frontend/wasm/web/protocol/frame.ts');
    const encoder = await import(await module('src/frontend/src/api/binaryFrame.ts', { '@wasm/protocol/frame': frame }));
    const contracts = await import(await module('src/frontend/src/api/contracts.ts'));
    const protocol = JSON.parse(await source('src/shared/Contracts/Validation/aeds-protocol.json'));
    const endpoint = JSON.parse(await source('src/shared/Contracts/Validation/aeds-endpoint-contracts.json'));
    const catalog = JSON.parse(await source('src/shared/Contracts/Localization/locale-catalog.json'));
    const locales = catalog.locales.filter((item) => item.status === 'enabled');
    async function conflictEnum(relative)
    {
        const matches = [...(await source(relative)).matchAll(/\bConflict\s*=\s*(\d+)\b/gu)];
        assert.equal(matches.length, 1, 'one production conflict enum value required');
        return Number(matches[0][1]);
    }
    const conflictCode = await conflictEnum('src/core/Common/ErrorCode.cs');
    const conflictCategory = await conflictEnum('src/core/Common/ErrorCategory.cs');
    const operations = ['binary_get_locale_preference', 'binary_put_locale_preference'].map((id) =>
    {
        const matches = endpoint.operations.filter((item) => item.operationId === id);
        assert.equal(matches.length, 1, 'preference operation must have exactly one owner');
        return matches[0];
    });
    const frameType = (name) =>
    {
        const matches = protocol.frameTypes.filter((item) => item.name === name);
        assert.equal(matches.length, 1, 'preference frame must have exactly one owner');
        return matches[0].value;
    };
    function readFrame(bytes, expected)
    {
        const frame = decodeAedsFrame(bytes);
        assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true), 0, 'inactive AEDS flags');
        assert.equal(frame.frameType, frameType(expected), 'preference AEDS frame type');
        return frame.payload;
    }
    return Object.freeze({
        refs, operations, apiOperations: endpoint.operations, locales, mediaType: contracts.AEDS_BINARY_MEDIA_TYPE,
        encodeRequest: (mode, locale, revision) => new Uint8Array(encoder.encodeAedsFrame(
            frameType('UserLocalePreferenceUpdateRequest'), encoder.encodeUserLocalePreferenceUpdateRequest(mode, locale, revision)
        )),
        decodeResponse(bytes)
        {
            const result = mapper.mapUserLocalePreferenceFromPayload(readFrame(bytes, 'UserLocalePreference'));
            assert.ok(Number.isSafeInteger(result.revision) && result.revision >= 0, 'unsafe preference revision');
            return result;
        },
        decodeError(bytes)
        {
            const payload = readFrame(bytes, 'ApiError');
            assert.equal(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(2, true), 0,
                'ApiError POD reserved bytes');
            const error = decodeApiErrorFrame(bytes);
            return { code: error.code, category: error.category, statusCode: error.statusCode,
                kind: error.code === conflictCode && error.category === conflictCategory && error.statusCode === 409
                    && error.message === 'locale_preference_revision_conflict' ? 'revision-conflict' : 'other',
                messageDigest: sha256(error.message), detailsDigest: sha256(error.details), traceDigest: sha256(error.traceId) };
        },
        inspectRequest(bytes)
        {
            const payload = readFrame(bytes, 'UserLocalePreferenceUpdateRequest');
            assert.ok(payload.length >= 8, 'preference revision missing');
            const revision = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigInt64(0, true));
            assert.ok(Number.isSafeInteger(revision) && revision >= 0, 'unsafe expected preference revision');
            const candidates = [{ mode: 'auto', fixedLocale: null }, ...locales.map((item) => ({ mode: 'fixed', fixedLocale: item.code }))];
            const matches = candidates.filter((item) => Buffer.from(payload).equals(Buffer.from(
                encoder.encodeUserLocalePreferenceUpdateRequest(item.mode, item.fixedLocale, revision)
            )));
            assert.equal(matches.length, 1, 'request must exactly match the production preference encoder');
            return { ...matches[0], expectedRevision: revision };
        }
    });
}

/** Cross-version means a different, independently admitted build's same locale/domain module.
 * No old worktree/default file is selected implicitly. The runner must supply immutable owner identity.
 */
export async function readPublicShellLocaleForeignBuildResource({ foreignBuild, currentIdentity, locale, domain })
{
    assert.ok(foreignBuild?.receiptFile && foreignBuild.sourceState && foreignBuild.receiptDigest,
        'explicit immutable foreign build identity required');
    const artifactRoot = path.dirname(foreignBuild.receiptFile);
    const { receipt } = verifyProductionBuildReceipt({ artifactRoot, receiptFile: path.basename(foreignBuild.receiptFile),
        expectedSourceState: foreignBuild.sourceState, expectedReceiptDigest: foreignBuild.receiptDigest, repairReadOnlySeal: false });
    assert.ok(receipt.sourceState.commit !== currentIdentity.sourceState.commit
        || receipt.sourceState.worktreeFingerprint !== currentIdentity.sourceState.worktreeFingerprint, 'cross-version needs a different source build');
    const frontend = receipt.domains.filter((item) => item.name === 'frontend-dist');
    assert.equal(frontend.length, 1, 'foreign build frontend-dist owner required');
    const manifestPath = `${frontend[0].path}/.vite/manifest.json`;
    const manifestArtifact = receipt.artifacts.find((item) => item.path === manifestPath);
    assert.ok(manifestArtifact, 'foreign manifest is not receipted');
    const manifestBytes = await readFile(path.join(artifactRoot, manifestPath));
    assert.equal(sha256(manifestBytes), manifestArtifact.sha256, 'foreign manifest changed');
    const manifest = JSON.parse(manifestBytes);
    const name = `locale-${locale}-${domain}`;
    const entries = Object.values(manifest).filter((entry) => entry.name === name);
    assert.equal(entries.length, 1, 'foreign build same locale/domain module required');
    assert.equal((entries[0].imports ?? []).length + (entries[0].dynamicImports ?? []).length
        + (entries[0].css ?? []).length + (entries[0].assets ?? []).length, 0,
    'cross-version requires a standalone module; foreign dependency failure must not impersonate version rejection');
    const file = safeRelative(entries[0].file);
    const artifact = receipt.artifacts.find((item) => item.path === `${frontend[0].path}/${file}`);
    assert.ok(artifact, 'foreign resource is not receipted');
    const body = await readFile(path.join(artifactRoot, artifact.path));
    assert.equal(sha256(body), artifact.sha256, 'foreign resource changed');
    return { body, proof: { kind: 'foreign-build', receiptFile: foreignBuild.receiptFile, sourceState: receipt.sourceState, buildDigest: receipt.contentDigest,
        manifestDigest: manifestArtifact.sha256, file, digest: artifact.sha256, locale, domain } };
}

function safeRelative(relative)
{
    assert.equal(typeof relative, 'string', 'artifact relative path required');
    assert.ok(relative && !path.isAbsolute(relative) && !relative.includes('\\')
        && relative.split('/').every((part) => part && part !== '.' && part !== '..'), 'artifact path escapes its owner');
    return relative;
}

/** Resolve expectations from a verified build, never from observed request names or counts. */
export async function admitPublicShellLocaleRuntimeBindings({ root, matrix, harness, buildReceiptFile })
{
    await validatePublicShellLocaleMatrix(matrix, root);
    assert.equal(harness.identity.matrixDigest, matrix.contentDigest, 'runtime binding matrix mismatch');
    const artifactRoot = path.dirname(buildReceiptFile);
    const { receipt } = verifyProductionBuildReceipt({
        artifactRoot, receiptFile: path.basename(buildReceiptFile), expectedSourceState: harness.identity.sourceState,
        expectedReceiptDigest: harness.identity.buildDigest, repairReadOnlySeal: false
    });
    const frontend = receipt.domains.filter((item) => item.name === 'frontend-dist');
    assert.equal(frontend.length, 1, 'one immutable frontend-dist domain required');
    const frontendRoot = frontend[0].path;
    const manifestPath = `${frontendRoot}/.vite/manifest.json`;
    assert.equal(receipt.artifacts.filter((item) => item.path === manifestPath).length, 1, 'receipted Vite manifest required');
    const manifest = JSON.parse(await readFile(path.join(artifactRoot, manifestPath), 'utf8'));
    const artifacts = new Map(receipt.artifacts.map((item) => [item.path, item]));
    const baseUrl = harness.fixture.baseUrl;
    const resources = new Map();
    async function resource(relative, identity)
    {
        safeRelative(relative);
        const artifact = artifacts.get(`${frontendRoot}/${relative}`);
        assert.ok(artifact, 'manifest references an unreceipted resource');
        const url = new URL(relative, `${baseUrl}/`).href;
        const existing = resources.get(url);
        if (existing)
        {
            existing.identities.push(identity);
            return existing;
        }
        const record = { url, file: relative, digest: artifact.sha256, identities: [identity] };
        resources.set(url, record);
        return record;
    }
    const entries = Object.entries(manifest);
    const domains = await loadPublicShellLocaleDomainBindings(root);
    const domainSource = await readFile(path.join(root, 'src/frontend/src/locales/localeDomains.ts'), 'utf8');
    const { LOCALE_DOMAINS } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(domainSource)).toString('base64')}`);
    for (const locale of matrix.locales)
    {
        for (const domain of LOCALE_DOMAINS)
        {
            const name = `locale-${locale.code}-${domain}`;
            const matches = entries.filter(([key, entry]) => entry.name === name
                || key.endsWith(`src/locales/${locale.code}/${domain}.ts`));
            assert.equal(matches.length, 1, 'locale/domain manifest entry missing or ambiguous');
            assert.equal(matches[0][1].name, name, 'locale/domain manifest ownership mismatch');
            await resource(matches[0][1].file, { kind: 'domain', locale: locale.code, domain,
                exportName: domains.exportNames[domain], schemaDigest: domains.schemaDigests[domain] });
        }
    }
    const postcss = createRequire(path.join(root, 'src/frontend/package.json'))('postcss');
    for (const font of matrix.fontPlan.entries)
    {
        const matches = entries.filter(([key, entry]) => entry.name === font.assetEntry
            || key.endsWith(`src/assets/fonts/${font.assetFile}`));
        assert.equal(matches.length, 1, 'font manifest owner missing or ambiguous');
        const entry = matches[0][1];
        const files = [...new Set([entry.file, ...(entry.css ?? [])])];
        assert.ok(files.some((file) => file.endsWith('.css')), 'font stylesheet missing');
        for (const file of files)
        {
            const stylesheet = await resource(file, { kind: 'font-style', locale: font.locale, script: font.script });
            if (!file.endsWith('.css'))
            {
                continue;
            }
            const css = await readFile(path.join(artifactRoot, frontendRoot, file), 'utf8');
            let faceCount = 0;
            const faces = [];
            postcss.parse(css).walkAtRules('font-face', (rule) =>
            {
                const declarations = Object.fromEntries(rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
                const family = declarations['font-family']?.replace(/^['"]|['"]$/gu, '');
                assert.equal(family, font.family, 'font CSS family differs from catalog');
                const weight = Number(declarations['font-weight']);
                assert.ok(font.weights.includes(weight), 'font CSS weight differs from catalog');
                const urls = [...(declarations.src ?? '').matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gu)];
                assert.ok(urls.length > 0, 'font CSS URL identity missing');
                for (const match of urls)
                {
                    const resolved = new URL(match[2], stylesheet.url);
                    assert.equal(resolved.origin, new URL(baseUrl).origin, 'font URL outside prepared runtime');
                    const relative = decodeURIComponent(resolved.pathname).replace(/^\//u, '');
                    faces.push({ relative, weight, unicodeRange: declarations['unicode-range'] ?? null });
                }
                faceCount += 1;
            });
            assert.ok(faceCount > 0, 'font stylesheet has no observable faces');
            for (const face of faces)
            {
                await resource(face.relative, { kind: 'font', locale: font.locale, script: font.script,
                    family: font.family, weight: face.weight, unicodeRange: face.unicodeRange });
            }
        }
    }
    // Unrelated locale domains remain identifiable; they cannot become neutral runtime assets.
    for (const [key, entry] of entries)
    {
        for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])])
        {
            if (!resources.has(new URL(file, `${baseUrl}/`).href))
            {
                await resource(file, { kind: 'static', entry: entry.name ?? key });
            }
        }
    }
    for (const artifact of receipt.artifacts)
    {
        if (artifact.path.startsWith(`${frontendRoot}/`) && !artifact.path.startsWith(`${frontendRoot}/.vite/`))
        {
            const relative = artifact.path.slice(frontendRoot.length + 1);
            if (!resources.has(new URL(relative, `${baseUrl}/`).href))
            {
                await resource(relative, { kind: 'static', entry: 'frontend-dist' });
            }
        }
    }
    const preference = await loadPublicShellLocalePreferenceBindings(root);
    return Object.freeze({
        identity: harness.identity, locales: matrix.locales, manifestDigest: artifacts.get(manifestPath).sha256,
        resources: [...resources.values()], preference, domains,
        preferenceUrl: new URL(preference.operations[0].path, baseUrl).href,
        async readResource(url)
        {
            const record = resources.get(url);
            assert.ok(record, 'unregistered immutable resource');
            const bytes = await readFile(path.join(artifactRoot, frontendRoot, record.file));
            assert.equal(sha256(bytes), record.digest, 'resource changed after admission');
            return bytes;
        }
    });
}
