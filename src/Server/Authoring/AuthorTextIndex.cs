using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorTextIndex
{
    private const int BatchSize = 8;
    private const int BatchSourceCharacters = 250_000;
    private static readonly Guid Scope = new("d02dce0a-3e06-42e4-a637-c6985a327eb1");
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private static readonly string Eligible = $"""
        select a.id,a.revision from public.article a
        where a.owner_id=$1 and not a.deleted and {ArchivedArticleAuthority.Available}
        """;

    internal static async Task<AuthorTextSearchPage> Read(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextQuery input, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, Scope, ct);
        await Reconcile(db, tx, actor.Id, ct);
        return await ReadPage(db, tx, actor.Id, input, ct);
    }

    // A closed set of current revisions, rather than an outbox high-water mark, witnesses
    // completeness. A late-committing writer is seen as an exact mismatch on the next read.
    private static string Changed => $"""
        eligible as materialized ({Eligible}),
        indexed as materialized (select article_id,revision from public.author_text_document where owner_id=$1 and profile={AuthorTextProfile.Version}),
        changed as (
            select coalesce(e.id,d.article_id) as id,e.revision
            from eligible e full join indexed d on d.article_id=e.id
            where e.revision is distinct from d.revision
        )
        """;

    private static async Task Reconcile(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct)
    {
        var batch = new List<Pending>(BatchSize);
        await using (var read = Store.Sql(db, tx, $"""
            with {Changed},
            picked as (select * from changed order by id limit $2)
            select p.id,p.revision,r.title,r.body
            from picked p left join public.article_revision r on r.article_id=p.id and r.revision=p.revision
            order by p.id
            """, owner, BatchSize))
        {
            read.CommandTimeout = 3;
            await using var rows = await read.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                var id = rows.GetInt32(0);
                if (rows.IsDBNull(1)) batch.Add(new(id, null, null, null));
                else
                {
                    if (rows.IsDBNull(2) || rows.IsDBNull(3)) throw InvalidIndex();
                    var title = rows.GetString(2);
                    var body = rows.GetString(3);
                    if (title.Length > AuthorTextProfile.MaxSourceChars || body.Length > AuthorTextProfile.MaxSourceChars)
                        throw InvalidIndex();
                    batch.Add(new(id, rows.GetInt64(1), title, body));
                }
            }
        }

        var sourceCharacters = 0;
        foreach (var entry in batch)
        {
            sourceCharacters += (entry.Title?.Length ?? 0) + (entry.Body?.Length ?? 0);
            if (sourceCharacters > BatchSourceCharacters) break;
            await using (var postings = Store.Sql(db, tx,
                "delete from public.author_text_posting where owner_id=$1 and article_id=$2", owner, entry.Id))
                await postings.ExecuteNonQueryAsync(ct);
            await using (var document = Store.Sql(db, tx,
                "delete from public.author_text_document where owner_id=$1 and article_id=$2", owner, entry.Id))
                await document.ExecuteNonQueryAsync(ct);
            if (entry is { Revision: { } revision, Title: { } title, Body: { } body })
            {
                await using var insert = Store.Sql(db, tx, """
                    insert into public.author_text_document(owner_id,article_id,revision,profile,title_digest,body_digest)
                    values($1,$2,$3,$4,$5,$6)
                    """, owner, entry.Id, revision, AuthorTextProfile.Version, Digest(title), Digest(body));
                await insert.ExecuteNonQueryAsync(ct);
                await using var copy = await db.BeginBinaryImportAsync("""
                    copy public.author_text_posting(owner_id,article_id,field,ordinal,term,start_u16,end_u16,start_u8,end_u8)
                    from stdin (format binary)
                    """, ct);
                await WriteTerms(copy, owner, entry.Id, 1, title, ct);
                await WriteTerms(copy, owner, entry.Id, 2, body, ct);
                await copy.CompleteAsync(ct);
            }
        }
    }

    private static async Task WriteTerms(NpgsqlBinaryImporter copy, Guid owner, int article, int field,
        string source, CancellationToken ct)
    {
        foreach (var token in AuthorTextProfile.Tokenize(source, ct))
        {
            if (Utf8.GetByteCount(token.Value) > AuthorTextProfile.MaxTermBytes) continue;
            await copy.StartRowAsync(ct);
            await copy.WriteAsync(owner, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(article, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(field, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(token.Ordinal, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(Utf8.GetBytes(token.Value), NpgsqlDbType.Bytea, ct);
            await copy.WriteAsync(token.Start, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(token.End, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(token.ByteStart, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(token.ByteEnd, NpgsqlDbType.Integer, ct);
        }
    }

    private static async Task<AuthorTextSearchPage> ReadPage(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        AuthorTextQuery input, CancellationToken ct)
    {
        var matches = new List<AuthorTextSearchRow>(WireLimits.AuthorTextSearchRows);
        var more = false;
        // This statement witnesses readiness, exact current owner/revision, term positions
        // and raw readback together. No candidate source is returned while any row is pending.
        await using (var query = Store.Sql(db, tx, $"""
            with {Changed},
            ready as (select not exists(select from changed) as complete),
            requirements as (select word,number::integer-1 as step from unnest($2::bytea[]) with ordinality t(word,number)),
            picked as materialized (
                select distinct on (p.article_id)
                    p.article_id,e.revision,p.field,p.start_u16,p.end_u16,p.start_u8,p.end_u8
                from public.author_text_posting p join eligible e on e.id=p.article_id
                where (select complete from ready) and p.owner_id=$1 and p.term=($2::bytea[])[1]
                  and not exists (
                    select from requirements q where q.step>0 and not exists (
                        select from public.author_text_posting n
                        where n.owner_id=p.owner_id and n.article_id=p.article_id and n.term=q.word
                          and (not $3 or (n.field=p.field and n.ordinal=p.ordinal+q.step))
                    )
                  )
                order by p.article_id desc,p.field,p.ordinal
                limit $4
            )
            select ready.complete,p.article_id,p.revision,p.field,p.start_u16,p.end_u16,p.start_u8,p.end_u8,r.title,
                   case p.field when 1 then r.title else r.body end,
                   case p.field when 1 then d.title_digest else d.body_digest end
            from ready left join picked p on ready.complete
            left join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
            left join public.author_text_document d on d.owner_id=$1 and d.article_id=p.article_id and d.revision=p.revision
            order by p.article_id desc
            """, owner, input.Terms.Select(term => Utf8.GetBytes(term)).ToArray(), input.Phrase, WireLimits.AuthorTextSearchRows + 1))
        {
            query.CommandTimeout = 3;
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (!rows.GetBoolean(0)) return new(false, false, []);
                if (rows.IsDBNull(1)) break;
                if (matches.Count == WireLimits.AuthorTextSearchRows)
                {
                    more = true;
                    break;
                }
                var raw = rows.GetString(9);
                var digest = rows.GetFieldValue<byte[]>(10);
                var start = rows.GetInt32(4);
                var end = rows.GetInt32(5);
                var byteStart = rows.GetInt32(6);
                var byteEnd = rows.GetInt32(7);
                if (start < 0 || end <= start || end > raw.Length || !CryptographicOperations.FixedTimeEquals(digest, Digest(raw)) ||
                    !string.Equals(AuthorTextProfile.NormalizeTerm(raw[start..end]), input.Terms[0], StringComparison.Ordinal))
                    throw InvalidIndex();
                var (snippet, highlightStart, highlightEnd) = Snippet(raw, start, end, byteStart, byteEnd);
                matches.Add(new(rows.GetInt32(1), rows.GetInt64(2), rows.GetString(8), rows.GetInt32(3), snippet,
                    highlightStart, highlightEnd, start, end, byteStart, byteEnd, digest));
            }
        }

        if (matches.Count > 0 && !await StillCurrent(db, tx, owner, matches, ct))
            return new(false, false, []);
        return new(true, more, matches);
    }

    private static async Task<bool> StillCurrent(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        IReadOnlyList<AuthorTextSearchRow> matches, CancellationToken ct)
    {
        var ids = matches.Select(row => row.Id).ToArray();
        await using (var claim = Store.Sql(db, tx, """
            select a.id from public.article a where a.id=any($1) and a.owner_id=$2 order by a.id for share
            """, ids, owner))
        {
            claim.CommandTimeout = 3;
            await claim.ExecuteNonQueryAsync(ct);
        }
        // The previous statement can wait behind an article change; re-read archive status
        // on the fresh statement after acquiring those locks.
        await using var check = Store.Sql(db, tx, $"""
            with {Changed}
            select not exists(select from changed) and not exists (
                select from unnest($2::integer[],$3::bigint[]) expected(id,revision)
                where not exists(select from eligible e where e.id=expected.id and e.revision=expected.revision)
            )
            """, owner, ids, matches.Select(row => row.Revision).ToArray());
        check.CommandTimeout = 3;
        return await check.ExecuteScalarAsync(ct) is true;
    }

    private static (string Text, int Start, int End) Snippet(string raw, int start, int end, int byteStart, int byteEnd)
    {
        var boundaries = StringInfo.ParseCombiningCharacters(raw);
        var startElement = Array.BinarySearch(boundaries, start);
        var endElement = end == raw.Length ? boundaries.Length : Array.BinarySearch(boundaries, end);
        if (startElement < 0 || endElement < 0 || Utf8.GetByteCount(raw.AsSpan(0, start)) != byteStart ||
            Utf8.GetByteCount(raw.AsSpan(start, end - start)) != byteEnd - byteStart)
            throw InvalidIndex();

        var first = Math.Max(0, startElement - 20);
        var last = Math.Min(boundaries.Length, endElement + 35);
        var left = boundaries[first];
        var right = At(last);
        while (Utf8.GetByteCount(raw.AsSpan(left, right - left)) > WireLimits.AuthorTextSearchSnippetBytes)
        {
            if (last > endElement) right = At(--last);
            else if (first < startElement) left = boundaries[++first];
            else throw InvalidIndex();
        }
        return (raw[left..right], start - left, end - left);

        int At(int element) => element == boundaries.Length ? raw.Length : boundaries[element];
    }

    private static byte[] Digest(string raw) => SHA256.HashData(Utf8.GetBytes(raw));
    private static BusinessException InvalidIndex() => new(Rejection.Conflict, "The private article index could not verify the current source.");
    private sealed record Pending(int Id, long? Revision, string? Title, string? Body);
}
