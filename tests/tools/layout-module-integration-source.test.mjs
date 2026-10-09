import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { createFiniteRefSelectorSource } from '@fsusblog/control-legality/source-ref-selectors';
import { compositionAnalyzerSources } from '@fsusblog/layout-governance/composition-analyzer';
import { createCompositionCollectionSource } from '@fsusblog/layout-governance/composition-collection-source';
import { matchCompositionTargetVariant } from '@fsusblog/layout-governance/composition-dom';
import { createCompositionFunctionalSource } from '@fsusblog/layout-governance/composition-functional-source';
import { createCompositionSlotSource } from '@fsusblog/layout-governance/composition-slot-source';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';
import { resolveCompositionTargetOrigin } from '@fsusblog/layout-governance/composition-target-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'actual original FsusUI source is required');
const directory = resolve(repositoryRoot, '.tmp', `module-integration-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function source()
{
    return createCompositionSource({ repositoryRoot, fsusUIRoot });
}
function fixture(text, extension = 'vue')
{
    const file = resolve(directory, `${randomUUID()}.${extension}`);
    writeFileSync(file, text);
    return file;
}
function functionPackage(exports = { '.': { import: './public.mjs', require: './index.cjs' } }, text = 'export const predicate=(value)=>typeof value === "string";')
{
    const name = `actual-functions-${randomUUID()}`;
    const root = resolve(directory, 'node_modules', name);
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name, exports }));
    writeFileSync(resolve(root, 'index.cjs'), 'module.exports={};');
    writeFileSync(resolve(root, 'public.mjs'), text);
    const file = fixture(`import {predicate as alias} from '${name}';const selected=alias('Actual');`, 'ts');
    const s = source();
    return { s, file, root, resolve: () => s.resolver.resolveSourceFunction(file, s.expression('alias', file)) };
}
function mixed(framework = false)
{
    const child = fixture('<template><a>Actual child</a></template>');
    const file = fixture(`<script setup>import {computed} from 'vue';import Child from './${child.split('/').at(-1)}';
        ${framework ? "import {RouterLink} from 'vue-router';" : ''}
        const host=computed(()=>productState?'a':${framework ? 'RouterLink' : 'Child'});</script><template><component :is="host"/></template>`);
    const s = source();
    const graph = s.graph([file]);
    const selector = graph.nodes.find((node) => node.file === file && node.tag === 'component');
    return { s, graph, selector, child };
}
function slot(scoped = false)
{
    const owner = fixture('import {defineComponent} from "vue";export default defineComponent({setup(_, {slots}){return()=>slots.default?.();}});', 'tsx');
    const file = fixture(`<script setup>import Owner from './${owner.split('/').at(-1)}';</script><template><Owner>
        ${scoped ? '<template #default="scope"><button :title="scope.title"/></template>' : '<button title="Actual">Child</button>'}</Owner></template>`);
    const graph = source().graph([file]);
    return { graph, owner, file };
}
function script(output, declarations = '')
{
    const file = fixture(`import {defineComponent} from 'vue';export default defineComponent({setup(){return()=>{${declarations}return ${output};};}});`, 'tsx');
    return source().graph([file]);
}

test('canonical package exports and original analyzer closure contain all five actual source modules', () =>
{
    for (const fn of [createCompositionCollectionSource, createCompositionFunctionalSource,
        createCompositionSlotSource, resolveCompositionTargetOrigin, createFiniteRefSelectorSource])
    {
        assert.equal(typeof fn, 'function');
    }
    assert.equal(compositionAnalyzerSources.length, 17);
    assert.equal(new Set(compositionAnalyzerSources).size, 17);
    assert.ok(compositionAnalyzerSources.includes('package.json'));
    assert.ok(compositionAnalyzerSources.includes('tools/frontend/control-legality/package.json'));
    for (const name of ['compositionCollectionSource', 'compositionFunctionalSource', 'compositionSlotSource', 'compositionTargetSource'])
    {
        assert.ok(compositionAnalyzerSources.includes(`tests/frontend/support/layout/${name}.mjs`));
    }
    assert.ok(compositionAnalyzerSources.includes('tools/frontend/control-legality/source-ref-selectors.mjs'));
});

test('central actual InspectorRail graph preserves six public icons through its real export star facade', () =>
{
    const file = resolve(repositoryRoot, 'src/frontend/src/components/admin/article/ArticleWriteInspectorRail.vue');
    const graph = source().graph([file]);
    const node = graph.nodes.find((entry) => entry.file === file && entry.tag === 'component');
    assert.equal(node.origin.kind, 'component-variants');
    assert.equal(node.origin.variants.length, 6);
    assert.ok(node.origin.variants.every((target) => target.kind === 'fsusui-public' && target.entry.endsWith('/icons-vue')));
    assert.ok(graph.resolverInputs.some((input) => input.path.endsWith('/src/fsusui/icons.ts')));
    assert.ok(node.definitions.every((definition) => graph.files.some((record) => record.file === definition)));
    const { proofDigest, ...proof } = node.origin.variants[0].selectorSource;
    assert.equal(proofDigest, controlDigest(proof));
});

test('central actual ImageViewer graph binds the initial ref and every closed authored mode write', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/image-viewer/src/image-viewer.vue');
    const graph = source().graph([file]);
    const node = graph.nodes.find((entry) => entry.file === file && entry.tag === 'component');
    assert.equal(node.origin.kind, 'component-variants');
    assert.equal(node.origin.variants.length, 2);
    assert.ok(node.origin.variants.every((target) => target.selectorSource.steps.length > 0));
    assert.ok(!graph.errors.some((error) => error.file === file && error.offset === node.offset));
});

test('central mixed native and local target retains both actual definitions without selecting product state', () =>
{
    const { graph, selector, child } = mixed();
    assert.deepEqual(graph.errors, []);
    assert.equal(selector.origin.kind, 'target-variants');
    assert.deepEqual(selector.origin.alternatives.map((target) => target.targetKind), ['native', 'component']);
    assert.deepEqual(selector.definitions, [child]);
    assert.ok(graph.files.some((record) => record.file === child));
});

test('central pure target matching binds the original component child through its actual selector call', () =>
{
    const { graph, selector, child } = mixed();
    const node = graph.nodes.find((entry) => entry.file === child && entry.tag === 'a');
    const match = matchCompositionTargetVariant(graph, selector, node, [{ sourceCall: selector.id }]);
    assert.equal(match.definition, child);
    assert.equal(match.target.kind, 'local');
});

test('central target matching rejects a same tag framework or native branch without its rendered supplier', () =>
{
    const { graph, selector } = mixed(true);
    assert.deepEqual(selector.origin.alternatives.map((target) => target.targetKind), ['native', 'framework']);
    assert.equal(matchCompositionTargetVariant(graph, selector, selector, [{ sourceCall: selector.id, tag: 'a' }]), null);
});

test('central target matching rejects missing calls cloned owners and changed source proof facts', () =>
{
    const { graph, selector, child } = mixed();
    const node = graph.nodes.find((entry) => entry.file === child);
    assert.equal(matchCompositionTargetVariant(graph, selector, node, []), null);
    assert.equal(matchCompositionTargetVariant(graph, { ...selector }, node, [{ sourceCall: selector.id }]), null);
    selector.origin.alternatives[0].target.name = 'aside';
    assert.equal(matchCompositionTargetVariant(graph, selector, node, [{ sourceCall: selector.id }]), null);
});

test('central actual Button RouterLink input retains its complete proof while rendered supplier stays rejected', () =>
{
    const file = fixture('<script setup>import {ElButton} from "@ozwasyd/element-plus";import {RouterLink} from "vue-router";</script><template><ElButton :tag="RouterLink"/></template>');
    const graph = source().graph([file]);
    const call = graph.nodes.find((node) => node.file === file && node.tag === 'ElButton');
    const binding = graph.targetBindings.find((entry) => entry.callNode === call.id && entry.targetKind === 'framework');
    assert.ok(binding);
    assert.deepEqual(binding.callPath, [call.id]);
    assert.equal(binding.inputDigest, controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }));
    const { proofDigest, ...proof } = binding;
    assert.equal(proofDigest, controlDigest(proof));
    assert.ok(graph.errors.some((error) => error.callNode === call.id && error.reason === 'unbound-native-prop-source'));
});

test('central slot invocation binds actual child identity and supplier source without a parent ownership substitution', () =>
{
    const { graph, file } = slot();
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.slotBindings.length, 1);
    const binding = graph.slotBindings[0];
    const child = graph.nodes.find((node) => node.file === file && node.tag === 'button');
    assert.equal(binding.result.value[0].sourceNode, child.id);
    assert.equal(binding.result.value[0].target.kind, 'native');
    assert.equal(binding.supplier.callNode, binding.result.callNode);
    const { proofDigest, ...proof } = binding.result;
    assert.equal(proofDigest, controlDigest(proof));
});

test('central target ledger retains every real Button supplying call including the unresolved framework branch', () =>
{
    const file = fixture('<script setup>import {ElButton} from "@ozwasyd/element-plus";import {RouterLink} from "vue-router";</script><template><ElButton :tag="RouterLink"/><ElButton tag="a"/></template>');
    const graph = source().graph([file]);
    const sourceNode = graph.nodes.find((node) => node.origin.kind === 'native-prop' && node.file.endsWith('/button/src/button.vue'));
    const calls = graph.nodes.filter((node) => node.definition === sourceNode.file);
    assert.equal(calls.length, 2);
    const bindings = graph.targetBindings.filter((entry) => entry.sourceNode === sourceNode.id);
    assert.equal(bindings.length, 2);
    assert.deepEqual(bindings.map((entry) => entry.callNode).sort(), calls.map((node) => node.id).sort());
    assert.deepEqual(bindings.map((entry) => entry.targetKind).sort(), ['framework', 'native']);
    assert.equal(graph.nativePropBindings.filter((entry) => entry.sourceNode === sourceNode.id).length, 1);
    assert.equal(graph.errors.filter((error) => error.reason === 'unbound-native-prop-source' && error.property === 'tag').length, 1);
});

test('central scoped slot supplier remains rejected with its exact original call and source location', () =>
{
    const { graph, owner } = slot(true);
    assert.equal(graph.slotBindings.length, 0);
    assert.ok(graph.errors.some((error) => error.reason === 'unbound-slot-source' && error.file === owner
        && error.callNode && error.sourceNode && /unbound scoped\/conditional slot supplier/.test(error.message)));
});

test('central actual functional Overlay carries its original render proof and lexical slot edge', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/table-v2/src/renderers/overlay.tsx');
    const graph = source().graph([file]);
    const proof = graph.files.find((record) => record.file === file).renderSource.functional;
    const { proofDigest, ...facts } = proof;
    assert.equal(proofDigest, controlDigest(facts));
    assert.ok(graph.nodes.some((node) => node.file === file && node.tag === 'div' && node.origin.kind === 'native'));
    assert.ok(graph.nodes.some((node) => node.file === file && node.slotSource?.name === 'default'));
    assert.equal(graph.slotBindings.length, 0, 'lexical slots alone do not supply callback payload or runtime qualification');
});

test('central functional closed spread retains actual field ASTs and native source instrumentation', () =>
{
    const file = fixture('const Owner=()=>{const attrs={title:"Actual"};return <button {...attrs}/>;};Owner.displayName="Owner";export default Owner;', 'tsx');
    const graph = source().graph([file]);
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.nodes[0].attributes.title, 'Actual');
    assert.equal(graph.nodes[0].sourceSyntax.kind, 'jsx');
    assert.ok(graph.files[0].renderSource.functional.steps.length > 0);
});

test('central finite map consumes every actual callback input and retains repeated source render paths', () =>
{
    const graph = script('["First","Second"].map(item=><button>{item}</button>)');
    assert.deepEqual(graph.errors, []);
    const button = graph.nodes.find((node) => node.tag === 'button');
    assert.equal(button.renderPaths.length, 2);
    assert.ok(button.renderPaths.every((entry) => entry.callbackInputs[0].name === 'item'));
    const proof = graph.files[0].collectionSources[0];
    const { proofDigest, ...facts } = proof;
    assert.equal(proofDigest, controlDigest(facts));
    assert.equal(proof.elements.length, 2);
});

test('central fresh array push retains its authored guard and original element source', () =>
{
    const graph = script('children', 'const children=[];if(productState){children.push(<button/>);}');
    assert.deepEqual(graph.errors, []);
    assert.deepEqual(graph.nodes[0].conditional, [{ name: 'if', expression: 'productState' }]);
    const effect = graph.files[0].collectionSources[0].effects[0];
    assert.equal(effect.kind, 'script-source');
    assert.ok(effect.digest.length === 64 && effect.file === graph.files[0].file);
    assert.equal(effect.conditions[0].expression, 'productState');
});

function targetSupplier(supplied = '<ElButton :tag="RouterLink"/><ElButton tag="a"/>')
{
    const file = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';import {RouterLink} from 'vue-router';</script><template>${supplied}</template>`);
    const s = source();
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.origin.kind === 'native-prop' && entry.file.endsWith('/button/src/button.vue'));
    return { s, graph, node, file };
}

