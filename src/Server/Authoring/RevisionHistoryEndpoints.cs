namespace FsusBlog.V2.Server.Authoring;

internal static class RevisionHistoryEndpoints
{
    internal static void Map(WebApplication app, string cookie, DraftMutationRoutes mutations)
    {
        app.MapCommandGet(WireRoutes.DraftRevisionHistory, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var expected = DraftRevisionQuery.Read(ctx, id);
            var cursor = ServerHttp.Query(ctx, "cursor", WireLimits.RevisionHistoryCursorChars);
            var token = ctx.Request.Cookies[cookie];
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                var published = await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
                long before = 0;
                if (cursor is not null && !RevisionHistoryCursor.TryDecode(token!, id, expected, cursor, out before))
                    throw new BusinessException(Rejection.Invalid, "Invalid or expired revision history cursor.");
                var items = await RevisionHistoryStore.Read(db, tx, id, expected, before, ct);
                var next = "";
                if (items.Count > WireLimits.RevisionHistoryPageSize)
                {
                    items.RemoveAt(items.Count - 1);
                    next = RevisionHistoryCursor.Encode(token!, id, expected, items[^1].Revision);
                }
                var page = new RevisionHistoryPage(id, expected, published, next, items);
                return ServerHttp.Frame(Wire.EncodeRevisionHistory(page));
            }, ct);
        });

        app.MapCommandGet(WireRoutes.DraftRevisionComparison, (HttpContext ctx, Store store, int id, long sourceRevision, CancellationToken ct) =>
        {
            var expected = DraftRevisionQuery.Read(ctx, id);
            var map = ServerHttp.Query(ctx, "map", 16);
            if (map is not (null or "body-insertion" or "body-chain" or "body-edit" or "properties" or "metadata"))
                throw new BusinessException(Rejection.Invalid, "Unknown saved revision map.");
            if (sourceRevision <= 0 || sourceRevision > expected || (sourceRevision == expected && map != "properties"))
                throw new BusinessException(Rejection.Invalid, "A historical source revision is required.");
            var token = ctx.Request.Cookies[cookie];
            var handle = SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                var requireCurrent = handle is not null || map is not null;
                var digest = requireCurrent ? Store.TokenDigest(token)! : null;
                if (requireCurrent) SiteSessions.RequireCurrent(actor.Id, digest!, handle);
                await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
                if (map == "metadata")
                {
                    ctx.Response.Headers.CacheControl = "no-store";
                    var metadata = await RevisionHistoryStore.ReadMetadata(db, tx, id, expected, sourceRevision, ct);
                    await Content.ArticleMediaStore.WriteCoverHeaders(db, tx, ctx.Response, id, expected, ct, sourceRevision);
                    return Reply(metadata, pair => Wire.EncodeRevisionMetadataComparison(id, expected, sourceRevision, pair.Current, pair.Source));
                }
                if (map == "properties")
                {
                    var cursor = ServerHttp.Query(ctx, "offset", 4);
                    int offset = 0;
                    if (cursor is not null && (!int.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out offset) ||
                        offset > PropertySchema.MaxDefinitions))
                        throw new BusinessException(Rejection.Invalid, "Invalid saved property cursor.");
                    return Reply(await new PropertyStore(db, tx, actor).ReadSnapshot(id, sourceRevision, offset, ct), Wire.EncodePropertyEditor);
                }
                if (map == "body-edit")
                    return Reply(await ArticleBodyInsertionStore.ReadEditChain(db, tx, id, expected, sourceRevision, ct), Wire.EncodeDraftRevisionBodyEditChain);
                if (map == "body-chain")
                    return Reply(await ArticleBodyInsertionStore.ReadChain(db, tx, id, expected, sourceRevision, ct), Wire.EncodeDraftRevisionBodyInsertionChain);
                if (map is not null)
                    return Reply(await ArticleBodyInsertionStore.Read(db, tx, id, expected, sourceRevision, ct), Wire.EncodeDraftRevisionBodyInsertion);
                var current = await RevisionHistoryStore.ReadSource(db, tx, id, expected, ct);
                var source = await RevisionHistoryStore.ReadSource(db, tx, id, sourceRevision, ct);
                var comparison = new RevisionComparison(id, expected, sourceRevision, current.Title, current.Body, source.Title, source.Body);
                return Reply(comparison, Wire.EncodeRevisionComparison);

                IResult Reply<T>(T data, Func<T, byte[]> encode)
                {
                    if (requireCurrent) SiteSessions.RequireCurrent(actor.Id, digest!, handle);
                    return ServerHttp.Frame(encode(data));
                }
            }, ct);
        });

        mutations.MapRollback();
    }
}

