import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireText } from './contract.mjs';
import { requestSecurityScenarioDispatch } from './resident-ipc.mjs';

export async function runSecurityResidentIpcClient(argumentsList = process.argv.slice(2))
{
    const allowed = new Set(['--socket', '--scenario', '--run-id', '--source-commit', '--source-fingerprint', '--output-file']);
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 2)
    {
        const key = argumentsList[index];
        if (!allowed.has(key) || options[key] !== undefined)
        {
            throw new Error('resident client requires explicit unique source/run/socket arguments');
        }
        options[key] = requireText(argumentsList[index + 1], key);
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('resident client process cancelled'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try
    {
        const result = await requestSecurityScenarioDispatch({ socketPath: options['--socket'],
            scenarioId: options['--scenario'], identity: { runId: options['--run-id'],
                commit: options['--source-commit'], worktreeFingerprint: options['--source-fingerprint'] },
            signal: controller.signal });
        if (!result.document)
        {
            throw new Error(result.dispatchError?.message ?? 'original resident result is unavailable');
        }
        const output = path.resolve(requireText(options['--output-file'], 'owned original-result output'));
        fs.writeFileSync(output, result.resultBytes, { flag: 'wx', mode: 0o600 });
        process.exitCode = result.document.result.status === 'pass' ? 0
            : result.document.result.status === 'cancelled' ? 130 : 1;
        console.log(`[security-resident-ipc] scenario=${result.scenarioId} status=${result.document.result.status} evidence=${output}`);
        // Original scan/assertion results are transported without translating
        // declaration metadata into observed test IDs or a successful sidecar.
        return result;
    }
    finally
    {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    runSecurityResidentIpcClient().catch((error) =>
    {
        console.error(`[security-resident-ipc] ${error.message}`);
        process.exitCode = 1;
    });
}
