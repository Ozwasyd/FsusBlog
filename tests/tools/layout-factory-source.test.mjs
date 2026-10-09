import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `factory-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(name, content)
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
const factory = `import {defineComponent as define} from 'vue';
export const construct = (scope: string) => {
 const name = \`Scope\${scope}\`;
 const Item = define({name, inheritAttrs: false, setup(_, {slots}) {return () => slots.default?.();}});
 return {leaf: Item};
};`;
const construction = `import {construct} from './Factory';const {leaf: Leaf} = construct('Sample');export {Leaf};`;
function localSource(factoryContent = factory, constructionContent = construction)
{
    const file = fixture('Factory.ts', factoryContent);
    fixture('Construction.ts', constructionContent);
    const entry = fixture('Entry.vue', '<script setup>import {Leaf} from "./Construction";</script><template><Leaf><button/></Leaf></template>');
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    return { file, entry, source, result: source.graph([entry]) };
}

test('actual Dropdown and RovingFocus factory calls bind their arguments, field and slot render source', () =>
{
    const entry = fixture('Public.vue', '<script setup>import {ElDropdownItem} from "@ozwasyd/element-plus";</script><template><ElDropdownItem/></template>');
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    const result = source.graph([entry]);
    assert.deepEqual(result.errors, []);
    const calls = result.nodes.filter((node) => node.origin.factoryComponent);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((node) => node.origin.factoryComponent.arguments[0]).sort(), ['Dropdown', 'RovingFocusGroup']);
    for (const node of calls)
    {
        assert.equal(node.origin.kind, 'local');
        assert.ok(node.origin.file.startsWith(fsusUIRoot + '/'));
        assert.equal(node.definition, null);
        assert.equal(node.structural, true);
        const proof = node.origin.factoryComponent;
        assert.equal(proof.property, 'ElCollectionItem');
        assert.equal(proof.componentName, `El${proof.arguments[0]}CollectionItem`);
        assert.equal(proof.slot, 'default');
        assert.ok(proof.factoryFile.endsWith('/collection/src/collection.ts'));
        assert.equal(proof.factoryFileDigest, controlDigest(readFileSync(proof.factoryFile, 'utf8')));
        assert.equal(proof.callFileDigest, controlDigest(readFileSync(proof.callFile, 'utf8')));
        assert.ok(result.resolverInputs.some((input) => input.path === proof.factoryFile && input.digest === proof.factoryFileDigest));
        const record = source.resolver.parse(proof.factoryFile);
        const text = record.content.slice(proof.componentOffset);
        assert.ok(text.startsWith('defineComponent('));
        assert.ok(proof.bindingDigest && proof.factoryDigest && proof.componentDigest && proof.renderDigest);
    }
});

test('ordinary local factory aliases keep local ownership and never grant their slot children public identity', () =>
{
    const { result } = localSource();
    assert.deepEqual(result.errors, []);
    const call = result.nodes.find((node) => node.tag === 'Leaf');
    assert.equal(call.origin.kind, 'local');
    assert.equal(call.origin.factoryComponent.property, 'leaf');
    assert.equal(call.origin.factoryComponent.componentName, 'ScopeSample');
    assert.equal(result.nodes.find((node) => node.tag === 'button').origin.kind, 'native');
    assert.ok(result.nodes.every((node) => node.origin.kind !== 'fsusui-public'));
});

for (const [label, content] of [
    ['unknown callee', construction.replace("construct('Sample')", "missing('Sample')")],
    ['dynamic argument', construction.replace("construct('Sample')", 'construct(state)')],
    ['spread arguments', construction.replace("construct('Sample')", 'construct(...args)')],
    ['extra argument', construction.replace("construct('Sample')", "construct('Sample', 1)")],
    ['mutable construction', construction.replace('const {leaf:', 'let {leaf:')],
    ['destructuring default', construction.replace('leaf: Leaf}', 'leaf: Leaf = fallback}')],
    ['destructuring rest', construction.replace('leaf: Leaf}', 'leaf: Leaf, ...rest}')],
    ['reassigned result', construction + 'Leaf = replacement;'],
    ['mutated result property', construction + 'Leaf.render = replacement;'],
    ['unknown external factory', construction.replace("'./Factory'", "'third-party-controls'")]
])
{
    test(`factory source rejects ${label}`, () =>
    {
        const { result } = localSource(factory, content);
        assert.ok(result.errors.some((error) => error.reason === 'unknown-component-source'), JSON.stringify(result.errors));
        assert.equal(result.nodes.find((node) => node.tag === 'Leaf').origin.kind, 'unknown');
    });
}

for (const [label, content] of [
    ['opaque initializer', factory.replace('const name =', 'const opaque = arbitrary(); const name =')],
    ['mutable function', factory.replace('export const construct', 'export let construct')],
    ['async factory', factory.replace('(scope: string) =>', 'async (scope: string) =>')],
    ['reassigned function', factory + 'construct = replacement;'],
    ['branch return', factory.replace('return {leaf:', 'if (state) return {}; return {leaf:')],
    ['computed result key', factory.replace('{leaf: Item}', '{[key]: Item}')],
    ['unknown result spread', factory.replace('{leaf: Item}', '{leaf: Item, ...unknown}')],
    ['duplicate result key', factory.replace('{leaf: Item}', '{leaf: Item, leaf: Other}')],
    ['unknown result value', factory.replace('{leaf: Item}', '{leaf: missing}')],
    ['non-Vue constructor', factory.replace("from 'vue'", "from 'fake-vue'")],
    ['shadowed Vue import', factory.replace('export const construct', 'const define = missing; export const construct')],
    ['reassigned Vue import', factory + 'define = replacement;'],
    ['dynamic component options', factory.replace('define({name,', 'define({...options, name,')],
    ['render override', factory.replace('inheritAttrs: false,', 'inheritAttrs: false, render: arbitrary,')],
    ['automatic attrs fallthrough', factory.replace('inheritAttrs: false', 'inheritAttrs: true')],
    ['unknown component name', factory.replace('const name = `Scope${scope}`;', 'const name = state;')],
    ['unknown render call', factory.replace('slots.default?.()', 'arbitrary()')],
    ['rendered DOM', factory.replace('slots.default?.()', 'define("button")')],
    ['slot argument substitution', factory.replace('slots.default?.()', 'slots.default?.(state)')],
    ['slot binding shadow', factory.replace('return () => slots', 'const slots = arbitrary(); return () => slots')],
    ['slot escape', factory.replace('return () => slots', 'arbitrary(slots); return () => slots')],
    ['async setup', factory.replace('setup(_,', 'async setup(_,')],
    ['async render', factory.replace('return () =>', 'return async () =>')]
])
{
    test(`factory construction rejects ${label}`, () =>
    {
        const { result } = localSource(content);
        assert.ok(result.errors.some((error) => error.reason === 'unknown-component-source'), JSON.stringify(result.errors));
        assert.equal(result.nodes.find((node) => node.tag === 'Leaf').origin.kind, 'unknown');
    });
}

test('factory source drift during the same scan remains a graph error', () =>
{
    const { file, entry, source, result } = localSource();
    assert.deepEqual(result.errors, []);
    writeFileSync(file, factory.replace('slots.default?.()', 'arbitrary()'));
    const changed = source.graph([entry]);
    assert.equal(changed.errors.filter((error) => error.path === file && error.reason === 'parsed-source-changed-during-scan').length, 1);
});
