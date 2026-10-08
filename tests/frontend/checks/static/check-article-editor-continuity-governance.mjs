#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const adapterPath = 'src/frontend/src/services/authoring/articleEditorContinuity.ts';
const required = [
    'fsusblog.article-editor-continuity.v1', 'fsusblog.article-editor-continuity-receipt.v1', 'fsusblog.article-editor-continuity-ack.v1',
    "'publish-preview-open', 'publish-preview-close', 'source-compare-open', 'source-compare-close'",
    'this.anchors.capture(binding, this.observation.selection, options)',
    'this.anchors.restore(before.anchor, binding, { ...restore, origin })',
    'const state = this.cache.state', 'renderReceipt = await this.cache.refresh()', 'this.cache.cancel()',
    'instance !== this.editor', 'this.owner.isCurrentContext(input.document)',
    'result.documentIdentity.epoch !== document.documentEpoch', 'result.revision !== document.sourceRevision',
    'this.owner.isTaskCurrent(lease', "changes: [], history: 'skip', origin: 'programmatic'",
    "status: 'awaiting-ack'", 'validateArticleEditorContinuityAcknowledgement(input)',
    'input.focus !== this.focusState', 'digest(input.selection) !== digest(this.observation.selection)',
    'digest(input.history) !== digest(this.observation.history)',
    "this.anchors.userIntent.state === 'manual'", 'this.anchors.userIntent.generation !== command.intent.generation',
    'input.viewportOffset === pending.receipt.anchorCommand.viewportOffset',
    'ack.document.contextDigest !== receipt.anchorCommand?.document.contextDigest',
    'receipt.renderReceipt.task.context.contextDigest !== receipt.before.document.contextDigest'
];
const forbidden = [
    /\b(?:getSelection|querySelector|selectionStart|selectionEnd|scrollIntoView)\b/u,
    /\b(?:localStorage|sessionStorage|indexedDB)\b/u,
    /\b(?:new\s+Map|createMarkdownAnchorMap|createMarkdownEditorProjection|renderMarkdownResultWithRuntime)\b/u,
    /(?:from\s+['"]@ozwasyd\/element-plus\/[^'"]+\/src|packages\/components\/)/u,
    /\b(?:remount|recreateEditor|editorKey|fourMode|splitMode|previewMode|writeMode)\b/u,
    /(?:\.focus\s*\(|\.getSelection\s*\(|\.innerHTML\s*=|setTimeout\s*\()/u
];
function inspect(source)
{
    return [
        ...required.filter(binding => !source.includes(binding)).map(binding => `missing binding: ${binding}`),
        ...forbidden.filter(pattern => pattern.test(source)).map(pattern => `forbidden independent authority: ${pattern}`)
    ];
}
const source = readFileSync(resolve(root, adapterPath), 'utf8');
const controls = [
    ...required.map(binding => [`binding:${binding}`, source.replaceAll(binding, 'removed_binding')]),
    ['private-dom', `${source}\nconst target = document.querySelector('textarea');`],
    ['private-focus', `${source}\neditor.focus();`],
    ['remount', `${source}\nconst editorKey = epoch;`],
    ['preference', `${source}\nlocalStorage.setItem('surface', surface);`],
    ['second-cache', `${source}\nconst cache = new Map();`],
    ['mapping', `${source}\ncreateMarkdownAnchorMap(source);`],
    ['renderer', `${source}\nrenderMarkdownResultWithRuntime(source);`]
];
const failures = inspect(source);
for (const [name, mutated] of controls)
{
    if (inspect(mutated).length === 0)
    {
        failures.push(`negative control survived: ${name}`);
    }
}
const runtimePath = 'src/frontend/src/services/authoring/articleEditorRuntimeBinding.ts';
const runtime = readFileSync(resolve(root, runtimePath), 'utf8');
const runtimeForbidden = [
    /\b(?:querySelector|getSelection|selectionStart|selectionEnd|scrollIntoView)\b/u,
    /\b(?:localStorage|sessionStorage|indexedDB|new\s+Map)\b/u,
    /\b(?:ArticleDocumentContextAuthority|createArticleDocumentContextAdapter|createMarkdownAnchorMap|createMarkdownEditorProjection)\b/u,
    /\b(?:renderMarkdownResultWithRuntime|remount|recreateEditor|editorKey)\b/u,
    /(?:\.focus\s*\(|\.innerHTML\s*=|setTimeout\s*\()/u,
    /(?:from\s+['"]@ozwasyd\/element-plus\/[^'"]+\/src|packages\/components\/)/u
];
const runtimeControls = [
    ['private-viewport', 'document.querySelector("textarea");'],
    ['private-focus', 'editor.focus();'],
    ['remount', 'const editorKey = epoch;'],
    ['persist-context', 'localStorage.setItem("context", context);'],
    ['second-cache', 'const otherCache = new Map();'],
    ['second-document', 'createArticleDocumentContextAdapter(input);'],
    ['second-map', 'createMarkdownAnchorMap(source);'],
    ['second-renderer', 'renderMarkdownResultWithRuntime(source);']
];
for (const pattern of runtimeForbidden)
{
    if (pattern.test(runtime))
    {
        failures.push(`${runtimePath}: forbidden independent authority: ${pattern}`);
    }
}
for (const [name, mutation] of runtimeControls)
{
    if (!runtimeForbidden.some(pattern => pattern.test(`${runtime}\n${mutation}`)))
    {
        failures.push(`runtime negative control survived: ${name}`);
    }
}
if (failures.length > 0)
{
    console.error(failures.join('\n'));
    process.exit(1);
}
console.log(`article editor continuity governance passed; negative controls=${controls.length + runtimeControls.length}; data/commands stage only`);
