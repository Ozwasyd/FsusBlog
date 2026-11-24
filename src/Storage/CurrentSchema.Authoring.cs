namespace FsusBlogV2.Storage;

internal enum ExportImageScope { Html, Portable, All }

internal static partial class CurrentSchema
{
    private const string ArticleBodyInsertionRelation = "public.article_body_insertion";
    private const string ArticleRevisionRelation = "public.article_revision";
    private const string AuthorTextDocumentRelation = "public.author_text_document";
    private const string AuthorTextPostingRelation = "public.author_text_posting";
    private const string AuthorTextRebuildRelation = "public.author_text_rebuild_job";
    internal const string AuthoringWorkspaceRelation = "public.authoring_workspace";
    private const string DocumentExportsRelation = "public.author_document_export";
    private const string PropertySnapshotRelation = "public.article_revision_property_snapshot";

    private static SchemaFacts GetArticleBodyInsertionShape(bool operations, bool edits) => Table(
        $"article_body_insertion article_id:int4 revision:int8 source_revision:int8 offset_utf16:int4{(edits ? "?" : "")} length_utf16:int4{(edits ? "?" : "")} source_digest:bytea body_digest:bytea" +
            (operations ? " operations:_int4?" : "") + (edits ? " edit_texts:_text?" : ""),
        "p article_id,revision", "f article_id,revision public.article_revision:article_id,revision",
        "f article_id,source_revision public.article_revision:article_id,revision",
        "c revision,source_revision revision=(source_revision+1)", NonNeg("offset_utf16"), Pos("length_utf16"),
        Bytes32("source_digest", "body_digest"),
        (operations ? Array1D("operations", 2, 16, "integer") : []),
        (edits ? Array1D("edit_texts", 1, 8, "text") : []));

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
        internal Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
            ProbeAsync(db, tx, ct, [], [ArticleBodyInsertionRelation], [], IsPresent);
        internal bool IsPresent(CatalogPresenceSnapshot catalog) =>
            catalog.TryGetColumn(ArticleBodyInsertionRelation, name, out var column) && RequireMatch(column.TypeName == _catalogType, invalid);
    }

    private static readonly SchemaFacts ArticleScheduleShape = Tables(
        Table("article_schedule_receipt actor_id:uuid command_id:uuid due_at:timestamptz? published_revision:int8",
            "p actor_id,command_id", "f actor_id,command_id public.article_command:actor_id,command_id", NonNeg("published_revision")),
        Table("article_schedule article_id:int4 revision:int8 actor_id:uuid generation:int8 command_id:uuid due_at:timestamptz",
            "p article_id", "f article_id,revision public.article_revision:article_id,revision",
            "f actor_id,command_id public.article_schedule_receipt:actor_id,command_id", Pos("generation")));

    internal static Task<bool> HasArticleSummaryAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        ProbeAsync(connection, transaction, ct, [], [ArticleRevisionRelation], [ArticleRevisionRelation], HasArticleSummary);

    private static bool HasArticleSummary(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(ArticleRevisionRelation, "author_summary",
            "article_revision_author_summary_length", "The article author summary schema is incomplete.");

    private static readonly SchemaFacts AuthorRecentOpenShape = Tables(
        Table("author_recent_open_collection site_id:uuid owner_id:uuid revision:int8",
            "p site_id,owner_id", "f owner_id public.admin_principal:id", Pos("revision")),
        Table("author_recent_open site_id:uuid owner_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "p site_id,owner_id,article_id", "u site_id,owner_id,sequence", "f article_id public.article:id",
            "f site_id,owner_id public.author_recent_open_collection:site_id,owner_id", Pos("article_revision", "sequence")),
        Table("author_recent_open_receipt site_id:uuid owner_id:uuid request_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "p site_id,owner_id,request_id", "u site_id,owner_id,sequence",
            "f site_id,owner_id public.author_recent_open_collection:site_id,owner_id", Pos("article_revision", "sequence")));

    private static readonly RelationGroup AuthorRecentOpenRelations = Relations(AuthorRecentOpenShape, "The author recent opens schema is incomplete.");

    internal static Task<bool> HasAuthorRecentOpensAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AuthorRecentOpenRelations.IsPresentAsync(db, tx, ct);

    private static SchemaFacts GetAuthorTextIndexShape(bool hasSummary, bool hasHeading) => Tables(
        Table("author_text_document owner_id:uuid article_id:int4 revision:int8 profile:int4 title_digest:bytea body_digest:bytea" +
                (hasSummary ? " summary_digest:bytea" : ""),
            "p owner_id,article_id", "f owner_id public.admin_principal:id",
            "f article_id,revision public.article_revision:article_id,revision",
            hasHeading ? "c profile profile>=1ANDprofile<=3" : hasSummary ? "c profile profile>=1ANDprofile<=2" : "c profile profile=1",
            Bytes32(hasSummary ? ["title_digest", "body_digest", "summary_digest"] : ["title_digest", "body_digest"])),
        Table("author_text_posting owner_id:uuid article_id:int4 field:int4 ordinal:int4 term:bytea start_u16:int4 end_u16:int4 start_u8:int4 end_u8:int4" +
                (hasHeading ? " segment:int4=0" : ""),
            "p owner_id,term,article_id,field,ordinal", "u owner_id,article_id,field,ordinal",
            "f owner_id,article_id public.author_text_document:owner_id,article_id",
            $"c field field>=1ANDfield<={(hasHeading ? 4 : hasSummary ? 3 : 2)}",
            "c ordinal ordinal>=0ANDordinal<=199999", "c term octet_length(term)>=1ANDoctet_length(term)<=512",
            NonNeg("start_u16", "start_u8"), "c start_u16,end_u16 start_u16<end_u16", "c start_u8,end_u8 start_u8<end_u8",
            If(hasHeading, "c field,segment field=4ANDsegment>=1ANDsegment<=200000ORfield<>4ANDsegment=0" )));

    private static readonly (string Relation, char Kind)[] AuthorTextIndexRelations =
    [
        (AuthorTextDocumentRelation, 'r'), (AuthorTextPostingRelation, 'r'),
        ("public.author_text_posting_owner_article", 'i'), ("public.author_text_article_owner", 'i')
    ];

    private static bool HasAuthorTextIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasTypedRelations(AuthorTextIndexRelations, "The author full-text index schema is incomplete.");

    private static bool HasAuthorTextSummaryIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(AuthorTextDocumentRelation, "summary_digest",
            "author_text_document_summary_digest_check", "The author full-text summary index schema is incomplete.");

    internal static Task<bool> HasAuthorTextHeadingIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, [], [AuthorTextPostingRelation], [AuthorTextPostingRelation], HasAuthorTextHeadingIndex);

    private static bool HasAuthorTextHeadingIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(AuthorTextPostingRelation, "segment",
            "author_text_posting_segment_check", "The author full-text heading index schema is incomplete.", requireLocalValidated: true);

    private static readonly CatalogInvariant AuthorTextArticleOwnerIndex = new("""
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
        """, "The author article owner index does not match the current schema.");

    private static readonly SchemaFacts AuthorTextPropertyIndexShape = Tables(
        Table("author_text_property_document owner_id:uuid definition_id:uuid article_id:int4 definition_revision:int8 value_revision:int8 source_digest:bytea",
            "p owner_id,definition_id,article_id", "f owner_id,definition_id public.property_definition:owner_id,id",
            "f article_id,owner_id public.property_article:article_id,owner_id",
            Pos("definition_revision", "value_revision"), Bytes32("source_digest")),
        Table("author_text_property_posting owner_id:uuid definition_id:uuid article_id:int4 ordinal:int4 term:bytea start_u16:int4 end_u16:int4 start_u8:int4 end_u8:int4",
            "p owner_id,definition_id,term,article_id,ordinal", "u owner_id,definition_id,article_id,ordinal",
            "f owner_id,definition_id,article_id public.author_text_property_document:owner_id,definition_id,article_id",
            "c ordinal ordinal>=0ANDordinal<=16383", "c term octet_length(term)>=1ANDoctet_length(term)<=512",
            NonNeg("start_u16", "start_u8"), "c end_u16 end_u16<=16384", "c end_u8 end_u8<=65536",
            "c start_u16,end_u16 start_u16<end_u16", "c start_u8,end_u8 start_u8<end_u8"));

    private static readonly (string Relation, char Kind)[] AuthorTextPropertyIndexRelations =
        [("public.author_text_property_document", 'r'), ("public.author_text_property_posting", 'r')];

    internal static Task<bool> HasAuthorTextPropertyIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, AuthorTextPropertyIndexRelations.Select(r => r.Relation).ToArray(), [], [], HasAuthorTextPropertyIndex);

    private static bool HasAuthorTextPropertyIndex(CatalogPresenceSnapshot catalog) =>
        catalog.HasTypedRelations(AuthorTextPropertyIndexRelations, "The author full-text property index schema is incomplete.");

    private static readonly SchemaFacts AuthorTextRebuildShape = Table(
        "author_text_rebuild_job owner_id:uuid profile:int4 definition_id:uuid owner_generation:int8 schema_revision:int8 definition_revision:int8 available_at:timestamptz",
        "f owner_id public.admin_principal:id", "c profile profile>=1ANDprofile<=4", Pos("owner_generation"),
        "c schema_revision,definition_revision schema_revision>=definition_revision", NonNeg("definition_revision"),
        "c available_at isfinite(available_at)", "p owner_id,profile,definition_id", "u available_at,owner_id,profile,definition_id");

    internal static Task<bool> HasAuthorTextRebuildAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, AuthorTextRebuildRelation, ct);

    private static SchemaFacts GetAuthoringWorkspaceShape(bool layout, bool groups) => Table(
        "authoring_workspace user_id:uuid schema_version:int4 revision:int8 updated_at:timestamptz active_article_id:int4 tabs:_int4" +
            (layout ? " inspector_open:bool=false" : "") +
            (groups ? " secondary_active_article_id:int4=0 secondary_tabs:_int4='{}'::integer[] focused_group:int4=0" : ""),
        "p user_id", "f user_id public.admin_principal:id", "c schema_version schema_version=1",
        Pos("revision"), NonNeg("active_article_id"), "c tabs cardinality(tabs)<=100",
        (groups ? new[]
        {
            "c secondary_active_article_id secondary_active_article_id>=0",
            "c focused_group focused_group>=0ANDfocused_group<=1",
            "c tabs,secondary_tabs (cardinality(tabs)+cardinality(secondary_tabs))<=100",
            "c focused_group,secondary_active_article_id focused_group=0ORsecondary_active_article_id>0"
        } : []));

    internal static Task<bool> HasAuthoringWorkspaceLayoutAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        HasColumnAsync(connection, transaction, ct, AuthoringWorkspaceRelation, "inspector_open");

    internal static Task<bool> HasAuthoringWorkspaceGroupsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        ProbeAsync(connection, transaction, ct, [], [AuthoringWorkspaceRelation], [], HasAuthoringWorkspaceGroups);

    private static bool HasAuthoringWorkspaceLayout(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AuthoringWorkspaceRelation, "inspector_open");

    private static bool HasAuthoringWorkspaceGroups(CatalogPresenceSnapshot catalog) =>
        Complete((catalog.HasColumn(AuthoringWorkspaceRelation, "secondary_active_article_id") ? 1 : 0) +
            (catalog.HasColumn(AuthoringWorkspaceRelation, "secondary_tabs") ? 1 : 0) +
            (catalog.HasColumn(AuthoringWorkspaceRelation, "focused_group") ? 1 : 0),
            3, "The authoring workspace group schema is incomplete.");

    private static readonly SchemaFacts CanvasHistoryShape = Tables(
        Table("canvas_history_patch canvas_id:uuid edit_revision:int8 undone:bool moved_at_revision:int8 payload:bytea digest:bytea",
            "p canvas_id,edit_revision", "f canvas_id,edit_revision public.canvas_document_event:canvas_id,revision",
            "f canvas_id,moved_at_revision public.canvas_document_event:canvas_id,revision",
            "c payload octet_length(payload)>=1ANDoctet_length(payload)<=33554432", Bytes32("digest")),
        Table("canvas_history_transition canvas_id:uuid revision:int8 target_revision:int8? discarded_redo:_int8",
            "p canvas_id,revision", "f canvas_id,revision public.canvas_document_event:canvas_id,revision",
            "f canvas_id,target_revision public.canvas_document_event:canvas_id,revision"));

    private static readonly SchemaFacts CanvasShape = Tables(
        Table("authoring_canvas id:uuid owner_id:uuid revision:int8 title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool touched_at:timestamptz",
            "p id", "f owner_id public.admin_principal:id", Pos("revision"), "c viewport_zoom viewport_zoom>=100ANDviewport_zoom<=4000"),
        Table("canvas_node canvas_id:uuid id:uuid kind:int4 x:int4 y:int4 width:int4 height:int4 article_id:int4? anchor:text? pinned_revision:int8? note:text? member_ids:_uuid",
            "p canvas_id,id", "f canvas_id public.authoring_canvas:id", "f article_id public.article:id",
            "f article_id,pinned_revision public.article_revision:article_id,revision", "c kind kind>=0ANDkind<=4"),
        Table("canvas_edge canvas_id:uuid id:uuid source_node_id:uuid target_node_id:uuid explicit_reference:bool sort_order:int4 label:text?",
            "p canvas_id,id", "f canvas_id public.authoring_canvas:id",
            "f canvas_id,source_node_id public.canvas_node:canvas_id,id",
            "f canvas_id,target_node_id public.canvas_node:canvas_id,id", NonNeg("sort_order")),
        Table("canvas_document_event canvas_id:uuid revision:int8 actor_id:uuid command_id:uuid command_kind:int4 fingerprint:bytea title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool node_count:int4 edge_count:int4 touched_at:timestamptz",
            "p canvas_id,revision", "u canvas_id,command_id", "f canvas_id public.authoring_canvas:id",
            "f actor_id public.admin_principal:id", Pos("revision"), Bytes32("fingerprint"),
            "c node_count node_count>=0ANDnode_count<=10000", "c edge_count edge_count>=0ANDedge_count<=10000"),
        CanvasLinkPlan("f canvas_id public.authoring_canvas:id"));

    private static SchemaFacts CanvasLinkPlan(string canvasReference) => Table(
        "canvas_link_plan id:uuid canvas_id:uuid edge_id:uuid canvas_revision:int8 host_revision:int8 target_revision:int8 source_offset:int4 insert_digest:bytea session_digest:bytea session_generation:int8 expires_at:timestamptz applied_article_id:int4? applied_revision:int8? applied_canvas_revision:int8?",
        "p id", Pos("canvas_revision", "host_revision", "target_revision", "session_generation"), NonNeg("source_offset"),
        Bytes32("insert_digest", "session_digest"), canvasReference,
        "f applied_article_id,applied_revision public.article_revision:article_id,revision");

    private static readonly SchemaFacts LegacyCanvasShape = Tables(
        Table("authoring_canvas id:uuid owner_id:uuid revision:int8", "p id", "f owner_id public.admin_principal:id", Pos("revision")),
        Table("canvas_edge canvas_id:uuid id:uuid article_id:int4 target_article_id:int4 explicit_reference:bool",
            "p canvas_id,id", "f canvas_id public.authoring_canvas:id", "f article_id public.article:id",
            "f target_article_id public.article:id", "c article_id,target_article_id article_id<>target_article_id"),
        CanvasLinkPlan("f canvas_id,edge_id public.canvas_edge:canvas_id,id"));

    private static SchemaFacts DocumentExportShape(bool attachments, bool imageList, bool currentProvider, ExportImageScope scope) => Table(
        "author_document_export owner_id:uuid id:uuid article_id:int4 expected_revision:int8 source_revision:int8 " +
            "author_generation:int8 format:int2 state:int2 failure:int2=0 provider:int2=1 created_at:timestamptz " +
            "started_at:timestamptz? finished_at:timestamptz? expires_at:timestamptz source_digest:bytea output_digest:bytea? output:bytea?" +
            (attachments ? " attachment_id:uuid?" : "") + (imageList ? " attachment_ids:_uuid?" : ""),
        "p owner_id,id", "f owner_id public.admin_principal:id delete-cascade",
        "f article_id,source_revision public.article_revision:article_id,revision delete-cascade",
        "c source_revision,expected_revision source_revision>=1ANDsource_revision<=expected_revision", Pos("author_generation"),
        "c format format>=1ANDformat<=4", "c state state>=1ANDstate<=7", "c failure failure>=0ANDfailure<=4",
        "c expires_at,created_at expires_at>created_at", "c started_at,created_at started_at>=created_at",
        "c finished_at,started_at,created_at finished_at>=COALESCE(started_at,created_at)",
        "c state,finished_at (state>=3ANDstate<=6)=(finished_atISNOTNULL)",
        "c state,started_at (state<>ALL(ARRAY[2,3,7]))ORstarted_atISNOTNULL",
        "c state,failure (state=ANY(ARRAY[4,6]))=(failure<>0)",
        Bytes32("source_digest", "output_digest"),
        "c output octet_length(output)>=1ANDoctet_length(output)<=4194304",
        "c state,output (state=3)=(outputISNOTNULL)", "c state,output_digest (state=3)=(output_digestISNOTNULL)",
        attachments ? $"c provider provider>=1ANDprovider<={(imageList ? 4 : 3)}" : currentProvider ? "c provider provider>=1ANDprovider<=2" : "c provider provider=1",
        If(attachments, "c provider,attachment_id (provider=3)=(attachment_idISNOTNULL)" ),
        (imageList ? new[] { "c provider,attachment_ids (provider=4)=(attachment_idsISNOTNULL)", $"c attachment_ids,format {ExportImageListCondition(scope)}" } : []));

    internal const string CurrentDocumentExportProviderConstraint = "CHECK (provider >= 1 AND provider <= 2)";
    internal const string SingleAttachmentProviderConstraint = "CHECK (provider >= 1 AND provider <= 3)";

    internal static Task<bool> HasCurrentDocumentExportProviderAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, [], [], [DocumentExportsRelation], HasCurrentDocumentExportProvider);

    internal static Task<bool> HasDocumentExportAttachmentsAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, bool list = false) =>
        HasColumnAsync(db, tx, ct, DocumentExportsRelation, list ? "attachment_ids" : "attachment_id");

    internal static string ExportImageListCondition(ExportImageScope scope) =>
        $"attachment_idsISNULLOR{(scope switch { ExportImageScope.All => "format>=1ANDformat<=4", ExportImageScope.Portable => "format<>2", _ => "format=1" })}" +
        "ANDcardinality(attachment_ids)>=2ANDcardinality(attachment_ids)<=4ANDarray_ndims(attachment_ids)=1ANDarray_position(attachment_ids,NULL::uuid)ISNULL";

    internal static Task<ExportImageScope> ReadExportImageScopeAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, [], [], [DocumentExportsRelation], ReadExportImageScope);

    private static readonly string[] DocumentExportIndexes =
    [
        "CREATE INDEX author_document_export_pending ON public.author_document_export USING btree (state, created_at, owner_id, id)",
        "CREATE INDEX author_document_export_expiry ON public.author_document_export USING btree (expires_at)",
        "CREATE INDEX author_document_export_article ON public.author_document_export USING btree (owner_id, article_id, created_at, id)"
    ];

    private static bool HasCurrentDocumentExportProvider(CatalogPresenceSnapshot catalog) =>
        catalog.HasValidatedCheckDefinition(DocumentExportsRelation, CurrentDocumentExportProviderConstraint,
            SingleAttachmentProviderConstraint, "CHECK (provider >= 1 AND provider <= 4)");

    private static bool HasDocumentExportAttachments(CatalogPresenceSnapshot catalog, bool list = false) =>
        catalog.HasColumn(DocumentExportsRelation, list ? "attachment_ids" : "attachment_id");

    private static ExportImageScope ReadExportImageScope(CatalogPresenceSnapshot catalog) =>
        catalog.HasValidatedCheckExpression(DocumentExportsRelation, ExportImageListCondition(ExportImageScope.All)) ? ExportImageScope.All
        : catalog.HasValidatedCheckExpression(DocumentExportsRelation, ExportImageListCondition(ExportImageScope.Portable)) ? ExportImageScope.Portable
        : ExportImageScope.Html;

    private static async Task VerifyDocumentExportIndexesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select pg_catalog.pg_get_indexdef(indexrelid) ||
                case when indisvalid and indisready and indislive then '' else ' unexpected-index' end
            from pg_catalog.pg_index where indrelid='public.author_document_export'::pg_catalog.regclass and not indisprimary
            """, db, tx);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var observed = new List<string>();
        while (await rows.ReadAsync(ct)) observed.Add(rows.GetString(0));
        AssertShape("document export index", DocumentExportIndexes, observed);
    }

    private static readonly SchemaFacts PropertyShape = Tables(
        Table("property_schema owner_id:uuid revision:int8", "p owner_id", "f owner_id public.admin_principal:id", NonNeg("revision")),
        Table("property_definition owner_id:uuid id:uuid machine_key:text revision:int8 digest:text shape:jsonb",
            "p owner_id,id", "u owner_id,machine_key", "f owner_id public.property_schema:owner_id",
            Pos("revision"), "c digest char_length(digest)=64"),
        Table("property_schema_command owner_id:uuid request_id:uuid receipt:jsonb",
            "p owner_id,request_id", "f owner_id public.property_schema:owner_id"),
        Table("property_article article_id:int4 owner_id:uuid revision:int8",
            "p article_id", "u article_id,owner_id", "f article_id public.article:id",
            "f owner_id public.property_schema:owner_id", Pos("revision")),
        Table("property_value article_id:int4 owner_id:uuid definition_id:uuid data:jsonb references_ids:_int4",
            "p article_id,definition_id", "f article_id,owner_id public.property_article:article_id,owner_id",
            "f owner_id,definition_id public.property_definition:owner_id,id", "c references_ids cardinality(references_ids)<=32"),
        Table("property_value_command article_id:int4 request_id:uuid fingerprint:bytea definition_id:uuid revision:int8",
            "p article_id,request_id", "f article_id public.property_article:article_id", Bytes32("fingerprint"), Pos("revision")));

    private static readonly SchemaFacts PropertySnapshotShape = Tables(
        Table("article_property_snapshot article_id:int4 schema_revision:int8 value_revision:int8 digest:text field_digests:_text",
            "p article_id,schema_revision,value_revision", "f article_id public.article:id",
            NonNeg("schema_revision", "value_revision"), "c digest char_length(digest)=64",
            "c field_digests cardinality(field_digests)<=1000"),
        Table("article_property_snapshot_field article_id:int4 schema_revision:int8 value_revision:int8 ordinal:int4 definition_id:uuid machine_key:text definition_revision:int8 definition_digest:text shape:jsonb data:jsonb references_ids:_int4",
            "p article_id,schema_revision,value_revision,ordinal", "u article_id,schema_revision,value_revision,machine_key",
            "f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision",
            Pos("ordinal", "definition_revision"), "c definition_digest char_length(definition_digest)=64",
            "c references_ids cardinality(references_ids)<=32"),
        Table("article_revision_property_snapshot article_id:int4 revision:int8 schema_revision:int8 value_revision:int8",
            "p article_id,revision", "f article_id,revision public.article_revision:article_id,revision",
            "f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision"));

    private static readonly TableProbe PropertySnapshotTable = new(PropertySnapshotRelation, "Invalid saved property snapshot relation.");

    internal static Task<bool> HasPropertySnapshotsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        PropertySnapshotTable.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts RevisionHistoryShape = Table(
        "article_rollback article_id:int4 revision:int8 previous_revision:int8 source_revision:int8 actor_id:uuid command_id:uuid reason:text",
        "p article_id,revision", "f article_id,revision public.article_revision:article_id,revision",
        "f article_id,previous_revision public.article_revision:article_id,revision",
        "f article_id,source_revision public.article_revision:article_id,revision",
        "f actor_id,command_id public.article_command:actor_id,command_id",
        "c previous_revision,revision,source_revision previous_revision=(revision-1)ANDsource_revision<previous_revision",
        "c reason char_length(reason)>=8ANDchar_length(reason)<=500");

    private static SchemaFacts SavedViewCommandTable(string table, string extraCols, int minAction, int maxAction, params ConstraintRule[] extraConstraints) => Table(
        $"{table} site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4{extraCols} fingerprint:bytea happened_at:timestamptz",
        "p site_id,owner_id,request_id", "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
        Pos("revision"), "c collection_revision,revision collection_revision>=revision",
        $"c action action>={minAction}ANDaction<={maxAction}", Bytes32("fingerprint"), extraConstraints);

    private static readonly SchemaFacts SavedViewPlacementShape = Tables(
        Table("author_saved_view_default site_id:uuid owner_id:uuid view_id:uuid",
            "p site_id,owner_id", "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id"),
        Table("author_saved_view_pin site_id:uuid owner_id:uuid view_id:uuid pin_order:int4",
            "p site_id,owner_id,view_id", "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            Pos("pin_order"), "u site_id,owner_id,pin_order deferred"),
        SavedViewCommandTable("author_saved_view_placement_command", " before_id:uuid?", 4, 8,
            "f site_id,owner_id,before_id public.author_saved_view:site_id,owner_id,id"));

    private static readonly RelationGroup SavedViewPlacementRelations = Relations(SavedViewPlacementShape, "The saved view placement schema is incomplete.");

    internal static Task<bool> HasSavedViewPlacementAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SavedViewPlacementRelations.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts SavedViewShape = Tables(
        Table("author_saved_view_collection site_id:uuid owner_id:uuid revision:int8",
            "p site_id,owner_id", "f owner_id public.admin_principal:id", Pos("revision")),
        Table("author_saved_view site_id:uuid owner_id:uuid id:uuid revision:int8 name:text name_key:bytea definition:bytea digest:bytea retired:bool",
            "p site_id,owner_id,id", "f site_id,owner_id public.author_saved_view_collection:site_id,owner_id",
            Pos("revision"), "c name octet_length(name)<=512", "c definition octet_length(definition)<=262288", Bytes32("digest")),
        SavedViewCommandTable("author_saved_view_command", "", 1, 3));

    private static readonly RelationGroup SavedViewRelations = Relations(SavedViewShape, "The saved views schema is incomplete.");

    internal static Task<bool> HasSavedViewsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SavedViewRelations.IsPresentAsync(db, tx, ct);
}
