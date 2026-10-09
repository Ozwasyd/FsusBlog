import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { resolveCompositionRoutes, resolveCompositionRouterViewSlot } from '@fsusblog/layout-governance/composition-routes';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';
import { bindCompositionRouterViewTargets, bindCompositionTargetInputs, resolveCompositionTargetOrigin } from '@fsusblog/layout-governance/composition-target-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
const parserRoot = process.env.FSUSBLOG_TARGET_PARSER_ROOT ?? repositoryRoot;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
assert.equal(typeof resolveCompositionRouterViewSlot, 'function', 'original3576 actual route source API is required');
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
    const inputs = s.resolveTargetInputs(node, graph);
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
    assert.ok(bindings.every(({ inputDigest, inputDigests, proofDigest, declarationDigest, steps, callSteps }) =>
        inputDigest === inputDigests[0] && proofDigest.length === 64 && declarationDigest.length === 64
        && steps.length >= 1 && steps.every(({ kind }) => kind === 'script-source') && callSteps.length >= 2));
    const declaration = s.resolver.componentPropDeclaration(node.file, node.origin.property);
    assert.deepEqual(bindings[0].steps[0], s.resolver.sourceStep(declaration.file, declaration.node));
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

test('actual ArticleDetailHeader target steps use the canonical original computed script AST', () =>
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/components/article/ArticleDetailHeader.vue');
    const record = s.resolver.parse(file);
    const value = record.variables.get('categoryComponent');
    const origin = selector(s, file, 'categoryComponent');
    assert.deepEqual(origin.steps, [s.resolver.sourceStep(file, value), s.resolver.sourceStep(file, value.arguments[0].body)]);
    assert.ok(origin.steps.every(({ offset, kind }) => Number.isInteger(offset) && kind === 'script-source'));
    const { proofDigest, ...facts } = origin;
    assert.equal(proofDigest, controlDigest(facts), 'every actual returned source fact is bound');
});

test('target selector proof rejects a synthetic computed AST despite identical target alternatives', () =>
{
    const s = source();
    const file = fixture(`<script setup>import {computed} from 'vue';const host=computed(()=>state?'a':'aside');</script><template><component :is="host"/></template>`);
    const actual = s.resolver.parse(file).variables.get('host');
    const synthetic = s.expression(actual.getText(), file);
    assert.throws(() => resolveCompositionTargetOrigin(s, file, synthetic), /unowned source proof node/);
});

test('target selector proof rejects a foreign original AST despite identical source text', () =>
{
    const s = source();
    const content = `<script setup>import {computed} from 'vue';const host=computed(()=>state?'a':'aside');</script><template><component :is="host"/></template>`;
    const file = fixture(content);
    const foreign = fixture(content, 'Foreign.vue');
    const value = s.resolver.parse(foreign).variables.get('host');
    assert.throws(() => resolveCompositionTargetOrigin(s, file, value), /unowned source proof node/);
});

function slotBinding(s, routes, node, callPath = [])
{
    return bindCompositionRouterViewTargets(s, routes, node, { resolveRouterViewSlot: resolveCompositionRouterViewSlot, callPath });
}
function actualSlot(layout, entries = [layout])
{
    const s = source();
    const file = resolve(repositoryRoot, 'src/frontend/src/layouts', layout);
    const routes = resolveCompositionRoutes(s, resolve(repositoryRoot, 'src/frontend/src/router/index.ts'));
    const graph = s.graph(entries.map((entry) => resolve(repositoryRoot, 'src/frontend/src/layouts', entry)));
    const node = graph.nodes.find((entry) => entry.file === file && entry.tag === 'component');
    assert.ok(node, 'actual dynamic source node is required');
    return { s, file, routes, graph, node };
}
function slotFixture(markup = '<RouterView v-slot="{Component}"><component :is="Component"/></RouterView>', script = `import {RouterView} from 'vue-router';`)
{
    fixture('<template><section/></template>', 'RouteLeaf.vue');
    const owner = fixture(`<script setup>${script}</script><template>${markup}</template>`, 'RouteOwner.vue');
    const router = fixture(`import {createRouter} from 'vue-router';createRouter({routes:[{path:'/',component:()=>import('./RouteOwner.vue'),children:[{path:'leaf',component:()=>import('./RouteLeaf.vue')}]}]});`, 'Router.ts');
    const s = source();
    const routes = resolveCompositionRoutes(s, router);
    const graph = s.graph([owner]);
    const node = graph.nodes.find((entry) => entry.file === owner && entry.tag === 'component');
    return { s, owner, router, routes, graph, node };
}

