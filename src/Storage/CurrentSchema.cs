using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const int Version = 1;

    private static readonly string[] Columns =
    [
        "v2_schema singleton:bool version:int4",
        "blog_user id:uuid name:text enabled:bool generation:int8",
        "admin_principal id:uuid handle:text user_handle:bytea enabled:bool generation:int8 generation_changed_at:timestamptz=clock_timestamp",
        "login_ticket digest:bytea user_id:uuid expires_at:timestamptz",
        "user_session digest:bytea user_id:uuid generation:int8 expires_at:timestamptz passkey_credential_id:bytea? totp_verified_at:timestamptz?",
        "article id:int4:a owner_id:uuid revision:int8 title:text body:text published_revision:int8? publication_count:int4=0 deleted:bool created_at:timestamptz=now updated_at:timestamptz=now",
        ArticleRevisionColumns,
        "article_command actor_id:uuid command_id:uuid fingerprint:bytea article_id:int4 revision:int8 title:text body:text published:bool",
        "article_publication article_id:int4 publication_id:int8:d revision:int8 publication_no:int4=1 published_at:timestamptz",
        "blog_outbox id:int8:a article_id:int4 revision:int8 kind:text created_at:timestamptz=now processed_at:timestamptz?"
    ];

    private static readonly string[] Constraints =
    [
        "v2_schema p singleton",
        "v2_schema c singleton singleton",
        "blog_user p id",
        "blog_user u name",
        "blog_user c generation generation>0",
        "admin_principal p id",
        "admin_principal u handle",
        "admin_principal c handle handle~'^[a-z][a-z0-9_.-]{0,63}$'::text",
        "admin_principal u user_handle",
        "admin_principal c user_handle octet_length(user_handle)=32",
        "admin_principal c generation generation>0",
        "login_ticket p digest",
        "login_ticket c digest octet_length(digest)=32",
        "login_ticket f user_id public.blog_user:id",
        "user_session p digest",
        "user_session c digest octet_length(digest)=32",
        "user_session c generation generation>0",
        "user_session f user_id public.blog_user:id",
        "article p id",
        "article c revision revision>0",
        "article c publication_count publication_count>=0",
        "article f owner_id public.admin_principal:id",
        "article f id,revision public.article_revision:article_id,revision deferred",
        "article f id,published_revision public.article_revision:article_id,revision deferred",
        "article_revision p article_id,revision",
        "article_revision c revision revision>0",
        "article_revision f article_id public.article:id",
        "article_command p actor_id,command_id",
        "article_command c fingerprint octet_length(fingerprint)=32",
        "article_command f actor_id public.admin_principal:id",
        "article_command f article_id public.article:id",
        "article_command f article_id,revision public.article_revision:article_id,revision",
        "article_publication p article_id",
        "article_publication u publication_id",
        "article_publication c publication_no publication_no>0",
        "article_publication f article_id public.article:id",
        "article_publication f article_id,revision public.article_revision:article_id,revision",
        "blog_outbox p id",
        "blog_outbox f article_id public.article:id",
        "blog_outbox f article_id,revision public.article_revision:article_id,revision"
    ];

    internal static async Task<bool> VerifyAsync(NpgsqlConnection connection, CancellationToken cancellationToken,
        SchemaAdmission admission = default)
    {
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        await using (var protect = new NpgsqlCommand("SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", connection, transaction))
        {
            await protect.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var role = new NpgsqlCommand("SHOW session_replication_role", connection, transaction))
        {
            if (await role.ExecuteScalarAsync(cancellationToken) is not "origin")
            {
                throw new InvalidOperationException("The PostgreSQL session must enforce local integrity triggers.");
            }
        }

        await using (var import = new NpgsqlCommand(
            "SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname='fsus_legacy_candidate')", connection, transaction))
        {
            if (await import.ExecuteScalarAsync(cancellationToken) is true)
                throw new InvalidOperationException("The database is an isolated legacy import candidate and cannot serve.");
        }

        var webpMedia = await VerifyCatalogAsync(connection, transaction, cancellationToken,
            CatalogVerificationOptions.FromAdmission(admission));
        await VerifyAdminIdentityMarkerAsync(connection, transaction, cancellationToken);
        await ReadRecoverySiteIdAsync(connection, transaction, cancellationToken);
        await using var marker = new NpgsqlCommand("SELECT version FROM public.v2_schema", connection, transaction);
        await using (var row = await marker.ExecuteReaderAsync(cancellationToken))
        {
            if (!await row.ReadAsync(cancellationToken) || row.GetInt32(0) != Version || await row.ReadAsync(cancellationToken))
            {
                throw new InvalidOperationException($"Expected a single FsusBlog V2 schema marker at version {Version}.");
            }
        }

        await transaction.CommitAsync(cancellationToken);
        return webpMedia;
    }

    internal static async Task<bool> VerifyCatalogAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken, CatalogVerificationOptions? options = null)
    {
        options ??= CatalogVerificationOptions.Default;
        var core = options.Core;
        var site = options.Site;
        var adminInbox = options.AdminInbox;
        var adminContent = options.AdminContent;
        var comments = options.Comments;
        var authoring = options.Authoring;
        var authorText = options.AuthorText;
        var media = options.Media;
        var publication = options.Publication;

        var catalog = await LoadCatalogPresenceSnapshotAsync(connection, transaction, cancellationToken);

        var hasArticleMedia = media.ArticleMedia ?? catalog.HasRelation(ArticleMediaRelation);
        var hasArticleCover = HasArticleCover(catalog);
        RequireSchemaPresence(media.ArticleCover, hasArticleCover,
            "The saved article cover schema presence does not match the requested operation.");
        if (hasArticleCover && !hasArticleMedia)
            throw new InvalidOperationException("Saved article covers require the article attachment schema.");
        var hasPrivateMediaImportOrigin = HasPrivateMediaImportOrigin(catalog);
        var hasLegacyReleaseOrigin = HasLegacyReleaseOrigin(catalog);
        if (hasPrivateMediaImportOrigin && !hasArticleMedia)
            throw new InvalidOperationException("Imported private media requires the article attachment schema.");
        var hasSubscription = site.Subscription ?? catalog.HasRelation(SiteSubscriptionRelation);
        var hasRecoveryKey = HasSiteRecoveryKeySchema(catalog);
        RequireSchemaPresence(site.RecoveryKey, hasRecoveryKey,
            "The site Recovery Key schema presence does not match the requested operation.");
        var hasAdminInboxReply = catalog.HasRelation(AdminInboxReplyRelation);
        RequireSchemaPresence(adminInbox.Reply, hasAdminInboxReply,
            "The administrator inbox reply schema presence does not match the requested operation.");
        var hasAdminInboxStatus = catalog.HasRelation(AdminInboxStatusRelation);
        RequireSchemaPresence(adminInbox.Status, hasAdminInboxStatus,
            "The administrator inbox status schema presence does not match the requested operation.");
        var hasAdminInboxNotice = catalog.HasRelation(AdminInboxNoticeRelation);
        RequireSchemaPresence(adminInbox.Notice, hasAdminInboxNotice,
            "The administrator inbox notice schema presence does not match the requested operation.");
        var hasAdminInboxRead = catalog.HasRelation(AdminInboxReadRelation);
        RequireSchemaPresence(adminInbox.Read, hasAdminInboxRead,
            "The shared administrator inbox read schema presence does not match the requested operation.");
        var hasAuthoringWorkspace = authoring.Workspace ?? catalog.HasRelation(AuthoringWorkspaceRelation);
        var hasSiteRefresh = HasSiteRefreshSchema(catalog);
        RequireSchemaPresence(site.Refresh, hasSiteRefresh,
            "The site refresh schema presence does not match the requested operation.");
        var hasSitePageEditor = HasSitePageEditorSchema(catalog);
        RequireSchemaPresence(site.PageEditor, hasSitePageEditor,
            "The site page editor schema presence does not match the requested operation.");
        var hasAppearanceActivation = HasAppearanceActivation(catalog);
        RequireSchemaPresence(site.AppearanceActivation, hasAppearanceActivation,
            "The signed appearance schema presence does not match the requested operation.");
        var hasRootCommentPowPolicy = HasRootCommentPowPolicy(catalog);
        if ((hasRootCommentPowPolicy && !core.AdminIdentity) ||
            (comments.RootPowPolicy.HasValue && comments.RootPowPolicy.Value != hasRootCommentPowPolicy))
            throw new InvalidOperationException("The root comment proof policy schema presence does not match the requested operation.");
        var hasSavedViews = HasSavedViews(catalog);
        RequireSchemaPresence(authoring.SavedViews, hasSavedViews,
            "The saved views schema presence does not match the requested operation.");
        var hasSavedViewPlacement = HasSavedViewPlacement(catalog);
        if ((hasSavedViewPlacement && !hasSavedViews) || (authoring.SavedViewPlacement.HasValue && authoring.SavedViewPlacement.Value != hasSavedViewPlacement))
            throw new InvalidOperationException("The saved view placement schema presence does not match the requested operation.");
        var hasAdminTagMetadata = HasAdminTagMetadata(catalog);
        RequireSchemaPresence(adminContent.TagMetadata, hasAdminTagMetadata,
            "The administrator tag metadata schema presence does not match the requested operation.");
        var hasAdminCategoryMetadata = HasAdminCategoryMetadata(catalog);
        if (hasAdminCategoryMetadata && !hasAdminTagMetadata)
            throw new InvalidOperationException("The administrator category metadata schema requires the taxonomy epoch.");
        RequireSchemaPresence(adminContent.CategoryMetadata, hasAdminCategoryMetadata,
            "The administrator category metadata schema is unavailable. Run category-metadata with the server stopped.");
        var hasAdminArticleRollback = HasAdminArticleRollbackSchema(catalog);
        RequireSchemaPresence(adminContent.ArticleRollback, hasAdminArticleRollback,
            "The administrator article rollback schema presence does not match the requested operation.");
        var hasAdminArticleDraftRollback = hasAdminArticleRollback &&
            HasAdminArticleDraftRollbackSchema(catalog);
        var hasAdminArticleArchive = hasAdminArticleDraftRollback &&
            HasAdminArticleArchiveSchema(catalog);
        var hasAdminArticleTrashPublication = hasAdminArticleArchive &&
            HasAdminArticleTrashPublicationSchema(catalog);
        var hasAdminArticleTrashRestore = HasAdminArticleTrashRestore(catalog);
        if (hasAdminArticleTrashRestore && !core.AdminIdentity)
            throw new InvalidOperationException("Administrator trash restoration requires independent administrator identity.");
        RequireSchemaPresence(adminContent.ArticleTrashRestore, hasAdminArticleTrashRestore,
            "The administrator trash restore schema presence does not match the requested operation.");
        var requireModerationVersion = core.AdminIdentity;
        var hasCommentAuthorDelete = HasCommentAuthorDeleteSchema(catalog);
        if (hasCommentAuthorDelete && !requireModerationVersion)
            throw new InvalidOperationException("Comment author deletion requires the current comment version column.");
        var hasCommentAuthorEdit = HasCommentAuthorEditSchema(catalog);
        if ((hasCommentAuthorEdit && !hasCommentAuthorDelete) ||
            (comments.AuthorEdit.HasValue && comments.AuthorEdit.Value != hasCommentAuthorEdit))
            throw new InvalidOperationException("Comment author edit schema presence does not match the requested operation.");
        string[] commentAuthorEditConstraints = hasCommentAuthorEdit
            ? ReadCommentAuthorEditConstraints(catalog) : [];
        var hasCommentReport = HasCommentReportSchema(catalog);
        RequireSchemaPresence(comments.Report, hasCommentReport,
            "Comment report schema presence does not match the requested operation.");
        var hasCommentAppeal = HasCommentAppealSchema(catalog);
        if (hasCommentAppeal && !hasCommentAuthorDelete || comments.Appeal.HasValue && comments.Appeal.Value != hasCommentAppeal)
            throw new InvalidOperationException("Comment appeal schema presence does not match the requested operation.");
        var hasCommentReplies = HasCommentReplySchema(catalog);
        if (hasCommentReplies && !hasCommentAuthorDelete || comments.Replies.HasValue && comments.Replies.Value != hasCommentReplies)
            throw new InvalidOperationException("Comment reply notice schema presence does not match the requested operation.");
        var hasAdminCommentBatch = HasAdminCommentBatchSchema(catalog);
        if ((hasAdminCommentBatch && !requireModerationVersion) ||
            (comments.AdminBatch.HasValue && comments.AdminBatch.Value != hasAdminCommentBatch))
            throw new InvalidOperationException("Administrator comment batch schema presence does not match the requested operation.");
        var hasWorkspaceLayout = hasAuthoringWorkspace && HasAuthoringWorkspaceLayout(catalog);
        var hasWorkspaceGroups = hasAuthoringWorkspace && HasAuthoringWorkspaceGroups(catalog);
        if ((hasWorkspaceGroups && !hasWorkspaceLayout) ||
            (authoring.WorkspaceGroups.HasValue && authoring.WorkspaceGroups.Value != hasWorkspaceGroups))
            throw new InvalidOperationException("The authoring workspace group schema presence does not match the requested operation.");
        var hasAuthorRecentOpens = HasAuthorRecentOpens(catalog);
        if ((hasAuthorRecentOpens && !core.RecoveryScope) ||
            (authoring.RecentOpens.HasValue && authoring.RecentOpens.Value != hasAuthorRecentOpens))
            throw new InvalidOperationException("The author recent opens schema presence does not match the requested operation.");
        var hasAuthorTextIndex = HasAuthorTextIndex(catalog);
        RequireSchemaPresence(authorText.Index, hasAuthorTextIndex,
            "The author full-text index schema presence does not match the requested operation.");
        var hasAuthorTextSummaryIndex = hasAuthorTextIndex &&
            HasAuthorTextSummaryIndex(catalog);
        if (authorText.SummaryIndex && !hasAuthorTextSummaryIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install summary indexing.");
        var hasAuthorTextHeadingIndex = hasAuthorTextIndex &&
            HasAuthorTextHeadingIndex(catalog);
        if (hasAuthorTextHeadingIndex && !hasAuthorTextSummaryIndex || authorText.HeadingIndex && !hasAuthorTextHeadingIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install heading indexing.");
        var hasAuthorTextPropertyIndex = HasAuthorTextPropertyIndex(catalog);
        if (hasAuthorTextPropertyIndex && !hasAuthorTextHeadingIndex || authorText.PropertyIndex && !hasAuthorTextPropertyIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install text property indexing.");
        var hasAuthorTextRebuild = HasAuthorTextRebuild(catalog);
        if (hasAuthorTextRebuild && !hasAuthorTextPropertyIndex || authorText.Rebuild && !hasAuthorTextRebuild)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install autonomous indexing.");
        var hasArticleSummary = HasArticleSummary(catalog);
        var hasDocumentExports = HasDocumentExports(catalog);
        var currentDocumentExportProvider = hasDocumentExports &&
            HasCurrentDocumentExportProvider(catalog);
        var hasDocumentExportAttachments = hasDocumentExports &&
            HasDocumentExportAttachments(catalog);
        var hasExportImageList = hasDocumentExportAttachments &&
            HasDocumentExportAttachments(catalog, list: true);
        var exportImageScope = hasExportImageList
            ? ReadExportImageScope(catalog) : ExportImageScope.Html;
        if (authoring.DocumentExports.HasValue && authoring.DocumentExports.Value != hasDocumentExports)
            throw new InvalidOperationException("The document export schema presence does not match the requested operation.");
        var hasArticleBodyInsertion = HasArticleBodyInsertion(catalog);
        var hasArticleBodyInsertionOperations = hasArticleBodyInsertion &&
            HasArticleBodyInsertionOperations(catalog);
        var hasArticleBodyEdits = hasArticleBodyInsertionOperations &&
            HasArticleBodyEdits(catalog);
        var hasPublicationCanonical = HasPublicationCanonical(catalog);
        if ((hasPublicationCanonical && (!core.PublicationHistory || !core.PublicationRights)) ||
            (publication.Canonical.HasValue && publication.Canonical.Value != hasPublicationCanonical))
            throw new InvalidOperationException("The native publication canonical schema presence does not match the requested operation.");
        var hasPublicationMedia = HasPublicationMedia(catalog);
        if ((hasPublicationMedia && (!core.PublicationHistory || !hasArticleMedia)) ||
            (media.PublicationMedia.HasValue && media.PublicationMedia.Value != hasPublicationMedia))
            throw new InvalidOperationException("The article publication media schema presence does not match the requested operation.");
        var hasPublicationCover = HasPublicationCover(catalog);
        if (hasPublicationCover && (!hasPublicationMedia || !hasPublicationCanonical || !hasArticleCover))
            throw new InvalidOperationException("Public article covers require author covers, selected publication media, and canonical storage.");
        RequireSchemaPresence(media.PublicationCover, hasPublicationCover,
            "The public article cover schema presence does not match the requested operation.");
        var hasPublicationProof = HasPublicationProof(catalog);
        if ((hasPublicationProof && !hasPublicationCanonical) ||
            (publication.Proof.HasValue && publication.Proof.Value != hasPublicationProof))
            throw new InvalidOperationException("The native publication proof schema presence does not match the requested operation.");
        var publicationTransparency = PublicationTransparencyState(catalog);
        var hasPublicationTransparency = publicationTransparency.HasValue;
        if ((hasPublicationTransparency && !hasPublicationProof) ||
            (publication.Transparency.HasValue && publication.Transparency.Value != hasPublicationTransparency))
            throw new InvalidOperationException("The native publication transparency schema presence does not match the requested operation.");
        var hasPublicationHead = HasPublicationHead(catalog);
        if ((hasPublicationHead && !hasPublicationTransparency) ||
            (publication.Head.HasValue && publication.Head.Value != hasPublicationHead))
            throw new InvalidOperationException("The native publication head schema presence does not match the requested operation.");
        var hasSiteTraffic = HasSiteTraffic(catalog);
        var hasArticleRead = HasArticleReadSchema(catalog);
        RequireSchemaPresence(publication.ArticleRead, hasArticleRead,
            "The article read aggregate schema presence does not match the requested operation.");
        // Retained as a dedicated index/opclass/sort-order probe rather than folded into CatalogPresenceSnapshot.
        var hasArticleReadTotal = await HasArticleReadTotalSchemaAsync(connection, transaction, cancellationToken);
        if ((hasArticleReadTotal && !hasArticleRead) || (publication.ArticleReadTotal.HasValue && publication.ArticleReadTotal.Value != hasArticleReadTotal))
            throw new InvalidOperationException("The article read total schema presence does not match the requested operation.");
        var hasPropertySnapshots = HasPropertySnapshots(catalog);
        var hasSitePasskeyNames = HasSitePasskeyNames(catalog);
        var expectedColumns = Columns.Select(column => hasArticleSummary && column == ArticleRevisionColumns
                ? ArticleRevisionColumns + " author_summary:text?" : column)
            .Concat(CommunicationColumns).Concat(TaxonomyColumns).Concat(core.LegacyCanvas ? LegacyCanvasColumns : CanvasColumns).Concat(PropertyColumns)
            .Concat(hasPropertySnapshots ? PropertySnapshotColumns : [])
            .Concat(PasskeyColumns).Concat(hasSitePasskeyNames ? [SitePasskeyNameColumns] : []).Concat(MfaColumns).Concat(GetCommentColumns(requireModerationVersion))
            .Concat(hasPrivateMediaImportOrigin ? PrivateMediaImportColumns : MediaColumns)
            .Concat(hasLegacyReleaseOrigin ? [LegacyReleaseOriginColumns] : [])
            .Concat(hasCommentAuthorDelete ? CommentAuthorDeleteColumns : [])
            .Concat(hasCommentAuthorEdit ? CommentAuthorEditColumns : [])
            .Concat(hasCommentReport ? [CommentReportColumns] : [])
            .Concat(hasCommentAppeal ? CommentAppealColumns : [])
            .Concat(hasCommentReplies ? CommentReplyColumns : [])
            .Concat(hasAdminCommentBatch ? AdminCommentBatchColumns : [])
            .Concat(core.RevisionHistory ? RevisionHistoryColumns : [])
            .Concat(core.AdminIdentity ? AdminIdentityColumns : [])
            .Concat(core.PublicationHistory ? (hasAdminArticleRollback ? PublicationHistoryColumnsForAdminRollback : PublicationHistoryColumns) : [])
            .Concat(hasPublicationMedia ? PublicationMediaColumns : [])
            .Concat(hasPublicationCover ? PublicationCoverColumns : [])
            .Concat(core.ArticleSchedule ? ArticleScheduleColumns : [])
            .Concat(core.MediaUpload ? MediaUploadColumns : [])
            .Concat(hasArticleMedia ? ArticleMediaColumns : [])
            .Concat(hasArticleCover ? ArticleCoverColumns : [])
            .Concat(hasSubscription ? SiteSubscriptionColumns : [])
            .Concat(hasRecoveryKey ? SiteRecoveryKeyColumns : [])
            .Concat(hasSiteRefresh ? SiteRefreshColumns : [])
            .Concat(hasSitePageEditor ? SitePageEditorColumns : [])
            .Concat(hasAppearanceActivation ? AppearanceActivationColumns : [])
            .Concat(hasRootCommentPowPolicy ? RootCommentPowPolicyColumns : [])
            .Concat(hasSavedViews ? SavedViewColumns : [])
            .Concat(hasSavedViewPlacement ? SavedViewPlacementColumns : [])
            .Concat(hasAdminTagMetadata ? AdminTagMetadataColumns : [])
            .Concat(hasAdminCategoryMetadata ? AdminCategoryMetadataColumns : [])
            .Concat(hasAdminArticleRollback ? GetAdminArticleRollbackColumns(hasAdminArticleDraftRollback, hasAdminArticleArchive, hasAdminArticleTrashPublication) : [])
            .Concat(hasAdminArticleTrashRestore ? AdminArticleTrashRestoreColumns : [])
            .Concat(hasAuthoringWorkspace ? GetAuthoringWorkspaceColumns(hasWorkspaceLayout, hasWorkspaceGroups) : [])
            .Concat(hasAuthorRecentOpens ? AuthorRecentOpenColumns : [])
            .Concat(hasArticleBodyInsertion ? [ArticleBodyInsertionColumns(hasArticleBodyInsertionOperations, hasArticleBodyEdits)] : [])
            .Concat(hasDocumentExports ? [DocumentExportColumns + (hasDocumentExportAttachments ? " attachment_id:uuid?" : "") + (hasExportImageList ? " attachment_ids:_uuid?" : "")] : [])
            .Concat(hasAuthorTextIndex ? AuthorTextIndexColumns(hasAuthorTextSummaryIndex, hasAuthorTextHeadingIndex) : [])
            .Concat(hasAuthorTextPropertyIndex ? AuthorTextPropertyIndexColumns : [])
            .Concat(hasAuthorTextRebuild ? [AuthorTextRebuildColumns] : [])
            .Concat(hasAdminInboxReply ? AdminInboxReplyColumns : [])
            .Concat(hasAdminInboxStatus ? AdminInboxStatusColumns : [])
            .Concat(hasAdminInboxNotice ? AdminInboxNoticeColumns : [])
            .Concat(hasAdminInboxRead ? AdminInboxReadColumns : [])
            .Concat(core.PublicationRights ? PublicationRightsColumns : [])
            .Concat(hasPublicationCanonical ? PublicationCanonicalColumns : [])
            .Concat(hasPublicationProof ? GetPublicationProofColumns(publicationTransparency) : [])
            .Concat(hasPublicationTransparency ? PublicationTransparencyColumns : [])
            .Concat(hasPublicationHead ? PublicationHeadColumns : [])
            .Concat(hasSiteTraffic ? SiteTrafficColumns : [])
            .Concat(hasArticleRead ? ArticleReadColumns : [])
            .Concat(hasArticleReadTotal ? ArticleReadTotalColumns : [])
            .Concat(!core.LegacyCanvas && core.CanvasHistory ? CanvasHistoryColumns : [])
            .Concat(core.RecoveryScope ? RecoveryScopeColumns : []).ToArray();
        var expectedConstraints = Constraints.Concat(hasArticleSummary ? [ArticleSummaryConstraint] : [])
            .Concat(CommunicationConstraints).Concat(TaxonomyConstraints).Concat(core.LegacyCanvas ? LegacyCanvasConstraints : CanvasConstraints)
            .Concat(PropertyConstraints).Concat(hasPropertySnapshots ? PropertySnapshotConstraints : [])
            .Concat(PasskeyConstraints).Concat(hasSitePasskeyNames ? SitePasskeyNameConstraints : []).Concat(MfaConstraints).Concat(GetCommentConstraints(requireModerationVersion)).Concat(MediaConstraints)
            .Concat(hasPrivateMediaImportOrigin ? PrivateMediaImportConstraints : [])
            .Concat(hasLegacyReleaseOrigin ? LegacyReleaseOriginConstraints : [])
            .Concat(hasCommentAuthorDelete ? CommentAuthorDeleteConstraints : [])
            .Concat(commentAuthorEditConstraints)
            .Concat(hasCommentReport ? CommentReportConstraints : [])
            .Concat(hasCommentAppeal ? CommentAppealConstraints : [])
            .Concat(hasCommentReplies ? CommentReplyConstraints : [])
            .Concat(hasAdminCommentBatch ? AdminCommentBatchConstraints : [])
            .Concat(core.RevisionHistory ? RevisionHistoryConstraints : [])
            .Concat(core.AdminIdentity ? AdminIdentityConstraints : [])
            .Concat(core.PublicationHistory ? PublicationHistoryConstraints : [])
            .Concat(hasPublicationMedia ? PublicationMediaConstraints : [])
            .Concat(hasAdminArticleRollback ? PublicationHistoryAdminRollbackConstraints : [])
            .Concat(core.ArticleSchedule ? ArticleScheduleConstraints : [])
            .Concat(core.MediaUpload ? MediaUploadConstraints : [])
            .Concat(hasArticleMedia ? ArticleMediaConstraints : [])
            .Concat(hasArticleCover ? ArticleCoverConstraints : [])
            .Concat(hasSubscription ? SiteSubscriptionConstraints : [])
            .Concat(hasRecoveryKey ? SiteRecoveryKeyConstraints : [])
            .Concat(hasSiteRefresh ? SiteRefreshConstraints : [])
            .Concat(hasSitePageEditor ? SitePageEditorConstraints : [])
            .Concat(hasAppearanceActivation ? AppearanceActivationConstraints : [])
            .Concat(hasRootCommentPowPolicy ? RootCommentPowPolicyConstraints : [])
            .Concat(hasSavedViews ? SavedViewConstraints : [])
            .Concat(hasSavedViewPlacement ? SavedViewPlacementConstraints : [])
            .Concat(hasAdminTagMetadata ? AdminTagMetadataConstraints : [])
            .Concat(hasAdminCategoryMetadata ? AdminCategoryMetadataConstraints : [])
            .Concat(hasAdminArticleRollback ? GetAdminArticleRollbackConstraints(hasAdminArticleDraftRollback, hasAdminArticleArchive, hasAdminArticleTrashPublication) : [])
            .Concat(hasAdminArticleTrashRestore ? AdminArticleTrashRestoreConstraints : [])
            .Concat(hasAuthoringWorkspace ? AuthoringWorkspaceConstraints : [])
            .Concat(hasWorkspaceGroups ? AuthoringWorkspaceGroupsConstraints : [])
            .Concat(hasAuthorRecentOpens ? AuthorRecentOpenConstraints : [])
            .Concat(hasArticleBodyInsertion ? ArticleBodyInsertionConstraints(hasArticleBodyInsertionOperations, hasArticleBodyEdits) : [])
            .Concat(hasDocumentExports
                ? DocumentExportConstraints.Concat(hasDocumentExportAttachments
                    ? [$"author_document_export c provider provider>=1ANDprovider<={(hasExportImageList ? 4 : 3)}",
                       "author_document_export c provider,attachment_id (provider=3)=(attachment_idISNOTNULL)"]
                    : [currentDocumentExportProvider ? "author_document_export c provider provider>=1ANDprovider<=2"
                        : "author_document_export c provider provider=1"]).Concat(hasExportImageList
                    ? ["author_document_export c provider,attachment_ids (provider=4)=(attachment_idsISNOTNULL)",
                       $"author_document_export c attachment_ids,format {ExportImageListCondition(exportImageScope)}"] : []) : [])
            .Concat(hasAuthorTextIndex ? AuthorTextIndexConstraints(hasAuthorTextSummaryIndex, hasAuthorTextHeadingIndex) : [])
            .Concat(hasAuthorTextPropertyIndex ? AuthorTextPropertyIndexConstraints : [])
            .Concat(hasAuthorTextRebuild ? AuthorTextRebuildConstraints : [])
            .Concat(hasAdminInboxReply ? AdminInboxReplyConstraints : [])
            .Concat(hasAdminInboxStatus ? AdminInboxStatusConstraints : [])
            .Concat(hasAdminInboxNotice ? AdminInboxNoticeConstraints : [])
            .Concat(hasAdminInboxRead ? AdminInboxReadConstraints : [])
            .Concat(core.PublicationRights ? PublicationRightsConstraints : [])
            .Concat(hasPublicationCanonical ? PublicationCanonicalConstraints : [])
            .Concat(hasPublicationCanonical ? [PublicationCanonicalVersionConstraint(hasPublicationCover)] : [])
            .Concat(hasPublicationCover ? PublicationCoverConstraints : [])
            .Concat(hasPublicationProof ? PublicationProofConstraints : [])
            .Concat(hasPublicationTransparency ? PublicationTransparencyConstraints : [])
            .Concat(hasPublicationHead ? PublicationHeadConstraints : [])
            .Concat(hasSiteTraffic ? SiteTrafficConstraints : [])
            .Concat(hasArticleRead ? ArticleReadConstraints : [])
            .Concat(hasArticleReadTotal ? ArticleReadTotalConstraints : [])
            .Concat(!core.LegacyCanvas && core.CanvasHistory ? CanvasHistoryConstraints : [])
            .Concat(core.RecoveryScope ? RecoveryScopeConstraints : []).ToArray();
        var webpMedia = await VerifyRelationsAsync(connection, transaction, expectedColumns, expectedConstraints, cancellationToken);
        RequireSchemaPresence(authoring.ArticleSummary, hasArticleSummary,
            "The article author summary schema presence does not match the requested operation.");
        if (hasSitePageEditor) await VerifySitePageCoordinatesAsync(connection, transaction, cancellationToken);
        if (hasAdminTagMetadata) await VerifyTaxonomyEpochAsync(connection, transaction, hasAdminCategoryMetadata, cancellationToken);
        if (hasAppearanceActivation) await VerifyAppearanceActivationAsync(connection, transaction, cancellationToken);
        if (hasRootCommentPowPolicy) await VerifyRootCommentPowPolicyAsync(connection, transaction, cancellationToken);
        if (hasArticleRead) await VerifyArticleReadEpochAsync(connection, transaction, cancellationToken);
        if (hasAuthorTextIndex) await VerifyAuthorTextArticleOwnerIndexAsync(connection, transaction, cancellationToken);
        if (hasDocumentExports) await VerifyDocumentExportIndexesAsync(connection, transaction, cancellationToken);
        return webpMedia;
    }

    private static async Task<bool> VerifyRelationsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string[] expectedColumns, string[] expectedConstraints, CancellationToken cancellationToken)
    {
        const string sql = """
            WITH owned AS (
                SELECT c.*
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname::text = ANY($1)
            )
            SELECT 'column', c.relname || ' ' || string_agg(a.attname || ':' || t.typname ||
                CASE WHEN a.attnotnull THEN '' ELSE '?' END ||
                CASE WHEN a.attidentity = '' THEN '' ELSE ':' || a.attidentity::text ||
                    CASE WHEN EXISTS (
                        SELECT FROM pg_depend dep JOIN pg_sequence seq ON seq.seqrelid = dep.objid
                        WHERE dep.classid = 'pg_class'::regclass AND dep.refclassid = 'pg_class'::regclass
                          AND dep.refobjid = c.oid AND dep.refobjsubid = a.attnum AND dep.deptype = 'i'
                          AND seq.seqtypid = a.atttypid AND seq.seqincrement = 1 AND seq.seqmin = 1
                          AND seq.seqstart = 1 AND seq.seqcache = 1 AND NOT seq.seqcycle
                    ) THEN '' ELSE ' unexpected-identity-sequence' END END ||
                CASE WHEN a.atttypmod = -1 AND a.attgenerated = '' AND tn.nspname = 'pg_catalog'
                         AND a.attcollation = t.typcollation THEN '' ELSE ' unexpected-modifier' END ||
                CASE WHEN d.oid IS NULL THEN '' ELSE '=' || replace(pg_get_expr(d.adbin, d.adrelid), '()', '') END,
                ' ' ORDER BY a.attnum)
            FROM owned c JOIN pg_attribute a ON a.attrelid = c.oid
            JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
            WHERE c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relrowsecurity AND NOT c.relhasrules
               AND NOT EXISTS (SELECT FROM pg_trigger tr WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal)
               AND NOT EXISTS (SELECT FROM pg_trigger tr WHERE tr.tgrelid = c.oid AND tr.tgenabled NOT IN ('O', 'A'))
               AND NOT EXISTS (SELECT FROM pg_inherits i WHERE c.oid IN (i.inhrelid, i.inhparent))
               AND a.attnum > 0 AND NOT a.attisdropped
            GROUP BY c.relname
            UNION ALL
            SELECT 'constraint', c.relname || ' ' || k.contype::text || ' ' ||
                coalesce((SELECT string_agg(a.attname, ',' ORDER BY i)
                          FROM unnest(k.conkey) WITH ORDINALITY AS keys(attnum, i)
                          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = keys.attnum), '') ||
                CASE WHEN k.contype = 'c' THEN ' ' || regexp_replace(pg_get_expr(k.conbin, k.conrelid, true), '[[:space:]]', '', 'g')
                     WHEN k.contype = 'f' THEN ' ' || n.nspname || '.' || target.relname || ':' ||
                         (SELECT string_agg(a.attname, ',' ORDER BY i)
                          FROM unnest(k.confkey) WITH ORDINALITY AS keys(attnum, i)
                          JOIN pg_attribute a ON a.attrelid = target.oid AND a.attnum = keys.attnum) ||
                         CASE WHEN k.confmatchtype <> 's' THEN ' unexpected-action'
                              WHEN k.confdeltype = 'a' AND k.confupdtype = 'a' THEN ''
                              WHEN k.confdeltype = 'c' AND k.confupdtype = 'a' AND n.nspname = 'public'
                                   AND ((c.relname IN ('admin_step_up', 'admin_site_page_step_up', 'admin_article_rollback_step_up',
                                                      'admin_appearance_step_up', 'comment_appeal_admin_step_up',
                                                      'admin_comment_batch_step_up', 'admin_root_comment_pow_step_up',
                                                      'admin_article_trash_step_up', 'admin_reader_governance_step_up')
                                         AND target.relname = 'admin_session')
                                     OR (c.relname = 'site_session_refresh_tombstone' AND target.relname = 'site_session_refresh')
                                     OR (c.relname = 'author_document_export' AND target.relname IN ('admin_principal', 'article_revision'))
                                     OR (c.relname = 'site_passkey_name' AND target.relname = 'passkey_credential'))
                                   THEN ' delete-cascade'
                              WHEN k.confdeltype = 'c' AND k.confupdtype = 'c' AND n.nspname = 'public'
                                   AND c.relname = 'site_session_refresh' AND target.relname = 'user_session'
                                   THEN ' delete-cascade update-cascade'
                              ELSE ' unexpected-action' END
                     ELSE '' END ||
                CASE WHEN NOT k.convalidated OR NOT k.conislocal
                           OR coalesce(to_jsonb(k)->>'conenforced', 'true') <> 'true' THEN ' not-validated'
                     WHEN k.contype IN ('p', 'u') AND NOT EXISTS (
                         SELECT FROM pg_index idx WHERE idx.indexrelid = k.conindid AND idx.indisvalid AND idx.indisready
                     ) THEN ' unexpected-index'
                     WHEN k.condeferrable AND k.condeferred THEN ' deferred'
                     WHEN k.condeferrable THEN ' deferrable' ELSE '' END
            FROM owned c JOIN pg_constraint k ON k.conrelid = c.oid
            LEFT JOIN pg_class target ON target.oid = k.confrelid
            LEFT JOIN pg_namespace n ON n.oid = target.relnamespace
            WHERE k.contype <> 'n'
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.Add(new NpgsqlParameter<string[]>
        {
            TypedValue = expectedColumns.Select(column => column.Split(' ', 2)[0]).ToArray()
        });
        var columns = new List<string>();
        var constraints = new List<string>();
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
                (reader.GetString(0) == "column" ? columns : constraints).Add(reader.GetString(1));
        }

        var webpMedia = constraints.Contains("private_media c format format>=1ANDformat<=3", StringComparer.Ordinal);
        if (webpMedia) expectedConstraints = expectedConstraints.Select(WithWebpFormat).ToArray();
        AssertShape("relation/column", expectedColumns, columns);
        AssertShape("constraint", expectedConstraints, constraints);
        return webpMedia;
    }

    private static void AssertShape(string kind, string[] expected, List<string> observed)
    {
        if (expected.Order(StringComparer.Ordinal).SequenceEqual(observed.Order(StringComparer.Ordinal)))
        {
            return;
        }

        var missing = string.Join("; ", expected.Except(observed, StringComparer.Ordinal));
        var unexpected = string.Join("; ", observed.Except(expected, StringComparer.Ordinal));
        throw new InvalidOperationException($"FsusBlog V2 {kind} shape mismatch. Missing [{missing}]. Unexpected [{unexpected}].");
    }
}
