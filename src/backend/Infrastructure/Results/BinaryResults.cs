using System.Buffers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.Results;

public static class BinaryResults
{
    public static BinaryFrameResult FromResult<T>(
        in Result<T> result,
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Action<T, IBufferWriter<byte>> writePayload,
        string? nullValueMessage = null)
    {
        if (!result.IsSuccess)
        {
            return FromError(result.Error, aeds);
        }

        if (result.Value is null)
        {
            return FromError(ErrorDetail.Create(ErrorCode.InfraFailure, nullValueMessage ?? "二进制载荷为空"), aeds);
        }

        T value = result.Value;
        return Frame(aeds, frameType, writer => writePayload(value, writer));
    }

    public static BinaryFrameResult FromError(in ErrorDetail error, IAedsEncoder aeds, int httpStatus = 0)
    {
        ErrorDetail copy = error;
        int status = httpStatus > 0 ? httpStatus : ApiErrorSemanticMapper.MapStatusCode(copy);
        return Frame(aeds, AedsFrameType.ApiError, writer => PodBinaryCodec.WriteApiError(copy, writer, status), status);
    }

    public static BinaryFramePayloadResult FrameRaw(
        IAedsEncoder aeds,
        AedsFrameType frameType,
        ReadOnlyMemory<byte> payload)
        => new(aeds, frameType, payload);

    public static BinaryPreencodedFrameResult PreencodedFrame(ReadOnlyMemory<byte> frame)
        => new(frame);

    public static BinaryPreencodedFrameResult PreencodedFrame(ReadOnlyMemory<byte> frame, BinaryFrameResponseMetadata metadata)
        => new(frame, metadata: metadata);

    public static BinaryPreencodedFrameResult PreencodedFrame(OwnedAedsFrameReadLease frameLease)
        => new(frameLease);

    public static BinaryPreencodedFrameResult PreencodedFrame(
        OwnedAedsFrameReadLease frameLease,
        BinaryFrameResponseMetadata metadata)
        => new(frameLease, metadata: metadata);

    public static BinaryFrameResult Frame(
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload)
    {
        return new BinaryFrameResult(frameType, writePayload);
    }

    public static BinaryFrameResult Frame(
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload,
        int statusCode)
    {
        return new BinaryFrameResult(frameType, writePayload, statusCode);
    }

    public static int MapStatusCode(in ErrorDetail error)
        => ApiErrorSemanticMapper.MapStatusCode(error);
}
