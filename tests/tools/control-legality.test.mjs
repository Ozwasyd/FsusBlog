import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    controlDigest,
    controlLegalityVersion,
    createControlSourceResolver,
    scanControlLegality,
    validateControlRegistry,
    verifyPublicControlParity
} from '@fsusblog/control-legality/source';

const { resolveLocalFsusUiRepositoryRoot } = await import(new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fsusUIRoot = resolveLocalFsusUiRepositoryRoot({ repositoryRoot });
const emptyRegistry = () => ({ schema: controlLegalityVersion, entries: [] });

function fixture(t, files)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-control-legality-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [relative, content] of Object.entries({
        'src/frontend/vite.config.ts': fs.readFileSync(path.join(repositoryRoot, 'src/frontend/vite.config.ts'), 'utf8'),
        'src/frontend/package.json': fs.readFileSync(path.join(repositoryRoot, 'src/frontend/package.json'), 'utf8'),
        'src/frontend/src/router/index.ts': "import { createRouter } from 'vue-router'; export const router = createRouter({});",
        ...files
    }))
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    const resolver = createControlSourceResolver({ repositoryRoot: root, parserRoot: repositoryRoot, fsusUIRoot });
    return { root, resolver, scan: (registry = emptyRegistry(), extra = {}) => scanControlLegality({
        repositoryRoot: root, resolver, registry, ...extra }) };
}

function source(t, template, script = '')
{
    return fixture(t, { 'src/frontend/src/Fixture.vue': `<template>${template}</template><script setup lang="ts">${script}</script>` });
}

function rejected(result, reason)
{
    assert.equal(result.qualified, false);
    assert.ok(result.errors.some((error) => error.reason.includes(reason)), JSON.stringify(result.errors));
    const diagnostic = result.errors.find((error) => error.path && error.line);
    assert.ok(diagnostic, 'source errors must be locatable');
    assert.ok(diagnostic.column > 0);
}

const sourceMutations = [
    ['01 raw button', '<button>Save</button>', '', 'unregistered-control'],
    ['02 checkbox/radio/text inputs', '<input type="checkbox"/><input type="radio"/><input type="text"/>', '', 'unregistered-control'],
    ['03 textarea/select', '<textarea/><select><option>One</option></select>', '', 'unregistered-control'],
    ['04 role/tabindex activation', '<div role="button" tabindex="0" @click="save">Save</div>', 'const save = () => {};', 'unregistered-control'],
    ['05 local pressed segmented', '<button :aria-pressed="selected" @click="selected = !selected">Choice</button>', 'let selected = false;', 'unregistered-control'],
    ['06 local switch track', '<span role="switch" :aria-checked="selected" tabindex="0" @click="selected = !selected"/>', 'let selected = false;', 'unregistered-control'],
    ['07 local menu keyboard kernel', '<div role="menuitem" tabindex="0" @keydown="key">Item</div>', "const key = (e: KeyboardEvent) => { if (e.key === 'ArrowDown' || e.key === 'Escape') {} };", 'unproved-generic-control-responsibility'],
    ['08 Teleport dialog', '<Teleport to="body"><div role="dialog" tabindex="0"/></Teleport>', "import { Teleport } from 'vue';", 'unregistered-control'],
    ['09 third party import/tag', '<ThirdPartyButton/>', "import { Button as ThirdPartyButton } from 'other-ui';", 'unregistered-control'],
    ['11 renamed generic wrapper', '<ElButton :disabled="disabled" :size="size">Save</ElButton>', 'defineProps<{ modelValue: string; disabled: boolean; size: string }>();', 'unproved-generic-control-responsibility'],
    ['12 hidden native fallback', '<ElButton>Save</ElButton><button hidden>Fallback</button>', '', 'unregistered-control'],
    ['13 nested interactive', '<button><ElButton>Save</ElButton></button>', '', 'nested-interactive'],
    ['14 unregistered framework bridge', '<RouterLink to="/next">Next</RouterLink>', "import { RouterLink } from 'vue-router';", 'unregistered-control'],
    ['20 parser/source resolution failure', '<UnknownWidget/>', '', 'unresolved component tag'],
    ['21 comment/environment suppression', '<!-- fsusui ignore --><button v-if="enabled">Save</button>', "const enabled = !process.env.FSUSBLOG_SKIP_FSUSUI;", 'unregistered-control']
];
for (const [name, template, script, reason] of sourceMutations)
{
    test(`mutation ${name}`, (t) => rejected(source(t, template, script).scan(), reason));
}

