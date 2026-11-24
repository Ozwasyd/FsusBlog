namespace FsusBlog.V2.Server.Comments;

internal static class CommentAppeals
{
    internal const string Adverse = """
        join lateral (
            select id, principal_id, next_status, comment_version
            from public.admin_comment_moderation
            where article_id=c.article_id and comment_id=c.id order by id desc limit 1
        ) adverse on adverse.next_status=c.moderation_status and adverse.comment_version=c.moderation_version-1
            and adverse.next_status=2
        """;

    internal static async Task RequireSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasCommentAppealSchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Comment appeals are unavailable.");
    }

    internal static string Reason(string? input)
    {
        var reason = input?.Trim() ?? "";
        if (reason.Length is < 10 or > 1000 || reason.Contains('\0'))
            throw new BusinessException(Rejection.Invalid, "Enter a reason of 10 to 1,000 characters.");
        return reason;
    }

    private const int OwnedSearchMaxChars = 100;
    private const int OwnedSearchMaxBytes = 400;

    internal static long Before(IQueryCollection query)
    {
        if (query.Count == 0) return 0;
        if (query.Count == 1 && query["before"] is { Count: 1 } value &&
            long.TryParse(value[0], NumberStyles.None, CultureInfo.InvariantCulture, out long before) && before > 0)
            return before;
        throw new BusinessException(Rejection.Invalid, "Invalid comment appeal position.");
    }

    internal static (long Before, string Keyword, short Status) ParseOwnedQuery(IQueryCollection query)
    {
        long before = 0;
        var keyword = "";
        short status = -1;
        foreach (var pair in query)
        {
            if (pair.Value.Count != 1)
                throw new BusinessException(Rejection.Invalid, "Invalid comment query.");
            var raw = pair.Value[0] ?? "";
            switch (pair.Key)
            {
                case "before":
                    if (!long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out before) || before <= 0)
                        throw new BusinessException(Rejection.Invalid, "Invalid comment appeal position.");
                    break;
                case "q":
                    var trimmed = raw.Trim();
                    if (trimmed.Length > OwnedSearchMaxChars ||
                        System.Text.Encoding.UTF8.GetByteCount(trimmed) > OwnedSearchMaxBytes ||
                        trimmed.Any(char.IsControl))
                        throw new BusinessException(Rejection.Invalid, "Invalid comment search keyword.");
                    keyword = trimmed.ToLowerInvariant();
                    break;
                case "status":
                    status = raw switch
                    {
                        "" or "all" => -1,
                        "pending" => 0,
                        "approved" => 1,
                        "rejected" => 2,
                        "hidden" => 3,
                        _ => throw new BusinessException(Rejection.Invalid, "Invalid comment status filter.")
                    };
                    break;
                default:
                    throw new BusinessException(Rejection.Invalid, "Invalid comment query.");
            }
        }
        return (before, keyword, status);
    }

    internal static async Task<byte[]> ReadOwned(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        IQueryCollection query, bool pendingEditEnabled, CancellationToken ct)
    {
        await RequireSchema(db, tx, ct);
        var (before, keyword, status) = ParseOwnedQuery(query);
        await using var find = Store.Sql(db, tx, """
            select c.article_id,c.id,c.body,c.moderation_status,
                case when a.id is not null then case when d.granted then 3 when not d.granted then 4
                    when c.deleted or c.moderation_status<>2 or c.moderation_version<>a.comment_version
                        or latest.id is distinct from a.adverse_id then 5 else 2 end
                     when latest.next_status=2 and latest.comment_version=c.moderation_version-1 and not c.deleted
                         and c.moderation_status=2 then 1 else 0 end,
                d.reason,c.deleted,
                ($6 and not c.deleted and c.moderation_status=0 and a.id is null
                    and c.created_at+$7*interval '1 minute'>=clock_timestamp()
                    and pub.publication_id is not null
                    and exists(
                        select 1 from public.article_publication_rights apr
                        join public.article_revision_rights arr
                            on arr.article_id=apr.article_id and arr.revision=apr.revision
                        where apr.article_id=pub.article_id and apr.revision=pub.revision
                            and apr.publication_id=pub.publication_id
                    )
                    and not exists(
                        select 1 from public.comment_blocked_region b
                        where b.article_id=c.article_id and b.comment_id=c.id
                    )) as editable
            from public.comment_account_owner o
            join public.comment c on c.article_id=o.article_id and c.id=o.comment_id and c.author_mode=3
            left join public.article art on art.id=c.article_id and not art.deleted and art.published_revision is not null
            left join public.article_publication pub on pub.article_id=art.id and pub.revision=art.published_revision and pub.published_at<=statement_timestamp()
            left join public.article_revision pub_rev on pub_rev.article_id=pub.article_id and pub_rev.revision=pub.revision
            left join lateral (
                select id,next_status,comment_version from public.admin_comment_moderation
                where article_id=c.article_id and comment_id=c.id order by id desc limit 1
            ) latest on true
            left join lateral (
                select id,comment_version,adverse_id from public.comment_appeal where article_id=c.article_id and comment_id=c.id
                    and user_id=o.user_id order by id desc limit 1
            ) a on true
            left join public.comment_appeal_decision d on d.appeal_id=a.id
            where o.user_id=$1 and ($2=0 or c.id<$2) and (not c.deleted or a.id is not null)
                and ($4 < 0 or c.moderation_status = $4)
                and ($5 = '' or (not c.deleted and strpos(lower(c.body), $5) > 0)
                    or (d.reason is not null and strpos(lower(d.reason), $5) > 0)
                    or (pub_rev.title is not null and strpos(lower(pub_rev.title), $5) > 0))
            order by c.id desc limit $3
            """, owner, before, Wire.CommentAppealPageSize + 1, status, keyword, pendingEditEnabled,
            WireLimits.CommentAuthorEditWindowMinutes);
        await using var row = await find.ExecuteReaderAsync(ct);
        List<AuthorAppealRow> rows = [];
        while (await row.ReadAsync(ct))
        {
            if (rows.Count == Wire.CommentAppealPageSize) return Wire.EncodeAuthorAppeals(rows, true);
            rows.Add(new(row.GetInt32(0), row.GetInt64(1), row.GetBoolean(6) ? "" : row.GetString(2), row.GetInt16(3),
                row.GetInt32(4), row.IsDBNull(5) ? null : row.GetString(5), row.GetBoolean(7)));
        }
        return Wire.EncodeAuthorAppeals(rows, false);
    }

    internal static async Task<CommentAuthorChallenge> Issue(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, CancellationToken ct)
    {
        await RequireSchema(db, tx, ct);
        var (article, adverse, version) = await LockTarget(db, tx, actor.Id, id, ct);
        var (proof, digest) = CommentAuthorProof.Issue();
        var expiry = (DateTime)(await SqlCommands.Scalar(db, tx, ct, """
            insert into public.comment_appeal_challenge
                (digest,article_id,comment_id,user_id,session_digest,generation,adverse_id,comment_version,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes')
            on conflict (article_id,comment_id,session_digest) do update
                set digest=excluded.digest,generation=excluded.generation,adverse_id=excluded.adverse_id,
                    comment_version=excluded.comment_version,expires_at=excluded.expires_at
            returning expires_at
            """, digest, article, id, actor.Id, session, actor.Generation, adverse, version))!;
        await SqlCommands.Execute(db, tx, ct, """
            delete from public.comment_appeal_challenge where digest in (
                select digest from public.comment_appeal_challenge where expires_at<=clock_timestamp()
                order by expires_at limit 32 for update skip locked
            )
            """);
        return new(true, proof, expiry, null, version);
    }

    internal static async Task Submit(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, byte[] session, long id,
        AuthorAppealInput request, CancellationToken ct)
    {
        await RequireSchema(db, tx, ct);
        var reason = Reason(request.Reason);
        var (article, adverse, version) = await LockTarget(db, tx, actor.Id, id, ct);
        var digest = CommentAuthorProof.Digest(request.Challenge!) ?? throw Missing();
        if (await SqlCommands.Scalar(db, tx, ct, """
            with verified as (
                delete from public.comment_appeal_challenge where digest=$1 and article_id=$2 and comment_id=$3
                    and user_id=$4 and session_digest=$5 and generation=$6 and adverse_id=$7 and comment_version=$8
                    and expires_at>clock_timestamp() returning 1
            ), submitted as (
                insert into public.comment_appeal(article_id,comment_id,user_id,adverse_id,comment_version,reason,submitted_at)
                select $2,$3,$4,$7,$8,$9,clock_timestamp() from verified returning id,submitted_at
            )
            insert into public.comment_appeal_event(appeal_id,kind,previous_status,next_status,occurred_at)
            select id,1,2,2,submitted_at from submitted returning appeal_id
            """, digest, article, id, actor.Id, session, actor.Generation, adverse, version, reason) is not long) throw Missing();
    }

    private static async Task<(int Article, long Adverse, long Version)> LockTarget(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, long id, CancellationToken ct)
    {
        if (id <= 0) throw Missing();
        await using var query = Store.Sql(db, tx, $"""
            select c.article_id,adverse.id,c.moderation_version from public.comment_account_owner o
            join public.comment c on c.article_id=o.article_id and c.id=o.comment_id
            {Adverse}
            where o.user_id=$1 and c.id=$2 and not c.deleted and c.author_mode=3
            for update of c
            """, owner, id);
        int article;
        long adverse, version;
        await using (var row = await query.ExecuteReaderAsync(ct))
        {
            await row.ReadRequired(ct, Missing);
            (article, adverse, version) = (row.GetInt32(0), row.GetInt64(1), row.GetInt64(2));
        }
        if (await SqlCommands.Scalar(db, tx, ct, "select 1 from public.comment_appeal where adverse_id=$1", adverse) is not null)
            throw new BusinessException(Rejection.Conflict, "An appeal already exists for this moderation decision.");
        return (article, adverse, version);
    }

    private static BusinessException Missing() =>
        new(Rejection.NotFound, "This comment or appeal challenge is unavailable.");
}
