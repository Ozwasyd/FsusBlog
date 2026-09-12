using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Services.Authoring;

public readonly record struct ArticleTemplateProfileReference(Guid ProfileId, long Revision);

public sealed class ArticleTemplateDefaults
{
    public ArticleTemplateDefaults(
        string? titlePlaceholder = null,
        string? summaryPlaceholder = null,
        int? categoryId = null,
        IEnumerable<int>? tagIds = null,
        IEnumerable<ArticleTemplatePropertyDefault>? propertyDefaults = null,
        IEnumerable<AssetId>? assetIds = null,
        ArticleTemplateProfileReference? rightsProfile = null,
        ArticleTemplateProfileReference? responsibilityProfile = null,
        ArticleTemplateProfileReference? prepublishProfile = null)
    {
        TitlePlaceholder = titlePlaceholder;
        SummaryPlaceholder = summaryPlaceholder;
        CategoryId = categoryId;
        TagIds = Array.AsReadOnly((tagIds ?? []).Distinct().Order().ToArray());
        PropertyDefaults = Array.AsReadOnly(
            (propertyDefaults ?? []).OrderBy(static item => item.DefinitionId).ToArray());
        AssetIds = Array.AsReadOnly(
            (assetIds ?? []).Distinct().OrderBy(static item => item.Value).ToArray());
        RightsProfile = rightsProfile;
        ResponsibilityProfile = responsibilityProfile;
        PrepublishProfile = prepublishProfile;
        ArticleTemplateContract.ValidateDefaults(this);
    }

    public string? TitlePlaceholder
    {
        get;
    }
    public string? SummaryPlaceholder
    {
        get;
    }
    public int? CategoryId
    {
        get;
    }
    public IReadOnlyList<int> TagIds
    {
        get;
    }
    public IReadOnlyList<ArticleTemplatePropertyDefault> PropertyDefaults
    {
        get;
    }
    public IReadOnlyList<AssetId> AssetIds
    {
        get;
    }
    public ArticleTemplateProfileReference? RightsProfile
    {
        get;
    }
    public ArticleTemplateProfileReference? ResponsibilityProfile
    {
        get;
    }
    public ArticleTemplateProfileReference? PrepublishProfile
    {
        get;
    }
}

public sealed record ArticleTemplateDefinition(
    int SchemaVersion,
    Guid TemplateId,
    ArticleTemplateScope Scope,
    string Name,
    string NameKey,
    string? Description,
    ArticleTemplateStatus Status,
    long Revision,
    Guid CurrentVersionId,
    int CurrentVersionNumber,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    string ContentDigest);

public sealed record ArticleTemplateVersion(
    int SchemaVersion,
    Guid TemplateId,
    Guid VersionId,
    int VersionNumber,
    long CreatedByAdminPrincipalId,
    DateTime CreatedAtUtc,
    ArticleTemplateSource Source,
    ArticleTemplateDefaults Defaults,
    string DefaultsDigest,
    string ContentDigest);

public sealed record ArticleTemplatePageCursor(string NameKey, Guid TemplateId);

public sealed record ArticleTemplatePage(
    IReadOnlyList<ArticleTemplateDefinition> Items,
    ArticleTemplatePageCursor? NextCursor,
    long ScopeRevision);

public sealed record ArticleTemplateVersionPage(
    IReadOnlyList<ArticleTemplateVersion> Items,
    int? NextVersionNumber);

public sealed record ArticleTemplateWriteReceipt(
    Guid ReceiptId,
    Guid RequestId,
    long ActorAdminPrincipalId,
    string CommandKind,
    string CommandDigest,
    Guid TemplateId,
    Guid? VersionId,
    int? VersionNumber,
    ArticleTemplateScope Scope,
    long PreviousScopeRevision,
    long ScopeRevision,
    long PreviousTemplateRevision,
    long TemplateRevision,
    ArticleTemplatePermission Permission,
    string PermissionDigest,
    string DefaultsDigest,
    ArticleTemplateStatus Status,
    string DefinitionDigest,
    string VersionDigest,
    ArticleTemplateDeleteDisposition DeleteDisposition,
    DateTime OccurredAtUtc,
    Guid AuditReference,
    string AuditDigest,
    string ContentDigest,
    bool IsIdempotentReplay = false);

