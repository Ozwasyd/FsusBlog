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
        "blog_user id:uuid name:text can_author:bool enabled:bool generation:int8",
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
        "article f owner_id public.blog_user:id",
        "article f id,revision public.article_revision:article_id,revision deferred",
        "article f id,published_revision public.article_revision:article_id,revision deferred",
        "article_revision p article_id,revision",
        "article_revision c revision revision>0",
        "article_revision f article_id public.article:id",
        "article_command p actor_id,command_id",
        "article_command c fingerprint octet_length(fingerprint)=32",
        "article_command f actor_id public.blog_user:id",
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

        var webpMedia = await VerifyCatalogAsync(connection, transaction, cancellationToken, requireArticleMedia: true,
            requireSubscription: admission.Subscription, requireRecoveryKey: admission.RecoveryKey, requireAdminInboxReply: admission.AdminInboxReply, requireSiteRefresh: admission.SiteRefresh,
            requireSitePageEditor: admission.SitePageEditor, requireAdminArticleRollback: admission.AdminArticleRollback, requireAdminInboxStatus: admission.AdminInboxStatus, requireAdminInboxNotice: admission.AdminInboxNotice, requireAppearanceActivation: admission.AppearanceActivation, requireAdminTagMetadata: admission.AdminTagMetadata, requireAdminInboxRead: admission.AdminInboxRead,
            requirePublicationMedia: admission.PublicationMedia, requireAdminCommentBatch: admission.AdminCommentBatch,
            requireAuthorTextIndex: admission.AuthorTextIndex, requireArticleSummary: admission.ArticleSummary,
            requireDocumentExports: admission.DocumentExports, requireAdminCategoryMetadata: admission.AdminCategoryMetadata);
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
        CancellationToken cancellationToken, bool requireRecoveryScope = true, bool requireRevisionHistory = true,
        bool requireAdminIdentity = true, bool requirePublicationHistory = true, bool requireArticleSchedule = true,
        bool requireMediaUpload = true, bool legacyCanvas = false, int adminIdentityVersion = AdminIdentityVersion,
        bool requirePublicationRights = true,
        bool requireCanvasHistory = true, bool? requireArticleMedia = null, bool? requireSubscription = null,
        bool? requireRecoveryKey = null, bool? requireAdminInboxReply = null, bool? requireAuthoringWorkspace = null, bool? requireSiteRefresh = null, bool? requireSitePageEditor = null, bool? requireAdminArticleRollback = null,
        bool? requireSavedViews = null, bool? requireAdminInboxStatus = null, bool? requireSavedViewPlacement = null, bool? requireAdminInboxNotice = null, bool? requireAppearanceActivation = null, bool? requireAdminTagMetadata = null, bool? requireAdminInboxRead = null,
        bool? requireAuthorRecentOpens = null, bool? requirePublicationCanonical = null, bool? requirePublicationProof = null, bool? requirePublicationMedia = null, bool? requireCommentAppeal = null,
        bool? requireAuthoringWorkspaceGroups = null, bool? requireCommentReplies = null, bool? requireAdminCommentBatch = null,
        bool? requireArticleRead = null, bool? requirePublicationTransparency = null, bool? requirePublicationHead = null,
        bool? requireArticleReadTotal = null, bool? requireCommentAuthorEdit = null, bool? requireCommentReport = null,
        bool? requireAuthorTextIndex = null, bool? requireRootCommentPowPolicy = null, bool? requireArticleSummary = null,
        bool requireAuthorTextSummaryIndex = false, bool requireAuthorTextHeadingIndex = false,
        bool requireAuthorTextPropertyIndex = false, bool requireAuthorTextRebuild = false,
        bool? requireDocumentExports = null, bool? requireAdminCategoryMetadata = null,
        bool? requireAdminArticleTrashRestore = null, bool? requireArticleCover = null, bool? requirePublicationCover = null)
    {
        requireArticleMedia ??= await HasRelationAsync(connection, transaction, "public.article_revision_media", cancellationToken);
        var hasArticleCover = await HasArticleCoverAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireArticleCover, hasArticleCover,
            "The saved article cover schema presence does not match the requested operation.");
        if (hasArticleCover && !requireArticleMedia.Value)
            throw new InvalidOperationException("Saved article covers require the article attachment schema.");
        var hasPrivateMediaImportOrigin = await HasPrivateMediaImportOriginAsync(connection, transaction, cancellationToken);
        var hasLegacyReleaseOrigin = await HasLegacyReleaseOriginAsync(connection, transaction, cancellationToken);
        if (hasPrivateMediaImportOrigin && !requireArticleMedia.Value)
            throw new InvalidOperationException("Imported private media requires the article attachment schema.");
        requireSubscription ??= await HasRelationAsync(connection, transaction, SiteSubscriptionRelation, cancellationToken);
        var hasRecoveryKey = await HasSiteRecoveryKeySchemaAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireRecoveryKey, hasRecoveryKey,
            "The site Recovery Key schema presence does not match the requested operation.");
        var hasAdminInboxReply = await HasRelationAsync(connection, transaction, AdminInboxReplyRelation, cancellationToken);
        RequireSchemaPresence(requireAdminInboxReply, hasAdminInboxReply,
            "The administrator inbox reply schema presence does not match the requested operation.");
        var hasAdminInboxStatus = await HasRelationAsync(connection, transaction, AdminInboxStatusRelation, cancellationToken);
        RequireSchemaPresence(requireAdminInboxStatus, hasAdminInboxStatus,
            "The administrator inbox status schema presence does not match the requested operation.");
        var hasAdminInboxNotice = await HasRelationAsync(connection, transaction, AdminInboxNoticeRelation, cancellationToken);
        RequireSchemaPresence(requireAdminInboxNotice, hasAdminInboxNotice,
            "The administrator inbox notice schema presence does not match the requested operation.");
        var hasAdminInboxRead = await HasRelationAsync(connection, transaction, AdminInboxReadRelation, cancellationToken);
        RequireSchemaPresence(requireAdminInboxRead, hasAdminInboxRead,
            "The shared administrator inbox read schema presence does not match the requested operation.");
        requireAuthoringWorkspace ??= await HasRelationAsync(connection, transaction, AuthoringWorkspaceRelation, cancellationToken);
        var hasSiteRefresh = await HasSiteRefreshSchemaAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireSiteRefresh, hasSiteRefresh,
            "The site refresh schema presence does not match the requested operation.");
        var hasSitePageEditor = await HasSitePageEditorSchemaAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireSitePageEditor, hasSitePageEditor,
            "The site page editor schema presence does not match the requested operation.");
        var hasAppearanceActivation = await HasAppearanceActivationAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireAppearanceActivation, hasAppearanceActivation,
            "The signed appearance schema presence does not match the requested operation.");
        var hasRootCommentPowPolicy = await HasRootCommentPowPolicyAsync(connection, transaction, cancellationToken);
        if ((hasRootCommentPowPolicy && !requireAdminIdentity) ||
            (requireRootCommentPowPolicy.HasValue && requireRootCommentPowPolicy.Value != hasRootCommentPowPolicy))
            throw new InvalidOperationException("The root comment proof policy schema presence does not match the requested operation.");
        var hasSavedViews = await HasSavedViewsAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireSavedViews, hasSavedViews,
            "The saved views schema presence does not match the requested operation.");
        var hasSavedViewPlacement = await HasSavedViewPlacementAsync(connection, transaction, cancellationToken);
        if ((hasSavedViewPlacement && !hasSavedViews) || (requireSavedViewPlacement.HasValue && requireSavedViewPlacement.Value != hasSavedViewPlacement))
            throw new InvalidOperationException("The saved view placement schema presence does not match the requested operation.");
        var hasAdminTagMetadata = await HasAdminTagMetadataAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireAdminTagMetadata, hasAdminTagMetadata,
            "The administrator tag metadata schema presence does not match the requested operation.");
        var hasAdminCategoryMetadata = await HasAdminCategoryMetadataAsync(connection, transaction, cancellationToken);
        if (hasAdminCategoryMetadata && !hasAdminTagMetadata)
            throw new InvalidOperationException("The administrator category metadata schema requires the taxonomy epoch.");
        RequireSchemaPresence(requireAdminCategoryMetadata, hasAdminCategoryMetadata,
            "The administrator category metadata schema is unavailable. Run category-metadata with the server stopped.");
        var hasAdminArticleRollback = await HasAdminArticleRollbackSchemaAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireAdminArticleRollback, hasAdminArticleRollback,
            "The administrator article rollback schema presence does not match the requested operation.");
        var hasAdminArticleDraftRollback = hasAdminArticleRollback &&
            await HasAdminArticleDraftRollbackSchemaAsync(connection, transaction, cancellationToken);
        var hasAdminArticleArchive = hasAdminArticleDraftRollback &&
            await HasAdminArticleArchiveSchemaAsync(connection, transaction, cancellationToken);
        var hasAdminArticleTrashPublication = hasAdminArticleArchive &&
            await HasAdminArticleTrashPublicationSchemaAsync(connection, transaction, cancellationToken);
        var hasAdminArticleTrashRestore = await HasAdminArticleTrashRestoreAsync(connection, transaction, cancellationToken);
        if (hasAdminArticleTrashRestore && !requireAdminIdentity)
            throw new InvalidOperationException("Administrator trash restoration requires independent administrator identity.");
        RequireSchemaPresence(requireAdminArticleTrashRestore, hasAdminArticleTrashRestore,
            "The administrator trash restore schema presence does not match the requested operation.");
        var requireModerationVersion = requireAdminIdentity && adminIdentityVersion >= AdminModerationVersion;
        var hasCommentAuthorDelete = await HasCommentAuthorDeleteSchemaAsync(connection, transaction, cancellationToken);
        if (hasCommentAuthorDelete && !requireModerationVersion)
            throw new InvalidOperationException("Comment author deletion requires the current comment version column.");
        var hasCommentAuthorEdit = await HasCommentAuthorEditSchemaAsync(connection, transaction, cancellationToken);
        if ((hasCommentAuthorEdit && !hasCommentAuthorDelete) ||
            (requireCommentAuthorEdit.HasValue && requireCommentAuthorEdit.Value != hasCommentAuthorEdit))
            throw new InvalidOperationException("Comment author edit schema presence does not match the requested operation.");
        string[] commentAuthorEditConstraints = hasCommentAuthorEdit
            ? await ReadCommentAuthorEditConstraintsAsync(connection, transaction, cancellationToken) : [];
        var hasCommentReport = await HasCommentReportSchemaAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireCommentReport, hasCommentReport,
            "Comment report schema presence does not match the requested operation.");
        var hasCommentAppeal = await HasCommentAppealSchemaAsync(connection, transaction, cancellationToken);
        if (hasCommentAppeal && !hasCommentAuthorDelete || requireCommentAppeal.HasValue && requireCommentAppeal.Value != hasCommentAppeal)
            throw new InvalidOperationException("Comment appeal schema presence does not match the requested operation.");
        var hasCommentReplies = await HasCommentReplySchemaAsync(connection, transaction, cancellationToken);
        if (hasCommentReplies && !hasCommentAuthorDelete || requireCommentReplies.HasValue && requireCommentReplies.Value != hasCommentReplies)
            throw new InvalidOperationException("Comment reply notice schema presence does not match the requested operation.");
        var hasAdminCommentBatch = await HasAdminCommentBatchSchemaAsync(connection, transaction, cancellationToken);
        if ((hasAdminCommentBatch && !requireModerationVersion) ||
            (requireAdminCommentBatch.HasValue && requireAdminCommentBatch.Value != hasAdminCommentBatch))
            throw new InvalidOperationException("Administrator comment batch schema presence does not match the requested operation.");
        var hasWorkspaceLayout = requireAuthoringWorkspace.Value && await HasAuthoringWorkspaceLayoutAsync(connection, transaction, cancellationToken);
        var hasWorkspaceGroups = requireAuthoringWorkspace.Value && await HasAuthoringWorkspaceGroupsAsync(connection, transaction, cancellationToken);
        if ((hasWorkspaceGroups && !hasWorkspaceLayout) ||
            (requireAuthoringWorkspaceGroups.HasValue && requireAuthoringWorkspaceGroups.Value != hasWorkspaceGroups))
            throw new InvalidOperationException("The authoring workspace group schema presence does not match the requested operation.");
        var hasAuthorRecentOpens = await HasAuthorRecentOpensAsync(connection, transaction, cancellationToken);
        if ((hasAuthorRecentOpens && !requireRecoveryScope) ||
            (requireAuthorRecentOpens.HasValue && requireAuthorRecentOpens.Value != hasAuthorRecentOpens))
            throw new InvalidOperationException("The author recent opens schema presence does not match the requested operation.");
        var hasAuthorTextIndex = await HasAuthorTextIndexAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireAuthorTextIndex, hasAuthorTextIndex,
            "The author full-text index schema presence does not match the requested operation.");
        var hasAuthorTextSummaryIndex = hasAuthorTextIndex &&
            await HasAuthorTextSummaryIndexAsync(connection, transaction, cancellationToken);
        if (requireAuthorTextSummaryIndex && !hasAuthorTextSummaryIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install summary indexing.");
        var hasAuthorTextHeadingIndex = hasAuthorTextIndex &&
            await HasAuthorTextHeadingIndexAsync(connection, transaction, cancellationToken);
        if (hasAuthorTextHeadingIndex && !hasAuthorTextSummaryIndex || requireAuthorTextHeadingIndex && !hasAuthorTextHeadingIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install heading indexing.");
        var hasAuthorTextPropertyIndex = await HasAuthorTextPropertyIndexAsync(connection, transaction, cancellationToken);
        if (hasAuthorTextPropertyIndex && !hasAuthorTextHeadingIndex || requireAuthorTextPropertyIndex && !hasAuthorTextPropertyIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install text property indexing.");
        var hasAuthorTextRebuild = await HasAuthorTextRebuildAsync(connection, transaction, cancellationToken);
        if (hasAuthorTextRebuild && !hasAuthorTextPropertyIndex || requireAuthorTextRebuild && !hasAuthorTextRebuild)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install autonomous indexing.");
        var hasArticleSummary = await HasArticleSummaryAsync(connection, transaction, cancellationToken);
        var hasDocumentExports = await HasDocumentExportsAsync(connection, transaction, cancellationToken);
        var currentDocumentExportProvider = hasDocumentExports &&
            await HasCurrentDocumentExportProviderAsync(connection, transaction, cancellationToken);
        var hasDocumentExportAttachments = hasDocumentExports &&
            await HasDocumentExportAttachmentsAsync(connection, transaction, cancellationToken);
        var hasExportImageList = hasDocumentExportAttachments &&
            await HasDocumentExportAttachmentsAsync(connection, transaction, cancellationToken, list: true);
        var exportImageScope = hasExportImageList
            ? await ReadExportImageScopeAsync(connection, transaction, cancellationToken) : ExportImageScope.Html;
        if (requireDocumentExports.HasValue && requireDocumentExports.Value != hasDocumentExports)
            throw new InvalidOperationException("The document export schema presence does not match the requested operation.");
        var hasArticleBodyInsertion = await HasArticleBodyInsertionAsync(connection, transaction, cancellationToken);
        var hasArticleBodyInsertionOperations = hasArticleBodyInsertion &&
            await HasArticleBodyInsertionOperationsAsync(connection, transaction, cancellationToken);
        var hasArticleBodyEdits = hasArticleBodyInsertionOperations &&
            await HasArticleBodyEditsAsync(connection, transaction, cancellationToken);
        var hasPublicationCanonical = await HasPublicationCanonicalAsync(connection, transaction, cancellationToken);
        if ((hasPublicationCanonical && (!requirePublicationHistory || !requirePublicationRights)) ||
            (requirePublicationCanonical.HasValue && requirePublicationCanonical.Value != hasPublicationCanonical))
            throw new InvalidOperationException("The native publication canonical schema presence does not match the requested operation.");
        var hasPublicationMedia = await HasPublicationMediaAsync(connection, transaction, cancellationToken);
        if ((hasPublicationMedia && (!requirePublicationHistory || !requireArticleMedia.Value)) ||
            (requirePublicationMedia.HasValue && requirePublicationMedia.Value != hasPublicationMedia))
            throw new InvalidOperationException("The article publication media schema presence does not match the requested operation.");
        var hasPublicationCover = await HasPublicationCoverAsync(connection, transaction, cancellationToken);
        if (hasPublicationCover && (!hasPublicationMedia || !hasPublicationCanonical || !hasArticleCover))
            throw new InvalidOperationException("Public article covers require author covers, selected publication media, and canonical storage.");
        RequireSchemaPresence(requirePublicationCover, hasPublicationCover,
            "The public article cover schema presence does not match the requested operation.");
        var hasPublicationProof = await HasPublicationProofAsync(connection, transaction, cancellationToken);
        if ((hasPublicationProof && !hasPublicationCanonical) ||
            (requirePublicationProof.HasValue && requirePublicationProof.Value != hasPublicationProof))
            throw new InvalidOperationException("The native publication proof schema presence does not match the requested operation.");
        var publicationTransparency = await PublicationTransparencyStateAsync(connection, transaction, cancellationToken);
        var hasPublicationTransparency = publicationTransparency.HasValue;
        if ((hasPublicationTransparency && !hasPublicationProof) ||
            (requirePublicationTransparency.HasValue && requirePublicationTransparency.Value != hasPublicationTransparency))
            throw new InvalidOperationException("The native publication transparency schema presence does not match the requested operation.");
        var hasPublicationHead = await HasPublicationHeadAsync(connection, transaction, cancellationToken);
        if ((hasPublicationHead && !hasPublicationTransparency) ||
            (requirePublicationHead.HasValue && requirePublicationHead.Value != hasPublicationHead))
            throw new InvalidOperationException("The native publication head schema presence does not match the requested operation.");
        var hasArticleRead = await HasArticleReadSchemaAsync(connection, transaction, cancellationToken);
        RequireSchemaPresence(requireArticleRead, hasArticleRead,
            "The article read aggregate schema presence does not match the requested operation.");
        var hasArticleReadTotal = await HasArticleReadTotalSchemaAsync(connection, transaction, cancellationToken);
        if ((hasArticleReadTotal && !hasArticleRead) || (requireArticleReadTotal.HasValue && requireArticleReadTotal.Value != hasArticleReadTotal))
            throw new InvalidOperationException("The article read total schema presence does not match the requested operation.");
        var hasPropertySnapshots = await HasPropertySnapshotsAsync(connection, transaction, cancellationToken);
        var hasSitePasskeyNames = await HasSitePasskeyNamesAsync(connection, transaction, cancellationToken);
        var expectedColumns = Columns.Select(column => hasArticleSummary && column == ArticleRevisionColumns
                ? ArticleRevisionColumns + " author_summary:text?" : column)
            .Concat(CommunicationColumns).Concat(TaxonomyColumns).Concat(legacyCanvas ? LegacyCanvasColumns : CanvasColumns).Concat(PropertyColumns)
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
            .Concat(requireRevisionHistory ? RevisionHistoryColumns : [])
            .Concat(requireAdminIdentity ? GetAdminIdentityColumns(adminIdentityVersion) : [])
            .Concat(requirePublicationHistory ? (hasAdminArticleRollback ? PublicationHistoryColumnsForAdminRollback : PublicationHistoryColumns) : [])
            .Concat(hasPublicationMedia ? PublicationMediaColumns : [])
            .Concat(hasPublicationCover ? PublicationCoverColumns : [])
            .Concat(requireArticleSchedule ? ArticleScheduleColumns : [])
            .Concat(requireMediaUpload ? MediaUploadColumns : [])
            .Concat(requireArticleMedia.Value ? ArticleMediaColumns : [])
            .Concat(hasArticleCover ? ArticleCoverColumns : [])
            .Concat(requireSubscription.Value ? SiteSubscriptionColumns : [])
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
            .Concat(requireAuthoringWorkspace.Value ? GetAuthoringWorkspaceColumns(hasWorkspaceLayout, hasWorkspaceGroups) : [])
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
            .Concat(requirePublicationRights ? PublicationRightsColumns : [])
            .Concat(hasPublicationCanonical ? PublicationCanonicalColumns : [])
            .Concat(hasPublicationProof ? GetPublicationProofColumns(publicationTransparency) : [])
            .Concat(hasPublicationTransparency ? PublicationTransparencyColumns : [])
            .Concat(hasPublicationHead ? PublicationHeadColumns : [])
            .Concat(hasArticleRead ? ArticleReadColumns : [])
            .Concat(hasArticleReadTotal ? ArticleReadTotalColumns : [])
            .Concat(!legacyCanvas && requireCanvasHistory ? CanvasHistoryColumns : [])
            .Concat(requireRecoveryScope ? RecoveryScopeColumns : []).ToArray();
        var expectedConstraints = Constraints.Concat(hasArticleSummary ? [ArticleSummaryConstraint] : [])
            .Concat(CommunicationConstraints).Concat(TaxonomyConstraints).Concat(legacyCanvas ? LegacyCanvasConstraints : CanvasConstraints)
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
            .Concat(requireRevisionHistory ? RevisionHistoryConstraints : [])
            .Concat(requireAdminIdentity ? GetAdminIdentityConstraints(adminIdentityVersion) : [])
            .Concat(requirePublicationHistory ? PublicationHistoryConstraints : [])
            .Concat(hasPublicationMedia ? PublicationMediaConstraints : [])
            .Concat(hasAdminArticleRollback ? PublicationHistoryAdminRollbackConstraints : [])
            .Concat(requireArticleSchedule ? ArticleScheduleConstraints : [])
            .Concat(requireMediaUpload ? MediaUploadConstraints : [])
            .Concat(requireArticleMedia.Value ? ArticleMediaConstraints : [])
            .Concat(hasArticleCover ? ArticleCoverConstraints : [])
            .Concat(requireSubscription.Value ? SiteSubscriptionConstraints : [])
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
            .Concat(requireAuthoringWorkspace.Value ? AuthoringWorkspaceConstraints : [])
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
            .Concat(requirePublicationRights ? PublicationRightsConstraints : [])
            .Concat(hasPublicationCanonical ? PublicationCanonicalConstraints : [])
            .Concat(hasPublicationCanonical ? [PublicationCanonicalVersionConstraint(hasPublicationCover)] : [])
            .Concat(hasPublicationCover ? PublicationCoverConstraints : [])
            .Concat(hasPublicationProof ? PublicationProofConstraints : [])
            .Concat(hasPublicationTransparency ? PublicationTransparencyConstraints : [])
            .Concat(hasPublicationHead ? PublicationHeadConstraints : [])
            .Concat(hasArticleRead ? ArticleReadConstraints : [])
            .Concat(hasArticleReadTotal ? ArticleReadTotalConstraints : [])
            .Concat(!legacyCanvas && requireCanvasHistory ? CanvasHistoryConstraints : [])
            .Concat(requireRecoveryScope ? RecoveryScopeConstraints : []).ToArray();
        var webpMedia = await VerifyRelationsAsync(connection, transaction, expectedColumns, expectedConstraints, cancellationToken);
        RequireSchemaPresence(requireArticleSummary, hasArticleSummary,
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
                                                      'admin_article_trash_step_up')
                                         AND target.relname = 'admin_session')
                                     OR (c.relname = 'site_session_refresh_tombstone' AND target.relname = 'site_session_refresh')
                                     OR (c.relname = 'author_document_export' AND target.relname IN ('blog_user', 'article_revision'))
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
