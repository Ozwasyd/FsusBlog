import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    articleWritingAidPolicyPath,
    articleWritingAidRuntimePath,
    inspectArticleWritingAidPolicy,
    inspectArticleWritingAidRuntime
} from './check-article-writing-aids-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const source = readFileSync(path.join(root, articleWritingAidPolicyPath), 'utf8');

test('actual policy retains public types and the original document authority', () =>
{
    assert.deepEqual(inspectArticleWritingAidPolicy(source), []);
});

for (const [name, mutation] of [
    ['private-dom', "document.querySelector('textarea');"],
    ['scroll-kernel', 'editor.scrollTop = 100;'],
    ['second-runtime', 'createWritingAidsController({ typewriter: true });'],
    ['local-authority', "localStorage.setItem('writingAids', 'on');"],
    ['surface-coupling', "const options = { mode: 'live' };"],
    ['single-mode', 'const zenEnabled = true;'],
    ['runtime-import', "import { resolveWritingAids } from '@ozwasyd/element-plus';"],
    ['private-import', "import { internalRuntime } from '@ozwasyd/element-plus/es/runtime';"]
])
{
    test(`refuses ${name} implementation mutation`, () =>
    {
        assert.ok(inspectArticleWritingAidPolicy(`${source}\n${mutation}\n`).includes(name));
    });
}

test('refuses removal of original current-context checking', () =>
{
    const mutation = source.replace('input.documentOwner.isCurrentContext(input.document)', 'true');
    assert.ok(inspectArticleWritingAidPolicy(mutation).includes('document-owner'));
});

test('refuses removal of public prop types', () =>
{
    const mutation = source.replace("from '@ozwasyd/element-plus';", "from './private-runtime';");
    assert.ok(inspectArticleWritingAidPolicy(mutation).includes('public-props-type'));
});

const runtime = readFileSync(path.join(root, articleWritingAidRuntimePath), 'utf8');
test('actual runtime consumer retains sole binding and intent owners', () =>
{
    assert.deepEqual(inspectArticleWritingAidRuntime(runtime), []);
});

for (const [name, before, after] of [
    ['runtime-document-owner', 'documentOwner.isCurrentContext(position.document)', 'true'],
    ['runtime-intent-owner', 'binding.anchors.userIntent.state', "'automatic'"],
    ['runtime-intent-owner', 'return binding.anchors.resume(reason, now)', 'return true']
])
{
    test(`refuses runtime authority replacement: ${before}`, () =>
    {
        assert.ok(inspectArticleWritingAidRuntime(runtime.replace(before, after)).includes(name));
    });
}

test('refuses an independent resume timer in the runtime consumer', () =>
{
    assert.ok(inspectArticleWritingAidRuntime(`${runtime}\nsetTimeout(() => {}, 1200);\n`).includes('scroll-kernel'));
});
