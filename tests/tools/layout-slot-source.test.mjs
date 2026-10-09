import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

import { createCompositionSlotSource } from '../frontend/support/layout/compositionSlotSource.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
const parserRoot = process.env.FSUSBLOG_PARSER_ROOT ?? repositoryRoot;
assert.ok(fsusUIRoot, 'actual canonical FsusUI source is required');
const directory = resolve(repositoryRoot, '.tmp', `slot-source-${randomUUID()}`);
test.before(() => mkdirSync(directory, { recursive: true }));
test.after(() => rmSync(directory, { recursive: true, force: true }));

function fixture(content, name = `${randomUUID()}.tsx`)
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
function tools()
{
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
    return { source, slots: createCompositionSlotSource({ source }) };
}
function expressionProof(content)
{
    const { source, slots } = tools();
    const file = fixture(content);
    const node = source.resolver.parse(file).variables.get('result');
    assert.ok(node, 'ordinary control has an actual result initializer');
    return slots.proveValue({ file, node });
}
function find(source, file, predicate)
{
    const matches = [];
    const visit = (node) =>
    {
        if (predicate(node))
        {
            matches.push(node);
        }
        source.resolver.ts.forEachChild(node, visit);
    };
    source.resolver.parse(file).scripts.forEach(({ ast }) => visit(ast));
    assert.equal(matches.length, 1, 'actual canonical AST selection must be unique');
    return matches[0];
}
function slotFixture(markup = '<button title="Original">Child</button>', definition)
{
    const { source, slots } = tools();
    const owner = definition ?? fixture('import {defineComponent} from "vue";export default defineComponent({setup(_, {slots}) {return () => slots.default?.();}});');
    const file = fixture(`<script setup>import Owner from ${JSON.stringify(owner)};</script><template><Owner>${markup}</Owner></template>`, `${randomUUID()}.vue`);
    // Canonical local resolution accepts relative source imports only.
    writeFileSync(file, readFileSync(file, 'utf8').replace(JSON.stringify(owner), JSON.stringify('./' + owner.split('/').at(-1))));
    const graph = source.graph([file]);
    const call = graph.nodes.find((node) => node.file === file && node.tag === 'Owner');
    assert.ok(call);
    return { source, slots, graph, call, owner };
}

test('ordinary slot supplier binds actual parent and original native child', () =>
{
    const { slots, graph, call } = slotFixture();
    const proof = slots.bindSlot({ graph, callNode: call.id });
    assert.equal(proof.callNode, call.id);
    assert.deepEqual(proof.callPath, [call.id]);
    assert.equal(proof.value.kind, 'template-slot');
    assert.ok(proof.steps.some((step) => step.kind === 'template-source'));
    assert.equal(proof.inputDigest.length, 64);
    assert.equal(proof.proofDigest.length, 64);
});

test('ordinary slot invocation retains child identity without borrowing parent identity', () =>
{
    const { source, slots, graph, call, owner } = slotFixture();
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'default');
    const binding = slots.bindSlot({ graph, callNode: call.id });
    const proof = slots.invokeSlot({ graph, binding, file: owner, invocation });
    assert.equal(proof.value[0].target.kind, 'native');
    assert.equal(proof.value[0].target.name, 'button');
    assert.notDeepEqual(proof.value[0].target, call.origin);
    assert.equal(proof.value[0].sourceNode, graph.nodes.find((node) => node.tag === 'button').id);
    assert.ok(proof.resolverInputs.some((input) => input.path === owner));
});

test('ordinary callback binds actual destructured payload and every executed return', () =>
{
    const proof = expressionProof('import {h} from "vue";const slots={cell:({label})=>{const title=label;return h("button",{title},[]);}};const result=slots.cell({label:"Actual"});');
    assert.equal(proof.value.target.name, 'button');
    assert.equal(proof.value.props.title, 'Actual');
    assert.equal(proof.effects.length, 1);
    assert.deepEqual(proof.effects[0].parameters, ['{label}']);
    assert.ok(proof.effects[0].argumentsDigest.length === 64);
});

test('ordinary callback uses runtime literal condition rather than its annotation', () =>
{
    const proof = expressionProof('import {h} from "vue";const cell=(active:boolean):any=>active?h("button",{},[]):h("span",{},[]);const result=cell(false);');
    assert.equal(proof.value.target.name, 'span');
});

