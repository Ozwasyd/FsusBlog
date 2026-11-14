using System.Reflection;
using System.Security.Cryptography;

using SqlSugar.DistributedSystem.Snowflake;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Caller-supplied production authority. The bridge never invents an epoch, assigned node,
/// or inventory digest, and the reserved node must be the unassigned maximum node.
/// </summary>
public sealed record SqlSugarCommentIdAuthority(
    string AlgorithmVersion,
    DateTimeOffset Epoch,
    int NodeBits,
    int SequenceBits,
    int FixtureReservedNodeId,
    IReadOnlyList<int> ProductionAssignedNodeIds,
    string ProductionCoreDigest,
    string ProductionNodeInventoryDigest);

public sealed record SqlSugarCommentIdCoordinate(long TimestampMs, int NodeId, int Sequence);

/// <summary>
/// Runs the installed production SqlSugar NextId implementation with its virtual business
/// clock seam. Decoding consumes that same assembly's literal layout metadata. No global
/// worker, wall clock, database maximum, or copied ID generation formula is used.
/// </summary>
public sealed class SqlSugarCommentIdCore
{
    private static readonly Type s_workerType = typeof(IdWorker);
    private readonly object _gate = new();
    private readonly int _workerBits;
    private readonly int _datacenterBits;
    private readonly int _sequenceBits;
    private readonly int _workerShift;
    private readonly int _datacenterShift;
    private readonly int _timestampShift;
    private readonly int _reservedNode;
    private ClockedWorker? _worker;
    private long _timestamp;
    private int _node;
    private int _sequence = -1;
    private long _id;

    public static string AlgorithmVersion => $"SqlSugar.IdWorker/{s_workerType.Assembly.GetName().Version}";

    public static string ProductionCoreDigest =>
        "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(s_workerType.Assembly.Location)));

    public SqlSugarCommentIdCore(SqlSugarCommentIdAuthority authority)
    {
        ArgumentNullException.ThrowIfNull(authority);
        _workerBits = Literal("WorkerIdBits");
        _datacenterBits = Literal("DatacenterIdBits");
        _sequenceBits = Literal("SequenceBits");
        _workerShift = Literal("WorkerIdShift");
        _datacenterShift = Literal("DatacenterIdShift");
        _timestampShift = IdWorker.TimestampLeftShift;
        int nodeBits = _workerBits + _datacenterBits;
        int maximumNode = (1 << nodeBits) - 1;
        if (authority.AlgorithmVersion != AlgorithmVersion
            || authority.ProductionCoreDigest != ProductionCoreDigest
            || authority.Epoch.Offset != TimeSpan.Zero
            || authority.Epoch.Ticks % TimeSpan.TicksPerMillisecond != 0
            || authority.Epoch.ToUnixTimeMilliseconds() != IdWorker.Twepoch
            || authority.NodeBits != nodeBits || authority.SequenceBits != _sequenceBits
            || _workerShift != _sequenceBits || _datacenterShift != _workerBits + _sequenceBits
            || _timestampShift != nodeBits + _sequenceBits
            || authority.FixtureReservedNodeId != maximumNode)
        {
            throw new InvalidOperationException("Comment Snowflake authority differs from the installed production core.");
        }
        IReadOnlyList<int>? nodes = authority.ProductionAssignedNodeIds;
        if (nodes is null || nodes.Count == 0 || nodes.Distinct().Count() != nodes.Count
            || nodes.Any(node => node < 0 || node >= maximumNode)
            || !IsDigest(authority.ProductionNodeInventoryDigest))
        {
            throw new InvalidOperationException("Comment Snowflake requires explicit nonoverlapping production node authority.");
        }
        _reservedNode = authority.FixtureReservedNodeId;
    }

    /// <summary>Encode an exact planned coordinate through production NextId; supports repeat and out-of-order replay.</summary>
    public long Encode(long timestampMs, int nodeId, int sequence)
    {
        if (timestampMs <= IdWorker.Twepoch
            || timestampMs - IdWorker.Twepoch > long.MaxValue >> _timestampShift
            || nodeId != _reservedNode || sequence < 0 || sequence >= 1 << _sequenceBits)
        {
            throw new ArgumentOutOfRangeException(nameof(timestampMs), "Comment Snowflake coordinate is outside its authority.");
        }
        lock (_gate)
        {
            if (_worker is null || _timestamp != timestampMs || _node != nodeId || sequence < _sequence)
            {
                _worker = new ClockedWorker(nodeId & ((1 << _workerBits) - 1), nodeId >> _workerBits, timestampMs);
                _timestamp = timestampMs;
                _node = nodeId;
                _sequence = -1;
            }
            while (_sequence < sequence)
            {
                _id = _worker.NextId();
                _sequence++;
            }
            SqlSugarCommentIdCoordinate decoded = Decode(_id);
            if (decoded != new SqlSugarCommentIdCoordinate(timestampMs, nodeId, sequence))
            {
                throw new InvalidOperationException("Production NextId does not reproduce the planned coordinate.");
            }
            return _id;
        }
    }

    /// <summary>Decode the installed core's exact node, time and sequence bit layout.</summary>
    public SqlSugarCommentIdCoordinate Decode(long id)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(id);
        long timestamp = (id >> _timestampShift) + IdWorker.Twepoch;
        int worker = (int)((id >> _workerShift) & ((1 << _workerBits) - 1));
        int datacenter = (int)((id >> _datacenterShift) & ((1 << _datacenterBits) - 1));
        return new(timestamp, (datacenter << _workerBits) | worker, (int)(id & ((1 << _sequenceBits) - 1)));
    }

    private static int Literal(string name)
    {
        FieldInfo field = s_workerType.GetField(name, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Production Snowflake layout field {name} is unavailable.");
        return field.IsLiteral && field.GetRawConstantValue() is int value && value is > 0 and < 31
            ? value
            : throw new InvalidOperationException($"Production Snowflake layout field {name} is not a bounded literal.");
    }

    private static bool IsDigest(string value)
        => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private sealed class ClockedWorker(long workerId, long datacenterId, long timestampMs)
        : IdWorker(workerId, datacenterId, 0)
    {
        protected override long TimeGen() => timestampMs;

        protected override long TilNextMillis(long lastTimestamp)
            => throw new InvalidOperationException("Explicit logical sequence cannot wait for a wall-clock rollover.");
    }
}
