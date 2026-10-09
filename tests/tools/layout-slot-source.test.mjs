import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        assert.throws(() => expressionProof(`import {h,cloneVNode} from "vue";const firstLegitNode=h("button",{},[]);${mutation}const result=cloneVNode(firstLegitNode,{title:"Actual"});`), /mutated source binding/);
    }
});

test('ordinary callback rejects opaque calls and source array mutation', () =>
{
    for (const body of ['opaque(children);return children;', 'children.push(h("span",{},[]));return children;',
        'children[0].props.title="Changed";return children;'])
    {
        assert.throws(() => expressionProof(`import {h} from "vue";const callback=(children:VNode[])=>{${body}};const result=callback([h("button",{},[])]);`), /unknown runtime|unknown runtime field|mutated source binding/);
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
    assert.throws(() => slots.invokeSlot({ graph, binding, file: owner, invocation }), /shadowed source binding|unproved source escape/);
    assert.ok(graph.errors.some((error) => error.message?.includes('escaped script render constant')));
    const helperCall = find(source, owner, (node) => ts.isCallExpression(node) && node.expression.getText() === 'filterOptions'
        && node.arguments[0]?.getText() === 'children[0]?.children');
    assert.throws(() => slots.proveValue({ file: owner, node: helperCall }), /shadowed source binding/);
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