test('ordinary local helper dependency chain includes actual reexported function source', () =>
{
    const { source, slots } = tools();
    const helper = fixture('import {h} from "vue";export function child({label}){return h("button",{title:label},[]);}', 'ChildHelper.ts');
    const exports = fixture('export {child as render} from "./ChildHelper";', 'ChildExports.ts');
    const file = fixture('import {render} from "./ChildExports";const result=render({label:"Actual"});');
    const proof = slots.proveValue({ file, node: source.resolver.parse(file).variables.get('result') });
    assert.equal(proof.value.props.title, 'Actual');
    assert.ok([helper, exports, file].every((path) => proof.resolverInputs.some((input) => input.path === path)));
    assert.ok(proof.steps.some((step) => step.file === helper));
});

test('ordinary clone retains original public component and permits own literal title', () =>
{
    const proof = expressionProof('import {h,cloneVNode} from "vue";import {FsusTaskPageHeader as Original} from "@ozwasyd/element-plus";const firstLegitNode=h(Original,{title:"Before"},[]);const attrs={title:"After"};const result=cloneVNode(firstLegitNode!,attrs);');
    assert.equal(proof.value.target.kind, 'fsusui-public');
    assert.equal(proof.value.target.publicName, 'FsusTaskPageHeader');
    assert.equal(proof.value.props.title, 'After');
    assert.equal(proof.value.clones.length, 1);
    assert.ok(proof.value.definition.endsWith('/task-page-header/src/task-page-header.vue'));
});

test('ordinary clone and readonly directive hooks preserve native original identity', () =>
{
    const proof = expressionProof('import {h,cloneVNode,withDirectives} from "vue";const firstLegitNode=h("button",{},[]);const attrs={title:"Actual"};const forwardRefDirective={mounted(){},updated(){},unmounted(){}};const result=withDirectives(cloneVNode(firstLegitNode!,attrs),[[forwardRefDirective]]);');
    assert.equal(proof.value.target.kind, 'native');
    assert.equal(proof.value.target.name, 'button');
    assert.equal(proof.effects.length, 3);
});

test('ordinary clone rejects unknown attrs despite an object annotation', () =>
{
    assert.throws(() => expressionProof('import {h,cloneVNode} from "vue";declare const attrs:Record<string,string>;const firstLegitNode=h("button",{},[]);const result=cloneVNode(firstLegitNode,attrs);'), /unknown runtime value|unbound source constant/);
});

test('ordinary clone rejects spreads reserved props refs and opaque event effects', () =>
{
    for (const attrs of ['{...unknown}', '{type:"PublicHeader"}', '{ref:"borrowed"}', '{key:"borrowed"}',
        '{"data-fsus-composition-call":"borrowed"}', '{onClick:()=>unknown()}', '{class:"borrowed"}', '{style:{display:"none"}}'])
    {
        assert.throws(() => expressionProof(`import {h,cloneVNode} from "vue";const firstLegitNode=h("button",{},[]);const result=cloneVNode(firstLegitNode,${attrs});`), /unknown attrs|reserved property|unproved clone prop/);
    }
});

test('ordinary clone rejects mutated VNodes and aggregate aliases', () =>
{
    for (const mutation of ['firstLegitNode.type="section";', 'const alias=[firstLegitNode];alias[0].type="section";',
        'const alias={child:firstLegitNode};alias.child.props.title="Changed";'])
    {
        assert.throws(() => expressionProof(`import {h,cloneVNode} from "vue";const firstLegitNode=h("button",{},[]);${mutation}const result=cloneVNode(firstLegitNode,{title:"Actual"});`), /unbound finite component binding/);
    }
});

test('ordinary callback rejects opaque calls and source array mutation', () =>
{
    for (const body of ['opaque(children);return children;', 'children.push(h("span",{},[]));return children;',
        'children[0].props.title="Changed";return children;'])
    {
        assert.throws(() => expressionProof(`import {h} from "vue";const callback=(children:VNode[])=>{${body}};const result=callback([h("button",{},[])]);`), /unknown runtime|mutated source array|mutated source binding/);
    }
});

test('ordinary source value rejects an escaped array even when its initializer is closed', () =>
{
    assert.throws(() => expressionProof('import {h} from "vue";const children=[h("button",{},[])];opaque(children);const result=children;'), /unproved source escape/);
});

