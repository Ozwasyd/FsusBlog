using System.Buffers;
using System.Buffers.Binary;
using System.Diagnostics.Metrics;
using System.IO.Pipelines;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Binary;

internal interface IBinaryRequestBinder
{
    Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null);

    Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null);

    Task<NameMutationPayload> ReadNameMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken);
}

internal sealed class BinaryRequestBinder : IBinaryRequestBinder
{
    private const string BinaryContentType = "application/octet-stream";
    private const int MaxBinaryRequestFrameBytes = 8 * 1024 * 1024;
    private readonly ArrayPool<byte> _pool;

    public BinaryRequestBinder()
        : this(ArrayPool<byte>.Shared)
    {
    }

    internal BinaryRequestBinder(ArrayPool<byte> pool)
    {
        _pool = pool;
    }

    public Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
        => ReadFrameAsync(httpContext, aeds, [expectedFrameType], cancellationToken, maxFrameBytes);

    public async Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
    {
        int frameLimit = NormalizeFrameLimit(maxFrameBytes);
        if (!IsBinaryContentType(httpContext.Request.ContentType))
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求体必须使用 application/octet-stream"));
        }

        if (httpContext.Request.ContentLength.HasValue && httpContext.Request.ContentLength.Value > frameLimit)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, $"请求帧超过 {FormatBytes(frameLimit)} 上限"));
        }

        ReadResult headerResult = await httpContext.Request.BodyReader.ReadAtLeastAsync(AedsFrameHeader.Size, cancellationToken);
        ReadOnlySequence<byte> headerBuffer = headerResult.Buffer;
        if (headerBuffer.Length < AedsFrameHeader.Size)
        {
            httpContext.Request.BodyReader.AdvanceTo(headerBuffer.End);
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS frame too short"));
        }

        var headerReader = new SequenceReader<byte>(headerBuffer.Slice(0, AedsFrameHeader.Size));
        if (!TryReadHeader(
                ref headerReader,
                out uint magic,
                out byte version,
                out byte headerLength,
                out ushort flags,
                out ushort frameTypeRaw,
                out uint payloadLength,
                out ushort expectedPayloadCrc))
        {
            httpContext.Request.BodyReader.AdvanceTo(headerBuffer.End);
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS header length mismatch"));
        }

        SequencePosition headerConsumed = headerBuffer.GetPosition(AedsFrameHeader.Size);
        httpContext.Request.BodyReader.AdvanceTo(headerConsumed, headerConsumed);

        if (magic != AedsEncoder.Magic)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS magic mismatch"));
        }

        if (version != AedsFrameHeader.CurrentVersion)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS version unsupported"));
        }

        if (headerLength != AedsFrameHeader.Size)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS header length mismatch"));
        }

        if (flags != 0)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS request flags unsupported"));
        }

        AedsFrameType actualFrameType = (AedsFrameType)frameTypeRaw;
        if (!IsExpectedFrameType(actualFrameType, expectedFrameTypes))
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "请求帧类型不匹配"));
        }

        if (payloadLength > frameLimit - AedsFrameHeader.Size)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, $"请求帧超过 {FormatBytes(frameLimit)} 上限"));
        }

        long expectedFrameLength = AedsFrameHeader.Size + (long)payloadLength;
        if (httpContext.Request.ContentLength.HasValue && httpContext.Request.ContentLength.Value != expectedFrameLength)
        {
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS payload length mismatch"));
        }

        if (payloadLength == 0)
        {
            return expectedPayloadCrc == AedsCrc16.Compute(ReadOnlySpan<byte>.Empty)
                ? BinaryRequestPayload.Success(ReadOnlyMemory<byte>.Empty, actualFrameType)
                : BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS payload crc mismatch"));
        }

        var lease = new BinaryRequestBufferLease(_pool, (int)payloadLength);
        bool ownershipTransferred = false;
        try
        {
            ErrorDetail payloadError = await ReadPayloadAndValidateAsync(
                httpContext,
                lease.Buffer,
                (int)payloadLength,
                expectedPayloadCrc,
                cancellationToken);
            if (payloadError.Code != ErrorCode.None)
            {
                return BinaryRequestPayload.Failure(payloadError);
            }

            BinaryRequestBufferLeaseScope.Register(httpContext, lease);
            ownershipTransferred = true;
            return BinaryRequestPayload.Success(lease, actualFrameType);
        }
        finally
        {
            if (!ownershipTransferred)
            {
                lease.Dispose("binder");
            }
        }
    }

    private static async Task<ErrorDetail> ReadPayloadAndValidateAsync(
        HttpContext httpContext,
        byte[] payloadBuffer,
        int payloadLength,
        ushort expectedPayloadCrc,
        CancellationToken cancellationToken)
    {
        bool read = await ReadExactAsync(httpContext.Request.BodyReader, payloadBuffer.AsMemory(0, payloadLength), cancellationToken);
        if (!read)
        {
            return ErrorDetail.Create(ErrorCode.Validation, "AEDS payload length mismatch");
        }

        ushort actualCrc = AedsCrc16.Compute(payloadBuffer.AsSpan(0, payloadLength));
        if (actualCrc == expectedPayloadCrc)
        {
            return ErrorDetail.None;
        }

        return ErrorDetail.Create(ErrorCode.Validation, "AEDS payload crc mismatch");
    }

    private static async Task<bool> ReadExactAsync(
        PipeReader reader,
        Memory<byte> destination,
        CancellationToken cancellationToken)
    {
        int copied = 0;
        while (copied < destination.Length)
        {
            ReadResult result = await reader.ReadAsync(cancellationToken);
            ReadOnlySequence<byte> buffer = result.Buffer;
            long remaining = destination.Length - copied;
            long copyLength = Math.Min(buffer.Length, remaining);
            if (copyLength > 0)
            {
                buffer.Slice(0, copyLength).CopyTo(destination.Span[copied..]);
                copied += (int)copyLength;
                SequencePosition consumed = buffer.GetPosition(copyLength);
                reader.AdvanceTo(consumed, consumed);
            }
            else
            {
                reader.AdvanceTo(buffer.Start, buffer.End);
            }

            if (result.IsCompleted && copied < destination.Length)
            {
                return false;
            }
        }

        return true;
    }

    internal static async Task<bool> HasReachedEndOfBodyAsync(
        PipeReader reader,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadResult result = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (result.IsCanceled)
                {
                    throw new OperationCanceledException(cancellationToken);
                }
                if (!result.Buffer.IsEmpty)
                {
                    return false;
                }
                if (result.IsCompleted)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return true;
                }
            }
            finally
            {
                // Leave unexpected bytes to the request owner; do not drain an unbounded body.
                reader.AdvanceTo(result.Buffer.Start, result.Buffer.End);
            }
        }
    }

    private static bool TryReadHeader(
        ref SequenceReader<byte> reader,
        out uint magic,
        out byte version,
        out byte headerLength,
        out ushort flags,
        out ushort frameTypeRaw,
        out uint payloadLength,
        out ushort expectedPayloadCrc)
    {
        magic = 0;
        version = 0;
        headerLength = 0;
        flags = 0;
        frameTypeRaw = 0;
        payloadLength = 0;
        expectedPayloadCrc = 0;

        if (!reader.TryReadLittleEndian(out int magicRaw)
            || !reader.TryRead(out version)
            || !reader.TryRead(out headerLength)
            || !reader.TryReadLittleEndian(out short flagsRaw)
            || !reader.TryReadLittleEndian(out short frameTypeRawSigned)
            || !reader.TryReadLittleEndian(out int payloadLengthRaw)
            || !reader.TryReadLittleEndian(out short payloadCrcRaw))
        {
            return false;
        }

        magic = unchecked((uint)magicRaw);
        flags = unchecked((ushort)flagsRaw);
        frameTypeRaw = unchecked((ushort)frameTypeRawSigned);
        payloadLength = unchecked((uint)payloadLengthRaw);
        expectedPayloadCrc = unchecked((ushort)payloadCrcRaw);
        return true;
    }

    public async Task<NameMutationPayload> ReadNameMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
    {
        using BinaryRequestPayload payload = await ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken);
        if (!payload.IsSuccess)
        {
            return NameMutationPayload.Failure(payload.Error);
        }

        if (!PodBinaryCodec.TryDecodeNameMutationRequest(payload.Payload, out string name))
        {
            return NameMutationPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "名称请求体非法"));
        }

        return NameMutationPayload.Success(name);
    }

    private static bool IsBinaryContentType(string? contentType)
        => contentType?.StartsWith(BinaryContentType, StringComparison.OrdinalIgnoreCase) == true;

    private static bool IsExpectedFrameType(AedsFrameType actualFrameType, IReadOnlyCollection<AedsFrameType> expectedFrameTypes)
    {
        foreach (AedsFrameType expectedFrameType in expectedFrameTypes)
        {
            if (actualFrameType == expectedFrameType)
            {
                return true;
            }
        }

        return false;
    }

    private static int NormalizeFrameLimit(int? maxFrameBytes)
    {
        if (maxFrameBytes is null or <= 0)
        {
            return MaxBinaryRequestFrameBytes;
        }

        return Math.Min(Math.Max(maxFrameBytes.Value, AedsFrameHeader.Size), MaxBinaryRequestFrameBytes);
    }

    private static string FormatBytes(int bytes)
        => bytes == MaxBinaryRequestFrameBytes
            ? "8 MiB"
            : $"{bytes} bytes";
}

