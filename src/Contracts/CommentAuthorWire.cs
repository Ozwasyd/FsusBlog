using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

internal sealed record CommentAuthorChallengeRequest(string? Purpose, string? CapabilitySecret);
internal sealed record CommentAuthorDeleteRequest(string? Challenge, string? CapabilitySecret);
public sealed record CommentAuthorChallenge(bool Issued, string Challenge, DateTime ExpiresAtUtc, string? FailureCode, long CurrentVersion);
public sealed record CommentAuthorMutation(bool Success, string Code, long CurrentVersion, int ModerationStatus, DateTime? EditedAtUtc);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(CommentAuthorChallengeRequest))]
[JsonSerializable(typeof(CommentAuthorDeleteRequest))]
[JsonSerializable(typeof(CommentAuthorChallenge))]
[JsonSerializable(typeof(CommentAuthorMutation))]
internal partial class CommentAuthorJson : JsonSerializerContext;

public static partial class Wire
{
    public static void ValidateCommentAuthorChallengeRequest(ReadOnlySpan<byte> frame)
        => ReadCommentAuthorChallengePurpose(frame, allowAppeal: false);

    public static string ReadCommentAuthorChallengePurpose(ReadOnlySpan<byte> frame, bool allowAppeal)
    {
        try
        {
            var request = JsonSerializer.Deserialize(Aeds.Decode(frame, FrameType.CommentManagementChallengeRequest),
                CommentAuthorJson.Default.CommentAuthorChallengeRequest);
            if (request is { Purpose: "delete", CapabilitySecret: null }) return "delete";
            if (allowAppeal && request is { Purpose: "appeal", CapabilitySecret: null }) return "appeal";
        }
        catch (JsonException) { }
        throw new ProtocolException("Invalid comment author challenge request.");
    }

    public static string ReadCommentAuthorDeleteRequest(ReadOnlySpan<byte> frame)
    {
        try
        {
            var request = JsonSerializer.Deserialize(Aeds.Decode(frame, FrameType.CommentAuthorStatusRequest),
                CommentAuthorJson.Default.CommentAuthorDeleteRequest);
            if (request is { Challenge: { Length: 43 } proof, CapabilitySecret: "" } &&
                proof.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_')) return proof;
        }
        catch (JsonException) { }
        throw new ProtocolException("Invalid comment author delete request.");
    }

    public static byte[] EncodeCommentAuthorChallenge(CommentAuthorChallenge value) => Aeds.Encode(
        FrameType.CommentManagementChallengeResponse,
        JsonSerializer.SerializeToUtf8Bytes(value, CommentAuthorJson.Default.CommentAuthorChallenge));

    public static byte[] EncodeCommentAuthorMutation(CommentAuthorMutation value) => Aeds.Encode(
        FrameType.CommentAuthorMutationResult,
        JsonSerializer.SerializeToUtf8Bytes(value, CommentAuthorJson.Default.CommentAuthorMutation));

    public static long[] DecodeCommentAuthorEligibilityRequest(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.CommentAuthorEligibilityRequest));
        var length = reader.I32();
        if (length is < 1 or > WireLimits.CommentAuthorBatchSize)
            throw new ProtocolException("Invalid comment eligibility count.");
        var ids = new long[length];
        for (var index = 0; index < ids.Length; index++) ids[index] = reader.I64();
        reader.Finish();
        if (ids.Any(id => id <= 0) || ids.Distinct().Count() != length)
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