test('canonical target supplier API returns every actual original call in order for graph and original nodes', () =>
{
    const { s, graph, node } = targetSupplier();
    const inputs = s.resolveTargetInputs(node, graph);
    assert.deepEqual(inputs, s.resolveTargetInputs(node, graph.nodes));
    const calls = graph.nodes.filter((entry) => entry.definition === node.file);
    assert.deepEqual(inputs.map((input) => input.callPath), calls.map((entry) => [entry.id]));
    assert.deepEqual(inputs.map((input) => input.target.kind), ['external', 'native']);
    assert.equal(inputs[0].target.publicName, 'RouterLink');
    assert.equal(inputs[1].target.name, 'a');
});

test('canonical target supplier API isolates returned identities from the original resolver graph', () =>
{
    const { s, graph, node } = targetSupplier();
    const inputs = s.resolveTargetInputs(node, graph);
    inputs[0].target.publicName = 'Forged';
    inputs[0].callPath.reverse();
    assert.equal(s.resolveTargetInputs(node, graph)[0].target.publicName, 'RouterLink');
});

test('canonical target supplier API rejects omitted cloned reordered and foreign graph inputs', () =>
{
    const { s, graph, node } = targetSupplier();
    for (const replacement of [graph.nodes.slice(), graph.nodes.slice(1), [...graph.nodes].reverse(), structuredClone(graph)])
    {
        assert.throws(() => s.resolveTargetInputs(node, replacement), /actual canonical graph/);
    }
    assert.throws(() => s.resolveTargetInputs({ ...node }, graph), /actual canonical graph/);
});

