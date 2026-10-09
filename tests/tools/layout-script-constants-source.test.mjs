import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCompositionSource } from '@fsusblog/layout-governance/composition-source';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fsusUIRoot = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT;
assert.ok(fsusUIRoot, 'an actual public FsusUI checkout is required');
const directory = resolve(repositoryRoot, '.tmp', `script-constants-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function graph(body)
{
    const file = resolve(directory, 'Owner.tsx');
    writeFileSync(file, `import {defineComponent,h} from 'vue'; export default defineComponent({setup(){return () => {${body}};}});`);
    return createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
}

test('actual Overlay shorthand vnode props retain both native branches and default slots', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/overlay/src/overlay.ts');
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
    assert.deepEqual(result.errors, []);
    const native = result.nodes.filter((node) => node.origin.kind === 'native');
    assert.equal(native.length, 2);
    assert.ok(native.every((node) => node.tag === 'div' && node.conditional.length));
    assert.equal(result.nodes.filter((node) => node.tag === 'slot').length, 2);
    assert.ok(native.some((node) => node.directives.some((directive) => directive.argument === 'onClick' && directive.expression === 'onClick')));
});

test('actual Tabs finite spread resolves header panels and button constants without hiding unknown TabNav output', () =>
{
    const file = resolve(fsusUIRoot, 'vue/packages/components/tabs/src/tabs.tsx');
    const result = createCompositionSource({ repositoryRoot, fsusUIRoot }).graph([file]);
    assert.ok(result.nodes.some((node) => node.file === file && node.tag === 'span' && node.attributes.tabindex === '0'));
    assert.ok(result.nodes.some((node) => node.file === file && node.tag === 'TabNav' && node.definition.endsWith('/tab-nav.tsx')));
    assert.ok(result.nodes.some((node) => node.file === file && node.tag === 'slot' && node.attributes.name === 'default'));
    assert.ok(result.errors.every((error) => error.file !== file));
    assert.ok(result.errors.some((error) => error.file?.endsWith('/tab-nav.tsx')));
});

test('finite JSX array alternatives preserve every reused constant path and one real marker per source', () =>
{
    const result = graph('const header=<header/>; const panel=<section/>; return <main>{...state ? [header,panel] : [panel,header]}</main>;');
    assert.deepEqual(result.errors, []);
    const header = result.nodes.find((node) => node.tag === 'header');
    assert.equal(header.renderPaths.length, 2);
    assert.deepEqual(new Set(header.renderPaths.flatMap((path) => path.conditional.map((condition) => condition.name))), new Set(['if','else']));
    assert.equal(result.nodes.filter((node) => node.tag === 'header').length, 1);
});

for (const [label, body] of [
    ['alias mutation', 'const header=<header/>; const alias=header; alias.props=other; return <main>{header}</main>;'],
    ['unknown constant method', 'const header=<header/>; header.change(); return <main>{header}</main>;'],
    ['unknown constant', 'return <div>{unknown}</div>;'],
    ['mutable constant', 'let header=<header/>; return <main>{header}</main>;'],
    ['mutated constant', 'const header=<header/>; header.props=other; return <main>{header}</main>;'],
    ['escaped constant', 'const header=<header/>; other(header); return <main>{header}</main>;'],
    ['cyclic constant', 'const header=header; return <main>{header}</main>;'],
    ['dynamic constant initializer', 'const header=other(); return <main>{header}</main>;'],
    ['different parent reuse', 'const header=<header/>; return <main><div>{header}</div><section>{header}</section></main>;'],
    ['unknown spread source', 'return <main>{...unknown}</main>;'],
    ['unknown spread branch', 'return <main>{...state ? [<header/>] : unknown}</main>;'],
    ['unknown spread element', 'return <main>{...[unknown]}</main>;'],
    ['nested dynamic array spread', 'return <main>{...[...unknown]}</main>;'],
    ['reserved shorthand marker', `const marker='forged'; return h('div',{'data-fsus-composition-node':marker},'content');`]
])
{
    test(`script constant source rejects ${label}`, () =>
    {
        assert.ok(graph(body).errors.length > 0, label);
    });
}
