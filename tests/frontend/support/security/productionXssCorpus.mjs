import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const requiredCategories = Object.freeze([
    'raw-event',
    'malformed-separator',
    'entity-control-protocol',
    'dangerous-url',
    'namespace',
    'container-navigation',
    'mutation-serialization',
    'feature-output',
    'resource-boundary'
]);
const sourceSurfaces = Object.freeze([
    'core-sync',
    'wasm',
    'worker',
    'chunked',
    'ssr-no-dom',
    'initial-render',
    'browser-dom'
]);
const featureSurfaces = Object.freeze(['feature-gateway', 'browser-dom']);

function assertCorpus(condition, message)
{
    if (!condition)
    {
        throw new Error(`[production-xss-corpus] ${message}`);
    }
}

function sameMembers(actual, expected)
{
    return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((entry) => actual.includes(entry));
}

export async function loadProductionXssCorpus(env = process.env)
{
    const fsusUiRoot = path.resolve(
        env.FSUSBLOG_LOCAL_FSUSUI_ROOT ?? path.join(repositoryRoot, '..', 'FsusUI'));
    const contractPath = path.join(fsusUiRoot, 'scripts', 'markdown-xss-corpus.mjs');
    const corpusPath = path.join(fsusUiRoot, 'spec', 'security', 'markdown-xss-corpus.json');
    const schemaPath = path.join(fsusUiRoot, 'spec', 'security', 'markdown-xss-corpus.schema.json');
    const manifestPath = path.join(fsusUiRoot, 'spec', 'security', 'markdown-xss-consumer-manifest.json');
    await Promise.all([contractPath, corpusPath, schemaPath, manifestPath].map((file) => access(file)));
    const [corpusText, schemaText, manifestText] = await Promise.all([
        readFile(corpusPath, 'utf8'),
        readFile(schemaPath, 'utf8'),
        readFile(manifestPath, 'utf8')
    ]);
    const corpus = JSON.parse(corpusText);
    const schema = JSON.parse(schemaText);
    const manifest = JSON.parse(manifestText);

    assertCorpus(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', 'schema draft drift');
    assertCorpus(schema.properties?.cases?.minItems === 60, 'schema case floor drift');
    assertCorpus(corpus.version === 1 && manifest.version === 1, 'unsupported corpus or manifest version');
    assertCorpus(sameMembers(corpus.categories, requiredCategories), 'category registry drift');
    assertCorpus(Array.isArray(corpus.cases) && corpus.cases.length >= 60, 'corpus case floor is not met');

    const ids = new Set();
    const counts = Object.fromEntries(requiredCategories.map((category) => [category, 0]));
    for (const entry of corpus.cases)
    {
        assertCorpus(/^mxss-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id), `invalid case ID ${entry.id}`);
        assertCorpus(!ids.has(entry.id), `duplicate case ID ${entry.id}`);
        ids.add(entry.id);
        assertCorpus(requiredCategories.includes(entry.category), `${entry.id}: unknown category`);
        counts[entry.category] += 1;
        const hasSource = typeof entry.source === 'string';
        const hasFeature = entry.featureOutput !== undefined;
        assertCorpus(hasSource !== hasFeature, `${entry.id}: input ownership drift`);
        assertCorpus(entry.reviewed === true, `${entry.id}: review declaration missing`);
        assertCorpus(
            sameMembers(entry.surfaces, hasSource ? sourceSurfaces : featureSurfaces),
            `${entry.id}: surface coverage drift`);
        assertCorpus(
            Array.isArray(entry.invariants?.forbidSelectors)
        && entry.invariants.forbidSelectors.length > 0
        && entry.invariants.forbidExternalUrls === true
        && Array.isArray(entry.invariants.allowedNamespaces),
            `${entry.id}: incomplete DOM invariants`);
        assertCorpus(
            Array.isArray(entry.preserve?.text) && Array.isArray(entry.preserve?.selectors),
            `${entry.id}: legal-content preservation drift`);
    }
    for (const category of requiredCategories)
    {
        assertCorpus(counts[category] >= 3, `${category}: reviewed case floor is not met`);
    }

    const digest = createHash('sha256').update(corpusText).digest('hex');
    assertCorpus(manifest.sha256 === digest, 'manifest SHA drift');
    assertCorpus(manifest.caseCount === corpus.cases.length, 'manifest case count drift');
    assertCorpus(JSON.stringify(manifest.categories) === JSON.stringify(counts), 'manifest category counts drift');
    assertCorpus(manifest.fuzz?.seed === corpus.seed, 'manifest fuzz seed drift');
    assertCorpus(manifest.fuzz?.fastIterations >= 2_000, 'fast fuzz count is below 2,000');
    assertCorpus(manifest.fuzz?.releaseIterations >= 20_000, 'release fuzz count is below 20,000');
    assertCorpus(manifest.productionExport === false, 'corpus must remain test-only');

    return {
        corpus,
        counts,
        digest,
        manifest,
        contractPath,
        fsusUiRoot,
        source: 'FsusUI test-only source contract'
    };
}

function featureMarkdown(featureOutput)
{
    return String(featureOutput?.payload ?? '');
}

export function markdownForCorpusCase(entry)
{
    return typeof entry.source === 'string'
        ? entry.source
        : featureMarkdown(entry.featureOutput);
}

export function persistenceSafeMarkdownForCorpusCase(entry)
{
    return markdownForCorpusCase(entry).replaceAll('\0', '\uFFFD');
}

export function selectProductionXssCases(corpus, mode)
{
    if (mode === 'release')
    {
        return [...corpus.cases];
    }
    const selected = [];
    for (const category of corpus.categories)
    {
        const entry = corpus.cases.find((candidate) => candidate.category === category);
        if (!entry)
        {
            throw new Error(`FsusUI corpus category has no case: ${category}`);
        }
        selected.push(entry);
    }
    return selected;
}

export function resolveProductionFeatureGatewayAsset(manifest)
{
    const matches = Object.entries(manifest ?? {}).filter(([source, entry]) =>
        source.endsWith('/markdown-feature-output-gateway.ts')
    && entry?.isDynamicEntry === true
    && /^assets\/markdown-feature-output-gateway-[A-Za-z0-9_-]+\.js$/u.test(String(entry.file ?? '')));
    assertCorpus(matches.length === 1, 'production feature gateway asset ownership drift');
    return `/${matches[0][1].file}`;
}

export function resolveMetadataProbe(cases)
{
    const entry = cases.find((candidate) =>
        typeof candidate.source === 'string'
    && candidate.source.length > 0
    && candidate.source.length <= 80
    && !candidate.source.includes('\0'));
    if (!entry)
    {
        throw new Error('FsusUI corpus has no bounded metadata probe');
    }
    return entry.source;
}
