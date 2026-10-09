import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
// The package export remains the central owner's write scope. Load the exact
// new source file for ordinary module controls without installing an alternate
// package manifest, parser, resolver, or test runner.
const { createCompositionCollectionSource } = await import(pathToFileURL(resolve(repositoryRoot,
    'tests/frontend/support/layout/compositionCollectionSource.mjs')).href);
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
const parserRoot = process.env.FSUSBLOG_PARSER_ROOT || repositoryRoot;
assert.ok(fsusUIRoot, 'the actual original FsusUI checkout is required');
const directory = resolve(tmpdir(), `fsus-collection-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
// Only this invocation's UUID directory is removed. No checkout or dependency
// cleanup, Git mutation, subprocess, browser or receipt hooks are installed.
test.after(() => rmSync(directory, { recursive: true, force: true }));

function fixture(content, name = 'Owner.tsx')
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
function context()
{
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
    return { source, module: createCompositionCollectionSource(source), ts: source.resolver.ts };
}
function find(record, predicate, ts)
{
    const found = [];
    function visit(node)
    {
        if (predicate(node))
        {
            found.push(node);
        }
        ts.forEachChild(node, visit);
    }
    record.scripts.forEach(({ ast }) => visit(ast));
    assert.ok(found.length, 'a nonempty actual AST selection is required');
    return found;
}
function local(body, output = 'children')
{
    const state = context();
    const file = fixture(`function render(){${body}return ${output};}`);
    const record = state.source.resolver.parse(file);
    const returned = find(record, (node) => state.ts.isReturnStatement(node) && node.expression?.getText() === output, state.ts).at(-1);
    return { ...state, file, record, expression: returned.expression };
}
function collection(body, output)
{
    const state = local(body, output);
    return state.module.collect(state.file, state.expression);
}
function reject(body, output = 'children')
{
    assert.throws(() => collection(body, output), /composition-collection-source|control-legality/u);
}
function emptyFixture({ helper = 'if(!props.marks){return [];}return props.marks;', input = '', ownerExtra = '', helperImports = "import {computed} from 'vue';" } = {})
{
    fixture(`${helperImports}export const select=(props)=>{return computed(()=>{${helper}});};`, 'helper.ts');
    const owner = fixture(`<script setup>import {select} from './helper';const props=defineProps({marks:Object});${ownerExtra}const values=select(props);</script><template><div/></template>`, 'Owner.vue');
    const entry = fixture(`<script setup>import Owner from './Owner.vue';</script><template><Owner ${input}/></template>`, 'Entry.vue');
    const state = context();
    const graph = state.source.graph([entry]);
    const componentCall = graph.nodes.find((node) => node.definition === owner);
    assert.ok(componentCall, 'original graph call identity is required');
    const record = state.source.resolver.parse(owner);
    const call = record.variables.get('values');
    return { ...state, file: owner, call, componentCall, graph };
}

test('collection literals preserve every original element AST and canonical input digest', () =>
{
    const result = collection("const children=['first','second'];");
    assert.deepEqual(result.outputs.map(({ node }) => node.getText()), ["'first'", "'second'"]);
    assert.ok(result.inputs.some((input) => input.path.endsWith('/Owner.tsx')));
    assert.equal(result.proofDigest.length, 64);
});

test('collection element steps equal the original canonical sourceStep interface', () =>
{
    const state = local("const children=['first','second'];");
    const result = state.module.collect(state.file, state.expression);
    assert.deepEqual(result.elements.map((element) => element.source), result.outputs.map(({ node }) => state.source.resolver.sourceStep(state.file, node)));
});

test('named collection callback uses the original immutable source function binding', () =>
{
    const state = local("const callback=(item)=><div>{item}</div>;const children=['a'].map(callback);");
    const call = state.record.variables.get('children');
    const canonical = state.source.resolver.resolveSourceFunction(state.file, call.arguments[0]);
    const result = state.module.collect(state.file, state.expression);
    assert.equal(result.outputs[0].node, canonical.fn.body);
    assert.equal(result.outputs[0].bindings.get('item').node.text, 'a');
    assert.equal(result.effects[0].proofDigest.length, 64);
});

test('collection branches retain both alternatives and ordered condition source identities', () =>
{
    const result = collection("const children=flag ? ['yes'] : ['no'];");
    assert.deepEqual(result.outputs.map(({ conditions }) => conditions.map(({ name, expression }) => [name, expression])),
        [[['if', 'flag']], [['else', 'flag']]]);
});

test('fresh array push preserves statement order and nested branch conditions', () =>
{
    const result = collection("const children=[];if(outer){if(inner)children.push('first');else children.push('second');}children.push('last');");
    assert.deepEqual(result.outputs.map(({ node }) => node.getText()), ["'first'", "'second'", "'last'"]);
    assert.deepEqual(result.outputs[0].conditions.map(({ expression }) => expression), ['outer', 'inner']);
    assert.equal(result.outputs[1].conditions[1].name, 'else');
    assert.equal(result.effects.length, 3);
});

test('finite scalar map retains actual callback reads and element bindings without executing it', () =>
{
    const result = collection("const children=['a','b'].map((item,index)=><div>{item}</div>);");
    assert.equal(result.outputs.length, 2);
    assert.equal(result.outputs[1].bindings.get('item').node.text, 'b');
    assert.equal(result.outputs[1].bindings.get('index').index, 1);
    assert.equal(result.effects[0].writes.length, 0);
});

test('finite filter preserves the authored predicate for every supplied scalar element', () =>
{
    const result = collection("const children=['a','b'].filter(item=>item==='a');");
    assert.equal(result.outputs.length, 2);
    assert.ok(result.outputs.every(({ conditions }) => conditions[0].expression === "item==='a'"));
});

test('authored missing input proves only its empty computed branch and retains the provided body', () =>
{
    const state = emptyFixture();
    const result = state.module.emptyComputedCall(state.file, state.call, state.componentCall);
    assert.equal(result.empty, true);
    assert.equal(result.providedBranch.renderProven, false);
    assert.equal(result.providedBranch.steps.length, 1);
    assert.equal(result.condition.expression, '!props.marks');
    assert.deepEqual(result.callPath, [state.componentCall.id]);
    assert.equal(result.inputDigests[0].length, 64);
});

test('actual Slider helper retains its no-marks branch and complete nonempty supplier source', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slider/src/slider.vue');
    const call = state.source.resolver.parse(file).variables.get('markList');
    const result = state.module.computedBranches(file, call);
    assert.ok(result.target.file.endsWith('/slider/src/composables/use-marks.ts'));
    assert.equal(result.condition.expression, '!props.marks');
    assert.equal(result.property, 'marks');
    assert.equal(result.providedBranch.steps.length, 2);
    assert.equal(result.providedBranch.renderProven, false);
    assert.ok(result.inputs.some((input) => input.path === file));
    assert.ok(result.effects.reads.some((entry) => entry.path?.join('.') === 'props.marks.*'));
});

test('actual Slider callers have three absent marks inputs but escaped setup props remain rejected', () =>
{
    const state = context();
    const entry = resolve(repositoryRoot, 'src/frontend/src/components/ui/ImageUploadOptionsPanel.vue');
    const slider = resolve(fsusUIRoot, 'vue/packages/components/slider/src/slider.vue');
    const graph = state.source.graph([entry]);
    const calls = graph.nodes.filter((node) => node.file === entry && node.definition === slider);
    assert.equal(calls.length, 3);
    const call = state.source.resolver.parse(slider).variables.get('markList');
    for (const supplied of calls)
    {
        assert.ok(!Object.hasOwn(supplied.attributes, 'marks'));
        assert.ok(supplied.directives.every((entry) => entry.argument !== 'marks'));
        assert.throws(() => state.module.emptyComputedCall(slider, call, supplied), /escaped collection binding/u);
    }
    // This source-only test must not erase the original resolver's remaining
    // opaque Marker label errors or claim any runtime/geometry qualification.
    assert.ok(graph.errors.some((entry) => entry.file?.endsWith('/slider/src/marker.ts')));
});

test('actual TabNav callback retains pane reads index writes slot calls and event escapes', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/tabs/src/tab-nav.tsx');
    const record = state.source.resolver.parse(file);
    const callback = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'props.panes.map', state.ts)[0].arguments[0];
    const result = state.module.callbackEffects(file, callback);
    assert.ok(result.reads.some((entry) => entry.path?.join('.') === 'pane.slots.label'));
    assert.ok(result.reads.some((entry) => entry.path?.join('.') === 'pane.props.label'));
    assert.ok(result.writes.some((entry) => entry.path?.join('.') === 'pane.index'));
    assert.ok(result.calls.some((entry) => entry.expression === 'pane.slots.label'));
    assert.ok(result.escapes.some((entry) => entry.path?.[0] === 'pane' && entry.kind === 'call-argument'));
    assert.ok(result.escapes.some((entry) => entry.path?.[0] === 'pane' && entry.kind === 'callback-capture'));
});

test('actual Tabs panes supplier resolves the original hook and retains runtime identity mutations', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/tabs/src/tabs.tsx');
    const record = state.source.resolver.parse(file);
    const call = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'useOrderedChildren', state.ts)[0];
    const result = state.module.supplier(file, call.expression);
    assert.ok(result.file.endsWith('/hooks/use-ordered-children/index.ts'));
    assert.ok(result.effects.writes.some((entry) => entry.path?.join('.') === 'children.*'));
    assert.ok(result.effects.writes.some((entry) => entry.path?.join('.') === 'orderedChildren.value'));
    assert.ok(result.effects.calls.some((entry) => entry.expression === 'getOrderedChildren'));
    assert.ok(result.functions.some((entry) => entry.name === 'getOrderedChildren'));
    assert.ok(result.functions.some((entry) => entry.name === 'flattedChildren'));
    assert.ok(result.unresolved.some((entry) => entry.expression === 'shallowRef'));
    assert.equal(result.renderProven, false);
});

test('actual Pagination navigation push plan retains every supplied child and branch', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/pagination/src/pagination.ts');
    const record = state.source.resolver.parse(file);
    const use = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'h'
        && node.arguments[2]?.getText() === 'navigationChildren', state.ts)[0].arguments[2];
    const result = state.module.collect(file, use);
    assert.equal(result.outputs.length, 5);
    assert.deepEqual(result.outputs.map(({ conditions }) => conditions.at(-1).expression),
        ["requested.has('prev')", "requested.has('pager')", "requested.has('pager')", "requested.has('pager')", "requested.has('next')"]);
    assert.equal(result.effects.length, 3);
    assert.ok(result.outputs[0].node.getText() === 'TEMPLATE_MAP.prev');
});

test('actual Pagination information callback and root class helper retain unresolved effects', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/pagination/src/pagination.ts');
    const record = state.source.resolver.parse(file);
    const information = record.variables.get('informationChildren');
    assert.throws(() => state.module.collect(file, information), /unbound collection callback read/u);
    const helper = find(record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'addClass', state.ts)[0];
    const effects = state.module.callbackEffects(file, helper);
    assert.deepEqual(effects.writes.map((entry) => entry.path), [['element', 'props'], ['element', 'props', 'class']]);
    const root = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'h'
        && node.arguments[2]?.getText() === 'rootChildren', state.ts)[0].arguments[2];
    assert.throws(() => state.module.collect(file, root), /deferred collection write/u);
    const render = find(record, (node) => state.ts.isArrowFunction(node) && state.ts.isReturnStatement(node.parent)
        && state.ts.isBlock(node.body) && node.body.getText().includes('const rootChildren'), state.ts)[0];
    const construction = state.module.callbackEffects(file, render);
    assert.deepEqual(construction.calls.filter((entry) => entry.expression === 'rootChildren.push')
        .flatMap((entry) => entry.arguments.map((argument) => argument.expression)), ['TEMPLATE_MAP[c]', 'rightWrapperRoot']);
    assert.ok(construction.calls.some((entry) => entry.expression === 'addClass'
        && entry.arguments[0].expression === 'rootChildren[0]'));
});

test('collection rejects an opaque input despite a readonly VNode array annotation', () => reject('const children=unknown as readonly VNode[];'));
test('collection rejects reassignment of a const array element', () => reject("const children=['safe'];children[0]=unknown;"));
test('collection rejects a mutated let array', () => reject("let children=['safe'];children=[];"));
test('collection rejects deleting a supplied element', () => reject("const children=['safe'];delete children[0];"));
test('collection rejects an opaque mutating array method', () => reject("const children=['safe'];children.reverse();"));
test('collection rejects a direct escaped array', () => reject("const children=['safe'];foreign(children);"));
test('collection rejects an aliased array', () => reject("const children=['safe'];const alias=children;foreign(alias);"));
test('collection rejects an array identity escaped through a containing array', () => reject("const children=['safe'];const box=[children];foreign(box);"));
test('collection rejects an array identity assigned to an outer binding', () => reject("const children=['safe'];outside=children;"));
test('collection rejects a deferred callback push', () => reject("const children=[];const callback=()=>children.push(unknown);"));
test('collection rejects a push after its output use', () => reject("const children=[];return children;children.push(unknown);"));
test('collection rejects a sparse authored array', () => reject('const children=[,];'));
test('collection rejects a spread of an opaque array', () => reject('const children=[...unknown];'));
test('collection rejects a shadowed array binding', () => reject("const children=['safe'];function other(){const children=[unknown];}"));
test('collection rejects an array borrowed from another function scope', () => reject("function other(){const children=['safe'];}"));
test('collection rejects an array borrowed from an expired block scope', () => reject("if(flag){const children=['safe'];}"));
test('collection map rejects unknown runtime item identity', () => reject('const children=unknown.map(item=><div/>);'));
test('collection map rejects a supplied object item identity', () => reject('const children=[{label:unknown}].map(item=><div>{item.label}</div>);'));
test('collection map rejects callback writes', () => reject("const children=['safe'].map(item=>{item.label=unknown;return <div/>;});"));
test('collection map rejects callback escape to an opaque call', () => reject("const children=['safe'].map(item=>foreign(item));"));
test('collection map rejects an opaque captured member read', () => reject("const children=['safe'].map(item=>unknown.value);"));
test('collection map rejects nested event callback item capture', () => reject("const children=['safe'].map(item=><div onClick={()=>foreign(item)}/>);"));
test('collection map rejects callback alias capture', () => reject("const children=['safe'].map(item=>{const alias=item;return <div onClick={()=>alias}/>;});"));
test('collection map rejects index inference across conditional suppliers', () => reject("const children=(flag?['a']:['b','c']).map((item,index)=><div>{index}</div>);"));
test('collection map rejects index inference after a conditional filter', () => reject("const children=['a','b'].filter(item=>flag).map((item,index)=><div>{index}</div>);"));
test('collection map rejects an opaque callback even for an empty input', () => reject('const children=[].map(unknown);'));
test('collection map rejects a mutated named callback through canonical immutability', () => reject("const callback=item=><div/>;callback=unknown;const children=['a'].map(callback);"));
test('collection map rejects a callback borrowed from another lexical scope', () => reject("function other(){const callback=item=><div/>;}const children=['a'].map(callback);"));
test('collection map rejects order dependent callback statements', () => reject("const children=['safe'].map(item=>{if(flag)return <div/>;return unknown;});"));

test('empty collection input rejects a supplied nonempty opaque label', () =>
{
    const state = emptyFixture({ input: ':marks="{0:{label:unknown}}"' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /provided\/opaque collection input/u);
});
test('empty collection input rejects a supplied empty object rather than infer absence', () =>
{
    const state = emptyFixture({ input: ':marks="{}"' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /provided\/opaque collection input/u);
});
test('empty collection input rejects an opaque spread', () =>
{
    const state = emptyFixture({ input: 'v-bind="unknown"' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /provided\/opaque collection input/u);
});
test('empty collection input rejects escaped caller props', () =>
{
    const state = emptyFixture({ ownerExtra: 'foreign(props);' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /escaped collection binding/u);
});
test('empty collection input rejects mutated helper props', () =>
{
    const state = emptyFixture({ helper: 'if(!props.marks){return [];}props.marks=unknown;return props.marks;' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /mutated helper collection props/u);
});
test('empty collection input rejects a prior mutation before the no-marks guard', () =>
{
    const state = emptyFixture({ helper: 'props.marks=unknown;if(!props.marks){return [];}return props.marks;' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /no authored first empty branch/u);
});
test('empty collection input rejects an earlier opaque return before the no-marks guard', () =>
{
    const state = emptyFixture({ helper: 'if(flag)return unknown;if(!props.marks){return [];}return props.marks;' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /no authored first empty branch/u);
});
test('empty collection input rejects a fake computed constructor', () =>
{
    const state = emptyFixture({ helperImports: 'const computed=foreign;' });
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, state.componentCall), /unknown computed constructor/u);
});
test('empty collection input rejects a copied canonical call identity', () =>
{
    const state = emptyFixture();
    assert.throws(() => state.module.emptyComputedCall(state.file, state.call, { ...state.componentCall }), /unbound canonical component call/u);
});
test('collection proof rejects changed parsed input bytes', () =>
{
    const state = local("const children=['safe'];");
    writeFileSync(state.file, readFileSync(state.file, 'utf8') + '\n// changed\n');
    assert.throws(() => state.module.collect(state.file, state.expression), /changed canonical inputs/u);
});
test('collection rejects AST nodes created outside the original parser records', () =>
{
    const state = local('const children=[];');
    assert.throws(() => state.module.collect(state.file, state.ts.factory.createArrayLiteralExpression([])), /unowned source proof node/u);
});

function actualPagination(input = 'layout="prev, pager, next"')
{
    const state = context();
    const entry = fixture(`<script setup>import {ElPagination} from '@ozwasyd/element-plus';</script><template><ElPagination ${input}/></template>`, 'PaginationEntry.vue');
    const file = resolve(fsusUIRoot, 'vue/packages/components/pagination/src/pagination.ts');
    const graph = state.source.graph([entry]);
    const componentCall = graph.nodes.find((node) => node.file === entry && node.definition === file);
    assert.ok(componentCall, 'actual Pagination call required');
    const record = state.source.resolver.parse(file);
    const loop = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'components.forEach', state.ts)[0];
    const helper = find(record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'addClass', state.ts)[0];
    const uses = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'addClass', state.ts);
    const bindings = new Map(uses.map((use) => [use.expression, { file, fn: helper, name: 'addClass' }]));
    return { ...state, file, record, loop, componentCall, bindings };
}
function partitionFixture({ input = 'layout="a, ->, b"', change = (value) => value } = {})
{
    const file = fixture(change(`import {defineComponent,h} from 'vue';
const ownerProps={layout:{type:String,default:'a, ->, b'}};
export default defineComponent({props:ownerProps,setup(props){
function decorate(element:any,cls:string){if(element){if(!element.props){element.props={};}element.props.class=[element.props.class,cls].join(' ');}}
return ()=>{const root=[];const right=[];const wrapper=h('div',{class:'wrapper'},right);
const table={a:h('span',{class:'old'},'A'),b:h('span',{},'B')};
const keys=props.layout.split(',').map(item=>item.trim());let switched=false;
keys.forEach(key=>{if(key==='->'){switched=true;return;}if(!switched){root.push(table[key]);}else{right.push(table[key]);}});
decorate(root[0],'first');decorate(root[root.length-1],'last');
if(switched&&right.length>0){decorate(right[0],'first');decorate(right[right.length-1],'last');root.push(wrapper);}
return h('div',{},root);};}});`), 'Partition.tsx');
    const entry = fixture(`<script setup>import Owner from './Partition.tsx';</script><template><Owner ${input}/></template>`, 'PartitionEntry.vue');
    const state = context();
    const graph = state.source.graph([entry]);
    const componentCall = graph.nodes.find((node) => node.file === entry && node.definition === file);
    assert.ok(componentCall, 'actual local partition call required');
    const record = state.source.resolver.parse(file);
    const loop = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'keys.forEach', state.ts)[0];
    const helper = find(record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'decorate', state.ts)[0];
    const uses = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'decorate', state.ts);
    const bindings = new Map(uses.map((use) => [use.expression, { file, fn: helper, name: 'decorate' }]));
    const factory = find(record, (node) => state.ts.isFunctionDeclaration(node), state.ts).find((node) => node.name?.text === 'classes');
    if (factory)
    {
        const calls = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'classes', state.ts);
        calls.forEach((use) => bindings.set(use.expression, { file, fn: factory, name: 'classes' }));
    }
    return { ...state, file, record, loop, componentCall, bindings };
}
function actualPanes()
{
    const state = context();
    const entry = resolve(repositoryRoot, 'src/frontend/src/views/admin/Settings.vue');
    const file = resolve(fsusUIRoot, 'vue/packages/components/tabs/src/tab-pane.vue');
    const navFile = resolve(fsusUIRoot, 'vue/packages/components/tabs/src/tab-nav.tsx');
    const ownerFile = resolve(fsusUIRoot, 'vue/packages/components/tabs/src/tabs.tsx');
    const graph = state.source.graph([entry]);
    const calls = graph.nodes.filter((node) => node.file === entry && node.definition === file);
    assert.equal(calls.length, 4);
    const record = state.source.resolver.parse(file);
    const nav = state.source.resolver.parse(navFile);
    const owner = state.source.resolver.parse(ownerFile);
    const mapCall = find(nav, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'props.panes.map', state.ts)[0];
    return { ...state, file, calls, callback: mapCall.arguments[0], navFile,
        chain: { ownerFile, registryCall: find(owner, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'useOrderedChildren', state.ts)[0],
            providerCall: find(owner, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'provide', state.ts)[0],
            paneFile: file, recordExpression: record.variables.get('pane'), injectionCall: record.variables.get('tabsRoot'),
            registerCall: find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'tabsRoot.registerPane', state.ts)[0],
            navExpression: find(owner, (node) => state.ts.isPropertyAccessExpression(node) && node.getText() === 'panes.value', state.ts)[0], navFile, mapCall } };
}

test('collection continuation: actual Slider four local helpers close readonly marks parameter effects', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slider/src/slider.vue');
    const record = state.source.resolver.parse(file);
    for (const name of ['useSlide', 'useStops', 'useWatch', 'useLifecycle'])
    {
        const call = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === name, state.ts)[0];
        const target = state.source.resolver.resolveSourceFunction(file, call.expression);
        const result = state.module.parameterClosure(target.file, target.fn, 0, 'marks');
        assert.equal(result.readonly, true, name);
        assert.equal(result.unresolved.length, 0, name);
        assert.ok(result.steps.length);
        assert.equal(result.renderProven, false);
    }
});
test('collection continuation: parameter closure follows the original local helper argument edge', () =>
{
    const state = local('function read(value){return value.min;}function owner(props){read(props);return props.max;}const children=[];');
    const fn = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'owner', state.ts)[0];
    const callee = find(state.record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'read', state.ts)[0].expression;
    const read = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'read', state.ts)[0];
    const result = state.module.parameterClosure(state.file, fn, 0, 'marks', new Map([[callee, { file: state.file, fn: read, name: 'read' }]]));
    assert.equal(result.readonly, true);
    assert.equal(result.edges.length, 1);
    assert.equal(result.functions.length, 2);
});
test('collection continuation: parameter closure rejects an alias that carries marks identity', () =>
{
    const state = local('function owner(props){const alias=props;alias.marks=unknown;}const children=[];');
    const fn = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'owner', state.ts)[0];
    const result = state.module.parameterClosure(state.file, fn, 0, 'marks');
    assert.equal(result.readonly, false);
    assert.equal(result.functions[0].escapes[0].kind, 'identity-escape');
});
test('collection continuation: parameter closure rejects nested callback marks mutation', () =>
{
    const state = local('function owner(props){watch(()=>{props.marks=unknown;});}const children=[];');
    const fn = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'owner', state.ts)[0];
    const result = state.module.parameterClosure(state.file, fn, 0, 'marks');
    assert.equal(result.readonly, false);
    assert.deepEqual(result.functions[0].writes[0].path, ['props', 'marks']);
});
test('collection continuation: parameter closure retains the unresolved external reference constructor', () =>
{
    const state = local("import {toRefs} from 'vue';function owner(props){return toRefs(props);}const children=[];");
    const fn = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'owner', state.ts)[0];
    const result = state.module.parameterClosure(state.file, fn, 0, 'marks');
    assert.equal(result.readonly, false);
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.unresolved[0].required.includes('original resolver'));
});
test('collection continuation: actual Pagination information map binds all four original table suppliers', () =>
{
    const state = actualPagination();
    const result = state.module.keyedMap(state.file, state.record.variables.get('informationChildren'), null, state.bindings);
    assert.deepEqual(result.outputs.map((item) => item.key), ['total', 'sizes', 'jumper', 'slot']);
    assert.ok(result.outputs.every((item) => item.conditions.at(-1).expression === 'requested.has(key)'));
    assert.equal(result.outputs[3].node.getText(), 'slots?.default?.() ?? null');
    assert.equal(result.renderProven, false);
});
test('collection continuation: keyed map rejects a mutated membership Set', () =>
{
    const state = local("const table={a:<div/>};const requested=new Set(['a']);requested.add(unknown);const children=['a'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /escaped collection binding/u);
});
test('collection continuation: keyed map rejects an escaped membership Set', () =>
{
    const state = local("const table={a:<div/>};const requested=new Set(['a']);foreign(requested);const children=['a'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /escaped collection binding/u);
});
test('collection continuation: keyed map rejects an unknown supplied table key', () =>
{
    const state = local("const table={a:<div/>};const requested=new Set(['a']);const children=['unknown'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /unknown keyed collection element/u);
});
test('collection continuation: keyed map rejects a mutated own table entry', () =>
{
    const state = local("const table={a:<div/>};table.a=unknown;const requested=new Set(['a']);const children=['a'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /unbound finite component binding table/u);
});
test('collection continuation: keyed map rejects an opaque callback even with an empty key array', () =>
{
    const state = local("const table={a:<div/>};const requested=new Set(['a']);const children=[].filter(foreign).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /control-legality|composition-collection-source/u);
});
test('collection continuation: actual Settings four pane label suppliers bind literal props and absent label slots', () =>
{
    const state = actualPanes();
    const results = state.calls.map((call) => state.module.paneLabel(state.file, state.chain.recordExpression, call, state.navFile, state.callback));
    assert.deepEqual(results.map((item) => item.labels[0].value), ['站点信息', '大陆合规', '媒体策略', '页面编辑']);
    assert.ok(results.every((item) => item.slot.absent && !item.renderProven && item.inputDigest.length === 64));
    assert.ok(results.every((item) => item.callbackEffects.writes.some((write) => write.path?.join('.') === 'pane.index')));
});
test('collection continuation: actual Tabs provider chain links the same source key registry item and navigation prop', () =>
{
    const state = actualPanes();
    const result = state.module.paneSourceChain(state.chain);
    assert.ok(result.key.file.endsWith('/tabs/src/constants.ts'));
    assert.ok(result.registryEffects.writes.some((write) => write.path?.join('.') === 'children.*'));
    assert.ok(result.supplierClosure.functions.some((fn) => fn.name === 'flattedChildren'));
    assert.equal(result.renderProven, false);
    assert.ok(result.requiredBinding.includes('component.uid'));
});
test('collection continuation: pane supplier rejects copied canonical caller identity', () =>
{
    const state = actualPanes();
    assert.throws(() => state.module.paneLabel(state.file, state.chain.recordExpression, { ...state.calls[0] }, state.navFile, state.callback), /unbound canonical/u);
});
test('collection continuation: pane supplier rejects a supplied label slot', () =>
{
    const state = actualPanes();
    const entry = fixture('<script setup>import {ElTabPane} from "@ozwasyd/element-plus";</script><template><ElTabPane label="safe"><template #label>{{unknown}}</template></ElTabPane></template>', 'PaneEntry.vue');
    const call = state.source.graph([entry]).nodes.find((node) => node.file === entry && node.definition === state.file);
    assert.ok(call);
    assert.throws(() => state.module.paneLabel(state.file, state.chain.recordExpression, call, state.navFile, state.callback), /provided\/opaque pane label slot/u);
});
test('collection continuation: pane supplier rejects an opaque runtime label input', () =>
{
    const state = actualPanes();
    const entry = fixture('<script setup>import {ElTabPane} from "@ozwasyd/element-plus";</script><template><ElTabPane :label="unknown"/></template>', 'PaneEntry.vue');
    const call = state.source.graph([entry]).nodes.find((node) => node.file === entry && node.definition === state.file);
    assert.ok(call);
    assert.throws(() => state.module.paneLabel(state.file, state.chain.recordExpression, call, state.navFile, state.callback), /nonliteral collection input/u);
});
test('collection continuation: pane provider rejects a different actual imported injection key', () =>
{
    const state = actualPanes();
    fixture("export const otherKey=Symbol('otherKey');", 'OtherKey.ts');
    const keyFile = fixture("import {otherKey} from './OtherKey';const key=inject(otherKey);", 'WrongKey.ts');
    const injectionCall = state.source.resolver.parse(keyFile).variables.get('key');
    assert.throws(() => state.module.paneSourceChain({ ...state.chain, paneFile: keyFile, injectionCall,
        registerCall: injectionCall, recordExpression: injectionCall }), /mismatched actual pane provider key/u);
});
test('collection continuation: actual Pagination static caller preserves ordered keys and binds first last class values', () =>
{
    const state = actualPagination('layout="total, sizes, prev, pager, next"');
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    const branch = result.outputs[0];
    assert.deepEqual(branch.left.map((item) => item.key), ['total', 'sizes', 'prev', 'pager', 'next']);
    assert.deepEqual(branch.right, []);
    assert.deepEqual(branch.mutations.map((item) => item.binding.classValue), ['is-first', 'is-last']);
    assert.ok(branch.conditions.some((item) => item.expression === "props.responsive === 'auto'" && item.name === 'else'));
    assert.equal(result.renderProven, false);
});
test('collection continuation: actual Pagination conditional caller retains both ordered input branches', () =>
{
    const state = actualPagination(':layout="compact ? \'prev, pager, next\' : \'sizes, prev, pager, next\'"');
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    assert.deepEqual(result.outputs.map((branch) => branch.left.map((item) => item.key)), [['prev', 'pager', 'next'], ['sizes', 'prev', 'pager', 'next']]);
    assert.deepEqual(result.outputs.map((branch) => branch.conditions.at(-1).name), ['if', 'else']);
});
test('collection continuation: actual Pagination default derives the right wrapper total supplier and all guards', () =>
{
    const state = actualPagination('');
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    assert.deepEqual(result.outputs[0].left.map((item) => item.key), ['prev', 'pager', 'next', 'jumper']);
    assert.deepEqual(result.outputs[0].right.map((item) => item.key), ['total']);
    assert.equal(result.outputs[0].wrappers.length, 1);
    assert.equal(result.outputs[0].transitions[0].index, 4);
    assert.equal(result.outputs[0].mutations.length, 4);
});
test('collection continuation: ordered partition preserves repeated keys and multiple delimiter transitions', () =>
{
    const state = partitionFixture({ input: 'layout="a, ->, b, ->, a"' });
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    assert.deepEqual(result.outputs[0].left.map((item) => item.key), ['a']);
    assert.deepEqual(result.outputs[0].right.map((item) => item.key), ['b', 'a']);
    assert.deepEqual(result.outputs[0].transitions.map((item) => item.index), [1, 3]);
});
test('collection continuation: ordered partition rejects an opaque supplied layout', () =>
{
    const state = partitionFixture({ input: ':layout="unknown"' });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /nonliteral collection input/u);
});
test('collection continuation: ordered partition rejects an unknown nonempty supplied key', () =>
{
    const state = partitionFixture({ input: 'layout="a, unknown"' });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /unknown supplied partition key/u);
});
test('collection continuation: ordered partition rejects a mutated array after the callback', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("decorate(root[0],'first');", "root.reverse();decorate(root[0],'first');") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /escaped\/mutated partition collection/u);
});
test('collection continuation: ordered partition rejects an escaped array identity', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("decorate(root[0],'first');", "foreign(root);decorate(root[0],'first');") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /escaped\/mutated partition collection/u);
});
test('collection continuation: ordered partition rejects a callback mutation before the delimiter return', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("if(key==='->'){switched=true;return;}", "if(key==='->'){foreign(root);switched=true;return;}") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /order-sensitive partition flow/u);
});
test('collection continuation: ordered partition rejects a late delimiter state overwrite', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("decorate(root[0],'first');", "switched=false;decorate(root[0],'first');") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /mutated partition state/u);
});
test('collection continuation: class binding rejects an opaque props argument despite a VNode annotation', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("a:h('span',{class:'old'},'A')", "a:h('span',unknown as VNodeProps,'A')") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /opaque\/mutated class props supplier/u);
});
test('collection continuation: class binding rejects an opaque class argument despite its string annotation', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("decorate(root[0],'first');", "decorate(root[0],unknown as string);") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /opaque class argument/u);
});
test('collection continuation: class helper rejects an additional children mutation', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("element.props.class=[element.props.class,cls].join(' ');", "element.children=unknown;element.props.class=[element.props.class,cls].join(' ');") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /unclosed class mutation effects/u);
});
test('collection continuation: explicit class binding rejects a copied function AST', () =>
{
    const state = partitionFixture();
    const bindings = new Map([...state.bindings].map(([node, binding]) => [node, { ...binding, fn: { ...binding.fn } }]));
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, bindings), /unowned source proof node/u);
});
test('collection continuation: class binding rejects an accessor props object', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("a:h('span',{class:'old'},'A')", "a:h('span',{get class(){return unknown;}},'A')") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /opaque\/mutated class props supplier/u);
});
test('collection continuation: keyed map rejects a runtime Set constructor parameter', () =>
{
    const state = local("function build(Set){const table={a:<div/>};const requested=new Set(['a']);return ['a'].filter(key=>requested.has(key)).map(key=>table[key]);}const children=[];");
    const expression = find(state.record, (node) => state.ts.isCallExpression(node) && node.expression.getText().endsWith('.map'), state.ts)[0];
    assert.throws(() => state.module.keyedMap(state.file, expression), /shadowed keyed filter constructor/u);
});
test('collection continuation: actual Slider caller closure isolates precisely the two external reference exports', () =>
{
    const state = context();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slider/src/slider.vue');
    const record = state.source.resolver.parse(file);
    const binding = find(record, (node) => state.ts.isVariableDeclaration(node) && node.name.getText() === 'props', state.ts)[0];
    const selected = record.variables.get('markList');
    const result = state.module.bindingClosure(file, binding, 'marks', new Set([selected.arguments[0]]));
    assert.equal(result.readonly, false);
    assert.deepEqual(result.unresolved.map((item) => item.path), [['props'], ['props']]);
    assert.ok(result.unresolved.some((item) => item.file.endsWith('/form/src/hooks/use-form-item.ts')));
    assert.ok(result.unresolved.some((item) => item.file === file));
    assert.ok(result.functions.every((item) => !item.writes.length && !item.escapes.length));
    assert.equal(result.edges.length, 5);
});
test('collection continuation: actual Pagination information slot binds the original null fallback for an absent caller slot', () =>
{
    const state = actualPagination();
    const result = state.module.keyedMap(state.file, state.record.variables.get('informationChildren'), state.componentCall, state.bindings);
    const slot = result.outputs.find((item) => item.key === 'slot');
    assert.equal(slot.node.kind, state.ts.SyntaxKind.NullKeyword);
    assert.equal(slot.slot.absent, true);
    assert.equal(slot.slot.callNode, state.componentCall.id);
    assert.equal(slot.slot.suppliedBranch.digest.length, 64);
});
test('collection continuation: actual Pagination ordered slot entry preserves the null element and skips guarded class writes', () =>
{
    const state = actualPagination('layout="slot, ->, total"');
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    assert.equal(result.outputs[0].left[0].node.kind, state.ts.SyntaxKind.NullKeyword);
    assert.equal(result.outputs[0].left[0].slot.absent, true);
    assert.equal(result.outputs[0].right[0].key, 'total');
    assert.equal(result.outputs[0].mutations.length, 2);
    assert.equal(result.outputs[0].wrappers.length, 1);
});
test('collection continuation: actual Pagination rejects a supplied default slot identity', () =>
{
    const state = actualPagination('layout="slot"');
    const entry = fixture('<script setup>import {ElPagination} from "@ozwasyd/element-plus";</script><template><ElPagination layout="slot"><span>{{unknown}}</span></ElPagination></template>', 'SuppliedSlot.vue');
    const call = state.source.graph([entry]).nodes.find((node) => node.file === entry && node.definition === state.file);
    assert.ok(call);
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, call, state.bindings), /opaque partition slot supplier/u);
});
test('collection continuation: actual Pagination rejects a dynamic slot supplier', () =>
{
    const state = actualPagination('layout="slot"');
    const entry = fixture('<script setup>import {ElPagination} from "@ozwasyd/element-plus";</script><template><ElPagination layout="slot"><template #[unknown]><span/></template></ElPagination></template>', 'DynamicSlot.vue');
    const call = state.source.graph([entry]).nodes.find((node) => node.file === entry && node.definition === state.file);
    assert.ok(call);
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, call, state.bindings), /opaque partition slot supplier/u);
});
test('collection continuation: ordered partition rejects a layout overwrite before key construction', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("const keys=props.layout", "props.layout=unknown;const keys=props.layout") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /mutated\/escaped partition input/u);
});
test('collection continuation: ordered partition rejects props identity forwarded to an opaque mutator', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("const keys=props.layout", "foreign(props);const keys=props.layout") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /mutated\/escaped partition input/u);
});
test('collection continuation: ordered partition rejects reordered keys before its callback', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("keys.forEach(key=>", "keys.reverse();keys.forEach(key=>") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /escaped collection binding/u);
});
test('collection continuation: class argument binding preserves a literal prior class and the constructor identity obligation', () =>
{
    const state = partitionFixture();
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    const binding = result.outputs[0].mutations[0].binding;
    assert.equal(binding.priorClass.expression, "'old'");
    assert.equal(binding.classValue, 'first');
    assert.ok(binding.requiredBinding.includes('result-to-own-props identity'));
    assert.equal(binding.renderProven, false);
    assert.deepEqual(result.outputs[0].mutations.at(-1).binding.priorClass, { absentOwnArgumentField: true });
});
test('collection continuation: class argument binding rejects an opaque prior class conversion despite a string cast', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("a:h('span',{class:'old'},'A')", "a:h('span',{class:unknown as string},'A')") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /opaque prior class conversion/u);
});
test('collection continuation: ordered partition rejects an opaque third argument array consumer', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("decorate(root[0],'first');", "foreign('div',{},root);decorate(root[0],'first');") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /unbound canonical collection constructor/u);
});
test('collection continuation: ordered partition rejects an incremented delimiter state', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("keys.forEach(key=>", "switched++;keys.forEach(key=>") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /mutated partition state/u);
});
test('collection continuation: ordered partition rejects a shadowed key copying constructor', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("keys.forEach(key=>", "function Set(items){items.reverse();}const copy=new Set(keys);keys.forEach(key=>") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /shadowed partition key constructor/u);
});
test('collection continuation: class supplier closes a real local primitive function before binding its argument', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("function decorate(element:any", "function classes(){const is=(name)=>{return name;};return {is};}const ns=classes();function decorate(element:any")
        .replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));") });
    const result = state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings);
    assert.equal(result.outputs[0].mutations[0].binding.classValue, 'first');
});
test('collection continuation: class supplier rejects a mutated method despite its original pure body', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("function decorate(element:any", "function classes(){const is=(name)=>{return name;};return {is};}const ns=classes();ns.is=unknown;function decorate(element:any")
        .replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /unbound finite component binding ns/u);
});
test('collection continuation: class supplier rejects its object identity escaped to an opaque consumer', () =>
{
    const state = partitionFixture({ change: (value) => value.replace("function decorate(element:any", "function classes(){const is=(name)=>{return name;};return {is};}const ns=classes();foreign(ns);function decorate(element:any")
        .replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));") });
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /escaped class supplier identity/u);
});

// Independent review probes: retain their original inputs and assertion boundaries.
function reviewReadonly(body)
{
    const state = context();
    const file = fixture(body);
    const record = state.source.resolver.parse(file);
    const fn = find(record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'owner', state.ts)[0];
    return state.module.parameterClosure(file, fn, 0, 'marks');
}
function reviewPartition(transform = (value) => value, input = 'a, ->, b')
{
    const state = context();
    const file = fixture(transform(`import {defineComponent,h} from 'vue';
const ownerProps={layout:{type:String,default:'a, ->, b'}};
export default defineComponent({props:ownerProps,setup(props){
function decorate(element,cls){if(element){if(!element.props){element.props={};}element.props.class=[element.props.class,cls].join(' ');}}
return ()=>{const root=[];const right=[];const wrapper=h('div',{},right);const table={a:h('span',{},'A'),b:h('span',{},'B')};
const keys=props.layout.split(',').map(item=>item.trim());let switched=false;
keys.forEach(key=>{if(key==='->'){switched=true;return;}if(!switched){root.push(table[key]);}else{right.push(table[key]);}});
decorate(root[0],'first');decorate(root[root.length-1],'last');
if(switched&&right.length>0){decorate(right[0],'first');decorate(right[right.length-1],'last');root.push(wrapper);}
return h('div',{},root);};}});`), 'partition.tsx');
    const entry = fixture(`<script setup>import Owner from './partition';</script><template><Owner layout="${input}"/></template>`, 'PartitionEntry.vue');
    const call = state.source.graph([entry]).nodes.find((node) => node.file === entry && node.definition === file);
    assert.ok(call);
    const record = state.source.resolver.parse(file);
    const loop = find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'keys.forEach', state.ts)[0];
    const fn = find(record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'decorate', state.ts)[0];
    const bindings = new Map(find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'decorate', state.ts)
        .map((node) => [node.expression, { file, fn, name: 'decorate' }]));
    return { ...state, file, record, loop, call, bindings };
}
function reviewPlan(state)
{
    return state.module.partitionCollection(state.file, state.loop, state.call, state.bindings);
}
test('probe: parenthesized array escape is rejected', () => reject("const children=['a'];foreign((children));"));
test('probe: parenthesized mutating array receiver is rejected', () => reject("const children=['a','b'];(children).reverse();"));
test('probe: conditional array escape is rejected', () => reject("const children=['a'];foreign(flag?children:[]);"));
test('probe: repeated loop push is rejected as unbounded', () => reject("const children=[];for(let i=0;i<2;i++){children.push('a');}"));
test('probe: conditional parameter escape is not readonly', () => assert.equal(reviewReadonly('function owner(props){foreign(flag?props:null);}').readonly, false));
test('probe: spread parameter escape is not readonly', () => assert.equal(reviewReadonly('function owner(props){foreign(...props);}').readonly, false));
test('probe: helper default parameter mutation is not readonly', () => assert.equal(reviewReadonly('function helper(p,side=(p.marks=unknown)){}function owner(props){helper(props);}').readonly, false));
test('probe: guarded partition loop keeps its authored condition', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('keys.forEach(key=>', 'if(extra)keys.forEach(key=>')));
    assert.ok(result.outputs[0].conditions.some((entry) => entry.expression === 'extra' && entry.name === 'if'));
});
test('probe: conditional nested return does not invent a whole-guard else', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('const keys=props.layout', 'if(outer){if(inner)return null;}const keys=props.layout')));
    assert.ok(!result.outputs[0].conditions.some((entry) => entry.expression === 'outer' && entry.name === 'else'));
});
test('probe: class mutations preserve authored cross-container order', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace("decorate(root[0],'first');", "decorate(right[0],'early');decorate(root[0],'first');")));
    assert.equal(result.outputs[0].mutations[0].binding.classValue, 'early');
});
test('probe: unconditional wrapper push survives a no-delimiter input', () =>
{
    const state = reviewPartition((value) => value.replace('root.push(wrapper);', '').replace("return h('div',{},root);", "root.push(wrapper);return h('div',{},root);"), 'a');
    assert.equal(reviewPlan(state).outputs[0].wrappers.length, 1);
});
test('probe: malformed pane provider is rejected', () =>
{
    const state = context();
    fixture("export const key=Symbol('k');", 'key.ts');
    const ownerFile = fixture("import {key} from './key';const children=[];const addChild=child=>{children.push(child);};export const registry=()=>{return {children,addChild};};const {children:panes,addChild:registerPane}=registry();foreign(key,{registerPane});const output=<WrongNav panes={panes.value}/>;", 'Tabs.tsx');
    const paneFile = fixture("import {key} from './key';const props={};const slots={};const pane=foreign({props,slots});const tabsRoot=foreign(key);tabsRoot.registerPane(pane);", 'Pane.tsx');
    const navFile = fixture('const other={panes:[]};const out=other.panes.map(pane=>pane.props.label);', 'Nav.tsx');
    const owner = state.source.resolver.parse(ownerFile);
    const pane = state.source.resolver.parse(paneFile);
    const nav = state.source.resolver.parse(navFile);
    const call = (record, name) => find(record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === name, state.ts)[0];
    const chain = { ownerFile, registryCall: call(owner, 'registry'), providerCall: call(owner, 'foreign'), paneFile,
        recordExpression: pane.variables.get('pane'), injectionCall: pane.variables.get('tabsRoot'), registerCall: call(pane, 'tabsRoot.registerPane'),
        navExpression: find(owner, (node) => state.ts.isPropertyAccessExpression(node) && node.getText() === 'panes.value', state.ts)[0],
        navFile, mapCall: call(nav, 'other.panes.map') };
    assert.throws(() => state.module.paneSourceChain(chain), /composition-collection-source|control-legality/u);
});
test('probe: pane label rejects changed caller props before record construction', () =>
{
    const state = context();
    const file = fixture("<script setup>import {useSlots,reactive} from 'vue';const props=defineProps({label:String});const slots=useSlots();props.label='changed';const pane=reactive({props,slots});</script><template><div/></template>", 'LabelPane.vue');
    const entry = fixture('<script setup>import Pane from "./LabelPane.vue";</script><template><Pane label="original"/></template>', 'LabelEntry.vue');
    const callbackFile = fixture('const callback=pane=>pane.slots.label?.()||pane.props.label;', 'LabelNav.tsx');
    const call = state.source.graph([entry]).nodes.find((node) => node.file === entry && node.definition === file);
    assert.ok(call);
    const record = state.source.resolver.parse(file);
    const callback = state.source.resolver.parse(callbackFile).variables.get('callback');
    assert.throws(() => state.module.paneLabel(file, record.variables.get('pane'), call, callbackFile, callback), /composition-collection-source|control-legality/u);
});
test('probe: keyed table entry escaped before map is rejected', () =>
{
    const state = local("const table={a:<div/>};foreign(table.a);const requested=new Set(['a']);const children=['a'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /composition-collection-source|control-legality/u);
});
test('probe: keyed map retains callback parameter binding with distinct parameter names', () =>
{
    const state = local("const table={a:<div/>};const requested=new Set(['a']);const children=['a'].filter(filterKey=>requested.has(filterKey)).map(mapKey=>table[mapKey]);");
    const result = state.module.keyedMap(state.file, state.record.variables.get('children'));
    assert.equal(result.outputs[0].bindings.get('mapKey')?.node.text, 'a');
});
test('probe: class supplier retains an opaque earlier factory return alternative', () =>
{
    const state = reviewPartition((value) => value.replace('function decorate(element,cls)', 'function classes(){const is=(name)=>{return name;};if(flag)return {is:foreign};return {is};}const ns=classes();function decorate(element,cls)').replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));"));
    const fn = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'classes', state.ts)[0];
    find(state.record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'classes', state.ts)
        .forEach((node) => state.bindings.set(node.expression, { file: state.file, fn, name: 'classes' }));
    assert.throws(() => reviewPlan(state), /composition-collection-source|control-legality/u);
});
test('probe: partition callback cannot precede false state initialization', () =>
{
    const state = reviewPartition((value) => value.replace('let switched=false;', '').replace("decorate(root[0],'first');", "let switched=false;decorate(root[0],'first');"));
    assert.throws(() => reviewPlan(state), /composition-collection-source|control-legality/u);
});
test('probe: copied callback AST is rejected by canonical source ownership', () =>
{
    const state = local('const callback=item=><div/>;const children=[];');
    assert.throws(() => state.module.callbackEffects(state.file, { ...state.record.variables.get('callback') }), /unowned source proof node/u);
});

test('repair: satisfies-wrapped collection escape is rejected', () => reject("const children=['a'];foreign(children satisfies string[]);"));
test('repair: short-circuit collection escape is rejected', () => reject("const children=['a'];foreign(flag&&children);"));
test('repair: while collection multiplicity is rejected', () => reject("const children=[];while(flag){children.push('a');}"));
test('repair: switch-dependent collection push is rejected', () => reject("const children=[];switch(flag){case true:children.push('a');}"));
test('repair: try-dependent collection push is rejected', () => reject("const children=[];try{children.push('a');}catch(error){}"));
test('repair: callback conditional and spread arguments retain every actual origin', () =>
{
    const state = local('const callback=(item,other)=>{foreign(flag?item:other);foreign(...item);};const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    assert.deepEqual(result.escapes.filter((entry) => entry.kind === 'call-argument').map((entry) => entry.path), [['item'], ['other'], ['item']]);
    assert.ok(result.calls[0].arguments[0].paths.length === 2);
});
test('repair: helper default parameter escape stays unresolved', () =>
{
    assert.equal(reviewReadonly('function helper(p,side=foreign(p)){}function owner(props){helper(props);}').readonly, false);
});
test('repair: guarded partition retains both executed and bypassed paths', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('keys.forEach(key=>', 'if(extra)keys.forEach(key=>')));
    assert.equal(result.outputs.length, 2);
    assert.deepEqual(result.outputs.map((entry) => entry.loopExecuted), [true, false]);
    assert.deepEqual(result.outputs[1].assembledRoot, []);
    assert.ok(result.outputs[1].conditions.some((entry) => entry.expression === 'extra' && entry.name === 'else'));
});
test('repair: nested terminal guards retain both surviving control paths', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('const keys=props.layout', 'if(outer){if(inner)return null;}const keys=props.layout')));
    assert.deepEqual(result.outputs.map((entry) => entry.conditions.filter((guard) => ['outer', 'inner'].includes(guard.expression)).map(({name, expression}) => [name, expression])),
        [[['if', 'outer'], ['else', 'inner']], [['else', 'outer']]]);
    assert.ok(result.excludedReturns.some((entry) => entry.conditions.length === 2));
});
test('repair: callback return before loop does not become a render guard', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('const keys=props.layout', 'if(extra){const read=()=>{return null;};}const keys=props.layout')));
    assert.equal(result.outputs.length, 2);
    assert.ok(result.outputs[0].conditions.some((entry) => entry.expression === 'extra' && entry.name === 'if'));
});
test('repair: wrapper push keeps its own unknown authored guard', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('root.push(wrapper);', '').replace("return h('div',{},root);", "if(extra)root.push(wrapper);return h('div',{},root);"), 'a'));
    assert.deepEqual(result.outputs.map((entry) => entry.wrappers.length), [1, 0]);
    assert.deepEqual(result.outputs[0].assembledRoot.map((entry) => entry.wrapper ?? false), [false, true]);
});
test('repair: late last class write targets wrapper at that program point', () =>
{
    const state = reviewPartition((value) => value.replace('root.push(wrapper);', '').replace("return h('div',{},root);", "root.push(wrapper);decorate(root[root.length-1],'late');return h('div',{},root);"), 'a');
    const result = reviewPlan(state);
    const last = result.outputs[0].mutations.at(-1);
    assert.equal(last.binding.classValue, 'late');
    assert.equal(last.binding.constructor.digest, state.source.resolver.sourceStep(state.file, result.outputs[0].wrappers[0].node).digest);
});
test('repair: conditional wrapper omission does not borrow a right-side condition', () =>
{
    const result = reviewPlan(reviewPartition((value) => value.replace('if(switched&&right.length>0)', 'if(!switched)'), 'a'));
    assert.equal(result.outputs[0].wrappers.length, 1);
    assert.equal(result.outputs[0].right.length, 0);
});
test('repair: unsupported render loop is rejected before a partition plan', () =>
{
    assert.throws(() => reviewPlan(reviewPartition((value) => value.replace('const keys=props.layout', 'while(extra){}const keys=props.layout'))), /unsupported partition control flow/u);
});
test('repair: wrapped keyed table entry escape is rejected', () =>
{
    const state = local("const table={a:<div/>};foreign(flag?table.a:null);const requested=new Set(['a']);const children=['a'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /escaped keyed collection/u);
});
test('repair: fresh keyed sink cannot escape through a carrier expression', () =>
{
    const state = local("const table={a:<div/>};const borrowed=[];borrowed.push(table.a);foreign(flag?borrowed:null);const requested=new Set(['a']);const children=['a'].filter(key=>requested.has(key)).map(key=>table[key]);");
    assert.throws(() => state.module.keyedMap(state.file, state.record.variables.get('children')), /escaped keyed collection sink/u);
});
test('repair: distinct keyed parameters preserve exact original binding scopes', () =>
{
    const state = local("const table={a:<div/>};const requested=new Set(['a']);const children=['a'].filter(filterKey=>requested.has(filterKey)).map(mapKey=>table[mapKey]);");
    const result = state.module.keyedMap(state.file, state.record.variables.get('children'));
    const bindings = result.outputs[0].bindings;
    assert.equal(bindings.get('filterKey').parameter.parent, bindings.get('filterKey').scope);
    assert.equal(bindings.get('mapKey').parameter.parent, bindings.get('mapKey').scope);
    assert.notEqual(bindings.get('filterKey').scope, bindings.get('mapKey').scope);
});
test('repair: class factory rejects opaque earlier throw alternative', () =>
{
    const state = reviewPartition((value) => value.replace('function decorate(element,cls)', 'function classes(){const is=(name)=>{return name;};if(flag)throw unknown;return {is};}const ns=classes();function decorate(element,cls)').replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));"));
    const fn = find(state.record, (node) => state.ts.isFunctionDeclaration(node) && node.name?.text === 'classes', state.ts)[0];
    find(state.record, (node) => state.ts.isCallExpression(node) && node.expression.getText() === 'classes', state.ts).forEach((node) => state.bindings.set(node.expression, {file:state.file,fn,name:'classes'}));
    assert.throws(() => reviewPlan(state), /alternate class supplier factory flow/u);
});
test('repair: class supplier rejects a projected method escape', () =>
{
    const state = partitionFixture({change: (value) => value.replace('function decorate(element:any,cls:string)', "function classes(){const is=(name)=>{return name;};return {is};}const ns=classes();foreign(ns.is);function decorate(element:any,cls:string)").replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));" )});
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /escaped class supplier identity/u);
});
test('repair: class supplier rejects an overriding factory spread', () =>
{
    const state = partitionFixture({change: (value) => value.replace('function decorate(element:any,cls:string)', "function classes(){const is=(name)=>{return name;};return {is,...unknown};}const ns=classes();function decorate(element:any,cls:string)").replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));" )});
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /open class supplier/u);
});
test('repair: class supplier rejects an effectful default parameter initializer', () =>
{
    const state = partitionFixture({change: (value) => value.replace('function decorate(element:any,cls:string)', "function classes(){const is=(name,side=foreign())=>{return name;};return {is};}const ns=classes();function decorate(element:any,cls:string)").replace("decorate(root[0],'first');", "decorate(root[0],ns.is('first'));" )});
    assert.throws(() => state.module.partitionCollection(state.file, state.loop, state.componentCall, state.bindings), /opaque primitive parameter/u);
});
test('repair: labeled wrapper push remains unsupported', () =>
{
    assert.throws(() => reviewPlan(reviewPartition((value) => value.replace('root.push(wrapper);', 'label:root.push(wrapper);'))), /unsupported partition control flow/u);
});
test('repair: actual pane chain precisely reports the missing central Vue binding interface', () =>
{
    const state = actualPanes();
    const module = createCompositionCollectionSource({ ...state.source, vueBinding: undefined });
    assert.throws(() => module.paneSourceChain(state.chain), /required central interface: vueBinding\(record, actualCalleeAST, exportedName\)/u);
});
test('repair: callback alias effects retain their lexical block identity', () =>
{
    const state = local('const callback=(item,other)=>{const alias=item;{const alias=other;foreign(alias);}foreign(alias);};const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    const escapes = result.escapes.filter((entry) => entry.kind === 'call-argument');
    assert.deepEqual(escapes.map((entry) => entry.path), [['other'], ['item']]);
    assert.notEqual(escapes[0].binding.digest, escapes[1].binding.digest);
});
test('repair: nested callback parameter does not borrow an outer capture', () =>
{
    const state = local('const callback=item=>{const inner=(item)=>item;return item;};const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    assert.ok(!result.escapes.some((entry) => entry.kind === 'callback-capture'));
});
test('repair: conditional callback aliases preserve writes to both original parameters', () =>
{
    const state = local('const callback=(item,other)=>{const alias=flag?item:other;alias.value=unknown;};const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    assert.deepEqual(result.writes.map((entry) => entry.path), [['item','value'],['other','value']]);
    assert.equal(result.writes[0].originBindings.length, 2);
});
test('repair: inner shadowed alias does not create an outer parameter capture', () =>
{
    const state = local('const callback=item=>{const inner=item=>{const alias=item;return alias;};return item;};const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    assert.ok(!result.escapes.some((entry) => entry.kind === 'callback-capture'));
});
test('repair: callback effects retain opaque free condition reads without inferring values', () =>
{
    const state = local('const callback=item=>flag?item:unknown;const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    assert.deepEqual(result.freeReads.map((entry) => entry.path), [['flag'],['unknown']]);
    assert.ok(result.freeReads.every((entry) => entry.binding === null));
});
test('repair: callback type references do not manufacture runtime free reads', () =>
{
    const state = local('const callback=item=>{const value:Opaque=item;return value;};const children=[];');
    const result = state.module.callbackEffects(state.file, state.record.variables.get('callback'));
    assert.ok(!result.freeReads.some((entry) => entry.path?.[0] === 'Opaque'));
});