test('ordinary callback rejects function name and VNode annotation as runtime authority', () =>
{
    assert.throws(() => expressionProof('function findFirstLegitChild(children:VNode[]):VNode{return unknown(children);}const result=findFirstLegitChild([]);'), /unknown runtime value/);
    assert.throws(() => expressionProof('const result=({cell:(props:TableV2RowCellRenderParam):VNode=>opaque(props)});'), /actual invocation/);
});

test('ordinary callback rejects shadowed Vue APIs and component imports', () =>
{
    assert.throws(() => expressionProof('import {h,cloneVNode} from "vue";function helper(cloneVNode){return cloneVNode(h("button",{},[]),{});}const result=helper(()=>null);'), /shadowed source binding/);
    assert.throws(() => expressionProof('import {h} from "vue";import {FsusTaskPageHeader as Header} from "@ozwasyd/element-plus";const callback=(Header)=>h(Header,{},[]);const result=callback("button");'), /shadowed source binding/);
});

test('ordinary callback rejects private public-package imports', () =>
{
    assert.throws(() => expressionProof('import {h} from "vue";import Header from "@ozwasyd/element-plus/es/components/task-page-header";const result=h(Header,{},[]);'), /private|absent|unresolved|unknown/);
});

test('ordinary callback rejects fallthrough rest defaults and asynchronous output', () =>
{
    for (const declaration of ['const callback=()=>{};', 'const callback=(...args)=>null;',
        'const callback=(value=unknown)=>null;', 'const callback=async()=>null;'])
    {
        assert.throws(() => expressionProof(`${declaration}const result=callback();`), /fall through|parameters|async|default/);
    }
});

test('ordinary directive rejects opaque setter and unknown lifecycle payload', () =>
{
    assert.throws(() => expressionProof('import {h,withDirectives} from "vue";const directive={mounted(el){setForwardRef(el);}};const result=withDirectives(h("button",{},[]),[[directive]]);'), /unproved directive effect/);
    assert.throws(() => expressionProof('import {h,withDirectives} from "vue";const result=withDirectives(h("button",{},[]),[[opaqueDirective]]);'), /unknown runtime value/);
});

test('ordinary supplier rejects scoped conditional dynamic and opaque template inputs', () =>
{
    for (const markup of ['<template #default="scope"><button/></template>', '<template #default v-if="active"><button/></template>',
        '<template #[slotName]><button/></template>', '<button v-bind="attrs"/>', '{{unknownVNode}}'])
    {
        const { slots, graph, call } = slotFixture(markup);
        assert.throws(() => slots.bindSlot({ graph, callNode: call.id }), /unbound|unproved|opaque/);
    }
});

test('actual Options supplier retains unproved helper escape without blessing returned children', () =>
{
    const { source, slots } = tools();
    const options = resolve(fsusUIRoot, 'vue/packages/components/select/src/options.ts');
    const owner = fixture(readFileSync(options, 'utf8'));
    const file = fixture(`<script setup>import Owner from "./${owner.split('/').at(-1)}";</script><template><Owner><div><button>Choice</button></div></Owner></template>`, `${randomUUID()}.vue`);
    const graph = source.graph([file]);
    const call = graph.nodes.find((node) => node.tag === 'Owner');
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'default' && ts.isIdentifier(node.expression.expression));
    const binding = slots.bindSlot({ graph, callNode: call.id });
    assert.equal(binding.callNode, call.id);
    assert.throws(() => slots.invokeSlot({ graph, binding, file: owner, invocation }), /unproved source escape/);
    assert.ok(graph.errors.some((error) => error.message?.includes('escaped script render constant')));
    const helperCall = find(source, owner, (node) => ts.isCallExpression(node) && node.expression.getText() === 'filterOptions'
        && node.arguments[0]?.getText() === 'children[0]?.children');
    assert.throws(() => slots.proveValue({ file: owner, node: helperCall }), /unknown runtime value.*slots/);
});

test('actual OnlyChild clone and directive expression retains unresolved supplier context', () =>
{
    const { source, slots } = tools();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slot/src/only-child.tsx');
    const ts = source.resolver.ts;
    const node = find(source, file, (candidate) => ts.isCallExpression(candidate)
        && candidate.expression.getText() === 'withDirectives');
    assert.throws(() => slots.proveValue({ file, node }), /unknown runtime value.*slots/);
});

