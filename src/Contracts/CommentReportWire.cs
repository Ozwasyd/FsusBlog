using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

internal sealed record CommentReportPayload(string? ReasonCode, string? Detail, string? ScopedCredential);
public sealed record CommentReportRequest(string ReasonCode, string? Detail);
public sealed record CommentReportResult(bool Success, string Code, long ReportId, bool Duplicate);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(CommentReportPayload))]
[JsonSerializable(typeof(CommentReportResult))]
internal partial class CommentReportJson : JsonSerializerContext;

public static partial class Wire
{
    public const long MaxCommentReportId = (1L << 53) - 1;

    public static CommentReportRequest DecodeCommentReportRequest(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.CommentReportFrameBytes) throw Invalid();
        try
        {
            var value = JsonSerializer.Deserialize(Aeds.Decode(frame, FrameType.CommentReportRequest),
                CommentReportJson.Default.CommentReportPayload);
            var reason = value?.ReasonCode?.Trim().ToLowerInvariant();
            if (value is not { ScopedCredential: null } ||
                reason is not ("spam" or "harassment" or "hate" or "privacy" or "illegal" or "misinformation" or "other"))
                throw Invalid();
            var detail = value.Detail?.Trim();
            if (detail is { Length: > WireLimits.CommentReportDetailChars } ||
                detail?.Any(ch => char.IsControl(ch) && ch is not ('\t' or '\r' or '\n')) is true) throw Invalid();
            return new(reason, detail is { Length: > 0 } ? detail : null);
        }
        catch (JsonException) { throw Invalid(); }

        static ProtocolException Invalid() => new("Invalid signed-in comment report.");
    }

    public static byte[] EncodeCommentReportResult(CommentReportResult value)
    {
        if (!value.Success || value.ReportId is <= 0 or > MaxCommentReportId ||
            value.Code != (value.Duplicate ? "comment_report_duplicate" : "ok"))
            throw new ProtocolException("Invalid comment report receipt.");
        return Aeds.Encode(FrameType.CommentReportResult,
            JsonSerializer.SerializeToUtf8Bytes(value, CommentReportJson.Default.CommentReportResult));
    }
}
