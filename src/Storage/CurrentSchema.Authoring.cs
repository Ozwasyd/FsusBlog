using Npgsql;

namespace FsusBlogV2.Storage;

internal enum ExportImageScope { Html, Portable, All }

internal static partial class CurrentSchema
{
    private static readonly string[] ArticleBodyInsertionBaseConstraints =
    [
        "article_body_insertion p article_id,revision",
        "article_body_insertion f article_id,revision public.article_revision:article_id,revision",
        "article_body_insertion f article_id,source_revision public.article_revision:article_id,revision",
        "article_body_insertion c revision,source_revision revision=(source_revision+1)",
        "article_body_insertion c offset_utf16 offset_utf16>=0",
        "article_body_insertion c length_utf16 length_utf16>0",
        "article_body_insertion c source_digest octet_length(source_digest)=32",
        "article_body_insertion c body_digest octet_length(body_digest)=32"
    ];

    private static string ArticleBodyInsertionColumns(bool operations, bool edits)
    {
        var nullable = edits ? "?" : "";
        return $"article_body_insertion article_id:int4 revision:int8 source_revision:int8 offset_utf16:int4{nullable} length_utf16:int4{nullable} source_digest:bytea body_digest:bytea" +
            (operations ? " operations:_int4?" : "") + (edits ? " edit_texts:_text?" : "");
    }

    private static IReadOnlyList<string> ArticleBodyInsertionConstraints(bool operations, bool edits)
    {
        string[] constraints = operations ? [..ArticleBodyInsertionBaseConstraints,
            "article_body_insertion c operations cardinality(operations)>=2ANDcardinality(operations)<=16",
            "article_body_insertion c operations array_ndims(operations)=1",
            "article_body_insertion c operations array_lower(operations,1)=1",
            "article_body_insertion c operations array_position(operations,NULL::integer)ISNULL"] : ArticleBodyInsertionBaseConstraints;
        return edits ? [..constraints,
            "article_body_insertion c edit_texts cardinality(edit_texts)>=1ANDcardinality(edit_texts)<=8",
            "article_body_insertion c edit_texts array_ndims(edit_texts)=1",
            "article_body_insertion c edit_texts array_lower(edit_texts,1)=1",
            "article_body_insertion c edit_texts array_position(edit_texts,NULL::text)ISNULL"] : constraints;
    }

    private const string ArticleBodyInsertionRelation = "public.article_body_insertion";

    private static readonly BodyArrayColumn BodyEditTexts = new("edit_texts", "text", "Invalid article body edit text column.");
    private static readonly BodyArrayColumn BodyInsertionOperations = new("operations", "int4", "Invalid article body insertion operations column.");
    private static readonly TableProbe BodyInsertionTable = new(ArticleBodyInsertionRelation, "Invalid article body insertion relation.");

    internal static Task<bool> HasArticleBodyEditsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        BodyEditTexts.IsPresentAsync(db, tx, ct);

    internal static Task<bool> HasArticleBodyInsertionOperationsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        BodyInsertionOperations.IsPresentAsync(db, tx, ct);

    internal static Task<bool> HasArticleBodyInsertionAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        BodyInsertionTable.IsPresentAsync(db, tx, ct);

    private sealed class BodyArrayColumn(string name, string elementType, string invalid)
    {
        private readonly string _catalogType = $"pg_catalog._{elementType}";
        private readonly string _sql = $"""
            select atttypid='pg_catalog.{elementType}[]'::regtype
            from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass('{ArticleBodyInsertionRelation}')
                and attname='{name}' and attnum>0 and not attisdropped
            """;

        internal Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
            MatchesOptionalScalarAsync(db, tx, _sql, true, invalid, ct);

        internal bool IsPresent(CatalogPresenceSnapshot catalog) =>
            catalog.TryGetColumn(ArticleBodyInsertionRelation, name, out var column) &&
            RequireMatch(column.TypeName == _catalogType, invalid);
    }

    private static readonly SchemaFacts ArticleScheduleShape = Tables(
        Table("article_schedule_receipt actor_id:uuid command_id:uuid due_at:timestamptz? published_revision:int8",
            "p actor_id,command_id",
            "f actor_id,command_id public.article_command:actor_id,command_id",
            "c published_revision published_revision>=0"),
        Table("article_schedule article_id:int4 revision:int8 actor_id:uuid generation:int8 command_id:uuid due_at:timestamptz",
            "p article_id",
            "f article_id,revision public.article_revision:article_id,revision",
            "f actor_id,command_id public.article_schedule_receipt:actor_id,command_id",
            "c generation generation>0"));