test('actual OnlyChild helper source is not admitted by its VNode return annotation', () =>
{
    const { source, slots } = tools();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slot/src/only-child.tsx');
    const ts = source.resolver.ts;
    const helper = find(source, file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'findFirstLegitChild');
    assert.throws(() => slots.proveValue({ file, node: helper }), /unknown source value\/effects/);
});

test('actual TableV2 scoped slot objects retain pending callbacks and runtime spreads', () =>
{
    const { source, slots } = tools();
    const file = resolve(fsusUIRoot, 'vue/packages/components/table-v2/src/table-v2.tsx');
    const record = source.resolver.parse(file);
    const node = record.variables.get('tableSlots');
    assert.ok(node);
    assert.throws(() => slots.proveValue({ file, node }), /actual invocation/);
    const ts = source.resolver.ts;
    const row = find(source, file, (candidate) => ts.isPropertyAssignment(candidate) && candidate.name?.getText() === 'row'
        && ts.isArrowFunction(candidate.initializer) && candidate.initializer.parameters[0]?.type?.getText() === 'TableGridRowSlotParams');
    assert.throws(() => slots.proveValue({ file, node: row.initializer.body }), /unknown attrs or spread/);
});

test('actual AutoResizer slot payload retains unresolved reactive width and height', () =>
{
    const { source, slots } = tools();
    const file = resolve(fsusUIRoot, 'vue/packages/components/table-v2/src/components/auto-resizer.tsx');
    const ts = source.resolver.ts;
    const invocation = find(source, file, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'default');
    assert.throws(() => slots.proveValue({ file, node: invocation.arguments[0] }), /unknown runtime value.*height/);
});

test('ordinary local source increment does not modify canonical graph errors or product evidence', () =>
{
    const { slots, graph, call } = slotFixture();
    const before = JSON.stringify(graph);
    slots.bindSlot({ graph, callNode: call.id });
    assert.equal(JSON.stringify(graph), before);
    assert.equal('fullGeometryVerified' in graph, false);
});

function actualOptions(markup, mutation = null)
{
    const { source, slots } = tools();
    const original = resolve(fsusUIRoot, 'vue/packages/components/select/src/options.ts');
    const owner = mutation ? fixture(mutation(readFileSync(original, 'utf8'))) : original;
    const importPath = relative(directory, owner).replaceAll('\\', '/');
    const file = fixture(`<script setup>import Owner from "${importPath.startsWith('.') ? importPath : './' + importPath}";import {ElOption as Option} from "@ozwasyd/element-plus";</script><template><Owner>${markup}</Owner></template>`, `${randomUUID()}.vue`);
    const graph = source.graph([file]);
    const call = graph.nodes.find((node) => node.file === file && node.tag === 'Owner');
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node) && node.expression.getText() === 'filterOptions'
        && node.arguments[0]?.getText() === 'children[0]?.children');
    return { source, slots, graph, call, owner, invocation, original };
}

test('actual Options nested helper proves finite native descendants and readonly callbacks', () =>
{
    const { slots, graph, call, owner, invocation, original } = actualOptions('<div><section><button>Choice</button></section></div>');
    const errors = JSON.stringify(graph.errors);
    const proof = slots.proveHelperCall({ graph, callNode: call.id, file: owner, invocation });
    assert.equal(proof.proofScope, 'helper-invocation');
    assert.deepEqual(proof.value, { absent: true });
    assert.equal(proof.supplierValue[0].target.name, 'div');
    assert.equal(proof.supplierValue[0].children[0].target.name, 'section');
    assert.ok(proof.effects.length >= 3);
    assert.ok(proof.steps.some((entry) => entry.file === original && entry.offset === invocation.getStart()));
    assert.equal(JSON.stringify(graph.errors), errors);
});

test('actual Options label helper proves declared component runtime name and scratch append', () =>
{
    const { slots, graph, call, owner, invocation } = actualOptions('<div><Option label="Actual" value="literal"/></div>');
    const proof = slots.proveHelperCall({ graph, callNode: call.id, file: owner, invocation });
    assert.deepEqual(proof.scratchValues, [['Actual']]);
    assert.equal(proof.supplierValue[0].children[0].target.publicName, 'ElOption');
    assert.ok(proof.effects.some((effect) => effect.kind === 'local-scratch-append'));
    assert.ok(proof.steps.some((entry) => entry.file.endsWith('/select/src/option.vue')));
    const multiple = actualOptions('<div><Option label="A" value="a"/><Option label="B" value="b"/></div>');
    const collected = multiple.slots.proveHelperCall({ graph: multiple.graph, callNode: multiple.call.id, file: multiple.owner, invocation: multiple.invocation });
    assert.deepEqual(collected.scratchValues, [['A', 'B']]);
});

