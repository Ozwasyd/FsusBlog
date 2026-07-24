import crypto from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const evidenceDirectory = String(
    process.env.FSUSBLOG_RUNTIME_SCENARIO_PROCESS_EVIDENCE_DIR ?? ''
).trim();
const startedAt = new Date().toISOString();
const cpuStart = process.cpuUsage();
let connectionSetupCount = 0;

const connectionChannel = diagnosticsChannel.channel('undici:client:connected');
const observeConnection = () =>
{
    connectionSetupCount += 1;
};
connectionChannel.subscribe(observeConnection);

function digest(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

process.once('exit', (exitCode) =>
{
    if (!evidenceDirectory)
    {
        return;
    }
    const cpu = process.cpuUsage(cpuStart);
    const document = {
        schema: 'fsusblog.runtime-scenario-process-observation.v1',
        runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
        source: {
            commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
            worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
        },
        processId: process.pid,
        parentProcessId: process.ppid,
        executableDigest: digest(process.execPath),
        argvDigest: digest(JSON.stringify(process.argv.slice(1))),
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        cpuSeconds: (cpu.user + cpu.system) / 1e6,
        connectionSetupCount
    };
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const target = path.join(evidenceDirectory, `${process.pid}.json`);
    const temporary = `${target}.next`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, target);
});
