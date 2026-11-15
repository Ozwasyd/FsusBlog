using System.Data.Common;
using System.Text;
using Npgsql;

internal static partial class Migration
{
    private const string LegacySiteConfigTable = "sys_systemconfig";
    private const string LegacySiteAuthorKey = "Seo_Author";
    private sealed record LegacySiteAuthor(LegacyTable Relation, string Value, LegacyProjection Projection);

    private static LegacyProjection LegacySiteAuthorProjection(string value) =>
        new(LegacySiteConfigTable, 1, DigestMediaDocument(new { key = LegacySiteAuthorKey, value }));

    private static async Task<LegacySiteAuthor?> ReadLegacySiteAuthorAsync(LegacySource source, DbTransaction transaction,
        LegacyTable[] catalog, CancellationToken ct)
    {
        if (transaction is not NpgsqlTransaction tx ||
            catalog.FirstOrDefault(table => table.Name == LegacySiteConfigTable) is not
                { Kind: "r", Columns: [{ Name: "key", Type: "character varying(64)" },
                                       { Name: "value", Type: "character varying(512)" }] } relation)
            return null;

        await using var query = new NpgsqlCommand($"""
            SELECT CASE WHEN cfg.key COLLATE "C"=$2 THEN cfg.value::text END
            FROM ONLY {source.Table(relation)} cfg WHERE EXISTS (
                SELECT FROM pg_class c
                JOIN pg_attribute k ON k.attrelid=c.oid AND k.attname='key' AND k.attnotnull
                JOIN pg_attribute v ON v.attrelid=c.oid AND v.attname='value' AND v.attnotnull
                JOIN pg_constraint pk ON pk.conrelid=c.oid AND pk.contype='p' AND pk.conkey=ARRAY[k.attnum]
                WHERE c.oid=to_regclass($1) AND c.relpersistence='p'
                  AND NOT EXISTS (SELECT FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
            LIMIT 2
            """, tx.Connection, tx) { CommandTimeout = LegacyCommandTimeout };
        query.Parameters.AddWithValue(source.Table(relation));
        query.Parameters.AddWithValue(LegacySiteAuthorKey);
        await using var rows = await query.ExecuteReaderAsync(ct);
        if (!await rows.ReadAsync(ct) || rows.IsDBNull(0)) return null;
        var value = rows.GetString(0);
        return await rows.ReadAsync(ct) ? null : new(relation, value, LegacySiteAuthorProjection(value));
    }

    private static string ResolveLegacySiteAuthor(string? value)
    {
        // Frozen v1 PublicSiteAuthorPolicy applies a 20-byte budget before the public manifest trims the author.
        if (string.IsNullOrWhiteSpace(value)) return "Fsu";
        var author = value.Trim();
        int bytes = 0, chars = 0;
        foreach (var rune in author.EnumerateRunes())
        {
            bytes += rune.Utf8SequenceLength;
            if (bytes > 20) break;
            chars += rune.Utf16SequenceLength;
        }
        return author[..chars].TrimEnd();
    }
}