    private const string ArticleRevisionColumns = "article_revision article_id:int4 revision:int8 title:text body:text happened_at:timestamptz";
    private const string ArticleSummaryConstraint = "article_revision c author_summary char_length(author_summary)>=1ANDchar_length(author_summary)<=512";

    private const string ArticleRevisionRelation = "public.article_revision";

    internal static Task<bool> HasArticleSummaryAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        HasColumnAndCheckAsync(connection, transaction, ct, ArticleRevisionRelation, "author_summary",
            "article_revision_author_summary_length", "The article author summary schema is incomplete.");

    private static bool HasArticleSummary(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(ArticleRevisionRelation, "author_summary",
            "article_revision_author_summary_length", "The article author summary schema is incomplete.");

    private static readonly SchemaFacts AuthorRecentOpenShape = Tables(
        Table("author_recent_open_collection site_id:uuid owner_id:uuid revision:int8",
            "p site_id,owner_id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0"),
        Table("author_recent_open site_id:uuid owner_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "p site_id,owner_id,article_id",
            "u site_id,owner_id,sequence",
            "f article_id public.article:id",
            "f site_id,owner_id public.author_recent_open_collection:site_id,owner_id",
            "c article_revision article_revision>0",
            "c sequence sequence>0"),
        Table("author_recent_open_receipt site_id:uuid owner_id:uuid request_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "p site_id,owner_id,request_id",
            "u site_id,owner_id,sequence",
            "f site_id,owner_id public.author_recent_open_collection:site_id,owner_id",
            "c article_revision article_revision>0",
            "c sequence sequence>0"));

    private static readonly RelationGroup AuthorRecentOpenRelations = Relations(AuthorRecentOpenShape, "The author recent opens schema is incomplete.");

    internal static Task<bool> HasAuthorRecentOpensAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AuthorRecentOpenRelations.IsPresentAsync(db, tx, ct);

    private static string[] AuthorTextIndexColumns(bool hasSummary, bool hasHeading) =>
    [
        "author_text_document owner_id:uuid article_id:int4 revision:int8 profile:int4 title_digest:bytea body_digest:bytea" +
            (hasSummary ? " summary_digest:bytea" : ""),
        "author_text_posting owner_id:uuid article_id:int4 field:int4 ordinal:int4 term:bytea start_u16:int4 end_u16:int4 start_u8:int4 end_u8:int4" +
            (hasHeading ? " segment:int4=0" : "")
    ];

    private static string[] AuthorTextIndexConstraints(bool hasSummary, bool hasHeading) =>
    [
        "author_text_document p owner_id,article_id",
        "author_text_document f owner_id public.admin_principal:id",
        "author_text_document f article_id,revision public.article_revision:article_id,revision",
        hasHeading ? "author_text_document c profile profile>=1ANDprofile<=3" :
            hasSummary ? "author_text_document c profile profile>=1ANDprofile<=2" : "author_text_document c profile profile=1",
        "author_text_document c title_digest octet_length(title_digest)=32",
        "author_text_document c body_digest octet_length(body_digest)=32",
        "author_text_posting p owner_id,term,article_id,field,ordinal",
        "author_text_posting u owner_id,article_id,field,ordinal",
        "author_text_posting f owner_id,article_id public.author_text_document:owner_id,article_id",
        hasHeading ? "author_text_posting c field field>=1ANDfield<=4" :
            hasSummary ? "author_text_posting c field field>=1ANDfield<=3" : "author_text_posting c field field>=1ANDfield<=2",
        "author_text_posting c ordinal ordinal>=0ANDordinal<=199999",
        "author_text_posting c term octet_length(term)>=1ANDoctet_length(term)<=512",
        "author_text_posting c start_u16 start_u16>=0",
        "author_text_posting c start_u8 start_u8>=0",
        "author_text_posting c start_u16,end_u16 start_u16<end_u16",
        "author_text_posting c start_u8,end_u8 start_u8<end_u8",
        .. (hasSummary ? new[] { "author_text_document c summary_digest octet_length(summary_digest)=32" } : []),
        .. (hasHeading ? new[] { "author_text_posting c field,segment field=4ANDsegment>=1ANDsegment<=200000ORfield<>4ANDsegment=0" } : [])
    ];

    private const string AuthorTextDocumentRelation = "public.author_text_document";
    private const string AuthorTextPostingRelation = "public.author_text_posting";
    private static readonly (string Relation, char Kind)[] AuthorTextIndexRelations =
    [
        (AuthorTextDocumentRelation, 'r'),
        (AuthorTextPostingRelation, 'r'),
        ("public.author_text_posting_owner_article", 'i'),
        ("public.author_text_article_owner", 'i')
    ];

    private static bool HasAuthorTextIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasTypedRelations(AuthorTextIndexRelations, "The author full-text index schema is incomplete.");

    private static bool HasAuthorTextSummaryIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(AuthorTextDocumentRelation, "summary_digest",
            "author_text_document_summary_digest_check", "The author full-text summary index schema is incomplete.");

    internal static Task<bool> HasAuthorTextHeadingIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasColumnAndCheckAsync(db, tx, ct, AuthorTextPostingRelation, "segment",
            "author_text_posting_segment_check", "The author full-text heading index schema is incomplete.", requireLocalValidated: true);

    private static bool HasAuthorTextHeadingIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(AuthorTextPostingRelation, "segment",
            "author_text_posting_segment_check", "The author full-text heading index schema is incomplete.", requireLocalValidated: true);

    private static readonly CatalogInvariant AuthorTextArticleOwnerIndex = new(
        """
            select exists (
                select from pg_catalog.pg_class rel
                join pg_catalog.pg_am method on method.oid=rel.relam and method.amname='btree'
                join pg_catalog.pg_index idx on idx.indexrelid=rel.oid and idx.indrelid='public.article'::regclass
                join pg_catalog.pg_attribute owner_key on owner_key.attrelid=idx.indrelid and owner_key.attname='owner_id'
                join pg_catalog.pg_attribute article_key on article_key.attrelid=idx.indrelid and article_key.attname='id'
                join pg_catalog.pg_opclass uuid_ops on uuid_ops.oid=idx.indclass[0] and uuid_ops.opcmethod=method.oid
                    and uuid_ops.opcnamespace='pg_catalog'::regnamespace and uuid_ops.opcname='uuid_ops'
                join pg_catalog.pg_opclass int_ops on int_ops.oid=idx.indclass[1] and int_ops.opcmethod=method.oid
                    and int_ops.opcnamespace='pg_catalog'::regnamespace and int_ops.opcname='int4_ops'
                where rel.oid='public.author_text_article_owner'::regclass and rel.relpersistence='p'
                    and idx.indisvalid and idx.indisready and idx.indislive and not idx.indisunique
                    and idx.indpred is null and idx.indexprs is null and idx.indnkeyatts=2 and idx.indnatts=2
                    and idx.indkey[0]=owner_key.attnum and idx.indkey[1]=article_key.attnum
                    and idx.indoption[0]=0 and idx.indoption[1]=0
            )
            """,
        "The author article owner index does not match the current schema.");

    private static readonly SchemaFacts AuthorTextPropertyIndexShape = Tables(
        Table("author_text_property_document owner_id:uuid definition_id:uuid article_id:int4 definition_revision:int8 value_revision:int8 source_digest:bytea",
            "p owner_id,definition_id,article_id",
            "f owner_id,definition_id public.property_definition:owner_id,id",
            "f article_id,owner_id public.property_article:article_id,owner_id",
            "c definition_revision definition_revision>0",
            "c value_revision value_revision>0",
            "c source_digest octet_length(source_digest)=32"),
        Table("author_text_property_posting owner_id:uuid definition_id:uuid article_id:int4 ordinal:int4 term:bytea start_u16:int4 end_u16:int4 start_u8:int4 end_u8:int4",
            "p owner_id,definition_id,term,article_id,ordinal",
            "u owner_id,definition_id,article_id,ordinal",
            "f owner_id,definition_id,article_id public.author_text_property_document:owner_id,definition_id,article_id",
            "c ordinal ordinal>=0ANDordinal<=16383",
            "c term octet_length(term)>=1ANDoctet_length(term)<=512",
            "c start_u16 start_u16>=0",
            "c end_u16 end_u16<=16384",
            "c start_u8 start_u8>=0",
            "c end_u8 end_u8<=65536",
            "c start_u16,end_u16 start_u16<end_u16",
            "c start_u8,end_u8 start_u8<end_u8"));

    private static readonly (string Relation, char Kind)[] AuthorTextPropertyIndexRelations =
        [("public.author_text_property_document", 'r'), ("public.author_text_property_posting", 'r')];

    internal static async Task<bool> HasAuthorTextPropertyIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        Complete(await ScalarAsync(db, tx, ct, """
            select case when count(obj.oid)=0 then 0
                        when count(*) filter (where obj.relkind='r')=2 then 1
                        else 2 end
            from (values (pg_catalog.to_regclass('public.author_text_property_document')),
                         (pg_catalog.to_regclass('public.author_text_property_posting'))) expected(oid)
            left join pg_catalog.pg_class obj on obj.oid=expected.oid
            """), 1, "The author full-text property index schema is incomplete.");

    private static bool HasAuthorTextPropertyIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasTypedRelations(AuthorTextPropertyIndexRelations, "The author full-text property index schema is incomplete.");

    private static readonly SchemaFacts AuthorTextRebuildShape = Table(
        "author_text_rebuild_job owner_id:uuid profile:int4 definition_id:uuid owner_generation:int8 schema_revision:int8 definition_revision:int8 available_at:timestamptz",
        "f owner_id public.admin_principal:id",
        "c profile profile>=1ANDprofile<=4",
        "c owner_generation owner_generation>0",
        "c schema_revision,definition_revision schema_revision>=definition_revision",
        "c definition_revision definition_revision>=0",
        "c available_at isfinite(available_at)",
        "p owner_id,profile,definition_id",
        "u available_at,owner_id,profile,definition_id");

    private const string AuthorTextRebuildRelation = "public.author_text_rebuild_job";

    internal static Task<bool> HasAuthorTextRebuildAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, AuthorTextRebuildRelation, ct);

