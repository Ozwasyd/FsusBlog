using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal readonly record struct AuthorTextRankKey(int PhraseRank, int FieldRank, long UpdatedAtUnixMs, int Id);
internal sealed record AuthorTextRankedRow(AuthorTextSearchRow Match, AuthorTextRankKey Key);
internal sealed record AuthorTextRankedPage(bool Ready, bool More, IReadOnlyList<AuthorTextRankedRow> Rows, byte[]? Generation);
internal sealed record AuthorTextFacetedPage(bool Ready, bool More, IReadOnlyList<AuthorTextRankedRow> Rows, byte[]? Generation,
    int Total, int[] StateCounts, IReadOnlyList<AuthorTextTaxonomyFacet> Categories, bool MoreCategories,
    IReadOnlyList<AuthorTextTaxonomyFacet> Tags, bool MoreTags);

internal static class AuthorTextIndex
{
    private const int BatchSize = 8;
    private const int BatchSourceCharacters = 250_000;
    private const string RankOrder = "p.phrase_rank desc,p.field_rank desc,p.updated_unix_ms desc,p.article_id";
    private const string RankHighlightOrder = "h.phrase desc,h.field,h.start_u16,h.clause";
    private const string RankTime = "floor(extract(epoch from a.updated_at)*1000)::bigint";
    private const string OwnerEligible = $"a.owner_id=$1 and not a.deleted and {ArchivedArticleAuthority.Available}";
    private static readonly Guid Scope = new("d02dce0a-3e06-42e4-a637-c6985a327eb1");
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private static readonly string Eligible = $"""
        select a.id,a.revision,{RankTime} as updated_unix_ms
        from public.article a
        where {OwnerEligible}
        """;

    internal static async Task<AuthorTextSearchPage> Read(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextLegacyQuery input, CancellationToken ct)
    {
        AuthorTextClause[] clauses = input.Phrase ? [new(AuthorTextField.Any, true, input.Terms)] :
            input.Terms.Select(term => new AuthorTextClause(AuthorTextField.Any, false, [term])).ToArray();
        var page = await Read(db, tx, actor, new(clauses), ranked: false, after: null, expectedGeneration: null, ct);
        return new(page.Ready, page.More, page.Rows.Select(row => row.Match).ToArray());
    }

    internal static Task<AuthorTextRankedPage> ReadRanked(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextQuery input, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct)
    {
        ValidateContinuation(after, expectedGeneration);
        return Read(db, tx, actor, input, ranked: true, after, expectedGeneration, ct);
    }

    internal static async Task<AuthorTextFacetedPage> ReadFaceted(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct)
    {
        ValidateContinuation(after, expectedGeneration);
        await Store.LockCommand(db, tx, actor.Id, Scope, ct);
        if (after is null) await Reconcile(db, tx, actor.Id, ct);
        return await ReadFacets(db, tx, actor, input, after, expectedGeneration, ct);
    }

    private static void ValidateContinuation(AuthorTextRankKey? after, byte[]? expectedGeneration)
    {
        if ((after is null) != (expectedGeneration is null) || expectedGeneration is { Length: not SHA256.HashSizeInBytes } ||
            after is { } key && (key.Id <= 0 || key.PhraseRank < 0 || key.FieldRank <= 0 || key.PhraseRank > key.FieldRank))
            throw AuthorTextCursor.Invalid();
    }

    private static async Task<AuthorTextRankedPage> Read(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextQuery input, bool ranked, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct)
    {
        await Store.LockCommand(db, tx, actor.Id, Scope, ct);
        if (after is null) await Reconcile(db, tx, actor.Id, ct);
        return await ReadPage(db, tx, actor.Id, input, ranked, after, expectedGeneration, ct);
    }

    // A closed set of current revisions, rather than an outbox high-water mark, witnesses
    // completeness. A late-committing writer is seen as an exact mismatch on the next read.
    private static string Changed => $"""
        eligible as materialized ({Eligible}),
        {IndexChanges("eligible")}
        """;

