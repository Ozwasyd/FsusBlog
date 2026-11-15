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
        "article_revision article_id:int4 revision:int8 title:text body:text happened_at:timestamptz",
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

    internal static async Task VerifyAsync(NpgsqlConnection connection, CancellationToken cancellationToken,
        bool? requireSubscription = null, bool? requireRecoveryKey = null, bool? requireAdminInboxReply = null, bool? requireSiteRefresh = null, bool? requireSitePageEditor = null, bool? requireAdminArticleRollback = null, bool? requireAdminInboxStatus = null, bool? requireAdminInboxNotice = null, bool? requireAppearanceActivation = null, bool? requireAdminTagMetadata = null, bool? requireAdminInboxRead = null,
        bool? requirePublicationMedia = null, bool? requireAdminCommentBatch = null)
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

        await VerifyCatalogAsync(connection, transaction, cancellationToken, requireArticleMedia: true,
            requireSubscription: requireSubscription, requireRecoveryKey: requireRecoveryKey, requireAdminInboxReply: requireAdminInboxReply, requireSiteRefresh: requireSiteRefresh,
            requireSitePageEditor: requireSitePageEditor, requireAdminArticleRollback: requireAdminArticleRollback, requireAdminInboxStatus: requireAdminInboxStatus, requireAdminInboxNotice: requireAdminInboxNotice, requireAppearanceActivation: requireAppearanceActivation, requireAdminTagMetadata: requireAdminTagMetadata, requireAdminInboxRead: requireAdminInboxRead,
            requirePublicationMedia: requirePublicationMedia, requireAdminCommentBatch: requireAdminCommentBatch);
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
    }

    internal static async Task VerifyCatalogAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
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
        bool? requireArticleReadTotal = null)
    {
        if (requireArticleMedia is null)
        {
            await using var relation = new NpgsqlCommand("SELECT pg_catalog.to_regclass('public.article_revision_media') IS NOT NULL", connection, transaction);
            requireArticleMedia = await relation.ExecuteScalarAsync(cancellationToken) is true;
        }
        if (requireSubscription is null)
        {
            await using var relation = new NpgsqlCommand("SELECT pg_catalog.to_regclass($1) IS NOT NULL", connection, transaction);
            relation.Parameters.AddWithValue(SiteSubscriptionRelation);
            requireSubscription = await relation.ExecuteScalarAsync(cancellationToken) is true;
        }
        var hasRecoveryKey = await HasSiteRecoveryKeySchemaAsync(connection, transaction, cancellationToken);
        if (requireRecoveryKey.HasValue && requireRecoveryKey.Value != hasRecoveryKey)
            throw new InvalidOperationException("The site Recovery Key schema presence does not match the requested operation.");
        await using var adminInboxRelation = new NpgsqlCommand("SELECT pg_catalog.to_regclass($1) IS NOT NULL", connection, transaction);
        adminInboxRelation.Parameters.AddWithValue(AdminInboxReplyRelation);
        var hasAdminInboxReply = await adminInboxRelation.ExecuteScalarAsync(cancellationToken) is true;
        if (requireAdminInboxReply.HasValue && requireAdminInboxReply.Value != hasAdminInboxReply)
            throw new InvalidOperationException("The administrator inbox reply schema presence does not match the requested operation.");
        await using var adminInboxStatusRelation = new NpgsqlCommand("SELECT pg_catalog.to_regclass($1) IS NOT NULL", connection, transaction);
        adminInboxStatusRelation.Parameters.AddWithValue(AdminInboxStatusRelation);
        var hasAdminInboxStatus = await adminInboxStatusRelation.ExecuteScalarAsync(cancellationToken) is true;
        if (requireAdminInboxStatus.HasValue && requireAdminInboxStatus.Value != hasAdminInboxStatus)
            throw new InvalidOperationException("The administrator inbox status schema presence does not match the requested operation.");
        await using var adminInboxNoticeRelation = new NpgsqlCommand("SELECT pg_catalog.to_regclass($1) IS NOT NULL", connection, transaction);
        adminInboxNoticeRelation.Parameters.AddWithValue(AdminInboxNoticeRelation);
        var hasAdminInboxNotice = await adminInboxNoticeRelation.ExecuteScalarAsync(cancellationToken) is true;
        if (requireAdminInboxNotice.HasValue && requireAdminInboxNotice.Value != hasAdminInboxNotice)
            throw new InvalidOperationException("The administrator inbox notice schema presence does not match the requested operation.");
        await using var adminInboxReadRelation = new NpgsqlCommand("SELECT pg_catalog.to_regclass($1) IS NOT NULL", connection, transaction);
        adminInboxReadRelation.Parameters.AddWithValue(AdminInboxReadRelation);
        var hasAdminInboxRead = await adminInboxReadRelation.ExecuteScalarAsync(cancellationToken) is true;
        if (requireAdminInboxRead.HasValue && requireAdminInboxRead.Value != hasAdminInboxRead)
            throw new InvalidOperationException("The shared administrator inbox read schema presence does not match the requested operation.");
        if (requireAuthoringWorkspace is null)
        {
            await using var relation = new NpgsqlCommand("SELECT pg_catalog.to_regclass($1) IS NOT NULL", connection, transaction);
            relation.Parameters.AddWithValue(AuthoringWorkspaceRelation);
            requireAuthoringWorkspace = await relation.ExecuteScalarAsync(cancellationToken) is true;
        }
        var hasSiteRefresh = await HasSiteRefreshSchemaAsync(connection, transaction, cancellationToken);
        if (requireSiteRefresh.HasValue && requireSiteRefresh.Value != hasSiteRefresh)
            throw new InvalidOperationException("The site refresh schema presence does not match the requested operation.");
        var hasSitePageEditor = await HasSitePageEditorSchemaAsync(connection, transaction, cancellationToken);
        if (requireSitePageEditor.HasValue && requireSitePageEditor.Value != hasSitePageEditor)
            throw new InvalidOperationException("The site page editor schema presence does not match the requested operation.");
        var hasAppearanceActivation = await HasAppearanceActivationAsync(connection, transaction, cancellationToken);
        if (requireAppearanceActivation.HasValue && requireAppearanceActivation.Value != hasAppearanceActivation)
            throw new InvalidOperationException("The signed appearance schema presence does not match the requested operation.");
        var hasSavedViews = await HasSavedViewsAsync(connection, transaction, cancellationToken);
        if (requireSavedViews.HasValue && requireSavedViews.Value != hasSavedViews)
            throw new InvalidOperationException("The saved views schema presence does not match the requested operation.");
        var hasSavedViewPlacement = await HasSavedViewPlacementAsync(connection, transaction, cancellationToken);
        if ((hasSavedViewPlacement && !hasSavedViews) || (requireSavedViewPlacement.HasValue && requireSavedViewPlacement.Value != hasSavedViewPlacement))
            throw new InvalidOperationException("The saved view placement schema presence does not match the requested operation.");
        var hasAdminTagMetadata = await HasAdminTagMetadataAsync(connection, transaction, cancellationToken);
        if (requireAdminTagMetadata.HasValue && requireAdminTagMetadata.Value != hasAdminTagMetadata)
            throw new InvalidOperationException("The administrator tag metadata schema presence does not match the requested operation.");
        var hasAdminArticleRollback = await HasAdminArticleRollbackSchemaAsync(connection, transaction, cancellationToken);
        if (requireAdminArticleRollback.HasValue && requireAdminArticleRollback.Value != hasAdminArticleRollback)
            throw new InvalidOperationException("The administrator article rollback schema presence does not match the requested operation.");
        var hasAdminArticleDraftRollback = hasAdminArticleRollback &&
            await HasAdminArticleDraftRollbackSchemaAsync(connection, transaction, cancellationToken);
        var requireModerationVersion = requireAdminIdentity && adminIdentityVersion >= AdminModerationVersion;
        var hasCommentAuthorDelete = await HasCommentAuthorDeleteSchemaAsync(connection, transaction, cancellationToken);
        if (hasCommentAuthorDelete && !requireModerationVersion)
            throw new InvalidOperationException("Comment author deletion requires the current comment version column.");
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
        var hasPublicationCanonical = await HasPublicationCanonicalAsync(connection, transaction, cancellationToken);
        if ((hasPublicationCanonical && (!requirePublicationHistory || !requirePublicationRights)) ||
            (requirePublicationCanonical.HasValue && requirePublicationCanonical.Value != hasPublicationCanonical))
            throw new InvalidOperationException("The native publication canonical schema presence does not match the requested operation.");
        var hasPublicationMedia = await HasPublicationMediaAsync(connection, transaction, cancellationToken);
        if ((hasPublicationMedia && (!requirePublicationHistory || !requireArticleMedia.Value)) ||
            (requirePublicationMedia.HasValue && requirePublicationMedia.Value != hasPublicationMedia))
            throw new InvalidOperationException("The article publication media schema presence does not match the requested operation.");
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
        if (requireArticleRead.HasValue && requireArticleRead.Value != hasArticleRead)
            throw new InvalidOperationException("The article read aggregate schema presence does not match the requested operation.");
        var hasArticleReadTotal = await HasArticleReadTotalSchemaAsync(connection, transaction, cancellationToken);
        if ((hasArticleReadTotal && !hasArticleRead) || (requireArticleReadTotal.HasValue && requireArticleReadTotal.Value != hasArticleReadTotal))
            throw new InvalidOperationException("The article read total schema presence does not match the requested operation.");
        var expectedColumns = Columns.Concat(CommunicationColumns).Concat(TaxonomyColumns).Concat(legacyCanvas ? LegacyCanvasColumns : CanvasColumns).Concat(PropertyColumns)
            .Concat(PasskeyColumns).Concat(MfaColumns).Concat(GetCommentColumns(requireModerationVersion)).Concat(MediaColumns)
            .Concat(hasCommentAuthorDelete ? CommentAuthorDeleteColumns : [])
            .Concat(hasCommentAppeal ? CommentAppealColumns : [])
            .Concat(hasCommentReplies ? CommentReplyColumns : [])
            .Concat(hasAdminCommentBatch ? AdminCommentBatchColumns : [])
            .Concat(requireRevisionHistory ? RevisionHistoryColumns : [])
            .Concat(requireAdminIdentity ? GetAdminIdentityColumns(adminIdentityVersion) : [])
            .Concat(requirePublicationHistory ? (hasAdminArticleRollback ? PublicationHistoryColumnsForAdminRollback : PublicationHistoryColumns) : [])
            .Concat(hasPublicationMedia ? PublicationMediaColumns : [])
            .Concat(requireArticleSchedule ? ArticleScheduleColumns : [])
            .Concat(requireMediaUpload ? MediaUploadColumns : [])
            .Concat(requireArticleMedia.Value ? ArticleMediaColumns : [])
            .Concat(requireSubscription.Value ? SiteSubscriptionColumns : [])
            .Concat(hasRecoveryKey ? SiteRecoveryKeyColumns : [])
            .Concat(hasSiteRefresh ? SiteRefreshColumns : [])
            .Concat(hasSitePageEditor ? SitePageEditorColumns : [])
            .Concat(hasAppearanceActivation ? AppearanceActivationColumns : [])
            .Concat(hasSavedViews ? SavedViewColumns : [])
            .Concat(hasSavedViewPlacement ? SavedViewPlacementColumns : [])
            .Concat(hasAdminTagMetadata ? AdminTagMetadataColumns : [])
            .Concat(hasAdminArticleRollback ? GetAdminArticleRollbackColumns(hasAdminArticleDraftRollback) : [])
            .Concat(requireAuthoringWorkspace.Value ? GetAuthoringWorkspaceColumns(hasWorkspaceLayout, hasWorkspaceGroups) : [])
            .Concat(hasAuthorRecentOpens ? AuthorRecentOpenColumns : [])
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
        var expectedConstraints = Constraints.Concat(CommunicationConstraints).Concat(TaxonomyConstraints).Concat(legacyCanvas ? LegacyCanvasConstraints : CanvasConstraints)
            .Concat(PropertyConstraints).Concat(PasskeyConstraints).Concat(MfaConstraints).Concat(GetCommentConstraints(requireModerationVersion)).Concat(MediaConstraints)
            .Concat(hasCommentAuthorDelete ? CommentAuthorDeleteConstraints : [])
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
            .Concat(requireSubscription.Value ? SiteSubscriptionConstraints : [])
            .Concat(hasRecoveryKey ? SiteRecoveryKeyConstraints : [])
            .Concat(hasSiteRefresh ? SiteRefreshConstraints : [])
            .Concat(hasSitePageEditor ? SitePageEditorConstraints : [])
            .Concat(hasAppearanceActivation ? AppearanceActivationConstraints : [])
            .Concat(hasSavedViews ? SavedViewConstraints : [])
            .Concat(hasSavedViewPlacement ? SavedViewPlacementConstraints : [])
            .Concat(hasAdminTagMetadata ? AdminTagMetadataConstraints : [])
            .Concat(hasAdminArticleRollback ? GetAdminArticleRollbackConstraints(hasAdminArticleDraftRollback) : [])
            .Concat(requireAuthoringWorkspace.Value ? AuthoringWorkspaceConstraints : [])
            .Concat(hasWorkspaceGroups ? AuthoringWorkspaceGroupsConstraints : [])
            .Concat(hasAuthorRecentOpens ? AuthorRecentOpenConstraints : [])
            .Concat(hasAdminInboxReply ? AdminInboxReplyConstraints : [])
            .Concat(hasAdminInboxStatus ? AdminInboxStatusConstraints : [])
            .Concat(hasAdminInboxNotice ? AdminInboxNoticeConstraints : [])
            .Concat(hasAdminInboxRead ? AdminInboxReadConstraints : [])
            .Concat(requirePublicationRights ? PublicationRightsConstraints : [])
            .Concat(hasPublicationCanonical ? PublicationCanonicalConstraints : [])
            .Concat(hasPublicationProof ? PublicationProofConstraints : [])
            .Concat(hasPublicationTransparency ? PublicationTransparencyConstraints : [])
            .Concat(hasPublicationHead ? PublicationHeadConstraints : [])
            .Concat(hasArticleRead ? ArticleReadConstraints : [])
            .Concat(hasArticleReadTotal ? ArticleReadTotalConstraints : [])
            .Concat(!legacyCanvas && requireCanvasHistory ? CanvasHistoryConstraints : [])
            .Concat(requireRecoveryScope ? RecoveryScopeConstraints : []).ToArray();
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
                                                      'admin_appearance_step_up', 'comment_appeal_admin_step_up', 'admin_comment_batch_step_up')
                                         AND target.relname = 'admin_session')
                                     OR (c.relname = 'site_session_refresh_tombstone' AND target.relname = 'site_session_refresh'))
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

        AssertShape("relation/column", expectedColumns, columns);
        AssertShape("constraint", expectedConstraints, constraints);
        if (hasSitePageEditor) await VerifySitePageCoordinatesAsync(connection, transaction, cancellationToken);
        if (hasAdminTagMetadata) await VerifyTaxonomyEpochAsync(connection, transaction, cancellationToken);
        if (hasAppearanceActivation) await VerifyAppearanceActivationAsync(connection, transaction, cancellationToken);
        if (hasArticleRead) await VerifyArticleReadEpochAsync(connection, transaction, cancellationToken);
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
