using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts ArticleCoverShape = Table(
        "article_revision_cover article_id:int4 revision:int8 asset_id:uuid",
        "p article_id,revision",
        "f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id");


    private const string ArticleCoverRelation = "public.article_revision_cover";

    internal static Task<bool> HasArticleCoverAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, ArticleCoverRelation, ct);

    internal const string ArticleMediaRelation = "public.article_revision_media";
    private static readonly SchemaFacts ArticleMediaShape = Table(
        "article_revision_media article_id:int4 revision:int8 asset_id:uuid",
        "p article_id,revision,asset_id",
        "f article_id,revision public.article_revision:article_id,revision",
        "f asset_id public.private_media:id");

    private static readonly SchemaFacts ArticleReadShape = Tables(
        Table("article_read_hour article_id:int4 hour_utc:timestamptz count:int8",
            "p article_id,hour_utc",
            "f article_id public.article:id",
            "c article_id article_id>0",
            "c hour_utc isfinite(hour_utc)",
            "c hour_utc hour_utc=date_trunc('hour'::text,hour_utc,'UTC'::text)",
            "c count count>0"),
        Table("article_read_dwell article_id:int4 day_utc:date bucket:int4 count:int8",
            "p article_id,day_utc,bucket",
            "f article_id public.article:id",
            "c article_id article_id>0",
            "c day_utc isfinite(day_utc)",
            "c bucket bucket>=0ANDbucket<=3",
            "c count count>0"),
        Table("article_read_epoch singleton:bool last_epoch:int8?",
            "p singleton",
            "c singleton singleton",
            "c last_epoch last_epoch>=0"));

    private static readonly SchemaFacts ArticleReadTotalShape = Table(
        "article_read_total article_id:int4 views:int4",
        "p article_id",
        "f article_id public.article:id",
        "c article_id article_id>0",
        "c views views>0");

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
        """
            select last_epoch is not null or (
                not exists (select from public.article_read_hour)
                and not exists (select from public.article_read_dwell))
            from public.article_read_epoch where singleton
            """,
        "The article read epoch watermark is missing or inconsistent with the aggregate storage.");

    internal const string LegacyReleaseOriginRelation = "public.legacy_release_origin";

    private static readonly SchemaFacts LegacyReleaseOriginShape = Table(
        "legacy_release_origin article_id:int4 revision:int8 publication_id:int8 source_revision_id:int8 source_actor_id:int8 source_rollback_revision_id:int8? rollback_reason:text? responsibility:jsonb? evidence:jsonb manifest:jsonb plan_sha256:text projection_sha256:text source_admin_identity_sha256:text",
        "p article_id,revision",
        "f article_id,revision public.article_revision:article_id,revision",
        "u publication_id");

    internal static Task<bool> HasLegacyReleaseOriginAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, LegacyReleaseOriginRelation, ct);

    private static readonly string[] PrivateMediaImportColumns =
    [
        "private_media id:uuid owner_id:uuid command_id:uuid? request_hash:bytea? content_hash:bytea name:text format:int2 length:int4 width:int4 height:int4 phase:int2 created_at:timestamptz=now import_origin_id:uuid?",
        "private_media_import asset_id:uuid owner_id:uuid source_site_id:uuid target_site_id:uuid source_owner_id:int8 activation_sha256:bytea plan_sha256:bytea projection_sha256:bytea custody_manifest_sha256:bytea request_sha256:bytea prepared_manifest_sha256:bytea normalizer_sha256:bytea raw_sha256:bytea",
        "article_revision_media_import article_id:int4 revision:int8 asset_id:uuid source_revision_id:int8 reference_count:int4 alt_text:text?",
    ];

    private static readonly string[] PrivateMediaImportConstraints =
    [
        "private_media u import_origin_id,owner_id",
        "private_media c import_origin_id,command_id,request_hash,id,phase CASEWHENimport_origin_idISNULLTHENcommand_idISNOTNULLANDrequest_hashISNOTNULLELSEcommand_idISNULLANDrequest_hashISNULLANDimport_origin_id=idANDphase>0END",
        "private_media f import_origin_id public.private_media_import:asset_id",
        "private_media_import p asset_id",
        "private_media_import f asset_id,owner_id public.private_media:import_origin_id,owner_id deferred",
        "private_media_import c target_site_id,source_site_id target_site_id<>source_site_id",
        "private_media_import c source_owner_id source_owner_id>0",
        "private_media_import c activation_sha256 octet_length(activation_sha256)=32",
        "private_media_import c plan_sha256 octet_length(plan_sha256)=32",
        "private_media_import c projection_sha256 octet_length(projection_sha256)=32",
        "private_media_import c custody_manifest_sha256 octet_length(custody_manifest_sha256)=32",
        "private_media_import c request_sha256 octet_length(request_sha256)=32",
        "private_media_import c prepared_manifest_sha256 octet_length(prepared_manifest_sha256)=32",
        "private_media_import c normalizer_sha256 octet_length(normalizer_sha256)=32",
        "private_media_import c raw_sha256 octet_length(raw_sha256)=32",
        "article_revision_media_import p article_id,revision,asset_id",
        "article_revision_media_import u asset_id,source_revision_id",
        "article_revision_media_import f asset_id public.private_media_import:asset_id",
        "article_revision_media_import f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id",
        "article_revision_media_import c source_revision_id source_revision_id>0",
        "article_revision_media_import c reference_count reference_count>0",
        "article_revision_media_import c alt_text char_length(alt_text)<=256",
    ];

    private static readonly RelationGroup PrivateMediaImportRelations = new(
        "The imported private media origin schema is incomplete.",
        "public.private_media_import", "public.article_revision_media_import");

    private static readonly string[] MediaColumns =
    [
        "private_media id:uuid owner_id:uuid command_id:uuid request_hash:bytea content_hash:bytea name:text format:int2 length:int4 width:int4 height:int4 phase:int2 created_at:timestamptz=now"
    ];

    private static readonly string[] MediaConstraints =
    [
        "private_media p id",
        "private_media u owner_id,command_id",
        "private_media f owner_id public.admin_principal:id",
        "private_media c request_hash octet_length(request_hash)=32",
        "private_media c content_hash octet_length(content_hash)=32",
        "private_media c name octet_length(name)>=1ANDoctet_length(name)<=255",
        "private_media c length length>=1ANDlength<=20971520",
        "private_media c format format>=1ANDformat<=2",
        "private_media c width width>=1ANDwidth<=8192",
        "private_media c height height>=1ANDheight<=8192",
        "private_media c phase phase>=0ANDphase<=3"
    ];

    private static string WithWebpFormat(string constraint) => constraint switch
    {
        "private_media c format format>=1ANDformat<=2" or
        "private_media_upload c format format>=1ANDformat<=2" or
        "article_publication_media c format format>=1ANDformat<=2" => constraint[..^1] + "3",
        _ => constraint
    };

    private static readonly SchemaFacts MediaUploadShape = new(
        Columns: [
            "private_media_upload id:uuid owner_id:uuid command_id:uuid name:text format:int2 length:int4 part_size:int4 digest:bytea expires_at:timestamptz asset_id:uuid? complete:bool=false",
            "private_media_upload_part upload_id:uuid part:int4 digest:bytea bytes:bytea"
        ],
        Constraints: [
            "private_media_upload p id",
            "private_media_upload u owner_id,command_id",
            "private_media_upload f owner_id public.admin_principal:id",
            "private_media_upload f asset_id public.private_media:id",
            "private_media_upload c name octet_length(name)>=1ANDoctet_length(name)<=255",
            "private_media_upload c format format>=1ANDformat<=2",
            "private_media_upload c length length>=1ANDlength<=20971520",
            "private_media_upload c part_size part_size>=65536ANDpart_size<=2097152",
            "private_media_upload c digest octet_length(digest)=32",
            "private_media_upload_part p upload_id,part",
            "private_media_upload c complete,asset_id NOTcompleteORasset_idISNOTNULL",
            "private_media_upload_part f upload_id public.private_media_upload:id",
            "private_media_upload_part c part part>=0ANDpart<=319",
            "private_media_upload_part c digest octet_length(digest)=32",
            "private_media_upload_part c bytes octet_length(bytes)>=1ANDoctet_length(bytes)<=2097152"
        ]);

    internal const string PublicationCanonicalRelation = "public.article_publication_canonical";

    private static readonly string[] PublicationCanonicalColumns =
    [
        "article_publication_canonical publication_id:int8 article_id:int4 revision:int8 publication_no:int4 published_at:timestamptz transition:text rights_snapshot_id:int8 outbox_id:int8 outbox_kind:text canonical_version:int4 content_sha256:bytea policy_sha256:bytea"
    ];

    private static readonly string[] PublicationCanonicalConstraints =
    [
        "article_publication_history u publication_id,article_id,revision,publication_no,happened_at,kind",
        "article_publication_rights u id,publication_id,article_id,revision",
        "blog_outbox u id,article_id,revision,kind",
        "article_publication_canonical p publication_id",
        "article_publication_canonical u rights_snapshot_id",
        "article_publication_canonical u outbox_id",
        "article_publication_canonical f publication_id,article_id,revision,publication_no,published_at,transition public.article_publication_history:publication_id,article_id,revision,publication_no,happened_at,kind",
        "article_publication_canonical f rights_snapshot_id,publication_id,article_id,revision public.article_publication_rights:id,publication_id,article_id,revision",
        "article_publication_canonical f outbox_id,article_id,revision,outbox_kind public.blog_outbox:id,article_id,revision,kind",
        "article_publication_canonical c transition transition=ANY(ARRAY['publish'::text,'replace'::text])",
        "article_publication_canonical c outbox_kind outbox_kind='publish'::text",
        "article_publication_canonical c content_sha256 octet_length(content_sha256)=32",
        "article_publication_canonical c policy_sha256 octet_length(policy_sha256)=32"
    ];

    internal static Task<bool> HasPublicationCanonicalAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationCanonicalRelation, ct);

    private static readonly string[] PublicationCoverColumns =
        ["article_publication_cover article_id:int4 publication_id:int8 asset_id:uuid"];
    private static readonly string[] PublicationCoverConstraints =
    [
        "article_publication_cover p article_id,publication_id",
        "article_publication_cover f article_id,publication_id,asset_id public.article_publication_media:article_id,publication_id,asset_id"
    ];

    private static string PublicationCanonicalVersionConstraint(bool hasCover) => hasCover
        ? "article_publication_canonical c canonical_version canonical_version=ANY(ARRAY[2,3])"
        : "article_publication_canonical c canonical_version canonical_version=2";

    private const string PublicationCoverRelation = "public.article_publication_cover";

    internal static Task<bool> HasPublicationCoverAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationCoverRelation, ct);

    private static readonly string[] PublicationHeadColumns =
    [
        "publication_transparency_head singleton:bool seq:int8 entry_sha256:bytea origin:text key_id:text key_version:int4 key_sha256:bytea attested_at:timestamptz signature:bytea"
    ];

    private static readonly string[] PublicationHeadConstraints =
    [
        "article_publication_transparency u seq,entry_sha256",
        "publication_transparency_head p singleton",
        "publication_transparency_head c singleton singleton",
        "publication_transparency_head c entry_sha256 octet_length(entry_sha256)=32",
        "publication_transparency_head c signature octet_length(signature)=64",
        "publication_transparency_head f seq,entry_sha256 public.article_publication_transparency:seq,entry_sha256",
        "publication_transparency_head f key_id,key_version,key_sha256 public.publication_proof_key:key_id,version,spki_sha256",
    ];

    private const string PublicationHeadRelation = "public.publication_transparency_head";

    internal static Task<bool> HasPublicationHeadAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationHeadRelation, ct);

    internal static async Task VerifyPublicationCheckpointSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using (var marker = new NpgsqlCommand("""
            select version from public.v2_schema
            where current_setting('session_replication_role')='origin'
              and not exists(select from pg_catalog.pg_namespace where nspname='fsus_legacy_candidate')
            """, db, tx))
        await using (var row = await marker.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct) || row.GetInt32(0) != Version || await row.ReadAsync(ct))
                throw new InvalidOperationException("Automatic daily checkpoints require an active native V2 database.");
        }
        if (await PublicationTransparencyStateAsync(db, tx, ct) is not true || !await HasPublicationHeadAsync(db, tx, ct))
            throw new InvalidOperationException("Automatic daily checkpoints require the active native ledger and signed head.");

        var columns = Columns.Where(fact => fact.StartsWith("v2_schema ", StringComparison.Ordinal) ||
                                            fact.StartsWith("blog_outbox ", StringComparison.Ordinal))
            .Concat(PublicationCanonicalColumns).Concat(GetPublicationProofColumns(true))
            .Concat(PublicationTransparencyColumns).Concat(PublicationHeadColumns).ToArray();
        var relations = columns.Select(fact => fact.Split(' ', 2)[0]).ToHashSet(StringComparer.Ordinal);
        var hasCover = await HasPublicationCoverAsync(db, tx, ct);
        var constraints = Constraints.Concat(PublicationCanonicalConstraints)
            .Append(PublicationCanonicalVersionConstraint(hasCover)).Concat(PublicationProofConstraints)
            .Concat(PublicationTransparencyConstraints).Concat(PublicationHeadConstraints)
            .Where(fact => relations.Contains(fact.Split(' ', 2)[0])).ToArray();
        await VerifyRelationsAsync(db, tx, columns, constraints, ct);
    }

    internal const string PublicationHistoryRelation = "public.article_publication_history";

    private static readonly string[] PublicationHistoryColumns =
    [
        "article_publication_history article_id:int4 event_no:int4 revision:int8 publication_no:int4 publication_id:int8? supersedes_id:int8? kind:text reason:text happened_at:timestamptz? recorded_at:timestamptz=clock_timestamp actor_id:uuid? command_id:uuid?"
    ];

    private static readonly string[] PublicationHistoryConstraints =
    [
        "article_publication_history p article_id,event_no",
        "article_publication_history u article_id,revision",
        "article_publication_history u article_id,publication_id",
        "article_publication_history u publication_id",
        "article_publication_history u actor_id,command_id",
        "article_publication_history f article_id,revision public.article_revision:article_id,revision",
        "article_publication_history f article_id,supersedes_id public.article_publication_history:article_id,publication_id",
        "article_publication_history f actor_id,command_id public.article_command:actor_id,command_id",
        "article_publication_history c event_no event_no>0",
        "article_publication_history c publication_no publication_no>=0",
        "article_publication_history c actor_id,command_id (actor_idISNULL)=(command_idISNULL)",
        "article_publication_history c publication_id publication_idISNULLORpublication_id>0",
        "article_publication_history c supersedes_id,publication_id supersedes_idISNULLORsupersedes_idISDISTINCTFROMpublication_id",
        "article_publication_history c kind kind=ANY(ARRAY['retained-active'::text,'retained-hidden'::text,'publish'::text,'replace'::text,'retract'::text,'delete'::text])"
    ];

    private static string[] PublicationHistoryColumnsForAdminRollback =>
        [PublicationHistoryColumns[0] + " admin_actor_id:uuid? admin_command_id:uuid?"];

    private static readonly string[] PublicationHistoryAdminRollbackConstraints =
    [
        "article_publication_history f admin_actor_id,admin_command_id public.admin_article_rollback:principal_id,command_id",
        "article_publication_history u admin_actor_id,admin_command_id",
        "article_publication_history c admin_actor_id,admin_command_id (admin_actor_idISNULL)=(admin_command_idISNULL)",
        "article_publication_history c actor_id,admin_actor_id actor_idISNULLORadmin_actor_idISNULL"
    ];

    internal const int PublicationMediaMaximumBytes = 40 * 1024 * 1024;

    private static readonly SchemaFacts PublicationMediaShape = new(
        Columns: [
            "article_publication_media article_id:int4 publication_id:int8 revision:int8 ordinal:int4 asset_id:uuid content_hash:bytea format:int2 length:int4 width:int4 height:int4"
        ],
        Constraints: [
            "article_publication_history u article_id,publication_id,revision",
            "article_publication_media p article_id,publication_id,ordinal",
            "article_publication_media u article_id,publication_id,asset_id",
            "article_publication_media u article_id,publication_id,content_hash",
            "article_publication_media f article_id,publication_id,revision public.article_publication_history:article_id,publication_id,revision",
            "article_publication_media f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id",
            "article_publication_media c ordinal ordinal>=1ANDordinal<=32",
            "article_publication_media c content_hash octet_length(content_hash)=32",
            "article_publication_media c format format>=1ANDformat<=2",
            "article_publication_media c length length>=1ANDlength<=20971520",
            "article_publication_media c width width>=1ANDwidth<=8192",
            "article_publication_media c height height>=1ANDheight<=8192"
        ]);

    private const string PublicationMediaRelation = "public.article_publication_media";

    internal static Task<bool> HasPublicationMediaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationMediaRelation, ct);

    private static string[] GetPublicationProofColumns(bool? transparency) =>
    [
        "publication_proof_key key_id:text version:int4 spki_sha256:bytea not_before:timestamptz not_after:timestamptz revoked_at:timestamptz? compromised_at:timestamptz?",
        "article_publication_proof publication_id:int8 origin:text key_id:text key_version:int4 key_sha256:bytea issued_at:timestamptz signature:bytea" +
            (transparency switch { true => " transparency_seq:int8", false => " transparency_seq:int8?", _ => "" })
    ];

    private static readonly string[] PublicationProofConstraints =
    [
        "publication_proof_key p key_id",
        "publication_proof_key c version version>0",
        "publication_proof_key u spki_sha256",
        "publication_proof_key c spki_sha256 octet_length(spki_sha256)=32",
        "publication_proof_key c not_after,not_before not_after>=not_before",
        "publication_proof_key u key_id,version,spki_sha256",
        "article_publication_proof p publication_id",
        "article_publication_proof f publication_id public.article_publication_canonical:publication_id",
        "article_publication_proof f key_id,key_version,key_sha256 public.publication_proof_key:key_id,version,spki_sha256",
        "article_publication_proof c signature octet_length(signature)=64"
    ];

    private const string PublicationProofRelation = "public.article_publication_proof";
    private static readonly RelationGroup PublicationProofRelations = new(
        "Native publication proof schema is incomplete.",
        PublicationProofRelation, "public.publication_proof_key");

    internal static Task<bool> HasPublicationProofAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        PublicationProofRelations.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts PublicationRightsShape = Tables(
        Table("article_revision_rights article_id:int4 revision:int8 enabled:bool license_type:text copyright_holder:text copyright_year:int4 rights_statement:text attribution_template:text copy_policy:text max_excerpt_chars:int4 allow_code_copy:bool show_public_badge:bool proof_binding_enabled:bool",
            "p article_id,revision",
            "f article_id,revision public.article_revision:article_id,revision",
            "c max_excerpt_chars max_excerpt_chars>=0ANDmax_excerpt_chars<=10000"),
        Table("article_publication_rights id:int8:a article_id:int4 publication_id:int8 revision:int8",
            "p id",
            "u publication_id",
            "c publication_id publication_id>0",
            "f article_id,revision public.article_revision_rights:article_id,revision"));

    private static readonly string[] PublicationTransparencyColumns =
    [
        "article_publication_transparency seq:int8 publication_id:int8 prev_sha256:bytea receipt_sha256:bytea entry_sha256:bytea"
    ];

    private static readonly string[] PublicationTransparencyConstraints =
    [
        "article_publication_proof f transparency_seq,publication_id public.article_publication_transparency:seq,publication_id deferred",
        "article_publication_transparency p seq",
        "article_publication_transparency c seq seq>0",
        "article_publication_transparency u publication_id",
        "article_publication_transparency u seq,publication_id",
        "article_publication_transparency f publication_id public.article_publication_proof:publication_id",
        "article_publication_transparency c prev_sha256 octet_length(prev_sha256)=32",
        "article_publication_transparency c receipt_sha256 octet_length(receipt_sha256)=32",
        "article_publication_transparency c entry_sha256 octet_length(entry_sha256)=32",
    ];

    // Null means the extension is absent. Activation makes the exact proof-to-leaf binding required.
    private const string PublicationTransparencyRelation = "public.article_publication_transparency";

    internal static async Task<bool?> PublicationTransparencyStateAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select pg_catalog.to_regclass('public.article_publication_transparency') is not null,
                   (select a.attnotnull from pg_catalog.pg_attribute a
                    where a.attrelid=pg_catalog.to_regclass('public.article_publication_proof')
                      and a.attname='transparency_seq' and not a.attisdropped)
            """, db, tx);
        await using var row = await command.ExecuteReaderAsync(ct);
        await row.ReadAsync(ct);
        bool? active = row.IsDBNull(1) ? null : row.GetBoolean(1);
        if (row.GetBoolean(0) != active.HasValue)
            throw new InvalidOperationException("Native publication transparency schema is incomplete.");
        return active;
    }

    private static bool? PublicationTransparencyState(CatalogPresenceSnapshot catalog)
    {
        var hasLedger = catalog.HasRelation(PublicationTransparencyRelation);
        bool? active = catalog.TryGetColumn(PublicationProofRelation, "transparency_seq", out var column)
            ? column.NotNull
            : null;
        if (hasLedger != active.HasValue)
            throw new InvalidOperationException("Native publication transparency schema is incomplete.");
        return active;
    }
}
