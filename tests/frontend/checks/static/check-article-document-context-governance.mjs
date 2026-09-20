#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const contextPath = path.join(
    repoRoot,
    'src/frontend/src/services/authoring/articleDocumentContext.ts'
);
const writePath = path.join(repoRoot, 'src/frontend/src/composables/useAdminArticleWrite.ts');
const contextTestPath = path.join(
    repoRoot,
    'tests/frontend/unit/authoring/articleDocumentContext.test.ts'
);
const sourceRoot = path.join(repoRoot, 'src/frontend/src');
const failures = [];

const read = file => fs.readFileSync(file, 'utf8');
const relative = file => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const fail = (file, message) => failures.push(`${relative(file)}:1: ${message}`);

function sourceFiles(root)
{
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory())
        {
            return sourceFiles(absolute);
        }
        return /\.(?:ts|vue)$/u.test(entry.name) ? [absolute] : [];
    });
}

const context = read(contextPath);
const write = read(writePath);
const contextTest = read(contextTestPath);
const productionSources = sourceFiles(sourceRoot);

for (const token of [
    "articleDocumentContextSchema = 'fsusblog.article-document-context.v1'",
    "articleDocumentTaskEnvelopeSchema = 'fsusblog.article-document-task-envelope.v1'",
    "articleDocumentEpochReceiptSchema = 'fsusblog.article-document-epoch-receipt.v1'",
    'sourceIdentityDigest:',
    'contentDigest:',
    'contextDigest:',
    'editorSessionId:',
    'siteScope:',
    'userScope:',
    'articleDocumentTaskKinds',
    "'render'",
    "'projection'",
    "'feature'",
    "'refresh'",
    "'attachment'",
    "'search'",
    "'outline'",
    "'preview'",
    "'compare'",
    'class ArticleDocumentContextAdapter',
    'class ArticleDocumentContextAuthority',
    'adapter.cancelAll(\'component-unmounted\')',
    'export const articleDocumentContextAuthority = new ArticleDocumentContextAuthority()'
])
{
    if (!context.includes(token))
    {
        fail(contextPath, `document context authority is missing ${token}`);
    }
}

for (const [pattern, reason] of [
    [/\b(?:Date\.now|Math\.random|randomUUID)\s*\(/u, 'timestamp or random identity authority'],
    [/\b(?:useRoute|route\.(?:params|query|path|fullPath))\b/u, 'route identity authority'],
    [/\b(?:querySelector|getSelection|selectionStart|selectionEnd|innerHTML)\b/u, 'private DOM or naked selection authority'],
    [/\b(?:parserState|projectionState|syntaxIdentity|positionDelta)\b/u, 'consumer parser or position authority'],
    [/(?:\bdocumentEpoch\s*[:=][^\n]*(?:hash|digest)|(?:hash|digest)[^\n]*\bdocumentEpoch\s*[:=])/iu, 'hash-derived epoch authority'],
    [/\bArticleDocumentContextRegistry\b/u, 'second document context registry']
])
{
    if (pattern.test(context))
    {
        fail(contextPath, `document context authority contains forbidden ${reason}`);
    }
}

const adapterOwners = productionSources.filter(file => (
    read(file).includes('class ArticleDocumentContextAdapter')
));
if (adapterOwners.length !== 1 || path.resolve(adapterOwners[0] ?? '') !== path.resolve(contextPath))
{
    fail(
        contextPath,
        `ArticleDocumentContextAdapter must have exact-one production owner; found ${adapterOwners.map(relative).join(', ')}`
    );
}

const directProductionFactories = productionSources.filter(file => (
    path.resolve(file) !== path.resolve(contextPath)
    && read(file).includes('createArticleDocumentContextAdapter(')
));
if (directProductionFactories.length > 0)
{
    fail(
        contextPath,
        `production consumers must acquire the singleton authority, not construct parallel adapters: ${directProductionFactories.map(relative).join(', ')}`
    );
}

for (const token of [
    'articleDocumentContextAuthority.acquire({',
    'articleDocumentContextBinding.adapter',
    'articleDocumentContextBinding.switchDocument({',
    'articleDocumentContextBinding.release()',
    'resetArticleDocumentState();',
    'void initData();'
])
{
    if (!write.includes(token))
    {
        fail(writePath, `article writer is missing ${token}`);
    }
}

for (const forbidden of [
    /editorSessionId:\s*recoveryCoordinator\.tabId/u,
    /documentEpoch\s*:\s*(?:Date\.now|Math\.random|.*(?:hash|digest))/iu,
    /:key\s*=\s*["'][^"']*article/iu,
    /\b(?:querySelector|getSelection|selectionStart|selectionEnd)\b/u
])
{
    if (forbidden.test(write))
    {
        fail(writePath, `article writer contains forbidden identity or private editor access: ${forbidden}`);
    }
}

const switchIndex = write.indexOf('articleDocumentContextBinding.switchDocument({');
const resetIndex = write.indexOf('resetArticleDocumentState();', switchIndex);
const initIndex = write.indexOf('void initData();', resetIndex);
if (switchIndex < 0 || resetIndex < switchIndex || initIndex < resetIndex)
{
    fail(writePath, 'document switch must reset old article state synchronously before loading the new article');
}

for (const token of [
    'isolates A/B same-source and different-source article identities',
    'updates source and draft revisions without creating a document epoch',
    'binds every Blog-owned async task kind and accepts only the current result',
    'aborts all old tasks and rejects late same-source results after an explicit switch',
    'cancels each rapid intermediate epoch and records only exact lifecycle receipts',
    'retains one opaque identity and epoch across component release and remount',
    'creates exact-one switch receipt for entity changes and reuses the new draft on remount',
    'advances exact-one epoch when a user explicitly replaces one unsaved draft with another',
    'treats site or user scope changes as an entity switch without route or content authority',
    'rejects tampered task envelopes even when the changed field keeps its shape'
])
{
    if (!contextTest.includes(token))
    {
        fail(contextTestPath, `independent verifier is missing ${token}`);
    }
}

if (failures.length > 0)
{
    console.error(failures.join('\n'));
    process.exit(1);
}

console.log('article document context governance passed');