    private static string IndexChanges(string scope) => $"""
        indexed as materialized (select article_id,revision from public.author_text_document where owner_id=$1 and profile={AuthorTextProfile.Version}),
        changed as (
            select coalesce(e.id,d.article_id) as id,e.revision
            from {scope} e full join indexed d on d.article_id=e.id
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

    // Title and body weights follow the frozen author search registry. Every clause
    // contributes at most one match. Repetition cannot increase its weight.
    internal const string MatchCtes = """
        requirements as (
            select * from unnest($2::integer[],$3::integer[],$4::boolean[],$5::integer[],$6::bytea[])
                q(clause,field,phrase,step,term)
        ),
        clause_hits as materialized (
            select distinct on (p.article_id,q.clause)
                p.article_id,q.clause,q.phrase,p.field,p.ordinal,p.start_u16,p.end_u16,p.start_u8,p.end_u8
            from requirements q join public.author_text_posting p on p.owner_id=$1 and p.term=q.term
            join eligible e on e.id=p.article_id
            where (select admitted from witness) and q.step=0 and (q.field=0 or p.field=q.field)
              and not exists (
                select from requirements rest where rest.clause=q.clause and rest.step>0 and not exists (
                    select from public.author_text_posting n
                    where n.owner_id=p.owner_id and n.article_id=p.article_id and n.field=p.field
                      and n.term=rest.term and (not q.phrase or n.ordinal=p.ordinal+rest.step)
                )
              )
            order by p.article_id,q.clause,p.field,p.ordinal
        ),
        ranked_hits as (
            select h.article_id,
                coalesce(sum(case h.field when 1 then 10 else 1 end) filter (where h.phrase),0)::integer as phrase_rank,
                sum(case h.field when 1 then 10 else 1 end)::integer as field_rank
            from clause_hits h
            group by h.article_id having count(*)=$7
        )
        """;

    internal static object[] MatchArguments(Guid owner, AuthorTextQuery input)
    {
        var clauseIds = new List<int>();
        var fields = new List<int>();
        var phrases = new List<bool>();
        var steps = new List<int>();
        var terms = new List<byte[]>();
        for (var index = 0; index < input.Clauses.Length; index++)
        {
            var clause = input.Clauses[index];
            for (var step = 0; step < clause.Terms.Length; step++)
            {
                clauseIds.Add(index);
                fields.Add((int)clause.Field);
                phrases.Add(clause.Phrase);
                steps.Add(step);
                terms.Add(Utf8.GetBytes(clause.Terms[step]));
            }
        }
        return [owner, clauseIds.ToArray(), fields.ToArray(), phrases.ToArray(), steps.ToArray(), terms.ToArray(), input.Clauses.Length];
    }

    // Fixed-size, network-order fields prevent ambiguous witnesses. updated_at can move
    // without a revision increment on scheduled publication and affects the keyset order.
    private const string Generation = """
        select pg_catalog.sha256(
            pg_catalog.convert_to('fsusblog-author-text-ranked.v1','UTF8') || pg_catalog.uuid_send($1::uuid) ||
            coalesce(string_agg(pg_catalog.int4send(e.id) || pg_catalog.int8send(e.revision) ||
                pg_catalog.int8send(e.updated_unix_ms), ''::bytea order by e.id), ''::bytea))
        from eligible e
        """;

    private static async Task<AuthorTextRankedPage> ReadPage(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        AuthorTextQuery input, bool ranked, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct)
    {
        var matches = new List<AuthorTextRankedRow>(WireLimits.AuthorTextSearchRows);
        var more = false;
        byte[]? generation = null;
        var ordering = ranked ? RankOrder : "p.article_id desc";
        var highlightOrder = ranked ? RankHighlightOrder : "h.clause,h.field,h.ordinal";
        // The statement witnesses eligibility, the complete generation, and the exact
        // readback together. A stale cursor cannot reach candidate source or snippets.
        await using (var query = Store.Sql(db, tx, $"""
            with {Changed},
            readiness as (
                select complete,case when $9 and complete then ({Generation}) end as generation
                from (select not exists(select from changed) as complete) state
            ),
            witness as (
                select complete,generation,complete and ($10::bytea is null or generation=$10) as admitted from readiness
            ),
            {MatchCtes},
            selected as (
                select m.article_id,m.phrase_rank,m.field_rank,e.updated_unix_ms,e.revision
                from ranked_hits m join eligible e on e.id=m.article_id
            ),
            picked as materialized (
                select p.* from selected p
                where $11::integer is null or (p.phrase_rank,p.field_rank,p.updated_unix_ms,-p.article_id)<($11,$12,$13,-$14)
                order by {ordering} limit $8
            )
            select witness.admitted,witness.generation,p.article_id,p.revision,h.field,h.start_u16,h.end_u16,h.start_u8,h.end_u8,r.title,
                   case h.field when 1 then r.title else r.body end,
                   case h.field when 1 then d.title_digest else d.body_digest end,
                   h.clause,p.phrase_rank,p.field_rank,p.updated_unix_ms
            from witness left join picked p on witness.admitted
            left join lateral (
                select * from clause_hits h where h.article_id=p.article_id order by {highlightOrder} limit 1
            ) h on true
            left join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
            left join public.author_text_document d on d.owner_id=$1 and d.article_id=p.article_id and d.revision=p.revision
            order by {ordering}
            """, [.. MatchArguments(owner, input), WireLimits.AuthorTextSearchRows + 1, ranked,
                new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = (object?)expectedGeneration ?? DBNull.Value },
                new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Integer, Value = (object?)after?.PhraseRank ?? DBNull.Value },
                after?.FieldRank ?? 0, after?.UpdatedAtUnixMs ?? 0, after?.Id ?? 0]))
        {
            query.CommandTimeout = 3;
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (!rows.GetBoolean(0))
                {
                    if (expectedGeneration is not null) throw AuthorTextCursor.Invalid();
                    return new(false, false, [], null);
                }
                if (ranked && generation is null) generation = rows.GetFieldValue<byte[]>(1);
                if (rows.IsDBNull(2)) break;
                if (matches.Count == WireLimits.AuthorTextSearchRows)
                {
                    more = true;
                    break;
                }
                matches.Add(ReadMatch(rows, input));
            }
        }

        if ((ranked || matches.Count > 0) && !await StillCurrent(db, tx, owner, matches, generation, ct))
        {
            if (expectedGeneration is not null) throw AuthorTextCursor.Invalid();
            if (ranked) throw InvalidIndex();
            return new(false, false, [], null);
        }
        return new(true, more, matches, generation);
    }

    private static string NameWitness(string column) =>
        $"pg_catalog.int4send(octet_length(pg_catalog.convert_to({column},'UTF8'))) || pg_catalog.convert_to({column},'UTF8')";

    private static string FacetMetadata(int generationParameter) => $$"""
        owner_scope as materialized (
            select a.id,a.revision,{{RankTime}} as updated_unix_ms,{{ArticleInventoryEndpoints.CurrentState}} as state,
                coalesce(c.id,0) as category_id,coalesce(c.name,'') as category_name,
                coalesce(t.ids,'{}'::integer[]) as tag_ids,coalesce(t.witness,''::bytea) as tag_witness
            from public.article a
            {{ArticleInventoryEndpoints.CurrentSchedule(generationParameter)}}
            left join public.article_revision_category rc on rc.article_id=a.id and rc.revision=a.revision
            left join public.category c on c.id=rc.category_id
            left join lateral (
                select array_agg(tag.id order by tag.id) as ids,
                    string_agg(pg_catalog.int4send(tag.id) || {{NameWitness("tag.name")}}, ''::bytea order by tag.id) as witness
                from public.article_revision_tag link join public.tag tag on tag.id=link.tag_id
                where link.article_id=a.id and link.revision=a.revision
            ) t on true
            where {{OwnerEligible}}
        ),
        {{IndexChanges("owner_scope")}}
        """;

    // Every article contributes its exact current lifecycle and ordered taxonomy facts.
    // Names are prefixed by their UTF-8 byte length and tags by their count.
    private static readonly string FacetedGeneration = $"""
        select pg_catalog.sha256(
            pg_catalog.convert_to('fsusblog-author-text-facets.v1','UTF8') || pg_catalog.uuid_send($1::uuid) ||
            coalesce(string_agg(
                pg_catalog.int4send(e.id) || pg_catalog.int8send(e.revision) || pg_catalog.int8send(e.updated_unix_ms) ||
                pg_catalog.int4send(e.state) || pg_catalog.int4send(e.category_id) || {NameWitness("e.category_name")} ||
                pg_catalog.int4send(cardinality(e.tag_ids)) || e.tag_witness,
                ''::bytea order by e.id), ''::bytea))
        from owner_scope e
        """;

    private static async Task<AuthorTextFacetedPage> ReadFacets(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct)
    {
        var matches = new List<AuthorTextRankedRow>(WireLimits.AuthorTextSearchRows);
        var total = 0;
        int[] states = new int[WireLimits.AuthorTextSearchStateCount];
        IReadOnlyList<AuthorTextTaxonomyFacet> categories = [];
        IReadOnlyList<AuthorTextTaxonomyFacet> tags = [];
        var more = false;
        var moreCategories = false;
        var moreTags = false;
        byte[]? generation = null;

        await using (var query = Store.Sql(db, tx, $$"""
            with {{FacetMetadata(14)}},
            eligible as materialized (
                select * from owner_scope e
                where ($15=0 or e.state=$15) and ($16=0 or e.category_id=$16)
                    and ($17=0 or $17=any(e.tag_ids))
            ),
            readiness as (
                select case when not exists(select from changed) then ({{FacetedGeneration}}) end as generation
            ),
            witness as (
                select generation,generation is not null and ($9::bytea is null or generation=$9) as admitted from readiness
            ),
            {{MatchCtes}},
            selected as materialized (
                select m.article_id,m.phrase_rank,m.field_rank,e.updated_unix_ms,e.revision,
                    e.state,e.category_id,e.category_name,e.tag_ids
                from ranked_hits m join eligible e on e.id=m.article_id
            ),
            totals as (
                select count(*)::integer as total,array[
                    count(*) filter (where state=1),count(*) filter (where state=2),
                    count(*) filter (where state=3),count(*) filter (where state=4)
                ]::integer[] as states
                from selected
            ),
            category_counts as (
                select category_id as id,category_name as name,count(*)::integer as hits
                from selected where category_id>0 group by category_id,category_name
                order by hits desc,id limit {{WireLimits.AuthorTextSearchFacetRows + 1}}
            ),
            tag_counts as (
                select tag.id,tag.name,count(*)::integer as hits
                from selected m cross join lateral unnest(m.tag_ids) link(id)
                join public.tag tag on tag.id=link.id
                group by tag.id,tag.name order by hits desc,tag.id limit {{WireLimits.AuthorTextSearchFacetRows + 1}}
            ),
            category_buckets as (
                select array_agg(id order by hits desc,id) as ids,array_agg(name order by hits desc,id) as names,
                    array_agg(hits order by hits desc,id) as hits from category_counts
            ),
            tag_buckets as (
                select array_agg(id order by hits desc,id) as ids,array_agg(name order by hits desc,id) as names,
                    array_agg(hits order by hits desc,id) as hits from tag_counts
            ),
            picked as materialized (
                select p.article_id,p.phrase_rank,p.field_rank,p.updated_unix_ms,p.revision from selected p
                where $10::integer is null or
                    (p.phrase_rank,p.field_rank,p.updated_unix_ms,-p.article_id)<($10,$11,$12,-$13)
                order by {{RankOrder}} limit $8
            )
            select witness.admitted,witness.generation,p.article_id,p.revision,h.field,h.start_u16,h.end_u16,h.start_u8,h.end_u8,r.title,
                case h.field when 1 then r.title else r.body end,
                case h.field when 1 then d.title_digest else d.body_digest end,
                h.clause,p.phrase_rank,p.field_rank,p.updated_unix_ms,
                totals.total,totals.states,cb.ids,cb.names,cb.hits,tb.ids,tb.names,tb.hits
            from witness cross join totals cross join category_buckets cb cross join tag_buckets tb
            left join picked p on witness.admitted
            left join lateral (
                select * from clause_hits h where h.article_id=p.article_id order by {{RankHighlightOrder}} limit 1
            ) h on true
            left join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
            left join public.author_text_document d on d.owner_id=$1 and d.article_id=p.article_id and d.revision=p.revision
            order by {{RankOrder}}
            """, [.. MatchArguments(actor.Id, input.Text), WireLimits.AuthorTextSearchRows + 1,
                new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = (object?)expectedGeneration ?? DBNull.Value },
                new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Integer, Value = (object?)after?.PhraseRank ?? DBNull.Value },
                after?.FieldRank ?? 0, after?.UpdatedAtUnixMs ?? 0, after?.Id ?? 0, actor.Generation,
                (int?)input.Status ?? 0, input.CategoryId ?? 0, input.TagId ?? 0]))
        {
            query.CommandTimeout = 3;
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (!rows.GetBoolean(0))
                {
                    if (expectedGeneration is not null) throw AuthorTextCursor.Invalid();
                    return new(false, false, [], null, 0, states, [], false, [], false);
                }
                if (generation is null)
                {
                    generation = rows.GetFieldValue<byte[]>(1);
                    total = rows.GetInt32(16);
                    states = rows.GetFieldValue<int[]>(17);
                    (categories, moreCategories) = ReadBuckets(rows, 18);
                    (tags, moreTags) = ReadBuckets(rows, 21);
                }
                if (rows.IsDBNull(2)) break;
                if (matches.Count == WireLimits.AuthorTextSearchRows)
                {
                    more = true;
                    break;
                }
                matches.Add(ReadMatch(rows, input.Text));
            }
        }

        if (generation is null || !await StillCurrent(db, tx, actor.Id, matches, generation, ct, actor.Generation))
            throw expectedGeneration is not null ? AuthorTextCursor.Invalid() : InvalidIndex();
        return new(true, more, matches, generation, total, states, categories, moreCategories, tags, moreTags);
    }

    private static (IReadOnlyList<AuthorTextTaxonomyFacet> Facets, bool More) ReadBuckets(NpgsqlDataReader rows, int column)
    {
        if (rows.IsDBNull(column)) return ([], false);
        var ids = rows.GetFieldValue<int[]>(column);
        var names = rows.GetFieldValue<string[]>(column + 1);
        var counts = rows.GetFieldValue<int[]>(column + 2);
        var facets = new AuthorTextTaxonomyFacet[Math.Min(ids.Length, WireLimits.AuthorTextSearchFacetRows)];
        for (var index = 0; index < facets.Length; index++)
        {
            var id = ids[index];
            var name = names[index];
            if (id <= 0 || string.IsNullOrEmpty(name) || Utf8.GetByteCount(name) > WireLimits.TaxonomyNameBytes)
                throw InvalidIndex();
            facets[index] = new(id, name, counts[index]);
        }
        return (facets, ids.Length > WireLimits.AuthorTextSearchFacetRows);
    }

    private static AuthorTextRankedRow ReadMatch(NpgsqlDataReader rows, AuthorTextQuery input)
    {
        var raw = rows.GetString(10);
        var digest = rows.GetFieldValue<byte[]>(11);
        var start = rows.GetInt32(5);
        var end = rows.GetInt32(6);
        var byteStart = rows.GetInt32(7);
        var byteEnd = rows.GetInt32(8);
        var expectedTerm = input.Clauses[rows.GetInt32(12)].Terms[0];
        if (start < 0 || end <= start || end > raw.Length || !CryptographicOperations.FixedTimeEquals(digest, Digest(raw)) ||
            !string.Equals(AuthorTextProfile.NormalizeTerm(raw[start..end]), expectedTerm, StringComparison.Ordinal))
            throw InvalidIndex();
        var (snippet, highlightStart, highlightEnd) = Snippet(raw, start, end, byteStart, byteEnd);
        var id = rows.GetInt32(2);
        var match = new AuthorTextSearchRow(id, rows.GetInt64(3), rows.GetString(9), rows.GetInt32(4), snippet,
            highlightStart, highlightEnd, start, end, byteStart, byteEnd, digest);
        return new(match, new(rows.GetInt32(13), rows.GetInt32(14), rows.GetInt64(15), id));
    }

    private static async Task<bool> StillCurrent(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        IReadOnlyList<AuthorTextRankedRow> matches, byte[]? generation, CancellationToken ct, long? facetAuthorityGeneration = null)
    {
        var ids = matches.Select(row => row.Match.Id).ToArray();
        if (ids.Length > 0)
        {
            await using var claim = Store.Sql(db, tx, """
                select a.id from public.article a where a.id=any($1) and a.owner_id=$2 order by a.id for share
                """, ids, owner);
            claim.CommandTimeout = 3;
            await claim.ExecuteNonQueryAsync(ct);
        }
        // The lock can wait behind an article change. Observe the fresh archive, source
        // and ranking state in a new statement even when a ranked result has zero rows.
        var scope = facetAuthorityGeneration.HasValue ? "owner_scope" : "eligible";
        var metadata = facetAuthorityGeneration.HasValue ? FacetMetadata(5) : Changed;
        var sourceGeneration = facetAuthorityGeneration.HasValue ? FacetedGeneration : Generation;
        var parameters = new List<object> { owner, ids, matches.Select(row => row.Match.Revision).ToArray(),
            new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = (object?)generation ?? DBNull.Value } };
        if (facetAuthorityGeneration.HasValue) parameters.Add(facetAuthorityGeneration.Value);
        await using var check = Store.Sql(db, tx, $"""
            with {metadata}
            select not exists(select from changed) and ($4::bytea is null or $4=({sourceGeneration})) and not exists (
                select from unnest($2::integer[],$3::bigint[]) expected(id,revision)
                where not exists(select from {scope} e where e.id=expected.id and e.revision=expected.revision)
            )
            """, parameters.ToArray());
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
