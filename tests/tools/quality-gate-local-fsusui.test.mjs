import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('production artifact build uses pinned local FsusUI and the job token', () =>
{
    const workflow = fs.readFileSync('.github/workflows/quality-gate.yml', 'utf8');
    const job = workflow.split('    production-build-artifacts:')[1].split('\n    coverage-merge-threshold:')[0];
    assert.match(workflow, /GITHUB_PACKAGES_TOKEN: \$\{\{ github\.token \}\}/u);
    assert.doesNotMatch(workflow, /secrets\.GITHUB_PACKAGES_TOKEN/u);
    assert.match(job, /FSUSBLOG_USE_LOCAL_FSUSUI: "1"/u);
    assert.match(job, /fsusui-baseline\.mjs --github-output[\s\S]*ref: \$\{\{ steps\.fsusui-baseline\.outputs\.commit \}\}/u);
    assert.match(job, /npm --prefix src\/frontend ci[\s\S]*run build:theme[\s\S]*local-fsusui-identity\.mjs[\s\S]*ci-tier production-build-artifacts/u);
});
