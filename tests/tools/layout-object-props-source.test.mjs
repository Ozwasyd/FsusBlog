import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { matchCompositionComponentProp, matchCompositionNativeProp } from '@fsusblog/layout-governance/composition-dom';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `object-props-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(text, name = 'Entry.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, text);
    return file;
}
function graph(entry)
{
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([entry]);
}
function buttons(result)
{
    return result.nodes.filter((node) => node.file.endsWith('/button/src/button.vue') && ['native-prop','component-prop'].includes(node.origin.kind));
}
function relevantErrors(result)
{
    return result.errors.filter((error) => error.file.endsWith('/button/src/button.vue') && [2,30,34].includes(error.line));
}
function dropdown(supplied = '', script = '')
{
    return graph(fixture(`<script setup>import {ElDropdown} from '@ozwasyd/element-plus';import {Check} from '@ozwasyd/element-plus/icons-vue';${script}</script><template><ElDropdown ${supplied}/></template>`));
}

test('actual Dropdown missing buttonProps binds both real Button native tags loading defaults and absent icons', () =>
{
    const result = dropdown();
    assert.deepEqual(relevantErrors(result), []);
    const sources = buttons(result);
    assert.equal(sources.length, 3);
    const natives = result.nativePropBindings.filter((binding) => sources.some((source) => source.id === binding.sourceNode));
    assert.equal(natives.length, 2);
    assert.ok(natives.every((binding) => binding.tag === 'button' && binding.callPath.length === 2));
    const component = result.componentPropBindings.filter((binding) => sources.some((source) => source.id === binding.sourceNode));
    assert.equal(component.length, 4);
    assert.equal(component.filter((binding) => binding.absent).length, 2);
    assert.ok(component.filter((binding) => !binding.absent).every((binding) => binding.definition.endsWith('/loading.vue')));
});

test('actual Dropdown supplied literal object preserves exact imported icon and native tag input', () =>
{
    const result = dropdown(`:button-props="{tag:'section',icon:Check,loadingIcon:Check}"`);
    assert.deepEqual(relevantErrors(result), []);
    assert.ok(result.nativePropBindings.filter((binding) => buttons(result).some((source) => source.id === binding.sourceNode)).every((binding) => binding.tag === 'section'));
    assert.ok(result.componentPropBindings.filter((binding) => buttons(result).some((source) => source.id === binding.sourceNode)).every((binding) => binding.definition.endsWith('/check.vue')));
});

test('null and unshadowed undefined object inputs use only the actual nullish fallback', () =>
{
    assert.deepEqual(relevantErrors(dropdown(':button-props="null"')), []);
    assert.deepEqual(relevantErrors(dropdown(':button-props="undefined"')), []);
});

test('nested object prop forwarding keeps the complete ordered actual call path', () =>
{
    fixture(`<script setup>import {ElDropdown} from '@ozwasyd/element-plus';const props=defineProps({buttonProps:Object});</script><template><ElDropdown :button-props="props.buttonProps"/></template>`, 'Forward.vue');
    const result = graph(fixture(`<script setup>import Forward from './Forward.vue';</script><template><Forward/></template>`));
    assert.deepEqual(relevantErrors(result), []);
    const source = buttons(result).find((source) => source.origin.kind === 'native-prop');
    const binding = result.nativePropBindings.find((binding) => binding.sourceNode === source.id);
    assert.equal(binding.callPath.length, 3);
    const ancestors = binding.callPath.map((sourceCall) => ({sourceCall}));
    assert.equal(matchCompositionNativeProp(result, source, ancestors), binding);
    assert.equal(matchCompositionNativeProp(result, source, ancestors.slice(0, 2)), null);
    assert.equal(matchCompositionNativeProp(result, source, [...ancestors].reverse()), null);
    const componentSource = buttons(result).find((source) => source.origin.kind === 'component-prop');
    const componentBinding = result.componentPropBindings.find((binding) => binding.sourceNode === componentSource.id);
    assert.equal(matchCompositionComponentProp(result, componentSource, componentBinding.callPath.map((sourceCall) => ({sourceCall}))), componentBinding);
});

test('native object prop proof rejects changed caller inputs and forged legacy digest', () =>
{
    const result = dropdown();
    const source = buttons(result).find((source) => source.origin.kind === 'native-prop');
    const binding = result.nativePropBindings.find((binding) => binding.sourceNode === source.id);
    const ancestors = binding.callPath.map((sourceCall) => ({sourceCall}));
    const changed = structuredClone(result);
    changed.nodes.find((node) => node.id === binding.callPath[1]).attributes.buttonProps = 'changed';
    assert.equal(matchCompositionNativeProp(changed, source, ancestors), null);
    const forged = structuredClone(result);
    forged.nativePropBindings.find((entry) => entry.callNode === binding.callNode).inputDigest = 'forged';
    assert.equal(matchCompositionNativeProp(forged, source, ancestors), null);
});

for (const [label, supplied, script] of [
    ['unknown object', ':button-props="unknown"', ''],
    ['unknown field', ':button-props="{icon:unknown}"', ''],
    ['unknown spread', ':button-props="{...unknown}"', ''],
    ['mutable object', ':button-props="config"', 'let config={icon:Check};'],
    ['mutated object', ':button-props="config"', 'const config={icon:Check};config.icon=unknown;'],
    ['escaped object', ':button-props="config"', 'const config={icon:Check};other(config);'],
    ['aliased object', ':button-props="config"', 'const config={icon:Check};const alias=config;alias.tag=unknown;'],
    ['computed key', ':button-props="{[key]:Check}"', ''],
    ['getter field', ':button-props="config"', 'const config={get icon(){return Check;}};'],
    ['unknown native tag', ':button-props="{tag:unknown}"', ''],
    ['shadowed undefined', ':button-props="undefined"', 'const undefined=unknown;'],
    ['template shadow', 'v-for="config in list" :button-props="config"', 'const config={icon:Check};const list=[];']
])
{
    test(`object prop input rejects ${label}`, () =>
    {
        assert.ok(relevantErrors(dropdown(supplied, script)).length > 0, label);
    });
}

function wrapped(extra)
{
    fixture(`<script setup>import {computed,toRef} from 'vue';import {ElButton} from '@ozwasyd/element-plus';const props=defineProps({inputs:Object,motion:String});${extra}const attrs=computed(()=>({...props.inputs??{}}));</script><template><ElButton v-bind="attrs"/></template>`, 'Owner.vue');
    return graph(fixture(`<script setup>import Owner from './Owner.vue';</script><template><Owner/></template>`));
}

test('an actual unrelated Vue toRef preserves the selected object prop source', () =>
{
    const result = wrapped(`const motion=toRef(props,'motion');`);
    assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
    assert.ok(result.errors.every((error) => error.reason === 'unbound-slot-source'
        && error.file.endsWith('/icon/src/icon.vue')));
    assert.equal(new Set(result.errors.map((error) => error.callNode)).size, 2);
    assert.deepEqual(relevantErrors(result), []);
});

for (const [label, extra] of [
    ['owner mutation', 'props.inputs=unknown;'],
    ['owner escape', 'foreign(props);'],
    ['selected ref escape', `const selected=toRef(props,'inputs');selected.value=unknown;`]
])
{
    test(`object prop input rejects ${label}`, () =>
    {
        assert.ok(relevantErrors(wrapped(extra)).length > 0, label);
    });
}
