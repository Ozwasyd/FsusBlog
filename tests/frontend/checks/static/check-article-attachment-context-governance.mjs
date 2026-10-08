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
    'contentDigest:', 'created-intent-capacity', 'attachment-input-disposed'
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
for (const token of ['lease.signal', 'expectedRevision:', 'isCurrentContext(', 'resolveMarkdownClipboardPaste('])
{
    assert.ok(failures(source.replaceAll(token, 'removed_guard')).length > 0, token);
}
assert.deepEqual(failures(source), [], ownerPath);
console.log('article attachment created-stage governance and negative controls passed; completion lifecycle remains unqualified');