test('actual BlogLayout RouterView target binding retains every original supplier alternative and framework VNode identity', (t) =>
{
    const { s, file, routes, graph, node } = actualSlot('BlogLayout.vue');
    const binding = slotBinding(s, routes, node);
    assert.equal(node.offset, 272);
    assert.equal(binding.supplier.slotOwner.offset, 224);
    const expected = resolveCompositionRouterViewSlot(s, routes, { file, offset: node.offset });
    assert.deepEqual(binding.supplier, expected);
    assert.deepEqual(binding.alternatives.map(({ path, kind, componentFile }) => ({ path, kind, componentFile })),
        expected.alternatives.map(({ path, kind, componentFile }) => ({ path, kind, componentFile })));
    const article = binding.alternatives.find(({ path }) => path === '/article/:id');
    assert.equal(article.targetKind, 'framework');
    assert.equal(article.target.publicName, 'RouterView');
    assert.equal(article.backingTarget.kind, 'local');
    assert.ok(article.definition.endsWith('/views/ArticleDetail.vue'));
    assert.equal(binding.runtimeState, 'unbound');
    assert.equal(binding.permissionState, 'unbound');
    assert.equal(binding.qualificationEligible, false);
    const { proofDigest, ...facts } = binding;
    assert.equal(proofDigest, controlDigest(facts));
    assert.ok(graph.errors.some((error) => error.file === file && error.offset === node.offset));
    t.diagnostic(`retained local BlogLayout graph errors: ${graph.errors.length}; central integration remains unverified`);
});

test('actual AccountRouteFrame RouterView target binding retains its real AdminWorkspaceFrame call chain', (t) =>
{
    const { s, file, routes, graph, node } = actualSlot('AccountRouteFrame.vue', ['AdminWorkspaceFrame.vue']);
    const admin = resolve(repositoryRoot, 'src/frontend/src/layouts/AdminWorkspaceFrame.vue');
    const call = graph.nodes.find((entry) => entry.file === admin && entry.definition === file);
    assert.ok(call);
    const binding = slotBinding(s, routes, node, [call.id]);
    assert.equal(binding.supplier.routeOwner.file, admin);
    assert.deepEqual(binding.callPath, [binding.supplier.slotOwner.callNode, call.id]);
    assert.equal(binding.inputDigests[1], controlDigest({ attributes: call.attributes, directives: call.directives, slots: call.slotInputs }));
    assert.ok(binding.alternatives.some(({ definition }) => definition?.endsWith('/views/admin/Dashboard.vue')));
    assert.ok(binding.alternatives.every(({ definition }) => !definition?.endsWith('/views/ArticleDetail.vue')));
    assert.equal(binding.runtimeState, 'unbound');
    assert.equal(binding.permissionState, 'unbound');
    assert.ok(graph.errors.some((error) => error.file === file && error.offset === node.offset));
    t.diagnostic(`retained local AdminWorkspaceFrame graph errors: ${graph.errors.length}; central integration remains unverified`);
});

test('RouterView target binding preserves original empty-view alternatives without native or component substitution', () =>
{
    const { s, routes, node } = slotFixture();
    const binding = slotBinding(s, routes, node);
    assert.deepEqual(binding.alternatives.map(({ targetKind }) => targetKind), ['empty-view', 'framework']);
    assert.equal(binding.alternatives[0].target, null);
    assert.equal(binding.alternatives[0].backingTarget, null);
    assert.equal(binding.alternatives[0].definition, null);
    assert.deepEqual(binding.conditional, node.conditional);
});

test('RouterView target binding preserves the actual imported Outlet alias and exposed View binding', () =>
{
    const { s, routes, node } = slotFixture('<Outlet v-slot="{Component:View}"><component :is="View"/></Outlet>', `import {RouterView as Outlet} from 'vue-router';`);
    const binding = slotBinding(s, routes, node);
    assert.equal(binding.supplier.slotOwner.tag, 'Outlet');
    assert.equal(binding.supplier.slotOwner.binding, 'View');
    assert.equal(binding.alternatives[1].target.publicName, 'RouterView');
});

test('actual AccountRouteFrame target binding rejects a missing route-owner call chain', () =>
{
    const { s, routes, node } = actualSlot('AccountRouteFrame.vue', ['AdminWorkspaceFrame.vue']);
    assert.throws(() => slotBinding(s, routes, node), /no actual route declaration/);
});