test('mutation 10 a local el-button shadows the actual global export', (t) =>
{
    const instance = fixture(t, {
        'src/frontend/src/Fake.vue': '<template><button>Fake</button></template>',
        'src/frontend/src/Fixture.vue': '<template><el-button/></template><script setup>import ElButton from "./Fake.vue";</script>'
    });
    const result = instance.scan();
    rejected(result, 'unregistered-control');
    const shadow = result.controls.find((control) => control.controlKind === 'el-button');
    assert.equal(shadow.resolvedSource.kind, 'local');
    assert.ok(shadow.resolvedSource.file.endsWith('Fake.vue'));
});

function registration(control, classification = 'semantic-native')
{
    const value = { schema: controlLegalityVersion, id: 'exact-fixture-control', path: control.path,
        identity: control.identity, sourceLocation: structuredClone(control.sourceLocation), classification,
        productSemantics: classification === 'composition' ? ['plugin-installation'] : [],
        fsusUiPrimitives: classification === 'composition' ? ['ElButton'] : [],
        reason: 'precise document/browser/product responsibility fixture', owner: 'fixture-owner',
        allowedResponsibilities: ['document-navigation'], forbiddenGenericResponsibilities: ['selection-kernel'],
        requiredTestIds: ['playwright:fixture#authority'], upstreamIssue: null, reviewAfter: null,
        removalCondition: 'remove when this exact owned semantic occurrence is removed' };
    return { ...value, contentDigest: controlDigest(value) };
}

// These maps test the pure validator model. They are never emitted as runtime
// receipts: production admission derives tests from the sole real catalog and
// independently verifies current source-bound observation artifacts.
const testCatalog = new Map([['playwright:fixture#authority', { executable: true, kind: 'browser', lanes: ['fast', 'ci', 'release'] }]]);
const testExecutions = new Map([['playwright:fixture#authority', { verified: true, status: 'passed' }]]);
function validation(entry, control, overrides = {})
{
    return validateControlRegistry({ registry: { schema: controlLegalityVersion, entries: [entry] },
        controls: [control], testCatalog, testExecutions, now: new Date('2026-10-08T00:00:00Z'), ...overrides });
}

const registryMutations = [
    ['15 broad registration', (entry) =>
    {
        entry.path = 'src/frontend/src/**';
    }, {}, 'broad-or-unowned-registration'],
    ['16 registration without executable tests', (entry) =>
    {
        entry.requiredTestIds = ['missing'];
    }, {}, 'missing-executable-test'],
    ['17 expired capability gap', (entry) =>
    {
        entry.classification = 'capability-gap';
        entry.upstreamIssue = 'upstream';
        entry.reviewAfter = '2026-10-07T00:00:00Z';
    }, {}, 'expired-capability-gap'],
    ['18 missing open upstream issue', (entry) =>
    {
        entry.classification = 'capability-gap';
        entry.upstreamIssue = 'closed';
        entry.reviewAfter = '2026-12-01T00:00:00Z';
    }, {}, 'missing-open-upstream-capability'],
    ['19 moved occurrence', (entry) =>
    {
        entry.sourceLocation.offset += 1;
    }, {}, 'missing-moved-or-duplicate-occurrence']
];
for (const [name, mutate, overrides, reason] of registryMutations)
{
    test(`mutation ${name}`, (t) =>
    {
        const control = source(t, '<a href="/read">Read</a>').scan().controls[0];
        const entry = registration(control);
        mutate(entry);
        const unsigned = { ...entry };
        delete unsigned.contentDigest;
        entry.contentDigest = controlDigest(unsigned);
        assert.ok(validation(entry, control, overrides).some((error) => error.reason.includes(reason)));
    });
}