internal readonly record struct BinaryRequestPayload : IDisposable
{
    private readonly ReadOnlyMemory<byte> _payload;
    private readonly BinaryRequestBufferLease? _lease;

    private BinaryRequestPayload(
        bool isSuccess,
        ReadOnlyMemory<byte> payload,
        ErrorDetail error,
        AedsFrameType frameType,
        BinaryRequestBufferLease? lease = null)
    {
        IsSuccess = isSuccess;
        _payload = payload;
        Error = error;
        FrameType = frameType;
        _lease = lease;
    }

    public bool IsSuccess
    {
        get;
    }
    public ReadOnlyMemory<byte> Payload => _lease?.Memory ?? _payload;
    public ErrorDetail Error
    {
        get;
    }
    public AedsFrameType FrameType
    {
        get;
    }

    public static BinaryRequestPayload Success(ReadOnlyMemory<byte> payload, AedsFrameType frameType = AedsFrameType.Unknown)
        => new(true, payload, ErrorDetail.None, frameType);

    internal static BinaryRequestPayload Success(BinaryRequestBufferLease lease, AedsFrameType frameType)
        => new(true, ReadOnlyMemory<byte>.Empty, ErrorDetail.None, frameType, lease);

    public static BinaryRequestPayload Failure(ErrorDetail error)
        => new(false, ReadOnlyMemory<byte>.Empty, error, AedsFrameType.Unknown);

    public void Dispose()
        => _lease?.Dispose("consumer");
}

