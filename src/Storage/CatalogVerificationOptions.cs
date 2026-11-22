namespace FsusBlogV2.Storage;

// Grouped immutable configuration for CurrentSchema.VerifyCatalogAsync.
// For nullable bool? fields: null auto-detects presence in pg_catalog, true requires presence,
// and false requires absence (or omits auto-detected single-table legacy checks where applicable).
internal sealed record CatalogVerificationOptions
{
    internal static readonly CatalogVerificationOptions Default = new();

    internal static CatalogVerificationOptions FromAdmission(SchemaAdmission admission) => new()
    {
        Site = new()
        {
            Subscription = admission.Subscription,
            RecoveryKey = admission.RecoveryKey,
            Refresh = admission.SiteRefresh,
            PageEditor = admission.SitePageEditor,
            ConfigEditor = admission.SiteConfigEditor,
            AppearanceActivation = admission.AppearanceActivation
        },
        AdminInbox = new()
        {
            Reply = admission.AdminInboxReply,
            Status = admission.AdminInboxStatus,
            Notice = admission.AdminInboxNotice,
            Read = admission.AdminInboxRead
        },
        AdminContent = new()
        {
            TagMetadata = admission.AdminTagMetadata,
            CategoryMetadata = admission.AdminCategoryMetadata,
            ArticleRollback = admission.AdminArticleRollback
        },
        Comments = new()
        {
            AdminBatch = admission.AdminCommentBatch
        },
        Authoring = new()
        {
            ArticleSummary = admission.ArticleSummary,
            DocumentExports = admission.DocumentExports
        },
        AuthorText = new()
        {
            Index = admission.AuthorTextIndex
        },
        Media = new()
        {
            ArticleMedia = true,
            PublicationMedia = admission.PublicationMedia
        }
    };

    internal CoreCatalogOptions Core
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(Core));
    } = CoreCatalogOptions.Default;

    internal SiteCatalogOptions Site
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(Site));
    } = SiteCatalogOptions.Default;

    internal AdminInboxCatalogOptions AdminInbox
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(AdminInbox));
    } = AdminInboxCatalogOptions.Default;

    internal AdminContentCatalogOptions AdminContent
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(AdminContent));
    } = AdminContentCatalogOptions.Default;

    internal CommentCatalogOptions Comments
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(Comments));
    } = CommentCatalogOptions.Default;

    internal AuthoringCatalogOptions Authoring
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(Authoring));
    } = AuthoringCatalogOptions.Default;

    internal AuthorTextCatalogOptions AuthorText
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(AuthorText));
    } = AuthorTextCatalogOptions.Default;

    internal MediaCatalogOptions Media
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(Media));
    } = MediaCatalogOptions.Default;

    internal PublicationCatalogOptions Publication
    {
        get;
        init => field = value ?? throw new ArgumentNullException(nameof(Publication));
    } = PublicationCatalogOptions.Default;
}

internal sealed record CoreCatalogOptions
{
    internal static readonly CoreCatalogOptions Default = new();

    internal bool RecoveryScope { get; init; } = true;
    internal bool RevisionHistory { get; init; } = true;
    internal bool AdminIdentity { get; init; } = true;
    internal bool PublicationHistory { get; init; } = true;
    internal bool ArticleSchedule { get; init; } = true;
    internal bool MediaUpload { get; init; } = true;
    internal bool PublicationRights { get; init; } = true;
    internal bool CanvasHistory { get; init; } = true;
    internal bool LegacyCanvas { get; init; }
}

internal sealed record SiteCatalogOptions
{
    internal static readonly SiteCatalogOptions Default = new();

    internal bool? Subscription { get; init; }
    internal bool? RecoveryKey { get; init; }
    internal bool? Refresh { get; init; }
    internal bool? PageEditor { get; init; }
    internal bool? ConfigEditor { get; init; }
    internal bool? AppearanceActivation { get; init; }
}

internal sealed record AdminInboxCatalogOptions
{
    internal static readonly AdminInboxCatalogOptions Default = new();

    internal bool? Reply { get; init; }
    internal bool? Status { get; init; }
    internal bool? Notice { get; init; }
    internal bool? Read { get; init; }
}

internal sealed record AdminContentCatalogOptions
{
    internal static readonly AdminContentCatalogOptions Default = new();

    internal bool? TagMetadata { get; init; }
    internal bool? CategoryMetadata { get; init; }
    internal bool? ArticleRollback { get; init; }
    internal bool? ArticleTrashRestore { get; init; }
}

internal sealed record CommentCatalogOptions
{
    internal static readonly CommentCatalogOptions Default = new();

    internal bool? RootPowPolicy { get; init; }
    internal bool? AuthorEdit { get; init; }
    internal bool? Report { get; init; }
    internal bool? Appeal { get; init; }
    internal bool? Replies { get; init; }
    internal bool? AdminBatch { get; init; }
}

internal sealed record AuthoringCatalogOptions
{
    internal static readonly AuthoringCatalogOptions Default = new();

    internal bool? Workspace { get; init; }
    internal bool? WorkspaceGroups { get; init; }
    internal bool? SavedViews { get; init; }
    internal bool? SavedViewPlacement { get; init; }
    internal bool? RecentOpens { get; init; }
    internal bool? ArticleSummary { get; init; }
    internal bool? DocumentExports { get; init; }
}

internal sealed record AuthorTextCatalogOptions
{
    internal static readonly AuthorTextCatalogOptions Default = new();

    internal bool? Index { get; init; }
    internal bool SummaryIndex { get; init; }
    internal bool HeadingIndex { get; init; }
    internal bool PropertyIndex { get; init; }
    internal bool Rebuild { get; init; }
}

internal sealed record MediaCatalogOptions
{
    internal static readonly MediaCatalogOptions Default = new();

    internal bool? ArticleMedia { get; init; }
    internal bool? ArticleCover { get; init; }
    internal bool? PublicationMedia { get; init; }
    internal bool? PublicationCover { get; init; }
}

internal sealed record PublicationCatalogOptions
{
    internal static readonly PublicationCatalogOptions Default = new();

    internal bool? Canonical { get; init; }
    internal bool? Proof { get; init; }
    internal bool? Transparency { get; init; }
    internal bool? Head { get; init; }
    internal bool? ArticleRead { get; init; }
    internal bool? ArticleReadTotal { get; init; }
}