test('canonical target supplier API rejects changes to actual call attributes rather than rebinding them', () =>
{
    const { s, graph, node } = targetSupplier();
    graph.nodes.find((entry) => entry.definition === node.file).attributes.tag = 'aside';
    assert.throws(() => s.resolveTargetInputs(node, graph), /graph changed/);
});

test('canonical target supplier API rejects raw source drift with an unchanged in memory graph', () =>
{
    const { s, graph, node, file } = targetSupplier();
    writeFileSync(file, '<template><button/></template>');
    assert.throws(() => s.resolveTargetInputs(node, graph), /source changed/);
});

test('canonical target supplier API refuses the whole set when one actual supplying call is unresolved', () =>
{
    const { s, graph, node } = targetSupplier('<ElButton tag="a"/><ElButton :tag="unknown"/>');
    assert.ok(graph.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    assert.throws(() => s.resolveTargetInputs(node, graph), /unknown|unbound|unresolved/);
});

test('canonical target supplier API preserves complete nested forwarding paths and both real outer suppliers', () =>
{
    const inner = fixture('<script setup>import {ElButton} from "@ozwasyd/element-plus";const props=defineProps({tag:[String,Object]});</script><template><ElButton :tag="tag"/></template>');
    const file = fixture(`<script setup>import Forward from './${inner.split('/').at(-1)}';import {RouterLink} from 'vue-router';</script><template><Forward :tag="RouterLink"/><Forward tag="a"/></template>`);
    const s = source();
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.origin.kind === 'native-prop' && entry.file.endsWith('/button/src/button.vue'));
    const inputs = s.resolveTargetInputs(node, graph);
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every((input) => input.callPath.length === 2));
    assert.equal(inputs[0].callPath[0], inputs[1].callPath[0]);
    assert.notEqual(inputs[0].callPath[1], inputs[1].callPath[1]);
    assert.deepEqual(inputs.map((input) => input.target.kind), ['external', 'native']);
});