internal sealed class BinaryRequestBufferLease
{
    private readonly ArrayPool<byte> _pool;
    private readonly int _length;
    private byte[]? _buffer;

    public BinaryRequestBufferLease(ArrayPool<byte> pool, int length)
    {
        _pool = pool;
        _length = length;
        _buffer = pool.Rent(length);
        BinaryRequestBufferMetrics.Rented(_buffer.Length);
    }

    public byte[] Buffer
        => Volatile.Read(ref _buffer)
            ?? throw new ObjectDisposedException(nameof(BinaryRequestBufferLease));

    public ReadOnlyMemory<byte> Memory
        => Buffer.AsMemory(0, _length);

    public void Dispose(string reason)
    {
        byte[]? buffer = Interlocked.Exchange(ref _buffer, null);
        if (buffer is null)
        {
            return;
        }

        _pool.Return(buffer, clearArray: true);
        BinaryRequestBufferMetrics.Returned(buffer.Length, reason);
    }
}

internal sealed class BinaryRequestBufferLeaseScope : IDisposable
{
    private static readonly object s_itemsKey = new();
    private readonly object _sync = new();
    private List<BinaryRequestBufferLease>? _leases = [];

    public static void Register(HttpContext context, BinaryRequestBufferLease lease)
    {
        if (!context.Items.TryGetValue(s_itemsKey, out object? value))
        {
            var scope = new BinaryRequestBufferLeaseScope();
            context.Items[s_itemsKey] = scope;
            context.Response.OnCompleted(static state =>
            {
                Release((HttpContext)state, "response-completed");
                return Task.CompletedTask;
            }, context);
            value = scope;
        }

        if (value is not BinaryRequestBufferLeaseScope registeredScope)
        {
            lease.Dispose("invalid-scope");
            throw new InvalidOperationException("Binary request buffer scope registration is invalid.");
        }

        registeredScope.Add(lease);
    }

