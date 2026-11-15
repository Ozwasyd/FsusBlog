using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
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
}