    internal const string AuthoringWorkspaceRelation = "public.authoring_workspace";

    private static string[] GetAuthoringWorkspaceColumns(bool layout, bool groups) =>
    [
        "authoring_workspace user_id:uuid schema_version:int4 revision:int8 updated_at:timestamptz active_article_id:int4 tabs:_int4" +
        (layout ? " inspector_open:bool=false" : "") +
        (groups ? " secondary_active_article_id:int4=0 secondary_tabs:_int4='{}'::integer[] focused_group:int4=0" : "")
    ];

    internal static Task<bool> HasAuthoringWorkspaceLayoutAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        HasColumnAsync(connection, transaction, ct, AuthoringWorkspaceRelation, "inspector_open");

    internal static async Task<bool> HasAuthoringWorkspaceGroupsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        await ScalarAsync(connection, transaction, ct, """
            select count(*) from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass($1)
                and attname in ('secondary_active_article_id', 'secondary_tabs', 'focused_group') and attnum>0 and not attisdropped
            """, AuthoringWorkspaceRelation) switch
        {
            0L => false,
            3L => true,
            _ => throw new InvalidOperationException("The authoring workspace group schema is incomplete.")
        };

    private static bool HasAuthoringWorkspaceLayout(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AuthoringWorkspaceRelation, "inspector_open");

