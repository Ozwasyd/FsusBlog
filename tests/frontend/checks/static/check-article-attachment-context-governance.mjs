#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ownerPath = 'src/frontend/src/services/authoring/articleAttachmentContext.ts';
const source = fs.readFileSync(path.join(root, ownerPath), 'utf8');
const forbidden = [
    /\b(?:querySelector|getSelection|selectionStart|selectionEnd|DOMParser|innerHTML|keydown|textarea)\b/u,
    /fsus-upload-placeholder:\/\//u,
    /\.(?:replace|replaceAll|match|matchAll)\s*\(/u,
    /\b(?:positionDelta|offsetDelta|parseCaption|captionRange|createCaption|captionField)\b/u,
    /\b(?:fetch|XMLHttpRequest|upload|AssetId|WebAssembly)\s*\(/u
];
const required = [
    'captureMarkdownAttachmentInput(', 'resolveMarkdownClipboardPaste(', 'planMarkdownAttachmentInsert(',
    'validateArticleAnchorContext(', 'validateArticleDocumentTaskEnvelope(', 'isCurrentContext(',
    'createArticleDocumentContext(', '.beginTask(', 'lease.signal', 'item.order', 'expectedRevision:',
    'contentDigest:', 'created-intent-capacity', 'attachment-input-disposed',
    'planMarkdownAttachmentResolve(', 'planMarkdownAttachmentRemove(', 'createMarkdownAttachmentJob(',
    'consumeTransaction(', 'port.commitSource(', 'result.positionMap.mapRange(', 'result.positionMap.map(',
    'attachment-position-map-missing', 'attachment-node-deleted', 'attachment-provider-context-stale',
    'attachment-pending-handle-invalid', 'attachment-retry-context-invalid', 'this.pendingHandles.get(handle)',
    'entry.controller.abort(', 'predecessorTaskRef:', 'validateArticleAttachmentLifecycle('
];
function failures(value)
{
    return forbidden.filter(pattern => pattern.test(value)).map(String)
        .concat(required.filter(token => !value.includes(token)).map(token => `missing ${token}`));
}
for (const mutation of ['querySelector', 'selectionStart', 'fsus-upload-placeholder://', 'value.replace(', 'offsetDelta', 'captionRange', 'upload('])
{
    assert.ok(failures(`${source}\n${mutation}`).length > 0, mutation);
}
for (const token of ['lease.signal', 'expectedRevision:', 'isCurrentContext(', 'resolveMarkdownClipboardPaste(',
    'result.positionMap.mapRange(', 'this.pendingHandles.get(handle)', 'entry.controller.abort(', 'predecessorTaskRef:'])
{
    assert.ok(failures(source.replaceAll(token, 'removed_guard')).length > 0, token);
}
assert.deepEqual(failures(source), [], ownerPath);
const owner = fs.readFileSync(path.join(root, 'src/frontend/src/composables/useAdminArticleWrite.ts'), 'utf8');
assert.ok(owner.includes('articleDocumentContextBinding.adapter'), 'existing document owner');
assert.ok(owner.includes('authoringAttachmentRuntime'), 'controlled owner entry');
assert.equal((owner.match(/new ArticleAttachmentContextAdapter\(/gu) ?? []).length, 1, 'sole attachment adapter');
assert.ok(!owner.includes('createArticleDocumentContextAdapter('), 'no second document context');
console.log('article attachment public lifecycle/controlled owner governance and negative controls passed; product/independent qualification not inferred');
