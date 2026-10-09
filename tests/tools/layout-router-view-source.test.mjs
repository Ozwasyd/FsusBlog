import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';
import { resolveCompositionRoutes, resolveCompositionRouterViewSlot, bindCompositionArchetypes } from '@fsusblog/layout-governance/composition-routes';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `router-view-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
const source = () => createCompositionSource({ repositoryRoot, fsusUIRoot });
function file(name, content)
{
    const path = resolve(directory, name);
    writeFileSync(path, content);
    return path;
}
function fixture(markup = '<RouterView v-slot="{ Component }"><component :is="Component"/></RouterView>', views = "component:()=>import('./Leaf.vue')")
{
    const owner = file('Owner.vue', `<script setup>import {RouterView} from 'vue-router';import Leaf from './Leaf.vue';</script><template>${markup}</template>`);
    file('Leaf.vue', '<template><section/></template>');
    const router = file('Router.ts', `import {createRouter} from 'vue-router';
const routes=[{path:'/',component:()=>import('./Owner.vue'),children:[{path:'leaf',${views}}]}];
createRouter({routes});`);
    const s = source();
    const routes = resolveCompositionRoutes(s, router);
    const offset = readFileSync(owner, 'utf8').indexOf('<component');
    return { s, owner, router, routes, offset };
}
const bind = ({ s, owner, routes, offset }, options = {}) => resolveCompositionRouterViewSlot(s, routes, { file: owner, offset, ...options });

test('real BlogLayout slot retains exact original route suppliers without runtime selection', () =>
{
    const s = source();
    const router = resolve(repositoryRoot, 'src/frontend/src/router/index.ts');
    const routes = resolveCompositionRoutes(s, router);
    const owner = resolve(repositoryRoot, 'src/frontend/src/layouts/BlogLayout.vue');
    const proof = bind({ s, owner, routes, offset: readFileSync(owner, 'utf8').indexOf('<component') });
    assert.equal(proof.slotOwner.property, 'Component');
    assert.equal(proof.slotOwner.origin.registration, 'vue-router:createRouter');
    assert.equal(proof.routeOwner.file, owner);
    assert.ok(proof.variantDefinitions.some((file) => file.endsWith('/views/ArticleDetail.vue')));
    assert.ok(proof.alternatives.every((entry) => entry.matchedRecords[0].componentViews.default === owner));
    assert.ok(proof.resolverInputs.some((entry) => entry.path.endsWith('/router/appRouteRecords.ts')));
    assert.equal(proof.qualificationEligible, false);
    const { matrix } = loadCompositionInputs({ repositoryRoot, fsusUIRoot });
    assert.deepEqual(bindCompositionArchetypes(matrix, routes).flatMap((binding) => binding.errors), []);
});

test('finite route suppliers retain empty views and nested immediate outlets', () =>
{
    const f = fixture();
    const proof = bind(f);
    assert.deepEqual(proof.variants, [{ kind: 'local', file: resolve(directory, 'Leaf.vue'), name: 'default' }]);
    assert.deepEqual(proof.alternatives.map((entry) => entry.kind), ['empty-view', 'component']);
    assert.equal(proof.alternatives[1].componentFile, resolve(directory, 'Leaf.vue'));
});

test('actual slot destructuring aliases keep the Component property supplier', () =>
{
    const proof = bind(fixture('<RouterView v-slot="{ Component: View }"><component :is="View"/></RouterView>'));
    assert.equal(proof.slotOwner.binding, 'View');
    assert.equal(proof.slotOwner.property, 'Component');
});

test('named views keep their own original component declaration', () =>
{
    const f = fixture('<RouterView name="aside" v-slot="{ Component }"><component :is="Component"/></RouterView>', "components:{aside:()=>import('./Leaf.vue')}");
    const proof = bind(f);
    assert.equal(proof.alternatives[1].viewName, 'aside');
    assert.equal(proof.alternatives[1].componentFile, resolve(directory, 'Leaf.vue'));
});

test('an imported RouterView alias binds through the actual canonical framework import', () =>
{
    const f = fixture('<Outlet v-slot="{Component}"><component :is="Component"/></Outlet>');
    writeFileSync(f.owner, readFileSync(f.owner, 'utf8').replace('{RouterView}', '{RouterView as Outlet}'));
    f.offset = readFileSync(f.owner, 'utf8').indexOf('<component');
    assert.equal(bind(f).slotOwner.origin.publicName, 'RouterView');
});

test('componentless records pass through while an explicitly empty components object stops the next outlet', () =>
{
    for (const [declaration, expected] of [['', 'component'], ['components:{},', 'empty-view']])
    {
        const f = fixture();
        file('Router.ts', `import {createRouter} from 'vue-router';createRouter({routes:[{path:'/',component:()=>import('./Owner.vue'),
children:[{path:'pass',${declaration}children:[{path:'leaf',component:()=>import('./Leaf.vue')}]}]}]});`);
        f.s = source();
        f.routes = resolveCompositionRoutes(f.s, f.router);
        const proof = bind(f);
        assert.equal(proof.alternatives.find((entry) => entry.path === '/pass/leaf').kind, expected);
    }
});

test('competing singular and named component declarations retain an explicit refusal', () =>
{
    const f = fixture(undefined, "component:()=>import('./Leaf.vue'),components:{aside:()=>import('./Leaf.vue')}");
    assert.throws(() => bind(f), /ambiguous route owner or named-view declaration/);
});

test('real reusable AccountRouteFrame requires its actual route-owner call path', () =>
{
    const s = source();
    const routes = resolveCompositionRoutes(s, resolve(repositoryRoot, 'src/frontend/src/router/index.ts'));
    const admin = resolve(repositoryRoot, 'src/frontend/src/layouts/AdminWorkspaceFrame.vue');
    const owner = resolve(repositoryRoot, 'src/frontend/src/layouts/AccountRouteFrame.vue');
    s.graph([admin]);
    const call = [...s.nodes.values()].find((node) => node.file === admin && node.definition === owner);
    assert.ok(call);
    const f = { s, owner, routes, offset: readFileSync(owner, 'utf8').indexOf('<component') };
    assert.throws(() => bind(f), /no actual route declaration/);
    const proof = bind(f, { callPath: [call.id] });
    assert.equal(proof.routeOwner.file, admin);
    assert.equal(proof.routeOwner.callPath[0].definition, owner);
    assert.ok(proof.variantDefinitions.some((file) => file.endsWith('/views/admin/Dashboard.vue')));
    assert.ok(!proof.variantDefinitions.some((file) => file.endsWith('/PublicArticleDetailPageContent.vue')));
    assert.throws(() => bind(f, { callPath: ['forged'] }), /actual component definitions/);
    assert.throws(() => bind(f, { callPath: [call.id, call.id] }), /cyclic/);
});

for (const [label, markup, refusal] of [
    ['unrelated slot owner', '<Leaf v-slot="{Component}"><component :is="Component"/></Leaf>', /canonical RouterView/],
    ['unknown binding', '<RouterView v-slot="{ Other }"><component :is="Other"/></RouterView>', /actual RouterView Component/],
    ['slot default expression', '<RouterView v-slot="{Component=Unknown}"><component :is="Component"/></RouterView>', /binding pattern/],
    ['spread selector supplier', '<RouterView v-slot="{Component}"><component :is="Component" v-bind="unknown"/></RouterView>', /exact authored/],
    ['shadow loop', '<RouterView v-slot="{Component}"><component v-for="Component in unknown" :is="Component"/></RouterView>', /shadow scope/],
    ['unknown view name', '<RouterView :name="unknown" v-slot="{Component}"><component :is="Component"/></RouterView>', /view-name supplier/],
    ['custom route override', '<RouterView :route="unknown" v-slot="{Component}"><component :is="Component"/></RouterView>', /view-name supplier/],
    ['nested RouterView depth', '<RouterView><RouterView v-slot="{Component}"><component :is="Component"/></RouterView></RouterView>', /RouterView depth/],
    ['compound selector', '<RouterView v-slot="{Component}"><component :is="unknown ? Component : Other"/></RouterView>', /selector expression/]
])
{
    test(`unknown route supplier refuses ${label}`, () => assert.throws(() => bind(fixture(markup)), refusal));
}

test('route observation cannot be cloned, retargeted or mutated into authority', () =>
{
    const f = fixture();
    assert.throws(() => bind({ ...f, routes: JSON.parse(JSON.stringify(f.routes)) }), /original source observation/);
    assert.throws(() => bind({ ...f, s: source() }), /original source observation/);
    f.routes.routes[1].matchedRecords[1].componentViews.default = f.owner;
    assert.throws(() => bind(f), /original source observation/);
});

test('changed router or slot source bytes invalidate the original declaration observation', () =>
{
    for (const selected of ['router', 'owner'])
    {
        const f = fixture();
        bind(f);
        writeFileSync(f[selected], readFileSync(f[selected], 'utf8') + '\n');
        assert.throws(() => bind(f), /source inputs changed/);
    }
});

test('an arbitrary offset cannot select a different slot supplier', () =>
{
    const f = fixture();
    assert.throws(() => bind({ ...f, offset: f.offset + 1 }), /exact authored/);
});
