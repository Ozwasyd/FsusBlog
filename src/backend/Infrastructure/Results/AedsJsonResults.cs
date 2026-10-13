using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Infrastructure.Results;

internal static class AedsJsonResults
{
    public const int MaxAuthoringFrameBytes = 8 * 1024 * 1024;
    public const int MaxSecurityFrameBytes = 1024 * 1024;
    public const int FixedSerializationBufferBytes = 16 * 1024;
    // The fixed discard buffer, bounded depth-64 writer/converter state and
    // per-call objects are reserved before counting. Shared serializer metadata
    // belongs to the existing options owner; no complete payload is retained.
    public const int SerializationMemoryReserveBytes = 64 * 1024;

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public static AedsJsonOutputBudgetResult MeasureOutput<T>(
        T value,
        long maxOutputBytes,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (maxOutputBytes <= 0)
        {
            return new(AedsJsonOutputBudgetStatus.InvalidBudget, 0);
        }

        var output = new DiscardOutputBuffer(maxOutputBytes, cancellationToken);
        try
        {
            using var writer = new Utf8JsonWriter(output, new JsonWriterOptions
            {
                Encoder = new AtomicAdmissionEncoder(s_jsonOptions.Encoder ?? JavaScriptEncoder.Default, cancellationToken),
                Indented = s_jsonOptions.WriteIndented,
                MaxDepth = s_jsonOptions.MaxDepth == 0 ? 64 : s_jsonOptions.MaxDepth
            });
            JsonSerializer.Serialize(writer, value, s_jsonOptions);
            writer.Flush();
            cancellationToken.ThrowIfCancellationRequested();
            return new(AedsJsonOutputBudgetStatus.Accepted, output.ByteCount);
        }
        catch (OutputBudgetRefusal error)
        {
            return new(error.Status, 0);
        }
    }

    public static bool MemoryWithinBudget(AedsJsonOutputBudgetResult wire, long heldBytes, long maxMemoryBytes)
    {
        if (wire.Status != AedsJsonOutputBudgetStatus.Accepted || wire.ByteCount <= 0
            || heldBytes < 0 || maxMemoryBytes <= 0 || heldBytes > maxMemoryBytes)
        {
            return false;
        }
        // Existing publication allocates the serializer pool/exact byte copy
        // and requests a complete frame destination. Count workspace is also
        // retained. Provider-specific pool capacities remain a runtime gate.
        long remaining = maxMemoryBytes - heldBytes;
        long fixedReserve = SerializationMemoryReserveBytes + (long)AedsFrameHeader.Size;
        return remaining >= fixedReserve && wire.ByteCount <= (remaining - fixedReserve) / 4;
    }

    private sealed class DiscardOutputBuffer(long limit, CancellationToken cancellationToken) : IBufferWriter<byte>
    {
        private readonly byte[] _buffer = new byte[FixedSerializationBufferBytes];

        public long ByteCount
        {
            get; private set;
        }

