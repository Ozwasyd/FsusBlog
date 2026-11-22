using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

public sealed record AuthorAppealInput(string? Reason, string? Challenge);
public sealed record AdminAppealInput(string? Decision, string? Reason);
public sealed record AdminAppealResult(bool Success, string Code, long? AppealId);
public sealed record AuthorAppealRow(int Article, long Comment, string Body, int Status, int Appeal, string? DecisionReason,
    bool Editable);
public sealed record AdminAppealRow(long Appeal, int Article, long Comment, string Body, string Reason);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(AuthorAppealInput))]
[JsonSerializable(typeof(AdminAppealInput))]
[JsonSerializable(typeof(AdminAppealResult))]
internal partial class CommentAppealJson : JsonSerializerContext;

public static partial class Wire
{
    public const int CommentAppealPageSize = 24;
    public const int CommentAppealFrameBytes = 7000;

    public static AuthorAppealInput DecodeAuthorAppeal(ReadOnlySpan<byte> frame)
    {
        try
        {
            var request = JsonSerializer.Deserialize(Aeds.Decode(frame, FrameType.CommentAuthorAppealRequest),
                CommentAppealJson.Default.AuthorAppealInput);
            if (request is { Reason: not null, Challenge: { Length: 43 } proof } &&
                proof.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return request;
        }
        catch (JsonException) { }
        throw new ProtocolException("Invalid author appeal.");
    }

    public static AdminAppealInput DecodeAdminAppeal(ReadOnlySpan<byte> frame)
    {
        try
        {
            var request = JsonSerializer.Deserialize(Aeds.Decode(frame, FrameType.CommentAppealDecisionRequest),
                CommentAppealJson.Default.AdminAppealInput);
            if (request is { Reason: not null, Decision: "granted" or "denied" }) return request;
        }
        catch (JsonException) { }
        throw new ProtocolException("Invalid administrator appeal decision.");
    }

    public static byte[] EncodeAdminAppealResult(long id) => Aeds.Encode(FrameType.CommentAppealDecisionResult,
        JsonSerializer.SerializeToUtf8Bytes(new(true, "ok", id), CommentAppealJson.Default.AdminAppealResult));

    public static byte[] EncodeAuthorAppeals(IReadOnlyList<AuthorAppealRow> rows, bool more)
    {
        var writer = new Writer();
        writer.Bool(more);
        writer.I32(rows.Count);
        foreach (var row in rows)
        {
            writer.I32(row.Article);
            writer.I64(row.Comment);
            writer.Text(row.Body, 4096);
            writer.I32(row.Status);
            writer.I32(row.Appeal);
            writer.Text(row.DecisionReason ?? "", 4000);
            writer.Bool(row.Editable);
        }
        return Aeds.Encode(FrameType.CommentAuthorAppeals, writer.Written);
    }

    public static byte[] EncodeAdminCommentAppeals(IReadOnlyList<AdminAppealRow> rows, bool more)
    {
        var writer = new Writer();
        writer.Bool(more);
        writer.I32(rows.Count);
        foreach (var row in rows)
        {
            writer.I64(row.Appeal);
            writer.I32(row.Article);
            writer.I64(row.Comment);
            writer.Text(row.Body, 4096);
            writer.Text(row.Reason, 4000);
        }
        return Aeds.Encode(FrameType.AdminCommentAppeals, writer.Written);
    }
}