test('canonical target supplier API rejects a non target owner and another source instance', () =>
{
    const { s, graph, node } = targetSupplier();
    const call = graph.nodes.find((entry) => entry.definition === node.file);
    assert.throws(() => s.resolveTargetInputs(call, graph), /actual canonical graph and source node/);
    assert.throws(() => source().resolveTargetInputs(node, graph), /actual canonical graph/);
});

test('canonical target supplier rejects every conflicting literal and unknown named tag binding before its shortcut', () =>
{
    for (const markup of ['<ElButton :tag="\'a\'" v-bind:tag="unknown"/>',
        '<ElButton tag="a" :tag="unknown"/>', '<ElButton :tag="unknown" v-bind:tag="\'a\'"/>'])
    {
        const { s, graph, node } = targetSupplier(markup);
        assert.ok(graph.errors.some((error) => error.reason === 'unbound-native-prop-source' && /ambiguous component input/.test(error.message)));
        assert.equal(graph.nativePropBindings.length, 0);
        assert.throws(() => s.resolveTargetInputs(node, graph), /ambiguous component input/);
    }
    const owner = fixture('<script setup>const props=defineProps({tag:{type:[String,Object],default:"button"}});</script><template><component :is="tag"/></template>');
    for (const markup of ['<Owner :tag="\'a\'" v-bind:tag="unknown"/>', '<Owner tag="button" :tag="\'a\'"/>'])
    {
        const file = fixture(`<script setup>import Owner from './${owner.split('/').at(-1)}';</script><template>${markup}</template>`);
        const s = source();
        const graph = s.graph([file]);
        const node = graph.nodes.find((entry) => entry.origin.kind === 'native-prop');
        assert.ok(graph.errors.length > 0);
        assert.throws(() => s.resolveTargetInputs(node, graph), /ambiguous component input/);
    }
});