        public void Advance(int count)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (count < 0 || count > _buffer.Length)
            {
                throw new ArgumentOutOfRangeException(nameof(count));
            }
            // Subtraction also refuses at long.MaxValue without an overflowing
            // addition. Advance discards committed bytes before the next span.
            if (count > limit - ByteCount)
            {
                throw new OutputBudgetRefusal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded);
            }
            ByteCount += count;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            ValidateSizeHint(sizeHint);
            return _buffer;
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            ValidateSizeHint(sizeHint);
            return _buffer;
        }

        private void ValidateSizeHint(int sizeHint)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (sizeHint < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(sizeHint));
            }
            if (sizeHint > FixedSerializationBufferBytes)
            {
                throw new OutputBudgetRefusal(AedsJsonOutputBudgetStatus.SerializationBufferExceeded);
            }
        }
    }

    // Guard before the writer rents escape/transcoding scratch space. Allowed
    // atoms use the production encoder unchanged; large atoms are explicitly
    // outside this bounded count operation even when the payload limit is high.
    // This does not bound allocations made by arbitrary getters or converters.
    private sealed class AtomicAdmissionEncoder(JavaScriptEncoder canonical, CancellationToken cancellationToken) : JavaScriptEncoder
    {
        private const int MaxAtomicInputLength = FixedSerializationBufferBytes / 6;

        public override int MaxOutputCharactersPerInputCharacter => canonical.MaxOutputCharactersPerInputCharacter;

        public override bool WillEncode(int unicodeScalar) => canonical.WillEncode(unicodeScalar);

        public override unsafe int FindFirstCharacterToEncode(char* text, int textLength)
        {
            Admit(textLength);
            return canonical.FindFirstCharacterToEncode(text, textLength);
        }

        public override int FindFirstCharacterToEncodeUtf8(ReadOnlySpan<byte> utf8Text)
        {
            Admit(utf8Text.Length);
            return canonical.FindFirstCharacterToEncodeUtf8(utf8Text);
        }

        public override OperationStatus EncodeUtf8(ReadOnlySpan<byte> source, Span<byte> destination,
            out int bytesConsumed, out int bytesWritten, bool isFinalBlock = true)
        {
            Admit(source.Length);
            return canonical.EncodeUtf8(source, destination, out bytesConsumed, out bytesWritten, isFinalBlock);
        }

        public override unsafe bool TryEncodeUnicodeScalar(int unicodeScalar, char* buffer,
            int bufferLength, out int numberOfCharactersWritten)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return canonical.TryEncodeUnicodeScalar(unicodeScalar, buffer, bufferLength, out numberOfCharactersWritten);
        }

        private void Admit(int inputLength)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (inputLength > MaxAtomicInputLength)
            {
                throw new OutputBudgetRefusal(AedsJsonOutputBudgetStatus.SerializationBufferExceeded);
            }
        }
    }

    private sealed class OutputBudgetRefusal(AedsJsonOutputBudgetStatus status) : Exception
    {
        public AedsJsonOutputBudgetStatus Status { get; } = status;
    }

    public static IResult Ok<T>(IAedsEncoder aeds, AedsFrameType frameType, T value)
        => BinaryResults.FrameRaw(aeds, frameType, JsonSerializer.SerializeToUtf8Bytes(value, s_jsonOptions));

    public static IResult OkNull(IAedsEncoder aeds, AedsFrameType frameType)
        => BinaryResults.FrameRaw(aeds, frameType, "null"u8.ToArray());

    public static IResult BadRequest(IAedsEncoder aeds, string message)
        => Error(aeds, ApiErrorTransportMappingId.Default400Validation, message);

    public static IResult NotFound(IAedsEncoder aeds, string message)
        => Error(aeds, ApiErrorTransportMappingId.Default404NotFound, message);

    public static IResult Unauthorized(IAedsEncoder aeds)
        => Error(aeds, ApiErrorTransportMappingId.Default401Unauthorized, "UNAUTHORIZED");

    public static IResult PreconditionRequired(IAedsEncoder aeds, string message)
        => Error(aeds, ApiErrorTransportMappingId.Operation428Forbidden, message);

    public static IResult Error(IAedsEncoder aeds, ApiErrorTransportMappingId mappingId, string message)
        => BinaryResults.FromError(ApiErrorSemanticMapper.CreateError(mappingId, message), aeds, mappingId);

    public static async Task<AedsJsonRequest<T>> ReadAsync<T>(
        HttpContext context,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        int maxFrameBytes,
        string invalidMessage,
        CancellationToken cancellationToken)
    {
        var requestContext = context.RequestServices.GetRequiredService<IBinaryEndpointRequestContext>();
        using BinaryRequestPayload payload = await requestContext.ReadFrameAsync(
            context,
            aeds,
            expectedFrameType,
            cancellationToken,
            maxFrameBytes);
        if (!payload.IsSuccess)
        {
            return AedsJsonRequest<T>.Failure(payload.Error);
        }

        try
        {
            T? value = JsonSerializer.Deserialize<T>(payload.Payload.Span, s_jsonOptions);
            return value is null
                ? AedsJsonRequest<T>.Failure(ErrorDetail.Create(ErrorCode.Validation, invalidMessage))
                : AedsJsonRequest<T>.Success(value);
        }
        catch (JsonException)
        {
            return AedsJsonRequest<T>.Failure(ErrorDetail.Create(ErrorCode.Validation, invalidMessage));
        }
    }
}

internal readonly record struct AedsJsonRequest<T>(bool IsSuccess, T? Value, ErrorDetail Error)
{
    public static AedsJsonRequest<T> Success(T value)
        => new(true, value, ErrorDetail.None);

    public static AedsJsonRequest<T> Failure(ErrorDetail error)
        => new(false, default, error);

    public IResult ToErrorResult(IAedsEncoder aeds)
        => BinaryResults.FromError(ErrorDetail.Create(Error.Code, Error.Message), aeds);
}

internal enum AedsJsonOutputBudgetStatus
{
    Accepted,
    InvalidBudget,
    OutputBudgetExceeded,
    SerializationBufferExceeded
}

internal readonly record struct AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus Status, long ByteCount);
