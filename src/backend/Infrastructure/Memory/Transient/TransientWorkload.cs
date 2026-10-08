namespace FsusBlog.Server.Infrastructure.Memory.Transient;

/// <summary>Finite workload labels for transient owners; quotas and priority remain policy-owned.</summary>
public enum TransientWorkload
{
    RequestScratch,
    Encoding,
    Compression,
    DatabaseMaterialization,
    SocketSend,
    WebSocketFanout,
    BackgroundBuild,
    Recovery
}

/// <summary>Explicit finite pool limits supplied by the existing memory policy owner.</summary>
public sealed record TransientBufferPoolLimits(
    int MaximumBufferBytes,
    int MaximumHolds,
    int MaximumRetainedBuffers,
    long MaximumRetainedBytes);

/// <summary>Payload capacities only; CLR headers, metadata and OS reclamation are separate observations.</summary>
public sealed record TransientBufferPoolSnapshot(
    TransientWorkload Workload,
    int Holds,
    long LeasedBytes,
    int RetainedBuffers,
    long RetainedBytes,
    bool Closing);
