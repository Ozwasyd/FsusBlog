import fs from 'node:fs';
import process from 'node:process';
import { isMainThread } from 'node:worker_threads';

import {
    EVIDENCE_TERMINAL_HANDOFF_PREFIX
} from './current-run-evidence-publication.mjs';
import {
    beginRegisteredCurrentRunEvidenceProducer,
    finalizeRegisteredCurrentRunEvidenceProducer
} from './run-current-run-evidence-producer.mjs';

const ownerPid = String(process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_HOOK_OWNER_PID ?? '').trim();
const enabled = isMainThread
    && String(process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT ?? '').trim().length > 0
    && (!ownerPid || ownerPid === String(process.pid));
if (enabled)
{
    process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_HOOK_OWNER_PID = String(process.pid);
    const session = beginRegisteredCurrentRunEvidenceProducer();
    let completed = false;
    const finalize = () =>
    {
        if (completed || Number(process.exitCode ?? 0) !== 0) return;
        completed = true;
        try
        {
            const handoff = finalizeRegisteredCurrentRunEvidenceProducer(session);
            fs.writeSync(process.stdout.fd,
                `${EVIDENCE_TERMINAL_HANDOFF_PREFIX}${JSON.stringify(handoff)}\n`);
        }
        catch (error)
        {
            fs.writeSync(process.stderr.fd,
                `[current-run-evidence-producer] ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    };
    process.once('beforeExit', finalize);
    process.once('exit', finalize);
}
