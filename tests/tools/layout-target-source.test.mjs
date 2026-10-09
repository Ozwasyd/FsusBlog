import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '../frontend/support/layout/compositionSource.mjs';
import { bindCompositionTargetInputs, resolveCompositionTargetOrigin } from '../frontend/support/layout/compositionTargetSource.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
const parserRoot = process.env.FSUSBLOG_TARGET_PARSER_ROOT ?? repositoryRoot;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `target-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));

function source()
{
    return createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
}
function fixture(content, name = 'Entry.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
function selector(s, file, name)
{
    assert.ok(s.resolver.parse(file).variables.has(name), 'the actual selector must exist');
    return resolveCompositionTargetOrigin(s, file, s.expression(name, file));
}

test('actual ArticleDetailHeader retains native a and registered RouterLink alternatives', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/components/article/ArticleDetailHeader.vue');
    const origin = selector(s, file, 'categoryComponent');
    assert.deepEqual(origin.alternatives.map(({ targetKind }) => targetKind), ['native', 'framework']);
    assert.equal(origin.variants[0].name, 'a');
    assert.deepEqual(origin.variants[1], s.resolver.resolveTag(file, 'RouterLink'));
    assert.equal(origin.variants[1].registration, 'vue-router:createRouter');
    assert.ok(origin.resolverInputs.some(({ path }) => path.endsWith('/router/index.ts')));
    assert.equal(origin.proofDigest.length, 64);
});

test('actual PublicArticleDetailPageContent retains both authored appendix targets', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue');
    const origin = selector(s, file, 'appendixTagComponent');
    assert.equal(origin.variants.length, 2);
    assert.equal(origin.variants[0].name, 'a');
    assert.deepEqual(origin.variants[1], s.resolver.resolveTag(file, 'RouterLink'));
});

test('actual OutlineRail retains registered public Drawer and native aside alternatives', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue');
    const origin = selector(s, file, 'outlineHost');
    assert.equal(origin.variants[0].kind, 'fsusui-public');
    assert.deepEqual(origin.variants[0], s.resolver.resolveTag(file, 'ElDrawer'));
    assert.ok(origin.alternatives[0].definition.endsWith('/drawer/src/drawer.vue'));
    assert.equal(origin.variants[1].name, 'aside');
});

test('actual InspectorShell retains registered public Drawer and native aside alternatives', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/components/admin/article/ArticleWriteInspectorShell.vue');
    const origin = selector(s, file, 'inspectorHost');
    assert.deepEqual(origin.alternatives.map(({ targetKind }) => targetKind), ['component', 'native']);
    assert.deepEqual(origin.variants[0], s.resolver.resolveTag(file, 'ElDrawer'));
    assert.equal(origin.variants[1].name, 'aside');
});

test('mixed target resolution retains repeated authored branches and local component identity', () =>
{
    fixture('<template><div/></template>', 'Local.vue');
    const file = fixture(`<script setup>import {computed} from 'vue';import Local from './Local.vue';const host=computed(()=>outer?'aside':inner?Local:'aside');</script><template><component :is="host"/></template>`);
    const origin = selector(source(), file, 'host');
    assert.equal(origin.variants.length, 3);
    assert.deepEqual(origin.alternatives.map(({ targetKind }) => targetKind), ['native', 'component', 'native']);
    assert.equal(origin.variants[1].kind, 'local');
    assert.equal(origin.variantDefinitions.length, 1);
});

function buttonInput()
{
    const s = source();
    const file = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';import {RouterLink} from 'vue-router';</script><template><ElButton :tag="RouterLink"/><ElButton tag="a"/></template>`);
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    assert.ok(node, 'actual Button target prop source must exist');
    const calls = graph.nodes.filter((entry) => entry.definition === node.file);
    assert.equal(calls.length, 2);
    // These ordinary literal suppliers use the original resolver. Ordered
    // forwarding/spread/default tests await the central private componentInput API.
    const inputs = calls.map((call) =>
    {
        const supplier = call.directives.find(({ name, argument }) => name === 'bind' && argument === 'tag');
        const expression = s.expression(supplier?.expression ?? JSON.stringify(call.attributes.tag), file);
        const targets = s.resolver.resolveComponentInput(file, expression);
        assert.equal(targets.length, 1);
        return { target: targets[0], callPath: [call.id] };
    });
    return { s, graph, node, calls, inputs };
}

test('actual Button RouterLink import and native literal retain separate call provenance', () =>
{
    const { s, graph, node, calls, inputs } = buttonInput();
    const bindings = bindCompositionTargetInputs(s, node, inputs, graph.nodes);
    assert.deepEqual(bindings.map(({ targetKind }) => targetKind), ['framework', 'native']);
    assert.deepEqual(bindings[0].target, s.resolver.resolveTag(calls[0].file, 'RouterLink'));
    assert.equal(bindings[1].target.name, 'a');
    assert.deepEqual(bindings.map(({ callPath }) => callPath), calls.map(({ id }) => [id]));
    assert.ok(bindings.every(({ inputDigest, inputDigests, proofDigest, declarationDigest, steps }) =>
        inputDigest === inputDigests[0] && proofDigest.length === 64 && declarationDigest.length === 64
        && steps.length >= 2));
    assert.ok(graph.errors.some(({ callNode, reason }) => callNode === calls[0].id && reason === 'unbound-native-prop-source'),
        'central integration remains owned by original1894');
});

