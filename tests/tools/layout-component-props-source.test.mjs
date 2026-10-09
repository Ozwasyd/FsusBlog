import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { matchCompositionComponentProp } from '@fsusblog/layout-governance/composition-dom';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `component-props-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
const rows = [['button/src/button.vue', 836], ['button/src/button.vue', 949], ['dropdown/src/dropdown-item-impl.vue', 603]];
function fixture(content, name = 'Entry.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
function graph(template, script = '')
{
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    const file = fixture(`<script setup>${script}</script><template>${template}</template>`);
    return source.graph([file]);
}
function exactErrors(result)
{
    return result.errors.filter((entry) => rows.some(([suffix, offset]) => entry.file?.endsWith(suffix) && entry.offset === offset));
}
const imports = 'import {ElButton, ElDropdownItem} from "@ozwasyd/element-plus"; import {Loading as Busy} from "@ozwasyd/element-plus/icons-vue";';

test('real default and absent guarded props recover only the three exact upstream rows', () =>
{
    const result = graph('<ElButton/><ElDropdownItem/>', imports);
    assert.deepEqual(exactErrors(result), []);
    const bindings = result.componentPropBindings;
    assert.equal(bindings.length, 3);
    assert.equal(bindings.filter((entry) => entry.absent).length, 2);
    const loading = bindings.find((entry) => !entry.absent);
    assert.ok(loading.definition.endsWith('/icons-vue/src/components/loading.vue'));
    assert.ok(result.nodes.some((entry) => entry.file === loading.definition && entry.tag === 'svg'));
    assert.ok(result.resolverInputs.some((entry) => entry.path.endsWith('/button/src/button.ts')));
    assert.ok(result.resolverInputs.some((entry) => entry.path.endsWith('/dropdown/src/dropdown.ts')));
    // Other unsupported factories remain visible; this is not Settings qualification.
    assert.ok(result.errors.every((entry) => !rows.some(([suffix, offset]) => entry.file?.endsWith(suffix) && entry.offset === offset)));
});

test('explicit actual public component values bind button and forwarded dropdown calls', () =>
{
    const result = graph('<ElButton :icon="Busy" :loading-icon="Busy"/><ElDropdownItem :icon="Busy"/>', imports);
    assert.deepEqual(exactErrors(result), []);
    assert.equal(result.componentPropBindings.length, 3);
    assert.ok(result.componentPropBindings.every((entry) => entry.target && !entry.absent
        && entry.definition.endsWith('/icons-vue/src/components/loading.vue')));
    const dropdown = result.componentPropBindings.find((entry) => result.nodes.find((node) => node.id === entry.sourceNode).file.endsWith('/dropdown-item-impl.vue'));
    assert.equal(dropdown.callPath.length, 2);
    assert.equal(dropdown.inputDigests.length, 2);
});

test('ordinary static and explicitly imported local sources retain actual ownership', () =>
{
    const local = fixture('<template><svg><path/></svg></template>', 'LocalGlyph.vue');
    const result = graph('<Glyph/><ElButton :icon="Glyph"/>', imports + 'import Glyph from "./LocalGlyph.vue";');
    assert.deepEqual(exactErrors(result), []);
    const binding = result.componentPropBindings.find((entry) => entry.definition === local);
    assert.equal(binding.target.kind, 'local');
    assert.ok(result.nodes.some((entry) => entry.tag === 'Glyph' && entry.origin.kind === 'local'));
});

test('ordinary declared component factory defaults follow their actual imported source', () =>
{
    fixture('<script setup>import {Loading as Busy} from "@ozwasyd/element-plus/icons-vue";const props=defineProps({glyph:{type:[Object,Function],default:()=>Busy}});</script><template><component :is="glyph"/></template>', 'DefaultOwner.vue');
    const result = graph('<Owner/>', 'import Owner from "./DefaultOwner.vue";');
    assert.deepEqual(result.errors, []);
    assert.equal(result.componentPropBindings.length, 1);
    assert.ok(result.componentPropBindings[0].definition.endsWith('/loading.vue'));
});

for (const [label, template, extra] of [
    ['unknown supplied icon', '<ElButton :icon="unknownIcon"/>', ''],
    ['unknown supplied loading default override', '<ElButton :loading-icon="unknownIcon"/>', ''],
    ['unknown forwarded dropdown input', '<ElDropdownItem :icon="unknownIcon"/>', ''],
    ['mutable supplied component', '<ElButton :icon="candidate"/>', 'let candidate=Busy;'],
    ['const alias of mutable input', '<ElButton :icon="alias"/>', 'let candidate=Busy;const alias=candidate;'],
    ['template shadow of actual import', '<ElButton v-for="Busy in items" :icon="Busy"/>', 'const items=[];'],
    ['unknown spread override', '<ElButton v-bind="unknownInputs"/>', ''],
    ['dynamic prop key', '<ElButton :[key]="Busy"/>', 'const key="icon";'],
    ['same prop collision', '<ElButton :loadingIcon="Busy" :loading-icon="Busy"/>', ''],
    ['string name without runtime registration', '<ElButton icon="Busy"/>', ''],
    ['const string name without runtime registration', '<ElButton :icon="alias"/>', 'const alias="Busy";']
])
{
    test(`component props reject ${label}`, () =>
    {
        const result = graph(template, imports + extra);
        assert.ok(exactErrors(result).some((entry) => entry.reason === 'unbound-component-prop-source'), JSON.stringify(result.errors));
    });
}

test('unknown declared defaults and unguarded missing component inputs remain rejected', () =>
{
    for (const config of ['{glyph:{type:Object,default:()=>unknown}}', '{glyph:Object}'])
    {
        fixture(`<script setup>const props=defineProps(${config});</script><template><component :is="glyph"/></template>`, 'UnknownOwner.vue');
        const result = graph('<Owner/>', 'import Owner from "./UnknownOwner.vue";');
        assert.ok(result.errors.some((entry) => entry.reason === 'unbound-component-prop-source'));
        assert.equal(result.componentPropBindings.length, 0);
    }
});

test('source-only DOM interface refuses another call, changed inputs and forged declaration identity', () =>
{
    const result = graph('<ElButton :icon="Busy"/><ElButton/>', imports);
    const binding = result.componentPropBindings.find((entry) => !entry.absent && result.nodes.find((node) => node.id === entry.sourceNode).origin.property === 'icon');
    const source = result.nodes.find((entry) => entry.id === binding.sourceNode);
    const ancestors = binding.callPath.map((sourceCall) => ({ sourceCall }));
    assert.equal(matchCompositionComponentProp(result, source, ancestors), binding);
    assert.equal(matchCompositionComponentProp(result, source, [{ sourceCall: 'another-call' }]), null);
    const changed = structuredClone(result);
    changed.nodes.find((entry) => entry.id === binding.callNode).attributes.icon = 'unknown';
    assert.equal(matchCompositionComponentProp(changed, source, ancestors), null);
    assert.equal(matchCompositionComponentProp(result, { ...source, origin: { ...source.origin, declarationDigest: 'forged' } }, ancestors), null);
    assert.equal(readFileSync(binding.definition, 'utf8').includes('<svg'), true);
});

// Unbound props do not acquire identity in the standalone default-deny scanner.
test('canonical component input edges require composition call proof', () =>
{
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    const file = resolve(fsusUIRoot, 'vue/packages/components/button/src/button.vue');
    const exp = source.expression('loadingIcon', file);
    assert.throws(() => source.resolver.resolveExpression(file, exp), /unresolved component expression/);
    const edge = source.resolver.resolveComponentInput(file, exp)[0];
    assert.equal(edge.kind, 'component-prop');
    assert.equal(edge.property, 'loadingIcon');
    assert.ok(edge.declarationFile.endsWith('/button/src/button.ts'));
});

test('reaching a supplied component does not authorize its further unbound input edges', () =>
{
    fixture('<script setup>const props=defineProps({inner:Object});</script><template><component :is="inner" v-if="inner"/></template>', 'NestedGlyph.vue');
    const result = graph('<ElButton :icon="Glyph"/>', imports + 'import Glyph from "./NestedGlyph.vue";');
    assert.ok(result.errors.some((entry) => entry.file.endsWith('/NestedGlyph.vue') && entry.reason === 'unbound-component-prop-source'));
});

test('forwarded component proof requires the complete ordered rendering call chain', () =>
{
    const result = graph('<ElDropdownItem :icon="Busy"/>', imports);
    const binding = result.componentPropBindings.find((entry) => entry.callPath.length === 2);
    assert.ok(binding);
    const source = result.nodes.find((entry) => entry.id === binding.sourceNode);
    const chain = binding.callPath.map((sourceCall) => ({ sourceCall }));
    assert.equal(matchCompositionComponentProp(result, source, chain), binding);
    assert.equal(matchCompositionComponentProp(result, source, chain.slice(0, 1)), null);
    assert.equal(matchCompositionComponentProp(result, source, chain.toReversed()), null);
});

test('shadowed Vue props and attrs cannot borrow the outer supplied component', () =>
{
    for (const [declaration, spread] of [
        ['const $props={icon:unknown};', '$props'],
        ['const $attrs={icon:unknown};', '{...props,...$attrs}']
    ])
    {
        fixture(`<script setup>import {ElButton} from "@ozwasyd/element-plus";const props=defineProps({icon:Object});${declaration}</script><template><ElButton v-bind="${spread}"/></template>`, 'ShadowOwner.vue');
        const result = graph('<Owner :icon="Busy"/>', imports + 'import Owner from "./ShadowOwner.vue";');
        assert.ok(exactErrors(result).some((entry) => entry.reason === 'unbound-component-prop-source'));
    }
});
