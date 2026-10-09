import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionRun, createLocalCompositionBaseline } from '@fsusblog/layout-governance/composition-analyzer';
import { loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';
import { resolveCompositionRoutes, bindCompositionArchetypes } from '@fsusblog/layout-governance/composition-routes';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual FsusUI checkout is required; no synthetic public API');
const directory = resolve(repositoryRoot, '.tmp', `composition-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
const source = () => createCompositionSource({ repositoryRoot, fsusUIRoot });
function fixture(content, name = 'Fixture.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
test.after(() => rmSync(directory, { recursive: true, force: true }));

test('all twelve fixtures bind to actual router AST/import graph without a second map', () =>
{
    const s = source();
    const routes = resolveCompositionRoutes(s, resolve(repositoryRoot, 'src/frontend/src/router/index.ts'));
    const { matrix } = loadCompositionInputs({ repositoryRoot, fsusUIRoot });
    const bindings = bindCompositionArchetypes(matrix, routes);
    assert.equal(bindings.length, 12);
    assert.deepEqual(bindings.flatMap((binding) => binding.errors), []);
    assert.ok(bindings.every((binding) => binding.entryFiles.length > 0));
    assert.ok(bindings.every((binding) => binding.entryFiles.every((file) => readFileSync(file, 'utf8').length)));
});

test('public aliases follow the real withInstall property factory and source file', () =>
{
    const s = source();
    const file = fixture('<script setup>import { FsusTaskPageHeader as Header } from "@ozwasyd/element-plus"</script><template><Header title="Current"/></template>');
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    const call = graph.nodes.find((node) => node.tag === 'Header');
    assert.equal(call.origin.publicName, 'FsusTaskPageHeader');
    assert.ok(graph.nodes.some((node) => node.file === call.definition && node.origin.kind === 'native-variants' && node.origin.default === 'h1'));
});

test('public icon star exports reach actual Vue SVG source and bind source path configuration', () =>
{
    const s = source();
    const file = fixture('<script setup>import {Loading as Busy} from "@ozwasyd/element-plus/icons-vue"</script><template><Busy/></template>');
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    const call = graph.nodes.find((node) => node.tag === 'Busy');
    assert.equal(call.origin.kind, 'fsusui-public');
    assert.ok(call.definition.endsWith('/icons-vue/src/components/loading.vue'));
    assert.ok(graph.nodes.some((node) => node.file === call.definition && node.tag === 'svg' && node.origin.kind === 'native'));
    assert.ok(graph.sourceIdentity.resolutionInputs.some((input) => input.path.endsWith('/vue/tsconfig.base.json') && input.digest.length === 64));
});

test('named reexports preserve local ownership instead of laundering a public-looking alias', () =>
{
    fixture('<template><div data-fsus-surface="control-group"/></template>', 'ExportOwner.vue');
    fixture('export {default as Toolbar} from "./ExportOwner.vue";', 'Exports.ts');
    const graph = source().graph([fixture('<script setup>import {Toolbar as FsusToolbar} from "./Exports";</script><template><FsusToolbar/></template>')]);
    assert.deepEqual(graph.errors, []);
    const call = graph.nodes.find((node) => node.tag === 'FsusToolbar');
    assert.equal(call.origin.kind, 'local');
    assert.ok(call.definition.endsWith('/ExportOwner.vue'));
});

test('conflicting star exports fail closed instead of choosing an arbitrary component source', () =>
{
    fixture('<template><div/></template>', 'FirstOwner.vue');
    fixture('<template><section/></template>', 'SecondOwner.vue');
    fixture('export {default as Toolbar} from "./FirstOwner.vue";', 'FirstExports.ts');
    fixture('export {default as Toolbar} from "./SecondOwner.vue";', 'SecondExports.ts');
    fixture('export * from "./FirstExports";export * from "./SecondExports";', 'AmbiguousExports.ts');
    const graph = source().graph([fixture('<script setup>import {Toolbar} from "./AmbiguousExports";</script><template><Toolbar/></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source' && error.message.includes('ambiguous')));
});

test('an explicit Vue script default and the SFC default identify one component', () =>
{
    const owner = fixture('<script>import {defineComponent} from "vue";export default defineComponent({});</script><template><div/></template>', 'ExplicitDefault.vue');
    const s = source();
    assert.equal(s.resolver.exportsOf(owner).get('default').ambiguous, undefined);
    const graph = s.graph([fixture('<script setup>import Owner from "./ExplicitDefault.vue";</script><template><Owner/></template>')]);
    assert.deepEqual(graph.errors, []);
    assert.ok(graph.nodes.some((node) => node.file === owner && node.tag === 'div'));
});

test('public structural conditions bind exact static props and provided slots', () =>
{
    const graph = source().graph([fixture('<script setup>import {FsusTaskPageHeader as Header,FsusCollectionToolbar as Toolbar} from "@ozwasyd/element-plus";</script><template><Header title="Current"/><Toolbar #actions><span>Action</span></Toolbar></template>')]);
    assert.deepEqual(graph.errors, []);
    const header = graph.nodes.find((node) => node.tag === 'Header');
    const toolbar = graph.nodes.find((node) => node.tag === 'Toolbar');
    const headerBindings = graph.structuralBindings.filter((binding) => binding.callNode === header.id);
    assert.deepEqual(Object.fromEntries(headerBindings.map((binding) => [binding.expression, binding.expected])),
        { hasTitle: true, hasDescription: false, hasActions: false });
    const toolbarBindings = graph.structuralBindings.filter((binding) => binding.callNode === toolbar.id);
    assert.deepEqual(Object.fromEntries(toolbarBindings.map((binding) => [binding.expression, binding.expected])),
        { hasPrimary: false, '$slots.filters': false, '$slots.actions': true });
    assert.ok(graph.resolverInputs.some((input) => input.path.endsWith('/task-page-header/src/task-page-header.ts')));
});

test('dynamic props and conditional slots cannot acquire structural proof', () =>
{
    const graph = source().graph([fixture('<script setup>import {FsusTaskPageHeader as Header} from "@ozwasyd/element-plus";</script><template><Header :title="currentTitle"><template #actions v-if="showActions">Action</template></Header></template>')]);
    assert.deepEqual(graph.errors, []);
    assert.ok(!graph.structuralBindings.some((binding) => binding.expression === 'hasTitle' || binding.expression === 'hasActions'));
    assert.ok(graph.structuralBindings.some((binding) => binding.expression === 'hasDescription' && binding.expected === false));
    const spread = source().graph([fixture('<script setup>import {FsusTaskPageHeader as Header} from "@ozwasyd/element-plus";</script><template><Header title="Current" v-bind="unknownAttrs"/></template>')]);
    assert.ok(!spread.structuralBindings.some((binding) => binding.expression === 'hasTitle'));
    const dynamicAttribute = source().graph([fixture('<script setup>import {FsusTaskPageHeader as Header} from "@ozwasyd/element-plus";</script><template><Header title="Current" :[key]="unknownValue"/></template>')]);
    assert.ok(!dynamicAttribute.structuralBindings.some((binding) => binding.expression === 'hasTitle'));
    const dynamicSlot = source().graph([fixture('<script setup>import {FsusCollectionToolbar as Toolbar} from "@ozwasyd/element-plus";</script><template><Toolbar #[slotName]>Content</Toolbar></template>')]);
    assert.equal(dynamicSlot.structuralBindings.length, 0);
});

test('slot branches, teleport and responsive directives retain concrete node locations', () =>
{
    fixture('<template><slot :open="true"/></template>', 'SlotOwner.vue');
    const file = fixture('<script setup>import SlotOwner from "./SlotOwner.vue"</script><template><section><SlotOwner><template #default="scope"><p v-if="scope.open">A</p><p v-else>B</p></template></SlotOwner><Teleport to="body"><aside v-show="open">X</aside></Teleport></section></template>');
    const graph = source().graph([file]);
    assert.equal(graph.errors.length, 1);
    assert.equal(graph.errors[0].reason, 'unbound-slot-source');
    assert.match(graph.errors[0].message, /unbound scoped\/conditional slot supplier/);
    assert.equal(graph.slotBindings.length, 0);
    assert.ok(graph.nodes.some((node) => node.slot));
    assert.equal(graph.nodes.filter((node) => node.file === file && node.conditional.length).length, 3);
    assert.ok(graph.nodes.some((node) => node.teleport));
    assert.ok(graph.nodes.every((node) => node.line > 0 && node.sourceDigest.length === 64));
});

test('malformed Vue AST fails closed', () =>
{
    const graph = source().graph([fixture('<template><section><p></section></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-ast-parse'));
});

test('unknown component and dynamic source fail closed despite plausible labels', () =>
{
    const graph = source().graph([fixture('<template><UnknownPanel data-fsus-surface="document"/><component :is="unknownView"/></template>')]);
    assert.equal(graph.errors.filter((error) => error.reason === 'unknown-component-source').length, 2);
});

test('finite native component alternatives retain every actual source branch', () =>
{
    const graph = source().graph([fixture('<template><component :is="active ? \'section\' : \'article\'"/></template>')]);
    assert.deepEqual(graph.errors, []);
    const node = graph.nodes.find((node) => node.tag === 'component');
    assert.equal(node.origin.kind, 'native-variants');
    assert.deepEqual(node.origin.values, ['section', 'article']);
    const unknown = source().graph([fixture('<template><component :is="active ? \'section\' : missingComponent"/></template>')]);
    assert.ok(unknown.errors.some((error) => error.reason === 'unknown-component-source'));
});

test('public native tag props bind the real default or exact literal call without a fallback', () =>
{
    const graph = source().graph([fixture('<script setup>import {ElScrollbar as Scroller} from "@ozwasyd/element-plus";</script><template><Scroller/><Scroller tag="section"/></template>')]);
    assert.ok(!graph.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    assert.ok(graph.nodes.some((node) => node.origin.kind === 'native-prop' && node.origin.property === 'tag' && node.origin.default === 'div'));
    assert.deepEqual(graph.nativePropBindings.map((binding) => binding.tag).sort(), ['div', 'section']);
    const dynamic = source().graph([fixture('<script setup>import {ElScrollbar as Scroller} from "@ozwasyd/element-plus";</script><template><Scroller :tag="currentTag"/></template>')]);
    assert.ok(dynamic.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    assert.equal(dynamic.nativePropBindings.length, 0);
    const unknown = source().graph([fixture('<script setup>import {ElScrollbar as Scroller} from "@ozwasyd/element-plus";</script><template><Scroller tag="UnknownPanel"/></template>')]);
    assert.ok(unknown.errors.some((error) => error.reason === 'unbound-native-prop-source'));
});

test('actual public DataList row functions prove all native returns without trusting annotations', () =>
{
    const graph = source().graph([fixture('<script setup>import {FsusDataList as List} from "@ozwasyd/element-plus";</script><template><List/></template>')]);
    const row = graph.nodes.find((node) => node.origin.function === 'rowTag');
    assert.ok(row.file.endsWith('/collection-primitives/src/data-list.vue'));
    assert.equal(row.origin.kind, 'native-variants');
    assert.deepEqual(row.origin.values, ['a', 'button', 'div']);
    assert.ok(!graph.errors.some((error) => error.file === row.file && error.offset === row.offset));
    const closed = source().graph([fixture('<script setup>const tag=(active)=>{if(active){return "section";}else{return "article";}}</script><template><component :is="tag(active)"/></template>')]);
    assert.deepEqual(closed.errors, []);
    assert.deepEqual(closed.nodes.find((node) => node.tag === 'component').origin.values, ['section', 'article']);
});

test('unknown returns, fallthrough and unsupported native function flow fail closed', () =>
{
    for (const body of ['return active ? "section" : unknownTag;', 'if(active)return "section";',
        'for(const item of items){return "section";}return "article";', 'return "section";return unknownTag;'])
    {
        const graph = source().graph([fixture(`<script setup lang="ts">const tag=(active):"section"=>{${body}}</script><template><component :is="tag(active)"/></template>`)]);
        assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source'), body);
    }
});

test('native function proof rejects mutable, nested and template-shadowed bindings', () =>
{
    const content = (script, markup) => `<script setup>${script}</script><template>${markup}</template>`;
    for (const entry of [
        content('let tag=()=>"section";', '<component :is="tag()"/>'),
        content('function hidden(){const tag=()=>"section";}', '<component :is="tag()"/>'),
        content('const tag=()=>"section";', '<template v-for="tag in items"><component :is="tag()"/></template>'),
        content('const tag=()=>"section";', '<template v-for="({kind:tag}, index) of items"><component :is="tag()"/></template>'),
        content('const tag=()=>"section";', '<Wrapper #default="{kind:tag}"><component :is="tag()"/></Wrapper>'),
        content('const tag=()=>"section";', '<component v-for="tag in items" :is="tag()"/>')
    ])
    {
        const graph = source().graph([fixture(entry)]);
        assert.equal(graph.nodes.find((node) => node.tag === 'component').origin.kind, 'unknown');
        assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source'));
    }
    const harmlessProperty = source().graph([fixture(content('const tag=()=>"section";', '<template v-for="({tag:other}, index) in items"><component :is="tag()"/></template>'))]);
    assert.deepEqual(harmlessProperty.errors, []);
});

test('a later unknown props spread cannot inherit proof from an earlier native default', () =>
{
    fixture('export const sharedProps = { inherited: String };', 'SharedProps.ts');
    fixture('<script setup>import {sharedProps} from "./SharedProps";const props=defineProps({...sharedProps,tag:{type:String,default:"section"}});</script><template><component :is="tag"/></template>', 'EarlierSpread.vue');
    const bounded = source().graph([fixture('<script setup>import Owner from "./EarlierSpread.vue";</script><template><Owner/></template>')]);
    assert.deepEqual(bounded.errors, []);
    assert.deepEqual(bounded.nativePropBindings.map((binding) => binding.tag), ['section']);
    assert.equal(bounded.nodes.find((node) => node.tag === 'Owner').origin.kind, 'local');
    fixture('<script setup>import {sharedProps} from "./SharedProps";const props=defineProps({tag:{type:String,default:"section"},...sharedProps});</script><template><component :is="tag"/></template>', 'LaterSpread.vue');
    const unknown = source().graph([fixture('<script setup>import Owner from "./LaterSpread.vue";</script><template><Owner/></template>')]);
    assert.ok(unknown.errors.some((error) => error.reason === 'unknown-component-source'));
    assert.equal(unknown.nativePropBindings.length, 0);
});

test('actual public withDefaults props bind declared native tags to exact calls', () =>
{
    const graph = source().graph([fixture('<script setup>import {FsuMobileDock as Dock} from "@ozwasyd/element-plus/motion";</script><template><Dock/><Dock as="aside"/></template>')]);
    assert.ok(!graph.errors.some((error) => ['unknown-component-source', 'unbound-native-prop-source'].includes(error.reason)));
    assert.deepEqual(graph.nativePropBindings.map((binding) => binding.tag).sort(), ['aside', 'nav']);
    assert.ok(graph.nodes.some((node) => node.origin.property === 'as' && node.origin.default === 'nav'));
    const dynamic = source().graph([fixture('<script setup>import {FsuMobileDock as Dock} from "@ozwasyd/element-plus/motion";</script><template><Dock :as="currentTag"/></template>')]);
    assert.ok(dynamic.errors.some((error) => error.reason === 'unbound-native-prop-source'));
});

test('withDefaults proof rejects undeclared, spread, computed and shadowed macro inputs', () =>
{
    for (const script of [
        'const props=withDefaults(defineProps<{other?:string}>(),{as:"nav"});',
        'const props=withDefaults(defineProps<{as?:string}>(),{as:"nav",...unknown});',
        'const props=withDefaults(defineProps<{as?:string}>(),{[key]:"nav"});',
        'const withDefaults=(props,defaults)=>defaults;const props=withDefaults(defineProps<{as?:string}>(),{as:"nav"});',
        'const props=withDefaults(defineProps<{as?:string}>(),{as:unknownTag});'
    ])
    {
        const graph = source().graph([fixture(`<script setup lang="ts">${script}</script><template><component :is="as"/></template>`)]);
        assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source'), script);
        assert.equal(graph.nativePropBindings.length, 0);
    }
    const shadowed = source().graph([fixture('<script setup lang="ts">const props=withDefaults(defineProps<{as?:string}>(),{as:"nav"});</script><template><component v-for="as in items" :is="as"/></template>')]);
    assert.ok(shadowed.errors.some((error) => error.reason === 'unknown-component-source'));
});

test('closed literal call spreads prove only their exact prop keys and values', () =>
{
    const script = '<script setup>import {FsuMobileDock as Dock} from "@ozwasyd/element-plus/motion";</script>';
    const bounded = source().graph([fixture(script + '<template><Dock v-bind="{ label:\'Current\' }"/><Dock v-bind="{ as:\'aside\' }"/></template>')]);
    assert.ok(!bounded.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    assert.deepEqual(bounded.nativePropBindings.map((binding) => binding.tag).sort(), ['aside', 'nav']);
    const escaped = source().graph([fixture(script + '<template><Dock v-bind="{ \'a\\u0073\':\'aside\' }"/></template>')]);
    assert.deepEqual(escaped.nativePropBindings.map((binding) => binding.tag), ['aside']);
    const tabs = source().graph([fixture('<script setup>import {FsuBottomTabBar as Tabs} from "@ozwasyd/element-plus/motion";</script><template><Tabs/></template>')]);
    assert.ok(tabs.nativePropBindings.some((binding) => binding.tag === 'nav'
        && tabs.nodes.find((node) => node.id === binding.callNode)?.file.endsWith('/FsuBottomTabBar.vue')));
    assert.ok(!tabs.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    for (const attributes of [
        'v-bind="unknownAttrs"', 'v-bind="{ ...unknownAttrs }"', 'v-bind="{ [key]:\'aside\' }"',
        'v-bind="{ as:unknownTag }"', 'v-bind="{ __proto__:unknownPrototype }"',
        'as="nav" v-bind="{ as:\'aside\' }"', 'as="nav" v-bind="{ \'a\\u0073\':\'aside\' }"',
        'v-bind="{ as:\'aside\' }" :as="\'nav\'"',
        'v-bind="{ as:\'aside\' }" v-bind="{ as:\'nav\' }"'
    ])
    {
        const graph = source().graph([fixture(script + `<template><Dock ${attributes}/></template>`)]);
        assert.ok(graph.errors.some((error) => ['unknown-ast-parse', 'unbound-native-prop-source'].includes(error.reason)), attributes);
        assert.equal(graph.nativePropBindings.length, 0);
    }
});

test('route-name branching resolves useRoute aliases and computed element access', () =>
{
    const graph = source().graph([fixture('<script setup>import {useRoute as activeRoute} from "vue-router";const current = activeRoute();const good = current["name"] === "representative";</script><template><h1 v-if="good">Good</h1></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'route-name-visual-branch'));
});

test('route-name business reads do not become a visual branch without a layout sink', () =>
{
    const graph = source().graph([fixture('<script setup>import {useRoute} from "vue-router";const route=useRoute();const navigationIdentity=route.name;</script><template><h1>Current</h1></template>')]);
    assert.deepEqual(graph.errors, []);
});

test('destructured route name flowing through class data fails closed', () =>
{
    const graph = source().graph([fixture('<script setup>import {useRoute} from "vue-router";const {name:page}=useRoute();const good=page==="representative";const density=good?"good":"bad";</script><template><h1 :class="density">Current</h1></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'route-name-visual-branch'));
});

test('imported local wrapper remains local through a public-looking alias', () =>
{
    fixture('<template><div data-fsus-surface="control-group"/></template>', 'Wrapper.vue');
    const graph = source().graph([fixture('<script setup>import FsusTaskPageHeader from "./Wrapper.vue"</script><template><FsusTaskPageHeader/></template>')]);
    const call = graph.nodes.find((node) => node.tag === 'FsusTaskPageHeader');
    assert.equal(call.origin.kind, 'local');
    assert.ok(call.definition.endsWith('/Wrapper.vue'));
});

test('instrumentation binds original bytes and rejects authored provenance markers', () =>
{
    const s = source();
    const file = fixture('<template><h1>Current</h1></template>');
    const code = readFileSync(file, 'utf8');
    assert.ok(s.instrument(file, code).includes('data-fsus-composition-node'));
    assert.throws(() => s.instrument(file, code + ' '), /source changed/);
    assert.throws(() => source().instrument(fixture('<template><h1 data-fsus-composition-node="fake">X</h1></template>'), '<template><h1 data-fsus-composition-node="fake">X</h1></template>'), /reserved source marker/);
});

test('actual contract, design and FsusUI digests are bound to the current run', () =>
{
    const baseline = createLocalCompositionBaseline(fsusUIRoot);
    const run = createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity: baseline, runId: randomUUID() });
    assert.equal(run.verifyCurrent(), true);
    assert.ok(run.analyzerDigest.length === 64 && run.worktree.worktreeDigest.length === 64);
    const drift = { ...baseline, gitHead: 'a'.repeat(40) };
    assert.throws(() => createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity: drift, runId: randomUUID() }), /baseline mismatch/);
});
