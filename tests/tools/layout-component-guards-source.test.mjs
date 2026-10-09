import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { controlDigest } from '@fsusblog/control-legality/source';
import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `component-guards-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(name, content)
{
    const file = resolve(directory, name);
    writeFileSync(file, content);
    return file;
}
function localGraph(guard, { supplied = '', script = '', prefix = '' } = {})
{
    fixture('Owner.vue', `<script setup>const props=defineProps({glyph:{type:[Object,Function]}});${script}</script><template>${prefix}<span ${guard}><component :is="glyph"/></span></template>`);
    const entry = fixture('Entry.vue', `<script setup>import Owner from './Owner.vue';</script><template><Owner ${supplied}/></template>`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([entry]);
}

test('actual Switch conjunctive else-if guards bind absent action icons without discarding its unknown selector', () =>
{
    const entry = fixture('Switch.vue', '<script setup>import {ElSwitch} from "@ozwasyd/element-plus";</script><template><ElSwitch/><ElSwitch/><ElSwitch/></template>');
    const graph = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([entry]);
    const actionNodes = graph.nodes.filter((node) => node.file.endsWith('/switch/src/switch.vue') && [1591, 1718].includes(node.offset));
    assert.equal(actionNodes.length, 2);
    const ids = new Set(actionNodes.map((node) => node.id));
    const bindings = graph.componentPropBindings.filter((entry) => ids.has(entry.sourceNode));
    assert.equal(bindings.length, 6);
    assert.ok(bindings.every((entry) => entry.absent && entry.target === null && entry.absenceGuard.directive === 'else-if'));
    assert.ok(bindings.every((entry) => entry.absenceGuard.expressionDigest === controlDigest(entry.absenceGuard.expression)));
    assert.ok(graph.errors.every((error) => !error.file?.endsWith('/switch/src/switch.vue') || ![1591, 1718].includes(error.offset)));
    assert.ok(graph.errors.some((error) => error.file?.endsWith('/switch/src/switch.vue') && error.offset === 1063
        && error.reason === 'unknown-component-source'));
});

for (const guard of ['v-if="glyph && state"', 'v-if="state && (glyph)"', 'v-if="state && (other && glyph)"', 'v-else-if="glyph && state"'])
{
    test(`an actual conjunction can prove absence: ${guard}`, () =>
    {
        const prefix = guard.startsWith('v-else-if') ? '<span v-if="other"/>' : '';
        const result = localGraph(guard, { prefix });
        assert.deepEqual(result.errors, []);
        assert.equal(result.componentPropBindings.length, 1);
        assert.equal(result.componentPropBindings[0].absent, true);
        assert.ok(result.componentPropBindings[0].absenceGuard);
    });
}
for (const [label, guard, options] of [
    ['disjunction', 'v-if="glyph || state"', {}],
    ['negation', 'v-if="!glyph && state"', {}],
    ['condition alias', 'v-if="enabled"', {script:'const enabled=props.glyph;'}],
    ['unguarded else', 'v-else', {prefix:'<span v-if="state"/>'}],
    ['unknown supplied input', 'v-if="glyph && state"', {supplied:':glyph="unknown"'}]
])
{
    test(`absence cannot authorize ${label}`, () =>
    {
        const result = localGraph(guard, options);
        assert.ok(result.errors.some((error) => error.reason === 'unbound-component-prop-source'));
    });
}
