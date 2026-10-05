import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the canonical source-root and replay identity authority.
import { resolveGitRepositoryAuthority, resolveSourceCommit, runGitRepository } from '../../tools/fact-extractors/identity.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
// Parser dependencies belong to this checkout's lock, never to a supplied source root.
const require = createRequire(new URL('../../src/frontend/package.json', import.meta.url));
const { parse } = require('acorn');
const ts = require('typescript');
const admittedDomainBindings = new WeakMap();
const moduleUrls = new Map();
const preparedSources = new Map();
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function moduleDescriptor(file, imports = {}, deferred = [])
{
    return Object.freeze({ file, imports: Object.freeze({ ...imports }), deferred: Object.freeze([...deferred]) });
}

/** Closed production projection graph. This is source ownership, not execution qualification. */
export const publicShellFiniteModuleGraph = Object.freeze({
    localeCatalog: moduleDescriptor('src/frontend/src/locales/localeCatalog.ts'),
    routeDomains: moduleDescriptor('src/frontend/src/locales/routeLocaleDomains.ts'),
    fonts: moduleDescriptor('src/frontend/src/locales/localeFontCatalog.ts'),
    selector: moduleDescriptor('src/frontend/src/components/i18n/projectLocaleSelectorItems.ts', { '@/locales': 'localeCatalog' }),
    localeDomains: moduleDescriptor('src/frontend/src/locales/localeDomains.ts'),
    pageManifest: moduleDescriptor('src/frontend/src/public-renderers/generated/publicPageManifest.ts'),
    fixedPages: moduleDescriptor('src/frontend/src/public-renderers/publicFixedPageSemantics.ts', { '@/public-renderers/generated/publicPageManifest': 'pageManifest' }),
    routePaths: moduleDescriptor('src/frontend/src/public-renderers/publicRoutePaths.ts', { '@/public-renderers/generated/publicPageManifest': 'pageManifest', '@/public-renderers/publicFixedPageSemantics': 'fixedPages' }),
    routeTitle: moduleDescriptor('src/frontend/src/router/routeTitleContract.ts'),
    routeRegistry: moduleDescriptor('src/frontend/src/public-renderers/publicRouteRegistry.ts', { '@/public-renderers/generated/publicPageManifest': 'pageManifest', '@/public-renderers/publicRoutePaths': 'routePaths', '@/router/routeTitleContract': 'routeTitle' }, ['@/views/Home.vue', '@/views/ArticleDetail.vue', '@/views/Archive.vue', '@/views/PublicDynamicPage.vue', '@/views/FilterView.vue']),
    filterSemantics: moduleDescriptor('src/frontend/src/public-renderers/publicFilterSemantics.ts'),
    routeIdentity: moduleDescriptor('src/frontend/src/public-renderers/publicRouteIdentity.ts', { '@/public-renderers/generated/publicPageManifest': 'pageManifest', '@/public-renderers/publicFixedPageSemantics': 'fixedPages', '@/public-renderers/publicRouteRegistry': 'routeRegistry', '@/public-renderers/publicFilterSemantics': 'filterSemantics' }),
    appError: moduleDescriptor('src/frontend/src/utils/appError.ts'),
    binaryReader: moduleDescriptor('src/frontend/src/codecs/binary/reader.ts', { '@/utils/appError': 'appError' }),
    adapterTypes: moduleDescriptor('src/frontend/src/adapters/binary/types.ts'),
    localePreference: moduleDescriptor('src/frontend/src/adapters/binary/localePreferenceAdapter.ts', { '@/codecs/binary/reader': 'binaryReader', '@/utils/appError': 'appError', './types': 'adapterTypes' }),
    frame: moduleDescriptor('src/frontend/wasm/web/protocol/frame.ts'),
    binaryEncoder: moduleDescriptor('src/frontend/src/api/binaryFrame.ts', { '@wasm/protocol/frame': 'frame' }),
    apiContracts: moduleDescriptor('src/frontend/src/api/contracts.ts'),
    publicAotPayload: moduleDescriptor('src/frontend/src/bootstrap/publicAotBinaryPayload.ts', { '@wasm/protocol/frame': 'frame' }),
    releaseId: moduleDescriptor('src/frontend/src/generated/releaseIdContract.ts'),
    trustedTypes: moduleDescriptor('src/frontend/src/security/trustedTypesRuntime.ts', { '@/generated/releaseIdContract': 'releaseId' }),
    seoHead: moduleDescriptor('src/frontend/src/router/publicSeoHead.ts', { '@/security/trustedTypesRuntime': 'trustedTypes' }),
    localeSchema: moduleDescriptor('src/frontend/src/locales/localeDomainBundleStore.ts')
});

