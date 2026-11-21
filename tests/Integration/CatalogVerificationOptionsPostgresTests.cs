using System.Data;
using System.Reflection;
using FsusBlogV2.Storage;
using Npgsql;

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
        Assert.Equal(4, parameters.Length);
        Assert.Equal(typeof(NpgsqlConnection), parameters[0].ParameterType);
        Assert.Equal(typeof(NpgsqlTransaction), parameters[1].ParameterType);
        Assert.Equal(typeof(CancellationToken), parameters[2].ParameterType);
        Assert.Equal(typeof(CatalogVerificationOptions), parameters[3].ParameterType);
        Assert.True(parameters[3].HasDefaultValue);
        Assert.Null(parameters[3].DefaultValue);

        var options = new CatalogVerificationOptions();
        Assert.Equal(CatalogVerificationOptions.Default, options);

        // 9 core bool flags
        Assert.True(options.Core.RecoveryScope);
        Assert.True(options.Core.RevisionHistory);
        Assert.True(options.Core.AdminIdentity);
        Assert.True(options.Core.PublicationHistory);
        Assert.True(options.Core.ArticleSchedule);
        Assert.True(options.Core.MediaUpload);
        Assert.True(options.Core.PublicationRights);
        Assert.True(options.Core.CanvasHistory);
        Assert.False(options.Core.LegacyCanvas);

        // 5 site bool? flags
        Assert.Null(options.Site.Subscription);
        Assert.Null(options.Site.RecoveryKey);
        Assert.Null(options.Site.Refresh);
        Assert.Null(options.Site.PageEditor);
        Assert.Null(options.Site.AppearanceActivation);

        // 4 admin inbox bool? flags
        Assert.Null(options.AdminInbox.Reply);
        Assert.Null(options.AdminInbox.Status);
        Assert.Null(options.AdminInbox.Notice);
        Assert.Null(options.AdminInbox.Read);

        // 4 admin content bool? flags
        Assert.Null(options.AdminContent.TagMetadata);
        Assert.Null(options.AdminContent.CategoryMetadata);
        Assert.Null(options.AdminContent.ArticleRollback);
        Assert.Null(options.AdminContent.ArticleTrashRestore);

        // 6 comment bool? flags
        Assert.Null(options.Comments.RootPowPolicy);
        Assert.Null(options.Comments.AuthorEdit);
        Assert.Null(options.Comments.Report);
        Assert.Null(options.Comments.Appeal);
        Assert.Null(options.Comments.Replies);
        Assert.Null(options.Comments.AdminBatch);

        // 7 authoring bool? flags
        Assert.Null(options.Authoring.Workspace);
        Assert.Null(options.Authoring.WorkspaceGroups);
        Assert.Null(options.Authoring.SavedViews);
        Assert.Null(options.Authoring.SavedViewPlacement);
        Assert.Null(options.Authoring.RecentOpens);
        Assert.Null(options.Authoring.ArticleSummary);
        Assert.Null(options.Authoring.DocumentExports);

        // 1 bool? + 4 bool author-text flags
        Assert.Null(options.AuthorText.Index);
        Assert.False(options.AuthorText.SummaryIndex);
        Assert.False(options.AuthorText.HeadingIndex);
        Assert.False(options.AuthorText.PropertyIndex);
        Assert.False(options.AuthorText.Rebuild);

        // 4 media bool? flags
        Assert.Null(options.Media.ArticleMedia);
        Assert.Null(options.Media.ArticleCover);
        Assert.Null(options.Media.PublicationMedia);
        Assert.Null(options.Media.PublicationCover);

        // 6 publication/read bool? flags
        Assert.Null(options.Publication.Canonical);
        Assert.Null(options.Publication.Proof);
        Assert.Null(options.Publication.Transparency);
        Assert.Null(options.Publication.Head);
        Assert.Null(options.Publication.ArticleRead);
        Assert.Null(options.Publication.ArticleReadTotal);

        // Immutability & null-group guard
        var customized = options with { Media = options.Media with { ArticleMedia = true } };
        Assert.Null(options.Media.ArticleMedia);
        Assert.True(customized.Media.ArticleMedia);
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { Core = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { Site = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { AdminInbox = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { AdminContent = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { Comments = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { Authoring = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { AuthorText = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { Media = null! });
        Assert.Throws<ArgumentNullException>(() => new CatalogVerificationOptions { Publication = null! });
    }

    [Fact]
    public void FromAdmissionPreservesTriStateMappingForAllOnlineFields()
    {
        var defaultOnline = CatalogVerificationOptions.FromAdmission(default);
        Assert.True(defaultOnline.Media.ArticleMedia);
        Assert.Null(defaultOnline.Media.PublicationMedia);
        Assert.Null(defaultOnline.Site.Subscription);
        Assert.Null(defaultOnline.Authoring.ArticleSummary);
        Assert.Null(defaultOnline.Authoring.DocumentExports);
        Assert.Equal(CoreCatalogOptions.Default, defaultOnline.Core);

        var mixed = CatalogVerificationOptions.FromAdmission(new SchemaAdmission(
            Subscription: true,
            RecoveryKey: false,
            AdminInboxReply: true,
            SiteRefresh: false,
            SitePageEditor: true,
            AdminArticleRollback: false,
            AdminInboxStatus: true,
            AdminInboxNotice: false,
            AppearanceActivation: true,
            AdminTagMetadata: false,
            AdminInboxRead: true,
            PublicationMedia: false,
            AdminCommentBatch: true,
            AuthorTextIndex: false,
            ArticleSummary: true,
            DocumentExports: false,
            AdminCategoryMetadata: true));

        Assert.True(mixed.Media.ArticleMedia);
        Assert.Equal(true, mixed.Site.Subscription);
        Assert.Equal(false, mixed.Site.RecoveryKey);
        Assert.Equal(true, mixed.AdminInbox.Reply);
        Assert.Equal(false, mixed.Site.Refresh);
        Assert.Equal(true, mixed.Site.PageEditor);
        Assert.Equal(false, mixed.AdminContent.ArticleRollback);
        Assert.Equal(true, mixed.AdminInbox.Status);
        Assert.Equal(false, mixed.AdminInbox.Notice);
        Assert.Equal(true, mixed.Site.AppearanceActivation);
        Assert.Equal(false, mixed.AdminContent.TagMetadata);
        Assert.Equal(true, mixed.AdminInbox.Read);
        Assert.Equal(false, mixed.Media.PublicationMedia);
        Assert.Equal(true, mixed.Comments.AdminBatch);
        Assert.Equal(false, mixed.AuthorText.Index);
        Assert.Equal(true, mixed.Authoring.ArticleSummary);
        Assert.Equal(false, mixed.Authoring.DocumentExports);
        Assert.Equal(true, mixed.AdminContent.CategoryMetadata);

        // Unmapped optional fields remain auto-detected (null) / false
        Assert.Null(mixed.Media.ArticleCover);
        Assert.Null(mixed.Media.PublicationCover);
        Assert.Null(mixed.Comments.Report);
        Assert.Null(mixed.Comments.Appeal);
        Assert.Null(mixed.Publication.Canonical);
        Assert.False(mixed.AuthorText.Rebuild);
    }

    [PostgresFact]
    public async Task VerifyCatalogOptionsEnforceTrueFalseNullAutoDetectAndRejectPartialOrCorruptSchema()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);

        // 1. Complete schema: defaults, explicit true, and explicit false rejection
        Assert.False(await VerifyInReadOnlyTx(db, null, ct));
        Assert.False(await VerifyInReadOnlyTx(db, new CatalogVerificationOptions
        {
            Site = new() { Subscription = true, RecoveryKey = true, Refresh = true, PageEditor = true, AppearanceActivation = true },
            AdminInbox = new() { Reply = true, Status = true, Notice = true, Read = true },
            AdminContent = new() { TagMetadata = true, CategoryMetadata = true, ArticleRollback = true, ArticleTrashRestore = true },
            Comments = new() { RootPowPolicy = true, AuthorEdit = true, Report = true, Appeal = true, Replies = true, AdminBatch = true },
            Authoring = new() { Workspace = true, WorkspaceGroups = true, SavedViews = true, SavedViewPlacement = true, RecentOpens = true, ArticleSummary = true, DocumentExports = true },
            AuthorText = new() { Index = true, SummaryIndex = true, HeadingIndex = true, PropertyIndex = true, Rebuild = true },
            Media = new() { ArticleMedia = true, ArticleCover = true, PublicationMedia = true, PublicationCover = true },
            Publication = new() { Canonical = true, Proof = true, Transparency = true, Head = true, ArticleRead = true, ArticleReadTotal = true }
        }, ct));

        var forbiddenReport = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VerifyInReadOnlyTx(db, new CatalogVerificationOptions { Comments = new() { Report = false } }, ct));
        Assert.Contains("Comment report schema presence", forbiddenReport.Message, StringComparison.Ordinal);

        var forbiddenRecoveryKey = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VerifyInReadOnlyTx(db, new CatalogVerificationOptions { Site = new() { RecoveryKey = false } }, ct));
        Assert.Contains("Recovery Key schema presence", forbiddenRecoveryKey.Message, StringComparison.Ordinal);

        var forbiddenHead = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VerifyInReadOnlyTx(db, new CatalogVerificationOptions { Publication = new() { Head = false } }, ct));
        Assert.Contains("publication head schema presence", forbiddenHead.Message, StringComparison.Ordinal);

        var coreScopeConflict = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VerifyInReadOnlyTx(db, new CatalogVerificationOptions { Core = new() { RecoveryScope = false } }, ct));
        Assert.Contains("author recent opens schema presence", coreScopeConflict.Message, StringComparison.Ordinal);

        // 2. Half-installed optional relation group must be rejected under null, true, AND false
        await Execute(db, "ALTER TABLE public.comment_appeal_event RENAME TO incomplete_comment_appeal_event", ct);
        foreach (var appealOption in new bool?[] { null, true, false })
        {
            var partial = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                VerifyInReadOnlyTx(db, new CatalogVerificationOptions { Comments = new() { Appeal = appealOption } }, ct));
            Assert.Contains("Comment appeal storage is incomplete", partial.Message, StringComparison.Ordinal);
        }
        await Execute(db, "ALTER TABLE public.incomplete_comment_appeal_event RENAME TO comment_appeal_event", ct);

        // 3. Corrupted index and CHECK constraint must still be rejected with default options
        await Execute(db, "ALTER INDEX public.author_text_article_owner RENAME TO broken_author_text_article_owner", ct);
        var missingIndex = await Assert.ThrowsAsync<InvalidOperationException>(() => VerifyInReadOnlyTx(db, null, ct));
        Assert.Contains("author full-text index", missingIndex.Message, StringComparison.OrdinalIgnoreCase);
        await Execute(db, "ALTER INDEX public.broken_author_text_article_owner RENAME TO author_text_article_owner", ct);

        await Execute(db, """
            ALTER TABLE public.comment_report
                DROP CONSTRAINT comment_report_publication_id_check,
                ADD CHECK (publication_id >= 0)
            """, ct);
        var wrongCheck = await Assert.ThrowsAsync<InvalidOperationException>(() => VerifyInReadOnlyTx(db, null, ct));
        Assert.Contains("comment_report c publication_id publication_id>0", wrongCheck.Message, StringComparison.Ordinal);
        await Execute(db, """
            ALTER TABLE public.comment_report
                DROP CONSTRAINT comment_report_publication_id_check,
                ADD CHECK (publication_id > 0)
            """, ct);

        // 4. Allowed optional absence: null auto-detect and explicit false pass, explicit true fails
        await Execute(db, "DROP TABLE public.comment_report, public.author_text_rebuild_job", ct);
        Assert.False(await VerifyInReadOnlyTx(db, null, ct));
        Assert.False(await VerifyInReadOnlyTx(db, new CatalogVerificationOptions
        {
            Comments = new() { Report = false },
            AuthorText = new() { Index = true, SummaryIndex = true, HeadingIndex = true, PropertyIndex = true, Rebuild = false }
        }, ct));

        var missingReport = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VerifyInReadOnlyTx(db, new CatalogVerificationOptions { Comments = new() { Report = true } }, ct));
        Assert.Contains("Comment report schema presence", missingReport.Message, StringComparison.Ordinal);

        var missingRebuild = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VerifyInReadOnlyTx(db, new CatalogVerificationOptions { AuthorText = new() { Rebuild = true } }, ct));
        Assert.Contains("autonomous indexing", missingRebuild.Message, StringComparison.Ordinal);

        // 5. Core boolean toggle (RecoveryScope = false) when recovery scope & dependent recent opens are absent
        await Execute(db, """
            DROP TABLE public.author_recent_open_receipt, public.author_recent_open,
                public.author_recent_open_collection, public.authoring_recovery_site
            """, ct);
        var missingRecoveryScope = await Assert.ThrowsAsync<InvalidOperationException>(() => VerifyInReadOnlyTx(db, null, ct));
        Assert.Contains("authoring_recovery_site", missingRecoveryScope.Message, StringComparison.Ordinal);
        Assert.False(await VerifyInReadOnlyTx(db, new CatalogVerificationOptions
        {
            Core = new() { RecoveryScope = false },
            Authoring = new() { RecentOpens = false }
        }, ct));
    }

    private static async Task<bool> VerifyInReadOnlyTx(NpgsqlConnection db, CatalogVerificationOptions? options, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await using (var protect = new NpgsqlCommand("SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", db, tx))
            await protect.ExecuteNonQueryAsync(ct);
        var webp = await CurrentSchema.VerifyCatalogAsync(db, tx, ct, options);
        await tx.CommitAsync(ct);
        return webp;
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(sql, db);
        await command.ExecuteNonQueryAsync(ct);
    }
}