test('actual Options helper mutation of supplied children remains rejected', () =>
{
    const { slots, graph, call, owner, invocation } = actualOptions('<div><button>Choice</button></div>', (text) =>
        text.replace(';(children as VNode[]).forEach((item) => {', ';(children as VNode[]).forEach((item) => { children.push(item);'));
    assert.throws(() => slots.proveHelperCall({ graph, callNode: call.id, file: owner, invocation }), /mutated source array/);
});

test('ordinary lexical nested helper separates captured collection from same named parameter', () =>
{
    const proof = expressionProof('import {h} from "vue";const render=()=>{const children=[h("button",{},[])];function identity(children:VNode[]){return children;}return identity(children);};const result=render();');
    assert.equal(proof.value[0].target.name, 'button');
    assert.equal(proof.effects.length, 2);
});

test('actual Options comparison helper binds array entries and runtime inequality', () =>
{
    const { source } = tools();
    const file = resolve(fsusUIRoot, 'vue/packages/components/select/src/options.ts');
    const ts = source.resolver.ts;
    const helper = find(source, file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'isSameOptions');
    assert.equal(expressionProof(`${helper.getText()}const result=isSameOptions(["Actual"],["Actual"]);`).value, true);
    assert.equal(expressionProof(`${helper.getText()}const result=isSameOptions(["Actual"],["Different"]);`).value, false);
});

test('ordinary helper rejects counterfeit array methods and scratch VNode aliases', () =>
{
    assert.throws(() => expressionProof('const Array={isArray:()=>true};const result=Array.isArray({});'), /shadowed\/unknown Array intrinsic/);
    assert.throws(() => expressionProof('const array={forEach:(callback)=>callback(null)};const result=array.forEach(()=>null);'), /opaque collection method/);
    assert.throws(() => expressionProof('import {h} from "vue";const render=()=>{const scratch=[];scratch.push(h("button",{},[]));return h("div",{},[]);};const result=render();'), /unproved scratch payload alias/);
    assert.throws(() => expressionProof('import {h} from "vue";const render=()=>{const children=[];children.push("Changed");return children;};const result=render();'), /mutated source array/);
});


test('ordinary lexical callback rejects borrowed captured value under a block shadow', () =>
{
    assert.throws(() => expressionProof('const helper=(label)=>{if(true){const label=opaque();return label;}return label;};const result=helper("Actual");'), /unknown runtime value.*opaque/);
    assert.equal(expressionProof('const helper=(label)=>{if(true){const label="Own";return label;}return label;};const result=helper("Borrowed");').value, 'Own');
});

test('ordinary runtime component name rejects an unrelated defineComponent declaration', () =>
{
    const child = fixture('import {defineComponent} from "vue";const decoy=defineComponent({name:"ElOption"});export default defineComponent({setup(){return()=>null;}});');
    assert.throws(() => expressionProof(`import {h} from "vue";import Child from "./${child.split('/').at(-1)}";const result=h(Child,{},[]).type.name;`), /ambiguous component runtime name/);
});


function scriptSlotFixture(output = 'h("button",{title:label},[])', payload = '{label:"Actual"}', mutation = '', imports = '')
{
    const { source, slots } = tools();
    const owner = fixture(`import {defineComponent} from "vue";export default defineComponent({setup(_, {slots}){return()=>slots.cell?.(${payload});}});`);
    const file = fixture(`${imports}import {defineComponent,h} from "vue";import Owner from "./${owner.split('/').at(-1)}";export default defineComponent({setup(){const slotObject={cell:({label})=>${output}};${mutation}return()=> <Owner>{slotObject}</Owner>;}});`);
    const graph = source.graph([file]);
    const call = graph.nodes.find((entry) => entry.file === file && entry.tag === 'Owner');
    assert.ok(call, 'canonical graph contains actual JSX owner call');
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'cell');
    return { source, slots, graph, call, owner, file, invocation };
}

