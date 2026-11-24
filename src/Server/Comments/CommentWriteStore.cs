namespace FsusBlog.V2.Server.Comments;

internal static class CommentWriteStore
{
    internal static async Task<PublicCommentEligibility> Eligibility(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, int articleId, long publication, CancellationToken ct)
    {
        var name = await SqlCommands.Scalar(db, tx, ct, """
            select h.display_name from public.article a
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            join public.comment_public_write w on w.article_id=a.id
            join public.comment_public_handle h on h.user_id=$3
            where a.id=$1 and not a.deleted and p.publication_id=$2 and p.published_at<=statement_timestamp()
            for share of a,p,w,h
            """, articleId, publication, actor.Id) as string ??
            throw new BusinessException(Rejection.Forbidden, "Public comment submission is unavailable for this publication.");
        return new(articleId, publication, name);
    }

    internal static async Task<PublicCommentSubmissionResult> Submit(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, PublicCommentSubmission input, CancellationToken ct, long? parent = null)
    {
        input = input with { Body = Normalize(input.Body) };
        var hash = Fingerprint(input, parent);
        await Store.LockCommand(db, tx, actor.Id, input.IdempotencyKey, ct);
        if (await SqlCommands.QueryOne(db, tx, ct, """
            select c.fingerprint,c.article_id,c.comment_id,p.moderation_status
            from public.comment_submit_command c join public.comment p on p.article_id=c.article_id and p.id=c.comment_id
            where c.user_id=$1 and c.command_id=$2
            """, row => CryptographicOperations.FixedTimeEquals(hash, row.GetFieldValue<byte[]>(0))
                ? new PublicCommentSubmissionResult(row.GetInt32(1), row.GetInt64(2), row.GetInt16(3), true)
                : throw new BusinessException(Rejection.Conflict, "The comment key was used for a different submission."),
            actor.Id, input.IdempotencyKey) is { } replayed)
            return replayed;

        var eligible = await Eligibility(db, tx, actor, input.ArticleId, input.Publication, ct);
        if (!string.Equals(eligible.DisplayName, input.DisplayName, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The public display name changed. Reload and confirm it before sending.");

        var target = parent is long predecessor ? await CommentReplies.LockParent(db, tx, input.ArticleId, predecessor, ct) : null;
        var id = (long)(parent is null
            ? await SqlCommands.Scalar(db, tx, ct, """
                with identity as (select nextval(pg_get_serial_sequence('public.comment','id')) as id),
                new_comment as (
                    insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,
                        display_name,display_language,created_at)
                    select $1,id,id,0,0,false,$2,3,$3,'zh-CN',statement_timestamp() from identity returning id
                )
                insert into public.comment_submit_command(user_id,command_id,fingerprint,article_id,comment_id)
                select $4,$5,$6,$1,id from new_comment returning comment_id
                """, input.ArticleId, input.Body, eligible.DisplayName, actor.Id, input.IdempotencyKey, hash)
            : await SqlCommands.Scalar(db, tx, ct, """
                with new_comment as (
                    insert into public.comment(article_id,root_id,parent_id,parent_depth,reply_to_id,depth,
                        moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
                    values ($1,$7,$8,$9,$8,$9+1,0,false,$2,3,$3,'zh-CN',statement_timestamp()) returning id
                )
                insert into public.comment_submit_command(user_id,command_id,fingerprint,article_id,comment_id)
                select $4,$5,$6,$1,id from new_comment returning comment_id
                """, input.ArticleId, input.Body, eligible.DisplayName, actor.Id, input.IdempotencyKey, hash,
                target!.Root, parent.Value, target.Depth))!;
        if (await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct))
            await SqlCommands.Execute(db, tx, ct,
                "insert into public.comment_account_owner(article_id,comment_id,user_id) values($1,$2,$3)",
                input.ArticleId, id, actor.Id);
        return new(input.ArticleId, id, 0, false);
    }

    internal static async Task AdmitChallenge(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, PublicCommentSubmission input, CancellationToken ct, long? parent = null)
    {
        var normalized = input with { Body = Normalize(input.Body) };
        if (await SqlCommands.Scalar(db, tx, ct,
            "select fingerprint from public.comment_submit_command where user_id=$1 and command_id=$2",
            actor.Id, input.IdempotencyKey) is byte[] fingerprint)
        {
            if (!CryptographicOperations.FixedTimeEquals(fingerprint, Fingerprint(normalized, parent)))
                throw new BusinessException(Rejection.Conflict, "The comment key was used for a different submission.");
            return;
        }
        var eligible = await Eligibility(db, tx, actor, input.ArticleId, input.Publication, ct);
        if (!string.Equals(eligible.DisplayName, input.DisplayName, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The public display name changed. Reload and confirm it before sending.");
        if (parent is long predecessor) await CommentReplies.LockParent(db, tx, input.ArticleId, predecessor, ct);
    }

    private static byte[] Fingerprint(PublicCommentSubmission input, long? parent) =>
        SHA256.HashData(parent is long predecessor ? Wire.EncodePublicCommentReply(new(input.ArticleId, input.Publication,
            predecessor, input.DisplayName, input.Body, input.IdempotencyKey, input.ExplicitPublic)) : Wire.EncodePublicCommentSubmission(input));

    internal static string Normalize(string raw)
    {
        var text = raw.Trim().ReplaceLineEndings("\n");
        if (text.Length is 0 or > 1000 || Encoding.UTF8.GetByteCount(text) > WireLimits.PublicCommentBodyBytes ||
            text.Any(ch => char.IsControl(ch) && ch is not ('\r' or '\n' or '\t')))
            throw new BusinessException(Rejection.Invalid, "Public comment text exceeds its allowed length or contains control characters.");
        return text;
    }
}

internal static class CommentAuthorProof
{
    private const int SecretSize = 32;

    internal static (string Proof, byte[] Digest) Issue()
    {
        Span<byte> secret = stackalloc byte[SecretSize];
        RandomNumberGenerator.Fill(secret);
        try { return (Base64Url.EncodeToString(secret), SHA256.HashData(secret)); }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }

    internal static byte[]? Digest(string proof)
    {
        Span<byte> secret = stackalloc byte[SecretSize];
        try
        {
            return Base64Url.TryDecodeFromChars(proof, secret, out var written) && written == secret.Length &&
                Base64Url.EncodeToString(secret) == proof ? SHA256.HashData(secret) : null;
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }
}

internal static class CommentAuthorEdits
{
    private sealed record Target(int Article, long Publication, long Version, short ModerationStatus, string Body);

    internal static async Task<CommentAuthorEditDetail> Detail(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, long id,
        CancellationToken ct, bool pendingOnly = false)
    {
        var target = await Find(db, tx, owner, id, locking: false, ct);
        if (pendingOnly && target.ModerationStatus != 0) throw Missing();
        await RequireEditable(db, tx, target, ct);
        return new(target.Article, target.Publication, target.Version, target.Body);
    }

    internal static async Task<CommentAuthorChallenge> Issue(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, CancellationToken ct)
    {
        var target = await Find(db, tx, actor.Id, id, locking: true, ct);
        await RequireEditable(db, tx, target, ct);
        var (proof, digest) = CommentAuthorProof.Issue();
        var expires = (DateTime)(await SqlCommands.Scalar(db, tx, ct, """
            insert into public.comment_author_edit_challenge
                (digest,article_id,comment_id,user_id,session_digest,generation,comment_version,publication_id,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes')
            on conflict (article_id,comment_id,session_digest) do update set digest=excluded.digest,
                generation=excluded.generation,comment_version=excluded.comment_version,
                publication_id=excluded.publication_id,expires_at=excluded.expires_at
            returning expires_at
            """, digest, target.Article, id, actor.Id, session, actor.Generation, target.Version, target.Publication))!;
        await SqlCommands.Execute(db, tx, ct, """
            delete from public.comment_author_edit_challenge where digest in (
                select digest from public.comment_author_edit_challenge where expires_at<=clock_timestamp()
                order by expires_at limit 64 for update skip locked)
            """);
        return new(true, proof, expires, null, target.Version);
    }

    internal static async Task<CommentAuthorMutation> Apply(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, CommentAuthorEditRequest request, CancellationToken ct)
    {
        var body = CommentWriteStore.Normalize(request.Content);
        var digest = CommentAuthorProof.Digest(request.Challenge) ?? throw Missing();
        var target = await Find(db, tx, actor.Id, id, locking: true, ct);
        var (chVersion, chPub) = await SqlCommands.QueryRequired(db, tx, ct, """
            delete from public.comment_author_edit_challenge
            where digest=$1 and article_id=$2 and comment_id=$3 and user_id=$4 and session_digest=$5
                and generation=$6 and expires_at>clock_timestamp()
            returning comment_version,publication_id
            """, row => (row.GetInt64(0), row.GetInt64(1)), Missing, digest, target.Article, id, actor.Id, session, actor.Generation);
        if (chVersion != request.ExpectedVersion || target.Version != request.ExpectedVersion || chPub != target.Publication)
            throw Stale();
        await RequireEditable(db, tx, target, ct);
        if (string.Equals(body, target.Body, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Invalid, "The edited comment matches its current text.");

        return await SqlCommands.QueryRequired(db, tx, ct, """
            with changed as (
                update public.comment c set body=$4,edited_at=clock_timestamp(),moderation_status=0,
                    moderation_version=c.moderation_version+1
                where c.article_id=$1 and c.id=$2 and c.moderation_version=$3 and c.moderation_status=$8 and not c.deleted
                    and c.created_at+$7*interval '1 minute'>=clock_timestamp()
                    and not exists(select 1 from public.comment_blocked_region b where b.article_id=$1 and b.comment_id=$2)
                returning article_id,id,moderation_version,body,edited_at
            ), revision as (
                insert into public.comment_author_edited
                    (article_id,comment_id,user_id,comment_version,previous_version,previous_status,moderation_status,
                     previous_body,body,previous_body_digest,body_digest,happened_at)
                select article_id,id,$5,moderation_version,$3,$8,0,$6,body,pg_catalog.sha256(convert_to($6,'UTF8')),
                    pg_catalog.sha256(convert_to(body,'UTF8')),edited_at from changed
                returning article_id,comment_id,comment_version
            ), outbox as (
                insert into public.comment_author_edit_outbox(article_id,comment_id,comment_version,event_type)
                select article_id,comment_id,comment_version,'CommentEdited' from revision returning comment_id
            )
            select changed.moderation_version,changed.edited_at from changed join outbox on outbox.comment_id=changed.id
            """, result => new CommentAuthorMutation(true, "ok", result.GetInt64(0), 0, result.GetDateTime(1)),
            Stale, target.Article, id, target.Version, body, actor.Id, target.Body, WireLimits.CommentAuthorEditWindowMinutes,
            target.ModerationStatus);
    }

    private static async Task<Target> Find(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, long id, bool locking,
        CancellationToken ct)
    {
        if (id <= 0 || !await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct)) throw Missing();
        return await SqlCommands.QueryRequired(db, tx, ct, """
            select c.article_id,p.publication_id,c.moderation_version,c.moderation_status,c.body
            from public.comment_account_owner o join public.comment c on c.article_id=o.article_id and c.id=o.comment_id
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
                and p.published_at<=statement_timestamp()
            join public.article_publication_rights snapshot on snapshot.article_id=a.id and snapshot.revision=p.revision
                and snapshot.publication_id=p.publication_id
            join public.article_revision_rights rights on rights.article_id=a.id and rights.revision=snapshot.revision
            where o.user_id=$1 and c.id=$2 and c.author_mode=3 and not c.deleted
                and c.created_at+$3*interval '1 minute'>=clock_timestamp()
                and not exists(select 1 from public.comment_blocked_region b where b.article_id=c.article_id and b.comment_id=c.id)
            """ + (locking ? " for update of c for share of a,p,snapshot,rights" : ""),
            row => new Target(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt16(3), row.GetString(4)),
            Missing, owner, id, WireLimits.CommentAuthorEditWindowMinutes);
    }

    private static async Task RequireEditable(NpgsqlConnection db, NpgsqlTransaction tx, Target target, CancellationToken ct)
    {
        if (target.ModerationStatus == 1 ||
            target.ModerationStatus == 0 && await CurrentSchema.SupportsPendingCommentAuthorEditAsync(db, tx, ct)) return;
        throw Missing();
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "comment_management_not_found");
    private static BusinessException Stale() => new(Rejection.Conflict, "comment_version_conflict");
}

internal static class CommentReplies
{
    internal const string Setting = "FSUSBLOG_SIGNED_IN_COMMENT_REPLIES";
    internal sealed record Parent(long Root, int Depth);
    internal sealed record ApprovedNotice(int Article, long Reply, Guid Recipient, string Name, string Body, long Version);

    internal static async Task<Parent> LockParent(NpgsqlConnection db, NpgsqlTransaction tx, int article, long parent,
        CancellationToken ct)
    {
        if (!await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Comment replies are unavailable.");
        var target = await SqlCommands.QueryRequired(db, tx, ct, """
            select p.root_id,p.depth
            from public.comment p join public.comment r on r.article_id=p.article_id and r.id=p.root_id
            join public.article a on a.id=p.article_id and not a.deleted
            join public.article_publication publication on publication.article_id=a.id and publication.revision=a.published_revision
                and publication.published_at<=statement_timestamp()
            join public.article_publication_rights snapshot on snapshot.article_id=a.id and snapshot.revision=publication.revision
                and snapshot.publication_id=publication.publication_id
            join public.article_revision_rights rights on rights.article_id=a.id and rights.revision=snapshot.revision
            where p.article_id=$1 and p.id=$2 and p.moderation_status=1 and not p.deleted
                and r.moderation_status=1 and not r.deleted and r.parent_id is null and p.depth<32
                and not exists (select 1 from public.comment_blocked_region b
                    where b.article_id=p.article_id and b.comment_id in (p.id,r.id))
            for update of p for share of r,a,publication,snapshot,rights
            """, row => new Parent(row.GetInt64(0), row.GetInt32(1)),
            () => new BusinessException(Rejection.NotFound, "This comment cannot accept a reply."), article, parent);
        if (await SqlCommands.Scalar(db, tx, ct,
            "select exists(select 1 from public.comment where article_id=$1 and parent_id=$2 offset 499 limit 1)",
            article, parent) is true)
            throw new BusinessException(Rejection.Conflict, "This comment reached its reply limit.");
        return target;
    }

    internal static async Task DeliverApproved(NpgsqlConnection db, NpgsqlTransaction tx, int article, long reply,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        if (!await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct)) return;
        if (await FindApprovedNotice(db, tx, article, reply, ct) is { } notice)
            await DeliverNotice(db, tx, notice, fenceVisibleMessages, ct);
    }

    internal static Task<ApprovedNotice?> FindApprovedNotice(NpgsqlConnection db, NpgsqlTransaction tx, int article, long reply,
        CancellationToken ct) =>
        SqlCommands.QueryOne(db, tx, ct, """
            select recipient.id,c.display_name,c.body,c.moderation_version
            from public.comment c
            join public.comment_account_owner author on author.article_id=c.article_id and author.comment_id=c.id
            join public.comment p on p.article_id=c.article_id and p.id=c.reply_to_id and p.id=c.parent_id
            join public.comment r on r.article_id=p.article_id and r.id=p.root_id
            join public.comment_account_owner target on target.article_id=p.article_id and target.comment_id=p.id
            join public.blog_user recipient on recipient.id=target.user_id and recipient.enabled and recipient.id<>author.user_id
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication publication on publication.article_id=a.id and publication.revision=a.published_revision
                and publication.published_at<=statement_timestamp()
            join public.article_publication_rights snapshot on snapshot.article_id=a.id and snapshot.revision=publication.revision
                and snapshot.publication_id=publication.publication_id
            join public.article_revision_rights rights on rights.article_id=a.id and rights.revision=snapshot.revision
            where c.article_id=$1 and c.id=$2 and c.moderation_status=1 and not c.deleted and c.author_mode=3
                and p.moderation_status=1 and not p.deleted and p.author_mode=3
                and r.moderation_status=1 and not r.deleted and r.parent_id is null
                and not exists (select 1 from public.comment_blocked_region b
                    where b.article_id=c.article_id and b.comment_id in (c.id,p.id,r.id))
                and not exists (select 1 from public.comment_reply_notice delivered
                    where delivered.article_id=c.article_id and delivered.reply_id=c.id)
            for share of recipient,p,r,a,publication,snapshot,rights,target,author
            """, row => new ApprovedNotice(article, reply, row.GetGuid(0), row.GetString(1), row.GetString(2), row.GetInt64(3)),
            article, reply);

    internal static async Task DeliverNotice(NpgsqlConnection db, NpgsqlTransaction tx, ApprovedNotice notice,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        var excerpt = string.Concat(notice.Body.EnumerateRunes().Take(40).Select(rune => rune.ToString()));
        var text = string.Create(CultureInfo.InvariantCulture,
            $"{notice.Name} 回复了您的评论：{excerpt}。定位：/article/{notice.Article}#comment-{notice.Reply}");
        var delivered = await new InboxStore(db, tx, notice.Recipient, fenceVisibleMessages).SendAttributedNotice("收到新的评论回复", text, ct);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.comment_reply_notice(article_id,reply_id,recipient_id,conversation_id,message_id,moderation_version,delivered_at)
            values($1,$2,$3,$4,$5,$6,$7)
            """, notice.Article, notice.Reply, notice.Recipient, delivered.ConversationId, delivered.Id, notice.Version, delivered.SentAt);
    }
}

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

    internal static long Before(IQueryCollection query) =>
        query.Count == 0 ? 0
        : query.Count == 1 && query["before"] is { Count: 1 } value &&
            long.TryParse(value[0], NumberStyles.None, CultureInfo.InvariantCulture, out long before) && before > 0
            ? before : throw new BusinessException(Rejection.Invalid, "Invalid comment appeal position.");

    internal static (long Before, string Keyword, short Status) ParseOwnedQuery(IQueryCollection query)
    {
        long before = 0;
        var keyword = "";
        short status = -1;
        foreach (var pair in query)
        {
            if (pair.Value.Count != 1) throw new BusinessException(Rejection.Invalid, "Invalid comment query.");
            var raw = pair.Value[0] ?? "";
            switch (pair.Key)
            {
                case "before":
                    if (!long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out before) || before <= 0)
                        throw new BusinessException(Rejection.Invalid, "Invalid comment appeal position.");
                    break;
                case "q":
                    var trimmed = raw.Trim();
                    if (trimmed.Length > 100 || Encoding.UTF8.GetByteCount(trimmed) > 400 || trimmed.Any(char.IsControl))
                        throw new BusinessException(Rejection.Invalid, "Invalid comment search keyword.");
                    keyword = trimmed.ToLowerInvariant();
                    break;
                case "status":
                    status = raw switch
                    {
                        "" or "all" => -1, "pending" => 0, "approved" => 1, "rejected" => 2, "hidden" => 3,
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
        var rows = await SqlCommands.QueryList(db, tx, ct, """
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
                        join public.article_revision_rights arr on arr.article_id=apr.article_id and arr.revision=apr.revision
                        where apr.article_id=pub.article_id and apr.revision=pub.revision and apr.publication_id=pub.publication_id
                    )
                    and not exists(select 1 from public.comment_blocked_region b where b.article_id=c.article_id and b.comment_id=c.id)) as editable
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
            """, row => new AuthorAppealRow(row.GetInt32(0), row.GetInt64(1), row.GetBoolean(6) ? "" : row.GetString(2),
                row.GetInt16(3), row.GetInt32(4), row.IsDBNull(5) ? null : row.GetString(5), row.GetBoolean(7)),
            owner, before, Wire.CommentAppealPageSize + 1, status, keyword, pendingEditEnabled, WireLimits.CommentAuthorEditWindowMinutes);
        var hasMore = rows.Count > Wire.CommentAppealPageSize;
        if (hasMore) rows.RemoveAt(Wire.CommentAppealPageSize);
        return Wire.EncodeAuthorAppeals(rows, hasMore);
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
                order by expires_at limit 32 for update skip locked)
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
        var target = await SqlCommands.QueryRequired(db, tx, ct, $"""
            select c.article_id,adverse.id,c.moderation_version from public.comment_account_owner o
            join public.comment c on c.article_id=o.article_id and c.id=o.comment_id
            {Adverse}
            where o.user_id=$1 and c.id=$2 and not c.deleted and c.author_mode=3 for update of c
            """, row => (row.GetInt32(0), row.GetInt64(1), row.GetInt64(2)), Missing, owner, id);
        if (await SqlCommands.Scalar(db, tx, ct, "select 1 from public.comment_appeal where adverse_id=$1", target.Item2) is not null)
            throw new BusinessException(Rejection.Conflict, "An appeal already exists for this moderation decision.");
        return target;
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "This comment or appeal challenge is unavailable.");
}
