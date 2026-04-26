using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;
using System.Buffers;

namespace FsusBlog.Server.Infrastructure.Results;

public static class BinaryResults
{
    public static Results<BinaryFrameResult, JsonHttpResult<ApiResponse>> FromResult<T>(
        in Result<T> result,
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Action<T, IBufferWriter<byte>> writePayload,
        string? nullValueMessage = null)
    {
        if (!result.IsSuccess)
        {
            return FromError(result.Error);
        }

        if (result.Value is null)
        {
            return FromError(ErrorDetail.Create(ErrorCode.InfraFailure, nullValueMessage ?? "二进制载荷为空"));
        }

        T value = result.Value;
        return Frame(aeds, frameType, writer => writePayload(value, writer));
    }

    public static Results<BinaryFrameResult, JsonHttpResult<ApiResponse>> FromResult<T>(
        in Result<T> result,
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Func<T, byte[]> encodePayload,
        string? nullValueMessage = null)
    {
        if (!result.IsSuccess)
        {
            return FromError(result.Error);
        }

        if (result.Value is null)
        {
            return FromError(ErrorDetail.Create(ErrorCode.InfraFailure, nullValueMessage ?? "二进制载荷为空"));
        }

        return Frame(aeds, frameType, encodePayload(result.Value));
    }

    public static Results<BinaryFrameResult, JsonHttpResult<ApiResponse>> FromError(in ErrorDetail error)
        => ApiResults.FromError(error);

    public static Results<BinaryFrameResult, JsonHttpResult<ApiResponse>> Frame(
        IAedsEncoder aeds,
        AedsFrameType frameType,
        byte[] payload)
        => Frame(aeds, frameType, writer => writer.Write(payload));

    public static Results<BinaryFrameResult, JsonHttpResult<ApiResponse>> Frame(
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload)
    {
        return new BinaryFrameResult(aeds, frameType, writePayload);
    }
}