test('canonical target supplier rejects old nodes after a same byte clone replaces actual graph membership', () =>
{
    const { s, graph, node } = targetSupplier();
    const index = graph.nodes.indexOf(node);
    graph.nodes[index] = structuredClone(node);
    assert.throws(() => s.resolveTargetInputs(node, graph), /graph node identity changed/);
    assert.throws(() => s.resolveTargetInputs(graph.nodes[index], graph), /actual canonical graph and source node/);
    const call = targetSupplier();
    const callIndex = call.graph.nodes.findIndex((entry) => entry.definition === call.node.file);
    call.graph.nodes[callIndex] = structuredClone(call.graph.nodes[callIndex]);
    assert.throws(() => call.s.resolveTargetInputs(call.node, call.graph), /graph node identity changed/);
    const array = targetSupplier();
    array.graph.nodes = [...array.graph.nodes];
    assert.throws(() => array.s.resolveTargetInputs(array.node, array.graph), /graph node identity changed/);
});

test('canonical SFC source rejects missing named runtime exports instead of borrowing its default template', () =>
{
    const child = fixture('<template><button/></template>');
    const file = fixture(`<script setup>import {Missing as Child} from './${child.split('/').at(-1)}';</script><template><Child/></template>`);
    const graph = source().graph([file]);
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source' && /named SFC runtime component export/.test(error.message)));
    assert.equal(graph.nodes.find((node) => node.tag === 'Child').definition, null);
});

test('canonical SFC source rejects declared and type only named components while retaining actual default exports', () =>
{
    for (const declaration of ['export interface Named {}', 'export type Named={render:unknown};', 'export declare const Named:unknown;'])
    {
        const child = fixture(`<script lang="ts">${declaration}</script><template><button/></template>`);
        const file = fixture(`<script setup>import {Named as Child} from './${child.split('/').at(-1)}';</script><template><Child/></template>`);
        const graph = source().graph([file]);
        assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source' && /named SFC runtime component export/.test(error.message)));
        const actual = fixture(`<script setup>import Child from './${child.split('/').at(-1)}';</script><template><Child/></template>`);
        assert.equal(source().graph([actual]).nodes.find((node) => node.tag === 'Child').definition, child);
    }
});

