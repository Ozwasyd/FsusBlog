using System.Threading;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Testing;

using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Infrastructure.Cache;

internal sealed class CacheCoordinationObservation(CachePolicyId policy, ICacheSingleFlightCoordinator coordinator) : IDisposable
{
    private static readonly AsyncLocal<CacheCoordinationObservation?> s_current = new();
    private readonly CacheCoordinationObservation? _parent = s_current.Value;

    internal static CacheCoordinationObservation? Current => s_current.Value;
    internal ProfilingSession RedisProfile { get; } = new();
    internal TimeSpan LocalWait
    {
        get; set;
    }
    internal TimeSpan LeaseWait
    {
        get; set;
    }
    internal int RebuildCount
    {
        get; set;
    }
    internal int LastGoodWhileRebuild
    {
        get; set;
    }
    internal string ReleaseOutcome { get; set; } = "not-owned";

    internal static CacheCoordinationObservation Begin(CachePolicyId policy, ICacheSingleFlightCoordinator coordinator)
    {
        var observation = new CacheCoordinationObservation(policy, coordinator);
        s_current.Value = observation;
        return observation;
    }

    public void Dispose()
    {
        s_current.Value = _parent;
        string[] redisCommands = RedisProfile.FinishProfiling()
            .Select(static command => command.Command.ToString().ToUpperInvariant())
            .ToArray();
        RuntimeCacheEvidenceObservation.Current?.RecordRedisCommands(redisCommands);
        FsusObservability.RecordCacheCoordination(
            CachePolicyTelemetry.Name(policy), redisCommands.LongLength,
            LocalWait, LeaseWait, RebuildCount, ReleaseOutcome,
            coordinator is CacheSingleFlightCoordinator concrete ? concrete.ActiveEntryCount : null);
    }
}
