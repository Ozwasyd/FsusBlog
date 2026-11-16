namespace FsusBlogV2.Storage;

// Null leaves an option unspecified; explicit requirements pass unchanged to catalog verification.
internal readonly record struct SchemaAdmission(
    bool? Subscription = null,
    bool? RecoveryKey = null,
    bool? AdminInboxReply = null,
    bool? SiteRefresh = null,
    bool? SitePageEditor = null,
    bool? AdminArticleRollback = null,
    bool? AdminInboxStatus = null,
    bool? AdminInboxNotice = null,
    bool? AppearanceActivation = null,
    bool? AdminTagMetadata = null,
    bool? AdminInboxRead = null,
    bool? PublicationMedia = null,
    bool? AdminCommentBatch = null,
    bool? AuthorTextIndex = null,
    bool? ArticleSummary = null,
    bool? DocumentExports = null,
    bool? AdminCategoryMetadata = null);
