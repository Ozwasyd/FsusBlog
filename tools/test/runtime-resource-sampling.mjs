import { performance } from 'node:perf_hooks';

/** Observe the whole operation, including in-flight drain; retain failed reads. */
export function startResourceSampling(read, intervalMs = 250)
{
    const readings = [];
    const sample = (phase) =>
    {
        const observedMonotonicMs = performance.now();
        try
        {
            readings.push({ phase, observedMonotonicMs, ...read() });
        }
        catch (error)
        {
            readings.push({ phase, observedMonotonicMs, status: 'probe-failed',
                reason: `resource read failed: ${error?.code ?? error?.name ?? 'unknown'}` });
        }
    };
    sample('start');
    const timer = setInterval(() => sample('interval'), intervalMs);
    let stopped = false;
    return {
        readings,
        stop()
        {
            if (!stopped)
            {
                clearInterval(timer);
                sample('end');
                stopped = true;
            }
            return readings;
        }
    };
}