test('ordinary JSX scoped slot object binds actual supplier and component payload', () =>
{
    const { slots, graph, call, owner, file, invocation } = scriptSlotFixture();
    const errors = JSON.stringify(graph.errors);
    const binding = slots.bindSlot({ graph, callNode: call.id, name: 'cell' });
    assert.equal(binding.proofScope, 'slot-supplier-binding');
    assert.equal(binding.callbackPending, true);
    assert.equal(binding.value.file, file);
    const proof = slots.invokeSlot({ graph, binding, file: owner, invocation });
    assert.equal(proof.value.target.name, 'button');
    assert.equal(proof.value.props.title, 'Actual');
    assert.equal(proof.supplierProofDigest, binding.proofDigest);
    assert.ok(proof.steps.some((entry) => entry.file === file));
    assert.ok(proof.steps.some((entry) => entry.file === owner));
    assert.equal(JSON.stringify(graph.errors), errors);
});

test('ordinary JSX slot callback preserves own public component instead of supplier owner', () =>
{
    const { slots, graph, call, owner, invocation } = scriptSlotFixture('h(Child,{title:label},[])', undefined, '', 'import {FsusTaskPageHeader as Child} from "@ozwasyd/element-plus";');
    const binding = slots.bindSlot({ graph, callNode: call.id, name: 'cell' });
    const proof = slots.invokeSlot({ graph, binding, file: owner, invocation });
    assert.equal(proof.value.target.publicName, 'FsusTaskPageHeader');
    assert.notEqual(proof.value.definition, owner);
    assert.equal(proof.value.props.title, 'Actual');
});

test('ordinary JSX slot object rejects mutated supplier and opaque callback effects', () =>
{
    const mutated = scriptSlotFixture(undefined, undefined, 'slotObject.cell=opaque;');
    assert.throws(() => mutated.slots.bindSlot({ graph: mutated.graph, callNode: mutated.call.id, name: 'cell' }), /mutated|unbound finite component binding/);
    const opaque = scriptSlotFixture('opaque(label)');
    const binding = opaque.slots.bindSlot({ graph: opaque.graph, callNode: opaque.call.id, name: 'cell' });
    assert.throws(() => opaque.slots.invokeSlot({ graph: opaque.graph, binding, file: opaque.owner, invocation: opaque.invocation }), /unknown runtime value.*opaque/);
    const unknown = scriptSlotFixture(undefined, '{label:measurement.value}');
    const unknownBinding = unknown.slots.bindSlot({ graph: unknown.graph, callNode: unknown.call.id, name: 'cell' });
    assert.throws(() => unknown.slots.invokeSlot({ graph: unknown.graph, binding: unknownBinding, file: unknown.owner, invocation: unknown.invocation }), /unknown runtime value.*measurement/);
});


test('actual AutoResizer JSX supplier binds while original measurement payload remains unknown', () =>
{
    const { source, slots } = tools();
    const owner = resolve(fsusUIRoot, 'vue/packages/components/table-v2/src/components/auto-resizer.tsx');
    const importPath = relative(directory, owner).replaceAll('\\', '/');
    const file = fixture(`import {defineComponent,h} from "vue";import Auto from "${importPath}";export default defineComponent({setup(){return()=> <Auto>{{default:({height,width})=>h("div",{title:width},[])}}</Auto>;}});`);
    const graph = source.graph([file]);
    const call = graph.nodes.find((entry) => entry.file === file && entry.tag === 'Auto');
    assert.equal(call.definition, owner);
    const before = JSON.stringify(graph.errors);
    const binding = slots.bindSlot({ graph, callNode: call.id });
    assert.equal(binding.callbackPending, true);
    assert.equal(binding.value.file, file);
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node) && node.expression.getText() === 'slots.default');
    assert.throws(() => slots.invokeSlot({ graph, binding, file: owner, invocation }), /unknown runtime value.*height/);
    assert.equal(JSON.stringify(graph.errors), before);
});


test('ordinary unbound setup parameter rejects borrowed outer constant identity', () =>
{
    assert.throws(() => expressionProof('import {h} from "vue";const label="Borrowed";function setup(label){const result=h("button",{title:label},[]);}'), /unknown runtime value.*label.*unbound lexical parameter/);
    assert.equal(expressionProof('import {h} from "vue";const label="Borrowed";const helper=(label)=>h("button",{title:label},[]);const result=helper("Own");').value.props.title, 'Own');
});