    private static bool HasAuthoringWorkspaceGroups(CatalogPresenceSnapshot catalog)
    {
        var count = (catalog.HasColumn(AuthoringWorkspaceRelation, "secondary_active_article_id") ? 1 : 0)
            + (catalog.HasColumn(AuthoringWorkspaceRelation, "secondary_tabs") ? 1 : 0)
            + (catalog.HasColumn(AuthoringWorkspaceRelation, "focused_group") ? 1 : 0);
        return Complete(count, 3, "The authoring workspace group schema is incomplete.");
    }

    private static readonly string[] AuthoringWorkspaceConstraints =
    [
        "authoring_workspace p user_id",
        "authoring_workspace f user_id public.admin_principal:id",
        "authoring_workspace c schema_version schema_version=1",
        "authoring_workspace c revision revision>0",
        "authoring_workspace c active_article_id active_article_id>=0",
        "authoring_workspace c tabs cardinality(tabs)<=100"
    ];

    private static readonly string[] AuthoringWorkspaceGroupsConstraints =
    [
        "authoring_workspace c secondary_active_article_id secondary_active_article_id>=0",
        "authoring_workspace c focused_group focused_group>=0ANDfocused_group<=1",
        "authoring_workspace c tabs,secondary_tabs (cardinality(tabs)+cardinality(secondary_tabs))<=100",
        "authoring_workspace c focused_group,secondary_active_article_id focused_group=0ORsecondary_active_article_id>0"
    ];

