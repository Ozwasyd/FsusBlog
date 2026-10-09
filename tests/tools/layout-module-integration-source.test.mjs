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
