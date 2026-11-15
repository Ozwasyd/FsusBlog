using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record ArticleBodyInsertionWitness(int Offset, int Length, byte[] SourceDigest, byte[] BodyDigest,
    IReadOnlyList<BodyInsertion>? Insertions = null);

internal static class ArticleBodyInsertionStore
{
    internal static ArticleBodyInsertionWitness? Prepare(string source, string body, int offset, int length)
    {
        if (!Applies(source, body, offset, length))
            throw new BusinessException(Rejection.Invalid, "The saved body is not the supplied source insertion.");
        return Unique(source, body, offset, length) ? new(offset, length, Digest(source), Digest(body)) : null;
    }

    internal static ArticleBodyInsertionWitness? PrepareSequence(string source, string body, IReadOnlyList<BodyInsertion> insertions)
    {
        if (!TryReplay(source, body, insertions, out var unique))
            throw new BusinessException(Rejection.Invalid, "The saved body is not the supplied source insertion sequence.");
        return unique ? new(insertions[0].Offset, insertions[0].Length, Digest(source), Digest(body), insertions) : null;
    }

    internal static async Task Record(NpgsqlConnection db, NpgsqlTransaction tx, int id, long revision, long source,
        ArticleBodyInsertionWitness witness, CancellationToken ct)
    {
        if (witness.Insertions is { } operations)
        {
            await using var sequence = Store.Sql(db, tx, """
                insert into public.article_body_insertion
                    (article_id,revision,source_revision,offset_utf16,length_utf16,source_digest,body_digest,operations)
                values ($1,$2,$3,$4,$5,$6,$7,$8)
                """, id, revision, source, witness.Offset, witness.Length, witness.SourceDigest, witness.BodyDigest,
                operations.SelectMany(operation => new[] { operation.Offset, operation.Length }).ToArray());
            await sequence.ExecuteNonQueryAsync(ct);
            return;
        }
        if (!await CurrentSchema.HasArticleBodyInsertionAsync(db, tx, ct)) return;
        await using var write = Store.Sql(db, tx, """
            insert into public.article_body_insertion
                (article_id,revision,source_revision,offset_utf16,length_utf16,source_digest,body_digest)
            values ($1,$2,$3,$4,$5,$6,$7)
            """, id, revision, source, witness.Offset, witness.Length, witness.SourceDigest, witness.BodyDigest);
        await write.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<DraftRevisionBodyInsertion> Read(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long revision, long sourceRevision, CancellationToken ct)
    {
        var absent = new DraftRevisionBodyInsertion(id, revision, sourceRevision, false, 0, 0, "", "", "", "");
        if (sourceRevision != revision - 1 || !await CurrentSchema.HasArticleBodyInsertionAsync(db, tx, ct)) return absent;

        await using var read = Store.Sql(db, tx, """
            select e.offset_utf16,e.length_utf16,e.source_digest,e.body_digest,prior.body,head.body
            from public.article_body_insertion e
            join public.article_revision prior on prior.article_id=e.article_id and prior.revision=e.source_revision
            join public.article_revision head on head.article_id=e.article_id and head.revision=e.revision
            where e.article_id=$1 and e.revision=$2 and e.source_revision=$3
            """, id, revision, sourceRevision);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return absent;
        var offset = row.GetInt32(0);
        var length = row.GetInt32(1);
        var sourceDigest = row.GetFieldValue<byte[]>(2);
        var bodyDigest = row.GetFieldValue<byte[]>(3);
        var source = row.GetString(4);
        var body = row.GetString(5);
        if (!Applies(source, body, offset, length) || !Unique(source, body, offset, length) ||
            !CryptographicOperations.FixedTimeEquals(sourceDigest, Digest(source)) ||
            !CryptographicOperations.FixedTimeEquals(bodyDigest, Digest(body)))
            return absent;
        return new(id, revision, sourceRevision, true, offset, length, Convert.ToHexStringLower(sourceDigest),
            Convert.ToHexStringLower(bodyDigest), source, body);
    }

    internal static async Task<DraftRevisionBodyInsertionChain> ReadChain(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long revision, long sourceRevision, CancellationToken ct)
    {
        var absent = new DraftRevisionBodyInsertionChain(id, revision, sourceRevision, false, "", "", []);
        if (revision - sourceRevision > WireLimits.ArticleBodyInsertionChainEdges) return absent;
        var hasWitness = await CurrentSchema.HasArticleBodyInsertionAsync(db, tx, ct);
        var hasOperations = hasWitness && await CurrentSchema.HasArticleBodyInsertionOperationsAsync(db, tx, ct);
        var coordinates = hasWitness
            ? "e.source_revision,e.offset_utf16,e.length_utf16,e.source_digest,e.body_digest"
            : "null::bigint,null::int,null::int,null::bytea,null::bytea";
        var operationsColumn = hasOperations ? "e.operations" : "null::integer[]";
        var join = hasWitness ? "left join public.article_body_insertion e on e.article_id=r.article_id and e.revision=r.revision" : "";
        await using var read = Store.Sql(db, tx, $"""
            select r.revision,r.body,{coordinates},{operationsColumn}
            from public.article_revision r {join}
            where r.article_id=$1 and r.revision between $2 and $3
            order by r.revision
            """, id, sourceRevision, revision);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.GetInt64(0) != sourceRevision) return absent;
        var source = row.GetString(1);
        if (Encoding.UTF8.GetByteCount(source) > WireLimits.BodyBytes) return absent;
        var previousBody = source;
        var previousDigest = Digest(source);
        var previousRevision = sourceRevision;
        var edges = new List<DraftRevisionBodyInsertionEdge>((int)(revision - sourceRevision));

        while (await row.ReadAsync(ct))
        {
            var headRevision = row.GetInt64(0);
            var headBody = row.GetString(1);
            if (headRevision != previousRevision + 1 || Encoding.UTF8.GetByteCount(headBody) > WireLimits.BodyBytes)
                return absent;
            var equal = string.Equals(previousBody, headBody, StringComparison.Ordinal);
            var headDigest = equal ? previousDigest : Digest(headBody);
            IReadOnlyList<BodyInsertion> operations = [];
            if (!equal)
            {
                if (row.IsDBNull(2) || row.GetInt64(2) != previousRevision ||
                    !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(5), previousDigest) ||
                    !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(6), headDigest))
                    return absent;
                var offset = row.GetInt32(3);
                var length = row.GetInt32(4);
                if (row.IsDBNull(7)) operations = [new(offset, length)];
                else
                {
                    var encoded = row.GetFieldValue<int[]>(7);
                    if (encoded.Length is < 2 or > 2 * WireLimits.ArticleBodyInsertionOperations ||
                        encoded.Length % 2 != 0 || encoded[0] != offset || encoded[1] != length)
                        return absent;
                    var decoded = new BodyInsertion[encoded.Length / 2];
                    for (var index = 0; index < decoded.Length; index++)
                        decoded[index] = new(encoded[2 * index], encoded[2 * index + 1]);
                    operations = decoded;
                }
                if (!TryReplay(previousBody, headBody, operations, out var unique) || !unique) return absent;
            }
            edges.Add(new(Convert.ToHexStringLower(previousDigest), Convert.ToHexStringLower(headDigest), operations));
            previousBody = headBody;
            previousDigest = headDigest;
            previousRevision = headRevision;
        }
        return previousRevision == revision
            ? new(id, revision, sourceRevision, true, source, previousBody, edges)
            : absent;
    }

    private static bool TryReplay(string source, string body, IReadOnlyList<BodyInsertion> insertions, out bool unique)
    {
        unique = true;
        if (insertions.Count is < 1 or > WireLimits.ArticleBodyInsertionOperations) return false;
        if (insertions.Count == 1)
        {
            var (offset, length) = insertions[0];
            if (!Applies(source, body, offset, length)) return false;
            unique = Unique(source, body, offset, length);
            return true;
        }

        // Reverse explicit operations in a single scratch buffer. Removing an inserted
        // slice recovers the exact intermediate source for the next boundary/ambiguity check.
        var scratch = body.ToCharArray();
        var current = scratch.AsSpan();
        for (var index = insertions.Count - 1; index >= 0; index--)
        {
            var (offset, length) = insertions[index];
            if (offset < 0 || length <= 0 || offset > current.Length || length > current.Length - offset) return false;
            var end = offset + length;
            if (!ValidBoundary(current, offset) || !ValidBoundary(current, end)) return false;
            if ((offset > 0 && current[offset - 1] == current[end - 1]) ||
                (end < current.Length && current[end] == current[offset]))
                unique = false;
            current[end..].CopyTo(current[offset..]);
            current = current[..(current.Length - length)];
            if (!ValidBoundary(current, offset)) return false;
        }
        return source.AsSpan().SequenceEqual(current);
    }

    private static bool Applies(string source, string body, int offset, int length) =>
        length > 0 && length == body.Length - source.Length && ValidBoundary(source, offset) &&
        ValidBoundary(body, offset) && ValidBoundary(body, offset + length) &&
        source.AsSpan(0, offset).SequenceEqual(body.AsSpan(0, offset)) &&
        source.AsSpan(offset).SequenceEqual(body.AsSpan(offset + length));

    // After exact replay, another possible insertion coordinate exists only if the insertion can shift
    // one code unit in either direction. Decline even when that shift crosses an invalid boundary.
    private static bool Unique(string source, string body, int offset, int length) =>
        (offset == 0 || source[offset - 1] != body[offset + length - 1]) &&
        (offset == source.Length || source[offset] != body[offset]);

    private static bool ValidBoundary(ReadOnlySpan<char> value, int offset) =>
        offset >= 0 && offset <= value.Length && (offset == 0 || offset == value.Length ||
            !(char.IsHighSurrogate(value[offset - 1]) && char.IsLowSurrogate(value[offset])) &&
            !(value[offset - 1] == '\r' && value[offset] == '\n'));

    private static byte[] Digest(string text) => SHA256.HashData(Encoding.UTF8.GetBytes(text));
}
