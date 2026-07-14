using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Infrastructure.Results;

internal static class AedsJsonResults
{
    public const int MaxAuthoringFrameBytes = 8 * 1024 * 1024;
    public const int MaxSecurityFrameBytes = 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static IResult Ok<T>(IAedsEncoder aeds, AedsFrameType frameType, T value)
        => BinaryResults.FrameRaw(aeds, frameType, JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions));

    public static IResult OkNull(IAedsEncoder aeds, AedsFrameType frameType)
        => BinaryResults.FrameRaw(aeds, frameType, "null"u8.ToArray());

    public static IResult BadRequest(IAedsEncoder aeds, string message)
        => Error(aeds, ErrorCode.Validation, message, StatusCodes.Status400BadRequest);

    public static IResult NotFound(IAedsEncoder aeds, string message)
        => Error(aeds, ErrorCode.NotFound, message, StatusCodes.Status404NotFound);

    public static IResult Unauthorized(IAedsEncoder aeds)
        => Error(aeds, ErrorCode.Unauthorized, "UNAUTHORIZED", StatusCodes.Status401Unauthorized);

    public static IResult PreconditionRequired(IAedsEncoder aeds, string message)
        => Error(aeds, ErrorCode.Forbidden, message, StatusCodes.Status428PreconditionRequired);

    public static IResult Error(IAedsEncoder aeds, ErrorCode code, string message, int statusCode = 0)
        => BinaryResults.FromError(ErrorDetail.Create(code, message), aeds, statusCode);

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
            T? value = JsonSerializer.Deserialize<T>(payload.Payload.Span, JsonOptions);
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
