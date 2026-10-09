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
const directory = resolve(repositoryRoot, '.tmp', `canonical-context-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
test.after(() => rmSync(directory, { recursive: true, force: true }));
const source = () => createCompositionSource({ repositoryRoot, fsusUIRoot });
function fixture(content)
{
    const file = resolve(directory, `${randomUUID()}.ts`);
    writeFileSync(file, content);
    return file;
}

test('canonical context exposes the actual OnlyChild function AST and source byte step', () =>
{
    const s = source();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slot/src/only-child.tsx');
    const record = s.resolver.parse(file);
    const binding = s.resolver.resolveSourceFunction(file, s.expression('findFirstLegitChild', file));
    const step = s.resolver.sourceStep(binding.file, binding.fn);
    assert.equal(binding.file, file);
    assert.equal(binding.name, 'findFirstLegitChild');
    assert.equal(binding.fn.getSourceFile(), record.scripts[0].ast);
    assert.deepEqual(step, { file, offset: binding.fn.getStart(), kind: 'script-source', digest: controlDigest(binding.fn.getText()) });
    const closed = s.resolver.sourceBindings();
    assert.deepEqual(closed.errors, []);
    assert.ok(closed.files.some((entry) => entry.path === file && entry.digest === controlDigest(record.content)));
});

test('canonical function context follows actual imported useMarks and records its SFC caller offset', () =>
{
    const s = source();
    const file = resolve(fsusUIRoot, 'vue/packages/components/slider/src/slider.vue');
    const result = s.resolver.resolveSourceFunction(file, s.expression('useMarks', file));
    assert.ok(result.file.endsWith('/slider/src/composables/use-marks.ts'));
    assert.equal(result.name, 'useMarks');
    assert.equal(result.fn.parameters.length, 1);
    assert.equal(s.resolver.sourceStep(result.file, result.fn).offset, result.fn.getStart());
    const record = s.resolver.parse(file);
    const caller = record.variables.get('markList');
    const script = record.scripts.find(({ ast }) => ast === caller.getSourceFile());
    assert.equal(s.resolver.sourceStep(file, caller).offset, script.offset + caller.getStart());
    assert.deepEqual(s.resolver.sourceBindings().errors, []);
});

test('canonical source steps reject synthetic and foreign AST nodes without borrowing source identity', () =>
{
    const s = source();
    const file = fixture('const value = 1;');
    const foreign = fixture('const other = 2;');
    assert.throws(() => s.resolver.sourceStep(file, s.expression('value', file)), /unowned source proof node/);
    assert.throws(() => s.resolver.sourceStep(file, s.resolver.parse(foreign).variables.get('other')), /unowned source proof node/);
    assert.throws(() => s.resolver.sourceStep(file, s.resolver.ts.factory.createIdentifier('value')), /unowned source proof node/);
});

test('canonical binding helper retains mutable mutated and shadowed binding rejection', () =>
{
    for (const code of ['let value=1;', 'const value=1;value=2;', 'const value=1;function hidden(value){}'])
    {
        const s = source();
        assert.throws(() => s.resolver.assertImmutableBinding(fixture(code), 'value'), /unbound finite component binding/);
    }
});

test('canonical function helper rejects unknown private and duplicate functions', () =>
{
    for (const code of ['', 'import {helper} from "@element-plus/hooks";', 'function helper(){}function helper(){}'])
    {
        const s = source();
        const file = fixture(code);
        assert.throws(() => s.resolver.resolveSourceFunction(file, s.expression('helper', file)), /unbound finite component binding|unknown component source function/);
    }
});

test('canonical function helper rejects async generators and nonfunction values', () =>
{
    for (const code of ['const helper=async()=>1;', 'function* helper(){yield 1;}', 'const helper=1;'])
    {
        const s = source();
        const file = fixture(code);
        assert.throws(() => s.resolver.resolveSourceFunction(file, s.expression('helper', file)), /unknown component source function body/);
    }
});
