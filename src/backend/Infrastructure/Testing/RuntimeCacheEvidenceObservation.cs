using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Infrastructure.Testing;

internal sealed partial class RuntimeCacheEvidenceObservation : IDisposable
{
    private static readonly AsyncLocal<RuntimeCacheEvidenceObservation?> s_current = new();
    private readonly RuntimeCacheEvidenceObservation? _parent = s_current.Value;
    private readonly ConcurrentQueue<string> _databaseFingerprints = new();
    private readonly ConcurrentQueue<string> _redisCommands = new();
    private readonly long _startedAt = Stopwatch.GetTimestamp();
    private readonly long _allocatedBytesAtStart = GC.GetAllocatedBytesForCurrentThread();
    private string _layerSource = "database";
    private bool _disposed;

    private RuntimeCacheEvidenceObservation(string requestId, string method, string path)
    {
        RequestId = requestId;
        Method = method;
        Path = path;
    }

    internal static RuntimeCacheEvidenceObservation? Current => s_current.Value;
    internal string RequestId
    {
        get;
    }
    internal string Method
    {
        get;
    }
    internal string Path
    {
        get;
    }
    internal ProfilingSession RedisProfile { get; } = new();

    internal static RuntimeCacheEvidenceObservation Begin(string requestId, string method, string path)
    {
        var observation = new RuntimeCacheEvidenceObservation(requestId, method, path);
        s_current.Value = observation;
        return observation;
    }

    internal void RecordDatabaseCommand(string sql)
        => _databaseFingerprints.Enqueue(FingerprintSql(sql));

    internal void RecordRedisCommands(IEnumerable<string> commands)
    {
        foreach (string command in commands)
        {
            _redisCommands.Enqueue(command);
        }
    }

    internal void MarkLayerSource(string layerSource)
    {
        if (!string.IsNullOrWhiteSpace(layerSource))
        {
            _layerSource = layerSource;
        }
    }

    internal RuntimeCacheRequestObservation Complete(int statusCode, string payloadDigest)
    {
        RecordRedisCommands(RedisProfile.FinishProfiling()
            .Select(static command => command.Command.ToString().ToUpperInvariant())
            .ToArray());
        long allocatedBytes = Math.Max(0, GC.GetAllocatedBytesForCurrentThread() - _allocatedBytesAtStart);
        return new RuntimeCacheRequestObservation(
            RequestId,
            Method,
            Path,
            statusCode,
            payloadDigest,
            _layerSource,
            Stopwatch.GetElapsedTime(_startedAt).TotalMilliseconds,
            allocatedBytes,
            _redisCommands.ToArray(),
            _databaseFingerprints.ToArray());
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        s_current.Value = _parent;
    }

    internal static string FingerprintSql(string sql)
    {
        string normalized = OperatorSpacing().Replace(Whitespace().Replace(
            StringLiteral().Replace(NumericLiteral().Replace(sql, "?"), "?"),
            " "), "$1").Trim().ToLowerInvariant();
        return $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))}";
    }

    [GeneratedRegex(@"\b\d+(?:\.\d+)?\b", RegexOptions.CultureInvariant)]
    private static partial Regex NumericLiteral();

    [GeneratedRegex(@"'(?:''|[^'])*'", RegexOptions.CultureInvariant)]
    private static partial Regex StringLiteral();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"\s*([=<>(),])\s*", RegexOptions.CultureInvariant)]
    private static partial Regex OperatorSpacing();
}

internal sealed record RuntimeCacheRequestObservation(
    string RequestId,
    string Method,
    string Path,
    int Status,
    string PayloadDigest,
    string LayerSource,
    double LatencyMs,
    long AllocatedBytes,
    IReadOnlyList<string> RedisCommands,
    IReadOnlyList<string> DatabaseFingerprints);

internal sealed class RuntimeCacheEvidenceStore
{
    private const int Capacity = 4096;
    private readonly ConcurrentDictionary<string, RuntimeCacheRequestObservation> _observations = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _order = new();

    internal void Store(RuntimeCacheRequestObservation observation)
    {
        _observations[observation.RequestId] = observation;
        _order.Enqueue(observation.RequestId);
        while (_observations.Count > Capacity && _order.TryDequeue(out string? oldest))
        {
            _observations.TryRemove(oldest, out _);
        }
    }

    internal bool TryTake(string requestId, out RuntimeCacheRequestObservation? observation)
        => _observations.TryRemove(requestId, out observation);
}
