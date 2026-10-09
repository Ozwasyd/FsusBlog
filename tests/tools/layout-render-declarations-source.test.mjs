import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `render-declarations-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function graph(body)
{
    const file = resolve(directory, 'Owner.tsx');
    writeFileSync(file, `import {defineComponent,h} from 'vue';import {ElButton} from '@ozwasyd/element-plus';export default defineComponent({setup(){return ()=>{${body}};}});`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
}

test('actual Options helper declaration is inert while its escaped slot return remains rejected', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/select/src/options.ts');
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
    assert.ok(result.errors.every((error) => error.file !== file || error.line !== 25));
    assert.ok(result.errors.some((error) => error.file === file && error.line === 55 && error.reason === 'unknown-render-source'));
});

test('an inert local function declaration does not render its unknown return body', () =>
{
    const result = graph('function helper(){return unknown;}return <main/>;');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.nodes.map((node) => node.tag), ['main']);
});

test('a local handler declaration preserves the actual native render source', () =>
{
    const result = graph('function handle(){productEvent();}return h("main",{onClick:handle},"content");');
    assert.deepEqual(result.errors, []);
    assert.equal(result.nodes[0].directives[0].expression, 'handle');
});

for (const [label, body] of [
    ['unknown helper render', 'function helper(){return unknown;}return helper();'],
    ['helper mutation', 'const panel=<main/>;function change(){panel.type=other;}change();return panel;'],
    ['helper input escape', 'const panel=<main/>;function change(value){foreign(value);}change(panel);return panel;'],
    ['shadowed Vue constructor', 'function h(){return unknown;}return h("main",{},"content");'],
    ['shadowed public component', 'function ElButton(){return unknown;}return <ElButton/>;']
])
{
    test(`render declaration rejects ${label}`, () =>
    {
        assert.ok(graph(body).errors.length > 0, label);
    });
}
