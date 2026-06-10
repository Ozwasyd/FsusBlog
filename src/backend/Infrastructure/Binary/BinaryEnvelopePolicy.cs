using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Binary;

internal interface IBinaryEnvelopePolicy
{
    bool AcceptsBinaryEnvelope(HttpRequest request);
    bool ExplicitlyAcceptsBinaryEnvelope(HttpRequest request);
    bool IsBinaryContentType(string contentType);
    bool IsBinaryRequestContentType(string contentType);
    bool IsStreamContentType(string contentType);
    ErrorCode MapErrorCode(int statusCode);
    void ApplyFrameResponse(HttpResponse response, int payloadLength, int? statusCode = null);
    Task WriteApiErrorAsync(HttpContext context, Stream responseBody, ErrorDetail error, int statusCode);
}

internal sealed class BinaryEnvelopePolicy : IBinaryEnvelopePolicy
{
    private const string BinaryContentType = "application/octet-stream";
    private const string BinaryFrameVersion = "2";

    public bool AcceptsBinaryEnvelope(HttpRequest request)
        => HttpAcceptNegotiation.Accepts(request.Headers.Accept, BinaryContentType);

    public bool ExplicitlyAcceptsBinaryEnvelope(HttpRequest request)
        => HttpAcceptNegotiation.ExplicitlyAccepts(request.Headers.Accept, BinaryContentType);

    public bool IsBinaryContentType(string contentType)
    {
        return IsBinaryRequestContentType(contentType)
            || contentType.StartsWith("application/wasm", StringComparison.OrdinalIgnoreCase);
    }

    public bool IsBinaryRequestContentType(string contentType)
    {
        return contentType.StartsWith(BinaryContentType, StringComparison.OrdinalIgnoreCase);
    }

    public bool IsStreamContentType(string contentType)
    {
        return contentType.StartsWith("application/grpc", StringComparison.OrdinalIgnoreCase);
    }

    public ErrorCode MapErrorCode(int statusCode)
        => ApiErrorSemanticMapper.MapErrorCode(statusCode);

    public void ApplyFrameResponse(HttpResponse response, int payloadLength, int? statusCode = null)
    {
        response.ContentType = BinaryContentType;
        if (statusCode.HasValue)
        {
            response.StatusCode = statusCode.Value;
        }

        response.Headers["X-Fsus-Frame-Version"] = BinaryFrameVersion;
        response.ContentLength = AedsFrameHeader.Size + payloadLength;
    }

    public async Task WriteApiErrorAsync(HttpContext context, Stream responseBody, ErrorDetail error, int statusCode)
    {
        using var frameWriter = new AedsFrameBufferWriter(256);
        PodBinaryCodec.WriteApiError(error, frameWriter.PayloadWriter, statusCode);
        frameWriter.Seal(AedsFrameType.ApiError);

        context.Response.Body = responseBody;
        ApplyFrameResponse(context.Response, frameWriter.PayloadLength, statusCode);
        await context.Response.BodyWriter.WriteAsync(frameWriter.WrittenFrame, context.RequestAborted);
        await context.Response.BodyWriter.FlushAsync(context.RequestAborted);
    }
}

internal static class HttpAcceptNegotiation
{
    public static bool Accepts(StringValues acceptHeaders, string mediaType)
        => TryEvaluate(acceptHeaders, mediaType, includeWildcards: true, out double quality)
            ? quality > 0
            : true;

    public static bool ExplicitlyAccepts(StringValues acceptHeaders, string mediaType)
        => TryEvaluate(acceptHeaders, mediaType, includeWildcards: false, out double quality) && quality > 0;

    private static bool TryEvaluate(StringValues acceptHeaders, string mediaType, bool includeWildcards, out double quality)
    {
        ReadOnlySpan<char> expected = mediaType.AsSpan();
        int slash = expected.IndexOf('/');
        ReadOnlySpan<char> expectedType = slash >= 0 ? expected[..slash] : expected;

        bool sawHeader = false;
        bool matched = false;
        int selectedSpecificity = -1;
        double selectedQuality = 0;

        for (int i = 0; i < acceptHeaders.Count; i++)
        {
            string? header = acceptHeaders[i];
            if (string.IsNullOrWhiteSpace(header))
            {
                continue;
            }

            sawHeader = true;
            ReadOnlySpan<char> remaining = header.AsSpan();
            while (true)
            {
                int comma = remaining.IndexOf(',');
                ReadOnlySpan<char> segment = comma >= 0 ? remaining[..comma] : remaining;
                EvaluateSegment(segment, expected, expectedType, includeWildcards, ref matched, ref selectedSpecificity, ref selectedQuality);

                if (comma < 0)
                {
                    break;
                }

                remaining = remaining[(comma + 1)..];
            }
        }

        quality = matched ? selectedQuality : -1;
        return sawHeader;
    }

    private static void EvaluateSegment(
        ReadOnlySpan<char> segment,
        ReadOnlySpan<char> expected,
        ReadOnlySpan<char> expectedType,
        bool includeWildcards,
        ref bool matched,
        ref int selectedSpecificity,
        ref double selectedQuality)
    {
        segment = segment.Trim();
        if (segment.IsEmpty)
        {
            return;
        }

        int semicolon = segment.IndexOf(';');
        ReadOnlySpan<char> range = (semicolon >= 0 ? segment[..semicolon] : segment).Trim();
        int specificity = MatchSpecificity(range, expected, expectedType, includeWildcards);
        if (specificity < 0)
        {
            return;
        }

        double q = semicolon >= 0 ? ParseQuality(segment[(semicolon + 1)..]) : 1;
        if (!matched || specificity > selectedSpecificity || (specificity == selectedSpecificity && q > selectedQuality))
        {
            matched = true;
            selectedSpecificity = specificity;
            selectedQuality = q;
        }
    }

    private static int MatchSpecificity(
        ReadOnlySpan<char> range,
        ReadOnlySpan<char> expected,
        ReadOnlySpan<char> expectedType,
        bool includeWildcards)
    {
        if (range.Equals(expected, StringComparison.OrdinalIgnoreCase))
        {
            return 2;
        }

        if (!includeWildcards)
        {
            return -1;
        }

        if (range.Equals("*/*".AsSpan(), StringComparison.Ordinal))
        {
            return 0;
        }

        int slash = range.IndexOf('/');
        if (slash > 0
            && slash + 2 == range.Length
            && range[slash + 1] == '*'
            && range[..slash].Equals(expectedType, StringComparison.OrdinalIgnoreCase))
        {
            return 1;
        }

        return -1;
    }

    private static double ParseQuality(ReadOnlySpan<char> parameters)
    {
        while (!parameters.IsEmpty)
        {
            int semicolon = parameters.IndexOf(';');
            ReadOnlySpan<char> parameter = (semicolon >= 0 ? parameters[..semicolon] : parameters).Trim();
            int equals = parameter.IndexOf('=');
            if (equals > 0)
            {
                ReadOnlySpan<char> name = parameter[..equals].Trim();
                if (name.Equals("q".AsSpan(), StringComparison.OrdinalIgnoreCase))
                {
                    ReadOnlySpan<char> value = parameter[(equals + 1)..].Trim();
                    return double.TryParse(
                        value,
                        System.Globalization.NumberStyles.AllowDecimalPoint,
                        System.Globalization.CultureInfo.InvariantCulture,
                        out double parsed)
                            ? Math.Clamp(parsed, 0, 1)
                            : 0;
                }
            }

            if (semicolon < 0)
            {
                break;
            }

            parameters = parameters[(semicolon + 1)..];
        }

        return 1;
    }
}
