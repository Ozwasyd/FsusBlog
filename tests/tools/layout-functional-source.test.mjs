import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest, createControlSourceResolver } from '../../tools/frontend/control-legality/source.mjs';
import { createCompositionFunctionalSource } from '../frontend/support/layout/compositionFunctionalSource.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
const parserRoot = process.env.FSUSBLOG_FUNCTIONAL_PARSER_ROOT ?? repositoryRoot;
assert.ok(fsusUIRoot, 'actual original FsusUI source is required');
const directory = resolve(repositoryRoot, '.tmp', `functional-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));

function source(file)
{
    const resolver = createControlSourceResolver({ repositoryRoot, fsusUIRoot, parserRoot, mode: 'local' });
    const record = resolver.parse(file);
    const functional = createCompositionFunctionalSource({ resolver });
    const ts = resolver.ts;
    const exports = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isExportAssignment));
    const exported = exports[0]?.expression;
    const render = exported && ts.isIdentifier(exported) ? record.variables.get(exported.text) : exported;
    return { resolver, record, functional, ts, render, binding: () => functional.bind(record, render) };
}
function fixture(text)
{
    const file = resolve(directory, `Owner-${randomUUID()}.tsx`);
    writeFileSync(file, text);
    return source(file);
}
function actual(name)
{
    return source(resolve(fsusUIRoot, `vue/packages/components/table-v2/src/renderers/${name}.tsx`));
}
function find(s, predicate)
{
    const nodes = [];
    function visit(node)
    {
        if (predicate(node)) nodes.push(node);
        s.ts.forEachChild(node, visit);
    }
    s.record.scripts.forEach(({ ast }) => visit(ast));
    return nodes;
}
function opening(s)
{
    return find(s, (node) => s.ts.isJsxOpeningElement(node) || s.ts.isJsxSelfClosingElement(node))[0];
}

test('actual TableV2 Footer arrow binds lexical props slots and inert displayName source steps', () =>
{
    const s = actual('footer');
    const binding = s.binding();
    assert.equal(binding.render, s.render);
    assert.equal(binding.call, binding.render);
    assert.equal(binding.setup, binding.render);
    assert.equal(binding.props.text, 'props');
    assert.equal(binding.slots, 'slots');
    assert.equal(binding.branches.length, 1);
    assert.deepEqual(binding.branches[0].conditional, []);
    const call = find(s, s.ts.isCallExpression)[0];
    assert.equal(s.functional.slotCall(s.record, call, binding).name, 'default');
    assert.equal(binding.proofDigest, controlDigest(binding.proofFacts));
    assert.deepEqual(binding.steps[1], s.resolver.sourceStep(s.record.file, binding.render));
    assert.ok(binding.steps.every((entry) => entry.kind === 'script-source' && entry.file === s.record.file && entry.digest.length === 64));
    assert.ok(binding.steps.some((entry) => readFileSync(entry.file, 'utf8').slice(entry.offset).startsWith('Footer.displayName')));
    const inputs = s.resolver.sourceBindings();
    assert.deepEqual(inputs.errors, []);
    assert.ok(inputs.files.some((input) => input.path === s.record.file && input.digest === controlDigest(s.record.content)));
});

test('actual TableV2 Overlay binds its arrow without using the SimpleFunctionalComponent annotation', () =>
{
    const s = actual('overlay');
    const binding = s.binding();
    const tag = opening(s);
    assert.deepEqual(s.functional.componentOrigin(s.record, tag.tagName, true), { kind: 'native', name: 'div' });
    assert.deepEqual(s.functional.fields(s.record, tag.attributes.properties, binding).map((field) => field.name.text), ['class', 'style']);
    assert.equal(s.functional.outputValue(s.record, binding.branches[0].node, binding), find(s, s.ts.isJsxElement)[0]);
});

test('actual TableV2 Empty retains the imported fallback identity and both authored slot branches', () =>
{
    const s = actual('empty');
    const binding = s.binding();
    const fallback = find(s, s.ts.isJsxSelfClosingElement)[0];
    const origin = s.functional.componentOrigin(s.record, fallback.tagName, true);
    assert.equal(origin.kind, 'local');
    assert.equal(origin.file, resolve(fsusUIRoot, 'vue/packages/components/empty/index.ts'));
    assert.equal(origin.name, 'default');
    assert.deepEqual(origin, s.resolver.resolveExpression(s.record.file, fallback.tagName)[0]);
    const branch = find(s, s.ts.isConditionalExpression)[0];
    assert.equal(branch.condition.getText(), 'slots.default');
    assert.equal(s.functional.slotCall(s.record, branch.whenTrue, binding).name, 'default');
    assert.equal(branch.whenFalse, fallback);
});

test('actual TableV2 MainTable rest props stay unbound despite its TableV2GridProps annotation', () =>
{
    const s = actual('main-table');
    const binding = s.binding();
    const tag = opening(s);
    assert.equal(s.functional.componentOrigin(s.record, tag.tagName, true).kind, 'local');
    assert.throws(() => s.functional.fields(s.record, tag.attributes.properties, binding), /unbound functional output\/spread/);
    assert.throws(() => s.functional.outputValue(s.record, find(s, (node) => s.ts.isJsxExpression(node) && node.expression?.getText() === 'slots')[0].expression, binding), /unbound functional output\/spread/);
});

test('actual TableV2 fixed table empty-column returns retain guards and unbound rest suppliers', () =>
{
    for (const name of ['left-table', 'right-table'])
    {
        const s = actual(name);
        const binding = s.binding();
        assert.equal(binding.branches[0].node, null);
        assert.deepEqual(binding.branches[0].conditional, [{ name: 'if', expression: '!props.columns.length' }]);
        assert.deepEqual(binding.branches[1].conditional, [{ name: 'else', expression: '!props.columns.length' }]);
        assert.throws(() => s.functional.fields(s.record, opening(s).attributes.properties, binding), /unbound functional output\/spread/);
    }
});

test('actual TableV2 Row Header Cell and HeaderCell helper suppliers remain rejected', () =>
{
    for (const name of ['row', 'header', 'cell', 'header-cell'])
    {
        const s = actual(name);
        assert.throws(() => s.binding(), /escaped functional binding|shadowed functional binding|unknown functional return flow|unbound functional call effects/, name);
        assert.ok(s.resolver.sourceBindings().files.some((input) => input.path === s.record.file));
    }
});

test('functional return flow retains the negative continuation after an early native return', () =>
{
    const s = fixture('const Owner = () => { if (state) return <div/>; return <span/>; }; export default Owner;');
    const binding = s.binding();
    assert.deepEqual(binding.branches.map((branch) => branch.conditional), [
        [{ name: 'if', expression: 'state' }], [{ name: 'else', expression: 'state' }]
    ]);
    assert.deepEqual(binding.branches.map((branch) => branch.node.getText()), ['<div/>', '<span/>']);
});

test('functional return flow preserves nested branch paths and explicit empty returns', () =>
{
    const s = fixture('export default () => { if (a) { if (b) return <div/>; else return; } else return <span/>; };');
    const binding = s.binding();
    assert.equal(binding.branches.length, 3);
    assert.deepEqual(binding.branches[1].conditional, [{ name: 'if', expression: 'a' }, { name: 'else', expression: 'b' }]);
    assert.equal(binding.branches[1].node, null);
});

test('closed JSX spread exposes actual literal const fields with opaque values carrying no identity', () =>
{
    const s = fixture('export default () => { const extra = {class: "plain", title: unknownValue}; return <div {...extra} role="cell"/>; };');
    const binding = s.binding();
    const fields = s.functional.fields(s.record, opening(s).attributes.properties, binding);
    assert.deepEqual(fields.map((field) => field.name.text), ['class', 'title', 'role']);
    assert.equal(fields[1].initializer.getText(), 'unknownValue');
    assert.throws(() => s.functional.componentOrigin(s.record, fields[1].initializer), /unbound functional component target/);
});

test('closed nested literal spreads and destructured lexical prop aliases retain actual field ASTs', () =>
{
    const s = fixture('const Owner = ({class: klass}, {slots: children}) => <div {...{...{class: klass}, title: "title"}}>{children.default?.()}</div>; Owner.displayName="Owner"; export default Owner;');
    const binding = s.binding();
    const fields = s.functional.fields(s.record, opening(s).attributes.properties, binding);
    assert.deepEqual(fields.map((field) => field.name.text), ['class', 'title']);
    assert.equal(fields[0].initializer.getText(), 'klass');
    assert.equal(binding.slots, 'children');
    assert.equal(s.functional.slotCall(s.record, find(s, s.ts.isCallExpression)[0], binding).name, 'default');
});

test('functional native constant output preserves the original JSX node and source identity', () =>
{
    const s = fixture('export default () => { const child=<button/>; return child; };');
    const binding = s.binding();
    const node = s.functional.outputValue(s.record, binding.branches[0].node, binding);
    assert.equal(node, opening(s));
    assert.deepEqual(s.functional.componentOrigin(s.record, node.tagName, true), { kind: 'native', name: 'button' });
});

test('destructured lexical prop aliases retain readonly scalar attribute sources', () =>
{
    const s = fixture('export default (props)=> { const {class: klass}=props; return <div class={klass}/>; };');
    const binding = s.binding();
    assert.equal(s.functional.fields(s.record, opening(s).attributes.properties, binding)[0].initializer.expression.getText(), 'klass');
});

test('block-return proof digest binds the actual module-level VNode constant', () =>
{
    const s = fixture('const child=<div/>; export default ()=> { return child; };');
    const first = s.binding();
    assert.equal(s.functional.outputValue(s.record, first.branches[0].node, first).getText(), '<div/>');
    writeFileSync(s.record.file, s.record.content.replace('<div/>', '<nav/>'));
    const changed = source(s.record.file);
    const second = changed.binding();
    assert.equal(first.render.getText(), second.render.getText());
    assert.equal(first.render.getStart(), second.render.getStart());
    assert.equal(changed.functional.outputValue(changed.record, second.branches[0].node, second).getText(), '<nav/>');
    assert.notEqual(first.proofDigest, second.proofDigest);
    assert.ok(s.resolver.sourceBindings().errors.some((entry) => entry.reason === 'parsed-source-changed-during-scan'));
});

test('closed spread proof digest binds a changed module-level title value', () =>
{
    const s = fixture('const extra={title:"one"}; export default ()=> { return <div {...extra}/>; };');
    const first = s.binding();
    assert.equal(s.functional.fields(s.record, opening(s).attributes.properties, first)[0].initializer.text, 'one');
    writeFileSync(s.record.file, s.record.content.replace('"one"', '"two"'));
    const changed = source(s.record.file);
    const second = changed.binding();
    assert.equal(first.render.getText(), second.render.getText());
    assert.equal(first.render.getStart(), second.render.getStart());
    assert.equal(changed.functional.fields(changed.record, opening(changed).attributes.properties, second)[0].initializer.text, 'two');
    assert.notEqual(first.proofDigest, second.proofDigest);
});

test('module constant proof closure follows actual transitive scalar supplier declarations', () =>
{
    const s = fixture('const title="one"; const extra={title}; export default ()=> { return <div {...extra}/>; };');
    const first = s.binding();
    assert.deepEqual(first.proofFacts.dependencies.map((entry) => entry.name), ['title', 'extra']);
    for (const entry of first.proofFacts.dependencies)
    {
        const declaration = find(s, (node) => s.ts.isVariableDeclaration(node) && node.name.getText() === entry.name)[0];
        assert.deepEqual(entry.declaration, s.resolver.sourceStep(s.record.file, declaration));
        assert.deepEqual(entry.initializer, s.resolver.sourceStep(s.record.file, declaration.initializer));
        assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.declaration) && Object.isFrozen(entry.initializer));
    }
    writeFileSync(s.record.file, s.record.content.replace('"one"', '"two"'));
    const changed = source(s.record.file);
    const second = changed.binding();
    assert.equal(first.render.getText(), second.render.getText());
    assert.notEqual(first.proofDigest, second.proofDigest);
});

function reviewSource(text, file = resolve(directory, `Review-${randomUUID()}.tsx`))
{
    writeFileSync(file, text);
    const s = source(file);
    return { ...s, bind: s.binding };
}

for (const [name, text] of [
    ['tagged template initializer helper effects', 'export default ()=>{ const value=unknown`payload`; return <div/>; };'],
    ['tagged template guard helper effects', 'export default ()=>{ if(unknown`payload`) return <div/>; return <span/>; };'],
    ['unknown assignment effects in initializer', 'export default ()=>{ const value=(external.flag=true); return <div/>; };'],
    ['destructured props alias member mutation', 'export default (props)=>{ const {child}=props; const value=(child.flag=true); return <div/>; };'],
    ['destructured props alias deletion', 'export default (props)=>{ const {child}=props; const value=delete child.flag; return <div/>; };']
])
{
    test(`independent refusal: ${name}`, () =>
    {
        const s = reviewSource(text);
        assert.throws(() => s.bind(), /\[(?:composition-source|control-legality)\]/);
    });
}

test('proofDigest must distinguish dereferenced closed spread field facts', () =>
{
    const file = resolve(directory, 'spread-digest.tsx');
    const a = reviewSource('const extra={title:"old"}; export default ()=> <div {...extra}/>;', file);
    const ba = a.bind();
    const fa = a.functional.fields(a.record, find(a, a.ts.isJsxSelfClosingElement)[0].attributes.properties, ba);
    const b = reviewSource('const extra={title:"new"}; export default ()=> <div {...extra}/>;', file);
    const bb = b.bind();
    const fb = b.functional.fields(b.record, find(b, b.ts.isJsxSelfClosingElement)[0].attributes.properties, bb);
    assert.notEqual(fa[0].initializer.getText(), fb[0].initializer.getText());
    assert.notEqual(ba.proofDigest, bb.proofDigest);
});

test('block return module constant output facts must affect proofDigest', () =>
{
    const file = resolve(directory, 'ReviewOwner.tsx');
    function observe(tag)
    {
        const s = reviewSource(`const child=<${tag}/>; export default ()=>{return child;};`, file);
        const binding = s.bind();
        const output = s.functional.outputValue(s.record, binding.branches[0].node, binding);
        return { binding, output, record: s.record };
    }
    const a = observe('div');
    const b = observe('nav');
    assert.equal(a.output.getText(), '<div/>');
    assert.equal(b.output.getText(), '<nav/>');
    assert.notEqual(a.record.content, b.record.content);
    assert.notEqual(a.binding.proofDigest, b.binding.proofDigest);
});

const negatives = [
    ['metadata-only object impostor', 'const Owner={displayName:"ElTableV2Footer"}; export default Owner;', 'bind'],
    ['typed runtime call impostor', 'const Owner: FunctionalComponent = unknown(); Owner.displayName="ElTableV2Footer"; export default Owner;', 'bind'],
    ['mutable functional declaration', 'let Owner=()=> <div/>; export default Owner;', 'bind'],
    ['reassigned functional declaration', 'const Owner=()=> <div/>; Owner=other; export default Owner;', 'bind'],
    ['overwritten render identity', 'const Owner=()=> <div/>; Owner.render=other; export default Owner;', 'bind'],
    ['computed metadata mutation', 'const Owner=()=> <div/>; Owner["displayName"]="Owner"; export default Owner;', 'bind'],
    ['effectful displayName value', 'const Owner=()=> <div/>; Owner.displayName=unknown(); export default Owner;', 'bind'],
    ['escaped functional identity', 'const Owner=()=> <div/>; other(Owner); export default Owner;', 'bind'],
    ['shadowed props parameter', 'export default (props)=> { function other(props){} return <div class={props.class}/>; };', 'bind'],
    ['reassigned props parameter', 'export default (props)=> { props=other; return <div/>; };', 'bind'],
    ['mutated props member', 'export default (props)=> { props.class="injected"; return <div/>; };', 'bind'],
    ['escaped props context', 'export default (props)=> { other(props); return <div/>; };', 'bind'],
    ['escaped props member', 'export default (props)=> { const value=other(props.field); return <div/>; };', 'bind'],
    ['reassigned slot context', 'export default (_, {slots})=> { slots=other; return <div/>; };', 'bind'],
    ['mutated slot callback', 'export default (_, {slots})=> { slots.default=other; return <div/>; };', 'bind'],
    ['escaped slot context', 'export default (_, {slots})=> { other(slots); return <div/>; };', 'bind'],
    ['escaped slot callback', 'export default (_, {slots})=> { const alias=slots.default; return <div/>; };', 'bind'],
    ['escaped slot closure', 'export default (_, {slots})=> { const alias=other(()=>slots.default()); return <div/>; };', 'bind'],
    ['injected slot payload', 'export default (_, {slots})=> <div>{slots.default(other)}</div>;', 'bind'],
    ['unknown context object', 'export default (props, context)=> <div/>;', 'bind'],
    ['default context supplier', 'export default (_, {slots}=unknown)=> <div/>;', 'bind'],
    ['render fallthrough', 'export default ()=> { if (state) return <div/>; };', 'bind'],
    ['unknown flow loop', 'export default ()=> { for (const x of unknown) return <div/>; return null; };', 'bind'],
    ['async functional render', 'export default async ()=> <div/>;', 'bind'],
    ['injected prop VNode', 'export default (props)=> props.vnode;', 'bind'],
    ['injected unknown VNode call', 'export default ()=> unknown();', 'output'],
    ['typed opaque VNode constant', 'export default ()=> { const child: VNode=unknownVNode; return child; };', 'output'],
    ['mutable VNode constant', 'export default ()=> { let child=<div/>; return child; };', 'output'],
    ['escaped VNode constant', 'export default ()=> { const child=<div/>; const alias=child; return child; };', 'output'],
    ['out of scope VNode constant', 'export default ()=> { if (state) { const child=<div/>; } return child; };', 'output'],
    ['shadowed imported component', 'import Child from "./Child.vue"; export default (Child)=> <Child/>;', 'target'],
    ['reassigned imported component', 'import Child from "./Child.vue"; Child=other; export default ()=> <Child/>;', 'target'],
    ['escaped imported component', 'import Child from "./Child.vue"; other(Child); export default ()=> <Child/>;', 'target'],
    ['metadata-only component target', 'const Child={displayName:"ElEmpty"}; export default ()=> <Child/>;', 'target'],
    ['type-only component target', 'import type Child from "./Child.vue"; export default ()=> <Child/>;', 'target'],
    ['open parameter prop spread', 'export default (props)=> <div {...props}/>;', 'fields'],
    ['helper result prop spread', 'export default ()=> { const extra=helper(); return <div {...extra}/>; };', 'fields'],
    ['escaped closed spread', 'export default ()=> { const extra={class:"plain"}; other(extra); return <div {...extra}/>; };', 'fields'],
    ['mutated closed spread', 'export default ()=> { const extra={class:"plain"}; extra.title=unknown; return <div {...extra}/>; };', 'fields'],
    ['duplicate spread key', 'export default ()=> <div {...{class:"a"}} class="b"/>;', 'fields'],
    ['computed spread key', 'export default ()=> <div {...{[unknown]:"a"}}/>;', 'fields'],
    ['reserved native provenance marker', 'export default ()=> <div {...{"data-fsus-composition-node":"forged"}}/>;', 'fields'],
    ['reserved component provenance marker', 'export default ()=> <div data-fsus-composition-call="forged"/>;', 'fields'],
    ['unknown nested prop spread', 'export default ()=> <div {...{...unknown, class:"a"}}/>;', 'fields'],
    ['prototype setter spread', 'export default ()=> <div {...{__proto__: unknown, class:"a"}}/>;', 'fields'],
    ['unknown initializer call effects', 'export default ()=> { const value=unknown(); return <div/>; };', 'bind'],
    ['unknown initializer constructor effects', 'export default ()=> { const value=new Unknown(); return <div/>; };', 'bind'],
    ['escaped props callback closure', 'export default (props)=> { const value=other(()=>props.child); return <div/>; };', 'bind'],
    ['shadowed slot context', 'export default (_, {slots})=> { function other(slots){} return <div>{slots.default?.()}</div>; };', 'bind'],
    ['context rest supplier', 'export default (_, {...slots})=> <div/>;', 'bind'],
    ['unbound outer slot context', 'const leak=slots.default(); export default (_, {slots})=> <div>{slots.default?.()}</div>;', 'bind'],
    ['uninitialized VNode constant', 'export default ()=> { return child; const child=<div/>; };', 'output'],
    ['external package identity impostor', 'import Child from "unproved-runtime-package"; export default ()=> <Child/>;', 'target'],
    ['tagged template initializer call', 'export default ()=> { const ignored=mutator`payload`; return <div/>; };', 'bind'],
    ['tagged template return call', 'export default ()=> mutator`payload`;', 'bind'],
    ['external member assignment initializer', 'export default ()=> { const ignored=(external.flag=true); return <div/>; };', 'bind'],
    ['external member delete initializer', 'export default ()=> { const ignored=delete external.flag; return <div/>; };', 'bind'],
    ['external member increment initializer', 'export default ()=> { const ignored=external.flag++; return <div/>; };', 'bind'],
    ['destructured prop alias assignment initializer', 'export default (props)=> { const {child}=props; const ignored=(child.flag=true); return <div/>; };', 'bind'],
    ['destructured prop alias delete initializer', 'export default (props)=> { const {child}=props; const ignored=delete child.flag; return <div/>; };', 'bind'],
    ['transitive destructured alias delete initializer', 'export default (props)=> { const {child}=props; const {leaf}=child; const ignored=delete leaf.flag; return <div/>; };', 'bind'],
    ['destructured alias deferred mutation', 'export default (props)=> { const {child}=props; const callback=()=>child.flag=true; return <div/>; };', 'bind'],
    ['destructured alias deferred delete', 'export default (props)=> { const {child}=props; const callback=()=>delete child.flag; return <div/>; };', 'bind'],
    ['destructured alias escaped callback', 'export default (props)=> { const {child}=props; const callback=()=>consume(child); return <div/>; };', 'bind'],
    ['module spread supplier tagged call effects', 'const extra={title:mutator`payload`}; export default ()=> { return <div {...extra}/>; };', 'bind'],
    ['module spread supplier assignment effects', 'const extra={title:(external.flag=true)}; export default ()=> { return <div {...extra}/>; };', 'bind']
];
for (const [name, text, operation] of negatives)
{
    test(`functional source rejects ${name}`, () =>
    {
        const s = fixture(text);
        assert.throws(() =>
        {
            const binding = s.binding();
            if (operation === 'output') s.functional.outputValue(s.record, binding.branches[0].node, binding);
            if (operation === 'target') s.functional.componentOrigin(s.record, opening(s).tagName, true);
            if (operation === 'fields') s.functional.fields(s.record, opening(s).attributes.properties, binding);
        }, /\[composition-source\]/);
    });
}

test('functional helpers reject foreign AST records and counterfeit bindings', () =>
{
    const s = fixture('const injected=<span/>; export default ()=> <div/>;');
    const binding = s.binding();
    assert.throws(() => { binding.slots = 'injected'; }, TypeError);
    assert.throws(() => { binding.branches[0].node = null; }, TypeError);
    assert.throws(() => s.functional.bind({ ...s.record }, s.render), /noncanonical functional record/);
    assert.throws(() => s.functional.outputValue(s.record, binding.branches[0].node, { ...binding }), /foreign functional binding/);
    assert.throws(() => s.functional.fields(s.record, [], { ...binding }), /foreign functional binding/);
    assert.throws(() => s.functional.outputValue(s.record, opening(s), binding), /foreign functional binding/);
    const other = fixture('export default ()=> <span/>;');
    assert.throws(() => s.functional.outputValue(other.record, other.render, binding), /foreign functional binding/);
});
