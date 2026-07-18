using BenchmarkDotNet.Attributes;

using FsusBlog.Server.Infrastructure.Security;

[MemoryDiagnoser]
public class RateLimiterRejectionSamplerBenchmarks
{
    private const long WindowMinute = 5_000;
    private BoundedRateLimiterRejectionRiskSampler _sampler = null!;
    private string[] _untrackedSubjects = null!;
    private int _nextSubject;

    [Params(64, 4096)]
    public int TrackedBucketCount
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        _sampler = new BoundedRateLimiterRejectionRiskSampler(4, TrackedBucketCount);
        for (int index = 0; index < TrackedBucketCount; index++)
        {
            RateLimiterRiskSampleDecision decision = _sampler.Sample(
                WindowMinute,
                $"tracked-client-{index}",
                "tracked-route");
            if (decision != RateLimiterRiskSampleDecision.WriteRiskSignal)
            {
                throw new InvalidOperationException($"Unable to saturate sampler: {decision}.");
            }
        }

        _untrackedSubjects = Enumerable.Range(0, 1024)
            .Select(static index => $"untracked-client-{index}")
            .ToArray();
    }

    [Benchmark]
    public int DropNewLogicalBucketAtCapacity()
    {
        int index = _nextSubject;
        _nextSubject = (index + 1) % _untrackedSubjects.Length;
        return (int)_sampler.Sample(WindowMinute, _untrackedSubjects[index], "untracked-route");
    }
}
