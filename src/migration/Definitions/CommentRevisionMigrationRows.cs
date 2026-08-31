using SqlSugar;

namespace FsusBlog.Migration.Definitions;

[SugarTable("comment")]
internal sealed class Comment
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "content", ColumnDataType = "text")]
    public string Content { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "create_time")]
    public DateTime CreateTime
    {
        get; set;
    }

    [SugarColumn(ColumnName = "user_id", IsNullable = true)]
    public int? UserId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "author_mode", Length = 48)]
    public string AuthorMode { get; set; } = string.Empty;
}

[SugarTable("comment_revision")]
internal sealed class CommentRevision
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "version")]
    public int Version
    {
        get; set;
    }

    [SugarColumn(ColumnName = "content", ColumnDataType = "text")]
    public string Content { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_sha256", Length = 64)]
    public string ContentSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "operation", Length = 24)]
    public string Operation { get; set; } = CommentRevisionOperations.Created;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_account_id", IsNullable = true)]
    public int? ActorAccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_admin_principal_id", IsNullable = true)]
    public long? ActorAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_mode", Length = 32)]
    public string ActorMode { get; set; } = string.Empty;
}

internal static class CommentRevisionOperations
{
    internal const string Created = "created";
}
