using System.Data;
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
        var hasArticleCover = CheckPresence(media.ArticleCover, catalog.HasRelation(ArticleCoverRelation),
            "The saved article cover");
        if (hasArticleCover && !hasArticleMedia)
            throw new InvalidOperationException("Saved article covers require the article attachment schema.");
        var hasPrivateMediaImportOrigin = PrivateMediaImportRelations.IsPresent(catalog);
        var hasLegacyReleaseOrigin = catalog.HasRelation(LegacyReleaseOriginRelation);
        if (hasPrivateMediaImportOrigin && !hasArticleMedia)
            throw new InvalidOperationException("Imported private media requires the article attachment schema.");
        var hasSubscription = site.Subscription ?? catalog.HasRelation(SiteSubscriptionRelation);
        var hasRecoveryKey = CheckPresence(site.RecoveryKey, SiteRecoveryKeyRelations.IsPresent(catalog),
            "The site Recovery Key");
        var hasAdminInboxReply = CheckPresence(adminInbox.Reply, catalog.HasRelation(AdminInboxReplyRelation),
            "The administrator inbox reply");
        var hasAdminInboxStatus = CheckPresence(adminInbox.Status, catalog.HasRelation(AdminInboxStatusRelation),
            "The administrator inbox status");
        var hasAdminInboxNotice = CheckPresence(adminInbox.Notice, catalog.HasRelation(AdminInboxNoticeRelation),
            "The administrator inbox notice");
        var hasAdminInboxRead = CheckPresence(adminInbox.Read, catalog.HasRelation(AdminInboxReadRelation),
            "The shared administrator inbox read");
        var hasAuthoringWorkspace = authoring.Workspace ?? catalog.HasRelation(AuthoringWorkspaceRelation);
        var hasSiteRefresh = CheckPresence(site.Refresh, SiteRefreshRelations.IsPresent(catalog),
            "The site refresh");
        var hasSitePageEditor = CheckPresence(site.PageEditor, SitePageEditorRelations.IsPresent(catalog),
            "The site page editor");
        var hasSiteConfigOverride = CheckPresence(site.ConfigEditor, SiteConfigOverrideRelations.IsPresent(catalog),
            "The site configuration override");
        var hasAppearanceActivation = CheckPresence(site.AppearanceActivation, AppearanceActivationRelations.IsPresent(catalog),
            "The signed appearance");
        var hasRootCommentPowPolicy = CheckPresence(comments.RootPowPolicy, RootCommentPowPolicyRelations.IsPresent(catalog),
            "The root comment proof policy", prerequisitesMet: core.AdminIdentity);
        var hasSavedViews = CheckPresence(authoring.SavedViews, SavedViewRelations.IsPresent(catalog),
            "The saved views");
        var hasSavedViewPlacement = CheckPresence(authoring.SavedViewPlacement, SavedViewPlacementRelations.IsPresent(catalog),
            "The saved view placement", prerequisitesMet: hasSavedViews);
        var hasAdminTagMetadata = CheckPresence(adminContent.TagMetadata, AdminTagMetadataRelations.IsPresent(catalog),
            "The administrator tag metadata");
        var hasAdminCategoryMetadata = AdminCategoryMetadataRelations.IsPresent(catalog);
        if (hasAdminCategoryMetadata && !hasAdminTagMetadata)
            throw new InvalidOperationException("The administrator category metadata schema requires the taxonomy epoch.");
        if (adminContent.CategoryMetadata is bool requiredCategoryMetadata && requiredCategoryMetadata != hasAdminCategoryMetadata)
            throw new InvalidOperationException("The administrator category metadata schema is unavailable. Run category-metadata with the server stopped.");
        var hasAdminArticleRollback = CheckPresence(adminContent.ArticleRollback, HasAdminArticleRollbackSchema(catalog),
            "The administrator article rollback");
        var hasAdminArticleDraftRollback = hasAdminArticleRollback &&
            HasAdminArticleDraftRollbackSchema(catalog);
        var hasAdminArticleArchive = hasAdminArticleDraftRollback &&
            HasAdminArticleArchiveSchema(catalog);
        var hasAdminArticleTrashPublication = hasAdminArticleArchive &&
            HasAdminArticleTrashPublicationSchema(catalog);
        var hasAdminArticleTrashRestore = AdminArticleTrashRestoreRelations.IsPresent(catalog);
        if (hasAdminArticleTrashRestore && !core.AdminIdentity)
            throw new InvalidOperationException("Administrator trash restoration requires independent administrator identity.");
        CheckPresence(adminContent.ArticleTrashRestore, hasAdminArticleTrashRestore, "The administrator trash restore");
        var requireModerationVersion = core.AdminIdentity;
        var hasCommentAuthorDelete = CommentAuthorDeleteRelations.IsPresent(catalog);
        if (hasCommentAuthorDelete && !requireModerationVersion)
            throw new InvalidOperationException("Comment author deletion requires the current comment version column.");
        var hasCommentAuthorEdit = CheckPresence(comments.AuthorEdit, CommentAuthorEditRelations.IsPresent(catalog),
            "Comment author edit", prerequisitesMet: hasCommentAuthorDelete);
        string[] commentAuthorEditConstraints = hasCommentAuthorEdit
            ? ReadCommentAuthorEditConstraints(catalog) : [];
        var hasCommentReport = CheckPresence(comments.Report, catalog.HasRelation(CommentReportRelation),
            "Comment report");
        var hasCommentAppeal = CheckPresence(comments.Appeal, CommentAppealRelations.IsPresent(catalog),
            "Comment appeal", prerequisitesMet: hasCommentAuthorDelete);
        var hasCommentReplies = CheckPresence(comments.Replies, catalog.HasRelation(CommentReplyRelation),
            "Comment reply notice", prerequisitesMet: hasCommentAuthorDelete);
        var hasAdminCommentBatch = CheckPresence(comments.AdminBatch, AdminCommentBatchRelations.IsPresent(catalog),
            "Administrator comment batch", prerequisitesMet: requireModerationVersion);
        var hasWorkspaceLayout = hasAuthoringWorkspace && HasAuthoringWorkspaceLayout(catalog);
        var hasWorkspaceGroups = CheckPresence(authoring.WorkspaceGroups, hasAuthoringWorkspace && HasAuthoringWorkspaceGroups(catalog),
            "The authoring workspace group", prerequisitesMet: hasWorkspaceLayout);
        var hasAuthorRecentOpens = CheckPresence(authoring.RecentOpens, AuthorRecentOpenRelations.IsPresent(catalog),
            "The author recent opens", prerequisitesMet: core.RecoveryScope);
        var hasAuthorTextIndex = CheckPresence(authorText.Index, HasAuthorTextIndex(catalog),
            "The author full-text index");
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
        var hasAuthorTextRebuild = catalog.HasRelation(AuthorTextRebuildRelation);
        if (hasAuthorTextRebuild && !hasAuthorTextPropertyIndex || authorText.Rebuild && !hasAuthorTextRebuild)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install autonomous indexing.");
        var hasArticleSummary = HasArticleSummary(catalog);
        var hasDocumentExports = catalog.HasRelation(DocumentExportsRelation);
        var currentDocumentExportProvider = hasDocumentExports &&
            HasCurrentDocumentExportProvider(catalog);
        var hasDocumentExportAttachments = hasDocumentExports &&
            HasDocumentExportAttachments(catalog);
        var hasExportImageList = hasDocumentExportAttachments &&
            HasDocumentExportAttachments(catalog, list: true);
        var exportImageScope = hasExportImageList
            ? ReadExportImageScope(catalog) : ExportImageScope.Html;
        CheckPresence(authoring.DocumentExports, hasDocumentExports, "The document export");
        var hasArticleBodyInsertion = BodyInsertionTable.IsPresent(catalog);
        var hasArticleBodyInsertionOperations = hasArticleBodyInsertion &&
            BodyInsertionOperations.IsPresent(catalog);
        var hasArticleBodyEdits = hasArticleBodyInsertionOperations &&
            BodyEditTexts.IsPresent(catalog);
        var hasPublicationCanonical = CheckPresence(publication.Canonical, catalog.HasRelation(PublicationCanonicalRelation),
            "The native publication canonical", prerequisitesMet: core.PublicationHistory && core.PublicationRights);
        var hasPublicationMedia = CheckPresence(media.PublicationMedia, catalog.HasRelation(PublicationMediaRelation),
            "The article publication media", prerequisitesMet: core.PublicationHistory && hasArticleMedia);
        var hasPublicationCover = catalog.HasRelation(PublicationCoverRelation);
        if (hasPublicationCover && (!hasPublicationMedia || !hasPublicationCanonical || !hasArticleCover))
            throw new InvalidOperationException("Public article covers require author covers, selected publication media, and canonical storage.");
        CheckPresence(media.PublicationCover, hasPublicationCover, "The public article cover");
        var hasPublicationProof = CheckPresence(publication.Proof, PublicationProofRelations.IsPresent(catalog),
            "The native publication proof", prerequisitesMet: hasPublicationCanonical);
        var publicationTransparency = PublicationTransparencyState(catalog);
        var hasPublicationTransparency = CheckPresence(publication.Transparency, publicationTransparency.HasValue,
            "The native publication transparency", prerequisitesMet: hasPublicationProof);
        var hasPublicationHead = CheckPresence(publication.Head, catalog.HasRelation(PublicationHeadRelation),
            "The native publication head", prerequisitesMet: hasPublicationTransparency);
        var hasSiteTraffic = catalog.HasRelation(SiteTrafficRelation);
        var hasArticleRead = CheckPresence(publication.ArticleRead, ArticleReadRelations.IsPresent(catalog),
            "The article read aggregate");
        // Retained as a dedicated index/opclass/sort-order probe rather than folded into CatalogPresenceSnapshot.
        var hasArticleReadTotal = CheckPresence(publication.ArticleReadTotal, await HasArticleReadTotalSchemaAsync(connection, transaction, cancellationToken),
            "The article read total", prerequisitesMet: hasArticleRead);
        var hasPropertySnapshots = PropertySnapshotTable.IsPresent(catalog);
        var hasSitePasskeyNames = catalog.HasRelation(SitePasskeyNameRelation);
        SchemaFacts?[] features =
        [
            new(Columns.Select(column => hasArticleSummary && column == ArticleRevisionColumns
                    ? ArticleRevisionColumns + " author_summary:text?" : column), Constraints),
            hasArticleSummary ? new([], [ArticleSummaryConstraint]) : null,
            CommunicationShape,
            TaxonomyShape,
            core.LegacyCanvas ? LegacyCanvasShape : CanvasShape,
            PropertyShape,
            hasPropertySnapshots ? PropertySnapshotShape : null,
            PasskeyShape,
            hasSitePasskeyNames ? SitePasskeyNameShape : null,
            MfaShape,
            new(GetCommentColumns(requireModerationVersion), GetCommentConstraints(requireModerationVersion)),
            new(hasPrivateMediaImportOrigin ? PrivateMediaImportColumns : MediaColumns, MediaConstraints),
            hasPrivateMediaImportOrigin ? new([], PrivateMediaImportConstraints) : null,
            hasLegacyReleaseOrigin ? LegacyReleaseOriginShape : null,
            hasCommentAuthorDelete ? CommentAuthorDeleteShape : null,
            hasCommentAuthorEdit ? new(CommentAuthorEditColumns, commentAuthorEditConstraints) : null,
            hasCommentReport ? CommentReportShape : null,
            hasCommentAppeal ? CommentAppealShape : null,
            hasCommentReplies ? CommentReplyShape : null,
            hasAdminCommentBatch ? AdminCommentBatchShape : null,
            core.RevisionHistory ? RevisionHistoryShape : null,
            core.AdminIdentity ? AdminIdentityShape : null,
            core.PublicationHistory
                ? new(hasAdminArticleRollback ? PublicationHistoryColumnsForAdminRollback : PublicationHistoryColumns,
                    PublicationHistoryConstraints)
                : null,
            hasPublicationMedia ? PublicationMediaShape : null,
            hasPublicationCover ? new(PublicationCoverColumns, []) : null,
            hasAdminArticleRollback ? new([], PublicationHistoryAdminRollbackConstraints) : null,
            core.ArticleSchedule ? ArticleScheduleShape : null,
            core.MediaUpload ? MediaUploadShape : null,
            hasArticleMedia ? ArticleMediaShape : null,
            hasArticleCover ? ArticleCoverShape : null,
            hasSubscription ? SiteSubscriptionShape : null,
            hasRecoveryKey ? SiteRecoveryKeyShape : null,
            hasSiteRefresh ? SiteRefreshShape : null,
            hasSitePageEditor ? SitePageEditorShape : null,
            hasSiteConfigOverride ? SiteConfigOverrideShape : null,
            hasAppearanceActivation ? AppearanceActivationShape : null,
            hasRootCommentPowPolicy ? RootCommentPowPolicyShape : null,
            hasSavedViews ? SavedViewShape : null,
            hasSavedViewPlacement ? SavedViewPlacementShape : null,
            hasAdminTagMetadata ? AdminTagMetadataShape : null,
            hasAdminCategoryMetadata ? AdminCategoryMetadataShape : null,
            hasAdminArticleRollback
                ? new(GetAdminArticleRollbackColumns(hasAdminArticleDraftRollback, hasAdminArticleArchive, hasAdminArticleTrashPublication),
                    GetAdminArticleRollbackConstraints(hasAdminArticleDraftRollback, hasAdminArticleArchive, hasAdminArticleTrashPublication))
                : null,
            hasAdminArticleTrashRestore ? AdminArticleTrashRestoreShape : null,
            hasAuthoringWorkspace
                ? new(GetAuthoringWorkspaceColumns(hasWorkspaceLayout, hasWorkspaceGroups), AuthoringWorkspaceConstraints)
                : null,
            hasWorkspaceGroups ? new([], AuthoringWorkspaceGroupsConstraints) : null,
            hasAuthorRecentOpens ? AuthorRecentOpenShape : null,
            hasArticleBodyInsertion
                ? new([ArticleBodyInsertionColumns(hasArticleBodyInsertionOperations, hasArticleBodyEdits)],
                    ArticleBodyInsertionConstraints(hasArticleBodyInsertionOperations, hasArticleBodyEdits))
                : null,
            hasDocumentExports
                ? DocumentExportShape(hasDocumentExportAttachments, hasExportImageList, currentDocumentExportProvider, exportImageScope)
                : null,
            hasAuthorTextIndex
                ? new(AuthorTextIndexColumns(hasAuthorTextSummaryIndex, hasAuthorTextHeadingIndex),
                    AuthorTextIndexConstraints(hasAuthorTextSummaryIndex, hasAuthorTextHeadingIndex))
                : null,
            hasAuthorTextPropertyIndex ? AuthorTextPropertyIndexShape : null,
            hasAuthorTextRebuild ? AuthorTextRebuildShape : null,
            hasAdminInboxReply ? AdminInboxReplyShape : null,
            hasAdminInboxStatus ? AdminInboxStatusShape : null,
            hasAdminInboxNotice ? AdminInboxNoticeShape : null,
            hasAdminInboxRead ? AdminInboxReadShape : null,
            core.PublicationRights ? PublicationRightsShape : null,
            hasPublicationCanonical
                ? new(PublicationCanonicalColumns, PublicationCanonicalConstraints.Append(PublicationCanonicalVersionConstraint(hasPublicationCover)))
                : null,
            hasPublicationCover ? new([], PublicationCoverConstraints) : null,
            hasPublicationProof ? new(GetPublicationProofColumns(publicationTransparency), PublicationProofConstraints) : null,
            hasPublicationTransparency ? new(PublicationTransparencyColumns, PublicationTransparencyConstraints) : null,
            hasPublicationHead ? new(PublicationHeadColumns, PublicationHeadConstraints) : null,
            hasSiteTraffic ? SiteTrafficShape : null,
            hasArticleRead ? ArticleReadShape : null,
            hasArticleReadTotal ? ArticleReadTotalShape : null,
            !core.LegacyCanvas && core.CanvasHistory ? CanvasHistoryShape : null,
            core.RecoveryScope ? RecoveryScopeShape : null
        ];
        var expectedColumns = features.SelectMany(feature => feature?.Columns ?? []).ToArray();
        var expectedConstraints = features.SelectMany(feature => feature?.Constraints ?? []).ToArray();
        var webpMedia = await VerifyRelationsAsync(connection, transaction, expectedColumns, expectedConstraints, cancellationToken);
        CheckPresence(authoring.ArticleSummary, hasArticleSummary, "The article author summary");
        if (hasSitePageEditor) await SitePageCoordinates.VerifyAsync(connection, transaction, cancellationToken);
        if (hasSiteConfigOverride) await SiteConfigOverride.VerifyAsync(connection, transaction, cancellationToken);
        if (hasAdminTagMetadata) await TaxonomyEpoch(hasAdminCategoryMetadata).VerifyAsync(connection, transaction, cancellationToken);
        if (hasAppearanceActivation) await AppearanceActivation.VerifyAsync(connection, transaction, cancellationToken);
        if (hasRootCommentPowPolicy) await RootCommentPowPolicy.VerifyAsync(connection, transaction, cancellationToken);
        if (hasArticleRead) await ArticleReadEpoch.VerifyAsync(connection, transaction, cancellationToken);
        if (hasAuthorTextIndex) await AuthorTextArticleOwnerIndex.VerifyAsync(connection, transaction, cancellationToken);
        if (hasDocumentExports) await VerifyDocumentExportIndexesAsync(connection, transaction, cancellationToken);
        return webpMedia;
    }

    private sealed record SchemaFacts(IEnumerable<string> Columns, IEnumerable<string> Constraints);

    private static SchemaFacts DocumentExportShape(
        bool attachments, bool imageList, bool currentProvider, ExportImageScope scope)
    {
        var columns = DocumentExportColumns + (attachments ? " attachment_id:uuid?" : "") + (imageList ? " attachment_ids:_uuid?" : "");
        var constraints = DocumentExportConstraints.ToList();
        if (attachments)
        {
            constraints.Add($"author_document_export c provider provider>=1ANDprovider<={(imageList ? 4 : 3)}");
            constraints.Add("author_document_export c provider,attachment_id (provider=3)=(attachment_idISNOTNULL)");
        }
        else
            constraints.Add(currentProvider ? "author_document_export c provider provider>=1ANDprovider<=2"
                : "author_document_export c provider provider=1");
        if (imageList)
        {
            constraints.Add("author_document_export c provider,attachment_ids (provider=4)=(attachment_idsISNOTNULL)");
            constraints.Add($"author_document_export c attachment_ids,format {ExportImageListCondition(scope)}");
        }
        return new([columns], constraints);
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
                                   AND ((c.relname IN ('admin_step_up', 'admin_site_page_step_up', 'admin_site_config_step_up',
                                                      'admin_article_rollback_step_up',
                                                      'admin_appearance_step_up', 'comment_appeal_admin_step_up',
                                                      'admin_comment_batch_step_up', 'admin_root_comment_pow_step_up',
                                                      'admin_article_trash_step_up', 'admin_reader_governance_step_up',
                                                      'admin_handle_step_up')
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