test('ordinary aggregate escape rejects nested supplied arrays and original VNodes', () =>
{
    for (const aggregate of ['{children}', '[children]', '{nested:{children}}'])
    {
        assert.throws(() => expressionProof(`import {h} from "vue";const children=[h("button",{},[])];opaque(${aggregate});const result=children;`), /unproved source escape/);
    }
    assert.throws(() => expressionProof('import {h,cloneVNode} from "vue";const original=h("button",{},[]);opaque({original});const result=cloneVNode(original,{title:"Own"});'), /unproved source escape/);
    assert.throws(() => expressionProof('import {h} from "vue";const children=[h("button",{},[])];new Opaque({children});const result=children;'), /unproved source escape/);
});

test('ordinary defineOptions runtime name uses actual macro AST and preserves local identity', () =>
{
    const child = fixture('<script setup>defineOptions({name:"ElOption"});</script><template><button/></template>', `${randomUUID()}.vue`);
    const proof = expressionProof(`import {h} from "vue";import Child from "./${child.split('/').at(-1)}";const original=h(Child,{},[]);const result={name:original.type.name,original};`);
    assert.equal(proof.value.name, 'ElOption');
    assert.equal(proof.value.original.target.kind, 'local');
    assert.equal(proof.value.original.definition, child);
    assert.equal('publicName' in proof.value.original.target, false);
    const unknown = fixture('<script setup>defineOptions({name:unknownName});</script><template><button/></template>', `${randomUUID()}.vue`);
    assert.throws(() => expressionProof(`import {h} from "vue";import Child from "./${unknown.split('/').at(-1)}";const result=h(Child,{},[]).type.name;`), /unknown runtime value.*unknownName/);
});

test('ordinary helper capture accepts initialized child and rejects temporal dead zone', () =>
{
    assert.equal(expressionProof('import {h} from "vue";const helper=()=>child;const child=h("button",{},[]);const result=helper();').value.target.name, 'button');
    assert.equal(expressionProof('import {h} from "vue";const render=()=>{function helper(){return child;}const child=h("button",{},[]);return helper();};const result=render();').value.target.name, 'button');
    assert.throws(() => expressionProof('import {h} from "vue";const render=()=>{const helper=()=>child;const output=helper();const child=h("button",{},[]);return output;};const result=render();'), /unbound source constant.*child/);
});


test('probe setup parameter cannot borrow outer same-name constant', () =>
{
    const { source, slots } = tools();
    const owner = fixture('import {defineComponent} from "vue";export default defineComponent({setup(_, {slots}){return()=>slots.cell?.({});}});', 'ProbeOwner.tsx');
    const supplier = fixture('import {defineComponent,h} from "vue";import Owner from "./ProbeOwner";const label="Borrowed";export default defineComponent({setup(label){const slotObject={cell:(_)=>h("button",{title:label},[])};return()=> <Owner>{slotObject}</Owner>;}});', 'ProbeSupplier.tsx');
    const graph = source.graph([supplier]);
    const call = graph.nodes.find((entry) => entry.file === supplier && entry.tag === 'Owner');
    assert.ok(call);
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'cell');
    assert.throws(() =>
    {
        const binding = slots.bindSlot({ graph, callNode: call.id, name: 'cell' });
        return slots.invokeSlot({ graph, binding, file: owner, invocation });
    }, /unknown|unbound/);
});

test('probe inline aggregate source escape cannot bless children', () =>
{
    for (const argument of ['{children}', '[children]'])
    {
        assert.throws(() => expressionProof(`import {h} from "vue";const children=[h("button",{},[])];opaque(${argument});const result=children;`), /unproved source escape|unknown/);
    }
});

test('probe source mutation through inline aggregate escapes cannot bless clones', () =>
{
    assert.throws(() => expressionProof('import {h,cloneVNode} from "vue";const original=h("button",{},[]);opaque({original});const result=cloneVNode(original,{title:"A"});'), /unproved source escape|unknown/);
});

test('probe inline array source escape cannot bless children', () =>
{
    assert.throws(() => expressionProof('import {h} from "vue";const children=[h("button",{},[])];opaque([children]);const result=children;'), /unproved source escape|unknown/);
});

