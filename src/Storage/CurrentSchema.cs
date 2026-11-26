using System.Data;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const int Version = 1;

    private static SchemaFacts GetCoreShape(bool hasArticleSummary) => Tables(
        Singleton("v2_schema singleton:bool version:int4"),
        Table("blog_user id:uuid name:text enabled:bool generation:int8", "p id", "u name", Pos("generation")),
        Table("admin_principal id:uuid handle:text user_handle:bytea enabled:bool generation:int8 generation_changed_at:timestamptz=clock_timestamp",
            "p id", "u handle", "c handle handle~'^[a-z][a-z0-9_.-]{0,63}$'::text", "u user_handle", Bytes32("user_handle"), Pos("generation")),
        Table("login_ticket digest:bytea user_id:uuid expires_at:timestamptz",
            "p digest", Bytes32("digest"), "f user_id public.blog_user:id"),
        Table("user_session digest:bytea user_id:uuid generation:int8 expires_at:timestamptz passkey_credential_id:bytea? totp_verified_at:timestamptz?",
            "p digest", Bytes32("digest"), Pos("generation"), "f user_id public.blog_user:id"),
        Table("article id:int4:a owner_id:uuid revision:int8 title:text body:text published_revision:int8? publication_count:int4=0 deleted:bool created_at:timestamptz=now updated_at:timestamptz=now",
            "p id", Pos("revision"), NonNeg("publication_count"), "f owner_id public.admin_principal:id",
            "f id,revision public.article_revision:article_id,revision deferred",
            "f id,published_revision public.article_revision:article_id,revision deferred"),
        Table("article_revision article_id:int4 revision:int8 title:text body:text happened_at:timestamptz" + (hasArticleSummary ? " author_summary:text?" : ""),
            "p article_id,revision", Pos("revision"), "f article_id public.article:id",
            If(hasArticleSummary, "c author_summary char_length(author_summary)>=1ANDchar_length(author_summary)<=512" )),
        Table("article_command actor_id:uuid command_id:uuid fingerprint:bytea article_id:int4 revision:int8 title:text body:text published:bool",
            "p actor_id,command_id", Bytes32("fingerprint"), "f actor_id public.admin_principal:id",
            "f article_id public.article:id", "f article_id,revision public.article_revision:article_id,revision"),
        Table("article_publication article_id:int4 publication_id:int8:d revision:int8 publication_no:int4=1 published_at:timestamptz",
            "p article_id", "u publication_id", Pos("publication_no"), "f article_id public.article:id",
            "f article_id,revision public.article_revision:article_id,revision"),
        Table("blog_outbox id:int8:a article_id:int4 revision:int8 kind:text created_at:timestamptz=now processed_at:timestamptz?",
            "p id", "f article_id public.article:id", "f article_id,revision public.article_revision:article_id,revision"));

    internal static async Task<bool> VerifyAsync(NpgsqlConnection connection, CancellationToken cancellationToken, SchemaAdmission admission = default)
    {
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        await ExecuteAsync(connection, transaction, cancellationToken, "SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog");

        if (await ScalarAsync(connection, transaction, cancellationToken, "SHOW session_replication_role") is not "origin")
            throw new InvalidOperationException("The PostgreSQL session must enforce local integrity triggers.");
        if (await ScalarAsync(connection, transaction, cancellationToken, "SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname='fsus_legacy_candidate')") is true)
            throw new InvalidOperationException("The database is an isolated legacy import candidate and cannot serve.");

        var webpMedia = await VerifyCatalogAsync(connection, transaction, cancellationToken, CatalogVerificationOptions.FromAdmission(admission));
        await VerifyAdminIdentityMarkerAsync(connection, transaction, cancellationToken);
        await ReadRecoverySiteIdAsync(connection, transaction, cancellationToken);
        var markerError = $"Expected a single FsusBlog V2 schema marker at version {Version}.";
        if (await ReadSingleVersionAsync(connection, transaction, "SELECT version FROM public.v2_schema", markerError, cancellationToken) != Version)
            throw new InvalidOperationException(markerError);

        await transaction.CommitAsync(cancellationToken);
        return webpMedia;
    }

    internal static async Task<bool> VerifyCatalogAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken, CatalogVerificationOptions? options = null)
    {
        options ??= CatalogVerificationOptions.Default;
        var (core, site, adminInbox, adminContent) = (options.Core, options.Site, options.AdminInbox, options.AdminContent);
        var (comments, authoring, authorText, media, publication) = (options.Comments, options.Authoring, options.AuthorText, options.Media, options.Publication);
        var catalog = await LoadCatalogPresenceSnapshotAsync(connection, transaction, cancellationToken);

        List<SchemaFacts> shapes = [];
        void AddIf(bool condition, SchemaFacts shape) { if (condition) shapes.Add(shape); }
        bool Optional(bool? required, bool found, string feature, SchemaFacts shape, bool prerequisitesMet = true)
        {
            if (!CheckPresence(required, found, feature, prerequisitesMet)) return false;
            shapes.Add(shape);
            return true;
        }

        var hasArticleSummary = HasArticleSummary(catalog);
        var hasArticleMedia = media.ArticleMedia ?? catalog.HasRelation(ArticleMediaRelation);
        var hasArticleCover = Optional(media.ArticleCover, catalog.HasRelation(ArticleCoverRelation), "The saved article cover", ArticleCoverShape);
        if (hasArticleCover && !hasArticleMedia)
            throw new InvalidOperationException("Saved article covers require the article attachment schema.");
        var hasPrivateMediaImportOrigin = PrivateMediaImportRelations.IsPresent(catalog);
        if (hasPrivateMediaImportOrigin && !hasArticleMedia)
            throw new InvalidOperationException("Imported private media requires the article attachment schema.");

        shapes.AddRange([GetCoreShape(hasArticleSummary), CommunicationShape, TaxonomyShape, CanvasShape,
            PropertyShape, PasskeyShape, MfaShape, GetCommentShape(core.AdminIdentity), GetMediaShape(hasPrivateMediaImportOrigin)]);
        AddIf(hasArticleMedia, ArticleMediaShape);
        AddIf(PropertySnapshotTable.IsPresent(catalog), PropertySnapshotShape);
        AddIf(catalog.HasRelation(SitePasskeyNameRelation), SitePasskeyNameShape);
        AddIf(catalog.HasRelation(LegacyReleaseOriginRelation), LegacyReleaseOriginShape);
        AddIf(core.RevisionHistory, RevisionHistoryShape);
        AddIf(core.AdminIdentity, AdminIdentityShape);
        AddIf(core.ArticleSchedule, ArticleScheduleShape);
        AddIf(core.MediaUpload, MediaUploadShape);
        AddIf(core.PublicationRights, PublicationRightsShape);
        AddIf(core.CanvasHistory, CanvasHistoryShape);
        AddIf(core.RecoveryScope, RecoveryScopeShape);
        AddIf(site.Subscription ?? catalog.HasRelation(SiteSubscriptionRelation), SiteSubscriptionShape);
        AddIf(catalog.HasRelation(SiteTrafficRelation), SiteTrafficShape);

        Optional(site.RecoveryKey, SiteRecoveryKeyRelations.IsPresent(catalog), "The site Recovery Key", SiteRecoveryKeyShape);
        Optional(adminInbox.Reply, catalog.HasRelation(AdminInboxReplyRelation), "The administrator inbox reply", AdminInboxReplyShape);
        Optional(adminInbox.Status, catalog.HasRelation(AdminInboxStatusRelation), "The administrator inbox status", AdminInboxStatusShape);
        Optional(adminInbox.Notice, catalog.HasRelation(AdminInboxNoticeRelation), "The administrator inbox notice", AdminInboxNoticeShape);
        Optional(adminInbox.Read, catalog.HasRelation(AdminInboxReadRelation), "The shared administrator inbox read", AdminInboxReadShape);
        Optional(site.Refresh, SiteRefreshRelations.IsPresent(catalog), "The site refresh", SiteRefreshShape);
        var hasSitePageEditor = Optional(site.PageEditor, SitePageEditorRelations.IsPresent(catalog), "The site page editor", SitePageEditorShape);
        var hasSiteConfigOverride = Optional(site.ConfigEditor, SiteConfigOverrideRelations.IsPresent(catalog), "The site configuration override", SiteConfigOverrideShape);
        var hasAppearanceActivation = Optional(site.AppearanceActivation, AppearanceActivationRelations.IsPresent(catalog), "The signed appearance", AppearanceActivationShape);
        var hasRootCommentPowPolicy = Optional(comments.RootPowPolicy, RootCommentPowPolicyRelations.IsPresent(catalog), "The root comment proof policy", RootCommentPowPolicyShape, core.AdminIdentity);
        var hasSavedViews = Optional(authoring.SavedViews, SavedViewRelations.IsPresent(catalog), "The saved views", SavedViewShape);
        Optional(authoring.SavedViewPlacement, SavedViewPlacementRelations.IsPresent(catalog), "The saved view placement", SavedViewPlacementShape, hasSavedViews);
        var hasAdminTagMetadata = Optional(adminContent.TagMetadata, AdminTagMetadataRelations.IsPresent(catalog), "The administrator tag metadata", AdminTagMetadataShape);

        var hasAdminCategoryMetadata = AdminCategoryMetadataRelations.IsPresent(catalog);
        if (hasAdminCategoryMetadata && !hasAdminTagMetadata)
            throw new InvalidOperationException("The administrator category metadata schema requires the taxonomy epoch.");
        if (adminContent.CategoryMetadata is bool requiredCategoryMetadata && requiredCategoryMetadata != hasAdminCategoryMetadata)
            throw new InvalidOperationException("The administrator category metadata schema is unavailable. Run category-metadata with the server stopped.");
        AddIf(hasAdminCategoryMetadata, AdminCategoryMetadataShape);

        var hasAdminArticleRollback = CheckPresence(adminContent.ArticleRollback, HasAdminArticleRollbackSchema(catalog), "The administrator article rollback");
        if (hasAdminArticleRollback)
        {
            var draft = HasAdminArticleDraftRollbackSchema(catalog);
            var archive = draft && HasAdminArticleArchiveSchema(catalog);
            shapes.Add(GetAdminArticleRollbackShape(draft, archive, archive && HasAdminArticleTrashPublicationSchema(catalog)));
        }
        if (core.PublicationHistory) shapes.Add(GetPublicationHistoryShape(hasAdminArticleRollback));

        var hasAdminArticleTrashRestore = AdminArticleTrashRestoreRelations.IsPresent(catalog);
        if (hasAdminArticleTrashRestore && !core.AdminIdentity)
            throw new InvalidOperationException("Administrator trash restoration requires independent administrator identity.");
        Optional(adminContent.ArticleTrashRestore, hasAdminArticleTrashRestore, "The administrator trash restore", AdminArticleTrashRestoreShape);

        var hasCommentAuthorDelete = CommentAuthorDeleteRelations.IsPresent(catalog);
        if (hasCommentAuthorDelete && !core.AdminIdentity)
            throw new InvalidOperationException("Comment author deletion requires the current comment version column.");
        AddIf(hasCommentAuthorDelete, CommentAuthorDeleteShape);
        if (CheckPresence(comments.AuthorEdit, CommentAuthorEditRelations.IsPresent(catalog), "Comment author edit", hasCommentAuthorDelete))
            shapes.Add(ReadCommentAuthorEditShape(catalog));
        Optional(comments.Report, catalog.HasRelation(CommentReportRelation), "Comment report", CommentReportShape);
        Optional(comments.Appeal, CommentAppealRelations.IsPresent(catalog), "Comment appeal", CommentAppealShape, hasCommentAuthorDelete);
        Optional(comments.Replies, catalog.HasRelation(CommentReplyRelation), "Comment reply notice", CommentReplyShape, hasCommentAuthorDelete);
        Optional(comments.AdminBatch, AdminCommentBatchRelations.IsPresent(catalog), "Administrator comment batch", AdminCommentBatchShape, core.AdminIdentity);

        var hasAuthoringWorkspace = authoring.Workspace ?? catalog.HasRelation(AuthoringWorkspaceRelation);
        var hasWorkspaceLayout = hasAuthoringWorkspace && HasAuthoringWorkspaceLayout(catalog);
        var hasWorkspaceGroups = CheckPresence(authoring.WorkspaceGroups, hasAuthoringWorkspace && HasAuthoringWorkspaceGroups(catalog),
            "The authoring workspace group", hasWorkspaceLayout);
        if (hasAuthoringWorkspace) shapes.Add(GetAuthoringWorkspaceShape(hasWorkspaceLayout, hasWorkspaceGroups));
        Optional(authoring.RecentOpens, AuthorRecentOpenRelations.IsPresent(catalog), "The author recent opens", AuthorRecentOpenShape, core.RecoveryScope);

        var hasAuthorTextIndex = CheckPresence(authorText.Index, HasAuthorTextIndex(catalog), "The author full-text index");
        var hasAuthorTextSummaryIndex = hasAuthorTextIndex && HasAuthorTextSummaryIndex(catalog);
        if (authorText.SummaryIndex && !hasAuthorTextSummaryIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install summary indexing.");
        var hasAuthorTextHeadingIndex = hasAuthorTextIndex && HasAuthorTextHeadingIndex(catalog);
        if (hasAuthorTextHeadingIndex && !hasAuthorTextSummaryIndex || authorText.HeadingIndex && !hasAuthorTextHeadingIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install heading indexing.");
        if (hasAuthorTextIndex) shapes.Add(GetAuthorTextIndexShape(hasAuthorTextSummaryIndex, hasAuthorTextHeadingIndex));
        var hasAuthorTextPropertyIndex = HasAuthorTextPropertyIndex(catalog);
        if (hasAuthorTextPropertyIndex && !hasAuthorTextHeadingIndex || authorText.PropertyIndex && !hasAuthorTextPropertyIndex)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install text property indexing.");
        AddIf(hasAuthorTextPropertyIndex, AuthorTextPropertyIndexShape);
        var hasAuthorTextRebuild = catalog.HasRelation(AuthorTextRebuildRelation);
        if (hasAuthorTextRebuild && !hasAuthorTextPropertyIndex || authorText.Rebuild && !hasAuthorTextRebuild)
            throw new InvalidOperationException("Run the author-search migration with the server stopped to install autonomous indexing.");
        AddIf(hasAuthorTextRebuild, AuthorTextRebuildShape);

        var hasDocumentExports = CheckPresence(authoring.DocumentExports, catalog.HasRelation(DocumentExportsRelation), "The document export");
        if (hasDocumentExports)
        {
            var attachments = HasDocumentExportAttachments(catalog);
            var imageList = attachments && HasDocumentExportAttachments(catalog, list: true);
            shapes.Add(DocumentExportShape(attachments, imageList, HasCurrentDocumentExportProvider(catalog),
                imageList ? ReadExportImageScope(catalog) : ExportImageScope.Html));
        }

        if (BodyInsertionTable.IsPresent(catalog))
        {
            var ops = BodyInsertionOperations.IsPresent(catalog);
            shapes.Add(GetArticleBodyInsertionShape(ops, ops && BodyEditTexts.IsPresent(catalog)));
        }

        var hasPublicationCanonical = CheckPresence(publication.Canonical, catalog.HasRelation(PublicationCanonicalRelation),
            "The native publication canonical", core.PublicationHistory && core.PublicationRights);
        var hasPublicationMedia = Optional(media.PublicationMedia, catalog.HasRelation(PublicationMediaRelation),
            "The article publication media", PublicationMediaShape, core.PublicationHistory && hasArticleMedia);
        var hasPublicationCover = catalog.HasRelation(PublicationCoverRelation);
        if (hasPublicationCover && (!hasPublicationMedia || !hasPublicationCanonical || !hasArticleCover))
            throw new InvalidOperationException("Public article covers require author covers, selected publication media, and canonical storage.");
        Optional(media.PublicationCover, hasPublicationCover, "The public article cover", PublicationCoverShape);
        if (hasPublicationCanonical) shapes.Add(GetPublicationCanonicalShape(hasPublicationCover));

        var hasPublicationProof = CheckPresence(publication.Proof, PublicationProofRelations.IsPresent(catalog),
            "The native publication proof", hasPublicationCanonical);
        var publicationTransparency = PublicationTransparencyState(catalog);
        var hasPublicationTransparency = Optional(publication.Transparency, publicationTransparency.HasValue,
            "The native publication transparency", PublicationTransparencyShape, hasPublicationProof);
        if (hasPublicationProof) shapes.Add(GetPublicationProofShape(publicationTransparency));
        Optional(publication.Head, catalog.HasRelation(PublicationHeadRelation), "The native publication head", PublicationHeadShape, hasPublicationTransparency);

        var hasArticleRead = Optional(publication.ArticleRead, ArticleReadRelations.IsPresent(catalog), "The article read aggregate", ArticleReadShape);
        Optional(publication.ArticleReadTotal, await HasArticleReadTotalSchemaAsync(connection, transaction, cancellationToken),
            "The article read total", ArticleReadTotalShape, hasArticleRead);

        var webpMedia = await VerifyRelationsAsync(connection, transaction,
            shapes.SelectMany(s => s.Columns).ToArray(), shapes.SelectMany(s => s.Constraints).ToArray(), cancellationToken);
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
        command.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = expectedColumns.Select(c => c.Split(' ', 2)[0]).ToArray() });
        List<string> columns = [], constraints = [];
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
            while (await reader.ReadAsync(cancellationToken))
                (reader.GetString(0) == "column" ? columns : constraints).Add(reader.GetString(1));

        var webpMedia = constraints.Contains("private_media c format format>=1ANDformat<=3", StringComparer.Ordinal);
        if (webpMedia) expectedConstraints = expectedConstraints.Select(WithWebpFormat).ToArray();
        AssertShape("relation/column", expectedColumns, columns);
        AssertShape("constraint", expectedConstraints, constraints);
        return webpMedia;
    }

    private static void AssertShape(string kind, string[] expected, List<string> observed)
    {
        if (expected.Order(StringComparer.Ordinal).SequenceEqual(observed.Order(StringComparer.Ordinal))) return;
        var missing = string.Join("; ", expected.Except(observed, StringComparer.Ordinal));
        var unexpected = string.Join("; ", observed.Except(expected, StringComparer.Ordinal));
        throw new InvalidOperationException($"FsusBlog V2 {kind} shape mismatch. Missing [{missing}]. Unexpected [{unexpected}].");
    }
}
