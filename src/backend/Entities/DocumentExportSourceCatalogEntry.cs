using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>Private source binding only. No Markdown, labels, policy payloads or portable artifact identities.</summary>
[SugarTable("document_export_source_catalog")]
public sealed class DocumentExportSourceCatalogEntry
{
    [SugarColumn(ColumnName = "source_version", IsPrimaryKey = true, IsIdentity = true)]
    public long SourceVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "choice_id", Length = 64)]
    public string ChoiceId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "owner_admin_principal_id")]
    public long OwnerAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "site_scope", Length = 128)]
    public string SiteScope { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "source_kind")]
    public int SourceKind
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "draft_key", Length = 96, IsNullable = true)]
    public string? DraftKey
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_id", IsNullable = true)]
    public long? RevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "publication_id", IsNullable = true)]
    public long? PublicationId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "fingerprint", Length = 64)]
    public string Fingerprint { get; set; } = string.Empty;
}