internal static class RevisionHistoryCursor
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal static string Encode(string session, int articleId, long revision, long before)
    {
        Span<byte> token = stackalloc byte[sizeof(long) + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(token, before);
        Authenticate(session, articleId, revision, before, token[sizeof(long)..]);
        return WebEncoders.Base64UrlEncode(token.ToArray());
    }

    internal static bool TryDecode(string session, int articleId, long revision, string token, out long before)
    {
        before = 0;
        if (token.Length != WireLimits.RevisionHistoryCursorChars ||
            token.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) return false;
        var bytes = WebEncoders.Base64UrlDecode(token);
        if (WebEncoders.Base64UrlEncode(bytes) != token) return false;
        before = BinaryPrimitives.ReadInt64LittleEndian(bytes);
        if (before <= 1 || before > revision) return false;
        Span<byte> tag = stackalloc byte[SHA256.HashSizeInBytes];
        Authenticate(session, articleId, revision, before, tag);
        return CryptographicOperations.FixedTimeEquals(bytes.AsSpan(sizeof(long)), tag);
    }

    private static void Authenticate(string session, int articleId, long revision, long before, Span<byte> tag)
    {
        var binding = new byte[SHA256.HashSizeInBytes + sizeof(int) + 2 * sizeof(long)];
        Store.TokenDigest(session)!.CopyTo(binding, 0);
        BinaryPrimitives.WriteInt32LittleEndian(binding.AsSpan(32), articleId);
        BinaryPrimitives.WriteInt64LittleEndian(binding.AsSpan(36), revision);
        BinaryPrimitives.WriteInt64LittleEndian(binding.AsSpan(44), before);
        HMACSHA256.HashData(Key, binding, tag);
    }
}

internal static class RevisionHistoryStore
{
    internal static void RequireRevision(long current, long expected)
    {
        if (current != expected) throw new BusinessException(Rejection.Conflict, "The article changed. Reload its current revision.");
    }

    internal static Task<long> LockCurrent(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, int id, long expected, CancellationToken ct) =>
        LockOwned(db, tx, actor.Id, id, ct, expected);

    internal static async Task<long> LockOwned(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int id, CancellationToken ct, long? expected = null)
    {
        var head = await OwnedArticleRead.TryLock(db, tx, owner, id, ct) ?? throw new BusinessException(Rejection.NotFound, "Article not found.");
        if (expected is { } required) RequireRevision(head.Revision, required);
        return head.PublishedRevision ?? 0;
    }

    internal static Task<(string Title, string Body, DateTimeOffset HappenedAt)> ReadSource(NpgsqlConnection db, NpgsqlTransaction tx,
        int id, long revision, CancellationToken ct) =>
        SqlCommands.QueryRequired(db, tx, ct, "select title,body,happened_at from public.article_revision where article_id=$1 and revision=$2",
            r => (r.GetString(0), r.GetString(1), r.GetFieldValue<DateTimeOffset>(2)),
            () => new BusinessException(Rejection.NotFound, "Article revision not found."), id, revision);

    internal static Task<List<RevisionHistoryItem>> Read(NpgsqlConnection db, NpgsqlTransaction tx, int id, long expected, long before, CancellationToken ct) =>
        SqlCommands.QueryList(db, tx, ct, """
            select r.revision,r.title,r.happened_at,a.source_revision,a.reason
            from public.article_revision r left join public.article_rollback a using (article_id,revision)
            where r.article_id=$1 and r.revision<=$2 and ($3=0 or r.revision<$3)
            order by r.revision desc limit $4
            """, r => new RevisionHistoryItem(r.GetInt64(0), r.GetString(1), r.GetUnixMilliseconds(2),
                r.IsDBNull(3) ? 0 : r.GetInt64(3), r.IsDBNull(4) ? "" : r.GetString(4)),
            id, expected, before, WireLimits.RevisionHistoryPageSize + 1);

    internal static async Task<(SavedRevisionMetadata Current, SavedRevisionMetadata Source)> ReadMetadata(
        NpgsqlConnection db, NpgsqlTransaction tx, int id, long expected, long source, CancellationToken ct)
    {
        var rows = await SqlCommands.QueryList(db, tx, ct, """
            select r.revision,coalesce(r.author_summary,''),c.id,c.name,t.ids,t.names
            from public.article_revision r
            left join public.article_revision_category rc using (article_id,revision)
            left join public.category c on c.id=rc.category_id
            left join lateral (
                select array_agg(tag.id order by tag.id) as ids,array_agg(tag.name order by tag.id) as names
                from public.article_revision_tag rt join public.tag tag on tag.id=rt.tag_id
                where (rt.article_id,rt.revision)=(r.article_id,r.revision)
            ) t on true
            where r.article_id=$1 and r.revision in ($2,$3) order by r.revision desc
            """, row => (row.GetInt64(0), new SavedRevisionMetadata(row.GetString(1),
                row.IsDBNull(2) ? null : new TaxonomyName(row.GetInt32(2), row.GetString(3)),
                row.IsDBNull(4) ? [] : row.GetFieldValue<int[]>(4).Zip(row.GetFieldValue<string[]>(5), (tagId, name) => new TaxonomyName(tagId, name)).ToArray())),
            id, expected, source);
        if (rows.Count != 2 || rows[0].Item1 != expected || rows[1].Item1 != source)
            throw new BusinessException(Rejection.NotFound, "Article revision metadata is unavailable.");
        return (rows[0].Item2, rows[1].Item2);
    }

    internal static Task RecordRollback(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, long newRevision, DraftRollback input, CancellationToken ct) =>
        SqlCommands.Execute(db, tx, ct, """
            insert into public.article_rollback(article_id,revision,previous_revision,source_revision,actor_id,command_id,reason)
            values($1,$2,$3,$4,$5,$6,$7)
            """, input.Id, newRevision, input.ExpectedRevision, input.SourceRevision, actor.Id, input.IdempotencyKey, input.Reason);
}
