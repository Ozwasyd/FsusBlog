namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string ArticleCoverRelation = "public.article_revision_cover";
    internal const string ArticleMediaRelation = "public.article_revision_media";
    internal const string LegacyReleaseOriginRelation = "public.legacy_release_origin";
    internal const string PublicationCanonicalRelation = "public.article_publication_canonical";
    private const string PublicationCoverRelation = "public.article_publication_cover";
    private const string PublicationHeadRelation = "public.publication_transparency_head";
    internal const string PublicationHistoryRelation = "public.article_publication_history";
    private const string PublicationMediaRelation = "public.article_publication_media";
    private const string PublicationProofRelation = "public.article_publication_proof";
    private const string PublicationTransparencyRelation = "public.article_publication_transparency";
    internal const int PublicationMediaMaximumBytes = 40 * 1024 * 1024;

    private static readonly SchemaFacts ArticleCoverShape = Table(
        "article_revision_cover article_id:int4 revision:int8 asset_id:uuid",
        "p article_id,revision", "f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id");

    internal static Task<bool> HasArticleCoverAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, ArticleCoverRelation, ct);

    private static readonly SchemaFacts ArticleMediaShape = Table(
        "article_revision_media article_id:int4 revision:int8 asset_id:uuid",
        "p article_id,revision,asset_id", "f article_id,revision public.article_revision:article_id,revision",
        "f asset_id public.private_media:id");

    private static readonly SchemaFacts ArticleReadShape = Tables(
        Table("article_read_hour article_id:int4 hour_utc:timestamptz count:int8",
            "p article_id,hour_utc", "f article_id public.article:id", Pos("article_id", "count"),
            "c hour_utc isfinite(hour_utc)", "c hour_utc hour_utc=date_trunc('hour'::text,hour_utc,'UTC'::text)"),
        Table("article_read_dwell article_id:int4 day_utc:date bucket:int4 count:int8",
            "p article_id,day_utc,bucket", "f article_id public.article:id", Pos("article_id", "count"),
            "c day_utc isfinite(day_utc)", "c bucket bucket>=0ANDbucket<=3"),
        Singleton("article_read_epoch singleton:bool last_epoch:int8?", NonNeg("last_epoch")));

    private static readonly SchemaFacts ArticleReadTotalShape = Table(
        "article_read_total article_id:int4 views:int4",
        "p article_id", "f article_id public.article:id", Pos("article_id", "views"));

    private static readonly RelationGroup ArticleReadRelations = Relations(ArticleReadShape, "Article read aggregate storage is incomplete.");

    internal static Task<bool> HasArticleReadSchemaAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        ArticleReadRelations.IsPresentAsync(db, tx, ct);

    internal static async Task<bool> HasArticleReadTotalSchemaAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        Complete(await ScalarAsync(db, tx, ct, """
            select case
                when names.table_oid is null and names.index_oid is null then 0
                when total.relkind='r' and ranked.relkind='i' and tree.amname='btree'
                    and idx.indrelid=names.table_oid and idx.indisvalid and idx.indisready and idx.indislive
                    and not idx.indisunique and idx.indpred is null and idx.indexprs is null
                    and idx.indnkeyatts=2 and idx.indnatts=2
                    and idx.indkey[0]=views.attnum and idx.indkey[1]=article.attnum
                    and idx.indoption[0]=3 and idx.indoption[1]=3
                    and idx.indclass[0]=operators.oid and idx.indclass[1]=operators.oid then 1
                else 2
            end
            from (select pg_catalog.to_regclass('public.article_read_total') table_oid,
                         pg_catalog.to_regclass('public.article_read_total_rank') index_oid) names
            left join pg_catalog.pg_class total on total.oid=names.table_oid
            left join pg_catalog.pg_index idx on idx.indexrelid=names.index_oid
            left join pg_catalog.pg_class ranked on ranked.oid=idx.indexrelid
            left join pg_catalog.pg_am tree on tree.oid=ranked.relam
            left join pg_catalog.pg_attribute views on views.attrelid=total.oid and views.attname='views' and not views.attisdropped
            left join pg_catalog.pg_attribute article on article.attrelid=total.oid and article.attname='article_id' and not article.attisdropped
            left join pg_catalog.pg_opclass operators on operators.opcmethod=tree.oid
                and operators.opcnamespace='pg_catalog'::regnamespace and operators.opcname='int4_ops'
            """), 1, "Article read totals or their descending btree index do not match the current schema.");

    private static readonly CatalogInvariant ArticleReadEpoch = new(
        "select last_epoch is not null or (not exists (select from public.article_read_hour) and not exists (select from public.article_read_dwell)) from public.article_read_epoch where singleton",
        "The article read epoch watermark is missing or inconsistent with the aggregate storage.");

    private static readonly SchemaFacts LegacyReleaseOriginShape = Table(
        "legacy_release_origin article_id:int4 revision:int8 publication_id:int8 source_revision_id:int8 source_actor_id:int8 source_rollback_revision_id:int8? rollback_reason:text? responsibility:jsonb? evidence:jsonb manifest:jsonb plan_sha256:text projection_sha256:text source_admin_identity_sha256:text",
        "p article_id,revision", "f article_id,revision public.article_revision:article_id,revision", "u publication_id");

    internal static Task<bool> HasLegacyReleaseOriginAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, LegacyReleaseOriginRelation, ct);

    private static readonly SchemaFacts PrivateMediaImportExtras = Tables(
        Table("private_media_import asset_id:uuid owner_id:uuid source_site_id:uuid target_site_id:uuid source_owner_id:int8 activation_sha256:bytea plan_sha256:bytea projection_sha256:bytea custody_manifest_sha256:bytea request_sha256:bytea prepared_manifest_sha256:bytea normalizer_sha256:bytea raw_sha256:bytea",
            "p asset_id", "f asset_id,owner_id public.private_media:import_origin_id,owner_id deferred",
            "c target_site_id,source_site_id target_site_id<>source_site_id", Pos("source_owner_id"),
            Bytes32("activation_sha256", "plan_sha256", "projection_sha256", "custody_manifest_sha256",
                "request_sha256", "prepared_manifest_sha256", "normalizer_sha256", "raw_sha256")),
        Table("article_revision_media_import article_id:int4 revision:int8 asset_id:uuid source_revision_id:int8 reference_count:int4 alt_text:text?",
            "p article_id,revision,asset_id", "u asset_id,source_revision_id",
            "f asset_id public.private_media_import:asset_id",
            "f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id",
            Pos("source_revision_id", "reference_count"), "c alt_text char_length(alt_text)<=256"));

    private static readonly RelationGroup PrivateMediaImportRelations = Relations(PrivateMediaImportExtras,
        "The imported private media origin schema is incomplete.");

    private static string[] MediaDimensionConstraints =>
    [
        "c format format>=1ANDformat<=2", "c length length>=1ANDlength<=20971520",
        "c width width>=1ANDwidth<=8192", "c height height>=1ANDheight<=8192"
    ];

    private static SchemaFacts GetMediaShape(bool imported) => Tables(
        Table($"private_media id:uuid owner_id:uuid command_id:uuid{(imported ? "?" : "")} request_hash:bytea{(imported ? "?" : "")} content_hash:bytea name:text format:int2 length:int4 width:int4 height:int4 phase:int2 created_at:timestamptz=now{(imported ? " import_origin_id:uuid?" : "")}",
            "p id", "u owner_id,command_id", "f owner_id public.admin_principal:id",
            Bytes32("request_hash", "content_hash"), "c name octet_length(name)>=1ANDoctet_length(name)<=255",
            MediaDimensionConstraints, "c phase phase>=0ANDphase<=3",
            (imported ? new[]
            {
                "u import_origin_id,owner_id", "f import_origin_id public.private_media_import:asset_id",
                "c import_origin_id,command_id,request_hash,id,phase CASEWHENimport_origin_idISNULLTHENcommand_idISNOTNULLANDrequest_hashISNOTNULLELSEcommand_idISNULLANDrequest_hashISNULLANDimport_origin_id=idANDphase>0END"
            } : [])),
        imported ? PrivateMediaImportExtras : new([], []));

    private static string WithWebpFormat(string constraint) => constraint switch
    {
        "private_media c format format>=1ANDformat<=2" or
        "private_media_upload c format format>=1ANDformat<=2" or
        "article_publication_media c format format>=1ANDformat<=2" => constraint[..^1] + "3",
        _ => constraint
    };

    private static readonly SchemaFacts MediaUploadShape = Tables(
        Table("private_media_upload id:uuid owner_id:uuid command_id:uuid name:text format:int2 length:int4 part_size:int4 digest:bytea expires_at:timestamptz asset_id:uuid? complete:bool=false",
            "p id", "u owner_id,command_id", "f owner_id public.admin_principal:id", "f asset_id public.private_media:id",
            "c name octet_length(name)>=1ANDoctet_length(name)<=255", "c format format>=1ANDformat<=2",
            "c length length>=1ANDlength<=20971520", "c part_size part_size>=65536ANDpart_size<=2097152",
            Bytes32("digest"), "c complete,asset_id NOTcompleteORasset_idISNOTNULL"),
        Table("private_media_upload_part upload_id:uuid part:int4 digest:bytea bytes:bytea",
            "p upload_id,part", "f upload_id public.private_media_upload:id",
            "c part part>=0ANDpart<=319", Bytes32("digest"),
            "c bytes octet_length(bytes)>=1ANDoctet_length(bytes)<=2097152"));

    private static SchemaFacts GetPublicationCanonicalShape(bool hasCover) => Tables(
        Table("article_publication_canonical publication_id:int8 article_id:int4 revision:int8 publication_no:int4 published_at:timestamptz transition:text rights_snapshot_id:int8 outbox_id:int8 outbox_kind:text canonical_version:int4 content_sha256:bytea policy_sha256:bytea",
            "p publication_id", "u rights_snapshot_id", "u outbox_id",
            "f publication_id,article_id,revision,publication_no,published_at,transition public.article_publication_history:publication_id,article_id,revision,publication_no,happened_at,kind",
            "f rights_snapshot_id,publication_id,article_id,revision public.article_publication_rights:id,publication_id,article_id,revision",
            "f outbox_id,article_id,revision,outbox_kind public.blog_outbox:id,article_id,revision,kind",
            "c transition transition=ANY(ARRAY['publish'::text,'replace'::text])",
            "c outbox_kind outbox_kind='publish'::text", Bytes32("content_sha256", "policy_sha256"),
            hasCover ? "c canonical_version canonical_version=ANY(ARRAY[2,3])" : "c canonical_version canonical_version=2"),
        new([], [
            "article_publication_history u publication_id,article_id,revision,publication_no,happened_at,kind",
            "article_publication_rights u id,publication_id,article_id,revision",
            "blog_outbox u id,article_id,revision,kind"
        ]));

    internal static Task<bool> HasPublicationCanonicalAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationCanonicalRelation, ct);

    private static readonly SchemaFacts PublicationCoverShape = Table(
        "article_publication_cover article_id:int4 publication_id:int8 asset_id:uuid",
        "p article_id,publication_id",
        "f article_id,publication_id,asset_id public.article_publication_media:article_id,publication_id,asset_id");

    internal static Task<bool> HasPublicationCoverAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationCoverRelation, ct);

    private static readonly SchemaFacts PublicationHeadShape = Tables(
        Singleton("publication_transparency_head singleton:bool seq:int8 entry_sha256:bytea origin:text key_id:text key_version:int4 key_sha256:bytea attested_at:timestamptz signature:bytea",
            Bytes32("entry_sha256"), "c signature octet_length(signature)=64",
            "f seq,entry_sha256 public.article_publication_transparency:seq,entry_sha256",
            "f key_id,key_version,key_sha256 public.publication_proof_key:key_id,version,spki_sha256"),
        new([], ["article_publication_transparency u seq,entry_sha256"]));

    internal static Task<bool> HasPublicationHeadAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationHeadRelation, ct);

    internal static async Task VerifyPublicationCheckpointSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (await ReadSingleVersionAsync(db, tx, """
            select version from public.v2_schema
            where current_setting('session_replication_role')='origin'
              and not exists(select from pg_catalog.pg_namespace where nspname='fsus_legacy_candidate')
            """, "Automatic daily checkpoints require an active native V2 database.", ct) != Version)
            throw new InvalidOperationException("Automatic daily checkpoints require an active native V2 database.");
        if (await PublicationTransparencyStateAsync(db, tx, ct) is not true || !await HasPublicationHeadAsync(db, tx, ct))
            throw new InvalidOperationException("Automatic daily checkpoints require the active native ledger and signed head.");

        var hasCover = await HasPublicationCoverAsync(db, tx, ct);
        var core = GetCoreShape(false);
        var checkpoint = Tables(GetPublicationCanonicalShape(hasCover), GetPublicationProofShape(true), PublicationTransparencyShape, PublicationHeadShape);
        var columns = core.Columns.Where(c => c.StartsWith("v2_schema ", StringComparison.Ordinal) || c.StartsWith("blog_outbox ", StringComparison.Ordinal))
            .Concat(checkpoint.Columns).ToArray();
        var relations = columns.Select(fact => fact.Split(' ', 2)[0]).ToHashSet(StringComparer.Ordinal);
        var constraints = core.Constraints.Concat(checkpoint.Constraints).Where(fact => relations.Contains(fact.Split(' ', 2)[0])).ToArray();
        await VerifyRelationsAsync(db, tx, columns, constraints, ct);
    }

    private static SchemaFacts GetPublicationHistoryShape(bool adminRollback) => Table(
        "article_publication_history article_id:int4 event_no:int4 revision:int8 publication_no:int4 publication_id:int8? supersedes_id:int8? kind:text reason:text happened_at:timestamptz? recorded_at:timestamptz=clock_timestamp actor_id:uuid? command_id:uuid?" +
            (adminRollback ? " admin_actor_id:uuid? admin_command_id:uuid?" : ""),
        "p article_id,event_no", "u article_id,revision", "u article_id,publication_id", "u publication_id", "u actor_id,command_id",
        "f article_id,revision public.article_revision:article_id,revision",
        "f article_id,supersedes_id public.article_publication_history:article_id,publication_id",
        "f actor_id,command_id public.article_command:actor_id,command_id",
        Pos("event_no"), NonNeg("publication_no"),
        "c actor_id,command_id (actor_idISNULL)=(command_idISNULL)",
        "c publication_id publication_idISNULLORpublication_id>0",
        "c supersedes_id,publication_id supersedes_idISNULLORsupersedes_idISDISTINCTFROMpublication_id",
        "c kind kind=ANY(ARRAY['retained-active'::text,'retained-hidden'::text,'publish'::text,'replace'::text,'retract'::text,'delete'::text])",
        (adminRollback ? new[]
        {
            "f admin_actor_id,admin_command_id public.admin_article_rollback:principal_id,command_id",
            "u admin_actor_id,admin_command_id",
            "c admin_actor_id,admin_command_id (admin_actor_idISNULL)=(admin_command_idISNULL)",
            "c actor_id,admin_actor_id actor_idISNULLORadmin_actor_idISNULL"
        } : []));

    private static readonly SchemaFacts PublicationMediaShape = Tables(
        Table("article_publication_media article_id:int4 publication_id:int8 revision:int8 ordinal:int4 asset_id:uuid content_hash:bytea format:int2 length:int4 width:int4 height:int4",
            "p article_id,publication_id,ordinal", "u article_id,publication_id,asset_id", "u article_id,publication_id,content_hash",
            "f article_id,publication_id,revision public.article_publication_history:article_id,publication_id,revision",
            "f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id",
            "c ordinal ordinal>=1ANDordinal<=32", Bytes32("content_hash"), MediaDimensionConstraints),
        new([], ["article_publication_history u article_id,publication_id,revision"]));

    internal static Task<bool> HasPublicationMediaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationMediaRelation, ct);

    private static SchemaFacts GetPublicationProofShape(bool? transparency) => Tables(
        Table("publication_proof_key key_id:text version:int4 spki_sha256:bytea not_before:timestamptz not_after:timestamptz revoked_at:timestamptz? compromised_at:timestamptz?",
            "p key_id", Pos("version"), "u spki_sha256", Bytes32("spki_sha256"),
            "c not_after,not_before not_after>=not_before", "u key_id,version,spki_sha256"),
        Table("article_publication_proof publication_id:int8 origin:text key_id:text key_version:int4 key_sha256:bytea issued_at:timestamptz signature:bytea" +
                (transparency switch { true => " transparency_seq:int8", false => " transparency_seq:int8?", _ => "" }),
            "p publication_id", "f publication_id public.article_publication_canonical:publication_id",
            "f key_id,key_version,key_sha256 public.publication_proof_key:key_id,version,spki_sha256",
            "c signature octet_length(signature)=64"));

    private static readonly RelationGroup PublicationProofRelations = new(
        "Native publication proof schema is incomplete.", PublicationProofRelation, "public.publication_proof_key");

    internal static Task<bool> HasPublicationProofAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        PublicationProofRelations.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts PublicationRightsShape = Tables(
        Table("article_revision_rights article_id:int4 revision:int8 enabled:bool license_type:text copyright_holder:text copyright_year:int4 rights_statement:text attribution_template:text copy_policy:text max_excerpt_chars:int4 allow_code_copy:bool show_public_badge:bool proof_binding_enabled:bool",
            "p article_id,revision", "f article_id,revision public.article_revision:article_id,revision",
            "c max_excerpt_chars max_excerpt_chars>=0ANDmax_excerpt_chars<=10000"),
        Table("article_publication_rights id:int8:a article_id:int4 publication_id:int8 revision:int8",
            "p id", "u publication_id", Pos("publication_id"),
            "f article_id,revision public.article_revision_rights:article_id,revision"));

    private static readonly SchemaFacts PublicationTransparencyShape = Tables(
        Table("article_publication_transparency seq:int8 publication_id:int8 prev_sha256:bytea receipt_sha256:bytea entry_sha256:bytea",
            "p seq", Pos("seq"), "u publication_id", "u seq,publication_id",
            "f publication_id public.article_publication_proof:publication_id",
            Bytes32("prev_sha256", "receipt_sha256", "entry_sha256")),
        new([], ["article_publication_proof f transparency_seq,publication_id public.article_publication_transparency:seq,publication_id deferred"]));

    internal static Task<bool?> PublicationTransparencyStateAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, [PublicationTransparencyRelation], [PublicationProofRelation], [], PublicationTransparencyState);

    private static bool? PublicationTransparencyState(CatalogPresenceSnapshot catalog)
    {
        var hasLedger = catalog.HasRelation(PublicationTransparencyRelation);
        bool? active = catalog.TryGetColumn(PublicationProofRelation, "transparency_seq", out var column) ? column.NotNull : null;
        if (hasLedger != active.HasValue) throw new InvalidOperationException("Native publication transparency schema is incomplete.");
        return active;
    }
}