test('mutation 22 local/published identity difference is not waived', (t) =>
{
    const local = source(t, '<ElButton/>').scan();
    const published = structuredClone(local);
    published.controls[0].resolvedSource.publicName = 'OtherButton';
    assert.throws(() => verifyPublicControlParity(local, published), /identity mismatch/u);
    published.controls[0].resolvedSource.publicName = local.controls[0].resolvedSource.publicName;
    published.controls[0].resolvedSource.exportName = 'SameNameDifferentSource';
    assert.throws(() => verifyPublicControlParity(local, published), /identity mismatch/u);
});

test('actual app registration resolves an imported public component and rejects a shadow owner', (t) =>
{
    const instance = fixture(t, {
        'src/frontend/src/register.ts': "import { createApp } from 'vue';import { ElButton } from '@ozwasyd/element-plus';const app = createApp({});app.component('SaveAction', ElButton);",
        'src/frontend/src/Fixture.vue': '<template><SaveAction>Save</SaveAction></template>'
    });
    const result = instance.scan();
    assert.deepEqual(result.errors, []);
    assert.equal(result.controls[0].resolvedSource.publicName, 'ElButton');
});

test('unknown resolver callback and invalid template expressions fail closed', (t) =>
{
    const instance = fixture(t, {
        'src/frontend/vite.config.ts': "import Components from 'unplugin-vue-components/vite';Components({resolvers:[(name)=>{if (unknown(name)) {return {name,from:'@ozwasyd/element-plus'};}}]});",
        'src/frontend/src/Fixture.vue': '<template><ElButton/></template>'
    });
    rejected(instance.scan(), 'unknown Vite resolver conditional state');
    rejected(source(t, '<button @click="broken("/>').scan(), 'parser failure');
});

test('positive actual global import and direct adapter resolve the same public declaration', (t) =>
{
    const instance = fixture(t, {
        'src/frontend/src/fsusui/button.ts': "export { ElButton as FsusUiButton } from '@ozwasyd/element-plus';",
        'src/frontend/src/fsusui/index.ts': "export * from './button';",
        'src/frontend/src/Fixture.vue': '<template><el-button>Global</el-button><FsusUiButton>Adapter</FsusUiButton></template><script setup>import { FsusUiButton } from "@/fsusui";</script>'
    });
    const result = instance.scan();
    assert.deepEqual(result.errors, []);
    assert.equal(result.controls.length, 2);
    assert.ok(result.controls.every((control) => control.resolvedSource.publicName === 'ElButton'));
});

for (const [classification, template, script] of [
    ['semantic-native', '<a href="/read">Read</a>', ''],
    ['browser-native-bridge', '<input type="file"/>', ''],
    ['framework-bridge', '<RouterLink to="/read">Read</RouterLink>', "import { RouterLink } from 'vue-router';"]
])
{
    test(`positive exact ${classification} registry model; runtime evidence is a separate gate`, (t) =>
    {
        const instance = source(t, template, script);
        const scanned = instance.scan();
        const control = classification === 'framework-bridge'
            ? scanned.controls.find((entry) => entry.controlKind === 'framework-definition') : scanned.controls[0];
        const entry = registration(control, classification);
        assert.deepEqual(validation(entry, control), []);
        assert.equal(instance.scan({ schema: controlLegalityVersion, entries: [entry] }, { testCatalog, testExecutions }).qualified, true);
        assert.ok(validation(entry, control, { testExecutions: new Map() }).some((error) => error.reason.startsWith('unexecuted-test')));
    });
}