    private static readonly SchemaFacts CanvasHistoryShape = Tables(
        Table("canvas_history_patch canvas_id:uuid edit_revision:int8 undone:bool moved_at_revision:int8 payload:bytea digest:bytea",
            "p canvas_id,edit_revision",
            "f canvas_id,edit_revision public.canvas_document_event:canvas_id,revision",
            "f canvas_id,moved_at_revision public.canvas_document_event:canvas_id,revision",
            "c payload octet_length(payload)>=1ANDoctet_length(payload)<=33554432",
            "c digest octet_length(digest)=32"),
        Table("canvas_history_transition canvas_id:uuid revision:int8 target_revision:int8? discarded_redo:_int8",
            "p canvas_id,revision",
            "f canvas_id,revision public.canvas_document_event:canvas_id,revision",
            "f canvas_id,target_revision public.canvas_document_event:canvas_id,revision"));

    private static readonly SchemaFacts CanvasShape = Tables(
        Table("authoring_canvas id:uuid owner_id:uuid revision:int8 title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool touched_at:timestamptz",
            "p id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0",
            "c viewport_zoom viewport_zoom>=100ANDviewport_zoom<=4000"),
        Table("canvas_node canvas_id:uuid id:uuid kind:int4 x:int4 y:int4 width:int4 height:int4 article_id:int4? anchor:text? pinned_revision:int8? note:text? member_ids:_uuid",
            "p canvas_id,id",
            "f canvas_id public.authoring_canvas:id",
            "f article_id public.article:id",
            "f article_id,pinned_revision public.article_revision:article_id,revision",
            "c kind kind>=0ANDkind<=4"),
        Table("canvas_edge canvas_id:uuid id:uuid source_node_id:uuid target_node_id:uuid explicit_reference:bool sort_order:int4 label:text?",
            "p canvas_id,id",
            "f canvas_id public.authoring_canvas:id",
            "f canvas_id,source_node_id public.canvas_node:canvas_id,id",
            "f canvas_id,target_node_id public.canvas_node:canvas_id,id",
            "c sort_order sort_order>=0"),
        Table("canvas_document_event canvas_id:uuid revision:int8 actor_id:uuid command_id:uuid command_kind:int4 fingerprint:bytea title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool node_count:int4 edge_count:int4 touched_at:timestamptz",
            "p canvas_id,revision",
            "u canvas_id,command_id",
            "f canvas_id public.authoring_canvas:id",
            "f actor_id public.admin_principal:id",
            "c revision revision>0",
            "c fingerprint octet_length(fingerprint)=32",
            "c node_count node_count>=0ANDnode_count<=10000",
            "c edge_count edge_count>=0ANDedge_count<=10000"),
        CanvasLinkPlan("f canvas_id public.authoring_canvas:id"));

    private static SchemaFacts CanvasLinkPlan(string canvasReference) => Table(
        "canvas_link_plan id:uuid canvas_id:uuid edge_id:uuid canvas_revision:int8 host_revision:int8 target_revision:int8 source_offset:int4 insert_digest:bytea session_digest:bytea session_generation:int8 expires_at:timestamptz applied_article_id:int4? applied_revision:int8? applied_canvas_revision:int8?",
        "p id",
        "c canvas_revision canvas_revision>0",
        "c host_revision host_revision>0",
        "c target_revision target_revision>0",
        "c source_offset source_offset>=0",
        "c insert_digest octet_length(insert_digest)=32",
        "c session_digest octet_length(session_digest)=32",
        "c session_generation session_generation>0",
        canvasReference,
        "f applied_article_id,applied_revision public.article_revision:article_id,revision");