test('canonical actual supplier rejects a type only SFC identity even alongside unrelated rendered gaps', () =>
{
    const child = fixture('<script lang="ts">export type Ghost={};</script><template><button/></template>');
    const file = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';import {Ghost} from './${child.split('/').at(-1)}';</script><template><ElButton :tag="Ghost"/></template>`);
    const s = source();
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.origin.kind === 'native-prop' && entry.file.endsWith('/button/src/button.vue'));
    assert.throws(() => s.resolveTargetInputs(node, graph), /named SFC runtime component export/);
});

test('canonical SFC source retains a real named facade reexport of another actual default component', () =>
{
    const child = fixture('<template><button/></template>');
    const facade = fixture(`<script lang="ts">export {default as Named} from './${child.split('/').at(-1)}';</script><template><aside/></template>`);
    const file = fixture(`<script setup>import {Named as Child} from './${facade.split('/').at(-1)}';</script><template><Child/></template>`);
    const graph = source().graph([file]);
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.nodes.find((node) => node.tag === 'Child').definition, child);
});

test('canonical computed component source rejects a named callback capturing the ref container', () =>
{
    const child = fixture('<template><button/></template>');
    const other = fixture('<template><aside/></template>');
    const file = fixture(`<script setup>import {computed} from 'vue';import A from './${child.split('/').at(-1)}';import B from './${other.split('/').at(-1)}';
        const host=computed(()=>state?A:B);function leak(){return host;}foreign(leak);</script><template><component :is="host"/></template>`);
    assert.ok(source().graph([file]).errors.some((error) => /escaped finite component binding/.test(error.message)));
});

test('canonical component member rejects a named callback capturing the original provider object', () =>
{
    const file = fixture(`<script setup>import {Check as Glyph} from '@ozwasyd/element-plus/icons-vue';
        const provider={editor:Glyph};function leak(){return provider;}foreign(leak);</script><template><component :is="provider.editor"/></template>`);
    assert.ok(source().graph([file]).errors.some((error) => /escaped component member object/.test(error.message)));
});

test('canonical computed component source rejects assignment propagation through an aggregate', () =>
{
    const child = fixture('<template><button/></template>');
    const other = fixture('<template><aside/></template>');
    const file = fixture(`<script setup>import {computed} from 'vue';import A from './${child.split('/').at(-1)}';import B from './${other.split('/').at(-1)}';
        const host=computed(()=>state?A:B);let holder;holder={host};foreign(holder);</script><template><component :is="host"/></template>`);
    assert.ok(source().graph([file]).errors.some((error) => /escaped finite component binding/.test(error.message)));
});

test('central template outlet cannot consume a JSX callback supplier without its actual invocation', () =>
{
    const owner = fixture('<template><slot/></template>');
    const file = fixture(`import {defineComponent,h} from 'vue';import Owner from './${owner.split('/').at(-1)}';
        export default defineComponent({setup(){return()=> <Owner>{{default:()=>h('button',{},[])}}</Owner>;}});`, 'tsx');
    const s = source();
    const graph = s.graph([file]);
    const call = graph.nodes.find((node) => node.file === file && node.tag === 'Owner');
    const binding = createCompositionSlotSource({ source: s }).bindSlot({ graph, callNode: call.id });
    assert.equal(binding.callbackPending, true);
    assert.ok(graph.errors.some((error) => error.reason === 'unbound-slot-source'
        && error.file === owner && /missing actual slot callback invocation/.test(error.message)));
    assert.equal(graph.slotBindings.some((entry) => entry.supplier.callNode === call.id), false);
});

test('canonical actual Options predicates resolve to original public ESM definitions and metadata inputs', () =>
{
    const s = source();
    const file = resolve(fsusUIRoot, 'vue/packages/components/select/src/options.ts');
    for (const name of ['isString', 'isFunction'])
    {
        const result = s.resolver.resolveSourceFunction(file, s.expression(name, file));
        assert.ok(result.file.endsWith('/@vue/shared/dist/shared.esm-bundler.js'));
        assert.equal(result.name, name);
        assert.equal(result.fn, s.resolver.parse(result.file).variables.get(name));
        assert.deepEqual(result.sourceSteps, [s.resolver.sourceStep(result.file, result.fn)]);
    }
    const inputs = s.resolver.sourceBindings();
    assert.deepEqual(inputs.errors, []);
    assert.ok(inputs.files.some((entry) => entry.path.endsWith('/@vue/shared/package.json')));
    assert.ok(inputs.files.some((entry) => entry.path.endsWith('/utils/types.ts')));
    assert.ok(inputs.files.some((entry) => entry.path.endsWith('/@vue/shared/dist/shared.esm-bundler.js')));
});