test('positive product composition delegates public controls and binds one component definition', (t) =>
{
    const instance = fixture(t, {
        'src/frontend/src/Product.vue': '<template><ElButton @click="$emit(\'install-plugin\', pluginId)">Install</ElButton></template><script setup lang="ts">defineProps<{pluginId:string}>();defineEmits<{(e:"install-plugin",id:string):void}>();</script>',
        'src/frontend/src/Fixture.vue': '<template><Product plugin-id="one"/><Product plugin-id="two"/></template><script setup>import Product from "./Product.vue";</script>'
    });
    const first = instance.scan();
    const control = first.controls.find((entry) => entry.controlKind === 'composition');
    const entry = registration(control, 'composition');
    assert.deepEqual(validation(entry, control), []);
    const result = instance.scan({ schema: controlLegalityVersion, entries: [entry] }, { testCatalog, testExecutions });
    assert.deepEqual(result.errors, []);
    assert.equal(result.controls.filter((entry) => entry.registryRef === 'exact-fixture-control').length, 3);
});

test('positive nonexpired gap model rejects a now available capability', (t) =>
{
    const control = source(t, '<button>Missing capability</button>').scan().controls[0];
    const entry = registration(control, 'capability-gap');
    entry.upstreamIssue = 'upstream';
    entry.reviewAfter = '2026-12-01T00:00:00Z';
    const unsigned = { ...entry };
    delete unsigned.contentDigest;
    entry.contentDigest = controlDigest(unsigned);
    const upstreamIssues = new Map([['upstream', { repository: 'Ozwasyd/FsusUI', state: 'open', missingCapability: 'fixture exact capability', capabilityAvailable: false }]]);
    assert.deepEqual(validation(entry, control, { upstreamIssues }), []);
    upstreamIssues.get('upstream').capabilityAvailable = true;
    assert.ok(validation(entry, control, { upstreamIssues }).some((error) => error.reason === 'upstream-capability-already-available'));
});

test('dynamic target, aliases, native TS render and parser corruption cannot evade discovery', (t) =>
{
    const dynamic = source(t, '<component :is="choice"/>', "import { ElButton as Action } from '@ozwasyd/element-plus'; const choice = true ? Action : 'button';");
    const result = dynamic.scan();
    assert.equal(result.controls.filter((entry) => entry.controlKind === 'dynamic-component').length, 2);
    rejected(result, 'unregistered-control');
    const rendered = fixture(t, { 'src/frontend/src/render.ts': "import {h} from 'vue';export const render=()=>h('button',{onClick:()=>{}},'Save');" }).scan();
    rejected(rendered, 'unregistered-control');
    const factory = fixture(t, { 'src/frontend/src/factory.ts': "export const control = document.createElement('button');" }).scan();
    rejected(factory, 'unregistered-control');
    const invalid = source(t, '<ElButton/>', 'const = broken;').scan();
    rejected(invalid, 'TypeScript parser failure');
});

test('ordinary native document structure is outside interaction registration', (t) =>
{
    const result = source(t, '<div><a id="chapter"/><input type="hidden" name="metadata"/><video src="clip.webm"/><span>Text</span></div>').scan();
    assert.deepEqual(result.errors, []);
    assert.equal(result.controls.length, 0);
});

test('compiler-owned Vue structure preserves child controls; computed choices and recursion resolve', (t) =>
{
    const instance = source(t, '<Transition><component :is="tag"/></Transition>', "import { computed } from 'vue';const tag = computed(() => true ? 'button' : 'input');");
    const result = instance.scan();
    rejected(result, 'unregistered-control');
    assert.equal(result.controls.length, 2);
    const recursive = source(t, '<Fixture/>').scan();
    assert.ok(recursive.controls.some((control) => control.resolvedSource?.registration === 'vue:sfc-self-reference'));
});
