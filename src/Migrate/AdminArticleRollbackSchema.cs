using System.Data;
using System.Globalization;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAdminArticleRollbackAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await CurrentSchema.HasAdminArticleRollbackSchemaAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAdminArticleRollback: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(connection, tx, "publication-rollback-admin.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAdminArticleRollback: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the optional administrator article rollback schema.");
    }

    private static async Task RecordArticleResponsibilityAsync(NpgsqlConnection connection, string articleId,
        string revisionNumber, CancellationToken ct)
    {
        if (!int.TryParse(articleId, NumberStyles.None, CultureInfo.InvariantCulture, out var article) || article <= 0 ||
            !long.TryParse(revisionNumber, NumberStyles.None, CultureInfo.InvariantCulture, out var revision) || revision <= 0)
            throw new ArgumentException("Provide a positive article ID and revision.");
        if (!Console.IsInputRedirected)
            throw new ArgumentException("Provide the historical responsibility record on redirected standard input.");
        using var input = Console.OpenStandardInput();
        var evidence = await ReadArticleResponsibilityAsync(input, ct);
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAdminArticleRollback: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);

        await using (var locked = ResponsibilitySql(connection, tx, """
            SELECT id FROM public.article WHERE id=$1 AND NOT deleted FOR UPDATE
            """, article))
            if (await locked.ExecuteScalarAsync(ct) is null)
                throw new InvalidOperationException("A live article is required to record historical responsibility.");

        var publication = await ReadResponsibilityPublicationAsync(connection, tx, article, revision, ct);
        var existing = await ReadExistingResponsibilityAsync(connection, tx, article, revision, ct);
        long snapshot;
        if (existing is not null)
        {
            if (existing.Value.Evidence != evidence || existing.Value.Publication != publication)
                throw new InvalidOperationException("This historical responsibility coordinate already has different immutable evidence.");
            snapshot = existing.Value.Snapshot;
        }
        else
        {
            await using var insert = ResponsibilitySql(connection, tx, """
                INSERT INTO public.article_revision_responsibility
                    (article_id,revision,responsible_party,basis,reference,recorded_by)
                VALUES ($1,$2,$3,$4,$5,current_user::text)
                RETURNING id
                """, article, revision, evidence.ResponsibleParty, evidence.Basis, evidence.Reference);
            snapshot = (long)(await insert.ExecuteScalarAsync(ct) ??
                throw new InvalidOperationException("Could not record historical responsibility."));
            await using var bind = ResponsibilitySql(connection, tx, """
                INSERT INTO public.article_publication_responsibility(publication_id,article_id,revision,snapshot_id)
                VALUES ($1,$2,$3,$4)
                """, publication, article, revision, snapshot);
            await bind.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            articleId = article, revision, publicationId = publication,
            responsibilitySnapshotId = snapshot, replayed = existing is not null
        }, Json));
    }

    private static async Task<long> ReadResponsibilityPublicationAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        int article, long revision, CancellationToken ct)
    {
        await using var command = ResponsibilitySql(db, tx, """
            WITH publications AS (
                SELECT h.publication_id
                FROM public.article_publication_history h
                WHERE h.article_id=$1 AND h.revision=$2 AND h.publication_id IS NOT NULL
                  AND h.kind IN ('publish','replace','retained-active')
                UNION
                SELECT p.publication_id
                FROM public.article_publication p JOIN public.article a ON a.id=p.article_id AND a.published_revision=p.revision
                WHERE p.article_id=$1 AND p.revision=$2
            )
            SELECT p.publication_id
            FROM publications p JOIN public.article_publication_rights w ON w.publication_id=p.publication_id
              AND w.article_id=$1 AND w.revision=$2
            """, article, revision);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new InvalidOperationException("The revision lacks a historical publication with a matching immutable rights snapshot.");
        var publication = row.GetInt64(0);
        if (await row.ReadAsync(ct))
            throw new InvalidOperationException("The historical publication coordinate is ambiguous.");
        return publication;
    }

    private static async Task<(long Snapshot, long Publication, HistoricalResponsibility Evidence)?> ReadExistingResponsibilityAsync(
        NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision, CancellationToken ct)
    {
        await using var command = ResponsibilitySql(db, tx, """
            SELECT r.id,p.publication_id,r.responsible_party,r.basis,r.reference
            FROM public.article_revision_responsibility r
            LEFT JOIN public.article_publication_responsibility p ON p.snapshot_id=r.id AND p.article_id=r.article_id AND p.revision=r.revision
            WHERE r.article_id=$1 AND r.revision=$2
            """, article, revision);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        if (row.IsDBNull(1)) throw new InvalidOperationException("The immutable responsibility record lacks its publication binding.");
        var existing = (row.GetInt64(0), row.GetInt64(1), new HistoricalResponsibility(row.GetString(2), row.GetString(3), row.GetString(4)));
        if (await row.ReadAsync(ct)) throw new InvalidOperationException("The immutable responsibility record has ambiguous publication bindings.");
        return existing;
    }

    private static async Task<HistoricalResponsibility> ReadArticleResponsibilityAsync(Stream input, CancellationToken ct)
    {
        const int maximum = 64 * 1024;
        var bytes = new byte[maximum + 1];
        var used = await input.ReadAtLeastAsync(bytes, bytes.Length, false, ct);
        if (used > maximum)
            throw new ArgumentException("Historical responsibility input exceeds 64 KiB.");
        using var document = JsonDocument.Parse(bytes.AsMemory(0, used), new JsonDocumentOptions { MaxDepth = 2 });
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("Provide a JSON object with responsibleParty, basis and reference strings.");
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in document.RootElement.EnumerateObject())
        {
            var limit = field.Name switch { "responsibleParty" => 256, "basis" => 4000, "reference" => 1000, _ => 0 };
            if (limit == 0 || field.Value.ValueKind != JsonValueKind.String || field.Value.GetString() is not { } value ||
                value.Length == 0 || value != value.Trim() || StrictUtf8.GetByteCount(value) > limit ||
                value.Any(ch => char.IsControl(ch) && (field.Name != "basis" || ch is not ('\t' or '\r' or '\n'))) ||
                !fields.TryAdd(field.Name, value))
                throw new ArgumentException("Historical responsibility contains a missing, invalid or repeated field.");
        }
        if (fields.Count != 3)
            throw new ArgumentException("Provide all three historical responsibility fields.");
        return new HistoricalResponsibility(fields["responsibleParty"], fields["basis"], fields["reference"]);
    }

    private static NpgsqlCommand ResponsibilitySql(NpgsqlConnection db, NpgsqlTransaction tx, string text, params object[] args)
    {
        var command = new NpgsqlCommand(text, db, tx);
        foreach (var arg in args)
            command.Parameters.AddWithValue(arg);
        return command;
    }

    private sealed record HistoricalResponsibility(string ResponsibleParty, string Basis, string Reference);
}
