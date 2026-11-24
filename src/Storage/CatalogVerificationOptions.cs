namespace FsusBlogV2.Storage;

internal readonly record struct SchemaAdmission(
    bool? Subscription = null, bool? RecoveryKey = null, bool? AdminInboxReply = null, bool? SiteRefresh = null,
    bool? SitePageEditor = null, bool? SiteConfigEditor = null, bool? AdminArticleRollback = null,
    bool? AdminInboxStatus = null, bool? AdminInboxNotice = null, bool? AppearanceActivation = null,
    bool? AdminTagMetadata = null, bool? AdminInboxRead = null, bool? PublicationMedia = null,
    bool? AdminCommentBatch = null, bool? AuthorTextIndex = null, bool? ArticleSummary = null,
    bool? DocumentExports = null, bool? AdminCategoryMetadata = null);

internal sealed record CatalogVerificationOptions
{
    internal static readonly CatalogVerificationOptions Default = new();

    internal static CatalogVerificationOptions FromAdmission(SchemaAdmission a) => new()
    {
        Site = new(a.Subscription, a.RecoveryKey, a.SiteRefresh, a.SitePageEditor, a.SiteConfigEditor, a.AppearanceActivation),
        AdminInbox = new(a.AdminInboxReply, a.AdminInboxStatus, a.AdminInboxNotice, a.AdminInboxRead),
        AdminContent = new(a.AdminTagMetadata, a.AdminCategoryMetadata, a.AdminArticleRollback),
        Comments = new(AdminBatch: a.AdminCommentBatch),
        Authoring = new(ArticleSummary: a.ArticleSummary, DocumentExports: a.DocumentExports),
        AuthorText = new(a.AuthorTextIndex),
        Media = new(ArticleMedia: true, PublicationMedia: a.PublicationMedia)
    };

    private static T Require<T>(T value, string name) => value ?? throw new ArgumentNullException(name);

    internal CoreCatalogOptions Core { get; init => field = Require(value, nameof(Core)); } = CoreCatalogOptions.Default;
    internal SiteCatalogOptions Site { get; init => field = Require(value, nameof(Site)); } = SiteCatalogOptions.Default;
    internal AdminInboxCatalogOptions AdminInbox { get; init => field = Require(value, nameof(AdminInbox)); } = AdminInboxCatalogOptions.Default;
    internal AdminContentCatalogOptions AdminContent { get; init => field = Require(value, nameof(AdminContent)); } = AdminContentCatalogOptions.Default;
    internal CommentCatalogOptions Comments { get; init => field = Require(value, nameof(Comments)); } = CommentCatalogOptions.Default;
    internal AuthoringCatalogOptions Authoring { get; init => field = Require(value, nameof(Authoring)); } = AuthoringCatalogOptions.Default;
    internal AuthorTextCatalogOptions AuthorText { get; init => field = Require(value, nameof(AuthorText)); } = AuthorTextCatalogOptions.Default;
    internal MediaCatalogOptions Media { get; init => field = Require(value, nameof(Media)); } = MediaCatalogOptions.Default;
    internal PublicationCatalogOptions Publication { get; init => field = Require(value, nameof(Publication)); } = PublicationCatalogOptions.Default;
}

internal sealed record CoreCatalogOptions(
    bool RecoveryScope = true, bool RevisionHistory = true, bool AdminIdentity = true,
    bool PublicationHistory = true, bool ArticleSchedule = true, bool MediaUpload = true,
    bool PublicationRights = true, bool CanvasHistory = true, bool LegacyCanvas = false)
{
    internal static readonly CoreCatalogOptions Default = new();
}

internal sealed record SiteCatalogOptions(
    bool? Subscription = null, bool? RecoveryKey = null, bool? Refresh = null,
    bool? PageEditor = null, bool? ConfigEditor = null, bool? AppearanceActivation = null)
{
    internal static readonly SiteCatalogOptions Default = new();
}

internal sealed record AdminInboxCatalogOptions(
    bool? Reply = null, bool? Status = null, bool? Notice = null, bool? Read = null)
{
    internal static readonly AdminInboxCatalogOptions Default = new();
}

internal sealed record AdminContentCatalogOptions(
    bool? TagMetadata = null, bool? CategoryMetadata = null,
    bool? ArticleRollback = null, bool? ArticleTrashRestore = null)
{
    internal static readonly AdminContentCatalogOptions Default = new();
}

internal sealed record CommentCatalogOptions(
    bool? RootPowPolicy = null, bool? AuthorEdit = null, bool? Report = null,
    bool? Appeal = null, bool? Replies = null, bool? AdminBatch = null)
{
    internal static readonly CommentCatalogOptions Default = new();
}

internal sealed record AuthoringCatalogOptions(
    bool? Workspace = null, bool? WorkspaceGroups = null, bool? SavedViews = null,
    bool? SavedViewPlacement = null, bool? RecentOpens = null, bool? ArticleSummary = null, bool? DocumentExports = null)
{
    internal static readonly AuthoringCatalogOptions Default = new();
}

internal sealed record AuthorTextCatalogOptions(
    bool? Index = null, bool SummaryIndex = false, bool HeadingIndex = false,
    bool PropertyIndex = false, bool Rebuild = false)
{
    internal static readonly AuthorTextCatalogOptions Default = new();
}

internal sealed record MediaCatalogOptions(
    bool? ArticleMedia = null, bool? ArticleCover = null, bool? PublicationMedia = null, bool? PublicationCover = null)
{
    internal static readonly MediaCatalogOptions Default = new();
}

internal sealed record PublicationCatalogOptions(
    bool? Canonical = null, bool? Proof = null, bool? Transparency = null,
    bool? Head = null, bool? ArticleRead = null, bool? ArticleReadTotal = null)
{
    internal static readonly PublicationCatalogOptions Default = new();
}
