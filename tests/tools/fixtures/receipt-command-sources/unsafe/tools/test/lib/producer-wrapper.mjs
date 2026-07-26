import { spawnSync } from 'node:child_process';

export function runProducer()
{
    spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'run', 'canonical-producer']);
}