test('actual ArticleDetailNotFoundState Button retains its actual RouterLink import target', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/components/article/ArticleDetailNotFoundState.vue');
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    const call = graph.nodes.find((entry) => entry.file === file && entry.definition === node.file);
    const directive = call.directives.find(({ name, argument }) => name === 'bind' && argument === 'tag');
    const targets = s.resolver.resolveComponentInput(file, s.expression(directive.expression, file));
    assert.equal(targets.length, 1);
    const bindings = bindCompositionTargetInputs(s, node, targets.map((target) => ({ target, callPath: [call.id] })), graph.nodes);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].targetKind, 'framework');
    assert.deepEqual(bindings[0].target, s.resolver.resolveTag(file, 'RouterLink'));
    assert.equal(bindings[0].target.registration, undefined, 'the authored import differs from global registration provenance');
});

test('a local RouterLink substitution retains local ownership without framework identity', () =>
{
    fixture('<template><div/></template>', 'RouterLink.vue');
    const file = fixture(`<script setup>import {computed} from 'vue';import RouterLink from './RouterLink.vue';const host=computed(()=>state?'a':RouterLink);</script><template><component :is="host"/></template>`);
    const origin = selector(source(), file, 'host');
    assert.deepEqual(origin.alternatives.map(({ targetKind }) => targetKind), ['native', 'component']);
    assert.equal(origin.variants[1].kind, 'local');
    assert.ok(origin.alternatives[1].definition.endsWith('/RouterLink.vue'));
});

test('mixed target resolution rejects block flow until canonical raw return branches are exposed', () =>
{
    const file = fixture(`<script setup>import {computed} from 'vue';const host=computed(()=>{if(state)return 'a';return 'aside';});</script><template><component :is="host"/></template>`);
    assert.throws(() => selector(source(), file, 'host'), /canonical raw-return interface/);
});

test('mixed target resolution rejects an unknown alternative despite a component type annotation', () =>
{
    const file = fixture(`<script setup lang="ts">import {computed,type Component} from 'vue';const opaque:Component=foreign;const host=computed(()=>state?'aside':opaque);</script><template><component :is="host"/></template>`);
    assert.throws(() => selector(source(), file, 'host'), /unbound finite component binding foreign/);
});

test('mixed target resolution rejects a mutable selector', () =>
{
    const file = fixture(`<script setup>import {computed} from 'vue';let host=computed(()=>state?'aside':'a');</script><template><component :is="host"/></template>`);
    assert.throws(() => selector(source(), file, 'host'), /unbound finite component binding/);
});

test('mixed target resolution rejects an unknown Drawer substitution', () =>
{
    const file = fixture(`<script setup>import {computed,resolveComponent} from 'vue';const publicDrawer=resolveComponent('UnknownDrawer');const host=computed(()=>state?publicDrawer:'aside');</script><template><component :is="host"/></template>`);
    assert.throws(() => selector(source(), file, 'host'), /unresolved component tag/);
});

test('actual BlogLayout RouterView exposed Component remains unbound without its supplier proof', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/layouts/BlogLayout.vue');
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.file === file && entry.tag === 'component');
    assert.ok(node.scopedBindings.includes('Component'));
    assert.throws(() => resolveCompositionTargetOrigin(s, file, s.expression('Component', file), node), /unbound scoped target/);
});

test('actual AccountRouteFrame RouterView permission state remains unbound without its supplier proof', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/layouts/AccountRouteFrame.vue');
    const graph = s.graph([file]);
    const node = graph.nodes.find((entry) => entry.file === file && entry.tag === 'component');
    assert.ok(node.scopedBindings.includes('Component'));
    assert.throws(() => resolveCompositionTargetOrigin(s, file, s.expression('Component', file), node), /unbound scoped target/);
});

test('target input binding rejects a substituted call path outside the canonical graph', () =>
{
    const { s, graph, node, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, [{ ...inputs[0], callPath: ['substituted'] }], graph.nodes), /canonical graph/);
});

test('target input binding rejects a graph node that is not the actual supplying component call', () =>
{
    const { s, graph, node, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, [{ ...inputs[0], callPath: [node.id] }], graph.nodes), /actual component definitions/);
});

test('target input binding rejects a cloned owner and unresolved runtime target', () =>
{
    const { s, graph, node, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, { ...node }, inputs, graph.nodes), /actual native-prop/);
    assert.throws(() => bindCompositionTargetInputs(s, node, [{ ...inputs[0], target: null }], graph.nodes), /unbound target definition/);
});

test('target source proof rejects source bytes changed after canonical parsing', () =>
{
    const s = source();
    const file = fixture(`<script setup>import {computed} from 'vue';const host=computed(()=>state?'a':'aside');</script><template><component :is="host"/></template>`);
    selector(s, file, 'host');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n<!-- changed -->\n');
    assert.throws(() => selector(s, file, 'host'), /canonical source inputs changed/);
});
