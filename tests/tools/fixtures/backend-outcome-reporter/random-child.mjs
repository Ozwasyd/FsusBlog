import assert from 'node:assert/strict';
import fs from 'node:fs';

const { createDeterministicRandom, createRandomExecutionRecorder } = await import(new URL('../../../../tools/test/random-streams.mjs', import.meta.url));
const plan = JSON.parse(fs.readFileSync(process.env.ORDINARY_PLAN_FILE, 'utf8'));
const canonicalTestId = plan.testEnumerationOrder[0];
const streamId = 'ordinary-js-samples';
const derivedSeed = JSON.parse(process.env.FSUSBLOG_RANDOM_STREAMS_JSON)[`${canonicalTestId}\0${streamId}`];
const random = createDeterministicRandom(derivedSeed);
const recorder = createRandomExecutionRecorder({ canonicalTestId, streamId });
const mode = process.argv[2];
for (let index = 0; index < 3; index += 1)
{
    const sample = { index, generated: random() };
    if (mode === 'legacy')
    {
        assert.ok(Number.isInteger(sample.generated));
        recorder.record(sample);
        continue;
    }
    const originalFailure = new Error('ordinary generated sample failed');
    try
    {
        await recorder.observe(sample, async () =>
        {
            assert.ok(Number.isInteger(sample.generated));
            if (index === 1 && mode === 'failure')
            {
                throw originalFailure;
            }
            if (index === 1 && mode === 'cancel')
            {
                await new Promise(() => setInterval(() => {}, 1000));
            }
        });
    }
    catch (error)
    {
        assert.equal(error, originalFailure, 'the original oracle exception must be rethrown');
        throw error;
    }
}
recorder.complete();
