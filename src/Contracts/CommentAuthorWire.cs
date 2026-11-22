using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace FsusBlog.V2.Contracts;

internal sealed record CommentAuthorChallengeRequest(string? Purpose, string? CapabilitySecret);
internal sealed record CommentAuthorDeleteRequest(string? Challenge, string? CapabilitySecret);
public sealed record CommentAuthorEditRequest(
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] long ExpectedVersion, string Content, string Challenge);
public sealed record CommentAuthorChallenge(bool Issued, string Challenge, DateTime ExpiresAtUtc, string? FailureCode, long CurrentVersion);
public sealed record CommentAuthorMutation(bool Success, string Code, long CurrentVersion, int ModerationStatus, DateTime? EditedAtUtc);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(CommentAuthorChallengeRequest))]
[JsonSerializable(typeof(CommentAuthorDeleteRequest))]
[JsonSerializable(typeof(CommentAuthorEditRequest))]
[JsonSerializable(typeof(CommentAuthorChallenge))]
[JsonSerializable(typeof(CommentAuthorMutation))]
internal partial class CommentAuthorJson : JsonSerializerContext;

public static partial class Wire
{
    private const long MaxCommentAuthorVersion = 9_007_199_254_740_991L;

    private static T? ReadCommentJson<T>(ReadOnlySpan<byte> payload, JsonTypeInfo<T> type) where T : class
    {
        try { return JsonSerializer.Deserialize(payload, type); }
        catch (JsonException) { return null; }
    }

    private static byte[] WriteCommentJson<T>(FrameType frame, T value, JsonTypeInfo<T> type) =>
        Aeds.Encode(frame, JsonSerializer.SerializeToUtf8Bytes(value, type));

    private static bool ValidCommentProof(string proof) =>
        proof.Length == 43 && proof.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_');

    public static void ValidateCommentAuthorChallengeRequest(ReadOnlySpan<byte> frame)
        => ReadCommentAuthorChallengePurpose(frame, allowAppeal: false);

    public static string ReadCommentAuthorChallengePurpose(ReadOnlySpan<byte> frame, bool allowAppeal, bool allowEdit = false)
    {
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentManagementChallengeRequest),
            CommentAuthorJson.Default.CommentAuthorChallengeRequest);
        if (request is { Purpose: "delete", CapabilitySecret: null }) return "delete";
        if (allowAppeal && request is { Purpose: "appeal", CapabilitySecret: null }) return "appeal";
        if (allowEdit && request is { Purpose: "edit", CapabilitySecret: null }) return "edit";
        throw new ProtocolException("Invalid comment author challenge request.");
    }

    public static CommentAuthorEditRequest DecodeCommentAuthorEditRequest(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.CommentAuthorEditFrameBytes)
            throw new ProtocolException("Comment edit request exceeds its frame limit.");
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentAuthorEditRequest),
            CommentAuthorJson.Default.CommentAuthorEditRequest);
        if (request is { ExpectedVersion: > 0 and < MaxCommentAuthorVersion, Content.Length: > 0, Challenge: { } proof } &&
            ValidCommentProof(proof)) return request;
        throw new ProtocolException("Invalid comment author edit request.");
    }

    internal static void Validate(CommentAuthorEditDetail value)
    {
        if (value is not { ArticleId: > 0, Publication: > 0, CurrentVersion: > 0 and < MaxCommentAuthorVersion, Body.Length: > 0 })
            throw new ProtocolException("Invalid comment author edit detail.");
    }

    public static string ReadCommentAuthorDeleteRequest(ReadOnlySpan<byte> frame)
    {
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentAuthorStatusRequest),
            CommentAuthorJson.Default.CommentAuthorDeleteRequest);
        if (request is { Challenge: { } proof, CapabilitySecret: "" } &&
            ValidCommentProof(proof)) return proof;
        throw new ProtocolException("Invalid comment author delete request.");
    }

    public static byte[] EncodeCommentAuthorChallenge(CommentAuthorChallenge value) =>
        WriteCommentJson(FrameType.CommentManagementChallengeResponse, value,
            CommentAuthorJson.Default.CommentAuthorChallenge);

    public static byte[] EncodeCommentAuthorMutation(CommentAuthorMutation value) =>
        WriteCommentJson(FrameType.CommentAuthorMutationResult, value, CommentAuthorJson.Default.CommentAuthorMutation);

    public static long[] DecodeCommentAuthorEligibilityRequest(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.CommentAuthorEligibilityRequest));
        var ids = new long[reader.Count(1, WireLimits.CommentAuthorBatchSize,
            static () => new ProtocolException("Invalid comment eligibility count."))];
        for (var index = 0; index < ids.Length; index++) ids[index] = reader.I64();
        reader.Finish();
        if (ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Length)
            throw new ProtocolException("Invalid comment eligibility coordinates.");
        return ids;
    }

    public static byte[] EncodeCommentAuthorEligibility(IReadOnlyList<long> ids)
    {
        if (ids.Count > WireLimits.CommentAuthorBatchSize) throw new ProtocolException("Invalid comment eligibility count.");
        var writer = new Writer();
        writer.I32(ids.Count);
        foreach (var id in ids) writer.I64(id);
        return Aeds.Encode(FrameType.CommentAuthorEligibility, writer.Written);
    }
}
