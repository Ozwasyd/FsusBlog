import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyRuntimeRoleCurrentSchemaPair } from '../../tools/contracts/lib/runtime-role-observation.mjs';

// Pure early refusals only. No receipt, compiled command, native service or qualification is manufactured.
function unopenedPair()
{
    const side = {
        assembly: '/unopened/FsusBlog.RuntimeRoleObservation.dll',
        candidateSourceRevision: 'a'.repeat(40),
        connectionString: 'secret-marker-never-forwarded',
        receiptPath: '/unopened/current.receipt',
        receiptSha256: 'b'.repeat(64),
        serviceCatalog: '/unopened/catalog.json',
        serviceEnvelope: '/unopened/envelope.json'
    };
    return { runId: 'pure-input-control', sourceCommit: 'a'.repeat(40), source: { ...side }, target: { ...side } };
}

for (const [name, mutate, diagnostic] of [
    ['unknown-pair-key', value => { value.qualificationEligible = true; }, 'pair key set mismatch'],
    ['missing-run', value => { delete value.runId; }, 'pair key set mismatch'],
    ['empty-run', value => { value.runId = ''; }, 'pair run or target candidate invalid'],
    ['unknown-source-key', value => { value.source.ready = true; }, 'source key set mismatch'],
    ['retired-test-receipt', value => { value.source.receiptRoot = '/unopened'; }, 'source key set mismatch'],
    ['missing-native-input', value => { delete value.target.connectionString; }, 'target key set mismatch'],
    ['non-string-native-input', value => { value.source.connectionString = {}; }, 'source field invalid'],
    ['over-budget-native-input', value => { value.source.connectionString = 'x'.repeat(65_537); }, 'source field invalid'],
    ['relative-candidate', value => { value.source.assembly = 'candidate.dll'; }, 'source explicit canonical file required'],
    ['latest-receipt', value => { value.target.receiptPath = '/unopened/latest/current.receipt'; }, 'target explicit canonical file required'],
    ['source-zero-revision', value => { value.source.candidateSourceRevision = '0'.repeat(40); }, 'source artifact or candidate binding invalid'],
    ['payload-not-file-digest', value => { value.target.receiptSha256 = `sha256:${'b'.repeat(64)}`; }, 'target artifact or candidate binding invalid'],
    ['wrong-target-revision', value => { value.target.candidateSourceRevision = 'c'.repeat(40); }, 'target candidate mismatch']
])
{
    test(`current-only pair refuses ${name} before files, credentials or native command`, () =>
    {
        const input = unopenedPair();
        mutate(input);
        assert.throws(() => verifyRuntimeRoleCurrentSchemaPair(input), error =>
        {
            assert.equal(error.message, `runtime-role current schema: ${diagnostic}`);
            assert.ok(!error.message.includes('secret-marker'));
            assert.ok(!error.message.includes('ENOENT'));
            return true;
        });
    });
}
