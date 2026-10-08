import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const scenario = process.argv[2];
const testId = process.argv[3];

if (scenario === 'marker-wait')
{
    fs.writeFileSync(process.argv[4], 'started');
    setTimeout(() =>
    {}, 3500);
}
else if (scenario === 'timeout')
{
    setInterval(() =>
    {}, 1000);
}
else if (scenario === 'signal')
{
    process.kill(process.pid, 'SIGTERM');
}
else if (scenario === 'no-sidecar')
{
    process.exitCode = 0;
}
else
{
    const failed = scenario === 'product-failure';
    fs.writeFileSync(path.join(process.env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT, 'payload.json'), JSON.stringify({
        scenario,
        attemptNumber: Number(process.env.FSUSBLOG_ATTEMPT_NUMBER)
    }));
    fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH, JSON.stringify({
        schema: 'fsusblog.test-attempt-result.v1',
        failureClass: failed ? 'product' : null,
        failureKind: failed ? 'assertion-mismatch' : null,
        executedTestIds: [testId],
        failedTestIds: failed ? [testId] : [],
        artifactPaths: ['payload.json']
    }));
    process.exitCode = failed ? 1 : 0;
}
