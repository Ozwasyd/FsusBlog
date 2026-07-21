import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const canonicalizationVersion = 'fsusblog.article-canonical.v1';
export const assertionLabel = 'org.fsusblog.article.v1';
export const interopPolicyVersion = 'fsusblog.c2pa-interop.v1';

const forbiddenPrivateKey = /(?:^|_)(?:author_?email|email|ip|ip_?address|device|device_?id|user_?id|prompt|private_?draft|model_?log|repository_?url)(?:$|_)/iu;
const emailValue = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const ipv4Value = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;

export function sha256Hex(value)
{
    return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value, { trailingNewline = true } = {})
{
    const normalized = normalizeJsonValue(value);
    const serialized = JSON.stringify(normalized, null, 2);
    return trailingNewline ? `${serialized}\n` : serialized;
}

export function canonicalizeMarkdown(markdown)
{
    return canonicalizeText(markdown);
}

export function canonicalizeRenderedHtml(html)
{
    let normalized = canonicalizeText(html);
    normalized = normalized
        .replace(/\snonce=(?:"[^"]*"|'[^']*')/giu, '')
        .replace(/\sdata-csp-nonce=(?:"[^"]*"|'[^']*')/giu, '')
        .replace(/<([a-z][a-z0-9-]*)\b[^>]*\bdata-c2pa-volatile(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
        .replace(/<([a-z][a-z0-9-]*)\b[^>]*\bdata-c2pa-volatile(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*\/?>/giu, '')
        .replace(/>\s+</gu, '><');
    return canonicalizeText(normalized);
}

export function buildArticleCanonicalPackage(fixture, { fixtureDirectory = process.cwd() } = {})
{
    validateFixture(fixture);
    const markdown = canonicalizeMarkdown(fixture.markdown);
    const html = canonicalizeRenderedHtml(fixture.renderedHtml);
    const metadata = canonicalMetadata(fixture);
    const metadataJson = stableJson(metadata);
    const ingredients = fixture.ingredients.map(ingredient => canonicalIngredient(ingredient, fixtureDirectory));

    const digests = {
        markdownSha256: sha256Hex(markdown),
        renderedHtmlSha256: sha256Hex(html),
        metadataSha256: sha256Hex(metadataJson)
    };
    const assertion = {
        schema: assertionLabel,
        canonicalization: canonicalizationVersion,
        article: {
            articleId: metadata.articleId,
            revisionId: metadata.revisionId,
            canonicalUrl: metadata.canonicalUrl,
            publishedAt: metadata.publishedAt,
            language: metadata.language,
            license: metadata.license,
            aiUseDisclosure: metadata.aiUseDisclosure
        },
        digests,
        ingredients: ingredients.map(ingredient => Object.fromEntries(
            Object.entries(ingredient).filter(([key]) => key !== 'bytes')
        )),
        release: metadata.release
    };
    assertPublicManifest(assertion);

    const manifestDefinition = {
        claim_version: 2,
        claim_generator_info: [{ name: 'FsusBlog Content Credentials Prototype', version: '1.0.0' }],
        title: metadata.title,
        assertions: [{ label: assertionLabel, data: assertion }]
    };
    const association = buildHtmlManifestLink(metadata.manifestUrl);
    const files = {
        'canonical/article.md': markdown,
        'canonical/article.html': html,
        'canonical/metadata.json': metadataJson,
        'manifest-definition.json': stableJson(manifestDefinition),
        'html-association.txt': `${association}\n`
    };
    const packageManifest = {
        schema: 'fsusblog.content-credential-package.v1',
        canonicalization: canonicalizationVersion,
        manifestUrl: metadata.manifestUrl,
        files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256Hex(content)])),
        ingredients: Object.fromEntries(ingredients.map(ingredient => [ingredient.uri, ingredient.sha256]))
    };
    files['package-manifest.json'] = stableJson(packageManifest);

    return { assertion, association, files, ingredients, manifestDefinition, metadata, packageManifest };
}

export function writeArticleCanonicalPackage(targetDirectory, articlePackage)
{
    fs.mkdirSync(targetDirectory, { recursive: true });
    for (const [relativePath, content] of Object.entries(articlePackage.files))
    {
        const absolutePath = path.join(targetDirectory, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
    }

    const assetDirectory = path.join(targetDirectory, 'assets');
    fs.mkdirSync(assetDirectory, { recursive: true });
    for (const ingredient of articlePackage.ingredients)
    {
        const fileName = `${ingredient.kind}${path.extname(new URL(ingredient.uri).pathname) || '.bin'}`;
        fs.writeFileSync(path.join(assetDirectory, fileName), ingredient.bytes);
    }
}

export function verifyArticleCanonicalPackage(articlePackage)
{
    const errors = [];
    for (const [file, digest] of Object.entries(articlePackage.packageManifest.files))
    {
        const content = articlePackage.files[file];
        if (content === undefined)
        {
            errors.push(`missing:${file}`);
        }
        else if (sha256Hex(content) !== digest)
        {
            errors.push(`digest-mismatch:${file}`);
        }
    }
    const assertion = articlePackage.manifestDefinition.assertions.find(item => item.label === assertionLabel)?.data;
    if (!assertion)
    {
        errors.push('assertion-missing');
    }
    else if (stableJson(assertion) !== stableJson(articlePackage.assertion))
    {
        errors.push('assertion-mismatch');
    }
    try
    {
        assertPublicManifest(articlePackage.assertion);
    }
    catch (error)
    {
        errors.push(`privacy:${error.message}`);
    }
    return { accepted: errors.length === 0, errors };
}

export function buildHtmlManifestLink(manifestUrl)
{
    const parsed = new URL(manifestUrl);
    if (parsed.protocol !== 'https:')
    {
        throw new Error('manifest URL must use HTTPS');
    }
    return `<link rel="c2pa-manifest" type="application/c2pa" href="${escapeHtml(parsed.href)}">`;
}

export function assertPublicManifest(value)
{
    visit(value, []);

    function visit(candidate, pathParts)
    {
        if (Array.isArray(candidate))
        {
            candidate.forEach((item, index) => visit(item, [...pathParts, String(index)]));
            return;
        }
        if (candidate && typeof candidate === 'object')
        {
            for (const [key, nested] of Object.entries(candidate))
            {
                if (forbiddenPrivateKey.test(key))
                {
                    throw new Error(`private field is forbidden: ${[...pathParts, key].join('.')}`);
                }
                visit(nested, [...pathParts, key]);
            }
            return;
        }
        if (typeof candidate !== 'string')
        {
            return;
        }
        if (emailValue.test(candidate))
        {
            throw new Error(`email-like value is forbidden: ${pathParts.join('.')}`);
        }
        if (ipv4Value.test(candidate))
        {
            throw new Error(`IP-like value is forbidden: ${pathParts.join('.')}`);
        }
    }
}

export function evaluateProductionDefault(evidence)
{
    const reasons = [];
    if (evidence.canonicalization !== canonicalizationVersion || evidence.canonicalizationFrozen !== true)
    {
        reasons.push('canonicalization-not-frozen');
    }
    const passingVerifiers = (evidence.verifiers ?? []).filter(item => item.status === 'passed');
    const implementationFamilies = new Set(passingVerifiers.map(item => item.implementationFamily).filter(Boolean));
    if (passingVerifiers.length < 2 || implementationFamilies.size < 2)
    {
        reasons.push('two-independent-verifiers-required');
    }

    const requiredTamperCases = ['markdown', 'metadata', 'cover', 'ingredient', 'manifest-url'];
    const detectedCases = new Set((evidence.tamperCases ?? []).filter(item => item.detected === true).map(item => item.case));
    for (const tamperCase of requiredTamperCases)
    {
        if (!detectedCases.has(tamperCase))
        {
            reasons.push(`tamper-case-missing:${tamperCase}`);
        }
    }

    for (const requirement of ['staticDownload', 'cacheRestore', 'redeploy', 'noJavaScriptReadable', 'keyRotation', 'keyRevocation', 'privacyReview', 'performanceBudget'])
    {
        if (evidence[requirement] !== true)
        {
            reasons.push(`evidence-missing:${requirement}`);
        }
    }
    return {
        schema: 'fsusblog.c2pa-production-decision.v1',
        status: reasons.length === 0 ? 'eligible' : 'blocked',
        productionDefault: reasons.length === 0,
        reasons
    };
}

export function mutationEvidence(fixture, options)
{
    const baseline = buildArticleCanonicalPackage(fixture, options);
    const cases = [
        ['markdown', current => ({ ...current, markdown: `${current.markdown}\n篡改` }), 'markdownSha256'],
        ['metadata', current => ({ ...current, summary: `${current.summary} 篡改` }), 'metadataSha256'],
        ['cover', current => ({ ...current, ingredients: current.ingredients.map((item, index) => index === 0 ? { ...item, sourcePath: item.tamperedSourcePath } : item) }), 'ingredient'],
        ['ingredient', current => ({ ...current, ingredients: current.ingredients.map((item, index) => index === 0 ? item : { ...item, sourcePath: item.tamperedSourcePath }) }), 'ingredient'],
        ['manifest-url', current => ({ ...current, manifestUrl: current.manifestUrl.replace('/manifest.c2pa', '/moved.c2pa') }), 'invalid-url']
    ];
    return cases.map(([name, mutate, target]) =>
    {
        try
        {
            const changed = buildArticleCanonicalPackage(mutate(structuredClone(fixture)), options);
            const detected = target === 'ingredient'
                ? stableJson(changed.packageManifest.ingredients) !== stableJson(baseline.packageManifest.ingredients)
                : changed.assertion.digests[target] !== baseline.assertion.digests[target];
            return { case: name, detected };
        }
        catch
        {
            return { case: name, detected: target === 'invalid-url' };
        }
    });
}

function canonicalMetadata(fixture)
{
    const canonicalUrl = new URL(fixture.canonicalUrl);
    if (canonicalUrl.protocol !== 'https:')
    {
        throw new Error('canonical URL must use HTTPS');
    }
    const manifestUrl = new URL(fixture.manifestUrl);
    if (manifestUrl.origin !== canonicalUrl.origin)
    {
        throw new Error('manifest URL must be same-origin');
    }
    if (manifestUrl.search || manifestUrl.hash)
    {
        throw new Error('manifest URL must not contain query or fragment');
    }
    const expectedSuffix = `/credentials/articles/${fixture.articleId}/revisions/${fixture.revisionId}/manifest.c2pa`;
    if (!manifestUrl.pathname.endsWith(expectedSuffix))
    {
        throw new Error(`manifest URL must be immutable and revision-scoped: ${expectedSuffix}`);
    }

    const aiUseDisclosure = String(fixture.aiUseDisclosure).trim().toLowerCase();
    if (!['none', 'assisted', 'generated'].includes(aiUseDisclosure))
    {
        throw new Error('AI use disclosure must be none, assisted, or generated');
    }
    return {
        schemaVersion: 1,
        articleId: positiveInteger(fixture.articleId, 'articleId'),
        revisionId: positiveInteger(fixture.revisionId, 'revisionId'),
        title: requiredText(fixture.title, 'title'),
        summary: requiredText(fixture.summary, 'summary'),
        canonicalUrl: canonicalUrl.href,
        manifestUrl: manifestUrl.href,
        publishedAt: new Date(fixture.publishedAt).toISOString(),
        language: requiredText(fixture.language, 'language'),
        license: requiredText(fixture.license, 'license'),
        aiUseDisclosure,
        release: {
            version: requiredText(fixture.release?.version, 'release.version'),
            commit: hexDigest(fixture.release?.commit, 'release.commit', 40),
            repositoryReceiptSha256: hexDigest(fixture.release?.repositoryReceiptSha256, 'release.repositoryReceiptSha256', 64)
        }
    };
}

function canonicalIngredient(ingredient, fixtureDirectory)
{
    const sourcePath = path.resolve(fixtureDirectory, requiredText(ingredient.sourcePath, 'ingredient.sourcePath'));
    const bytes = fs.readFileSync(sourcePath);
    const uri = new URL(requiredText(ingredient.uri, 'ingredient.uri'));
    if (uri.protocol !== 'https:')
    {
        throw new Error('ingredient URL must use HTTPS');
    }
    return {
        kind: requiredText(ingredient.kind, 'ingredient.kind'),
        relationship: requiredText(ingredient.relationship, 'ingredient.relationship'),
        mediaType: requiredText(ingredient.mediaType, 'ingredient.mediaType'),
        uri: uri.href,
        sha256: sha256Hex(bytes),
        bytes
    };
}

function validateFixture(fixture)
{
    if (!fixture || typeof fixture !== 'object')
    {
        throw new Error('fixture must be an object');
    }
    if (!Array.isArray(fixture.ingredients) || fixture.ingredients.length === 0)
    {
        throw new Error('at least one ingredient is required');
    }
    requiredText(fixture.markdown, 'markdown');
    requiredText(fixture.renderedHtml, 'renderedHtml');
}

function canonicalizeText(value)
{
    const text = requiredText(value, 'canonical text').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').normalize('NFC');
    return `${text.replace(/\n+$/u, '')}\n`;
}

function normalizeJsonValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(normalizeJsonValue);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeJsonValue(value[key])]));
    }
    if (typeof value === 'number' && !Number.isFinite(value))
    {
        throw new Error('non-finite JSON number is forbidden');
    }
    if (value === undefined)
    {
        throw new Error('undefined JSON value is forbidden');
    }
    return value;
}

function requiredText(value, name)
{
    if (typeof value !== 'string' || value.trim() === '')
    {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function positiveInteger(value, name)
{
    if (!Number.isSafeInteger(value) || value <= 0)
    {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function hexDigest(value, name, length)
{
    const normalized = requiredText(value, name).toLowerCase();
    if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(normalized))
    {
        throw new Error(`${name} must be ${length} hexadecimal characters`);
    }
    return normalized;
}

function escapeHtml(value)
{
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