function parseModule(source)
{
    return parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
}

function walk(node, callback)
{
    if (!node || typeof node !== 'object')
    {
        return;
    }
    callback(node);
    for (const [key, value] of Object.entries(node))
    {
        if (['start', 'end', 'loc'].includes(key))
        {
            continue;
        }
        if (Array.isArray(value))
        {
            for (const child of value)
            {
                walk(child, callback);
            }
        }
        else if (value && typeof value === 'object')
        {
            walk(value, callback);
        }
    }
}

function assertProjectionRequests(source, descriptor)
{
    const seen = new Set();
    const requests = [];
    walk(parseModule(source), node =>
    {
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
        {
            assert.ok(Object.hasOwn(descriptor.imports, node.source.value), 'unowned production import specifier');
            seen.add(node.source.value);
            requests.push(node.source);
        }
        if (node.type === 'ImportExpression')
        {
            assert.ok(node.source.type === 'Literal' && descriptor.deferred.includes(node.source.value),
                'unowned deferred production import');
        }
    });
    assert.deepEqual([...seen].sort(), Object.keys(descriptor.imports).sort(), 'production replacement graph drift');
    return requests;
}

function sameFile(left, right)
{
    return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);
}

async function readOwnedSource(root, relative)
{
    assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'),
        'owned source path is not canonical');
    let cursor = root;
    for (const part of relative.split('/'))
    {
        cursor = path.join(cursor, part);
        const entry = await lstat(cursor);
        assert.ok(!entry.isSymbolicLink(), 'owned source path contains a symlink');
    }
    const before = await lstat(cursor);
    assert.ok(before.isFile() && before.nlink === 1, 'owned source must be a regular single-link file');
    const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try
    {
        const opened = await handle.stat();
        assert.ok(sameFile(before, opened), 'owned source changed before descriptor admission');
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const named = await lstat(cursor);
        assert.ok(sameFile(opened, after) && sameFile(after, named) && bytes.length === after.size,
            'owned source changed during descriptor read');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        assert.ok(!text.startsWith('\uFEFF'), 'owned source contains a UTF-8 BOM');
        return { bytes, text };
    }
    finally
    {
        await handle.close();
    }
}

function schemaProjection(source)
{
    const file = publicShellFiniteModuleGraph.localeSchema.file;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    assert.equal(ast.parseDiagnostics.length, 0, 'production domain schema source syntax');
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
        && ['leafKind', 'localeDomainSchemaDigest'].includes(node.name?.text));
    assert.equal(functions.length, 2, 'production schema functions missing/ambiguous');
    const declarations = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
    const names = declarations.filter(node => node.name.getText(ast) === 'EXPORT_NAMES');
    const schemas = declarations.filter(node => node.name.getText(ast) === 'LOCALE_DOMAIN_SCHEMA_DIGESTS');
    assert.equal(names.length, 1, 'production domain export map missing/ambiguous');
    assert.equal(schemas.length, 1, 'production schema digest map missing/ambiguous');
    return stripTypeScriptTypes(`${functions.map(node => node.getText(ast)).join('\n')}\nexport const exportNames = ${names[0].initializer.getText(ast)};
export const schemaDigests = ${schemas[0].initializer.getText(ast)};`);
}

