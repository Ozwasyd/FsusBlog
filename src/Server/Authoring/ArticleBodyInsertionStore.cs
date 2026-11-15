using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record ArticleBodyInsertionWitness(int Offset, int Length, byte[] SourceDigest, byte[] BodyDigest);

internal static class ArticleBodyInsertionStore
{
    internal static ArticleBodyInsertionWitness? Prepare(string source, string body, int offset, int length)
    {
        if (!Applies(source, body, offset, length))
            throw new BusinessException(Rejection.Invalid, "The saved body is not the supplied source insertion.");
        return Unique(source, body, offset, length) ? new(offset, length, Digest(source), Digest(body)) : null;
    }

    internal static async Task Record(NpgsqlConnection db, NpgsqlTransaction tx, int id, long revision, long source,
        ArticleBodyInsertionWitness witness, CancellationToken ct)
    {
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

    private static bool ValidBoundary(string value, int offset) =>
        offset >= 0 && offset <= value.Length && (offset == 0 || offset == value.Length ||
            !(char.IsHighSurrogate(value[offset - 1]) && char.IsLowSurrogate(value[offset])) &&
            !(value[offset - 1] == '\r' && value[offset] == '\n'));

    private static byte[] Digest(string text) => SHA256.HashData(Encoding.UTF8.GetBytes(text));
}
