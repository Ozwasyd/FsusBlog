using System.Data;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static readonly string[] LegacyCanvasKeys =
    [
        "authoring_canvas(id,owner_id,revision)",
        "canvas_edge(canvas_id,id,article_id,target_article_id,explicit_reference)",
        "canvas_link_plan(id,canvas_id,edge_id,canvas_revision,host_revision,target_revision,applied_article_id,applied_revision,applied_canvas_revision)",
    ];

    private static async Task CheckCanvasGraphAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await ExecuteAsync(connection, tx, "SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", ct);
        var report = await InspectCanvasGraphAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(report, Json));
    }

    private static async Task UpgradeEmptyCanvasGraphAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        await ExecuteAsync(connection, tx, """
            set local lock_timeout = '5s';
            lock table public.authoring_canvas, public.canvas_edge, public.canvas_link_plan in access exclusive mode
            """, ct);
        var before = await InspectCanvasGraphAsync(connection, tx, ct);
        if (before.Status == "preserve-legacy-rows")
        {
            Console.WriteLine(JsonSerializer.Serialize(before, Json));
            throw new InvalidOperationException("The preview Canvas has stored records. The source is untouched and still requires a verified conversion.");
        }
        if (before.Status == "empty-legacy-ready")
        {
            // RESTRICT is PostgreSQL's default. Unexpected dependent data or views abort the whole transaction.
            await ExecuteAsync(connection, tx, "drop table public.canvas_link_plan, public.canvas_edge, public.authoring_canvas", ct);
            await ApplySchemaAddition(connection, tx, "canvas.sql", ct);
        }
        var after = await InspectCanvasGraphAsync(connection, tx, ct);
        if (after.Status != "current") throw new InvalidOperationException("The Canvas schema did not reach the current shape.");
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(after, Json));
    }

    private static async Task<CanvasUpgradeReport> InspectCanvasGraphAsync(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using (var marker = new NpgsqlCommand("select singleton,version from public.v2_schema", connection, tx))
        await using (var row = await marker.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct) || !row.GetBoolean(0) || row.GetInt32(1) != CurrentSchema.Version || await row.ReadAsync(ct))
                throw new InvalidOperationException("The database is not on the expected v2 schema revision.");
        }
        var nodeTable = await HasRelation(connection, tx, "public.canvas_node", ct);
        var eventTable = await HasRelation(connection, tx, "public.canvas_document_event", ct);
        if (nodeTable != eventTable) throw new InvalidOperationException("The Canvas schema matches neither exact supported layout.");

        var hasRecoveryScope = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var hasRevisionHistory = await HasRelation(connection, tx, "public.article_rollback", ct);
        var hasAdminIdentity = await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct);
        var hasPublicationHistory = await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct);
        var hasArticleSchedule = await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct);
        var hasMediaUpload = await HasRelation(connection, tx, CurrentSchema.MediaUploadRelation, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory,
            hasAdminIdentity, hasPublicationHistory, hasArticleSchedule, hasMediaUpload, legacyCanvas: !nodeTable);
        if (hasRecoveryScope) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (hasAdminIdentity) await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        if (nodeTable) return new("current", null, [], []);

        await using var counts = new NpgsqlCommand("""
            select
              (select count(*) from public.authoring_canvas),
              (select count(distinct owner_id) from public.authoring_canvas),
              (select min(revision) from public.authoring_canvas),
              (select max(revision) from public.authoring_canvas),
              (select count(*) from public.canvas_edge),
              (select count(*) from public.canvas_edge where explicit_reference),
              (select count(*) from public.canvas_link_plan),
              (select count(*) from public.canvas_link_plan where applied_revision is not null),
              (select count(*) from public.canvas_link_plan
                  where num_nonnulls(applied_article_id,applied_revision,applied_canvas_revision) not in (0,3))
            """, connection, tx);
        await using var values = await counts.ExecuteReaderAsync(ct);
        await values.ReadAsync(ct);
        var legacy = new LegacyCanvasCounts(values.GetInt64(0), values.GetInt64(1),
            values.IsDBNull(2) ? null : values.GetInt64(2), values.IsDBNull(3) ? null : values.GetInt64(3),
            values.GetInt64(4), values.GetInt64(5), values.GetInt64(6), values.GetInt64(7), values.GetInt64(8));
        return legacy.Documents == 0 && legacy.Edges == 0 && legacy.Plans == 0
            ? new("empty-legacy-ready", legacy, LegacyCanvasKeys, [])
            : new("preserve-legacy-rows", legacy, LegacyCanvasKeys,
            [
                "The preview tables contain no persisted node IDs, geometry or viewport.",
                "The preview tables contain no ordered document transition receipts or original command fingerprints.",
            ]);
    }

    private sealed record LegacyCanvasCounts(long Documents, long Authors, long? EarliestRevision, long? LatestRevision,
        long Edges, long ExplicitEdges, long Plans, long AppliedPlans, long IncompletePlanReceipts);

    private sealed record CanvasUpgradeReport(string Status, LegacyCanvasCounts? Legacy, IReadOnlyList<string> PreservedKeyColumns,
        IReadOnlyList<string> Blockers);
}