    private static readonly SchemaFacts LegacyCanvasShape = Tables(
        Table("authoring_canvas id:uuid owner_id:uuid revision:int8",
            "p id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0"),
        Table("canvas_edge canvas_id:uuid id:uuid article_id:int4 target_article_id:int4 explicit_reference:bool",
            "p canvas_id,id",
            "f canvas_id public.authoring_canvas:id",
            "f article_id public.article:id",
            "f target_article_id public.article:id",
            "c article_id,target_article_id article_id<>target_article_id"),
        CanvasLinkPlan("f canvas_id,edge_id public.canvas_edge:canvas_id,id"));

    private const string DocumentExportColumns =
        "author_document_export owner_id:uuid id:uuid article_id:int4 expected_revision:int8 source_revision:int8 " +
        "author_generation:int8 format:int2 state:int2 failure:int2=0 provider:int2=1 created_at:timestamptz " +
        "started_at:timestamptz? finished_at:timestamptz? expires_at:timestamptz source_digest:bytea output_digest:bytea? output:bytea?";

    private static readonly string[] DocumentExportConstraints =
    [
        "author_document_export p owner_id,id",
        "author_document_export f owner_id public.admin_principal:id delete-cascade",
        "author_document_export f article_id,source_revision public.article_revision:article_id,revision delete-cascade",
        "author_document_export c source_revision,expected_revision source_revision>=1ANDsource_revision<=expected_revision",
        "author_document_export c author_generation author_generation>0",
        "author_document_export c format format>=1ANDformat<=4",
        "author_document_export c state state>=1ANDstate<=7",
        "author_document_export c failure failure>=0ANDfailure<=4",
        "author_document_export c expires_at,created_at expires_at>created_at",
        "author_document_export c started_at,created_at started_at>=created_at",
        "author_document_export c finished_at,started_at,created_at finished_at>=COALESCE(started_at,created_at)",
        "author_document_export c state,finished_at (state>=3ANDstate<=6)=(finished_atISNOTNULL)",
        "author_document_export c state,started_at (state<>ALL(ARRAY[2,3,7]))ORstarted_atISNOTNULL",
        "author_document_export c state,failure (state=ANY(ARRAY[4,6]))=(failure<>0)",
        "author_document_export c source_digest octet_length(source_digest)=32",
        "author_document_export c output_digest octet_length(output_digest)=32",
        "author_document_export c output octet_length(output)>=1ANDoctet_length(output)<=4194304",
        "author_document_export c state,output (state=3)=(outputISNOTNULL)",
        "author_document_export c state,output_digest (state=3)=(output_digestISNOTNULL)"
    ];

    internal const string CurrentDocumentExportProviderConstraint = "CHECK (provider >= 1 AND provider <= 2)";
    internal const string SingleAttachmentProviderConstraint = "CHECK (provider >= 1 AND provider <= 3)";

    internal static async Task<bool> HasCurrentDocumentExportProviderAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        await ScalarAsync(db, tx, ct, """
            select exists(select from pg_catalog.pg_constraint
                where conrelid=pg_catalog.to_regclass('public.author_document_export') and contype='c' and convalidated
                and pg_catalog.pg_get_constraintdef(oid,true) in ($1,$2,$3))
            """, CurrentDocumentExportProviderConstraint, SingleAttachmentProviderConstraint,
            "CHECK (provider >= 1 AND provider <= 4)") is true;

