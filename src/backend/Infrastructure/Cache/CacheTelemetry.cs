using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Cache;

public enum CacheL1Operation : byte
{
    Typed = 0,
    Raw = 1,
    Readonly = 2,
    OwnedFrame = 3
}

public readonly record struct CacheL1HitObservation(bool Sampled, long StartedAt);

internal static class CacheL1SamplingGate
{
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool ShouldSample(ref long sequence, int sampleRate)
    {
        if (sampleRate <= 0 || (sampleRate & (sampleRate - 1)) != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleRate), "cache_l1_sample_rate_must_be_power_of_two");
        }

        return (Interlocked.Increment(ref sequence) & (sampleRate - 1)) == 0;
    }
}

public interface ICacheTelemetry
{
    void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed);

    CacheL1HitObservation BeginL1Hit(CachePolicyId policyId, CacheL1Operation operation);

    void RecordL1Hit(CachePolicyId policyId, CacheL1Operation operation, bool negative, CacheL1HitObservation observation);
}

public sealed class CacheTelemetry : ICacheTelemetry
{
    public void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed)
        => FsusObservability.RecordCacheOperation(operation, policy, layer, outcome, elapsed);

    public CacheL1HitObservation BeginL1Hit(CachePolicyId policyId, CacheL1Operation operation)
        => FsusObservability.BeginCacheL1Hit(policyId, operation);

    public void RecordL1Hit(CachePolicyId policyId, CacheL1Operation operation, bool negative, CacheL1HitObservation observation)
        => FsusObservability.RecordCacheL1Hit(policyId, operation, negative, observation);
}
