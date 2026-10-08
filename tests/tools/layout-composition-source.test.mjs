import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionRun, createLocalCompositionBaseline } from '@fsusblog/layout-governance/composition-analyzer';
import { loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';
import { resolveCompositionRoutes, bindCompositionArchetypes } from '@fsusblog/layout-governance/composition-routes';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual FsusUI checkout is required; no synthetic public API');
const directory = resolve(repositoryRoot, '.tmp', `composition-source-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
const source = () => createCompositionSource({ repositoryRoot, fsusUIRoot });
function fixture(content, name = 'Fixture.vue')
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
test.after(() => rmSync(directory, { recursive: true, force: true }));

test('all twelve fixtures bind to actual router AST/import graph without a second map', () =>
{
    const s = source();
    const routes = resolveCompositionRoutes(s, resolve(repositoryRoot, 'src/frontend/src/router/index.ts'));
    const { matrix } = loadCompositionInputs({ repositoryRoot, fsusUIRoot });
    const bindings = bindCompositionArchetypes(matrix, routes);
    assert.equal(bindings.length, 12);
    assert.deepEqual(bindings.flatMap((binding) => binding.errors), []);
    assert.ok(bindings.every((binding) => binding.entryFiles.length > 0));
    assert.ok(bindings.every((binding) => binding.entryFiles.every((file) => readFileSync(file, 'utf8').length)));
});

test('public aliases follow the real withInstall property factory and source file', () =>
{
    const s = source();
    const file = fixture('<script setup>import { FsusTaskPageHeader as Header } from "@ozwasyd/element-plus"</script><template><Header title="Current"/></template>');
    const graph = s.graph([file]);
    assert.deepEqual(graph.errors, []);
    const call = graph.nodes.find((node) => node.tag === 'Header');
    assert.equal(call.origin.publicName, 'FsusTaskPageHeader');
    assert.ok(graph.nodes.some((node) => node.file === call.definition && node.origin.kind === 'native-variants' && node.origin.default === 'h1'));
});

test('slot branches, teleport and responsive directives retain concrete node locations', () =>
{
    fixture('<template><slot :open="true"/></template>', 'SlotOwner.vue');
    const file = fixture('<script setup>import SlotOwner from "./SlotOwner.vue"</script><template><section><SlotOwner><template #default="scope"><p v-if="scope.open">A</p><p v-else>B</p></template></SlotOwner><Teleport to="body"><aside v-show="open">X</aside></Teleport></section></template>');
    const graph = source().graph([file]);
    assert.deepEqual(graph.errors, []);
    assert.ok(graph.nodes.some((node) => node.slot));
    assert.equal(graph.nodes.filter((node) => node.file === file && node.conditional.length).length, 3);
    assert.ok(graph.nodes.some((node) => node.teleport));
    assert.ok(graph.nodes.every((node) => node.line > 0 && node.sourceDigest.length === 64));
});

test('malformed Vue AST fails closed', () =>
{
    const graph = source().graph([fixture('<template><section><p></section></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'unknown-ast-parse'));
});

test('unknown component and dynamic source fail closed despite plausible labels', () =>
{
    const graph = source().graph([fixture('<template><UnknownPanel data-fsus-surface="document"/><component :is="unknownView"/></template>')]);
    assert.equal(graph.errors.filter((error) => error.reason === 'unknown-component-source').length, 2);
});

test('route-name branching resolves useRoute aliases and computed element access', () =>
{
    const graph = source().graph([fixture('<script setup>import {useRoute as activeRoute} from "vue-router";const current = activeRoute();const good = current["name"] === "representative";</script><template><h1 v-if="good">Good</h1></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'route-name-visual-branch'));
});

test('route-name business reads do not become a visual branch without a layout sink', () =>
{
    const graph = source().graph([fixture('<script setup>import {useRoute} from "vue-router";const route=useRoute();const navigationIdentity=route.name;</script><template><h1>Current</h1></template>')]);
    assert.deepEqual(graph.errors, []);
});

test('destructured route name flowing through class data fails closed', () =>
{
    const graph = source().graph([fixture('<script setup>import {useRoute} from "vue-router";const {name:page}=useRoute();const good=page==="representative";const density=good?"good":"bad";</script><template><h1 :class="density">Current</h1></template>')]);
    assert.ok(graph.errors.some((error) => error.reason === 'route-name-visual-branch'));
});

test('imported local wrapper remains local through a public-looking alias', () =>
{
    fixture('<template><div data-fsus-surface="control-group"/></template>', 'Wrapper.vue');
    const graph = source().graph([fixture('<script setup>import FsusTaskPageHeader from "./Wrapper.vue"</script><template><FsusTaskPageHeader/></template>')]);
    const call = graph.nodes.find((node) => node.tag === 'FsusTaskPageHeader');
    assert.equal(call.origin.kind, 'local');
    assert.ok(call.definition.endsWith('/Wrapper.vue'));
});

test('instrumentation binds original bytes and rejects authored provenance markers', () =>
{
    const s = source();
    const file = fixture('<template><h1>Current</h1></template>');
    const code = readFileSync(file, 'utf8');
    assert.ok(s.instrument(file, code).includes('data-fsus-composition-node'));
    assert.throws(() => s.instrument(file, code + ' '), /source changed/);
    assert.throws(() => source().instrument(fixture('<template><h1 data-fsus-composition-node="fake">X</h1></template>'), '<template><h1 data-fsus-composition-node="fake">X</h1></template>'), /reserved source marker/);
});

test('actual contract, design and FsusUI digests are bound to the current run', () =>
{
    const baseline = createLocalCompositionBaseline(fsusUIRoot);
    const run = createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity: baseline, runId: randomUUID() });
    assert.equal(run.verifyCurrent(), true);
    assert.ok(run.analyzerDigest.length === 64 && run.worktree.worktreeDigest.length === 64);
    const drift = { ...baseline, gitHead: 'a'.repeat(40) };
    assert.throws(() => createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity: drift, runId: randomUUID() }), /baseline mismatch/);
});
