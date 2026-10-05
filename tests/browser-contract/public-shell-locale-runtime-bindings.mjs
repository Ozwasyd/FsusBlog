import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Consume the immutable build admission owner without repairing its seal.
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the canonical AEDS v2 envelope reader, not another framing implementation.
import { decodeAedsFrame, decodeApiErrorFrame } from '../frontend/support/aeds-envelope.mjs';

import { createPublicShellFiniteInputOwner, mutateFinitePublicShellDomainResource } from './public-shell-finite-input-owner.mjs';
import { validatePublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Resolve all first-response routes with the existing production route functions and owned IDs. */
export async function resolvePublicShellLocalePublishedRoute({ root, scene, fixture })
{
    assert.ok(scene.issue === 2083 && scene.stage === 'first-response', 'first-response route required');
    const owner = await createPublicShellFiniteInputOwner(root);
    const routes = await owner.load('routeIdentity');
    const fixedOwner = await owner.load('fixedPages');
    const manifest = await owner.load('pageManifest');
    const refs = owner.refs();
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
    const owner = await createPublicShellFiniteInputOwner(root);
    return owner.schemaBindings();
}

/** Mutate the admitted module, not a hand-written replacement or a product-state hook.
 * invalid-content is explicitly a syntax error; invalid-schema removes one actual own key;
 * invalid-digest changes one actual translated string while preserving the production schema.
 */
export async function mutatePublicShellLocaleDomainResource({ body, identity, mode, domains })
{
    return mutateFinitePublicShellDomainResource({ body, identity, mode, domains });
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
    const owner = await createPublicShellFiniteInputOwner(root);
    const mapper = await owner.load('localePreference');
    const encoder = await owner.load('binaryEncoder');
    const contracts = await owner.load('apiContracts');
    refs.push(...owner.refs());
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
    const domainOwner = await createPublicShellFiniteInputOwner(root);
    const { LOCALE_DOMAINS } = await domainOwner.load('localeDomains');
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
