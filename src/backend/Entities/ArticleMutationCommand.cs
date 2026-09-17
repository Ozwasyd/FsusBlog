using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_mutation_command")]
[SugarIndex("ux_article_mutation_command_identity", nameof(AdminPrincipalId), OrderByType.Asc, nameof(ClientMutationId), OrderByType.Asc, true)]
public sealed class ArticleMutationCommand
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "admin_principal_id")]
    public long AdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "client_mutation_id", Length = 36)]
    public string ClientMutationId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "request_hash", Length = 64)]
    public string RequestHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_id")]
    public long RevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "release_id")]
    public long ReleaseId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "release_no")]
    public int ReleaseNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "status")]
    public int Status
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_snapshot_id")]
    public long RightsSnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_revision_no")]
    public int RightsRevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }
}
