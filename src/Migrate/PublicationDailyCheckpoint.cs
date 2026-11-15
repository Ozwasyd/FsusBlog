using FsusBlog.V2.Contracts;
using Npgsql;

internal static partial class Migration
{
    private static async Task<List<PublicationCheckpointEntry>> ReadDailyCheckpointEntries(NpgsqlConnection db,
        NpgsqlTransaction tx, DateTime utcMidnight, PublicationTransparencyHeadV2 head, CancellationToken ct,
        (long Sequence, byte[] Hash)? anchor = null, PublicationTransparencyHeadV2? selectedHead = null, DateTime? observedAt = null)
    {
        var until = utcMidnight.AddDays(1);
        await using var query = new NpgsqlCommand("""
            select l.seq,l.prev_sha256,l.receipt_sha256,l.entry_sha256,
                   p.origin,c.article_id,c.revision,p.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,
                   c.outbox_id,c.content_sha256,c.policy_sha256,p.key_id,p.key_version,p.key_sha256,p.issued_at,p.signature,
                   c.canonical_version,o.processed_at is not null
            from public.article_publication_transparency l
            join public.article_publication_proof p on (p.transparency_seq,p.publication_id)=(l.seq,l.publication_id)
            join public.article_publication_canonical c on c.publication_id=p.publication_id
            join public.blog_outbox o on o.id=c.outbox_id
            where l.seq <= $1 order by l.seq
            """, db, tx);
        query.Parameters.AddWithValue(head.Sequence);
        await using var row = await query.ExecuteReaderAsync(ct);
        long sequence = 0;
        var previous = new byte[32];
        var selected = new List<PublicationCheckpointEntry>();
        selectedHead ??= head;
        var anchored = anchor is null;
        if (selectedHead.Sequence > head.Sequence) throw BadCheckpointPrefix();
        while (await row.ReadAsync(ct))
        {
            if (row.GetInt64(0) != ++sequence || !previous.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(1)) || !row.GetBoolean(20))
                throw BadCheckpointPrefix();
            var claim = ReadNativeLedgerClaim(row);
            if (claim.Origin != head.Origin || (observedAt.HasValue && claim.IssuedAt > observedAt.Value))
                throw BadCheckpointPrefix();
            // The authenticated head commits to every receipt's original signing time. Verify these bytes even outside the selected day.
            var receipt = PublicationTransparencyV2.ReceiptDigest(ArticlePublicationProofPayloadV2.Build(claim), row.GetFieldValue<byte[]>(18));
            if (!receipt.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(2))) throw BadCheckpointPrefix();
            var entry = PublicationTransparencyV2.EntryDigest(sequence, previous, receipt);
            if (!entry.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) throw BadCheckpointPrefix();
            if (anchor is { } pin && sequence == pin.Sequence) anchored = entry.AsSpan().SequenceEqual(pin.Hash);
            if (sequence == selectedHead.Sequence && !entry.AsSpan().SequenceEqual(selectedHead.EntrySha256)) throw BadCheckpointPrefix();
            if (sequence <= selectedHead.Sequence && claim.IssuedAt >= utcMidnight && claim.IssuedAt < until)
            {
                if (selected.Count == PublicationCheckpointV2.MaxLeaves)
                    throw new InvalidOperationException("The selected UTC day exceeds the native checkpoint entry limit.");
                selected.Add(new(sequence, entry));
            }
            previous = entry;
        }
        if (!anchored || sequence != head.Sequence || !previous.AsSpan().SequenceEqual(head.EntrySha256)) throw BadCheckpointPrefix();
        return selected;
    }
}
