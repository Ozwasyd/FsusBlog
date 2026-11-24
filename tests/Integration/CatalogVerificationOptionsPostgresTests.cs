using System.Data;
using System.Reflection;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CatalogVerificationOptionsPostgresTests
{
    [Fact]
    public void DefaultOptionsPreserveEveryLegacyParameterDefaultAndSignature()
    {
        var method = typeof(CurrentSchema).GetMethod(
            nameof(CurrentSchema.VerifyCatalogAsync),
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var parameters = method!.GetParameters();
        Assert.Equal([typeof(NpgsqlConnection), typeof(NpgsqlTransaction), typeof(CancellationToken), typeof(CatalogVerificationOptions)],
            parameters.Select(p => p.ParameterType).ToArray());
        Assert.True(parameters[3].HasDefaultValue);
        Assert.Null(parameters[3].DefaultValue);

        var options = new CatalogVerificationOptions();
        Assert.Equal(CatalogVerificationOptions.Default, options);

        // 9 core bool flags
        Assert.All(new[]
        {
            options.Core.RecoveryScope, options.Core.RevisionHistory, options.Core.AdminIdentity,
            options.Core.PublicationHistory, options.Core.ArticleSchedule, options.Core.MediaUpload,
            options.Core.PublicationRights, options.Core.CanvasHistory
        }, Assert.True);
        Assert.False(options.Core.LegacyCanvas);

        // 37 optional bool? flags default to null (auto-detect)
        Assert.All(new bool?[]
        {
            options.Site.Subscription, options.Site.RecoveryKey, options.Site.Refresh,
            options.Site.PageEditor, options.Site.AppearanceActivation,
            options.AdminInbox.Reply, options.AdminInbox.Status, options.AdminInbox.Notice, options.AdminInbox.Read,
            options.AdminContent.TagMetadata, options.AdminContent.CategoryMetadata,
            options.AdminContent.ArticleRollback, options.AdminContent.ArticleTrashRestore,
            options.Comments.RootPowPolicy, options.Comments.AuthorEdit, options.Comments.Report,
            options.Comments.Appeal, options.Comments.Replies, options.Comments.AdminBatch,
            options.Authoring.Workspace, options.Authoring.WorkspaceGroups, options.Authoring.SavedViews,
            options.Authoring.SavedViewPlacement, options.Authoring.RecentOpens,
            options.Authoring.ArticleSummary, options.Authoring.DocumentExports,
            options.AuthorText.Index,
            options.Media.ArticleMedia, options.Media.ArticleCover,
            options.Media.PublicationMedia, options.Media.PublicationCover,
            options.Publication.Canonical, options.Publication.Proof, options.Publication.Transparency,
            options.Publication.Head, options.Publication.ArticleRead, options.Publication.ArticleReadTotal
        }, Assert.Null);
        Assert.All(new[]
        {
            options.AuthorText.SummaryIndex, options.AuthorText.HeadingIndex,
            options.AuthorText.PropertyIndex, options.AuthorText.Rebuild
        }, Assert.False);

        // Immutability & null-group guard
        var customized = options with { Media = options.Media with { ArticleMedia = true } };
        Assert.Null(options.Media.ArticleMedia);
        Assert.True(customized.Media.ArticleMedia);
        foreach (Action invalid in new Action[]
        {
            () => _ = new CatalogVerificationOptions { Core = null! },
            () => _ = new CatalogVerificationOptions { Site = null! },
            () => _ = new CatalogVerificationOptions { AdminInbox = null! },
            () => _ = new CatalogVerificationOptions { AdminContent = null! },
            () => _ = new CatalogVerificationOptions { Comments = null! },
            () => _ = new CatalogVerificationOptions { Authoring = null! },
            () => _ = new CatalogVerificationOptions { AuthorText = null! },
            () => _ = new CatalogVerificationOptions { Media = null! },
            () => _ = new CatalogVerificationOptions { Publication = null! }
        })
            Assert.Throws<ArgumentNullException>(invalid);
    }

    [Fact]
    public void FromAdmissionPreservesTriStateMappingForAllOnlineFields()
    {
        var defaultOnline = CatalogVerificationOptions.FromAdmission(default);
        Assert.True(defaultOnline.Media.ArticleMedia);
        Assert.All(new bool?[]
        {
            defaultOnline.Media.PublicationMedia, defaultOnline.Site.Subscription,
            defaultOnline.Authoring.ArticleSummary, defaultOnline.Authoring.DocumentExports
        }, Assert.Null);
        Assert.Equal(CoreCatalogOptions.Default, defaultOnline.Core);

        var mixed = CatalogVerificationOptions.FromAdmission(new SchemaAdmission(
            Subscription: true, RecoveryKey: false, AdminInboxReply: true, SiteRefresh: false,
            SitePageEditor: true, SiteConfigEditor: true, AdminArticleRollback: false, AdminInboxStatus: true,
            AdminInboxNotice: false, AppearanceActivation: true, AdminTagMetadata: false, AdminInboxRead: true,
            PublicationMedia: false, AdminCommentBatch: true, AuthorTextIndex: false, ArticleSummary: true,
            DocumentExports: false, AdminCategoryMetadata: true));

        Assert.All(new bool?[]
        {
            mixed.Media.ArticleMedia, mixed.Site.Subscription, mixed.AdminInbox.Reply, mixed.Site.PageEditor,
            mixed.Site.ConfigEditor, mixed.AdminInbox.Status, mixed.Site.AppearanceActivation, mixed.AdminInbox.Read,
            mixed.Comments.AdminBatch, mixed.Authoring.ArticleSummary, mixed.AdminContent.CategoryMetadata
        }, value => Assert.Equal(true, value));
        Assert.All(new bool?[]
        {
            mixed.Site.RecoveryKey, mixed.Site.Refresh, mixed.AdminContent.ArticleRollback,
            mixed.AdminInbox.Notice, mixed.AdminContent.TagMetadata, mixed.Media.PublicationMedia,
            mixed.AuthorText.Index, mixed.Authoring.DocumentExports
        }, value => Assert.Equal(false, value));
        Assert.All(new bool?[]
        {
            mixed.Media.ArticleCover, mixed.Media.PublicationCover, mixed.Comments.Report,
            mixed.Comments.Appeal, mixed.Publication.Canonical
        }, Assert.Null);
        Assert.False(mixed.AuthorText.Rebuild);
    }

    [PostgresFact]
    public async Task VerifyCatalogOptionsEnforceTrueFalseNullAutoDetectAndRejectPartialOrCorruptSchema()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);

        async Task ExpectInvalid(string message, CatalogVerificationOptions? options = null,
            StringComparison comparison = StringComparison.Ordinal) =>
            Assert.Contains(message, (await Assert.ThrowsAsync<InvalidOperationException>(() => VerifyInReadOnlyTx(db, options, ct))).Message, comparison);

        // 1. Complete schema: defaults, explicit true, and explicit false rejection
        Assert.False(await VerifyInReadOnlyTx(db, null, ct));
        Assert.False(await VerifyInReadOnlyTx(db, new CatalogVerificationOptions
        {
            Site = new() { Subscription = true, RecoveryKey = true, Refresh = true, PageEditor = true, ConfigEditor = true, AppearanceActivation = true },
            AdminInbox = new() { Reply = true, Status = true, Notice = true, Read = true },
            AdminContent = new() { TagMetadata = true, CategoryMetadata = true, ArticleRollback = true, ArticleTrashRestore = true },
            Comments = new() { RootPowPolicy = true, AuthorEdit = true, Report = true, Appeal = true, Replies = true, AdminBatch = true },
            Authoring = new() { Workspace = true, WorkspaceGroups = true, SavedViews = true, SavedViewPlacement = true, RecentOpens = true, ArticleSummary = true, DocumentExports = true },
            AuthorText = new() { Index = true, SummaryIndex = true, HeadingIndex = true, PropertyIndex = true, Rebuild = true },
            Media = new() { ArticleMedia = true, ArticleCover = true, PublicationMedia = true, PublicationCover = true },
            Publication = new() { Canonical = true, Proof = true, Transparency = true, Head = true, ArticleRead = true, ArticleReadTotal = true }
        }, ct));

        await ExpectInvalid("Comment report schema presence", new() { Comments = new() { Report = false } });
        await ExpectInvalid("Recovery Key schema presence", new() { Site = new() { RecoveryKey = false } });
        await ExpectInvalid("publication head schema presence", new() { Publication = new() { Head = false } });
        await ExpectInvalid("author recent opens schema presence", new() { Core = new() { RecoveryScope = false } });

        // 2. Half-installed optional relation group must be rejected under null, true, AND false
        await FixtureSql.ExecuteAsync(db, null, ct, "ALTER TABLE public.comment_appeal_event RENAME TO incomplete_comment_appeal_event");
        foreach (var appealOption in new bool?[] { null, true, false })
            await ExpectInvalid("Comment appeal storage is incomplete", new() { Comments = new() { Appeal = appealOption } });
        await FixtureSql.ExecuteAsync(db, null, ct, "ALTER TABLE public.incomplete_comment_appeal_event RENAME TO comment_appeal_event");

        // 3. Corrupted index and CHECK constraint must still be rejected with default options
        await FixtureSql.ExecuteAsync(db, null, ct, "ALTER INDEX public.author_text_article_owner RENAME TO broken_author_text_article_owner");
        await ExpectInvalid("author full-text index", comparison: StringComparison.OrdinalIgnoreCase);
        await FixtureSql.ExecuteAsync(db, null, ct, "ALTER INDEX public.broken_author_text_article_owner RENAME TO author_text_article_owner");

        await FixtureSql.ExecuteAsync(db, null, ct, """
            ALTER TABLE public.comment_report DROP CONSTRAINT comment_report_publication_id_check, ADD CHECK (publication_id >= 0)
            """);
        await ExpectInvalid("comment_report c publication_id publication_id>0");
        await FixtureSql.ExecuteAsync(db, null, ct, """
            ALTER TABLE public.comment_report DROP CONSTRAINT comment_report_publication_id_check, ADD CHECK (publication_id > 0)
            """);

        // 4. Allowed optional absence: null auto-detect and explicit false pass, explicit true fails
        await FixtureSql.ExecuteAsync(db, null, ct, "DROP TABLE public.comment_report, public.author_text_rebuild_job");
        Assert.False(await VerifyInReadOnlyTx(db, null, ct));
        Assert.False(await VerifyInReadOnlyTx(db, new CatalogVerificationOptions
        {
            Comments = new() { Report = false },
            AuthorText = new() { Index = true, SummaryIndex = true, HeadingIndex = true, PropertyIndex = true, Rebuild = false }
        }, ct));

        await ExpectInvalid("Comment report schema presence", new() { Comments = new() { Report = true } });
        await ExpectInvalid("autonomous indexing", new() { AuthorText = new() { Rebuild = true } });

        // 5. Core boolean toggle (RecoveryScope = false) when recovery scope & dependent recent opens are absent
        await FixtureSql.ExecuteAsync(db, null, ct, """
            DROP TABLE public.author_recent_open_receipt, public.author_recent_open,
                public.author_recent_open_collection, public.authoring_recovery_site
            """);
        await ExpectInvalid("authoring_recovery_site");
        Assert.False(await VerifyInReadOnlyTx(db, new CatalogVerificationOptions
        {
            Core = new() { RecoveryScope = false },
            Authoring = new() { RecentOpens = false }
        }, ct));
    }

    private static async Task<bool> VerifyInReadOnlyTx(NpgsqlConnection db, CatalogVerificationOptions? options, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await FixtureSql.ExecuteAsync(db, tx, ct, "SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog");
        var webp = await CurrentSchema.VerifyCatalogAsync(db, tx, ct, options);
        await tx.CommitAsync(ct);
        return webp;
    }
}
