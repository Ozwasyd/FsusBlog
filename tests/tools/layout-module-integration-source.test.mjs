import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { createFiniteRefSelectorSource } from '@fsusblog/control-legality/source-ref-selectors';
import { compositionAnalyzerSources } from '@fsusblog/layout-governance/composition-analyzer';
import { createCompositionCollectionSource } from '@fsusblog/layout-governance/composition-collection-source';
import { matchCompositionTargetVariant } from '@fsusblog/layout-governance/composition-dom';
import { createCompositionFunctionalSource } from '@fsusblog/layout-governance/composition-functional-source';
import { resolveCompositionRoutes } from '@fsusblog/layout-governance/composition-routes';
import { createCompositionSlotSource } from '@fsusblog/layout-governance/composition-slot-source';
import { compositionProbePlugin, createCompositionSource } from '@fsusblog/layout-governance/composition-source';
import { bindCompositionRouterViewTargets, resolveCompositionTargetOrigin } from '@fsusblog/layout-governance/composition-target-source';

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
function nativePropertyGraph(tag = 'unknown')
{
    const owner = fixture('<script setup>const props=defineProps({tag:{type:[String,Object],default:"button"},other:{type:[String,Object],default:"aside"}});</script><template><component :is="tag"/></template>');
    const entry = fixture(`<script setup>import Owner from './${owner.split('/').at(-1)}';</script><template><Owner :tag="${tag}" other="a"/></template>`);
    const s = source();
    const graph = s.graph([entry]);
    const target = graph.nodes.find((node) => node.file === owner && node.origin.kind === 'native-prop');
    assert.ok(target);
    return { s, graph, target, entry };
}
function exportStarGraph(competing = true)
{
    const actual = fixture("export {Check as Glyph} from '@ozwasyd/element-plus/icons-vue';", 'ts');
    const other = fixture('<template><button/></template>');
    const second = fixture(competing ? `export {default as Glyph} from './${other.split('/').at(-1)}';`
        : `export {Glyph} from './${actual.split('/').at(-1)}';`, 'ts');
    const ambiguous = fixture(`export * from './${actual.split('/').at(-1)}';export * from './${second.split('/').at(-1)}';`, 'ts');
    const entry = fixture(`<script setup>import {Glyph} from './${ambiguous.split('/').at(-1)}';</script><template><Glyph/></template>`);
    return { s: source(), actual, ambiguous, second, entry };
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
function frameworkCallee(s, file, name, argument = undefined)
{
    const candidates = [];
    function visit(node)
    {
        if (s.resolver.ts.isCallExpression(node) && s.resolver.ts.isIdentifier(node.expression) && node.expression.text === name
            && (argument === undefined || node.arguments[0]?.getText() === argument))
        {
            candidates.push(node.expression);
        }
        s.resolver.ts.forEachChild(node, visit);
    }
    s.resolver.parse(file).scripts.forEach(({ ast }) => visit(ast));
    assert.equal(candidates.length, 1);
    return candidates[0];
}
function routerGraph(reused = false)
{
    const leaf = fixture('<template><button/></template>');
    const outlet = fixture('<script setup>import {RouterView} from "vue-router";</script><template><RouterView v-slot="{Component}"><component :is="Component"/></RouterView></template>');
    const owner = reused ? fixture(`<script setup>import Outlet from './${outlet.split('/').at(-1)}';</script><template><Outlet/></template>`) : outlet;
    const router = fixture(`import {createRouter} from 'vue-router';const routes=[{path:'/',component:()=>import('./${owner.split('/').at(-1)}'),
        children:[{path:'leaf',component:()=>import('./${leaf.split('/').at(-1)}')}]}];createRouter({routes});`, 'ts');
    const s = source();
    const routes = resolveCompositionRoutes(s, router);
    return { s, routes, owner, outlet, leaf };
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

function originalSupplierOrderGraph()
{
    const parent = resolve(directory, randomUUID());
    mkdirSync(parent);
    const owner = resolve(parent, 'Owner.vue');
    const entry = resolve(parent, 'Entry.vue');
    const ownerBytes = '<script setup>const props=defineProps({tag:{type:[String,Object],default:"button"}});</script><template><component :is="tag"/></template>';
    const entryBytes = '<script setup>import Owner from "./Owner.vue";</script><template><Owner tag="a"/><Owner tag="span"/></template>';
    writeFileSync(owner, ownerBytes);
    writeFileSync(entry, entryBytes);
    const s = source();
    const graph = s.graph([entry]);
    const target = graph.nodes.find((node) => node.file === owner && node.origin.kind === 'native-prop');
    assert.deepEqual(graph.errors, []);
    assert.ok(target);
    return { s, graph, target, owner, entry, entryBytes };
}

test('canonical supplier order refuses same pointer call deletion and reinsertion at the public source boundary', () =>
{
    const { s, graph, target, owner, entry, entryBytes } = originalSupplierOrderGraph();
    const before = s.resolveTargetInputs(target, graph);
    const ids = s.parse(entry).nodes.slice();
    const instrumentation = s.instrument(entry, entryBytes);
    const firstCall = graph.nodes.find((node) => node.file === entry && node.definition === owner);
    assert.deepEqual(before.map((input) => input.target.name), ['a', 'span']);
    assert.deepEqual(before.map((input) => input.callPath), ids.map((id) => [id]));
    assert.ok(instrumentation.includes(`data-fsus-composition-call="${firstCall.id}"`));
    const map = s.nodes;
    const original = [...map];
    map.delete(firstCall.id);
    map.set(firstCall.id, firstCall);
    assert.equal(map.size, original.length);
    assert.ok(original.every(([id, node]) => map.get(id) === node));
    assert.notDeepEqual([...map.keys()], original.map(([id]) => id));
    assert.deepEqual(s.parse(entry).nodes, ids);
    assert.throws(() => s.graph([entry]), /supplier graph changed: original source call order/);
    assert.throws(() => s.resolveTargetInputs(target, graph), /supplier graph changed: original source call order/);
    assert.throws(() => s.resolveTargetInputs(target, graph.nodes), /supplier graph changed: original source call order/);
    assert.throws(() => s.instrument(entry, entryBytes), /supplier graph changed: original source call order/);
    assert.throws(() => s.nodes, /supplier graph changed: original source call order/);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('canonical supplier order preserves genuine repeated graph inputs records and instrumentation', () =>
{
    const { s, graph, target, entry, entryBytes } = originalSupplierOrderGraph();
    const before = s.resolveTargetInputs(target, graph);
    const ids = s.parse(entry).nodes.slice();
    const instrumentation = s.instrument(entry, entryBytes);
    const map = s.nodes;
    for (const [id, node] of map)
    {
        map.set(id, node);
    }
    for (let repeat = 0; repeat < 2; repeat++)
    {
        const repeated = s.graph([entry]);
        assert.deepEqual(repeated.errors, []);
        assert.deepEqual(repeated.nodes.map((node) => node.id), graph.nodes.map((node) => node.id));
        assert.deepEqual(s.resolveTargetInputs(target, repeated), before);
        assert.deepEqual(s.resolveTargetInputs(target, repeated.nodes), before);
        assert.deepEqual(s.parse(entry).nodes, ids);
        assert.equal(s.instrument(entry, entryBytes), instrumentation);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    }
});

function originalSupplierReadGraph(unknown = false)
{
    const parent = resolve(directory, randomUUID());
    mkdirSync(parent);
    const owner = resolve(parent, 'Owner.vue');
    const entry = resolve(parent, 'Entry.vue');
    const ownerBytes = '<script setup>const props=defineProps({tag:{type:[String,Object],default:"button"}});</script><template><component :is="tag"/></template>';
    const entryBytes = unknown
        ? '<script setup>import Owner from "./Owner.vue";</script><template><Owner tag="a"/><Owner :tag="unknown"/></template>'
        : '<script setup>import Owner from "./Owner.vue";</script><template><Owner tag="a"/><Owner tag="span"/></template>';
    writeFileSync(owner, ownerBytes);
    writeFileSync(entry, entryBytes);
    const s = source();
    const graph = s.graph([entry]);
    const target = graph.nodes.find((node) => node.file === owner && node.origin.kind === 'native-prop');
    const calls = graph.nodes.filter((node) => node.file === entry && node.definition === owner);
    assert.ok(target);
    assert.equal(calls.length, 2);
    return { s, graph, target, entry, entryBytes, calls };
}

test('canonical supplier reads refuse original values shadow omitting an unknown supplying call', () =>
{
    const { s, graph, target, entry, entryBytes, calls } = originalSupplierReadGraph(true);
    assert.deepEqual(graph.errors.map((error) => error.reason), ['unbound-native-prop-source', 'unbound-target-supplier-source']);
    assert.throws(() => s.resolveTargetInputs(target, graph), /mutable\/unknown component input/);
    assert.throws(() => s.resolveTargetInputs(target, graph.nodes), /mutable\/unknown component input/);
    const recordIds = s.parse(entry).nodes.slice();
    const instrumentation = s.instrument(entry, entryBytes);
    const map = s.nodes;
    const originals = [...Map.prototype.entries.call(map)];
    map.values = function* ()
    {
        yield* [...Map.prototype.values.call(this)].filter((node) => node !== calls[1]);
    };
    assert.equal(map.size, originals.length);
    assert.ok(originals.every(([id, node]) => Map.prototype.get.call(map, id) === node));
    assert.deepEqual([...Map.prototype.keys.call(map)], originals.map(([id]) => id));
    assert.throws(() => s.graph([entry]), /original source node Map observation/);
    assert.throws(() => s.resolveTargetInputs(target, graph), /original source node Map observation/);
    assert.throws(() => s.resolveTargetInputs(target, graph.nodes), /original source node Map observation/);
    assert.throws(() => s.instrument(entry, entryBytes), /original source node Map observation/);
    delete map.values;
    assert.deepEqual(s.parse(entry).nodes, recordIds);
    assert.equal(s.instrument(entry, entryBytes), instrumentation);
    assert.throws(() => s.resolveTargetInputs(target, s.graph([entry])), /mutable\/unknown component input/);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('canonical supplier reads refuse original values shadow reversing genuine supplying calls', () =>
{
    const { s, graph, target, entry, entryBytes } = originalSupplierReadGraph();
    assert.deepEqual(graph.errors, []);
    const inputs = s.resolveTargetInputs(target, graph);
    assert.deepEqual(inputs.map((input) => input.target.name), ['a', 'span']);
    const map = s.nodes;
    const originals = [...Map.prototype.entries.call(map)];
    map.values = function* ()
    {
        yield* [...Map.prototype.values.call(this)].reverse();
    };
    assert.equal(map.size, originals.length);
    assert.ok(originals.every(([id, node]) => Map.prototype.get.call(map, id) === node));
    assert.deepEqual([...Map.prototype.keys.call(map)], originals.map(([id]) => id));
    assert.throws(() => s.graph([entry]), /original source node Map observation/);
    assert.throws(() => s.resolveTargetInputs(target, graph), /original source node Map observation/);
    assert.throws(() => s.resolveTargetInputs(target, graph.nodes), /original source node Map observation/);
    assert.throws(() => s.instrument(entry, entryBytes), /original source node Map observation/);
    delete map.values;
    assert.deepEqual(s.resolveTargetInputs(target, s.graph([entry])), inputs);
});

test('canonical supplier reads reject public Map method iterator getter and prototype overrides before invocation', () =>
{
    for (const property of ['values', 'keys', 'entries', 'get', 'has', 'forEach', 'size', Symbol.iterator, 'prototype'])
    {
        const { s, graph, target, entry, entryBytes } = originalSupplierReadGraph();
        const inputs = s.resolveTargetInputs(target, graph);
        const map = s.nodes;
        let trapCalls = 0;
        const trap = () =>
        {
            trapCalls++;
            throw new Error('public Map read override executed');
        };
        if (property === 'prototype')
        {
            Object.setPrototypeOf(map, { values: trap });
        }
        else
        {
            Object.defineProperty(map, property, { configurable: true, get: trap });
        }
        assert.throws(() => s.graph([entry]), /original source node Map observation/);
        assert.throws(() => s.resolveTargetInputs(target, graph), /original source node Map observation/);
        assert.throws(() => s.resolveTargetInputs(target, graph.nodes), /original source node Map observation/);
        assert.throws(() => s.instrument(entry, entryBytes), /original source node Map observation/);
        assert.throws(() => s.parse(entry), /original source node Map observation/);
        assert.throws(() => s.nodes, /original source node Map observation/);
        assert.equal(trapCalls, 0);
        if (property === 'prototype')
        {
            Object.setPrototypeOf(map, Map.prototype);
        }
        else
        {
            delete map[property];
        }
        assert.deepEqual(s.resolveTargetInputs(target, s.graph([entry])), inputs);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    }
});

test('canonical supplier reads keep detached resolver and file Maps observational while native callbacks remain supported', () =>
{
    const { s, graph, target, entry, entryBytes } = originalSupplierReadGraph();
    const inputs = s.resolveTargetInputs(target, graph);
    const instrumentation = s.instrument(entry, entryBytes);
    const originalRecord = s.resolver.parse(entry);
    const maps = [s.records, originalRecord.imports, originalRecord.variables, originalRecord.registrations, s.resolver.exportsOf(entry)];
    let trapCalls = 0;
    for (const map of maps)
    {
        map.clear();
        for (const property of ['values', 'keys', 'entries', 'get', 'has', 'forEach', 'size', Symbol.iterator])
        {
            Object.defineProperty(map, property, { configurable: true, get: () =>
            {
                trapCalls++;
                throw new Error('detached Map override executed');
            } });
        }
    }
    const map = s.nodes;
    const expected = [...map];
    assert.deepEqual([...map.entries()], expected);
    assert.deepEqual([...map.keys()], expected.map(([id]) => id));
    assert.deepEqual([...map.values()], expected.map(([, node]) => node));
    const callback = { calls: [] };
    map.forEach(function(node, id, observed)
    {
        assert.equal(this, callback);
        assert.equal(observed, map);
        assert.equal(map.get(id), node);
        assert.ok(map.has(id));
        this.calls.push([id, node]);
    }, callback);
    assert.deepEqual(callback.calls, expected);
    assert.equal(map.size, expected.length);
    assert.deepEqual(s.resolveTargetInputs(target, s.graph([entry])), inputs);
    assert.equal(s.instrument(entry, entryBytes), instrumentation);
    assert.equal(trapCalls, 0);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('canonical supplier reads preserve genuine unknown call refusal through repeated original graphs', () =>
{
    const { s, graph, target, entry, entryBytes, calls } = originalSupplierReadGraph(true);
    const errors = graph.errors.map((error) => error.reason);
    const ids = s.parse(entry).nodes.slice();
    assert.deepEqual(ids, calls.map((call) => call.id));
    const instrumentation = s.instrument(entry, entryBytes);
    for (let repeat = 0; repeat < 2; repeat++)
    {
        const repeated = s.graph([entry]);
        assert.deepEqual(repeated.errors.map((error) => error.reason), errors);
        assert.deepEqual(repeated.nodes.map((node) => node.id), graph.nodes.map((node) => node.id));
        assert.throws(() => s.resolveTargetInputs(target, repeated), /mutable\/unknown component input/);
        assert.throws(() => s.resolveTargetInputs(target, repeated.nodes), /mutable\/unknown component input/);
        assert.deepEqual(s.parse(entry).nodes, ids);
        assert.equal(s.instrument(entry, entryBytes), instrumentation);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    }
});

test('canonical supplier reads bind the actual resolver methods and observation getters without replacing registration callbacks', () =>
{
    const { s, graph, target, entry, entryBytes } = originalSupplierReadGraph();
    const inputs = s.resolveTargetInputs(target, graph);
    const instrumentation = s.instrument(entry, entryBytes);
    const identity = s.resolver.identity;
    assert.ok(Object.isFrozen(s.resolver));
    for (const property of ['parse', 'exportsOf', 'sourceBindings', 'addRegistrations', 'identity'])
    {
        assert.throws(() => Object.defineProperty(s.resolver, property, { get: () =>
        {
            throw new Error('forged resolver observation invoked');
        } }), TypeError);
    }
    const temporary = resolve(repositoryRoot, 'src/frontend/src', `module-integration-${randomUUID()}`);
    mkdirSync(temporary);
    try
    {
        const registration = resolve(temporary, 'main.ts');
        writeFileSync(registration, "import {Check} from '@ozwasyd/element-plus/icons-vue';app.component('OriginalCheck', Check);");
        s.resolver.addRegistrations(registration);
        assert.equal(s.resolver.resolveTag(entry, 'OriginalCheck').publicName, 'Check');
        assert.deepEqual(s.resolveTargetInputs(target, s.graph([entry])), inputs);
        assert.equal(s.instrument(entry, entryBytes), instrumentation);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
    assert.deepEqual(s.resolver.identity, identity);
});

test('canonical supplier reads reject shared traversal prototype drift without invoking forged reads', () =>
{
    const { s, graph, target, entry, entryBytes } = originalSupplierReadGraph();
    const inputs = s.resolveTargetInputs(target, graph);
    const instrumentation = s.instrument(entry, entryBytes);
    for (const prototype of [Map.prototype, Set.prototype])
    {
        for (const property of ['values', 'keys', 'entries', 'has', 'forEach', 'size', Symbol.iterator])
        {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
            let trapCalls = 0;
            try
            {
                Object.defineProperty(prototype, property, { configurable: true, get: () =>
                {
                    trapCalls++;
                    throw new Error('shared traversal read override invoked');
                } });
                assert.throws(() => s.graph([entry]), /original source node Map observation traversal prototype/);
                assert.throws(() => s.resolveTargetInputs(target, graph), /original source node Map observation traversal prototype/);
                assert.throws(() => s.resolveTargetInputs(target, graph.nodes), /original source node Map observation traversal prototype/);
                assert.throws(() => s.instrument(entry, entryBytes), /original source node Map observation traversal prototype/);
                assert.throws(() => s.parse(entry), /original source node Map observation traversal prototype/);
                assert.equal(trapCalls, 0);
            }
            finally
            {
                Object.defineProperty(prototype, property, descriptor);
            }
            assert.deepEqual(s.resolveTargetInputs(target, s.graph([entry])), inputs);
            assert.equal(s.instrument(entry, entryBytes), instrumentation);
        }
    }
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

test('canonical framework export binds actual Slider toRefs through public Vue exports and the original ObjectRefImpl setter', () =>
{
    const s = source();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slider/src/slider.vue');
    const callee = frameworkCallee(s, file, 'toRefs', 'props');
    const result = s.resolver.resolveFrameworkExport(file, callee);
    assert.equal(s.resolver.sourceStep(file, callee).offset, 6981);
    assert.equal(result.fn.name.text, 'toRefs');
    assert.ok(result.file.endsWith('/@vue/reactivity/dist/reactivity.esm-bundler.js'));
    assert.deepEqual(result.edges.slice(0, 4).map((edge) => edge.exportedName), ['toRefs', 'toRefs', 'toRefs', 'toRefs']);
    assert.ok(result.edges[0].resolvedFile.endsWith('/vue/dist/vue.runtime.esm-bundler.js'));
    assert.ok(result.edges[1].resolvedFile.endsWith('/@vue/runtime-dom/dist/runtime-dom.esm-bundler.js'));
    assert.ok(result.edges[2].resolvedFile.endsWith('/@vue/runtime-core/dist/runtime-core.esm-bundler.js'));
    const object = result.dependencies.find((entry) => entry.classDeclaration?.name.text === 'ObjectRefImpl');
    assert.ok(object);
    const setter = object.classDeclaration.members.find((member) => s.resolver.ts.isSetAccessorDeclaration(member) && member.name.text === 'value');
    assert.ok(setter.body.getText().includes('this._object[this._key] = newVal'));
    result.edges.forEach((edge) => assert.doesNotThrow(() => s.resolver.sourceStep(edge.file, edge.originalImportOrExportAST)));
    result.dependencies.forEach((entry) => assert.doesNotThrow(() => s.resolver.sourceStep(entry.file, entry.fn ?? entry.classDeclaration)));
    assert.ok(result.inputs.some((entry) => entry.path.endsWith('/vue/package.json')));
    assert.ok(result.inputs.some((entry) => entry.path.endsWith('/@vue/reactivity/package.json')));
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.readonly, undefined);
    assert.ok(result.unresolvedDependencies.some((entry) => entry.name === 'isArray'));
});

test('canonical framework export binds actual useFormItem toRef and preserves original propertyToRef class ownership', () =>
{
    const s = source();
    const file = resolve(fsusUIRoot, 'vue/packages/components/form/src/hooks/use-form-item.ts');
    const callee = frameworkCallee(s, file, 'toRef');
    const result = s.resolver.resolveFrameworkExport(file, callee);
    assert.equal(s.resolver.sourceStep(file, callee).offset, 1531);
    assert.equal(result.fn.name.text, 'toRef');
    assert.ok(result.dependencies.some((entry) => entry.fn?.name?.text === 'propertyToRef'));
    assert.ok(result.dependencies.some((entry) => entry.classDeclaration?.name.text === 'ObjectRefImpl'));
    assert.equal(result.exportIdentity.exportedName, 'toRef');
    assert.equal(result.exportIdentity.sourceKind, 'declared-frontend-public-esm');
    assert.equal(result.qualificationEligible, false);
});

test('canonical framework export rejects synthetic cloned and foreign callee ASTs', () =>
{
    const state = functionPackage();
    const callee = frameworkCallee(state.s, state.file, 'alias');
    const other = functionPackage();
    for (const node of [state.s.expression('alias', state.file), { ...callee }, frameworkCallee(other.s, other.file, 'alias')])
    {
        assert.throws(() => state.s.resolver.resolveFrameworkExport(state.file, node), /unowned source proof node/);
    }
});

test('canonical framework export refuses runtime values absent from real public exports and private entry paths', () =>
{
    const missing = functionPackage(undefined, 'export const unrelated=()=>true;');
    assert.throws(() => missing.s.resolver.resolveFrameworkExport(missing.file, frameworkCallee(missing.s, missing.file, 'alias')), /no actual callable definition/);
    const state = functionPackage();
    const name = state.root.split('/').at(-1);
    const file = fixture(`import {predicate} from '${name}/public.mjs';const x=predicate(1);`, 'ts');
    assert.throws(() => state.s.resolver.resolveFrameworkExport(file, frameworkCallee(state.s, file, 'predicate')), /unavailable public function package/);
});

test('canonical framework export rejects stale original source inputs without inventing new class definitions', () =>
{
    const state = functionPackage();
    const callee = frameworkCallee(state.s, state.file, 'alias');
    state.s.resolver.resolveFrameworkExport(state.file, callee);
    writeFileSync(resolve(state.root, 'public.mjs'), 'export const predicate=()=>true;');
    assert.throws(() => state.s.resolver.resolveFrameworkExport(state.file, callee), /framework export source inputs changed/);
});

test('canonical framework export exposes effectful original bodies without classifying them as readonly', () =>
{
    const state = functionPackage(undefined, 'class Box{set value(input){external.value=input;}}export function predicate(){return new Box();}');
    const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
    assert.ok(result.dependencies.some((entry) => entry.classDeclaration?.name.text === 'Box'));
    assert.equal(result.fn.body.getText(), '{return new Box();}');
    assert.equal(result.readonly, undefined);
    assert.equal(result.qualificationEligible, false);
});

test('canonical framework export rejects a real local callee that shadows its public import', () =>
{
    const state = functionPackage();
    const name = state.root.split('/').at(-1);
    const file = fixture(`import {predicate as alias} from '${name}';function owner(alias){return alias(1);}`, 'ts');
    assert.throws(() => state.s.resolver.resolveFrameworkExport(file, frameworkCallee(state.s, file, 'alias')), /unbound finite component binding/);
});

test('canonical framework export rejects declared signatures without an actual runtime function body', () =>
{
    const state = functionPackage(undefined, 'export declare function predicate():void;');
    assert.throws(() => state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias')), /no actual callable definition/);
});

test('canonical Vue binding exposes the original actual provide inject and reactive imports', () =>
{
    const s = source();
    const files = [
        ['tabs/src/tabs.tsx', 'provide'],
        ['tabs/src/tab-pane.vue', 'inject'],
        ['tabs/src/tab-pane.vue', 'reactive']
    ];
    for (const [path, name] of files)
    {
        const file = resolve(fsusUIRoot, 'vue/packages/components', path);
        const record = s.resolver.parse(file);
        const candidates = [];
        function visit(node)
        {
            if (s.resolver.ts.isCallExpression(node) && s.resolver.ts.isIdentifier(node.expression)
                && record.imports.get(node.expression.text)?.name === name)
            {
                candidates.push(node.expression);
            }
            s.resolver.ts.forEachChild(node, visit);
        }
        record.scripts.forEach(({ ast }) => visit(ast));
        assert.ok(candidates.length);
        candidates.forEach((callee) => assert.equal(s.vueBinding(record, callee, name), true));
    }
});

test('canonical Vue binding preserves actual aliases and rejects a mismatched export or unrelated import', () =>
{
    const file = fixture("import {provide as actual} from 'vue';import {provide as foreign} from 'other';actual(1);foreign(1);", 'ts');
    const s = source();
    const record = s.resolver.parse(file);
    assert.equal(s.vueBinding(record, frameworkCallee(s, file, 'actual'), 'provide'), true);
    assert.equal(s.vueBinding(record, frameworkCallee(s, file, 'actual'), 'inject'), false);
    assert.equal(s.vueBinding(record, frameworkCallee(s, file, 'foreign'), 'provide'), false);
});

test('canonical Vue binding rejects cloned and foreign records and synthetic or cloned callee ASTs', () =>
{
    const file = fixture("import {provide} from 'vue';provide(1);", 'ts');
    const s = source();
    const record = s.resolver.parse(file);
    const callee = frameworkCallee(s, file, 'provide');
    assert.throws(() => s.vueBinding({ ...record }, callee, 'provide'), /foreign Vue binding record/);
    assert.throws(() => s.vueBinding(source().resolver.parse(file), callee, 'provide'), /foreign Vue binding record/);
    for (const value of [{ ...callee }, s.expression('provide', file)])
    {
        assert.throws(() => s.vueBinding(record, value, 'provide'), /unowned source proof node/);
    }
});

test('canonical Vue binding retains the original mutation and shadow rejection', () =>
{
    for (const text of ["import {provide} from 'vue';provide=foreign;provide(1);",
        "import {provide} from 'vue';function owner(provide){provide(1);}"])
    {
        const file = fixture(text, 'ts');
        const s = source();
        assert.throws(() => s.vueBinding(s.resolver.parse(file), frameworkCallee(s, file, 'provide'), 'provide'), /mutated\/shadowed render binding/);
    }
});

test('canonical Vue binding refuses type only imports without manufacturing a runtime export', () =>
{
    for (const text of ["import type {provide} from 'vue';provide(1);", "import {type provide} from 'vue';provide(1);"])
    {
        const file = fixture(text, 'ts');
        const s = source();
        assert.equal(s.vueBinding(s.resolver.parse(file), frameworkCallee(s, file, 'provide'), 'provide'), false);
    }
});

test('canonical Vue binding rejects stale source bytes while retaining the original callee', () =>
{
    const file = fixture("import {provide} from 'vue';provide(1);", 'ts');
    const s = source();
    const record = s.resolver.parse(file);
    const callee = frameworkCallee(s, file, 'provide');
    assert.equal(s.vueBinding(record, callee, 'provide'), true);
    writeFileSync(file, record.content + '\n// changed original source\n');
    assert.throws(() => s.vueBinding(record, callee, 'provide'), /Vue binding source inputs changed/);
});

test('canonical import observation mutation cannot turn an actual foreign callee into Vue provide', () =>
{
    const foreign = fixture('export const foreign=()=>0;', 'ts');
    const file = fixture(`import {foreign as selected} from './${foreign.split('/').at(-1)}';selected();`, 'ts');
    const s = source();
    const record = s.resolver.parse(file);
    const callee = frameworkCallee(s, file, 'selected');
    record.imports.set('selected', { specifier: 'vue', name: 'provide' });
    assert.equal(s.vueBinding(record, callee, 'provide'), false);
    assert.equal(record.imports.get('selected').name, 'foreign');
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('canonical import observation entry mutation cannot substitute a public framework export absent from the original AST', () =>
{
    const state = functionPackage();
    const name = state.root.split('/').at(-1);
    writeFileSync(state.file, `import {absent as alias} from '${name}';alias(1);`);
    const record = state.s.resolver.parse(state.file);
    const callee = frameworkCallee(state.s, state.file, 'alias');
    assert.throws(() =>
    {
        record.imports.get('alias').name = 'predicate';
    }, TypeError);
    assert.equal(record.imports.get('alias').name, 'absent');
    assert.throws(() => state.s.resolver.resolveFrameworkExport(state.file, callee), /no actual callable definition/);
    assert.deepEqual(state.s.resolver.sourceBindings().errors, []);
});

test('canonical import observations retain the actual Vue export after detached map and value writes', () =>
{
    const file = fixture("import {provide as actual} from 'vue';actual(1);", 'ts');
    const s = source();
    const record = s.resolver.parse(file);
    const observation = record.imports;
    assert.throws(() =>
    {
        observation.get('actual').name = 'inject';
    }, TypeError);
    observation.clear();
    assert.equal(record.imports.get('actual'), record.imports.get('actual'));
    const callee = frameworkCallee(s, file, 'actual');
    assert.equal(s.vueBinding(record, callee, 'provide'), true);
    assert.equal(s.vueBinding(record, callee, 'inject'), false);
    assert.throws(() =>
    {
        record.imports = observation;
    }, TypeError);
});

test('canonical parser observations refuse original script syntax and record rewrites before framework binding', () =>
{
    const state = functionPackage();
    const record = state.s.resolver.parse(state.file);
    const callee = frameworkCallee(state.s, state.file, 'alias');
    assert.throws(() =>
    {
        callee.text = 'foreign';
    }, TypeError);
    assert.throws(() => record.scripts[0].ast.statements.pop(), TypeError);
    assert.throws(() =>
    {
        record.file = 'foreign.ts';
    }, TypeError);
    record.variables.set('alias', callee);
    assert.equal(record.variables.has('alias'), false);
    const result = state.s.resolver.resolveFrameworkExport(state.file, callee);
    assert.equal(result.exportIdentity.exportedName, 'predicate');
    assert.equal(result.qualificationEligible, false);
});

test('canonical parser observations refuse a rewritten original template before source call publication', () =>
{
    const leaf = fixture('<template><button/></template>');
    const other = fixture('<template><aside/></template>');
    const outlet = fixture('<script setup>import {RouterView} from "vue-router";</script><template><RouterView v-slot="{Component}"><component :is="Component"/></RouterView></template>');
    const owner = fixture(`<script setup>import Other from './${other.split('/').at(-1)}';import Outlet from './${outlet.split('/').at(-1)}';</script><template><Other/></template>`);
    const router = fixture(`import {createRouter} from 'vue-router';createRouter({routes:[{path:'/',component:()=>import('./${owner.split('/').at(-1)}'),
        children:[{path:'leaf',component:()=>import('./${leaf.split('/').at(-1)}')}]}]});`, 'ts');
    const s = source();
    const record = s.resolver.parse(owner);
    const element = record.template.ast.children.find((node) => node.tag === 'Other');
    assert.throws(() =>
    {
        element.tag = 'Outlet';
    }, TypeError);
    const routes = resolveCompositionRoutes(s, router);
    s.parse(outlet);
    const graph = s.graph([owner], { routes });
    assert.equal(graph.frameworkTargetBindings.length, 0);
    assert.equal(graph.nodes.find((node) => node.file === owner && node.tag === 'Other').definition, other);
});

test('canonical framework dependency follows the actual nested helper instead of borrowing the module helper', () =>
{
    const state = functionPackage(undefined, 'function helper(){return "module";}export function predicate(){function helper(){return "nested";}return helper();}');
    const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
    const definitions = result.dependencies.map((entry) => (entry.fn ?? entry.classDeclaration).getText());
    assert.ok(definitions.includes('function helper(){return "nested";}'));
    assert.ok(!definitions.includes('function helper(){return "module";}'));
    assert.equal(result.qualificationEligible, false);
});

test('canonical framework dependency leaves actual simple and destructured parameters unresolved', () =>
{
    for (const parameter of ['helper', '{helper}', '{value:helper}', '[helper]'])
    {
        const state = functionPackage(undefined, `function helper(){return "module";}export function predicate(${parameter}){return helper();}`);
        const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
        assert.ok(!result.dependencies.some((entry) => entry.fn?.getText() === 'function helper(){return "module";}'));
        const unresolved = result.unresolvedDependencies.find((entry) => entry.name === 'helper');
        assert.ok(unresolved);
        assert.ok(unresolved.binding);
        assert.match(unresolved.reason, /actual lexical parameter/);
    }
});

test('canonical framework dependency retains the nearest actual block function declaration', () =>
{
    const state = functionPackage(undefined, 'function helper(){return "module";}export function predicate(){{function helper(){return "block";}return helper();}}');
    const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
    assert.ok(result.dependencies.some((entry) => entry.fn?.getText() === 'function helper(){return "block";}'));
    assert.ok(!result.dependencies.some((entry) => entry.fn?.getText() === 'function helper(){return "module";}'));
});

test('canonical framework dependency does not borrow a module function through a destructured local binding', () =>
{
    const state = functionPackage(undefined, 'function helper(){return "module";}export function predicate(){const {helper}=unknown;return helper();}');
    const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
    assert.ok(!result.dependencies.some((entry) => entry.fn?.getText() === 'function helper(){return "module";}'));
    assert.ok(result.unresolvedDependencies.some((entry) => entry.name === 'helper' && entry.binding));
});

test('canonical framework dependency preserves a genuine module helper and its original source step', () =>
{
    const state = functionPackage(undefined, 'function helper(){return "module";}export function predicate(){return helper();}');
    const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
    const helper = result.dependencies.find((entry) => entry.fn?.getText() === 'function helper(){return "module";}');
    assert.ok(helper);
    assert.doesNotThrow(() => state.s.resolver.sourceStep(helper.file, helper.fn));
    assert.deepEqual(result.unresolvedDependencies, []);
});

test('canonical framework dependency does not borrow a module helper through a hoisted branch var or switch binding', () =>
{
    for (const body of ['if(flag){var helper=unknown;}return helper();',
        'switch(flag){case 0:const helper=unknown;return helper();}'])
    {
        const state = functionPackage(undefined, `function helper(){return "module";}export function predicate(){${body}}`);
        const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
        assert.ok(!result.dependencies.some((entry) => entry.fn?.getText() === 'function helper(){return "module";}'));
        assert.ok(result.unresolvedDependencies.some((entry) => entry.name === 'helper' && entry.binding));
    }
});

test('canonical framework dependency does not treat a class method name as its lexical callable binding', () =>
{
    const state = functionPackage(undefined, 'function helper(){return "module";}class Box{helper(){return helper();}}export function predicate(){return new Box();}');
    const result = state.s.resolver.resolveFrameworkExport(state.file, frameworkCallee(state.s, state.file, 'alias'));
    assert.ok(result.dependencies.some((entry) => entry.fn?.getText() === 'function helper(){return "module";}'));
    assert.ok(result.dependencies.some((entry) => entry.classDeclaration?.name.text === 'Box'));
});

test('canonical RouterView graph refuses an original Other call definition overwritten with an unrelated Outlet', () =>
{
    const state = routerGraph();
    const other = fixture('<template><aside/></template>');
    writeFileSync(state.owner, `<script setup>import Other from './${other.split('/').at(-1)}';</script><template><Other/></template>`);
    const s = source();
    const router = fixture(`import {createRouter} from 'vue-router';createRouter({routes:[{path:'/',component:()=>import('./${state.owner.split('/').at(-1)}'),
        children:[{path:'leaf',component:()=>import('./${state.leaf.split('/').at(-1)}')}]}]});`, 'ts');
    const routes = resolveCompositionRoutes(s, router);
    const outlet = fixture('<script setup>import {RouterView} from "vue-router";</script><template><RouterView v-slot="{Component}"><component :is="Component"/></RouterView></template>');
    s.parse(outlet);
    const original = s.graph([state.owner]);
    const call = original.nodes.find((node) => node.file === state.owner && node.tag === 'Other');
    assert.equal(call.definition, other);
    call.definition = outlet;
    assert.throws(() => s.graph([state.owner], { routes }), /supplier graph changed: original source call/);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('canonical RouterView direct public binder refuses a rewritten actual component call path', () =>
{
    const { s, routes, owner, outlet } = routerGraph(true);
    const graph = s.graph([owner], { routes });
    const selector = graph.nodes.find((node) => node.file === outlet && node.tag === 'component');
    const call = graph.nodes.find((node) => node.file === owner && node.definition === outlet);
    call.definition = owner;
    assert.throws(() => bindCompositionRouterViewTargets(s, routes, selector, { callPath: [call.id],
        resolveRouterViewSlot: () =>
        {
            throw new Error('forged call must not reach a supplied callback');
        } }), /supplier graph changed/);
});

test('canonical RouterView graph preserves its genuine original source calls across repeated observations', () =>
{
    const { s, routes, owner, outlet } = routerGraph(true);
    for (let index = 0; index < 2; index++)
    {
        const graph = s.graph([owner], { routes });
        assert.equal(graph.frameworkTargetBindings.length, 1);
        assert.equal(graph.frameworkTargetBindings[0].supplier.routeOwner.file, owner);
        assert.ok(graph.nodes.some((node) => node.file === owner && node.definition === outlet));
        assert.equal(graph.frameworkTargetBindings[0].qualificationEligible, false);
    }
});

test('central original graph joins actual RouterView route suppliers while retaining unbound rendered and permission gaps', () =>
{
    const { s, routes, owner, outlet, leaf } = routerGraph();
    const graph = s.graph([owner], { routes });
    assert.equal(graph.frameworkTargetBindings.length, 1);
    const binding = graph.frameworkTargetBindings[0];
    const node = graph.nodes.find((entry) => entry.file === outlet && entry.tag === 'component');
    assert.equal(binding.sourceNode, node.id);
    assert.equal(binding.supplier.routeOwner.file, owner);
    assert.ok(binding.variantDefinitions.includes(leaf));
    assert.ok(graph.files.some((entry) => entry.file === leaf));
    assert.ok(graph.nodes.some((entry) => entry.file === leaf && entry.tag === 'button'));
    assert.equal(binding.runtimeState, 'unbound');
    assert.equal(binding.permissionState, 'unbound');
    assert.equal(binding.qualificationEligible, false);
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source' && error.file === outlet));
});

test('central RouterView graph join follows the actual reusable component call to its original route declared owner', () =>
{
    const { s, routes, owner, outlet } = routerGraph(true);
    const graph = s.graph([owner], { routes });
    assert.equal(graph.frameworkTargetBindings.length, 1);
    const binding = graph.frameworkTargetBindings[0];
    const call = graph.nodes.find((entry) => entry.file === owner && entry.definition === outlet);
    assert.deepEqual(binding.supplier.routeOwner.callPath.map((entry) => entry.id), [call.id]);
    assert.deepEqual(binding.callPath.slice(1), [call.id]);
});

test('central RouterView graph join refuses cloned or foreign route observations without borrowing their suppliers', () =>
{
    const original = routerGraph();
    for (const routes of [structuredClone(original.routes), routerGraph().routes])
    {
        const s = original.s;
        const graph = s.graph([original.owner], { routes });
        assert.equal(graph.frameworkTargetBindings.length, 0);
        assert.ok(graph.errors.some((error) => error.reason === 'unbound-framework-target-source'));
    }
});

test('central RouterView graph without an actual route observation preserves its original unresolved source', () =>
{
    const { s, owner, outlet } = routerGraph();
    const graph = s.graph([owner]);
    assert.deepEqual(graph.frameworkTargetBindings, []);
    assert.ok(graph.errors.some((error) => error.file === outlet && error.reason === 'unknown-component-source'));
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


test('central original native target property cannot borrow another actual prop supplier', () =>
{
    const { s, graph, target, entry } = nativePropertyGraph();
    assert.equal(target.origin.property, 'tag');
    assert.ok(graph.errors.some((error) => error.reason === 'unbound-native-prop-source'));
    assert.throws(() => s.resolveTargetInputs(target, graph), /mutable\/unknown component input/);
    target.origin.property = 'other';
    assert.throws(() => s.graph([entry]), /supplier graph changed: original source call/);
    assert.throws(() => s.nodes, /supplier graph changed: original source call/);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central original native property retains its real supplier across repeated graphs', () =>
{
    const { s, graph, target, entry } = nativePropertyGraph("'a'");
    assert.deepEqual(graph.errors, []);
    const inputs = s.resolveTargetInputs(target, graph);
    assert.deepEqual(inputs.map((input) => input.target), [{ kind: 'native', name: 'a' }]);
    const repeated = s.graph([entry]);
    assert.deepEqual(repeated.errors, []);
    assert.deepEqual(s.resolveTargetInputs(target, repeated), inputs);
    assert.equal(target.origin.property, 'tag');
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

for (const [label, field, value] of [
    ['origin default', 'origin', { kind: 'native-prop', property: 'tag', default: 'a' }],
    ['origin additional values', 'origin', { kind: 'native-prop', property: 'tag', default: 'button', values: ['a'] }],
    ['slot input membership', 'slotInputs', { present: { default: true }, unknown: false }],
    ['conditional paths', 'conditional', [{ name: 'if', expression: 'accepted' }]],
    ['slot identity', 'slot', { name: 'forged' }],
    ['structural flag', 'structural', true],
    ['teleport flag', 'teleport', true],
    ['source syntax', 'sourceSyntax', { kind: 'vue-vnode', markerOffset: 1 }],
    ['render paths', 'renderPaths', [{ parentId: null, ancestors: [], conditional: [] }]],
    ['slot source', 'slotSource', { name: 'forged', steps: [] }],
    ['location line', 'line', -1],
    ['future original observation field', 'futureFact', { accepted: true }]
])
{
    test(`central original complete call snapshot refuses changed ${label}`, () =>
    {
        const { s, target, entry } = nativePropertyGraph("'a'");
        target[field] = value;
        assert.throws(() => s.graph([entry]), /supplier graph changed: original source call/);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    });
}

test('central original call snapshot refuses accessors without invoking caller code', () =>
{
    const { s, target, entry } = nativePropertyGraph("'a'");
    let invoked = 0;
    Object.defineProperty(target.origin, 'property', { enumerable: true, get: () =>
    {
        invoked++;
        return 'tag';
    } });
    assert.throws(() => s.graph([entry]), /supplier graph changed: accessor source call facts/);
    assert.equal(invoked, 0);
});

test('central original call snapshot refuses inherited facts without borrowing a prototype', () =>
{
    const { s, target, entry } = nativePropertyGraph("'a'");
    Object.setPrototypeOf(target.origin, { property: 'other' });
    assert.throws(() => s.graph([entry]), /supplier graph changed: non-data source call facts/);
});

test('central public export map replacement cannot remove actual export star ambiguity', () =>
{
    const { s, actual, ambiguous, entry } = exportStarGraph();
    const observation = s.resolver.exportsOf(ambiguous);
    assert.equal(observation.get('Glyph').ambiguous, true);
    observation.set('Glyph', s.resolver.exportsOf(actual).get('Glyph'));
    assert.equal(s.resolver.exportsOf(ambiguous).get('Glyph').ambiguous, true);
    for (let repeat = 0; repeat < 2; repeat++)
    {
        const graph = s.graph([entry]);
        assert.ok(graph.errors.some((error) => error.reason === 'unknown-component-source' && /ambiguous\/unresolved/.test(error.message)));
        assert.equal(graph.nodes.find((node) => node.file === entry).origin.kind, 'unknown');
    }
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central public export entry writes cannot alter canonical ambiguity or shared origins', () =>
{
    const { s, actual, ambiguous, entry } = exportStarGraph();
    Object.assign(s.resolver.exportsOf(ambiguous).get('Glyph'), s.resolver.exportsOf(actual).get('Glyph'), { ambiguous: false });
    const actualOrigin = s.resolver.exportsOf(actual).get('Glyph');
    actualOrigin.file = ambiguous;
    actualOrigin.name = 'invented';
    assert.equal(s.resolver.exportsOf(ambiguous).get('Glyph').ambiguous, true);
    assert.notEqual(s.resolver.exportsOf(actual).get('Glyph').file, ambiguous);
    assert.ok(s.graph([entry]).errors.some((error) => error.reason === 'unknown-component-source'));
});

test('central public export observations cannot supply traversal state to poison an initial cache', () =>
{
    const { s, ambiguous, second, entry } = exportStarGraph();
    const observation = s.resolver.exportsOf(ambiguous, new Set([second]));
    assert.equal(observation.get('Glyph').ambiguous, true);
    observation.clear();
    assert.equal(s.resolver.exportsOf(ambiguous).get('Glyph').ambiguous, true);
    assert.ok(s.graph([entry]).errors.some((error) => error.reason === 'unknown-component-source'));
});

test('central public export observers preserve the actual shared unambiguous declaration', () =>
{
    const { s, actual, ambiguous, entry } = exportStarGraph(false);
    const original = s.resolver.exportsOf(actual).get('Glyph');
    assert.deepEqual(s.resolver.exportsOf(ambiguous).get('Glyph'), original);
    const observation = s.resolver.exportsOf(ambiguous);
    observation.delete('Glyph');
    original.file = entry;
    original.name = 'invented';
    for (let repeat = 0; repeat < 2; repeat++)
    {
        const graph = s.graph([entry]);
        assert.deepEqual(graph.errors, []);
        const node = graph.nodes.find((node) => node.file === entry);
        assert.equal(node.origin.kind, 'fsusui-public');
        assert.equal(node.origin.publicName, 'Check');
        assert.equal(node.origin.definition, resolve(fsusUIRoot, 'vue/packages/icons-vue/src/components/check.vue'));
    }
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central public identity observations cannot overwrite a subsequent actual export identity', () =>
{
    const s = source();
    const original = s.resolver.publicIdentity('@ozwasyd/element-plus/icons-vue', 'Check');
    const expected = structuredClone(original);
    original.definition = fixture('<template><a/></template>');
    original.publicName = 'Invented';
    original.exportName = 'invented';
    assert.deepEqual(s.resolver.publicIdentity('@ozwasyd/element-plus/icons-vue', 'Check'), expected);
    const entry = fixture('<script setup>import {Check} from "@ozwasyd/element-plus/icons-vue";</script><template><Check/></template>');
    const graph = s.graph([entry]);
    assert.deepEqual(graph.errors, []);
    assert.deepEqual(graph.nodes.find((node) => node.file === entry).origin, expected);
});

test('central registered identity observations cannot overwrite the original app registration', () =>
{
    const temporary = resolve(repositoryRoot, 'src/frontend/src', `module-integration-${randomUUID()}`);
    mkdirSync(temporary);
    try
    {
        const registration = resolve(temporary, 'main.ts');
        writeFileSync(registration, 'import {Check} from "@ozwasyd/element-plus/icons-vue";app.component("ActualGlyph",Check);');
        const entry = fixture('<template><ActualGlyph/></template>');
        const s = source();
        s.resolver.addRegistrations(registration);
        const observation = s.resolver.resolveTag(entry, 'ActualGlyph');
        const expected = structuredClone(observation);
        observation.definition = entry;
        observation.publicName = 'Invented';
        assert.deepEqual(s.resolver.resolveTag(entry, 'ActualGlyph'), expected);
        const graph = s.graph([entry]);
        assert.deepEqual(graph.errors, []);
        assert.deepEqual(graph.nodes.find((node) => node.file === entry).origin, expected);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('central resolver identity and source input observations cannot rewrite private metadata baselines', () =>
{
    const s = source();
    const expected = s.resolver.identity;
    assert.ok(expected.resolutionInputs.length > 0);
    const observation = s.resolver.identity;
    observation.resolutionInputs[0].digest = 'forged';
    observation.resolutionInputs.length = 0;
    observation.upstream.commit = 'forged';
    assert.deepEqual(s.resolver.identity, expected);
    const inputs = s.resolver.sourceBindings();
    const original = structuredClone(inputs);
    inputs.files[0].digest = 'forged';
    inputs.files.length = 0;
    assert.deepEqual(s.resolver.sourceBindings(), original);
    assert.deepEqual(s.graph([fixture('<template><button/></template>')]).errors, []);
});

test('central detached public package metadata observations cannot hide real source drift', () =>
{
    const state = functionPackage();
    state.resolve();
    const metadataFile = resolve(state.root, 'package.json');
    const changed = JSON.stringify({ name: state.root.split('/').at(-1), exports: { '.': './foreign.mjs' } });
    const observation = state.s.resolver.sourceBindings();
    assert.ok(observation.files.some((input) => input.path === metadataFile));
    writeFileSync(metadataFile, changed);
    observation.files.find((input) => input.path === metadataFile).digest = controlDigest(changed);
    const identity = state.s.resolver.identity;
    identity.resolutionInputs.find((input) => input.path === metadataFile).digest = controlDigest(changed);
    assert.ok(state.s.resolver.sourceBindings().errors.some((error) => error.path === metadataFile));
});

test('central original call facts refuse byte identical nested object replacements', () =>
{
    const { s, target, entry } = nativePropertyGraph("'a'");
    target.origin = structuredClone(target.origin);
    assert.throws(() => s.graph([entry]), /supplier graph changed: original source call object identity/);
});

test('central original call facts refuse a proxy replacement before invoking caller traps', () =>
{
    const { s, target, entry } = nativePropertyGraph("'a'");
    let invoked = 0;
    target.origin = new Proxy(target.origin, { get: () =>
    {
        invoked++;
        return 'other';
    }, ownKeys: () =>
    {
        invoked++;
        return [];
    }, getPrototypeOf: () =>
    {
        invoked++;
        return Object.prototype;
    } });
    assert.throws(() => s.graph([entry]), /supplier graph changed: original source call object identity/);
    assert.equal(invoked, 0);
});

for (const [label, field, value] of [
    ['structural suppression', 'structural', true],
    ['invented marker identity', 'id', 'invented'],
    ['marker offset', 'offset', 0],
    ['source syntax', 'sourceSyntax', { kind: 'vue-vnode', markerOffset: 1 }],
    ['call origin', 'origin', { kind: 'framework-structure', package: 'vue', publicName: 'template' }],
    ['slot inputs', 'slotInputs', { present: { default: true }, unknown: false }]
])
{
    test(`central instrumentation refuses changed original ${label}`, () =>
    {
        const s = source();
        const code = '<template><button/></template>';
        const file = fixture(code);
        const graph = s.graph([file]);
        assert.deepEqual(graph.errors, []);
        graph.nodes[0][field] = value;
        assert.throws(() => s.instrument(file, code), /supplier graph changed: original source call/);
        assert.deepEqual(s.resolver.sourceBindings().errors, []);
    });
}

test('central probe plugin refuses original call mutation without a repeated graph', () =>
{
    const s = source();
    const code = '<template><button/></template>';
    const file = fixture(code);
    const graph = s.graph([file]);
    graph.nodes[0].id = 'invented';
    assert.throws(() => compositionProbePlugin(s).transform(code, file), /supplier graph changed: original source call/);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central instrumentation refuses removed call membership before reading markers', () =>
{
    const s = source();
    const code = '<template><button/></template>';
    const file = fixture(code);
    const graph = s.graph([file]);
    const node = graph.nodes[0];
    const observation = s.nodes;
    observation.delete(node.id);
    assert.throws(() => s.instrument(file, code), /original source call membership/);
    observation.set(node.id, node);
    assert.ok(s.instrument(file, code).includes(`data-fsus-composition-node="${node.id}"`));
});

test('central instrumentation refuses changed original file membership and digest observations', () =>
{
    for (const field of ['nodes', 'digest'])
    {
        const s = source();
        const code = '<template><button/></template>';
        const file = fixture(code);
        s.graph([file]);
        const record = s.parse(file);
        record[field] = field === 'nodes' ? [] : controlDigest(code + ' ');
        assert.throws(() => s.instrument(file, code), /supplier graph changed: original source (call object identity|record)/);
        assert.throws(() => s.graph([file]), /supplier graph changed: original source (call object identity|record)/);
    }
});

test('central public file map observations cannot replace original parser records', () =>
{
    const s = source();
    const code = '<template><button/></template>';
    const file = fixture(code);
    const graph = s.graph([file]);
    const observation = s.records;
    observation.set(file, { file, nodes: [], digest: controlDigest(code) });
    observation.clear();
    assert.equal(s.records.get(file), s.parse(file));
    assert.ok(s.instrument(file, code).includes(`data-fsus-composition-node="${graph.nodes[0].id}"`));
    assert.deepEqual(s.graph([file]).errors, []);
});

test('central fresh and repeated template instrumentation retain actual IDs and structural filtering', () =>
{
    const s = source();
    const code = '<template><template v-if="visible"><button/></template></template>';
    const file = fixture(code);
    const first = s.instrument(file, readFileSync(file, 'utf8'));
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    const button = graph.nodes.find((node) => node.tag === 'button');
    const structural = graph.nodes.find((node) => node.structural);
    assert.ok(button && structural);
    assert.ok(first.includes(`data-fsus-composition-node="${button.id}"`));
    assert.ok(!first.includes(`data-fsus-composition-call="${structural.id}"`));
    assert.equal(s.instrument(file, code), first);
    assert.equal(compositionProbePlugin(s).transform(code, file).code, first);
    assert.throws(() => s.instrument(file, first), /source changed before instrumentation/);
    assert.equal(s.instrument(file, code), first);
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central repeated JSX and canonical Vue vnode instrumentation preserve original parser locations', () =>
{
    for (const text of [
        'import {defineComponent} from "vue";export default defineComponent({setup(){return()=> <button/>;}});',
        'import {defineComponent,h} from "vue";export default defineComponent({setup(){return()=>h("button",{},"Actual");}});'
    ])
    {
        const s = source();
        const file = fixture(text, 'tsx');
        const graph = s.graph([file]);
        assert.deepEqual(graph.errors, []);
        const button = graph.nodes.find((node) => node.tag === 'button');
        assert.ok(button);
        const actual = s.instrument(file, text);
        assert.ok(actual.includes(button.id));
        assert.ok(actual.includes('data-fsus-composition-node'));
        assert.equal(compositionProbePlugin(s).transform(text, file).code, actual);
        assert.equal(s.instrument(file, text), actual);
        assert.deepEqual(s.graph([file]).errors, []);
    }
});

test('central instrumentation refuses unchanged argument bytes after the authored file drifts', () =>
{
    const s = source();
    const code = '<template><button/></template>';
    const file = fixture(code);
    s.graph([file]);
    writeFileSync(file, code + ' ');
    assert.throws(() => s.instrument(file, code), /supplier source changed: original source call/);
    assert.ok(s.resolver.sourceBindings().errors.some((error) => error.path === file));
    writeFileSync(file, code);
    assert.ok(s.instrument(file, code).includes('data-fsus-composition-node'));
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central unsupported bare functional h shape retains its inherited explicit effects refusal', () =>
{
    const file = fixture('import {h} from "vue";export default()=>h("button",{});', 'ts');
    const graph = source().graph([file]);
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-ast-parse' && /unbound functional call effects/.test(error.message)));
});

test('central canonical collection instance retains its original methods for both public and render consumers', () =>
{
    const s = source();
    const original = s.collectionSource;
    assert.equal(s.collectionSource, original);
    assert.ok(Object.isFrozen(original));
    assert.throws(() =>
    {
        original.collect = () => ({ outputs: [], accepted: true });
    }, TypeError);
    const file = fixture('import {defineComponent} from "vue";export default defineComponent({setup(){return()=>[1,2].map(item=><button>{item}</button>);}});', 'tsx');
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.nodes.find((node) => node.tag === 'button').renderPaths.length, 2);
});

test('central canonical collection receiver references preserve plain assignment without fabricating getter reads', () =>
{
    const s = source();
    const text = 'const callback=(item,other)=>{let alias=other;(alias=item,alias).marks=1;};';
    const file = fixture(text, 'ts');
    const fn = s.resolver.parse(file).variables.get('callback');
    const effect = s.collectionSource.callbackEffects(file, fn);
    assert.ok(effect.references.some((entry) => entry.kind === 'property-reference' && entry.path?.join('.') === 'item.marks'));
    assert.ok(effect.writes.some((entry) => entry.path?.join('.') === 'item.marks'));
    assert.ok(!effect.reads.some((entry) => entry.path?.join('.') === 'item.marks'));
    assert.ok(effect.references.every((entry) => entry.file === file && entry.digest.length === 64 && entry.runtimeIdentityProven === false));
    const { proofDigest, ...payload } = effect;
    assert.equal(proofDigest, controlDigest(payload));
    assert.notEqual(proofDigest, controlDigest({ ...payload, references: [] }));
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('central canonical collection source retains every receiver alternative at one original call site', () =>
{
    const s = source();
    const file = fixture('const callback=(item,other)=>{(flag?item:other).send();};', 'ts');
    const fn = s.resolver.parse(file).variables.get('callback');
    const effect = s.collectionSource.callbackEffects(file, fn);
    assert.deepEqual(effect.calls.map((entry) => entry.path), [['item', 'send'], ['other', 'send']]);
    assert.deepEqual(effect.escapes.filter((entry) => entry.kind === 'method-receiver').map((entry) => entry.path), [['item', 'send'], ['other', 'send']]);
    assert.equal(new Set(effect.calls.map((entry) => entry.offset)).size, 1);
    assert.equal(new Set(effect.calls.map((entry) => entry.digest)).size, 1);
    assert.ok(effect.calls.every((entry) => entry.file === file && entry.runtimeIdentityProven === false));
    const { proofDigest, ...payload } = effect;
    assert.equal(proofDigest, controlDigest(payload));
    assert.notEqual(proofDigest, controlDigest({ ...payload, calls: payload.calls.slice(0, 1) }));
    assert.notEqual(proofDigest, controlDigest({ ...payload, escapes: payload.escapes.slice(0, 1) }));
});

test('central canonical collection assignment preserves the original receiver across RHS rebinding', () =>
{
    const s = source();
    const file = fixture('const callback=(item,other)=>{let alias=other;alias.marks=(alias=item,1);};', 'ts');
    const fn = s.resolver.parse(file).variables.get('callback');
    const effect = s.collectionSource.callbackEffects(file, fn);
    assert.deepEqual(effect.writes.filter((entry) => entry.path?.length === 2).map((entry) => entry.path), [['other', 'marks']]);
    assert.ok(!effect.reads.some((entry) => entry.path?.length === 2));
    assert.ok(effect.references.some((entry) => entry.path?.join('.') === 'other.marks' && entry.kind === 'property-reference'));
    assert.ok(effect.writes.filter((entry) => entry.path?.length === 2).every((entry) => entry.runtimeIdentityProven === false));
});
