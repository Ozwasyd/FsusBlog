using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private delegate Task<bool> OptionalSchemaExists(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct);
    private delegate Task<bool> OptionalSchemaCatalog(NpgsqlConnection db, NpgsqlTransaction tx, bool exists, CancellationToken ct);

    private static Task InitializeSiteSubscriptionAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "site-subscription.sql", "Verified the optional site subscription schema.",
            (db, tx, ct) => HasRelation(db, tx, CurrentSchema.SiteSubscriptionRelation, ct),
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireSubscription: exists),
            requiresRecoverySite: true);

    private static Task InitializeSitePageEditorAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "site-page-editor.sql", "Verified the optional site page editor schema.",
            CurrentSchema.HasSitePageEditorSchemaAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireSitePageEditor: exists),
            requiresRecoverySite: true);

    private static Task InitializeSiteRefreshAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "site-session-refresh.sql", "Verified the optional site refresh schema.",
            CurrentSchema.HasSiteRefreshSchemaAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireSiteRefresh: exists),
            requiresRecoverySite: true);

    private static Task InitializeSiteRecoveryKeyAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "site-recovery-key.sql", "Verified the site Recovery Key schema.",
            CurrentSchema.HasSiteRecoveryKeySchemaAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireRecoveryKey: exists),
            requiresRecoverySite: true);

    private static Task InitializeAuthorSummaryAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "author-summary.sql", "Verified the article author summary schema.",
            CurrentSchema.HasArticleSummaryAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireArticleSummary: exists),
            requiresRecoverySite: true);

    private static Task InitializeAdminTagMetadataAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "taxonomy_tag_metadata.sql", "Verified the administrator tag metadata schema.",
            CurrentSchema.HasAdminTagMetadataAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireAdminTagMetadata: exists));

    private static Task InitializeAppearanceActivationAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "appearance-activation.sql", "Verified the optional signed appearance activation schema.",
            CurrentSchema.HasAppearanceActivationAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAppearanceActivation: exists));

    private static Task InitializeRootCommentPowPolicyAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "root-comment-pow-policy.sql", "Verified the root comment proof policy schema.",
            CurrentSchema.HasRootCommentPowPolicyAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireRootCommentPowPolicy: exists));

    private static Task InitializeAdminInboxReadAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeAdminInboxSchemaAsync(connection, token, CurrentSchema.AdminInboxReadRelation,
            "inbox-admin-read.sql", "Verified shared administrator inbox read schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxRead: exists));

    private static Task InitializeAdminInboxNoticeAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeAdminInboxSchemaAsync(connection, token, CurrentSchema.AdminInboxNoticeRelation,
            "inbox-admin-notice.sql", "Verified administrator inbox notice attribution schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxNotice: exists));

    private static Task InitializeAdminInboxRepliesAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeAdminInboxSchemaAsync(connection, token, CurrentSchema.AdminInboxReplyRelation,
            "inbox-admin-replies.sql", "Verified administrator inbox reply attribution schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxReply: exists));

    private static Task InitializeAdminInboxStatusAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeAdminInboxSchemaAsync(connection, token, CurrentSchema.AdminInboxStatusRelation,
            "inbox-admin-status.sql", "Verified administrator inbox status audit schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxStatus: exists));

    private static async Task InitializeOptionalSchemaAsync(NpgsqlConnection db, CancellationToken ct,
        string script, string success, OptionalSchemaExists probe, OptionalSchemaCatalog verifyCatalog,
        bool requiresRecoverySite = false)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await probe(db, tx, ct);
        await verifyCatalog(db, tx, exists, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (requiresRecoverySite) await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(db, tx, script, ct);
            await verifyCatalog(db, tx, true, ct);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine(success);
    }

    private static async Task InitializeAdminInboxSchemaAsync(NpgsqlConnection db, CancellationToken ct,
        string relation, string script, string success, OptionalSchemaCatalog verifyCatalog)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        if (!await HasRelation(db, tx, relation, ct))
        {
            await verifyCatalog(db, tx, false, ct);
            await ApplySchemaAddition(db, tx, script, ct);
        }
        await verifyCatalog(db, tx, true, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(success);
    }
}