    public static void Release(HttpContext context, string reason)
    {
        if (context.Items.TryGetValue(s_itemsKey, out object? value)
            && value is BinaryRequestBufferLeaseScope scope)
        {
            scope.Dispose(reason);
        }
    }

    private void Add(BinaryRequestBufferLease lease)
    {
        lock (_sync)
        {
            if (_leases is null)
            {
                lease.Dispose("late-register");
                throw new ObjectDisposedException(nameof(BinaryRequestBufferLeaseScope));
            }

            _leases.Add(lease);
        }
    }

    public void Dispose()
        => Dispose("scope");

    private void Dispose(string reason)
    {
        List<BinaryRequestBufferLease>? leases;
        lock (_sync)
        {
            leases = _leases;
            _leases = null;
        }

        if (leases is null)
        {
            return;
        }

        foreach (BinaryRequestBufferLease lease in leases)
        {
            lease.Dispose(reason);
        }
    }
}

internal static class BinaryRequestBufferMetrics
{
    private static readonly Meter s_meter = new(FsusObservability.MeterName, FsusObservability.ServiceVersion);
    private static readonly Counter<long> s_rentCounter = s_meter.CreateCounter<long>("fsus.binary_request.pool.rent_count");
    private static readonly Counter<long> s_returnCounter = s_meter.CreateCounter<long>("fsus.binary_request.pool.return_count");
    private static readonly Counter<long> s_rentedBytesCounter = s_meter.CreateCounter<long>("fsus.binary_request.pool.rented_bytes", "By");
    private static readonly Counter<long> s_returnedBytesCounter = s_meter.CreateCounter<long>("fsus.binary_request.pool.returned_bytes", "By");
    private static long s_outstanding;

    static BinaryRequestBufferMetrics()
    {
        s_meter.CreateObservableGauge(
            "fsus.binary_request.pool.outstanding",
            static () => Volatile.Read(ref s_outstanding));
    }

    public static void Rented(int bytes)
    {
        Interlocked.Increment(ref s_outstanding);
        s_rentCounter.Add(1);
        s_rentedBytesCounter.Add(bytes);
    }

    public static void Returned(int bytes, string reason)
    {
        Interlocked.Decrement(ref s_outstanding);
        s_returnCounter.Add(1, new KeyValuePair<string, object?>("reason", reason));
        s_returnedBytesCounter.Add(bytes);
    }
}

internal readonly record struct NameMutationPayload(bool IsSuccess, string Name, ErrorDetail Error)
{
    public static NameMutationPayload Success(string name)
        => new(true, name, ErrorDetail.None);

    public static NameMutationPayload Failure(ErrorDetail error)
        => new(false, string.Empty, error);
}