test('canonical public function source follows the actual declared ESM entry without executing require output', () =>
{
    const state = functionPackage();
    const result = state.resolve();
    assert.equal(result.file, resolve(state.root, 'public.mjs'));
    assert.equal(result.name, 'predicate');
    assert.equal(result.fn, state.s.resolver.parse(result.file).variables.get('predicate'));
    assert.ok(state.s.resolver.sourceBindings().files.some((entry) => entry.path === resolve(state.root, 'package.json')));
});

test('canonical public function source rejects a same name absent from its actual export', () =>
{
    const state = functionPackage(undefined, 'export const unrelated=()=>true;');
    assert.throws(state.resolve, /unknown component source function import/);
});

test('canonical public function source rejects ambiguous import conditions and conflicting module entry', () =>
{
    for (const contract of [
        { import: { browser: './public.mjs', default: './public.mjs' }, require: './index.cjs' },
        { import: './public.mjs', module: './index.cjs', require: './index.cjs' }
    ])
    {
        assert.throws(functionPackage({ '.': contract }).resolve, /missing\/ambiguous public ESM function entry/);
    }
});

test('canonical public function source rejects private subpaths and escaped declared source', () =>
{
    const state = functionPackage();
    const name = state.root.split('/').at(-1);
    const file = fixture(`import {predicate} from '${name}/public.mjs';`, 'ts');
    assert.throws(() => state.s.resolver.resolveSourceFunction(file, state.s.expression('predicate', file)), /unavailable public function package/);
    assert.throws(functionPackage({ '.': { import: './../outside.mjs', require: './index.cjs' } }).resolve, /invalid public ESM function entry/);
});

test('canonical public function source rejects stale metadata and original function bytes', () =>
{
    const metadata = functionPackage();
    metadata.resolve();
    writeFileSync(resolve(metadata.root, 'package.json'), JSON.stringify({ name: metadata.root.split('/').at(-1),
        exports: { '.': { import: './public.mjs', require: './index.cjs' } }, changed: true }));
    assert.throws(metadata.resolve, /public function package source changed/);
    const body = functionPackage();
    body.resolve();
    writeFileSync(resolve(body.root, 'public.mjs'), 'export const predicate=()=>true;');
    assert.throws(body.resolve, /component source function changed/);
});

test('canonical public function source leaves effectful and unavailable imports unqualified', () =>
{
    const state = functionPackage(undefined, 'export const predicate=(value)=>unknown(value);');
    const result = state.resolve();
    assert.equal(result.fn.body.getText(), 'unknown(value)');
    assert.equal(result.qualificationEligible, undefined);
    const file = fixture(`import {predicate} from 'missing-actual-package-${randomUUID()}';`, 'ts');
    assert.throws(() => state.s.resolver.resolveSourceFunction(file, state.s.expression('predicate', file)), /unavailable public function package/);
});

for (const [label, text] of [
    ['functional unknown helper', 'export default()=>foreign();'],
    ['functional injected prop VNode', 'export default(props)=>props.child;'],
    ['functional open prop spread', 'export default(props)=><button {...props}/>;'],
    ['functional escaped component', 'import Child from "./Missing.vue";foreign(Child);export default()=> <Child/>;'],
    ['collection opaque array', 'import {defineComponent} from "vue";export default defineComponent({setup(){return()=>opaque.map(item=><button/>);}});'],
    ['collection item mutation', 'import {defineComponent} from "vue";export default defineComponent({setup(){return()=>[1].map(item=>{item++;return <button/>;});}});'],
    ['collection callback effect', 'import {defineComponent} from "vue";export default defineComponent({setup(){return()=>[1].map(item=>foreign(item));}});'],
    ['collection unknown output identity', 'import {defineComponent} from "vue";export default defineComponent({setup(){return()=>[1].map(item=>unknownVNode);}});']
])
{
    test(`central module integration rejects ${label}`, () =>
    {
        const graph = source().graph([fixture(text, 'tsx')]);
        assert.ok(graph.errors.length > 0, label);
    });
}
