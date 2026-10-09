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
    assert.throws(() => state.module.collect(file, information), /effectful collection callback/u);
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