test('actual AccountRouteFrame target binding rejects a substituted dynamic-node call path', () =>
{
    const { s, routes, node } = actualSlot('AccountRouteFrame.vue', ['AdminWorkspaceFrame.vue']);
    assert.throws(() => slotBinding(s, routes, node, [node.id]), /actual component definitions/);
});

test('RouterView target binding rejects unresolved permission and runtime route overrides', () =>
{
    const { s, routes, node } = slotFixture('<RouterView :route="permission ? allowed : unknown" v-slot="{Component}"><component :is="Component"/></RouterView>');
    assert.throws(() => slotBinding(s, routes, node), /view-name supplier/);
});

test('RouterView target binding rejects an intervening Component loop supplier', () =>
{
    const { s, routes, node } = slotFixture('<RouterView v-slot="{Component}"><component v-for="Component in unknown" :is="Component"/></RouterView>');
    assert.throws(() => slotBinding(s, routes, node), /shadow scope/);
});

test('RouterView target binding rejects a local component named RouterView as a framework supplier', () =>
{
    fixture('<template><slot/></template>', 'PretendRouterView.vue');
    const { s, routes, node } = slotFixture(undefined, `import RouterView from './PretendRouterView.vue';`);
    assert.throws(() => slotBinding(s, routes, node), /canonical RouterView/);
});

test('RouterView target binding rejects route records observed by a different actual source instance', () =>
{
    const first = slotFixture();
    const s = source();
    const graph = s.graph([first.owner]);
    const node = graph.nodes.find((entry) => entry.file === first.owner && entry.tag === 'component');
    assert.throws(() => slotBinding(s, first.routes, node), /original source observation/);
});

function origin(s, file)
{
    return selector(s, file, 'host');
}

test('independent nested member escape must refuse a runtime changed alternative', () =>
{
    const file = fixture(`<script setup>import {computed} from 'vue';const choices={target:'a'};const container={choices};function change(value){value.choices.target='button';}change(container);const host=computed(()=>state?choices.target:'aside');</script><template><component :is="host"/></template>`);
    assert.throws(() => origin(source(), file), /escaped|mutated|unbound|unknown/);
});

test('independent escaped computed selector must refuse unknown mutation', () =>
{
    const file = fixture(`<script setup>import {computed} from 'vue';const host=computed(()=>state?'a':'aside');unknown(host);</script><template><component :is="host"/></template>`);
    assert.throws(() => origin(source(), file), /escaped|mutated|unbound|unknown/);
});

test('independent actual mutable selector initializer must refuse', () =>
{
    const file = fixture(`<script setup>import {computed} from 'vue';let host=computed(()=>state?'a':'aside');host=computed(()=>state?'button':'div');</script><template><component :is="host"/></template>`);
    const s = source();
    const value = s.resolver.parse(file).variables.get('host');
    assert.throws(() => resolveCompositionTargetOrigin(s, file, value), /mutated|unbound|mutable/);
});

test('independent swapped actual supplying call must refuse wrong target provenance', () =>
{
    const { s, node, graph, calls, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, [{ ...inputs[0], callPath: [calls[1].id] }], graph.nodes), /supplier|target|canonical|call/);
});

test('independent complete target supplier set must refuse omitted call', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, [inputs[0]], graph.nodes), /supplier|missing|complete|call/);
});

test('bounded named selector export must refuse unproven producer escape', () =>
{
    const file = resolve(directory, 'Host.ts');
    writeFileSync(file, `import {computed} from 'vue';const host=computed(()=>state?'a':'aside');export {host};`);
    const s = createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
    assert.throws(() => resolveCompositionTargetOrigin(s, file, s.expression('host', file)), /escaped target producer output/);
});

test('bounded renamed selector export must refuse unproven producer escape', () =>
{
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');export {host as exportedHost};`, 'Renamed.ts');
    assert.throws(() => origin(source(), file), /escaped target producer output/);
});

test('bounded selector alias export must refuse unproven producer escape', () =>
{
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');const alias=host;export {alias as exportedHost};`, 'Alias.ts');
    assert.throws(() => origin(source(), file), /escaped target producer output/);
});

test('bounded selector container export must refuse unproven producer escape', () =>
{
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');const container={host};export {container};`, 'Container.ts');
    assert.throws(() => origin(source(), file), /escaped target producer output/);
});

