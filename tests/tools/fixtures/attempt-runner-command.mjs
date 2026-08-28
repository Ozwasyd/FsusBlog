import fs from 'node:fs';
import process from 'node:process';

const scenario = process.argv[2];
const attempt = Number(process.env.FSUSBLOG_ATTEMPT_NUMBER ?? '0');
const resultPath = process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
const artifactRoot = process.env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT;

function writeResult({ failureClass = null, failureKind = null, failedTestIds = [], artifacts = true } = {})
{
    const artifactPaths = artifacts ? ['payload.json'] : ['missing.json'];
    if (artifacts)
    {
        fs.writeFileSync(`${artifactRoot}/payload.json`, `${JSON.stringify({ attempt, scenario })}\n`);
    }
    fs.writeFileSync(resultPath, `${JSON.stringify({
        schema: 'fsusblog.test-attempt-result.v1',
        failureClass,
        failureKind,
        executedTestIds: ['fixture:attempt-runner'],
        failedTestIds,
        artifactPaths
    })}\n`);
}

if (scenario === 'timeout')
{
    setInterval(() => {}, 1_000);
}
else if (scenario === 'signal')
{
    process.kill(process.pid, 'SIGTERM');
}
else if (scenario === 'browser-crash-once' && attempt === 1)
{
    writeResult({
        failureClass: 'infra',
        failureKind: 'browser-process-crash',
        failedTestIds: ['fixture:attempt-runner']
    });
    process.exitCode = 1;
}
else if (scenario === 'restore-timeout-once' && attempt === 1)
{
    writeResult({
        failureClass: 'infra',
        failureKind: 'dependency-registry-timeout',
        failedTestIds: ['fixture:attempt-runner']
    });
    process.exitCode = 1;
}
else if (scenario === 'product-failure')
{
    writeResult({
        failureClass: 'product',
        failureKind: 'assertion-mismatch',
        failedTestIds: ['fixture:attempt-runner']
    });
    process.exitCode = 1;
}
else if (scenario === 'missing-artifact')
{
    writeResult({ artifacts: false });
}
else
{
    writeResult();
}
