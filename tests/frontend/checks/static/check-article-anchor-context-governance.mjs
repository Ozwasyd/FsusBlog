#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const adapterPath = 'src/frontend/src/services/authoring/articleAnchorContext.ts';
const forbidden = [
    [/\b(?:querySelector|getSelection|selectionStart|selectionEnd|innerHTML|DOMParser|HTMLElement)\b/u, 'private DOM authority'],
    [/\b(?:RegExp|matchAll|match|replace|replaceAll|exec|split)\s*\(/u, 'consumer text parser'],
    [/\b(?:createMarkdownAnchorMap|createMarkdownEditorProjection|parseMarkdown|headingText|headingMap|domPath|htmlOffset)\b/u, 'consumer semantic authority'],
    [/\b(?:positionDelta|offsetDelta|anchorRegistry|ArticleAnchorRegistry)\b/u, 'second mapping authority'],
    [/\b(?:start|end|offset|point)\s*(?:\+=|-=)|\b(?:start|end|offset|point)\s*:\s*[^,;\n]*\s[+-]\s/u, 'consumer offset arithmetic'],
    [/\b(?:localStorage|sessionStorage|preferences|authorPreference)\b/u, 'article context persistence']
];
const required = [
    'sourceSelectionToVisual(', 'visualAnchorToSourceSelection(', 'sourcePositionToVisual(',
    'sourceRangeToReveal(', '.positionMap.mapRange(', '.positionMap.map(', 'beforeAnchor: structuredClone(saved)',
    'documentEpoch', 'contentDigest', 'beforeRevision', 'source-revision-unmapped',
    "'semantic-neighbor'", "'percentage'", 'approximate:', "this.intent.state === 'manual'",
    'event.generation !== null', 'this.lastSyncAt', 'syncDebounceMs', 'idleResumeMs',
    'options.reducedMotion', 'options.viewportHeight', 'this.log.length = 0'
];
function violations(source)
{
    return [
        ...forbidden.filter(([pattern]) => pattern.test(source)).map(([, reason]) => reason),
        ...required.filter(token => !source.includes(token)).map(token => `missing ${token}`)
    ];
}
const source = fs.readFileSync(path.join(root, adapterPath), 'utf8');
const failures = violations(source);
// Negative controls exercise authority and feedback guards, rather than only asserting tokens.
for (const mutation of [
    'querySelector(".editor")', 'headingText', 'new RegExp("heading")',
    'offsetDelta', 'start: source.start + 1', 'localStorage'
])
{
    assert.ok(violations(`${source}\n${mutation}`).length > 0, mutation);
}
for (const token of ['event.generation !== null', 'this.lastSyncAt', 'sourceRangeToReveal(', "this.intent.state === 'manual'"])
{
    assert.ok(violations(source.replaceAll(token, 'removed_guard')).length > 0, token);
}
function owners(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            return owners(absolute);
        }
        return /\.(?:ts|vue)$/u.test(entry.name)
            && fs.readFileSync(absolute, 'utf8').includes('class ArticleAnchorContextAdapter') ? [absolute] : [];
    });
}
assert.deepEqual(owners(path.join(root, 'src/frontend/src')), [path.join(root, adapterPath)], 'exact-one anchor command owner');
if (failures.length > 0)
{
    console.error(failures.map(reason => `${adapterPath}:1: ${reason}`).join('\n'));
    process.exit(1);
}
console.log('article anchor context governance and negative controls passed');
