using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

public sealed record AdminCommentRevision(long Version, string Content, string ContentSha256,
    string Operation, DateTime CreatedAtUtc, string ActorMode = "public");

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(List<AdminCommentRevision>))]
internal partial class AdminCommentRevisionJson : JsonSerializerContext;

public static partial class Wire
{
    public static byte[] EncodeAdminCommentRevisions(List<AdminCommentRevision> revisions) =>
        Aeds.Encode(FrameType.CommentRevisionList,
            JsonSerializer.SerializeToUtf8Bytes(revisions, AdminCommentRevisionJson.Default.ListAdminCommentRevision));
}
