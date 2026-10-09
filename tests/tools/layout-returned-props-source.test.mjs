import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `returned-props-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(text, name)
{
    const file = resolve(directory, name);
    writeFileSync(file, text);
    return file;
}
function source()
{
    return createCompositionSource({ repositoryRoot, fsusUIRoot });
}
function local(helper, extra = '', template = '<component v-if="selected" :is="selected"/>')
{
    fixture(`import {computed} from 'vue';export function select(props,state){${helper}}`, 'selector.ts');
    fixture(`<script setup>import {select} from './selector';const props=defineProps({glyph:{type:[Object,Function]},state:Boolean});${extra}const {current:selected}=select(props,props.state);</script><template>${template}</template>`, 'Owner.vue');
    return source().graph([fixture(`<script setup>import Owner from './Owner.vue';import {Check} from '@ozwasyd/element-plus/icons-vue';</script><template><Owner :glyph="Check"/></template>`, 'Entry.vue')]);
}

test('actual Select returned computed member binds suffixIcon through the actual props argument and exposure', () =>
{
    const graph = source().graph([fixture(`<script setup>import {ElSelect} from '@ozwasyd/element-plus';</script><template><ElSelect/></template>`, 'Entry.vue')]);
    const selector = graph.nodes.find((node) => node.file.endsWith('/select/src/select.vue') && node.line === 228);
    assert.equal(selector.origin.kind, 'component-prop');
    assert.equal(selector.origin.property, 'suffixIcon');
    assert.equal(selector.origin.selectorSource.name, 'iconComponent');
    assert.equal(selector.origin.selectorSource.emptyBranches, 1);
    const binding = graph.componentPropBindings.find((binding) => binding.sourceNode === selector.id);
    assert.ok(binding.definition.endsWith('/icons-vue/src/components/arrow-down.vue'));
    assert.ok(graph.errors.every((error) => error.file !== selector.file || error.offset !== selector.offset));
});

test('returned prop selector follows both finite branches without choosing product state', () =>
{
    const graph = local(`const current=computed(()=>state ? '' : props.glyph);return {current};`);
    assert.deepEqual(graph.errors, []);
    const selector = graph.nodes.find((node) => node.origin.selectorSource);
    assert.equal(selector.origin.selectorSource.emptyBranches, 1);
    assert.ok(selector.origin.selectorSource.steps.some((step) => step.file.endsWith('/selector.ts')));
});

test('an absent returned prop requires the exact proven selector guard', () =>
{
    fixture(`import {computed} from 'vue';export function select(props){const current=computed(()=>condition ? null : props.glyph);return {current};}`, 'selector.ts');
    fixture(`<script setup>import {select} from './selector';const props=defineProps({glyph:Object});const {current:selected}=select(props);</script><template><component v-if="selected" :is="selected"/></template>`, 'Owner.vue');
    const result = source().graph([fixture(`<script setup>import Owner from './Owner.vue';</script><template><Owner/></template>`, 'Entry.vue')]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.componentPropBindings[0].absent, true);
});

for (const [label, helper, extra, template] of [
    ['unknown selector branch', `const current=computed(()=>state ? unknown : props.glyph);return {current};`, '', ''],
    ['mutable returned member', `let current=computed(()=>props.glyph);return {current};`, '', ''],
    ['mutated returned member', `const current=computed(()=>props.glyph);current.value=unknown;return {current};`, '', ''],
    ['escaped returned member', `const current=computed(()=>props.glyph);foreign(current);return {current};`, '', ''],
    ['mutated helper props', `props.glyph=unknown;const current=computed(()=>props.glyph);return {current};`, '', ''],
    ['escaped helper props', `foreign(props);const current=computed(()=>props.glyph);return {current};`, '', ''],
    ['mutated caller props', `const current=computed(()=>props.glyph);return {current};`, 'props.glyph=unknown;', ''],
    ['escaped caller props', `const current=computed(()=>props.glyph);return {current};`, 'foreign(props);', ''],
    ['unknown earlier return', `if(state)return unknown;const current=computed(()=>props.glyph);return {current};`, '', ''],
    ['unknown object spread', `const current=computed(()=>props.glyph);return {...unknown,current};`, '', ''],
    ['getter result', `const current=computed(()=>props.glyph);return {get current(){return current;}};`, '', ''],
    ['undeclared prop', `const current=computed(()=>props.other);return {current};`, '', ''],
    ['empty-only result', `const current=computed(()=>state ? '' : null);return {current};`, '', ''],
    ['template shadow', `const current=computed(()=>props.glyph);return {current};`, '', '<component v-for="selected in list" :is="selected"/>']
])
{
    test(`returned prop selector rejects ${label}`, () =>
    {
        assert.ok(local(helper, extra, template || undefined).errors.length > 0, label);
    });
}

function ordinary(exposed, argument = 'props')
{
    fixture(`import {computed} from 'vue';export function select(props,state){const current=computed(()=>state ? '' : props.glyph);return {current};}`, 'selector.ts');
    fixture(`<script>import {defineComponent} from 'vue';import {select} from './selector';export default defineComponent({props:{glyph:Object,state:Boolean},setup(props){const {current:selected}=select(${argument},props.state);return {selected:${exposed}};}});</script><template><component v-if="selected" :is="selected"/></template>`, 'Owner.vue');
    return source().graph([fixture(`<script setup>import Owner from './Owner.vue';import {Check} from '@ozwasyd/element-plus/icons-vue';</script><template><Owner :glyph="Check"/></template>`, 'Entry.vue')]);
}

test('ordinary Vue setup must expose the same actual returned selector binding', () =>
{
    assert.deepEqual(ordinary('selected').errors, []);
});

test('ordinary Vue setup cannot lend a hidden member identity to another exposed value', () =>
{
    assert.ok(ordinary('unknown').errors.length > 0);
});

test('returned selector rejects a props argument without its actual Vue binding', () =>
{
    assert.ok(ordinary('selected', 'unknown').errors.length > 0);
});

test('returned selector rejects a destructuring default rather than assuming its source', () =>
{
    fixture(`import {computed} from 'vue';export function select(props){const current=computed(()=>props.glyph);return {current};}`, 'selector.ts');
    fixture(`<script setup>import {select} from './selector';const props=defineProps({glyph:Object});const {current:selected=unknown}=select(props);</script><template><component :is="selected"/></template>`, 'Owner.vue');
    const graph = source().graph([fixture(`<script setup>import Owner from './Owner.vue';</script><template><Owner/></template>`, 'Entry.vue')]);
    assert.ok(graph.errors.length > 0);
});