test('probe script setup defineOptions runtime name comes from owned AST', () =>
{
    const child = fixture('<script setup>defineOptions({name:"ElOption"});</script><template><button/></template>', `${randomUUID()}.vue`);
    assert.equal(expressionProof(`import {h} from "vue";import Child from "./${child.split('/').at(-1)}";const result=h(Child,{},[]).type.name;`).value, 'ElOption');
});

test('probe nested helper evaluates captured locals in each invocation frame', () =>
{
    const proof = expressionProof('const render=(label)=>{function helper(){return child;}const child=label;return helper();};const result=[render("A"),render("B")];');
    assert.deepEqual(proof.value, ['A', 'B']);
});


test('boundary top-level lazy dependency must reject pre-initialization helper call', () =>
{
    assert.throws(() => expressionProof('const helper=()=>child;const before=helper();const child="A";const result=before;'), /unbound source constant.*child/);
    assert.throws(() =>
    {
        const helper = () => child;
        const before = helper();
        const child = 'A';
        return before;
    }, ReferenceError);
    assert.throws(() => expressionProof('const helper=()=>child;const before=helper();const child="A";const result=[child,before];'), /unbound source constant.*child/);
    assert.equal(expressionProof('const helper=()=>child;const child="A";const before=helper();const result=before;').value, 'A');
});

function factorySlotFixture(setupLocal = false, label = '"A"', callback = 'h("button",{title:label},[])')
{
    const { source, slots } = tools();
    const owner = fixture('import {defineComponent} from "vue";export default defineComponent({setup(_, {slots}){return()=>slots.cell?.({});}});');
    const factory = setupLocal ? `const make=(label)=>{return {cell:(_)=>${callback}};};` : `const make=(label)=>({cell:(_)=>${callback}});`;
    const file = fixture(`import {defineComponent,h} from "vue";import Owner from "./${owner.split('/').at(-1)}";${setupLocal ? '' : factory}export default defineComponent({setup(){${setupLocal ? factory : ''}const slotObject=make(${label});return()=> <Owner>{slotObject}</Owner>;}});`);
    const graph = source.graph([file]);
    const call = graph.nodes.find((entry) => entry.file === file && entry.tag === 'Owner');
    assert.ok(call);
    const ts = source.resolver.ts;
    const invocation = find(source, owner, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'cell');
    return { source, slots, graph, call, file, owner, invocation };
}

test('boundary supplier factory must preserve captured parent parameter across invokeSlot context', () =>
{
    const { slots, graph, call, owner, invocation, file } = factorySlotFixture();
    const binding = slots.bindSlot({ graph, callNode: call.id, name: 'cell' });
    const proof = slots.invokeSlot({ graph, binding, file: owner, invocation });
    assert.equal(proof.value.props.title, 'A');
    assert.equal(proof.value.target.kind, 'native');
    assert.equal(proof.value.target.name, 'button');
    assert.ok(proof.steps.some((entry) => entry.file === file));
    assert.ok(proof.effects.some((effect) => effect.parameters?.[0] === 'label'));
});

test('boundary setup-local factory preserves captured parent frame across slot invocation', () =>
{
    const { slots, graph, call, owner, invocation } = factorySlotFixture(true);
    const binding = slots.bindSlot({ graph, callNode: call.id, name: 'cell' });
    assert.equal(binding.callbackPending, true);
    const proof = slots.invokeSlot({ graph, binding, file: owner, invocation });
    assert.equal(proof.value.props.title, 'A');
    assert.equal(proof.supplierProofDigest, binding.proofDigest);
});

test('ordinary finite slot factory rejects unknown inputs and deferred opaque effects', () =>
{
    const unknown = factorySlotFixture(false, 'unknownLabel');
    assert.throws(() => unknown.slots.bindSlot({ graph: unknown.graph, callNode: unknown.call.id, name: 'cell' }), /unknown runtime value.*unknownLabel/);
    const opaque = factorySlotFixture(true, undefined, 'opaque(label)');
    const binding = opaque.slots.bindSlot({ graph: opaque.graph, callNode: opaque.call.id, name: 'cell' });
    assert.equal(binding.callbackPending, true);
    assert.throws(() => opaque.slots.invokeSlot({ graph: opaque.graph, binding, file: opaque.owner, invocation: opaque.invocation }), /unknown runtime value.*opaque/);
});