// Only the closed source graph and this owner's validated original/fixed-recipe bytes reach this sink.
// Its existence is deliberately not admitted by an execution index in the source proposal.
async function importOwnedModule(source)
{
    const identity = sha256(source);
    if (!moduleUrls.has(identity))
    {
        moduleUrls.set(identity, `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    }
    return import(moduleUrls.get(identity));
}

function prepareSource(original, descriptor, schema = false)
{
    const identity = `${schema ? 'schema' : 'module'}:${sha256(original.bytes)}`;
    const existing = preparedSources.get(identity);
    const code = existing ?? (schema ? schemaProjection(original.text) : stripTypeScriptTypes(original.text));
    const requests = assertProjectionRequests(code, descriptor);
    if (!existing)
    {
        if (preparedSources.size >= 256)
        {
            preparedSources.delete(preparedSources.keys().next().value);
        }
        preparedSources.set(identity, code);
    }
    return { code, requests };
}

/** Execute original production modules by closed ID, with real source/ref and fresh-content identity. */
export async function createPublicShellFiniteInputOwner(root = defaultRoot)
{
    assert.ok(typeof root === 'string' && path.isAbsolute(root) && [path.resolve(root), path.resolve(root) + path.sep].includes(root), 'finite source root must be canonical');
    root = path.resolve(root);
    assert.equal(await realpath(root), root, 'finite source root cannot be a symlink alias');
    assert.equal(root, path.resolve(defaultRoot), 'finite source root must equal the executing owner checkout');
    const authority = resolveGitRepositoryAuthority(root);
    const sourceCommit = resolveSourceCommit(root, authority);
    const committed = new Map(runGitRepository(authority, ['ls-tree', '-r', '-z', sourceCommit, '--', 'src/frontend']).split('\0')
        .filter(Boolean).map(row =>
        {
            const separator = row.indexOf('\t');
            return [row.slice(separator + 1), row.slice(0, separator).split(' ')];
        }));
    const indexed = new Map(runGitRepository(authority, ['ls-files', '--stage', '-z', '--', 'src/frontend']).split('\0')
        .filter(Boolean).map(row =>
        {
            const separator = row.indexOf('\t');
            return [row.slice(separator + 1), row.slice(0, separator).split(' ')];
        }));
    const refs = new Map();
    function assertReplayRoot()
    {
        assert.equal(resolveSourceCommit(root, authority), sourceCommit, 'finite source root replay identity changed');
    }
    async function source(relative)
    {
        const entry = indexed.get(relative);
        assert.ok(entry && ['100644', '100755'].includes(entry[0]) && entry[2] === '0', 'finite source lacks a regular tracked owner');
        const head = committed.get(relative);
        assert.ok(head && head[0] === entry[0] && head[1] === 'blob' && head[2] === entry[1],
            'finite source index differs from its committed candidate blob');
        const current = runGitRepository(authority, ['ls-files', '--stage', '-z', '--', relative]).split('\0').filter(Boolean);
        assert.ok(current.length === 1 && /^(?:100644|100755) [a-f0-9]{40} 0\t/u.test(current[0])
            && current[0].slice(current[0].indexOf('\t') + 1) === relative, 'finite source current tracked owner changed');
        assert.deepEqual(current[0].slice(0, current[0].indexOf('\t')).split(' '), entry, 'finite source index identity changed');
        const read = await readOwnedSource(root, relative);
        const blob = createHash('sha1').update(`blob ${read.bytes.length}\0`).update(read.bytes).digest('hex');
        assert.equal(blob, entry[1], 'finite source bytes differ from the captured Git index');
        assert.equal(runGitRepository(authority, ['ls-files', '--stage', '-z', '--', relative]), current[0] + '\0',
            'finite source index changed during descriptor read');
        refs.set(relative, Object.freeze({ path: relative, digest: sha256(read.bytes) }));
        return read;
    }
    async function moduleCode(id, ancestry = [])
    {
        assert.ok(typeof id === 'string' && Object.hasOwn(publicShellFiniteModuleGraph, id), 'unknown finite production module ID');
        assert.ok(!ancestry.includes(id), 'finite production graph cycle');
        const descriptor = publicShellFiniteModuleGraph[id];
        const original = await source(descriptor.file);
        let { code, requests } = prepareSource(original, descriptor, id === 'localeSchema');
        const replacements = new Map();
        for (const [specifier, dependency] of Object.entries(descriptor.imports))
        {
            const child = await moduleCode(dependency, [...ancestry, id]);
            const url = `data:text/javascript;base64,${Buffer.from(child).toString('base64')}`;
            replacements.set(specifier, JSON.stringify(url));
        }
        for (const request of requests.sort((left, right) => right.start - left.start))
        {
            code = code.slice(0, request.start) + replacements.get(request.value) + code.slice(request.end);
        }
        return code;
    }
    async function load(id)
    {
        assertReplayRoot();
        const code = await moduleCode(id);
        assertReplayRoot();
        return importOwnedModule(code);
    }
    async function assertDomain(identity)
    {
        assert.ok(identity && Object.getPrototypeOf(identity) === Object.prototype, 'finite domain identity required');
        const descriptors = Object.getOwnPropertyDescriptors(identity);
        assert.ok(Object.values(descriptors).every(value => Object.hasOwn(value, 'value')), 'finite domain identity cannot contain accessors');
        assert.ok(Reflect.ownKeys(descriptors).every(key => ['kind', 'locale', 'domain', 'exportName', 'schemaDigest'].includes(key)), 'unknown finite domain identity field');
        const catalog = await load('localeCatalog');
        const domains = await load('localeDomains');
        assert.equal(catalog.ENABLED_LOCALES.length, 10, 'finite domain requires ten enabled locales');
        assert.ok(catalog.ENABLED_LOCALES.some(item => item.code === identity.locale), 'unknown finite domain locale');
        assert.ok(domains.LOCALE_DOMAINS.includes(identity.domain), 'unknown finite domain');
        assert.ok(identity.kind === undefined || identity.kind === 'domain', 'finite resource kind mismatch');
        assert.ok(identity.schemaDigest === undefined || /^fnv1a64:[0-9a-f]{16}$/u.test(identity.schemaDigest), 'finite domain schema identity');
        const schema = await load('localeSchema');
        assert.ok(identity.exportName === undefined || identity.exportName === schema.exportNames[identity.domain], 'finite domain export identity');
        assert.ok(identity.schemaDigest === undefined || identity.schemaDigest === schema.schemaDigests[identity.domain], 'finite domain production schema identity');
    }
    async function loadDomain(locale, domain)
    {
        await assertDomain({ locale, domain });
        assert.ok(/^[A-Za-z0-9-]+$/u.test(locale) && /^[a-z]+$/u.test(domain), 'finite domain path component');
        const file = `src/frontend/src/locales/${locale}/${domain}.ts`;
        const original = await source(file);
        const { code } = prepareSource(original, moduleDescriptor(file));
        assertReplayRoot();
        const value = await importOwnedModule(code);
        assert.deepEqual(value.localeDomainIdentity, { locale, domain }, 'finite domain module identity');
        return value;
    }
    async function schemaBindings()
    {
        const production = await load('localeSchema');
        Object.freeze(production.exportNames);
        Object.freeze(production.schemaDigests);
        const value = Object.freeze({ schemaDigest: production.localeDomainSchemaDigest, exportNames: production.exportNames,
            schemaDigests: production.schemaDigests, parse: parseModule, refs: Object.freeze([...refs.values()]) });
        admittedDomainBindings.set(value, { assertDomain });
        return value;
    }
    assertReplayRoot();
    return Object.freeze({ load, loadDomain, schemaBindings, sourceCommit, refs: () => Object.freeze([...refs.values()]),
        qualificationEligible: false, policyPromotion: false });
}

function assertInertSealedModule(ast)
{
    const bindings = new Set();
    function data(node)
    {
        if (node?.type === 'Literal')
        {
            assert.ok(!node.regex && !node.bigint, 'sealed resource literal kind');
            return;
        }
        if (node?.type === 'Identifier')
        {
            assert.ok(bindings.has(node.name), 'sealed resource unowned value reference');
            return;
        }
        if (node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) && node.argument.type === 'Literal' && typeof node.argument.value === 'number')
        {
            return;
        }
        if (node?.type === 'ArrayExpression')
        {
            for (const item of node.elements)
            {
                assert.ok(item, 'sealed resource sparse data');
                data(item);
            }
            return;
        }
        if (node?.type === 'ObjectExpression')
        {
            const keys = new Set();
            for (const item of node.properties)
            {
                assert.ok(item.type === 'Property' && item.kind === 'init' && !item.method && !item.computed, 'sealed resource executable property');
                const key = item.key.type === 'Identifier' ? item.key.name : item.key.value;
                assert.ok(!keys.has(key), 'sealed resource duplicate own key');
                keys.add(key);
                data(item.value);
            }
            return;
        }
        if (node?.type === 'CallExpression' && !node.optional && node.arguments.length === 1
            && node.callee.type === 'MemberExpression' && !node.callee.computed
            && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object' && node.callee.property.name === 'freeze')
        {
            data(node.arguments[0]);
            return;
        }
        assert.fail('sealed resource contains executable input outside its data owner');
    }
    for (const statement of ast.body)
    {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type === 'VariableDeclaration')
        {
            assert.equal(declaration.kind, 'const', 'sealed resource mutable input');
            for (const item of declaration.declarations)
            {
                assert.ok(item.id.type === 'Identifier' && !bindings.has(item.id.name), 'sealed resource binding identity');
                data(item.init);
                bindings.add(item.id.name);
            }
        }
        else
        {
            assert.ok(statement.type === 'ExportNamedDeclaration' && !statement.source && !statement.declaration
                && statement.specifiers.every(item => bindings.has(item.local.name)), 'sealed resource unowned statement');
        }
    }
}

export async function mutateFinitePublicShellDomainResource({ body, identity, mode, domains })
{
    const owner = admittedDomainBindings.get(domains);
    assert.ok(owner, 'production domain bindings require their finite source owner');
    await owner.assertDomain(identity);
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
    assertInertSealedModule(ast);
    const original = await importOwnedModule(source);
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
        const mutated = await importOwnedModule(changed);
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
