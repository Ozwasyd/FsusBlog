import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `render-conjunction-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function graph(output, prefix = '', imports = '')
{
    const file = resolve(directory, 'Owner.tsx');
    writeFileSync(file, `import {defineComponent,h} from 'vue';${imports}export default defineComponent({setup(){return ()=>{${prefix}return ${output};};}});`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
}

test('actual TableV2 conjunction guards retain functional renderer source and unknown slot body rejection', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/table-v2/src/table-v2.tsx');
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
    for (const [tag, condition] of [['Empty', 'unref(showEmpty)'], ['Overlay', 'slots.overlay']])
    {
        const node = result.nodes.find((node) => node.file === file && node.tag === tag);
        assert.ok(node, tag);
        assert.deepEqual(node.conditional, [{ name: 'if', expression: condition }]);
        assert.equal(node.origin.kind, 'local');
        assert.ok(node.definition.endsWith(`/renderers/${tag.toLowerCase()}.tsx`));
        assert.ok(result.files.find((entry) => entry.file === node.definition).renderSource.functional.proofDigest);
    }
    assert.ok(result.errors.some((error) => error.message?.includes('unknown/reserved script render attribute')));
    assert.ok(result.errors.some((error) => error.message?.includes('default: slots.')));
});

test('render conjunction retains its exact native branch without selecting product state', () =>
{
    const result = graph('productState && <main/>');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.nodes.map((node) => ({ tag: node.tag, conditional: node.conditional })),
        [{ tag: 'main', conditional: [{ name: 'if', expression: 'productState' }] }]);
});

test('render conjunction preserves the actual imported public component source', () =>
{
    const result = graph('productState && <ElIcon><Glyph/></ElIcon>', '',
        'import {ElIcon} from "@ozwasyd/element-plus";import {Check as Glyph} from "@ozwasyd/element-plus/icons-vue";');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].reason, 'unbound-slot-source');
    assert.match(result.errors[0].message, /unbound conditional\/script slot supplier/);
    const component = result.nodes.find((node) => node.tag === 'ElIcon');
    assert.equal(component.origin.kind, 'fsusui-public');
    assert.deepEqual(component.conditional, [{ name: 'if', expression: 'productState' }]);
    assert.ok(result.nodes.some((node) => node.tag === 'svg'));
});

test('nested render conjunctions retain both authored guards', () =>
{
    const result = graph('first && (second && <main/>)');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.nodes[0].conditional, [{ name: 'if', expression: 'first' }, { name: 'if', expression: 'second' }]);
});

test('render conjunction retains the actual route name visual branch error', () =>
{
    const result = graph('route.name === "admin" && <main/>', 'const route=useRoute();', 'import {useRoute} from "vue-router";');
    assert.ok(result.errors.some((error) => error.reason === 'route-name-visual-branch'));
    assert.equal(result.nodes[0].tag, 'main');
});

for (const [label, output, prefix] of [
    ['unknown child', 'state && <main>{unknown}</main>', ''],
    ['unknown component', 'state && <Unknown/>', ''],
    ['unknown props spread', 'state && <main {...unknown}/>', ''],
    ['mutated branch constant', 'state && panel', 'const panel=<main/>;panel.type=unknown;'],
    ['unknown helper', 'state && foreign()', ''],
    ['logical disjunction', 'unknown || <main/>', ''],
    ['nullish fallback', 'unknown ?? <main/>', '']
])
{
    test(`render conjunction rejects ${label}`, () =>
    {
        assert.ok(graph(output, prefix).errors.length > 0, label);
    });
}
