namespace FsusBlog.V2.Server.Content;

internal readonly record struct PublicationTransparency(long Sequence, byte[] Hash)
{
    internal static async Task<PublicationTransparency> ReadHead(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        // The signer holds the publication writer and PostgreSQL instance lease for the whole batch.
        await using var read = Store.Sql(db, tx, """
            select seq,entry_sha256 from public.article_publication_transparency order by seq desc limit 1
            """);
        await using var row = await read.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? new(row.GetInt64(0), row.GetFieldValue<byte[]>(1)) : new(0, new byte[32]);
    }

    internal async Task<PublicationTransparency> Append(NpgsqlConnection db, NpgsqlTransaction tx, long sequence,
        long publication, byte[] transcript, byte[] signature, CancellationToken ct)
    {
        var receipt = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
        var entry = PublicationTransparencyV2.EntryDigest(sequence, Hash, receipt);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_publication_transparency(seq,publication_id,prev_sha256,receipt_sha256,entry_sha256)
            values($1,$2,$3,$4,$5)
            """, sequence, publication, Hash, receipt, entry);
        return new(sequence, entry);
    }
}
