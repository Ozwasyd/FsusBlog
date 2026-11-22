using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class PublicationCanonicalStore
{
    internal static async Task Record(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision, long outbox, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPublicationCanonicalAsync(db, tx, ct)) return;
        var hasCover = await CurrentSchema.HasPublicationCoverAsync(db, tx, ct);
        PublicationCanonicalBinding binding;
        await using (var command = SqlCommands.Create(db, tx, $"""
            select {PublicationCanonicalFacts.Columns},{PublicationCanonicalFacts.CoverColumn(hasCover)}
            from public.article_publication p join public.article_publication_history h
              on h.publication_id=p.publication_id and h.article_id=p.article_id and h.revision=p.revision
              and h.publication_no=p.publication_no and h.happened_at=p.published_at
            {PublicationCanonicalFacts.RevisionJoins}
            where p.article_id=$1 and p.revision=$2
            """, article, revision))
        await using (var row = await command.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw new InvalidOperationException("The newly published coordinates cannot be bound to canonical facts.");
            binding = PublicationCanonicalFacts.Read(row);
        }

        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_publication_canonical
                (publication_id,article_id,revision,publication_no,published_at,transition,rights_snapshot_id,outbox_id,
                 outbox_kind,canonical_version,content_sha256,policy_sha256)
            values($1,$2,$3,$4,$5,$6,$7,$8,'publish',$9,$10,$11)
            """, binding.Publication, binding.Article, binding.Revision, binding.Number, binding.PublishedAt,
            binding.Transition, binding.RightsSnapshot, outbox, binding.Version, binding.Content, binding.Policy);
    }
}