test('bounded same-source selector reexport must refuse unproven producer escape', () =>
{
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');export {host as selected} from './SameSource.ts';`, 'SameSource.ts');
    assert.throws(() => origin(source(), file), /escaped target producer output/);
});

test('bounded indirect same-source selector reexport must refuse unproven producer escape', () =>
{
    fixture(`export {host as rebound} from './Indirect.ts';`, 'Barrel.ts');
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');export {rebound as publicHost} from './Barrel.ts';`, 'Indirect.ts');
    assert.throws(() => origin(source(), file), /escaped target producer output/);
});

test('bounded unrelated named export retains finite selector alternatives', () =>
{
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');const unrelated=1;export {unrelated as host};`, 'Unrelated.ts');
    const value = origin(source(), file);
    assert.deepEqual(value.variants.map(({ name }) => name), ['a', 'aside']);
});

test('bounded type-only selector exports retain finite runtime alternatives', () =>
{
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');export type {host};export {type host as HostType};`, 'TypeOnly.ts');
    const value = origin(source(), file);
    assert.deepEqual(value.variants.map(({ name }) => name), ['a', 'aside']);
});

test('bounded foreign same-named reexport retains local selector alternatives', () =>
{
    const foreign = fixture(`export const host='button';`, 'ForeignExport.ts');
    const file = fixture(`import {computed} from 'vue';const host=computed(()=>state?'a':'aside');export {host as foreignHost} from './ForeignExport.ts';`, 'ForeignReexport.ts');
    const value = origin(source(), file);
    assert.deepEqual(value.variants.map(({ name }) => name), ['a', 'aside']);
    assert.ok(value.resolverInputs.some(({ path }) => path === foreign));
});

test('actual complete target supplier bindings retain every original ordered fact and proof digest', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    const bindings = bindCompositionTargetInputs(s, node, inputs, graph.nodes);
    assert.equal(bindings.length, inputs.length);
    for (const binding of bindings)
    {
        assert.equal(binding.supplierDigest, controlDigest(s.resolveTargetInputs(node, graph)));
        assert.equal(binding.supplierCount, 2);
        const { proofDigest, ...facts } = binding;
        assert.equal(proofDigest, controlDigest(facts));
    }
    assert.deepEqual(graph.targetBindings.filter(({ sourceNode }) => sourceNode === node.id)
        .map(({ target, callPath, supplierDigest, supplierCount }) => ({ target, callPath, supplierDigest, supplierCount })),
    bindings.map(({ target, callPath, supplierDigest, supplierCount }) => ({ target, callPath, supplierDigest, supplierCount })));
});

test('complete target supplier binding rejects reversed actual input records', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, [...inputs].reverse(), graph.nodes), /complete canonical supplier set/);
});

test('complete target supplier binding rejects a duplicated call in place of its real alternative', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, [inputs[0], inputs[0]], graph.nodes), /complete canonical supplier set/);
});

test('complete target supplier binding rejects a cloned original graph array', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, inputs, [...graph.nodes]), /actual canonical graph/);
});

test('complete target supplier binding rejects an omitted graph node', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, inputs, graph.nodes.filter((entry) => entry !== node)), /actual canonical graph/);
});

test('complete target supplier binding rejects a reordered original graph array', () =>
{
    const { s, node, graph, inputs } = buttonInput();
    assert.throws(() => bindCompositionTargetInputs(s, node, inputs, [...graph.nodes].reverse()), /actual canonical graph/);
});

test('complete target supplier binding rejects actual call attributes changed after graph observation', () =>
{
    const { s, node, graph, calls, inputs } = buttonInput();
    calls[1].attributes.tag = 'aside';
    assert.throws(() => bindCompositionTargetInputs(s, node, inputs, graph.nodes), /supplier graph changed/);
});

test('complete target supplier binding rejects raw supplier source drift', () =>
{
    const { s, node, graph, calls, inputs } = buttonInput();
    writeFileSync(calls[0].file, readFileSync(calls[0].file, 'utf8') + '\n<!-- drift -->');
    assert.throws(() => bindCompositionTargetInputs(s, node, inputs, graph.nodes), /supplier source changed/);
});

