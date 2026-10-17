import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '../..');
const checker = fs.readFileSync(path.join(root, 'tools/check-test-matrix.mjs'), 'utf8');
// Execute the real bounded fixture helper without invoking the matrix checker's top-level CLI.
const functions = ['escapeRegExp', 'locateWorkflowJob', 'mutateWorkflowJob', 'appendWorkflowNeed'];
const extracted = functions.map((name) =>
{
    const start = checker.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const next = checker.indexOf('\nfunction ', start + 1);
    assert.ok(next > start, `missing end of ${name}`);
    return checker.slice(start, next);
}).join('\n');
const append = vm.runInNewContext(`${extracted}\nappendWorkflowNeed`, {});
const { parseWorkflowJobNeeds } = await import(pathToFileURL(path.join(root, 'tools/yaml/workflow-structure.mjs')).href);
const fixture = (needs) => `name: Fixture\njobs:\n    prepare:\n        runs-on: ubuntu-latest\n    target:\n        needs:${needs}\n        runs-on: ubuntu-latest\n    untouched:\n        needs: [prepare]\n        runs-on: ubuntu-latest\n`;
const expected = (text) => [...parseWorkflowJobNeeds(text).get('target')];
function assertPreserved(source, output)
{
    assert.equal(output.slice(output.indexOf('    untouched:')), source.slice(source.indexOf('    untouched:')));
    assert.equal(output.slice(0, output.indexOf('    target:')), source.slice(0, source.indexOf('    target:')));
}
test('actual production-summary flow retains every existing prerequisite and other jobs', () =>
{
    const source = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    const before = parseWorkflowJobNeeds(source);
    const original = [...before.get('production-summary')];
    assert.equal(original.length, 24);
    const output = append(source, 'production-summary', 'browser-contract');
    const after = parseWorkflowJobNeeds(output);
    assert.deepEqual([...after.get('production-summary')], [...original, 'browser-contract']);
    for (const [job, needs] of before)
    {
        if (job !== 'production-summary')
        {
            assert.deepEqual([...after.get(job)], [...needs], job);
        }
    }
    const sourceLines = source.split('\n');
    const outputLines = output.split('\n');
    const targetStart = sourceLines.indexOf('    production-summary:');
    const needsIndex = sourceLines.findIndex((line, index) => index > targetStart && line.trimStart().startsWith('needs:'));
    assert.ok(needsIndex > targetStart);
    assert.equal(outputLines.length, sourceLines.length);
    for (let index = 0; index < sourceLines.length; index += 1)
    {
        if (index !== needsIndex)
        {
            assert.equal(outputLines[index], sourceLines[index], `unchanged workflow line ${index + 1}`);
        }
    }
});
test('block needs retains original handling and unrelated job bytes', () =>
{
    const source = fixture('\n            - prepare\n            - compile');
    const output = append(source, 'target', 'browser-contract');
    assert.deepEqual(expected(output), ['browser-contract', 'prepare', 'compile']);
    assertPreserved(source, output);
});
test('empty inline needs admits the unique mutation', () =>
{
    const source = fixture(' []');
    const output = append(source, 'target', 'browser-contract');
    assert.deepEqual(expected(output), ['browser-contract']);
    assertPreserved(source, output);
});
test('trailing-comma inline needs retains all existing edges', () =>
{
    const source = fixture(' [prepare, compile, ]');
    const output = append(source, 'target', 'browser-contract');
    assert.deepEqual(expected(output), ['prepare', 'compile', 'browser-contract']);
    assertPreserved(source, output);
});
test('unsupported scalar needs still rejects without transforming input', () =>
{
    const source = fixture(' prepare');
    assert.throws(() => append(source, 'target', 'browser-contract'), /does not use block needs/u);
    assert.equal(source, fixture(' prepare'));
});
