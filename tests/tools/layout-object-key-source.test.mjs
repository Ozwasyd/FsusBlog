import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `object-key-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(script, name = 'Owner.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, `<script setup>${script}</script><template><div/></template>`);
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    return { file, source, proof: (input = 'shape', options = {}) => source.resolver.resolveObjectKeyAbsence(file,
        source.expression(input, file), 'icon', options) };
}

test('actual motion object ref proves excluded keys through both real imported helper returns', () =>
{
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    const file = resolve(fsusUIRoot, 'vue/packages/components/dialog/src/dialog.vue');
    const result = source.resolver.resolveObjectKeyAbsence(file, source.expression('componentMotionAttrs.value', file), 'closeIcon');
    assert.equal(result.absent, true);
    assert.ok(result.steps.some((step) => step.file.endsWith('/components/motion.ts')));
    assert.ok(result.steps.every((step) => step.digest && (step.offset === null || step.offset >= 0)));
});

test('parameterized shape proof follows every closed branch without resolving or admitting its values', () =>
{
    const { proof } = fixture(`function attributes(input){return input ? {title:unknown} : {'aria-label':other};} const shape=attributes(productState);`);
    assert.equal(proof().absent, true);
});

test('object key absence follows actual closed immutable spreads and an imported function', () =>
{
    writeFileSync(resolve(directory, 'attributes.ts'), `export const attributes=(input)=>{const opaque=foreign(input);return {title:opaque};};`);
    const { proof } = fixture(`import {attributes} from './attributes'; const first={id:unknown}; const shape={...first,...attributes(productState)};`);
    const result = proof();
    assert.ok(result.steps.some((step) => step.file.endsWith('/attributes.ts')));
});

test('object ref proof requires one explicit value read or actual template unwrapping', () =>
{
    const { proof } = fixture(`import {computed} from 'vue'; const shape=computed(()=>({title:unknown}));`);
    assert.throws(() => proof());
    assert.equal(proof('shape.value').absent, true);
    assert.equal(proof('shape', {templateRefs:true}).absent, true);
});

test('actual useAttrs excludes only the component prop declared by the same source', () =>
{
    const { file, source, proof } = fixture(`import {useAttrs} from 'vue';const props=defineProps({icon:{type:Object}});const shape=useAttrs();`);
    assert.equal(proof().absent, true);
    assert.throws(() => source.resolver.resolveObjectKeyAbsence(file, source.expression('shape', file), 'undeclared'));
});

for (const [label, script, input] of [
    ['private consumer import', `import {useComponentMotionAttrs} from '@element-plus/components/motion';const shape=useComponentMotionAttrs(other);`, 'shape.value'],
    ['unknown factory', 'const shape=opaque();', 'shape'],
    ['mutable object', 'let shape={title:unknown};', 'shape'],
    ['mutated object', 'const shape={title:unknown};shape.icon=other;', 'shape'],
    ['escaped object', 'const shape={title:unknown};foreign(shape);', 'shape'],
    ['aliased object', 'const shape={title:unknown};const alias=shape;alias.icon=other;', 'shape'],
    ['unknown method', 'const shape={title:unknown};shape.change();', 'shape'],
    ['computed key', 'const shape={[key]:unknown};', 'shape'],
    ['getter', 'const shape={get title(){return unknown;}};', 'shape'],
    ['prototype key', 'const shape={__proto__:other};', 'shape'],
    ['unknown spread', 'const shape={title:unknown,...other};', 'shape'],
    ['requested key', 'const shape={icon:unknown};', 'shape'],
    ['input determined shape', 'function attributes(input){return input;}const shape=attributes(other);', 'shape'],
    ['async shape function', 'async function attributes(){return {title:unknown};}const shape=attributes();', 'shape'],
    ['unknown return branch', 'function attributes(input){return input ? {title:unknown} : other;}const shape=attributes(state);', 'shape'],
    ['constructor', 'const shape=new Attributes();', 'shape'],
    ['nested ref read', `import {computed} from 'vue';const shape=computed(()=>({title:unknown}));`, 'shape.value.value']
])
{
    test(`object key absence rejects ${label}`, () =>
    {
        assert.throws(() => fixture(script).proof(input), label);
    });
}
for (const [label, extra] of [
    ['mutation', 'shape.icon=other;'],
    ['escape', 'foreign(shape);'],
    ['shadowed Vue import', 'function shadow(useAttrs){return useAttrs();}']
])
{
    test(`declared attrs exclusion rejects ${label}`, () =>
    {
        assert.throws(() => fixture(`import {useAttrs} from 'vue';const props=defineProps({icon:Object});const shape=useAttrs();${extra}`).proof(), label);
    });
}
