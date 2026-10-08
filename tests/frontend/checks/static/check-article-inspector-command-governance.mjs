#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const adapterPath = 'src/frontend/src/composables/useArticleWriteInspectorCommands.ts';
const viewPath = 'src/frontend/src/views/admin/article/Write.vue';
const ownerPath = 'src/frontend/src/composables/useArticleWriteInspector.ts';
const read = (file) => readFileSync(resolve(root, file), 'utf8');

function inspect(adapter, view, owner)
{
    const failures = [];
    for (const required of [
        'articleWriteInspectorRegistry.map',
        "import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands'",
        'options.inspector.open(view)',
        'options.inspector.focusActiveView(view, controller.signal)',
        '!validateArticleDocumentContext(document)',
        'context.documentIdentity.id !== document.documentId',
        'context.documentIdentity.epoch !== document.documentEpoch',
        'context.revision !== document.sourceRevision',
        'content: context.value',
        "options.admin.adminState !== 'active'",
        "!options.admin.hasPermission('article.write')",
        'options.modalActive.value',
        'pending.value',
        'controller.signal.throwIfAborted()',
        "context.signal.removeEventListener('abort', abort)",
        'onScopeDispose',
        'verifyArticleInspectorCommandReceipt',
        "import { translate } from '@/locales'"
    ])
    {
        if (!adapter.includes(required))
        {
            failures.push(`missing binding: ${required}`);
        }
    }
    for (const forbidden of [
        /from\s+['"]@\/api\//u,
        /\b(?:fetch|axios|saveDraftNow|submitForm|updateArticle|createArticle)\s*\(/u,
        /\b(?:querySelector|getSelection|selectionStart|selectionEnd)\b/u,
        /\b(?:articleResults|recentArticles|popularCommands|aiRanking|commandRecommendations)\b/u,
        /\b(?:input|contribution|extension)\.run\s*\(/u,
        /hasPermission\s*:\s*\([^)]*\)\s*=>\s*true/u,
        /(?:localStorage|sessionStorage)\s*\./u
    ])
    {
        if (forbidden.test(adapter))
        {
            failures.push(`forbidden palette authority: ${forbidden}`);
        }
    }
    if (!view.includes(':authoring-commands="inspectorCommands"') ||
        !view.includes('admin: useAdminStore()') ||
        !view.includes('documentContext: authoringDocumentContext') ||
        !view.includes('inspector: inspectorOwner'))
    {
        failures.push('writer must bind the current formal inspector, document and admin owners');
    }
    if (!owner.includes('activeInspector.value !== view') ||
        !owner.includes('signal?.aborted') ||
        !owner.includes('target.ownerDocument.activeElement === target'))
    {
        failures.push('the inspector focus owner must verify the actual active target and abort signal');
    }
    return failures;
}

const adapter = read(adapterPath);
const view = read(viewPath);
const owner = read(ownerPath);
const controls = [
    ['handler', adapter.replace('options.inspector.open(view)', 'anotherOwner.open(view)'), view, owner],
    ['identity', adapter.replace('context.documentIdentity.id !== document.documentId', 'false'), view, owner],
    ['epoch', adapter.replace('context.documentIdentity.epoch !== document.documentEpoch', 'false'), view, owner],
    ['revision', adapter.replace('context.revision !== document.sourceRevision', 'false'), view, owner],
    ['permission', adapter.replace("!options.admin.hasPermission('article.write')", 'false'), view, owner],
    ['session', adapter.replace("options.admin.adminState !== 'active'", 'false'), view, owner],
    ['modal', adapter.replaceAll('options.modalActive.value', 'false'), view, owner],
    ['abort', adapter.replaceAll('controller.signal.throwIfAborted()', ''), view, owner],
    ['source-api', `${adapter}\nimport { updateArticle } from '@/api/article';`, view, owner],
    ['direct-api', `${adapter}\nfetch('/api/article');`, view, owner],
    ['mixed-articles', `${adapter}\nconst articleResults = [];`, view, owner],
    ['ranking', `${adapter}\nconst popularCommands = [];`, view, owner],
    ['untrusted-callback', `${adapter}\ninput.run(context);`, view, owner],
    ['forged-permission', `${adapter}\nconst authority = { hasPermission: () => true };`, view, owner],
    ['writer-owner', adapter, view.replace('inspector: inspectorOwner', 'inspector: differentOwner'), owner],
    ['focus-owner', adapter, view, owner.replace('target.ownerDocument.activeElement === target', 'true')]
];
const failures = inspect(adapter, view, owner);
for (const [name, mutatedAdapter, mutatedView, mutatedOwner] of controls)
{
    if (inspect(mutatedAdapter, mutatedView, mutatedOwner).length === 0)
    {
        failures.push(`negative control survived: ${name}`);
    }
}
if (failures.length > 0)
{
    console.error(failures.join('\n'));
    process.exit(1);
}
console.log(`article inspector command governance passed; negative controls=${controls.length}; inspector-only development stage`);
