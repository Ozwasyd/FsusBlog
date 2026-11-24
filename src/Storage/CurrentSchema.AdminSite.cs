namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static string[] GetAdminArticleRollbackColumns(bool draft, bool archive, bool trash) =>
    [
        "article_revision_responsibility id:int8:a article_id:int4 revision:int8 responsible_party:text basis:text reference:text recorded_by:text recorded_at:timestamptz=clock_timestamp source_snapshot_id:int8?",
        "article_publication_responsibility publication_id:int8 article_id:int4 revision:int8 snapshot_id:int8",
        "admin_article_rollback principal_id:uuid command_id:uuid fingerprint:bytea article_id:int4 previous_revision:int8 source_revision:int8 revision:int8 source_publication_id:int8 previous_publication_id:int8 publication_id:int8 publication_no:int4 published_at:timestamptz rights_snapshot_id:int8 responsibility_snapshot_id:int8 reason:text"
            + (draft ? " destination:int4=2" : "") + (archive ? " from_archive:bool=false" : "")
            + (trash ? " from_trash:bool=false" : ""),
        StepUpColumns("admin_article_rollback_step_up")
    ];

    private static string[] GetAdminArticleRollbackConstraints(bool draft, bool archive, bool trash) =>
    [
        "article_revision_responsibility p id",
        "article_revision_responsibility u article_id,revision",
        "article_revision_responsibility u article_id,id",
        "article_revision_responsibility u article_id,revision,id",
        "article_revision_responsibility f article_id,revision public.article_revision:article_id,revision",
        "article_revision_responsibility f article_id,source_snapshot_id public.article_revision_responsibility:article_id,id",
        "article_revision_responsibility c id id>0",
        "article_revision_responsibility c responsible_party octet_length(responsible_party)>=1ANDoctet_length(responsible_party)<=256",
        "article_revision_responsibility c basis octet_length(basis)>=1ANDoctet_length(basis)<=4000",
        "article_revision_responsibility c reference octet_length(reference)>=1ANDoctet_length(reference)<=1000",
        "article_revision_responsibility c recorded_by octet_length(recorded_by)>=1ANDoctet_length(recorded_by)<=255",
        "article_revision_responsibility c source_snapshot_id,id source_snapshot_idISDISTINCTFROMid",
        "article_publication_responsibility p publication_id",
        "article_publication_responsibility u article_id,revision",
        "article_publication_responsibility c publication_id publication_id>0",
        "article_publication_responsibility f article_id,revision,snapshot_id public.article_revision_responsibility:article_id,revision,id",
        "admin_article_rollback p principal_id,command_id",
        "admin_article_rollback u article_id,revision",
        "admin_article_rollback u publication_id",
        "admin_article_rollback f principal_id public.admin_principal:id",
        "admin_article_rollback f article_id,previous_revision public.article_revision:article_id,revision",
        "admin_article_rollback f article_id,source_revision public.article_revision:article_id,revision",
        "admin_article_rollback f article_id,revision public.article_revision:article_id,revision",
        "admin_article_rollback f rights_snapshot_id public.article_publication_rights:id",
        "admin_article_rollback f responsibility_snapshot_id public.article_revision_responsibility:id",
        "admin_article_rollback c fingerprint octet_length(fingerprint)=32",
        "admin_article_rollback c source_publication_id source_publication_id>0",
        "admin_article_rollback c previous_publication_id previous_publication_id>0",
        "admin_article_rollback c publication_id publication_id>0",
        "admin_article_rollback c publication_no publication_no>0",
        "admin_article_rollback c reason char_length(reason)>=8ANDchar_length(reason)<=500",
        "admin_article_rollback c previous_revision,revision,source_revision previous_revision=(revision-1)ANDsource_revision<previous_revision",
        ..(archive ? new[] {
            "admin_article_rollback c destination destination=ANY(ARRAY[0,2,3])",
            "admin_article_rollback c from_archive,destination NOTfrom_archiveORdestination=2"
        } : draft ? ["admin_article_rollback c destination destination=ANY(ARRAY[0,2])"] : []),
        ..(trash ? new[] {
            "admin_article_rollback c from_trash,destination NOTfrom_trashORdestination=2",
            "admin_article_rollback c from_trash,from_archive NOTfrom_trashORNOTfrom_archive"
        } : []),
        ..StepUpConstraints("admin_article_rollback_step_up", trash ? "action=ANY(ARRAY[3,7,8,11])" :
            archive ? "action=ANY(ARRAY[3,7,8])" : draft ? "action=ANY(ARRAY[3,7])" : "action=3")
    ];

    private const string AdminArticleRollbackRelation = "public.admin_article_rollback";
    private static readonly string[] AdminArticleRollbackRelations =
    [
        "public.article_revision_responsibility",
        "public.article_publication_responsibility",
        AdminArticleRollbackRelation,
        "public.admin_article_rollback_step_up"
    ];

    internal static async Task<bool> HasAdminArticleRollbackSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        Complete(await ScalarAsync(db, tx, ct, """
            select num_nonnulls(pg_catalog.to_regclass('public.article_revision_responsibility'),
                pg_catalog.to_regclass('public.article_publication_responsibility'),
                pg_catalog.to_regclass('public.admin_article_rollback'),
                pg_catalog.to_regclass('public.admin_article_rollback_step_up')) + (
                    select count(*)::integer
                    from pg_catalog.pg_attribute
                    where attrelid=pg_catalog.to_regclass('public.article_publication_history')
                      and attname in ('admin_actor_id','admin_command_id') and attnum>0 and not attisdropped)
            """), 6, "The administrator article rollback schema is partially installed.");

    private static bool HasAdminArticleRollbackSchema(CatalogPresenceSnapshot catalog)
    {
        var found = catalog.CountRelations(AdminArticleRollbackRelations)
            + (catalog.HasColumn(PublicationHistoryRelation, "admin_actor_id") ? 1 : 0)
            + (catalog.HasColumn(PublicationHistoryRelation, "admin_command_id") ? 1 : 0);
        return Complete(found, 6, "The administrator article rollback schema is partially installed.");
    }

    internal static Task<bool> HasAdminArticleDraftRollbackSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasColumnAsync(db, tx, ct, AdminArticleRollbackRelation, "destination");

    private static bool HasAdminArticleDraftRollbackSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AdminArticleRollbackRelation, "destination");

    internal static Task<bool> HasAdminArticleArchiveSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasColumnAsync(db, tx, ct, AdminArticleRollbackRelation, "from_archive");

    private static bool HasAdminArticleArchiveSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AdminArticleRollbackRelation, "from_archive");

    internal static Task<bool> HasAdminArticleTrashPublicationSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasColumnAsync(db, tx, ct, AdminArticleRollbackRelation, "from_trash");

    private static bool HasAdminArticleTrashPublicationSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AdminArticleRollbackRelation, "from_trash");

    private static readonly SchemaFacts AdminArticleTrashRestoreShape = Tables(
        Table("admin_article_trash_restore principal_id:uuid command_id:uuid fingerprint:bytea article_id:int4 previous_revision:int8 revision:int8 happened_at:timestamptz=clock_timestamp",
            "p principal_id,command_id",
            "u article_id,revision",
            "f principal_id public.admin_principal:id",
            "f article_id,previous_revision public.article_revision:article_id,revision",
            "f article_id,revision public.article_revision:article_id,revision",
            "c fingerprint octet_length(fingerprint)=32",
            "c previous_revision,revision previous_revision=(revision-1)"),
        StepUpShape("admin_article_trash_step_up", "action=10"));

    private static readonly RelationGroup AdminArticleTrashRestoreRelations = Relations(AdminArticleTrashRestoreShape, "The administrator trash restore schema is incomplete.");

    internal static Task<bool> HasAdminArticleTrashRestoreAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminArticleTrashRestoreRelations.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts AdminCommentBatchShape = Tables(
        Table("admin_comment_batch id:int8:a principal_id:uuid session_reference:bytea decision:int2 item_count:int4 decided_at:timestamptz",
            "p id",
            "f principal_id public.admin_principal:id",
            "c session_reference octet_length(session_reference)=32",
            "c decision decision>=1ANDdecision<=2",
            "c item_count item_count>=2ANDitem_count<=20"),
        Table("admin_comment_batch_item batch_id:int8 moderation_id:int8",
            "p batch_id,moderation_id",
            "u moderation_id",
            "f batch_id public.admin_comment_batch:id",
            "f moderation_id public.admin_comment_moderation:id"),
        StepUpShape("admin_comment_batch_step_up", "action=6"));

    private static readonly RelationGroup AdminCommentBatchRelations = Relations(AdminCommentBatchShape, "Administrator comment batch storage is incomplete.");

    internal static Task<bool> HasAdminCommentBatchSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken) =>
        AdminCommentBatchRelations.IsPresentAsync(connection, transaction, cancellationToken);

    internal const string AdminInboxNoticeRelation = "public.inbox_admin_notice";
    private static readonly SchemaFacts AdminInboxNoticeShape = Table(
        "inbox_admin_notice source_event_id:int8 account_id:uuid conversation_id:int8 message_id:int8 principal_id:uuid session_reference:bytea fingerprint:bytea sent_at:timestamptz",
        "p source_event_id",
        "u conversation_id",
        "f account_id,conversation_id public.inbox_conversation:account_id,id",
        "f conversation_id,message_id public.inbox_message:conversation_id,id",
        "f principal_id public.admin_principal:id",
        "c source_event_id source_event_id>0",
        "c session_reference octet_length(session_reference)=32",
        "c fingerprint octet_length(fingerprint)=32");

    internal const string AdminInboxReadRelation = "public.inbox_admin_read";
    private static readonly SchemaFacts AdminInboxReadShape = Table(
        "inbox_admin_read conversation_id:int8 read_through:int8 read_at:timestamptz principal_id:uuid session_reference:bytea",
        "p conversation_id",
        "f conversation_id,read_through public.inbox_message:conversation_id,id",
        "f principal_id public.admin_principal:id",
        "c session_reference octet_length(session_reference)=32");

    internal const string AdminInboxReplyRelation = "public.inbox_admin_reply";
    private static readonly SchemaFacts AdminInboxReplyShape = Table(
        "inbox_admin_reply principal_id:uuid command_id:text fingerprint:bytea session_reference:bytea conversation_id:int8 message_id:int8",
        "p principal_id,command_id",
        "u message_id",
        "f principal_id public.admin_principal:id",
        "f conversation_id,message_id public.inbox_message:conversation_id,id",
        "c command_id octet_length(command_id)>=1ANDoctet_length(command_id)<=64",
        "c fingerprint octet_length(fingerprint)=32",
        "c session_reference octet_length(session_reference)=32");

    internal const string AdminInboxStatusRelation = "public.inbox_admin_status";
    private static readonly SchemaFacts AdminInboxStatusShape = Table(
        "inbox_admin_status id:int8:d conversation_id:int8 principal_id:uuid session_reference:bytea previous_status:int2 current_status:int2 reason:text happened_at:timestamptz",
        "p id",
        "f conversation_id public.inbox_conversation:id",
        "f principal_id public.admin_principal:id",
        "c session_reference octet_length(session_reference)=32",
        "c previous_status previous_status>=0ANDprevious_status<=2",
        "c current_status current_status>=0ANDcurrent_status<=2",
        "c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024",
        "c current_status,previous_status current_status<>previous_status");

    private static readonly SchemaFacts AdminTagMetadataShape = Tables(
        Table("taxonomy_epoch singleton:bool revision:int8",
            "p singleton",
            "c singleton singleton",
            "c revision revision>=0"),
        MetadataCommand("tag"));

    private static readonly SchemaFacts AdminCategoryMetadataShape = MetadataCommand("category");

    private static SchemaFacts MetadataCommand(string taxonomy) => Table(
        $"admin_{taxonomy}_metadata_command principal_id:uuid request_id:uuid {taxonomy}_id:int4 revision:int8 old_name:text old_description:text name:text description:text changed:bool fingerprint:bytea session_reference:bytea happened_at:timestamptz",
        "p principal_id,request_id",
        "f principal_id public.admin_principal:id",
        $"f {taxonomy}_id public.{taxonomy}:id",
        "c revision revision>=0",
        "c fingerprint octet_length(fingerprint)=32",
        "c session_reference octet_length(session_reference)=32");

    private static readonly RelationGroup AdminTagMetadataRelations = Relations(AdminTagMetadataShape, "The administrator tag metadata schema is incomplete.");
    private static readonly RelationGroup AdminCategoryMetadataRelations = Relations(AdminCategoryMetadataShape, "The administrator category metadata schema is incomplete.");

    internal static Task<bool> HasAdminTagMetadataAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminTagMetadataRelations.IsPresentAsync(db, tx, ct);


    private static CatalogInvariant TaxonomyEpoch(bool category)
    {
        var categoryHistory = category ? "union all select revision from public.admin_category_metadata_command where changed" : "";
        return new($"""
            select revision>=coalesce((select max(revision) from (
                select revision from public.admin_tag_metadata_command where changed
                {categoryHistory}
            ) as history),0) from public.taxonomy_epoch where singleton
            """,
            "The taxonomy epoch and durable command history do not agree.");
    }

    private static readonly SchemaFacts AppearanceActivationShape = Tables(
        Table("appearance_activation singleton:bool revision:int8 theme_digest:text font_digest:text",
            "p singleton",
            "c singleton singleton",
            "c revision revision>=0",
            "c theme_digest theme_digest=''::textORtheme_digest~'^[0-9a-f]{64}$'::text",
            "c font_digest font_digest=''::textORfont_digest~'^[0-9a-f]{64}$'::text"),
        Table("appearance_activation_audit revision:int8 principal_id:uuid rollback:bool previous_theme_digest:text previous_font_digest:text theme_digest:text font_digest:text happened_at:timestamptz",
            "p revision",
            "c revision revision>0",
            "f principal_id public.admin_principal:id"),
        StepUpShape("admin_appearance_step_up", "action=4"));

    private static readonly RelationGroup AppearanceActivationRelations = Relations(AppearanceActivationShape, "Appearance activation schema is partially installed.");

    private static readonly CatalogInvariant AppearanceActivation = new(
        """
            select exists (select from public.appearance_activation s where s.singleton and
              s.revision=coalesce((select max(a.revision) from public.appearance_activation_audit a),0)
              and (s.revision=0 and s.theme_digest='' and s.font_digest='' or exists (
                select from public.appearance_activation_audit a where a.revision=s.revision
                  and a.theme_digest=s.theme_digest and a.font_digest=s.font_digest)))
            """,
        "Appearance activation coordinates are incomplete.");

    private static readonly SchemaFacts MfaShape = Tables(
        Table("mfa_totp user_id:uuid sealed_seed:bytea last_step:int8 verified_at:timestamptz retry_after:timestamptz failed_count:int4",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "c sealed_seed octet_length(sealed_seed)=49",
            "c last_step last_step>=0",
            "c failed_count failed_count>=0ANDfailed_count<=5"),
        Table("mfa_recovery_code user_id:uuid digest:bytea",
            "p user_id,digest",
            "f user_id public.mfa_totp:user_id",
            "c digest octet_length(digest)=32"),
        Table("mfa_setup user_id:uuid generation:int8 session_digest:bytea sealed_seed:bytea expires_at:timestamptz failed_count:int4",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "c generation generation>0",
            "c session_digest octet_length(session_digest)=32",
            "c sealed_seed octet_length(sealed_seed)=49",
            "c failed_count failed_count>=0ANDfailed_count<=5"),
        Table("mfa_flow digest:bytea user_id:uuid generation:int8 kind:int4 scope:bytea options:text expires_at:timestamptz",
            "p digest",
            "f user_id public.passkey_subject:user_id",
            "c digest octet_length(digest)=32",
            "c generation generation>0",
            "c kind kind>=1ANDkind<=5",
            "c scope octet_length(scope)>=1ANDoctet_length(scope)<=1055",
            "c options octet_length(options)<=8192"));

    private static readonly SchemaFacts PasskeyShape = new(
        Columns: [
            "passkey_subject user_id:uuid account_id:int4:d user_handle:bytea",
            "passkey_credential credential_id:bytea user_id:uuid public_key:bytea sign_count:int8 backup_eligible:bool backed_up:bool created_at:timestamptz=now last_used_at:timestamptz?",
            "passkey_challenge digest:bytea user_id:uuid? generation:int8? options:text expires_at:timestamptz binding_digest:bytea?"
        ],
        Constraints: [
            "passkey_subject p user_id",
            "passkey_subject u account_id",
            "passkey_subject u user_handle",
            "passkey_subject f user_id public.blog_user:id",
            "passkey_subject c account_id account_id>0",
            "passkey_subject c user_handle octet_length(user_handle)=32",
            "passkey_credential p credential_id",
            "passkey_credential u credential_id,user_id",
            "passkey_credential f user_id public.passkey_subject:user_id",
            "passkey_credential c credential_id octet_length(credential_id)>=1ANDoctet_length(credential_id)<=1023",
            "passkey_credential c public_key octet_length(public_key)>=1ANDoctet_length(public_key)<=16384",
            "passkey_credential c sign_count sign_count>=0ANDsign_count<='4294967295'::bigint",
            "passkey_credential c backed_up,backup_eligible NOTbacked_upORbackup_eligible",
            "passkey_challenge p digest",
            "passkey_challenge f user_id public.passkey_subject:user_id",
            "passkey_challenge c digest octet_length(digest)=32",
            "passkey_challenge c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            "passkey_challenge c binding_digest octet_length(binding_digest)=32",
            "passkey_challenge c user_id,generation,binding_digest user_idISNULLANDgenerationISNULLANDbinding_digestISNULLORuser_idISNOTNULLANDgenerationISNOTNULLANDgeneration>0ANDbinding_digestISNOTNULL",
            "user_session f passkey_credential_id,user_id public.passkey_credential:credential_id,user_id"
        ]);

    private static readonly SchemaFacts RecoveryScopeShape = Table(
        "authoring_recovery_site singleton:bool site_id:uuid",
        "p singleton",
        "c singleton singleton");

    internal static async Task<Guid> ReadRecoverySiteIdAsync(
        NpgsqlConnection database, NpgsqlTransaction transaction, CancellationToken cancellationToken) =>
        await ScalarAsync(database, transaction, cancellationToken,
            "select site_id from public.authoring_recovery_site where singleton") is Guid id && id != Guid.Empty
            ? id : throw new InvalidOperationException("The recovery scope site id is missing.");

    private static readonly SchemaFacts RootCommentPowPolicyShape = Tables(
        Table("root_comment_pow_policy singleton:bool generation:int8 proof_seconds:int4",
            "p singleton",
            "c singleton singleton",
            "c generation generation>0",
            "c proof_seconds proof_seconds>=60ANDproof_seconds<=120"),
        Table("root_comment_pow_policy_audit generation:int8 principal_id:uuid previous_seconds:int4 proof_seconds:int4 rollback:bool happened_at:timestamptz",
            "p generation",
            "f principal_id public.admin_principal:id",
            "c generation generation>1",
            "c previous_seconds previous_seconds>=60ANDprevious_seconds<=120",
            "c proof_seconds proof_seconds>=60ANDproof_seconds<=120",
            "c previous_seconds,proof_seconds previous_seconds<>proof_seconds"),
        StepUpShape("admin_root_comment_pow_step_up", "action=9"));

    private static readonly RelationGroup RootCommentPowPolicyRelations = Relations(RootCommentPowPolicyShape, "The root comment proof policy schema is partially installed.");

    private static readonly CatalogInvariant RootCommentPowPolicy = new(
        """
            with audit as (
              select generation,proof_seconds,previous_seconds,rollback,
                lag(generation,1,1::bigint) over history as prior_generation,
                lag(proof_seconds,1,120) over history as prior_seconds,
                lag(previous_seconds) over history as rollback_seconds
              from public.root_comment_pow_policy_audit
              window history as (order by generation)
            )
            select exists (select from public.root_comment_pow_policy p where p.singleton and
                p.generation=coalesce((select max(generation) from audit),1)
                and (p.generation=1 and p.proof_seconds=120 or exists (
                  select from audit a where a.generation=p.generation and a.proof_seconds=p.proof_seconds)))
              and not exists (select from audit where generation<>prior_generation+1 or previous_seconds<>prior_seconds
                or rollback and proof_seconds is distinct from rollback_seconds)
            """,
        "The root comment proof policy activation history is incomplete.");

    private static readonly SchemaFacts SiteConfigOverrideShape = Tables(
        Table("site_config_override singleton:bool revision:int8 seo_json:text? compliance_json:text?",
            "p singleton",
            "c singleton singleton",
            "c revision revision>=0",
            "c seo_json octet_length(seo_json)<=16384",
            "c compliance_json octet_length(compliance_json)<=16384",
            "c revision,seo_json,compliance_json revision=0ANDseo_jsonISNULLANDcompliance_jsonISNULLORrevision>0ANDseo_jsonISNOTNULLANDcompliance_jsonISNOTNULL"),
        Table("site_config_audit revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
            "p revision",
            "c revision revision>0",
            "f principal_id public.admin_principal:id",
            "c previous_digest octet_length(previous_digest)=32",
            "c next_digest octet_length(next_digest)=32"),
        StepUpShape("admin_site_config_step_up", "action=13"));

    private static readonly RelationGroup SiteConfigOverrideRelations = Relations(SiteConfigOverrideShape, "The site configuration override schema is partially installed.");

    internal static Task<bool> HasSiteConfigOverrideSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SiteConfigOverrideRelations.IsPresentAsync(db, tx, ct);

    private static readonly CatalogInvariant SiteConfigOverride = new(
        """
            select exists (select from public.site_config_override s where s.singleton and
              s.revision=coalesce((select max(a.revision) from public.site_config_audit a),0)
              and ((s.revision=0 and s.seo_json is null and s.compliance_json is null)
                or (s.revision>0 and s.seo_json is not null and s.compliance_json is not null
                    and exists (select from public.site_config_audit a where a.revision=s.revision))))
            """,
        "The site configuration override coordinates are incomplete.");

    private static readonly SchemaFacts SitePageEditorShape = Tables(
        Table("site_page_content slug:text revision:int8 markdown:text?",
            "p slug",
            "c slug slug='about'::textORslug='privacy'::textORslug='guidelines'::textORslug='copyright'::text",
            "c markdown octet_length(markdown)<=600000",
            "c revision,markdown revision=0ANDmarkdownISNULLORrevision>0ANDmarkdownISNOTNULL"),
        Table("site_page_publish_audit slug:text revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
            "p slug,revision",
            "f slug public.site_page_content:slug",
            "f principal_id public.admin_principal:id",
            "c revision revision>0",
            "c previous_digest octet_length(previous_digest)=32",
            "c next_digest octet_length(next_digest)=32"),
        StepUpShape("admin_site_page_step_up", "action=2"));

    private static readonly RelationGroup SitePageEditorRelations = Relations(SitePageEditorShape, "The site page editor schema is partially installed.");

    private static readonly CatalogInvariant SitePageCoordinates = new(
        """
            select count(*)=4 and coalesce(bool_and(
                revision=coalesce((select max(a.revision) from public.site_page_publish_audit a where a.slug=p.slug),0)
            ),false) from public.site_page_content p
            """,
        "The site page editor publication coordinates are incomplete.");

    private static readonly SchemaFacts SitePasskeyNameShape = Table(
        "site_passkey_name credential_id:bytea user_id:uuid revision:int8 name:text",
        "p credential_id",
        "f credential_id,user_id public.passkey_credential:credential_id,user_id delete-cascade",
        "c revision revision>0",
        "c name char_length(name)>=1ANDchar_length(name)<=64ANDoctet_length(name)<=256");

    private const string SitePasskeyNameRelation = "public.site_passkey_name";

    internal static Task<bool> HasSitePasskeyNamesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, SitePasskeyNameRelation, ct);

    private static readonly SchemaFacts SiteRecoveryKeyShape = Tables(
        Table("site_recovery_key user_id:uuid lookup_digest:bytea salt:bytea verifier:bytea version:int8 created_at:timestamptz used_at:timestamptz? failed_count:int2 failure_until:timestamptz=now",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "u lookup_digest",
            "c lookup_digest octet_length(lookup_digest)=32",
            "c salt octet_length(salt)=16",
            "c verifier octet_length(verifier)=32",
            "c version version>0",
            "c failed_count failed_count>=0ANDfailed_count<=8"),
        Table("site_recovery_flow digest:bytea user_id:uuid generation:int8 session_digest:bytea purpose:int2 kind:int2 options:text? expires_at:timestamptz",
            "p digest",
            "f user_id public.passkey_subject:user_id",
            "c digest octet_length(digest)=32",
            "c generation generation>0",
            "c session_digest octet_length(session_digest)=32",
            "c purpose purpose>=1ANDpurpose<=2",
            "c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            "u user_id,purpose,kind",
            "c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"),
        Table("site_recovery_rebind user_id:uuid generation:int8 ticket_digest:bytea expires_at:timestamptz challenge_digest:bytea? options:text? challenge_expires_at:timestamptz? request_digest:bytea? completed_at:timestamptz?",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "c generation generation>0",
            "u ticket_digest",
            "c ticket_digest octet_length(ticket_digest)=32",
            "c challenge_digest octet_length(challenge_digest)=32",
            "c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            "c request_digest octet_length(request_digest)=32",
            "c challenge_digest,options (challenge_digestISNULL)=(optionsISNULL)",
            "c challenge_digest,challenge_expires_at (challenge_digestISNULL)=(challenge_expires_atISNULL)",
            "c request_digest,completed_at (request_digestISNULL)=(completed_atISNULL)"));

    private static readonly RelationGroup SiteRecoveryKeyRelations = Relations(SiteRecoveryKeyShape, "The site Recovery Key schema is partially installed.");

    internal static Task<bool> HasSiteRecoveryKeySchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken ct) =>
        SiteRecoveryKeyRelations.IsPresentAsync(connection, transaction, ct);

    // An issued Recovery Key is durable evidence that this account passed Passkey enrollment.
    internal static async Task<bool> RequiresSiteRecoveryAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct) =>
        await HasSiteRecoveryKeySchemaAsync(db, tx, ct) && await ScalarAsync(db, tx, ct, """
            select exists(select from public.site_recovery_key where user_id=$1)
                and not exists(select from public.passkey_credential where user_id=$1)
            """, owner) is true;

    private static readonly SchemaFacts SiteRefreshShape = Tables(
        Table("site_session_refresh family_id:uuid access_digest:bytea refresh_digest:bytea previous_access_digest:bytea? generation:int8 idle_expires_at:timestamptz absolute_expires_at:timestamptz rotated_at:timestamptz",
            "p family_id",
            "u access_digest",
            "f access_digest public.user_session:digest delete-cascade update-cascade",
            "c access_digest octet_length(access_digest)=32",
            "u refresh_digest",
            "c refresh_digest octet_length(refresh_digest)=32",
            "c previous_access_digest octet_length(previous_access_digest)=32",
            "c generation generation>=0",
            "c idle_expires_at,absolute_expires_at idle_expires_at<=absolute_expires_at"),
        Table("site_session_refresh_tombstone refresh_digest:bytea family_id:uuid generation:int8 used_at:timestamptz expires_at:timestamptz",
            "p refresh_digest",
            "c refresh_digest octet_length(refresh_digest)=32",
            "f family_id public.site_session_refresh:family_id delete-cascade",
            "c generation generation>=0",
            "c used_at,expires_at used_at<expires_at"));

    private static readonly RelationGroup SiteRefreshRelations = Relations(SiteRefreshShape, "The site refresh schema is partially installed.");

    internal const string SiteSubscriptionRelation = "public.site_subscription";

    private static readonly SchemaFacts SiteSubscriptionShape = Table(
        "site_subscription email_key:bytea channel:int2 enabled:bool created_at:timestamptz unsubscribed_at:timestamptz? proof_digest:bytea? proof_expires_at:timestamptz?",
        "p email_key",
        "c email_key octet_length(email_key)=32",
        "c channel channel>=1ANDchannel<=2",
        "c enabled,unsubscribed_at enabled=(unsubscribed_atISNULL)",
        "c proof_digest octet_length(proof_digest)=32",
        "c proof_digest,proof_expires_at (proof_digestISNULL)=(proof_expires_atISNULL)",
        "c enabled,proof_digest enabledORproof_digestISNULL");

    private static readonly SchemaFacts SiteTrafficShape = Table(
        "site_traffic_daily day:date region:text views:int8",
        "p day,region",
        "c day isfinite(day)",
        "c region region~'^([A-Z]{2}(-[A-Z0-9]{1,3})?|unknown)$'::text",
        "c views views>0");

    private const string SiteTrafficRelation = "public.site_traffic_daily";

    private static readonly SchemaFacts TaxonomyShape = Tables(
        Table("category id:int4:d name:text description:text?",
            "p id",
            "u name",
            "c name char_length(name)>=1ANDchar_length(name)<=128",
            "c description char_length(description)>=1ANDchar_length(description)<=500"),
        Table("tag id:int4:d name:text description:text?",
            "p id",
            "u name",
            "c name char_length(name)>=1ANDchar_length(name)<=128",
            "c description char_length(description)>=1ANDchar_length(description)<=500"),
        Table("tag_url_name name_key:text tag_id:int4",
            "p name_key",
            "c name_key char_length(name_key)>=1ANDchar_length(name_key)<=256",
            "f tag_id public.tag:id"),
        Table("article_revision_category article_id:int4 revision:int8 category_id:int4",
            "p article_id,revision",
            "f category_id public.category:id",
            "f article_id,revision public.article_revision:article_id,revision"),
        Table("article_revision_tag article_id:int4 revision:int8 tag_id:int4",
            "p article_id,revision,tag_id",
            "f tag_id public.tag:id",
            "f article_id,revision public.article_revision:article_id,revision"));
}
