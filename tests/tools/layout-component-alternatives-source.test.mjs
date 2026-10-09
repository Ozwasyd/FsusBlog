import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { matchCompositionComponentProp } from '@fsusblog/layout-governance/composition-dom';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `component-alternatives-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(text, name = 'Entry.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, text);
    return file;
}
function source()
{
    return createCompositionSource({ repositoryRoot, fsusUIRoot });
}
function alternatives(guard = 'a || b', supplied = '', script = '')
{
    fixture(`<script setup>const props=defineProps({a:{type:[Object,Function]},b:{type:[Object,Function]}});</script><template><span v-if="${guard}"><component :is="checked ? a : b"/></span></template>`, 'Owner.vue');
    const entry = fixture(`<script setup>import Owner from './Owner.vue'; ${script}</script><template><Owner ${supplied}/></template>`);
    return source().graph([entry]);
}

test('two absent component alternatives require both real inputs and their exact disjunction guard', () =>
{
    const result = alternatives();
    assert.deepEqual(result.errors, []);
    const selector = result.nodes.find((node) => node.origin.kind === 'component-prop-variants');
    const binding = result.componentPropBindings.find((entry) => entry.sourceNode === selector.id);
    assert.equal(binding.absent, true);
    assert.deepEqual(binding.absenceGuard.properties, ['a','b']);
    assert.equal(matchCompositionComponentProp(result, selector, binding.callPath.map((sourceCall) => ({sourceCall}))), binding);
    assert.equal(matchCompositionComponentProp(result, selector, []), null);
});

test('a missing prop uses only its actual imported fallback and a supplied value retains its actual source', () =>
{
    fixture(`<script setup>import {Close as Fallback} from '@ozwasyd/element-plus/icons-vue'; const props=defineProps({icon:{type:[Object,Function]}});</script><template><component :is="icon || Fallback"/></template>`, 'Owner.vue');
    const entry = fixture(`<script setup>import Owner from './Owner.vue'; import {Check as Actual} from '@ozwasyd/element-plus/icons-vue';</script><template><Owner/><Owner :icon="Actual"/></template>`);
    const result = source().graph([entry]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.componentPropBindings.map((binding) => binding.target.publicName), ['Close','Check']);
    assert.ok(result.componentPropBindings.every((binding) => !binding.absent && binding.definition));
});

test('actual dialog Close fallback binds after its real motion spread excludes the declared prop', () =>
{
    const entry = fixture(`<script setup>import {ElDialog} from '@ozwasyd/element-plus';</script><template><ElDialog/></template>`);
    const result = source().graph([entry]);
    const selector = result.nodes.find((node) => node.file.endsWith('/dialog-content/src/dialog-content.vue') && node.tag === 'component')
        ?? result.nodes.find((node) => node.file.endsWith('/dialog/src/dialog-content.vue') && node.tag === 'component');
    assert.equal(selector.origin.kind, 'component-prop');
    assert.equal(selector.origin.fallbackSource.memberSource.property, 'Close');
    const binding = result.componentPropBindings.find((binding) => binding.sourceNode === selector.id);
    assert.ok(binding.definition.endsWith('/icons-vue/src/components/close.vue'));
    assert.equal(binding.absent, false);
    assert.ok(result.errors.every((error) => error.file !== selector.file || error.offset !== selector.offset));
    assert.ok(result.objectKeyAbsenceProofs.some((proof) => proof.property === 'closeIcon'
        && proof.steps.some((step) => step.file.endsWith('/components/motion.ts'))));
    assert.equal(selector.origin.fallbackSource.kind, 'local');
    assert.ok(selector.origin.fallbackSource.file.endsWith('/icons-vue/src/components/close.vue'));
});

test('an actual declared attrs spread excludes the named component input', () =>
{
    fixture(`<script setup>import {Close} from '@ozwasyd/element-plus/icons-vue'; const props=defineProps({icon:{type:[Object,Function]}});</script><template><component :is="icon || Close"/></template>`, 'Owner.vue');
    fixture(`<script setup>import Owner from './Owner.vue'; const props=defineProps({icon:{type:[Object,Function]}});</script><template><Owner v-bind="$attrs" :icon="icon"/></template>`, 'Forward.vue');
    const graph = source().graph([fixture(`<script setup>import Forward from './Forward.vue';</script><template><Forward/></template>`)]);
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.componentPropBindings[0].target.publicName, 'Close');
});

test('an unknown spread beside an explicit component input remains rejected', () =>
{
    fixture(`<script setup>const props=defineProps({icon:{type:[Object,Function]}});</script><template><component v-if="icon" :is="icon"/></template>`, 'Owner.vue');
    const graph = source().graph([fixture(`<script setup>import Owner from './Owner.vue'; import {Close} from '@ozwasyd/element-plus/icons-vue';</script><template><Owner v-bind="unknown" :icon="Close"/></template>`)]);
    assert.ok(graph.errors.some((error) => error.reason === 'unbound-component-prop-source'));
    assert.equal(graph.componentPropBindings.length, 0);
});

test('closed immutable prop spreads inherit the actual component declaration and unknown overrides fail', () =>
{
    const owner = fixture(`<script setup>import {Close as Fallback} from '@ozwasyd/element-plus/icons-vue'; const inherited={icon:{type:[Object,Function]}}; const props=defineProps({...inherited});</script><template><component :is="icon || Fallback"/></template>`, 'Owner.vue');
    const entry = fixture(`<script setup>import Owner from './Owner.vue';</script><template><Owner/></template>`);
    assert.deepEqual(source().graph([entry]).errors, []);
    writeFileSync(owner, `<script setup>import {Close as Fallback} from '@ozwasyd/element-plus/icons-vue'; const inherited={icon:{type:[Object,Function]}}; const props=defineProps({...inherited,...unknown});</script><template><component :is="icon || Fallback"/></template>`);
    assert.ok(source().graph([entry]).errors.length > 0);
});

for (const [label, guard, supplied, script] of [
    ['unknown supplied alternative', 'a || b', ':a="unknown"', ''],
    ['only one missing alternative', 'a || b', ':a="Actual"', `import {Check as Actual} from '@ozwasyd/element-plus/icons-vue';`],
    ['unrelated disjunction', 'a || state', '', ''],
    ['negated guard', '!a || !b', '', ''],
    ['unguarded alternative', 'state', '', ''],
    ['duplicate guard input', 'a || a', '', '']
])
{
    test(`component alternatives reject ${label}`, () =>
    {
        assert.ok(alternatives(guard, supplied, script).errors.length > 0, label);
    });
}
for (const [label, script] of [
    ['unknown fallback', `const props=defineProps({icon:{type:[Object,Function]}});`],
    ['mutable destructuring', `import {Close as Actual} from '@ozwasyd/element-plus/icons-vue'; const object={Actual}; let {Actual: Fallback}=object; const props=defineProps({icon:{type:[Object,Function]}});`],
    ['destructuring default', `import {Close as Actual} from '@ozwasyd/element-plus/icons-vue'; const object={Actual}; const {Actual: Fallback=other}=object; const props=defineProps({icon:{type:[Object,Function]}});`],
    ['mutated field import', `import {Close as Actual} from '@ozwasyd/element-plus/icons-vue'; Actual=other; const object={Actual}; const {Actual: Fallback}=object; const props=defineProps({icon:{type:[Object,Function]}});`]
])
{
    test(`component fallback rejects ${label}`, () =>
    {
        const owner = fixture(`<script setup>${script}</script><template><component :is="icon || Fallback"/></template>`, 'Owner.vue');
        assert.ok(source().graph([owner]).errors.length > 0, label);
    });
}
