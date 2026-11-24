namespace FsusBlog.V2.Server.Authoring;

internal sealed record AuthorTextRankedRow(AuthorTextSearchRow Match, AuthorTextRankKey Key);
internal sealed record AuthorTextRankedPage(bool Ready, bool More, IReadOnlyList<AuthorTextRankedRow> Rows, byte[]? Generation);
internal sealed record AuthorTextFacetedPage(bool Ready, bool More, IReadOnlyList<AuthorTextRankedRow> Rows, byte[]? Generation,
    int Total, int[] StateCounts, IReadOnlyList<AuthorTextTaxonomyFacet> Categories, bool MoreCategories,
    IReadOnlyList<AuthorTextTaxonomyFacet> Tags, bool MoreTags, AuthorTextPropertyFacet? PropertyFacet = null);

internal static partial class AuthorTextIndex
{
    private const int QueryBatchSize = 8;
    private const int BatchSourceCharacters = 250_000;
    private const string RankOrder = "p.phrase_rank desc,p.field_rank desc,p.updated_unix_ms desc,p.article_id";
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
        AuthorTextContinuation.Validate(after, expectedGeneration);
        return Read(db, tx, actor, input, ranked: true, after, expectedGeneration, ct);
    }

    internal static async Task<AuthorTextFacetedPage> ReadFaceted(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct)
    {
        AuthorTextContinuation.Validate(after, expectedGeneration);
        await Store.LockCommand(db, tx, actor.Id, Scope, ct);
        if (after is null) await Reconcile(db, tx, actor.Id, ct);
        return await ReadFacets(db, tx, actor, input, after, expectedGeneration, ct);
    }

    internal static async Task<AuthorTextFacetedPage> ReadQualified(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, long? updatedFromUnixMs, long? updatedUntilUnixMs, long schemaRevision,
        IReadOnlyList<PropertyCondition> conditions, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct,
        bool includeSummary = false, bool includeHeading = false, PropertyStore.FacetSelection? facet = null,
        PropertyStore.SortSelection? sort = null)
    {
        AuthorTextContinuation.Validate(after, expectedGeneration);
        includeSummary |= includeHeading;
        var properties = new PropertyStore(db, tx, actor);
        var (resolved, facetDefinition, sortDefinition, _) = await ResolvePropertySearch(
            db, tx, actor, properties, schemaRevision, conditions, after, ct, facet, sort);

        if (after is null) await Reconcile(db, tx, actor.Id, ct, includeSummary, includeHeading);
        return await ReadFacets(db, tx, actor, input, after, expectedGeneration, ct,
            new(updatedFromUnixMs, updatedUntilUnixMs, resolved, facetDefinition, sortDefinition), includeSummary, includeHeading);
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
    private static string Changed(bool includeSummary = false, bool includeHeading = false) => $"""
        eligible as materialized ({Eligible}),
        {IndexChanges("eligible", includeSummary, includeHeading)}
        """;

    private static string IndexChanges(string scope, bool includeSummary, bool includeHeading) => $"""
        indexed as materialized (
            select article_id,revision,profile from public.author_text_document where owner_id=$1
        ),
        changed as (
            select coalesce(e.id,d.article_id) as id,e.revision
            from {scope} e full join indexed d on d.article_id=e.id
            where e.revision is distinct from d.revision
                {(includeHeading ? $"or d.profile<>{AuthorTextProfile.HeadingIndexVersion}" :
                    includeSummary ? $"or d.profile<{AuthorTextProfile.SummaryIndexVersion}" : "")}
        )
        """;

    private static async Task Reconcile(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct,
        bool includeSummary = false, bool includeHeading = false, int batchSize = QueryBatchSize)
    {
        var batch = new List<Pending>(batchSize);
        await using (var read = Store.Sql(db, tx, $"""
            with {Changed(includeSummary, includeHeading)},
            picked as (select * from changed order by id limit $2)
            select p.id,p.revision,r.title,r.body,coalesce(r.author_summary,'')
            from picked p left join public.article_revision r on r.article_id=p.id and r.revision=p.revision
            order by p.id
            """, owner, batchSize))
        {
            read.CommandTimeout = 3;
            await using var rows = await read.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                var id = rows.GetInt32(0);
                if (rows.IsDBNull(1)) batch.Add(new(id, null, null, null, ""));
                else
                {
                    if (rows.IsDBNull(2) || rows.IsDBNull(3)) throw InvalidIndex();
                    var title = rows.GetString(2);
                    var body = rows.GetString(3);
                    var summary = rows.GetString(4);
                    if (title.Length > AuthorTextProfile.MaxSourceChars || body.Length > AuthorTextProfile.MaxSourceChars ||
                        summary.Length > WireLimits.ArticleSummaryReadChars || Utf8.GetByteCount(summary) > WireLimits.ArticleSummaryReadBytes)
                        throw InvalidIndex();
                    batch.Add(new(id, rows.GetInt64(1), title, body, summary));
                }
            }
        }

        var sourceCharacters = 0;
        foreach (var entry in batch)
        {
            sourceCharacters += (entry.Title?.Length ?? 0) + (entry.Body?.Length ?? 0) + entry.Summary.Length;
            if (sourceCharacters > BatchSourceCharacters) break;
            await SqlCommands.Execute(db, tx, ct, "delete from public.author_text_posting where owner_id=$1 and article_id=$2", owner, entry.Id);
            await SqlCommands.Execute(db, tx, ct, "delete from public.author_text_document where owner_id=$1 and article_id=$2", owner, entry.Id);
            if (entry is { Revision: { } revision, Title: { } title, Body: { } body })
            {
                var profile = includeHeading ? AuthorTextProfile.HeadingIndexVersion : AuthorTextProfile.SummaryIndexVersion;
                await SqlCommands.Execute(db, tx, ct, """
                    insert into public.author_text_document(owner_id,article_id,revision,profile,title_digest,body_digest,summary_digest)
                    values($1,$2,$3,$4,$5,$6,$7)
                    """, owner, entry.Id, revision, profile, Digest(title), Digest(body), Digest(entry.Summary));
                await using var copy = await db.BeginBinaryImportAsync("""
                    copy public.author_text_posting(owner_id,article_id,field,ordinal,term,start_u16,end_u16,start_u8,end_u8,segment)
                    from stdin (format binary)
                    """, ct);
                await WriteTerms(copy, owner, entry.Id, (int)AuthorTextField.Title, title, ct);
                await WriteTerms(copy, owner, entry.Id, (int)AuthorTextField.MarkdownBody, body, ct);
                await WriteTerms(copy, owner, entry.Id, (int)AuthorTextField.Summary, entry.Summary, ct);
                if (includeHeading) await WriteHeadingTerms(copy, owner, entry.Id, body, ct);
                await copy.CompleteAsync(ct);
            }
        }
    }

    private static async Task WriteTerms(NpgsqlBinaryImporter copy, Guid owner, int article, int field,
        string source, CancellationToken ct)
    {
        foreach (var token in AuthorTextProfile.Tokenize(source, ct))
            await WriteTerm(copy, owner, article, field, 0, token, ct);
    }

    private static async Task WriteHeadingTerms(NpgsqlBinaryImporter copy, Guid owner, int article, string source, CancellationToken ct)
    {
        var ordinal = 0;
        var segment = 0;
        var previousEnd = 0;
        var previousByteEnd = 0;
        int[]? boundaries = null;
        foreach (var block in AuthorHeadingSource.Collect(source, ct))
        {
            if (++segment > AuthorTextProfile.MaxSourceChars) throw InvalidIndex();
            foreach (var range in block.ContentRanges)
            {
                ct.ThrowIfCancellationRequested();
                if (range.Start < previousEnd || range.End <= range.Start || range.End > source.Length ||
                    char.IsLowSurrogate(source[range.Start]) || range.End < source.Length && char.IsLowSurrogate(source[range.End]))
                    throw InvalidIndex();
                boundaries ??= StringInfo.ParseCombiningCharacters(source);
                var byteStart = previousByteEnd + Utf8.GetByteCount(source.AsSpan(previousEnd, range.Start - previousEnd));
                var raw = source[range.Start..range.End];
                foreach (var token in AuthorTextProfile.Tokenize(raw, ct))
                {
                    if (ordinal >= AuthorTextProfile.MaxTerms) throw InvalidIndex();
                    var anchored = new AuthorTextTerm(token.Value, ordinal++, token.Start + range.Start, token.End + range.Start,
                        token.ByteStart + byteStart, token.ByteEnd + byteStart);
                    // A range edge can bisect a source grapheme even when it is on a scalar boundary.
                    // Omit that coordinate but retain its ordinal so a phrase cannot skip over it.
                    if (Array.BinarySearch(boundaries, anchored.Start) < 0 ||
                        anchored.End != source.Length && Array.BinarySearch(boundaries, anchored.End) < 0) continue;
                    await WriteTerm(copy, owner, article, (int)AuthorTextField.Heading, segment, anchored, ct);
                }
                previousEnd = range.End;
                previousByteEnd = byteStart + Utf8.GetByteCount(raw);
            }
        }
    }

    private static async Task WriteTerm(NpgsqlBinaryImporter copy, Guid owner, int article, int field, int segment,
        AuthorTextTerm token, CancellationToken ct)
    {
        if (Utf8.GetByteCount(token.Value) > AuthorTextProfile.MaxTermBytes) return;
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
        await copy.WriteAsync(segment, NpgsqlDbType.Integer, ct);
    }

    // Field weights follow the frozen author search registry. Every clause
    // contributes at most one match. Repetition cannot increase its weight.
    private static string FieldPriority(string field, bool includeSummary, bool includeHeading) =>
        includeHeading ? $"case {field} when 1 then 1 when 4 then 2 when 3 then 3 when 2 then 4 else 5 end" :
        includeSummary ? $"case {field} when 1 then 1 when 3 then 2 when 2 then 3 else 4 end" : field;

    private static string RankHighlightOrder(bool includeSummary, bool includeHeading = false) =>
        $"h.phrase desc,{FieldPriority("h.field", includeSummary, includeHeading)},h.start_u16,h.clause";

    // Carry each eligible article's coordinates through to ranking. Joining the materialized
    // eligible scope a second time can scan its entire contents per hit in a generic plan.
    private static string MatchCoordinates(string alias, bool faceted) => $"{alias}.revision,{alias}.updated_unix_ms" +
        (faceted ? $",{alias}.state,{alias}.category_id,{alias}.category_name,{alias}.tag_ids" : "");

    private static string ArticleClauseHits(bool includeSummary, bool includeHeading, bool faceted, bool mixed) => $"""
            select e.id as article_id,q.clause,q.phrase,p.field,p.ordinal,p.start_u16,p.end_u16,p.start_u8,p.end_u8,{MatchCoordinates("e", faceted)}
            from eligible e join requirements q on q.step=0{(mixed ? $" and q.field<>{(int)AuthorTextField.PropertyText}" : "")}
            cross join lateral (
                select c.field,c.ordinal,c.start_u16,c.end_u16,c.start_u8,c.end_u8
                from public.author_text_posting c
                where c.owner_id=$1 and c.term=q.term and c.article_id=e.id and (q.field=0 or c.field=q.field)
                  and c.field<={(includeHeading ? 4 : includeSummary ? 3 : 2)}
                  and not exists (
                    select from requirements rest where rest.clause=q.clause and rest.step>0 and not exists (
                        select from public.author_text_posting n
                        where n.owner_id=c.owner_id and n.article_id=c.article_id and n.field=c.field
                          and n.term=rest.term and (not q.phrase or n.ordinal=c.ordinal+rest.step)
                          {(includeHeading ? "and n.segment=c.segment" : "")}
                    )
                  )
                order by {FieldPriority("c.field", includeSummary, includeHeading)},c.ordinal limit 1
            ) p
            where (select admitted from witness)
            """;

    private static string MatchCtes(bool includeSummary = false, bool includeHeading = false, bool faceted = false,
        PropertyTextParameters? propertyText = null, bool mixed = false)
    {
        var hits = propertyText is { } projected ? PropertyTextClauseHits(projected.Definition) : "";
        if (propertyText is null || mixed)
        {
            var article = ArticleClauseHits(includeSummary, includeHeading, faceted, mixed);
            hits = mixed ? $"{article}\nunion all\n{hits}" : article;
        }
        const string weight = "case h.field when 1 then 10 when 4 then 6 when 3 then 4 else 1 end";
        return $"""
            requirements as (
                select * from unnest($2::integer[],$3::integer[],$4::boolean[],$5::integer[],$6::bytea[])
                    q(clause,field,phrase,step,term)
            ),
            clause_hits as materialized (
                {hits}
            ),
            ranked_hits as (
                select h.article_id,{MatchCoordinates("h", faceted)},
                    coalesce(sum({weight}) filter (where h.phrase),0)::integer as phrase_rank,
                    sum({weight})::integer as field_rank
                from clause_hits h
                group by h.article_id,{MatchCoordinates("h", faceted)} having count(*)=$7
            )
            """;
    }

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
        var highlightOrder = ranked ? RankHighlightOrder(includeSummary: false) : "h.clause,h.field,h.ordinal";
        // The statement witnesses eligibility, the complete generation, and the exact
        // readback together. A stale cursor cannot reach candidate source or snippets.
        await using (var query = Store.Sql(db, tx, $"""
            with {Changed()},
            readiness as (
                select complete,case when $9 and complete then ({Generation}) end as generation
                from (select not exists(select from changed) as complete) state
            ),
            witness as (
                select complete,generation,complete and ($10::bytea is null or generation=$10) as admitted from readiness
            ),
            {MatchCtes()},
            picked as materialized (
                select p.* from ranked_hits p
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
                SqlCommands.Optional(NpgsqlDbType.Bytea, expectedGeneration),
                SqlCommands.Optional(NpgsqlDbType.Integer, after?.PhraseRank),
                after?.FieldRank ?? 0, after?.UpdatedAtUnixMs ?? 0, after?.Id ?? 0]))
        {
            query.CommandTimeout = 3;
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (!rows.GetBoolean(0))
                {
                    if (expectedGeneration is not null) throw AuthorTextContinuation.Invalid();
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
            if (expectedGeneration is not null) throw AuthorTextContinuation.Invalid();
            if (ranked) throw InvalidIndex();
            return new(false, false, [], null);
        }
        return new(true, more, matches, generation);
    }

    private static string NameWitness(string column) =>
        $"pg_catalog.int4send(octet_length(pg_catalog.convert_to({column},'UTF8'))) || pg_catalog.convert_to({column},'UTF8')";

    private static string FacetMetadata(int generationParameter, bool includeSummary, bool includeHeading,
        PropertyTextParameters? propertyText = null, bool mixed = false) => $$"""
        owner_scope as materialized (
            select a.id,a.revision,{{RankTime}} as updated_unix_ms,{{ArticleInventorySql.CurrentState}} as state,
                coalesce(c.id,0) as category_id,coalesce(c.name,'') as category_name,
                coalesce(t.ids,'{}'::integer[]) as tag_ids,coalesce(t.witness,''::bytea) as tag_witness
            from public.article a
            {{ArticleInventorySql.CurrentSchedule(generationParameter)}}
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
        {{FacetedIndexChanges(includeSummary, includeHeading, propertyText, mixed)}}
        """;

    private static string FacetedIndexChanges(bool includeSummary, bool includeHeading, PropertyTextParameters? propertyText, bool mixed)
    {
        if (propertyText is not { } text) return IndexChanges("owner_scope", includeSummary, includeHeading);
        var properties = AuthorTextPropertyIndex.Changes("owner_scope", text.Definition, text.Revision);
        return mixed ? $"{IndexChanges("owner_scope", includeSummary, includeHeading)},\n{properties}" : properties;
    }

    private static string IndexReady(PropertyTextParameters? propertyText, bool mixed) =>
        propertyText is null ? "not exists(select from changed)" :
        mixed ? "not exists(select from changed) and not exists(select from property_text_changed)" :
        "not exists(select from property_text_changed)";

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

    private static string SourceGeneration(List<object> parameters, QualifiedFilters? qualification)
    {
        if (qualification is null || qualification.Conditions.Length == 0 && qualification.Facet is null && qualification.Sort is null)
            return FacetedGeneration;
        var references = PropertyStore.ReferenceDependencyWitness(qualification.Conditions, parameters);
        return $"""
            select pg_catalog.sha256(pg_catalog.convert_to('fsusblog-author-text-typed.v1','UTF8') || ({FacetedGeneration}) ||
                pg_catalog.int8send(coalesce((select revision from public.property_schema where owner_id=$1),0)) ||
                (select pg_catalog.sha256(coalesce(string_agg(
                    pg_catalog.int4send(e.id) || pg_catalog.int8send(coalesce(v.revision,0)),
                    ''::bytea order by e.id), ''::bytea))
                 from owner_scope e left join public.property_article v on v.article_id=e.id and v.owner_id=$1) ||
                {references})
            """;
    }

    private sealed record QualifiedFilters(long? UpdatedFromUnixMs, long? UpdatedUntilUnixMs, PropertyStore.Condition[] Conditions,
        PropertyStore.FacetDefinition? Facet, PropertyStore.SortDefinition? Sort = null, AuthorTextPropertyScope? PropertyText = null,
        bool MixedText = false);

    private static async Task<AuthorTextFacetedPage> ReadFacets(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        AuthorTextFacetedQuery input, AuthorTextRankKey? after, byte[]? expectedGeneration, CancellationToken ct,
        QualifiedFilters? qualification = null, bool includeSummary = false, bool includeHeading = false)
    {
        var matches = new List<AuthorTextRankedRow>(WireLimits.AuthorTextSearchRows);
        var total = 0;
        int[] states = new int[WireLimits.AuthorTextSearchStateCount];
        IReadOnlyList<AuthorTextTaxonomyFacet> categories = [];
        IReadOnlyList<AuthorTextTaxonomyFacet> tags = [];
        var more = false;
        var moreCategories = false;
        var moreTags = false;
        AuthorTextPropertyFacet? propertyFacet = null;
        byte[]? generation = null;

        List<object> parameters = [.. MatchArguments(actor.Id, input.Text), WireLimits.AuthorTextSearchRows + 1,
            SqlCommands.Optional(NpgsqlDbType.Bytea, expectedGeneration),
            SqlCommands.Optional(NpgsqlDbType.Integer, after?.PhraseRank),
            after?.FieldRank ?? 0, after?.UpdatedAtUnixMs ?? 0, after?.Id ?? 0, actor.Generation,
            (int?)input.Status ?? 0, input.CategoryId ?? 0, input.TagId ?? 0];
        var filter = new StringBuilder();
        if (qualification?.UpdatedFromUnixMs is long from)
        {
            parameters.Add(from);
            filter.Append(" and a.updated_unix_ms >= $").Append(parameters.Count);
        }
        if (qualification?.UpdatedUntilUnixMs is long until)
        {
            parameters.Add(until);
            filter.Append(" and a.updated_unix_ms < $").Append(parameters.Count);
        }
        if (qualification is not null)
            PropertyStore.AppendConditions(filter, parameters, qualification.Conditions);
        var text = AddPropertyTextParameters(parameters, qualification?.PropertyText);
        var mixed = qualification?.MixedText == true;
        var sourceGeneration = FacetedSourceGeneration(parameters, qualification, text);
        var matchCtes = MatchCtes(includeSummary, includeHeading, faceted: true, propertyText: text, mixed: mixed);
        var rawArticle = $"case h.field when 1 then r.title {(includeSummary ? "when 3 then r.author_summary " : "")}else r.body end";
        var articleDigest = $"case h.field when 1 then d.title_digest {(includeSummary ? "when 3 then d.summary_digest " : "")}else d.body_digest end";
        var rawProperty = $"case when octet_length(v.data::text)<={AuthorTextPropertyIndex.MaxStoredTextBytes} then v.data::text end";
        var raw = text is null ? $"{rawArticle},{articleDigest}" : mixed
            ? $"case when h.field={(int)AuthorTextField.PropertyText} then {rawProperty} else {rawArticle} end," +
              $"case when h.field={(int)AuthorTextField.PropertyText} then pd.source_digest else {articleDigest} end"
            : $"{rawProperty},pd.source_digest";
        const string articleSourceJoin = "left join public.author_text_document d on d.owner_id=$1 and d.article_id=p.article_id and d.revision=p.revision";
        var sourceJoins = text is { } source ? PropertyTextSourceJoins(source.Definition) : "";
        if (text is null || mixed) sourceJoins = $"{articleSourceJoin}\n{sourceJoins}";
        var facet = qualification?.Facet;
        var facetCtes = facet is null ? "" : PropertyStore.FacetCtes(facet, parameters);
        var sort = qualification?.Sort;
        var sortCtes = sort is null ? "" : PropertyStore.SortCtes(sort, parameters, RankOrder);
        var pageOrder = sort is null ? RankOrder : "p.sort_position";
        // The encrypted cursor holds an article ID within the exact current generation.
        // Look up its position in the server's typed order without encoding private values.
        var afterFence = sort is null
            ? "(p.phrase_rank,p.field_rank,p.updated_unix_ms,-p.article_id)<($10,$11,$12,-$13)"
            : "p.sort_position>(select sort_position from property_sort_fence)";

        await using (var query = Store.Sql(db, tx, $$"""
            with {{FacetMetadata(14, includeSummary, includeHeading, text, mixed)}},
            eligible as materialized (
                select * from owner_scope a
                where ($15=0 or a.state=$15) and ($16=0 or a.category_id=$16)
                    and ($17=0 or $17=any(a.tag_ids)){{filter}}
            ),
            readiness as (
                select case when {{IndexReady(text, mixed)}} then ({{sourceGeneration}}) end as generation
            ),
            witness as (
                select generation,generation is not null and ($9::bytea is null or generation=$9) as admitted from readiness
            ),
            {{matchCtes}},
            selected as materialized (
                select * from ranked_hits
            ),
            {{facetCtes}}
            {{sortCtes}}
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
                select p.article_id,p.phrase_rank,p.field_rank,p.updated_unix_ms,p.revision{{(sort is null ? "" : ",p.sort_position")}}
                from {{(sort is null ? "selected" : "property_sort_order")}} p
                where $10::integer is null or {{afterFence}}
                order by {{pageOrder}} limit $8
            )
            select witness.admitted{{(sort is null ? "" : " and ($10::integer is null or exists (select from property_sort_fence))")}},
                witness.generation,p.article_id,p.revision,h.field,h.start_u16,h.end_u16,h.start_u8,h.end_u8,r.title,
                {{raw}},
                h.clause,p.phrase_rank,p.field_rank,p.updated_unix_ms,
                totals.total,totals.states,cb.ids,cb.names,cb.hits,tb.ids,tb.names,tb.hits
                {{(facet is null ? "" : ",pb.missing,pb.explicit_null,pb.empty,pb.hits")}}
            from witness cross join totals cross join category_buckets cb cross join tag_buckets tb
            {{(facet is null ? "" : "cross join property_facet_buckets pb")}}
            left join picked p on witness.admitted
            left join lateral (
                select * from clause_hits h where h.article_id=p.article_id order by {{RankHighlightOrder(includeSummary, includeHeading)}} limit 1
            ) h on true
            left join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
            {{sourceJoins}}
            order by {{pageOrder}}
            """, parameters.ToArray()))
        {
            query.CommandTimeout = 3;
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (!rows.GetBoolean(0))
                {
                    if (expectedGeneration is not null) throw AuthorTextContinuation.Invalid();
                    return new(false, false, [], null, 0, states, [], false, [], false);
                }
                if (generation is null)
                {
                    generation = rows.GetFieldValue<byte[]>(1);
                    total = rows.GetInt32(16);
                    states = rows.GetFieldValue<int[]>(17);
                    (categories, moreCategories) = ReadBuckets(rows, 18);
                    (tags, moreTags) = ReadBuckets(rows, 21);
                    if (facet is not null) propertyFacet = PropertyStore.ReadFacet(facet, rows, 24);
                }
                if (rows.IsDBNull(2)) break;
                if (matches.Count == WireLimits.AuthorTextSearchRows)
                {
                    more = true;
                    break;
                }
                matches.Add(ReadMatch(rows, input.Text, qualification?.PropertyText, mixed));
            }
        }

        if (generation is null || !await StillCurrent(db, tx, actor.Id, matches, generation, ct, actor.Generation,
                qualification, includeSummary, includeHeading))
            throw expectedGeneration is not null ? AuthorTextContinuation.Invalid() : InvalidIndex();
        return new(true, more, matches, generation, total, states, categories, moreCategories, tags, moreTags, propertyFacet);
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

    private static AuthorTextRankedRow ReadMatch(NpgsqlDataReader rows, AuthorTextQuery input, AuthorTextPropertyScope? propertyText = null,
        bool mixed = false)
    {
        if (rows.IsDBNull(10) || rows.IsDBNull(11)) throw InvalidIndex();
        var id = rows.GetInt32(2);
        var field = rows.GetInt32(4);
        var raw = rows.GetString(10);
        if (field == (int)AuthorTextField.PropertyText)
        {
            if (propertyText is null) throw InvalidIndex();
            raw = PropertyStore.ReadTextSource(propertyText, id, raw) ?? throw InvalidIndex();
        }
        else if (propertyText is not null && !mixed) throw InvalidIndex();
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
        var match = new AuthorTextSearchRow(id, rows.GetInt64(3), rows.GetString(9), field, snippet,
            highlightStart, highlightEnd, start, end, byteStart, byteEnd, digest);
        return new(match, new(rows.GetInt32(13), rows.GetInt32(14), rows.GetInt64(15), id));
    }

    private static async Task<bool> StillCurrent(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        IReadOnlyList<AuthorTextRankedRow> matches, byte[]? generation, CancellationToken ct, long? facetAuthorityGeneration = null,
        QualifiedFilters? qualification = null, bool includeSummary = false, bool includeHeading = false)
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
        var parameters = new List<object> { owner, ids, matches.Select(row => row.Match.Revision).ToArray(),
            SqlCommands.Optional(NpgsqlDbType.Bytea, generation) };
        if (facetAuthorityGeneration.HasValue) parameters.Add(facetAuthorityGeneration.Value);
        var text = AddPropertyTextParameters(parameters, qualification?.PropertyText);
        var mixed = qualification?.MixedText == true;
        var metadata = facetAuthorityGeneration.HasValue ? FacetMetadata(5, includeSummary, includeHeading, text, mixed) : Changed();
        var sourceGeneration = facetAuthorityGeneration.HasValue ? FacetedSourceGeneration(parameters, qualification, text) : Generation;
        await using var check = Store.Sql(db, tx, $"""
            with {metadata}
            select {IndexReady(text, mixed)} and ($4::bytea is null or $4=({sourceGeneration})) and not exists (
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
    private sealed record Pending(int Id, long? Revision, string? Title, string? Body, string Summary);
}
