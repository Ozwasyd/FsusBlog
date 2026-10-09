import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const sfc = createRequire(resolve(repositoryRoot, 'src/frontend/package.json'))('@vue/compiler-sfc');
const directory = resolve(repositoryRoot, '.tmp', `standalone-props-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function graph(script, markup = '<Owner/>', ownerMarkup = '<component :is="as"/>', setup = true)
{
    const owner = resolve(directory, 'Owner.vue');
    writeFileSync(owner, `<script ${setup ? 'setup' : ''} lang="ts">${script}</script><template>${ownerMarkup}</template>`);
    const entry = resolve(directory, 'Entry.vue');
    writeFileSync(entry, `<script setup>import Owner from './Owner.vue';</script><template>${markup}</template>`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([entry]);
}
const macro = 'withDefaults(defineProps<{as?:"section"|"article"}>(),{as:"section"});';

test('actual PublicReadingPageFrame standalone macro binds only its real default and supplied native tags', () =>
{
    const frame = resolve(repositoryRoot, 'src/frontend/src/components/public/PublicReadingPageFrame.vue');
    const { descriptor, errors } = sfc.parse(readFileSync(frame, 'utf8'), { filename: frame });
    assert.deepEqual(errors, []);
    const compiled = sfc.compileScript(descriptor, { id: 'standalone-source-proof' });
    assert.equal(compiled.bindings.as, 'props');
    assert.equal(descriptor.scriptSetup.content.includes('const props'), false);
    const entry = resolve(directory, 'ActualEntry.vue');
    writeFileSync(entry, '<script setup>import Frame from "@/components/public/PublicReadingPageFrame.vue";</script><template><Frame/><Frame as="article"/><Frame as="div"/></template>');
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([entry]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.nativePropBindings.map((binding) => binding.tag).sort(), ['article', 'div', 'section']);
    const source = result.nodes.find((node) => node.file === frame && node.tag === 'component');
    assert.equal(source.origin.kind, 'native-prop');
    assert.equal(source.origin.property, 'as');
    assert.equal(source.origin.default, 'section');
});

test('standalone runtime prop macro uses its authored native default and literal call inputs', () =>
{
    const result = graph('defineProps({as:{type:String,default:"section"}});', '<Owner/><Owner as="article"/>');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.nativePropBindings.map((binding) => binding.tag).sort(), ['article', 'section']);
});

test('standalone typed macro preserves the missing supplier error when its component has no actual calls', () =>
{
    const owner = resolve(directory, 'Unbound.vue');
    writeFileSync(owner, `<script setup lang="ts">${macro}</script><template><component :is="as"/></template>`);
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([owner]);
    assert.equal(result.nodes.find((node) => node.tag === 'component').origin.kind, 'native-prop');
    assert.ok(result.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    assert.equal(result.nativePropBindings.length, 0);
});

for (const [label, config] of [
    ['unknown supplied tag', [macro, '<Owner :as="unknown"/>']],
    ['unknown supplied spread', [macro, '<Owner v-bind="unknown"/>']],
    ['unknown default', ['withDefaults(defineProps<{as?:string}>(),{as:unknown});']],
    ['undeclared field', ['withDefaults(defineProps<{other?:string}>(),{as:"section"});']],
    ['unknown defaults spread', ['withDefaults(defineProps<{as?:string}>(),{as:"section",...unknown});']],
    ['computed default field', ['withDefaults(defineProps<{as?:string}>(),{[key]:"section"});']],
    ['extra runtime macro argument', ['defineProps({as:{default:"section"}},unknown);']],
    ['extra defaults macro argument', ['withDefaults(defineProps<{as?:string}>(),{as:"section"},unknown);']],
    ['duplicate macro', [macro + macro]],
    ['assigned second macro', [macro + 'const props=defineProps({as:String});']],
    ['nested macro', [`function hidden(){${macro}}`]],
    ['ordinary script macro', [macro, '<Owner/>', '<component :is="as"/>', false]],
    ['shadowed macro function', [`function withDefaults(){return unknown;}${macro}`]],
    ['imported macro lookalike', [`import {withDefaults} from 'vue';${macro}`]],
    ['mutated macro', [`${macro}defineProps=unknown;`]],
    ['shadowed exposed prop', [`${macro}const as=unknown;`]],
    ['template shadow', [macro, '<Owner/>', '<component v-for="as in unknown" :is="as"/>']]
])
{
    test(`standalone prop macro rejects ${label}`, () =>
    {
        const result = graph(...config);
        assert.ok(result.errors.length > 0, label);
        assert.equal(result.nativePropBindings.length, 0, label);
    });
}
