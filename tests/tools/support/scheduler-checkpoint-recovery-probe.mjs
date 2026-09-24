import process from 'node:process';

const { recordCheckpointFailure } = await import(new URL('../../../tools/test-matrix/scheduler.mjs', import.meta.url));

if (process.argv.length !== 4)
{
    throw new Error('scheduler checkpoint recovery probe requires an exact checkpoint path and run ID');
}

const checkpoint = recordCheckpointFailure(process.argv[2], process.argv[3],
    { tierId: 'worker', exitCode: 1, reason: 'fixture recovery inspection' });
process.stdout.write(JSON.stringify(checkpoint));
