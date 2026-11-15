using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

public sealed record AdminCommentRevision(long Version, string Content, string ContentSha256,
    string Operation, DateTime CreatedAtUtc, string ActorMode = "public");

public sealed record AdminCommentTimeline(long CommentId, int ArticleId, short ProjectedStatus, short CurrentStatus,
    bool Consistent, bool Deleted, IReadOnlyList<AdminCommentTimelineEvent> Events);

public sealed record AdminCommentTimelineEvent(long Id, long CommentId, string EventType, short? PreviousStatus, short NextStatus,
    string ActorType, string? ReasonCode, DateTime OccurredAtUtc, string TransitionSource, long? CommentVersion,
    Guid? AdminPrincipal, string? DatabaseRole, long? AppealId);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(List<AdminCommentRevision>))]
[JsonSerializable(typeof(AdminCommentTimeline))]
internal partial class AdminCommentRevisionJson : JsonSerializerContext;

public static partial class Wire
{
    public static byte[] EncodeAdminCommentRevisions(List<AdminCommentRevision> revisions) =>
        Aeds.Encode(FrameType.CommentRevisionList,
            JsonSerializer.SerializeToUtf8Bytes(revisions, AdminCommentRevisionJson.Default.ListAdminCommentRevision));

    public static byte[] EncodeAdminCommentTimeline(AdminCommentTimeline timeline) =>
        Aeds.Encode(FrameType.CommentModerationTimeline,
            JsonSerializer.SerializeToUtf8Bytes(timeline, AdminCommentRevisionJson.Default.AdminCommentTimeline));
}
