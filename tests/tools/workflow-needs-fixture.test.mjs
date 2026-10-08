import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const { parseWorkflow } = await import(pathToFileURL(path.join(root, 'tools/check-workflow-matrix-sync.mjs')));
const fixtureSource = fs.readFileSync(path.join(root, 'tools/check-test-matrix.mjs'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'tools/check-workflow-matrix-sync.mjs'), 'utf8');
const fixtureHelpers = fixtureSource.slice(fixtureSource.indexOf('function escapeRegExp('), fixtureSource.indexOf('function locateTier('))
    + fixtureSource.slice(fixtureSource.indexOf('function locateWorkflowJob('), fixtureSource.indexOf('function writeTempMatrix('));
const browserTopology = syncSource.slice(syncSource.indexOf('function validateBrowserWorkflowTopology('), syncSource.indexOf('export function validateBehaviorDocStaticAdmissionTopology('));
const { appendWorkflowNeed, mutateWorkflowJob, validateBrowserWorkflowTopology } = vm.runInNewContext(
    `${fixtureHelpers}\n${browserTopology}\n({ appendWorkflowNeed, mutateWorkflowJob, validateBrowserWorkflowTopology })`
);
const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
const originalNeeds = [...parseWorkflow(workflow).get('production-summary').needs];
const originalDiagnostic = 'production-summary must remain browserless and must not wait for browser-contract';

function withNeedsFormat(format)
{
    return mutateWorkflowJob(workflow, 'production-summary', (source, job) =>
    {
        const indent = ' '.repeat(job.fieldIndent);
        const childIndent = ' '.repeat(job.fieldIndent + job.fieldIndent - job.jobIndent);
        const itemIndent = `${childIndent}${' '.repeat(job.fieldIndent - job.jobIndent)}`;
        const needs = new RegExp(`^${indent}needs:[^\\n]*$`, 'mu');
        if (format === 'block')
        {
            return source.replace(needs, `${indent}needs:\n${originalNeeds.map((need) => `${childIndent}- ${need}`).join('\n')}`);
        }
        return source.replace(needs, `${indent}needs:\n${childIndent}[\n${originalNeeds.map((need) => `${itemIndent}${need},`).join('\n')}\n${childIndent}]`);
    });
}

function assertOriginalConsumerRefusal(source)
{
    const before = parseWorkflow(source);
    assert.deepEqual([...before.get('production-summary').needs], originalNeeds);
    const beforeErrors = [];
    validateBrowserWorkflowTopology(before, beforeErrors);
    assert.equal(beforeErrors.includes(originalDiagnostic), false);

    const updated = appendWorkflowNeed(source, 'production-summary', 'browser-contract');
    const after = parseWorkflow(updated);
    const errors = [];
    validateBrowserWorkflowTopology(after, errors);
    assert.deepEqual(errors, [...beforeErrors, originalDiagnostic]);
    assert.deepEqual([...after.get('production-summary').needs], ['browser-contract', ...originalNeeds]);
    for (const [jobId, job] of before)
    {
        if (jobId !== 'production-summary')
        {
            assert.deepEqual([...after.get(jobId).needs], [...job.needs], jobId);
            assert.deepEqual(after.get(jobId).lines, job.lines, jobId);
        }
    }
    return updated;
}

test('workflow refusal fixture retains block needs and the original browserless refusal', () =>
{
    assertOriginalConsumerRefusal(withNeedsFormat('block'));
});

test('workflow refusal fixture retains inline flow needs and the original browserless refusal', () =>
{
    assertOriginalConsumerRefusal(workflow);
});

test('workflow refusal fixture retains next-line multiline flow needs and the original browserless refusal', () =>
{
    const updated = assertOriginalConsumerRefusal(withNeedsFormat('next-line-flow'));
    assert.match(updated, /\n {12}\[\n {16}browser-contract,\n/u);
});
