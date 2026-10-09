import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `finite-component-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function graph(script, template = '<component :is="choice"/>')
{
    const file = resolve(directory, 'Entry.vue');
    writeFileSync(file, `<script setup>${script}</script><template>${template}</template>`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
}
const imports = `import {computed} from 'vue'; import {Check as A, Close as B} from '@ozwasyd/element-plus/icons-vue';`;

test('actual Progress and Input selectors retain all five and two imported source definitions', () =>
{
    const result = graph(`import {ElProgress, ElInput} from '@ozwasyd/element-plus';`, '<ElProgress/><ElInput/>');
    const progress = result.nodes.find((node) => node.file.endsWith('/progress/src/progress.vue') && node.tag === 'component');
    const password = result.nodes.find((node) => node.file.endsWith('/input/src/input.vue') && node.offset === 2497);
    assert.equal(progress.origin.kind, 'component-variants');
    assert.equal(progress.definitions.length, 5);
    assert.equal(password.origin.kind, 'component-variants');
    assert.equal(password.definitions.length, 2);
    for (const node of [progress, password])
    {
        assert.equal(node.definition, null);
        assert.equal(node.origin.selectorDigest, controlDigest(node.origin.selectorExpression));
        assert.ok(node.definitions.every((file) => result.nodes.some((child) => child.file === file && child.tag === 'svg')));
        assert.ok(result.errors.every((error) => error.file !== node.file || error.offset !== node.offset));
    }
    assert.ok(result.errors.some((error) => error.message?.includes('ValidateComponentsMap')));
});

test('finite computed block keeps each return and never selects a branch from product state', () =>
{
    const result = graph(imports + `const choice=computed(() => {if(state)return A; if(other){return B;} else {return A;}});`);
    assert.deepEqual(result.errors, []);
    const selector = result.nodes.find((node) => node.tag === 'component');
    assert.equal(selector.origin.kind, 'component-variants');
    assert.equal(selector.definitions.length, 2);
    assert.ok(selector.origin.variants.every((origin) => origin.kind === 'fsusui-public'));
    assert.ok(result.nodes.filter((node) => node.tag === 'svg').length === 2);
});

test('finite local component alternatives retain local ownership through public parent-free calls', () =>
{
    writeFileSync(resolve(directory, 'Local.vue'), '<template><div/></template>');
    const result = graph(`import {computed} from 'vue'; import A from './Local.vue'; import {Check as B} from '@ozwasyd/element-plus/icons-vue'; const choice=computed(() => state ? A : B);`);
    assert.deepEqual(result.errors, []);
    const selector = result.nodes.find((node) => node.tag === 'component');
    assert.deepEqual(selector.origin.variants.map((origin) => origin.kind), ['local', 'fsusui-public']);
    assert.ok(result.nodes.some((node) => node.file.endsWith('/Local.vue') && node.origin.kind === 'native'));
});

for (const [label, script] of [
    ['mutable selector', imports + 'let choice=computed(() => A);'],
    ['mutated selector', imports + 'const choice=computed(() => A); choice.value=B;'],
    ['unknown branch', imports + 'const choice=computed(() => state ? A : unknown);'],
    ['unknown block return', imports + 'const choice=computed(() => {if(state)return A; return unknown;});'],
    ['fallthrough', imports + 'const choice=computed(() => {if(state)return A;});'],
    ['unreachable unknown return', imports + 'const choice=computed(() => {return A; return unknown;});'],
    ['async function', imports + 'const choice=computed(async () => A);'],
    ['parameter function', imports + 'const choice=computed((value) => A);'],
    ['loop flow', imports + 'const choice=computed(() => {while(state)return A; return B;});'],
    ['unknown side-effect flow', imports + 'const choice=computed(() => {other(); return A;});'],
    ['mutable returned alias', imports + 'let Alias=A; const choice=computed(() => Alias);'],
    ['reassigned returned alias', imports + 'const Alias=A; Alias=B; const choice=computed(() => Alias);'],
    ['cyclic returned alias', imports + 'const Alias=Alias; const choice=computed(() => Alias);'],
    ['shadowed import', imports + 'function other(A){} const choice=computed(() => A);'],
    ['mutated import', imports + 'A.render=other; const choice=computed(() => A);'],
    ['shadowed computed constructor', imports + 'function other(computed){} const choice=computed(() => A);'],
    ['mutated computed constructor', imports + 'computed=other; const choice=computed(() => A);'],
    ['dynamic arguments', imports + 'const choice=computed(() => A, options);']
])
{
    test(`finite component source rejects ${label}`, () =>
    {
        assert.ok(graph(script).errors.length > 0, label);
    });
}