test('actual complete target suppliers retain both forwarded RouterLink and native call paths', () =>
{
    const forwarded = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';const props=defineProps({tag:[String,Object]});</script><template><ElButton :tag="tag"/></template>`, 'TargetForwarder.vue');
    const entry = fixture(`<script setup>import TargetForwarder from './TargetForwarder.vue';import {RouterLink} from 'vue-router';</script><template><TargetForwarder :tag="RouterLink"/><TargetForwarder tag="a"/></template>`, 'ForwardedTargets.vue');
    const s = source();
    const graph = s.graph([entry]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    assert.ok(node);
    const inputs = s.resolveTargetInputs(node, graph);
    const bindings = bindCompositionTargetInputs(s, node, inputs, graph.nodes);
    assert.deepEqual(bindings.map(({ targetKind }) => targetKind), ['framework', 'native']);
    assert.equal(bindings[1].target.name, 'a');
    assert.ok(bindings.every(({ callPath }) => callPath.length === 2 && s.nodes.get(callPath[0]).file === forwarded
        && s.nodes.get(callPath[1]).file === entry));
    assert.equal(bindings[0].callPath[0], bindings[1].callPath[0]);
    assert.notEqual(bindings[0].callPath[1], bindings[1].callPath[1]);
    assert.ok(bindings.every(({ supplierCount }) => supplierCount === 2));
});

test('actual complete target suppliers retain native default and proven absent spread fields', () =>
{
    const entry = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';</script><template><ElButton/><ElButton v-bind="{tag:'a'}"/><ElButton v-bind="{title:'aside-button'}" tag="aside"/></template>`, 'DefaultSpreadTargets.vue');
    const s = source();
    const graph = s.graph([entry]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    assert.ok(node);
    const inputs = s.resolveTargetInputs(node, graph);
    const bindings = bindCompositionTargetInputs(s, node, inputs, graph.nodes);
    assert.deepEqual(bindings.map(({ targetKind }) => targetKind), ['native', 'native', 'native']);
    assert.deepEqual(bindings.map(({ target }) => target.name), ['button', 'a', 'aside']);
    assert.ok(bindings.every(({ supplierCount }) => supplierCount === 3));
});

test('complete target supplier binding refuses a known prefix when another actual supplier is unknown', () =>
{
    const entry = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';import {RouterLink} from 'vue-router';</script><template><ElButton :tag="RouterLink"/><ElButton :tag="unknown"/></template>`, 'UnknownTargetSupplier.vue');
    const s = source();
    const graph = s.graph([entry]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    const call = graph.nodes.find((entry) => entry.definition === node.file);
    const target = s.resolver.resolveTag(entry, 'RouterLink');
    assert.throws(() => bindCompositionTargetInputs(s, node, [{ target, callPath: [call.id] }], graph.nodes), /unknown|unbound|supplier|finite/);
});


test('complete target supplier binding refuses a Component union annotation without its actual supplier declaration', () =>
{
    const forwarded = fixture(`<script setup lang="ts">import {ElButton} from '@ozwasyd/element-plus';import type {Component} from 'vue';const props=defineProps<{tag:Component|string}>();</script><template><ElButton :tag="tag"/></template>`, 'TypedTargetForwarder.vue');
    const entry = fixture(`<script setup>import TypedTargetForwarder from './TypedTargetForwarder.vue';import {RouterLink} from 'vue-router';</script><template><TypedTargetForwarder :tag="RouterLink"/><TypedTargetForwarder tag="a"/></template>`, 'TypedForwardedTargets.vue');
    const s = source();
    const graph = s.graph([entry]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    const inner = graph.nodes.find((entry) => entry.file === forwarded && entry.definition === node.file);
    const outer = graph.nodes.find((call) => call.file === entry && call.definition === forwarded);
    assert.ok(inner && outer);
    const inputs = [{ target: s.resolver.resolveTag(entry, 'RouterLink'), callPath: [inner.id, outer.id] }];
    assert.throws(() => bindCompositionTargetInputs(s, node, inputs, graph.nodes), /mutable\/unknown component input/);
});

test('complete target supplier binding refuses conflicting literal spread and explicit tag values', () =>
{
    const entry = fixture(`<script setup>import {ElButton} from '@ozwasyd/element-plus';</script><template><ElButton v-bind="{tag:'a'}" tag="aside"/></template>`, 'ConflictingSpreadTarget.vue');
    const s = source();
    const graph = s.graph([entry]);
    const node = graph.nodes.find((entry) => entry.file.endsWith('/button/src/button.vue') && entry.origin.kind === 'native-prop');
    const call = graph.nodes.find((entry) => entry.definition === node.file);
    assert.throws(() => bindCompositionTargetInputs(s, node, [{ target: { kind: 'native', name: 'aside' }, callPath: [call.id] }], graph.nodes), /ambiguous component input/);
});