    internal static Task<bool> HasDocumentExportAttachmentsAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, bool list = false) =>
        HasColumnAsync(db, tx, ct, DocumentExportsRelation, list ? "attachment_ids" : "attachment_id");

    internal static string ExportImageListCondition(ExportImageScope scope)
    {
        var formats = scope switch
        {
            ExportImageScope.All => "format>=1ANDformat<=4",
            ExportImageScope.Portable => "format<>2",
            _ => "format=1"
        };
        return $"attachment_idsISNULLOR{formats}ANDcardinality(attachment_ids)>=2ANDcardinality(attachment_ids)<=4ANDarray_ndims(attachment_ids)=1ANDarray_position(attachment_ids,NULL::uuid)ISNULL";
    }

    internal static async Task<ExportImageScope> ReadExportImageScopeAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
        => await FindExportImageListConstraintAsync(db, tx, ct, ExportImageScope.All) is not null ? ExportImageScope.All
            : await FindExportImageListConstraintAsync(db, tx, ct, ExportImageScope.Portable) is not null
                ? ExportImageScope.Portable : ExportImageScope.Html;

    internal static async Task<string?> FindExportImageListConstraintAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, ExportImageScope scope) =>
        await ScalarAsync(db, tx, ct, """
            select conname::text from pg_catalog.pg_constraint
            where conrelid=pg_catalog.to_regclass('public.author_document_export') and contype='c' and convalidated
            and regexp_replace(pg_catalog.pg_get_expr(conbin,conrelid,true),'[[:space:]]','','g')=$1
            """, ExportImageListCondition(scope)) as string;

    private static readonly string[] DocumentExportIndexes =
    [
        "CREATE INDEX author_document_export_pending ON public.author_document_export USING btree (state, created_at, owner_id, id)",
        "CREATE INDEX author_document_export_expiry ON public.author_document_export USING btree (expires_at)",
        "CREATE INDEX author_document_export_article ON public.author_document_export USING btree (owner_id, article_id, created_at, id)"
    ];

    private const string DocumentExportsRelation = "public.author_document_export";

    private static bool HasCurrentDocumentExportProvider(CatalogPresenceSnapshot catalog) =>
        catalog.HasValidatedCheckDefinition(DocumentExportsRelation,
            CurrentDocumentExportProviderConstraint,
            SingleAttachmentProviderConstraint,
            "CHECK (provider >= 1 AND provider <= 4)");

    private static bool HasDocumentExportAttachments(CatalogPresenceSnapshot catalog, bool list = false) =>
        catalog.HasColumn(DocumentExportsRelation, list ? "attachment_ids" : "attachment_id");

    private static ExportImageScope ReadExportImageScope(CatalogPresenceSnapshot catalog) =>
        catalog.HasValidatedCheckExpression(DocumentExportsRelation, ExportImageListCondition(ExportImageScope.All))
            ? ExportImageScope.All
            : catalog.HasValidatedCheckExpression(DocumentExportsRelation, ExportImageListCondition(ExportImageScope.Portable))
                ? ExportImageScope.Portable
                : ExportImageScope.Html;

    private static async Task VerifyDocumentExportIndexesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select pg_catalog.pg_get_indexdef(indexrelid) ||
                case when indisvalid and indisready and indislive then '' else ' unexpected-index' end
            from pg_catalog.pg_index
            where indrelid='public.author_document_export'::pg_catalog.regclass
                and not indisprimary
            """, db, tx);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var observed = new List<string>();
        while (await rows.ReadAsync(ct)) observed.Add(rows.GetString(0));
        AssertShape("document export index", DocumentExportIndexes, observed);
    }

    private static readonly SchemaFacts PropertyShape = Tables(
        Table("property_schema owner_id:uuid revision:int8",
            "p owner_id",
            "f owner_id public.admin_principal:id",
            "c revision revision>=0"),
        Table("property_definition owner_id:uuid id:uuid machine_key:text revision:int8 digest:text shape:jsonb",
            "p owner_id,id",
            "u owner_id,machine_key",
            "f owner_id public.property_schema:owner_id",
            "c revision revision>0",
            "c digest char_length(digest)=64"),
        Table("property_schema_command owner_id:uuid request_id:uuid receipt:jsonb",
            "p owner_id,request_id",
            "f owner_id public.property_schema:owner_id"),
        Table("property_article article_id:int4 owner_id:uuid revision:int8",
            "p article_id",
            "u article_id,owner_id",
            "f article_id public.article:id",
            "f owner_id public.property_schema:owner_id",
            "c revision revision>0"),
        Table("property_value article_id:int4 owner_id:uuid definition_id:uuid data:jsonb references_ids:_int4",
            "p article_id,definition_id",
            "f article_id,owner_id public.property_article:article_id,owner_id",
            "f owner_id,definition_id public.property_definition:owner_id,id",
            "c references_ids cardinality(references_ids)<=32"),
        Table("property_value_command article_id:int4 request_id:uuid fingerprint:bytea definition_id:uuid revision:int8",
            "p article_id,request_id",
            "f article_id public.property_article:article_id",
            "c fingerprint octet_length(fingerprint)=32",
            "c revision revision>0"));

    private static readonly SchemaFacts PropertySnapshotShape = Tables(
        Table("article_property_snapshot article_id:int4 schema_revision:int8 value_revision:int8 digest:text field_digests:_text",
            "p article_id,schema_revision,value_revision",
            "f article_id public.article:id",
            "c schema_revision schema_revision>=0",
            "c value_revision value_revision>=0",
            "c digest char_length(digest)=64",
            "c field_digests cardinality(field_digests)<=1000"),
        Table("article_property_snapshot_field article_id:int4 schema_revision:int8 value_revision:int8 ordinal:int4 definition_id:uuid machine_key:text definition_revision:int8 definition_digest:text shape:jsonb data:jsonb references_ids:_int4",
            "p article_id,schema_revision,value_revision,ordinal",
            "u article_id,schema_revision,value_revision,machine_key",
            "f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision",
            "c ordinal ordinal>0",
            "c definition_revision definition_revision>0",
            "c definition_digest char_length(definition_digest)=64",
            "c references_ids cardinality(references_ids)<=32"),
        Table("article_revision_property_snapshot article_id:int4 revision:int8 schema_revision:int8 value_revision:int8",
            "p article_id,revision",
            "f article_id,revision public.article_revision:article_id,revision",
            "f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision"));

    private const string PropertySnapshotRelation = "public.article_revision_property_snapshot";

    private static readonly TableProbe PropertySnapshotTable = new(PropertySnapshotRelation, "Invalid saved property snapshot relation.");

    internal static Task<bool> HasPropertySnapshotsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        PropertySnapshotTable.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts RevisionHistoryShape = Table(
        "article_rollback article_id:int4 revision:int8 previous_revision:int8 source_revision:int8 actor_id:uuid command_id:uuid reason:text",
        "p article_id,revision",
        "f article_id,revision public.article_revision:article_id,revision",
        "f article_id,previous_revision public.article_revision:article_id,revision",
        "f article_id,source_revision public.article_revision:article_id,revision",
        "f actor_id,command_id public.article_command:actor_id,command_id",
        "c previous_revision,revision,source_revision previous_revision=(revision-1)ANDsource_revision<previous_revision",
        "c reason char_length(reason)>=8ANDchar_length(reason)<=500");

    private static readonly SchemaFacts SavedViewPlacementShape = Tables(
        Table("author_saved_view_default site_id:uuid owner_id:uuid view_id:uuid",
            "p site_id,owner_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id"),
        Table("author_saved_view_pin site_id:uuid owner_id:uuid view_id:uuid pin_order:int4",
            "p site_id,owner_id,view_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            "c pin_order pin_order>0",
            "u site_id,owner_id,pin_order deferred"),
        Table("author_saved_view_placement_command site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4 before_id:uuid? fingerprint:bytea happened_at:timestamptz",
            "p site_id,owner_id,request_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            "f site_id,owner_id,before_id public.author_saved_view:site_id,owner_id,id",
            "c revision revision>0",
            "c collection_revision,revision collection_revision>=revision",
            "c action action>=4ANDaction<=8",
            "c fingerprint octet_length(fingerprint)=32"));

    private static readonly RelationGroup SavedViewPlacementRelations = Relations(SavedViewPlacementShape, "The saved view placement schema is incomplete.");

    internal static Task<bool> HasSavedViewPlacementAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SavedViewPlacementRelations.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts SavedViewShape = Tables(
        Table("author_saved_view_collection site_id:uuid owner_id:uuid revision:int8",
            "p site_id,owner_id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0"),
        Table("author_saved_view site_id:uuid owner_id:uuid id:uuid revision:int8 name:text name_key:bytea definition:bytea digest:bytea retired:bool",
            "p site_id,owner_id,id",
            "f site_id,owner_id public.author_saved_view_collection:site_id,owner_id",
            "c revision revision>0",
            "c name octet_length(name)<=512",
            "c definition octet_length(definition)<=262288",
            "c digest octet_length(digest)=32"),
        Table("author_saved_view_command site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4 fingerprint:bytea happened_at:timestamptz",
            "p site_id,owner_id,request_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            "c revision revision>0",
            "c collection_revision,revision collection_revision>=revision",
            "c action action>=1ANDaction<=3",
            "c fingerprint octet_length(fingerprint)=32"));

    private static readonly RelationGroup SavedViewRelations = Relations(SavedViewShape, "The saved views schema is incomplete.");

    internal static Task<bool> HasSavedViewsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SavedViewRelations.IsPresentAsync(db, tx, ct);
}
