import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { createCompositionSource, compositionProbePlugin } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `script-render-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(content, name = 'Owner.tsx')
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
function source()
{
    return createCompositionSource({ repositoryRoot, fsusUIRoot });
}
function owner(body, options = '')
{
    return `import {defineComponent, Fragment, h, renderSlot} from 'vue'; export default defineComponent({${options}setup(_, {slots}) { return () => {${body}}; }});`;
}

test('actual form label TSX default export binds every native branch and unchanged default slot', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/form/src/form-label-wrap.tsx');
    const s = source();
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    assert.ok(graph.files[0].renderSource);
    assert.deepEqual(graph.nodes.filter((node) => node.origin.kind === 'native').map((node) => node.tag), ['div']);
    assert.equal(graph.nodes.filter((node) => node.tag === 'slot').length, 2);
    const fragment = graph.nodes.find((node) => node.tag === 'Fragment');
    assert.equal(fragment.origin.kind, 'framework-structure');
    assert.ok(graph.nodes.every((node) => node.conditional.length));
    assert.ok(graph.resolverInputs.some((input) => input.path === file && input.digest === controlDigest(readFileSync(file, 'utf8'))));
});

test('actual slider marker native h target is proven while its opaque label remains rejected', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/slider/src/marker.ts');
    const graph = source().graph([file]);
    assert.ok(graph.nodes.some((node) => node.origin.kind === 'native' && node.tag === 'div' && node.sourceSyntax.kind === 'vue-vnode'));
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-render-source' && error.message.includes('label.value')));
});

test('actual imported TSX component remains local and its slot child retains its own source', () =>
{
    fixture(owner('return <div>{slots.default?.()}</div>;'));
    const entry = fixture(`<script setup>import Alias from './Owner.tsx';</script><template><Alias><button>Child</button></Alias></template>`, 'Entry.vue');
    const graph = source().graph([entry]);
    assert.deepEqual(graph.errors, []);
    const call = graph.nodes.find((node) => node.tag === 'Alias');
    assert.equal(call.origin.kind, 'local');
    assert.ok(call.definition.endsWith('/Owner.tsx'));
    const child = graph.nodes.find((node) => node.tag === 'button');
    assert.equal(child.file, entry);
    assert.equal(child.origin.kind, 'native');
});

test('native TS h instrumentation preserves exact source and refuses authored or changed markers', () =>
{
    const text = owner(`return h('div', {class: 'label'}, 'content');`);
    const file = fixture(text, 'Owner.ts');
    const s = source();
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    const transformed = compositionProbePlugin(s).transform(text, file).code;
    assert.ok(transformed.includes(`'data-fsus-composition-node': '${graph.nodes[0].id}'`));
    const ast = s.resolver.ts.createSourceFile(file, transformed, s.resolver.ts.ScriptTarget.Latest, true);
    assert.deepEqual(ast.parseDiagnostics, []);
    assert.throws(() => s.instrument(file, text + ' '), /source changed/);
    const authored = fixture(owner(`return h('div', {'data-fsus-composition-node': 'forged'}, 'content');`), 'Authored.ts');
    assert.ok(source().graph([authored]).errors.some((error) => error.message.includes('reserved script render attribute')));
});

test('TSX instrumentation inserts native and component markers at actual opening tags', () =>
{
    fixture('<template><span/></template>', 'Child.vue');
    const text = `import {defineComponent} from 'vue'; import Child from './Child.vue'; export default defineComponent({setup() {return () => <section><Child/></section>;}});`;
    const file = fixture(text);
    const s = source();
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    const transformed = s.instrument(file, text);
    assert.ok(transformed.includes('<section data-fsus-composition-node='));
    assert.ok(transformed.includes('<Child data-fsus-composition-call='));
    const ast = s.resolver.ts.createSourceFile(file, transformed, s.resolver.ts.ScriptTarget.Latest, true, s.resolver.ts.ScriptKind.TSX);
    assert.deepEqual(ast.parseDiagnostics, []);
});

test('TSX route-dependent render and class sources remain rejected visual branches', () =>
{
    const text = `import {defineComponent} from 'vue'; import {useRoute} from 'vue-router'; const route=useRoute(); export default defineComponent({setup(){return () => route.name==='admin' ? <div class={route.name}/> : <span/>;}});`;
    const graph = source().graph([fixture(text)]);
    assert.equal(graph.errors.filter((error) => error.reason === 'route-name-visual-branch').length, 2);
});

for (const [label, text] of [
    ['mutated JSX component import', `import {defineComponent} from 'vue'; import Child from './Child.vue'; Child=other; export default defineComponent({setup(){return () => <Child/>;}});`],
    ['shadowed JSX component import', `import {defineComponent} from 'vue'; import Child from './Child.vue'; export default defineComponent({setup(){const Child=other; return () => <Child/>;}});`],
    ['unknown constructor', `export default factory({setup(){return () => <div/>;}});`],
    ['shadowed Vue constructor', `import {defineComponent} from 'vue'; function other(defineComponent){}; export default defineComponent({setup(){return () => <div/>;}});`],
    ['mutated Vue constructor', `import {defineComponent} from 'vue'; defineComponent=other; export default defineComponent({setup(){return () => <div/>;}});`],
    ['unknown options spread', `import {defineComponent} from 'vue'; export default defineComponent({...unknown,setup(){return () => <div/>;}});`],
    ['duplicate setup', `import {defineComponent} from 'vue'; export default defineComponent({setup(){return () => <div/>;},setup(){return () => <span/>;}});`],
    ['render override', owner('return <div/>;', 'render: other,')],
    ['conditional setup return', `import {defineComponent} from 'vue'; export default defineComponent({setup(){if(state)return other; return () => <div/>;}});`],
    ['async setup', `import {defineComponent} from 'vue'; export default defineComponent({async setup(){return () => <div/>;}});`],
    ['async render', `import {defineComponent} from 'vue'; export default defineComponent({setup(){return async () => <div/>;}});`],
    ['render fallthrough', owner('if(state)return <div/>;')],
    ['unknown render return', owner('return other();')],
    ['JSX unknown child', owner('return <div>{unknown}</div>;')],
    ['JSX child spread', owner('return <div>{...unknown}</div>;')],
    ['JSX prop spread', owner('return <div {...unknown}/>;')],
    ['slot arguments', owner('return <div>{slots.default?.(unknown)}</div>;')],
    ['slot shadow', owner('const slots=other; return <div>{slots.default?.()}</div>;')],
    ['slot mutation', owner('slots.default=other; return <div>{slots.default?.()}</div>;')],
    ['slot escape', owner('other(slots); return <div>{slots.default?.()}</div>;')],
    ['mutable exported component', `import {defineComponent} from 'vue'; let Owner=defineComponent({setup(){return () => <div/>;}}); export default Owner;`],
    ['mutated exported component', `import {defineComponent} from 'vue'; const Owner=defineComponent({setup(){return () => <div/>;}}); Owner.render=other; export default Owner;`],
    ['fake h constructor', owner(`const h=other; return h('div',{},'content');`)],
    ['unknown h target', owner(`return h(unknown,{},'content');`)],
    ['unknown h props', owner(`return h('div',unknown,'content');`)],
    ['unknown h children', owner(`return h('div',{},unknown);`)],
    ['unsupported render loop', owner('for(const item of items){if(item)return <div/>;} return null;')]
])
{
    test(`script render rejects ${label}`, () =>
    {
        const graph = source().graph([fixture(text)]);
        assert.ok(graph.errors.length > 0, label);
    });
}
