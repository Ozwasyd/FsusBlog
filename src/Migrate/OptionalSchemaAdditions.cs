using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private delegate Task<bool> SchemaCheck(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct);
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

    private static Task InitializeAdminCategoryMetadataAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "taxonomy_category_metadata.sql", "Verified the administrator category metadata schema.",
            CurrentSchema.HasAdminCategoryMetadataAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true,
                requireAdminTagMetadata: true, requireAdminCategoryMetadata: exists));

    private static Task InitializeAppearanceActivationAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "appearance-activation.sql", "Verified the optional signed appearance activation schema.",
            CurrentSchema.HasAppearanceActivationAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAppearanceActivation: exists));

    private static Task InitializeRootCommentPowPolicyAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "root-comment-pow-policy.sql", "Verified the root comment proof policy schema.",
            CurrentSchema.HasRootCommentPowPolicyAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireRootCommentPowPolicy: exists));

    private static Task InitializeAdminArticleTrashRestoreAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "publication-trash-restore-admin.sql", "Verified administrator trash restoration schema.",
            CurrentSchema.HasAdminArticleTrashRestoreAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminArticleTrashRestore: exists));

    private static Task InitializeAdminInboxReadAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeMissingSchemaAsync(connection, token, CurrentSchema.AdminInboxReadRelation,
            "inbox-admin-read.sql", "Verified shared administrator inbox read schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxRead: exists));

    private static Task InitializeAdminInboxNoticeAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeMissingSchemaAsync(connection, token, CurrentSchema.AdminInboxNoticeRelation,
            "inbox-admin-notice.sql", "Verified administrator inbox notice attribution schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxNotice: exists));

    private static Task InitializeAdminInboxRepliesAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeMissingSchemaAsync(connection, token, CurrentSchema.AdminInboxReplyRelation,
            "inbox-admin-replies.sql", "Verified administrator inbox reply attribution schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxReply: exists));

    private static Task InitializeAdminInboxStatusAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeMissingSchemaAsync(connection, token, CurrentSchema.AdminInboxStatusRelation,
            "inbox-admin-status.sql", "Verified administrator inbox status audit schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAdminInboxStatus: exists));

    private static Task InitializeAuthorRecentOpensAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "author-recent-opens.sql", "Verified the author recent opens schema.",
            CurrentSchema.HasAuthorRecentOpensAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireAuthorRecentOpens: exists),
            requiresRecoverySite: true, verifyWhenInstalled: true);

    private static Task InitializeCommentReportAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "zzzz-comment-report.sql", "Verified signed-in comment report schema.",
            CurrentSchema.HasCommentReportSchemaAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentReport: exists),
            requiresAdminIdentity: false);

    private static Task InitializeArticleMediaAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeMissingSchemaAsync(connection, token, CurrentSchema.ArticleMediaRelation,
            "private-media-references.sql", "Verified private article attachment schema.",
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: exists),
            requiresAdminIdentity: false);

    private static Task InitializePublicationCoverAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "zzzz-publication-cover.sql", "Verified the public article cover schema.",
            CurrentSchema.HasPublicationCoverAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true,
                requirePublicationCanonical: true, requirePublicationMedia: true, requireArticleCover: true, requirePublicationCover: exists),
            verifyWhenInstalled: true, requiresAdminIdentity: false);

    private static Task InitializeArticleCoverAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeOptionalSchemaAsync(connection, token, "zzzz-article-cover.sql", "Verified the saved article cover schema.",
            CurrentSchema.HasArticleCoverAsync,
            (db, tx, exists, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireArticleCover: exists),
            verifyWhenInstalled: true, requiresAdminIdentity: false);

    private static Task InitializePropertySnapshotsAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeRecoverySchemaAsync(connection, token, "property-snapshots.sql",
            "Verified the private article property snapshot schema.", CurrentSchema.HasPropertySnapshotsAsync);

    private static Task InitializeSitePasskeyNamesAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeRecoverySchemaAsync(connection, token, "site-passkey-name.sql",
            "Verified the private site Passkey name schema.", CurrentSchema.HasSitePasskeyNamesAsync);

    private static Task InitializeCommentAppealAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeCommentDependentSchemaAsync(connection, token, "zzz-comment-appeal.sql", "Verified signed-in comment appeal schema.",
            CurrentSchema.HasCommentAppealSchemaAsync,
            (db, tx, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentAppeal: true),
            "Install comment author-delete-schema before comment appeal-schema.");

    private static Task InitializeCommentReplyAsync(NpgsqlConnection connection, CancellationToken token) =>
        InitializeCommentDependentSchemaAsync(connection, token, "zzzz-comment-reply.sql",
            "Verified signed-in comment reply notice schema.", CurrentSchema.HasCommentReplySchemaAsync,
            (db, tx, ct) => CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentReplies: true),
            "Install comment author-delete-schema before comment replies-schema.");

    private static async Task InitializeOptionalSchemaAsync(NpgsqlConnection db, CancellationToken ct,
        string script, string success, SchemaCheck probe, OptionalSchemaCatalog verifyCatalog,
        bool requiresRecoverySite = false, bool verifyWhenInstalled = false, bool requiresAdminIdentity = true)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(db, ct);
        var exists = await probe(db, tx, ct);
        await verifyCatalog(db, tx, exists, ct);
        if (requiresAdminIdentity) await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (requiresRecoverySite) await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!exists) await ApplySchemaAddition(db, tx, script, ct);
        if (!exists || verifyWhenInstalled) await verifyCatalog(db, tx, true, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(success);
    }

    private static async Task InitializeMissingSchemaAsync(NpgsqlConnection db, CancellationToken ct,
        string relation, string script, string success, OptionalSchemaCatalog verifyCatalog, bool requiresAdminIdentity = true)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(db, ct);
        if (!await HasRelation(db, tx, relation, ct))
        {
            await verifyCatalog(db, tx, false, ct);
            await ApplySchemaAddition(db, tx, script, ct);
        }
        await verifyCatalog(db, tx, true, ct);
        if (requiresAdminIdentity) await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(success);
    }

    private static async Task InitializeRecoverySchemaAsync(NpgsqlConnection db, CancellationToken ct,
        string script, string success, SchemaCheck probe)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(db, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!await probe(db, tx, ct)) await ApplySchemaAddition(db, tx, script, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(success);
    }

    private static async Task InitializeCommentDependentSchemaAsync(NpgsqlConnection db, CancellationToken ct,
        string script, string success, SchemaCheck probe, SchemaCheck verifyCatalog, string missingDependency)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(db, ct);
        if (!await probe(db, tx, ct))
        {
            if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct))
                throw new InvalidOperationException(missingDependency);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
            await ApplySchemaAddition(db, tx, script, ct);
        }
        await verifyCatalog(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(success);
    }
}
