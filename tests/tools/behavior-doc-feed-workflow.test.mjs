import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

test('BehaviorDoc workflow binds the acquisition, offline producer and consumer to one run', () =>
{
    const workflow = fs.readFileSync('.github/workflows/quality-gate.yml', 'utf8');
    const job = workflow.split('    behavior-doc-static-admission:')[1].split('\n    behavior-test-evidence:')[0];
    assert.match(job, /FSUSBLOG_BEHAVIOR_DOC_NUGET_PREPARATION:.*github\.run_id.*github\.run_attempt/u);
    assert.match(job, /acquire-behavior-doc-feed\.mjs[\s\S]*prepare-behavior-doc-nuget\.mjs --run-id "\$FSUSBLOG_TEST_RUN_ID" --out "\$FSUSBLOG_BEHAVIOR_DOC_NUGET_PREPARATION"[\s\S]*ci-tier behavior-doc-static-admission --no-deps/u);
});

test('feed acquisition refuses a missing or unsafe run identity', () =>
{
    for (const runId of ['', '../escape'])
    {
        const result = spawnSync(process.execPath, ['tools/docs/acquire-behavior-doc-feed.mjs'], {
            encoding: 'utf8', env: { ...process.env, FSUSBLOG_TEST_RUN_ID: runId }
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Explicit run identity required/u);
    }
});
