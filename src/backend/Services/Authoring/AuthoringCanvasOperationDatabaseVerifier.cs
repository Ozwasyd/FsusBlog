using System.Data.Common;

using SqlSugar;

using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent database verifier for a completed canvas operation sequence. It reads the document,
/// journal, receipts, and external article/relation coordinates without calling the operation engine.
/// </summary>
public sealed class AuthoringCanvasOperationDatabaseVerifier(
    ISqlSugarClient db,
    IAuthoringCanvasDocumentStore documentStore,
    IAuthoringCanvasOperationTransaction operationTransaction)
{
    public const int MaxJournalEntriesPerVerification = 10_000;

    public async Task<AuthoringCanvasOperationDatabaseBaseline> CaptureBaselineAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default)
        => new(
            await ReadSnapshotAsync(owner, canvasId, cancellationToken).ConfigureAwait(false),
            await CaptureExternalAuthorityAsync(cancellationToken).ConfigureAwait(false));

    public async Task<AuthoringCanvasOperationDatabaseVerificationResult> VerifyAsync(
        AuthoringCanvasOperationDatabaseBaseline baseline,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(baseline);
        AuthoringCanvasOwner owner = baseline.Initial.Header.Owner;
        Guid canvasId = baseline.Initial.Header.Id;
        AuthoringCanvasOperationSnapshot current = await ReadSnapshotAsync(
            owner,
            canvasId,
            cancellationToken).ConfigureAwait(false);
        IReadOnlyList<AuthoringCanvasOperationJournalEntry> journal =
            await operationTransaction.ReadJournalAsync(
                owner,
                canvasId,
                baseline.Initial.Header.Revision,
                MaxJournalEntriesPerVerification,
                cancellationToken).ConfigureAwait(false);
        IReadOnlyList<AuthoringCanvasOperationReceipt> receipts =
            await operationTransaction.ReadReceiptsAsync(
                owner,
                canvasId,
                baseline.Initial.Header.Revision,
                MaxJournalEntriesPerVerification,
                cancellationToken).ConfigureAwait(false);
        AuthoringCanvasOperationVerificationResult journalResult = AuthoringCanvasOperationVerifier.Verify(
            baseline.Initial,
            journal,
            receipts,
            current);
        AuthoringCanvasVerificationResult documentResult = await documentStore.VerifyAsync(
            owner,
            canvasId,
            cancellationToken).ConfigureAwait(false);
        AuthoringCanvasExternalAuthoritySnapshot external = await CaptureExternalAuthorityAsync(
            cancellationToken).ConfigureAwait(false);

        var reasons = new List<string>();
        if (!journalResult.Valid)
        {
            reasons.AddRange(journalResult.Reasons.Select(static reason => $"journal:{reason}"));
        }
        if (!documentResult.Valid)
        {
            reasons.AddRange(documentResult.Reasons.Select(static reason => $"document:{reason}"));
        }
        long expectedJournalEntries = current.Header.Revision - baseline.Initial.Header.Revision;
        if (expectedJournalEntries > MaxJournalEntriesPerVerification)
        {
            reasons.Add("journal_budget_exhausted");
        }
        else if (expectedJournalEntries < 0 || journal.Count != expectedJournalEntries)
        {
            reasons.Add("journal_window_incomplete");
        }
        if (baseline.ExternalAuthority != external)
        {
            reasons.Add("external_article_or_relation_mutation_detected");
        }
        return new AuthoringCanvasOperationDatabaseVerificationResult(
            canvasId,
            current.Header.Revision,
            journal.Count,
            reasons.Count == 0,
            reasons);
    }

    private async Task<AuthoringCanvasOperationSnapshot> ReadSnapshotAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasDocumentHeader header = await documentStore.GetAsync(
            owner,
            canvasId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();
        AuthoringCanvasNode[] nodes = await ReadAllAsync(
            (cursor, token) => documentStore.ReadNodesAsync(
                owner,
                canvasId,
                cursor,
                AuthoringCanvasContract.MaxPageSize,
                token),
            AuthoringCanvasContract.MaxNodesPerCanvas,
            cancellationToken).ConfigureAwait(false);
        AuthoringCanvasEdge[] edges = await ReadAllAsync(
            (cursor, token) => documentStore.ReadEdgesAsync(
                owner,
                canvasId,
                cursor,
                AuthoringCanvasContract.MaxPageSize,
                token),
            AuthoringCanvasContract.MaxEdgesPerCanvas,
            cancellationToken).ConfigureAwait(false);
        return new AuthoringCanvasOperationSnapshot(header, nodes, edges);
    }

    private async Task<AuthoringCanvasExternalAuthoritySnapshot> CaptureExternalAuthorityAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                (SELECT COUNT(*) FROM article) AS article_count,
                COALESCE((SELECT MAX(xmin::text::bigint) FROM article), 0) AS article_generation,
                (SELECT COUNT(*) FROM article_revision) AS revision_count,
                COALESCE((SELECT MAX(xmin::text::bigint) FROM article_revision), 0) AS revision_generation,
                (SELECT COUNT(*) FROM article_tag) AS relation_count,
                COALESCE((SELECT MAX(xmin::text::bigint) FROM article_tag), 0) AS relation_generation,
                (SELECT COUNT(*) FROM article_mutation_outbox_edge) AS outbox_edge_count,
                COALESCE((SELECT MAX(xmin::text::bigint) FROM article_mutation_outbox_edge), 0)
                    AS outbox_edge_generation;
            """).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_external_authority_unavailable");
        }
        return new AuthoringCanvasExternalAuthoritySnapshot(
            reader.GetInt64(reader.GetOrdinal("article_count")),
            reader.GetInt64(reader.GetOrdinal("article_generation")),
            reader.GetInt64(reader.GetOrdinal("revision_count")),
            reader.GetInt64(reader.GetOrdinal("revision_generation")),
            reader.GetInt64(reader.GetOrdinal("relation_count")),
            reader.GetInt64(reader.GetOrdinal("relation_generation")),
            reader.GetInt64(reader.GetOrdinal("outbox_edge_count")),
            reader.GetInt64(reader.GetOrdinal("outbox_edge_generation")));
    }

    private static async Task<T[]> ReadAllAsync<T>(
        Func<AuthoringCanvasPageCursor?, CancellationToken, Task<AuthoringCanvasPage<T>>> read,
        int maximum,
        CancellationToken cancellationToken)
    {
        var values = new List<T>();
        AuthoringCanvasPageCursor? cursor = null;
        do
        {
            AuthoringCanvasPage<T> page = await read(cursor, cancellationToken).ConfigureAwait(false);
            values.AddRange(page.Items);
            if (values.Count > maximum || (page.NextCursor is not null && page.NextCursor == cursor))
            {
                throw new AuthoringCanvasBudgetExceededException("canvas_operation_verifier_snapshot_budget_exceeded");
            }
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        return values.ToArray();
    }
}

public sealed record AuthoringCanvasOperationDatabaseBaseline(
    AuthoringCanvasOperationSnapshot Initial,
    AuthoringCanvasExternalAuthoritySnapshot ExternalAuthority);

public sealed record AuthoringCanvasExternalAuthoritySnapshot(
    long ArticleCount,
    long ArticleGeneration,
    long RevisionCount,
    long RevisionGeneration,
    long RelationCount,
    long RelationGeneration,
    long OutboxEdgeCount,
    long OutboxEdgeGeneration);

public sealed record AuthoringCanvasOperationDatabaseVerificationResult(
    Guid CanvasId,
    long Revision,
    int VerifiedJournalEntries,
    bool Valid,
    IReadOnlyList<string> Reasons);
