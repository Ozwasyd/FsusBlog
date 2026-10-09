import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `component-member-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
const imports = `import {computed} from 'vue'; import {Check as Glyph} from '@ozwasyd/element-plus/icons-vue';`;
function fixture(text, name = 'Entry.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, text);
    return file;
}
function graph(script)
{
    const file = fixture(`<script setup>${script}</script><template><component :is="provider.editor"/></template>`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
}
const identity = `function identity(value, label){if((typeof value==='object'&&value!==null)||typeof value==='function'){return value;}throw new TypeError(label);}`;

test('actual Markdown provider binds editor initialization through its imported getter and unchanged identity guard', () =>
{
    const entry = resolve(repositoryRoot, 'src/frontend/src/components/ui/MarkdownEditorAdapter.vue');
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([entry]);
    const editor = result.nodes.find((node) => node.file === entry && node.tag === 'component');
    assert.equal(editor.origin.kind, 'local');
    assert.ok(editor.definition.endsWith('/MarkdownTextEditor.vue'));
    assert.equal(editor.origin.memberSource.property, 'editorComponent');
    assert.ok(editor.origin.memberSource.steps.some((step) => step.file.endsWith('/markdownEditorProvider.ts') && step.offset !== null));
    assert.ok(editor.origin.identityFunction.file.endsWith('/markdownEditorProvider.ts'));
    assert.ok(result.nodes.some((node) => node.file === editor.definition && node.tag === 'ElMarkdownEditor' && node.origin.kind === 'fsusui-public'));
    assert.ok(result.errors.every((error) => error.file !== entry || error.offset !== editor.offset));
});

test('computed object member follows closed field and renamed identity helper without public-name assumptions', () =>
{
    const result = graph(imports + identity + `const selected={editor:identity(Glyph,'diagnostic')}; function getObject(){return selected;} const provider=computed(() => getObject());`);
    assert.deepEqual(result.errors, []);
    const call = result.nodes.find((node) => node.tag === 'component');
    assert.equal(call.origin.kind, 'fsusui-public');
    assert.equal(call.origin.publicName, 'Check');
    assert.ok(call.origin.identityFunction.digest);
    const selector = call.origin.memberSource.steps.find((step) => step.kind === 'selector-expression');
    assert.equal(selector.offset, null);
    assert.ok(call.origin.memberSource.steps.filter((step) => step.kind === 'script-source').every((step) => step.offset > 0));
});

test('imported object getter and component keep their actual local ownership', () =>
{
    fixture('<template><div/></template>', 'Local.vue');
    fixture(`import Local from './Local.vue'; const object={editor:Local}; export function renamed(){return object;}`, 'Provider.ts');
    const result = graph(`import {computed} from 'vue'; import {renamed} from './Provider.ts'; const provider=computed(() => renamed());`);
    assert.deepEqual(result.errors, []);
    assert.equal(result.nodes.find((node) => node.tag === 'component').origin.kind, 'local');
});

test('computed member unwrapping is limited to the actual Vue template input path', () =>
{
    const file = fixture(`<script setup>${imports} const provider=computed(() => ({editor:Glyph}));</script><template><div/></template>`);
    const s = createCompositionSource({ repositoryRoot, fsusUIRoot });
    const expr = s.expression('provider.editor', file);
    assert.throws(() => s.resolver.resolveExpression(file, expr), /template ref unwrapping/);
    assert.throws(() => s.resolver.resolveComponentInput(file, expr), /template ref unwrapping/);
    assert.equal(s.resolver.resolveComponentInput(file, expr, {templateRefs:true})[0].kind, 'fsusui-public');
});

for (const [label, script] of [
    ['mutated direct member import', imports + 'Glyph=other; const provider={editor:Glyph};'],
    ['nested computed member value', imports + 'const provider={editor:computed(() => Glyph)};'],
    ['object constructor escape', imports + 'const provider={editor:Glyph}; new Other(provider);'],
    ['object alias mutation', imports + 'const provider={editor:Glyph}; const copied=provider; copied.editor=other;'],
    ['identity constructor escape', imports + 'function identity(value,label){if(new Other(value))return value;throw other;} const provider={editor:identity(Glyph,"name")};'],
    ['unknown object method', imports + 'const provider={editor:Glyph,change:other}; provider.change();'],
    ['unknown identity argument method', imports + 'function identity(value,label){if(value.change())return value;throw other;} const provider={editor:identity(Glyph,"name")};'],
    ['unknown member value', imports + 'const provider={editor:unknown};'],
    ['unknown object initializer', imports + 'const provider=unknown;'],
    ['missing member', imports + 'const provider={other:Glyph};'],
    ['mutable object', imports + 'let provider={editor:Glyph};'],
    ['mutated member', imports + 'const provider={editor:Glyph}; provider.editor=other;'],
    ['escaped object', imports + 'const provider={editor:Glyph}; other(provider);'],
    ['escaped computed object', imports + 'const provider=computed(() => ({editor:Glyph})); other(provider.value);'],
    ['unknown object spread', imports + 'const provider={...other,editor:Glyph};'],
    ['computed object key', imports + 'const provider={[key]:Glyph};'],
    ['duplicate object key', imports + 'const provider={editor:Glyph,editor:unknown};'],
    ['getter member', imports + 'const provider={get editor(){return Glyph;}};'],
    ['prototype member', imports + 'const provider={__proto__:{editor:Glyph}};'],
    ['dynamic function', imports + 'const provider=computed(() => unknown());'],
    ['getter arguments', imports + 'function getObject(value){return {editor:Glyph};} const provider=computed(() => getObject(input));'],
    ['getter branch', imports + 'function getObject(){if(state)return {editor:Glyph};return unknown;} const provider=computed(() => getObject());'],
    ['getter side effect', imports + 'function getObject(){other();return {editor:Glyph};} const provider=computed(() => getObject());'],
    ['async getter', imports + 'async function getObject(){return {editor:Glyph};} const provider=computed(() => getObject());'],
    ['mutated getter', imports + 'function getObject(){return {editor:Glyph};} getObject=other; const provider=computed(() => getObject());'],
    ['computed parameters', imports + 'const provider=computed((value) => ({editor:Glyph}));'],
    ['computed block', imports + 'const provider=computed(() => {return {editor:Glyph};});'],
    ['async computed', imports + 'const provider=computed(async () => ({editor:Glyph}));'],
    ['mutable computed', imports + 'let provider=computed(() => ({editor:Glyph}));'],
    ['identity changed return', imports + 'function identity(value,label){return unknown;} const provider={editor:identity(Glyph,"name")};'],
    ['identity fallthrough', imports + 'function identity(value,label){if(state)return value;} const provider={editor:identity(Glyph,"name")};'],
    ['identity mutated parameter', imports + 'function identity(value,label){if((value=other))return value;throw other;} const provider={editor:identity(Glyph,"name")};'],
    ['identity escaped parameter', imports + 'function identity(value,label){if(other(value))return value;throw other;} const provider={editor:identity(Glyph,"name")};'],
    ['identity dynamic auxiliary argument', imports + identity + 'const provider={editor:identity(Glyph,unknown())};'],
    ['identity string name', imports + identity + 'const provider={editor:identity("Check","name")};'],
    ['mutated identity component import', imports + identity + 'Glyph=other; const provider={editor:identity(Glyph,"name")};']
])
{
    test(`component member source rejects ${label}`, () =>
    {
        assert.ok(graph(script).errors.length > 0, label);
    });
}
