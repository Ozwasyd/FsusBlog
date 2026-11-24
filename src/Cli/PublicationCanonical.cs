using NpgsqlTypes;

internal static partial class Cli
{
    private static async Task VerifyPublicationCanonicalAsync(NpgsqlConnection connection, string? id, CancellationToken ct)
    {
        long? publication = null;
        if (id is not null)
        {
            if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value <= 0)
                throw new ArgumentException("Supply a positive native publication identity.");
            publication = value;
        }
        await CurrentSchema.VerifyAsync(connection, ct);
        await using var tx = await BeginReadOnlyAsync(connection, ct);
        if (!await CurrentSchema.HasPublicationCanonicalAsync(connection, tx, ct))
            throw new InvalidOperationException("Native publication canonical storage is not installed.");
        var hasCover = await CurrentSchema.HasPublicationCoverAsync(connection, tx, ct);
        long count = 0;
        var latestVersion = 2;
        string? receipt = null;
        await using (var command = new NpgsqlCommand($"""
            with canonical_outbox as materialized (
                select e.* from public.article_publication_canonical e
                join public.blog_outbox o on o.id=e.outbox_id and o.article_id=e.article_id and o.revision=e.revision and o.kind=e.outbox_kind
                where ($1 is null or e.publication_id=$1)
            )
            select {PublicationCanonicalFacts.Columns},{PublicationCanonicalFacts.CoverColumn(hasCover)},
                   e.outbox_id,e.content_sha256,e.policy_sha256,e.canonical_version
            from canonical_outbox e join public.article_publication_history h
              on h.publication_id=e.publication_id and h.article_id=e.article_id and h.revision=e.revision
              and h.publication_no=e.publication_no and h.happened_at=e.published_at and h.kind=e.transition
            {PublicationCanonicalFacts.RevisionJoins}
            where s.id=e.rights_snapshot_id
            order by e.publication_id
            """, connection, tx))
        {
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = (object?)publication ?? DBNull.Value });
            await using var row = await command.ExecuteReaderAsync(ct);
            while (await row.ReadAsync(ct))
            {
                var facts = PublicationCanonicalFacts.Read(row);
                if (facts.Version != row.GetInt32(26) ||
                    !CryptographicOperations.FixedTimeEquals(facts.Content, row.GetFieldValue<byte[]>(24)) ||
                    !CryptographicOperations.FixedTimeEquals(facts.Policy, row.GetFieldValue<byte[]>(25)))
                    throw new InvalidOperationException($"Native publication {facts.Publication} canonical digests differ from retained revision and policy facts.");
                count++;
                latestVersion = Math.Max(latestVersion, facts.Version);
                if (publication.HasValue)
                    receipt = JsonSerializer.Serialize(new
                    {
                        canonicalVersion = facts.Version,
                        publicationId = facts.Publication.ToString(CultureInfo.InvariantCulture),
                        articleId = facts.Article,
                        revision = facts.Revision.ToString(CultureInfo.InvariantCulture),
                        publicationNo = facts.Number,
                        publishedAtUtc = facts.PublishedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture),
                        transition = facts.Transition,
                        rightsSnapshotId = facts.RightsSnapshot.ToString(CultureInfo.InvariantCulture),
                        publicationOutboxId = row.GetInt64(23).ToString(CultureInfo.InvariantCulture),
                        contentSha256 = Convert.ToHexStringLower(facts.Content),
                        policySha256 = Convert.ToHexStringLower(facts.Policy),
                    });
            }
        }
        await using (var expected = new NpgsqlCommand("select count(*) from public.article_publication_canonical where $1 is null or publication_id=$1",
            connection, tx))
        {
            expected.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = (object?)publication ?? DBNull.Value });
            if (await expected.ExecuteScalarAsync(ct) is not long expectedCount || expectedCount != count)
                throw new InvalidOperationException("Native canonical storage contains incomplete publication coordinates.");
        }
        if (publication.HasValue && receipt is null)
            throw new InvalidOperationException("The requested publication has no native canonical binding.");
        await tx.CommitAsync(ct);
        Console.WriteLine(receipt ?? JsonSerializer.Serialize(new { canonicalVersion = latestVersion, verifiedPublications = count }));
    }
}
