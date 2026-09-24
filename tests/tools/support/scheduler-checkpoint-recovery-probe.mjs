import process from 'node:process';

import { recordCheckpointFailure } from '../../../tools/test-matrix/scheduler.mjs';

if (process.argv.length !== 4)
{
    throw new Error('scheduler checkpoint recovery probe requires an exact checkpoint path and run ID');
}

const checkpoint = recordCheckpointFailure(process.argv[2], process.argv[3],
    { tierId: 'worker', exitCode: 1, reason: 'fixture recovery inspection' });
process.stdout.write(JSON.stringify(checkpoint));
