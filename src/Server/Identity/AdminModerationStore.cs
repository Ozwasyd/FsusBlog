namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminModerationStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private const short ClaimActive = 1;
    private const short ClaimReleased = 2;
    private const short ClaimCompleted = 3;

    internal Task<AdminModerationClaim> AcquireCommentClaim(string? session, AdminModerationClaimRequest target, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (db, tx, admin) => AcquireCommentClaim(db, tx, admin, target, ct), ct);

    internal static async Task<AdminModerationClaim> AcquireCommentClaim(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminLiveSession admin, AdminModerationClaimRequest target, CancellationToken ct)
    {
        var version = await LockPendingComment(db, tx, target.ArticleId, target.CommentId, ct);
        var token = AdminSql.Token();
        return await SqlCommands.QueryRequired(db, tx, ct, """
            insert into public.admin_comment_claim as claim
                (article_id,comment_id,principal_id,session_digest,admin_generation,claim_digest,
                 claim_generation,claim_version,claimed_comment_version,expires_at,state)
            values($1,$2,$3,$4,$5,$6,1,1,$7,clock_timestamp()+interval '2 minutes',$8)
            on conflict(article_id,comment_id) do update set
                principal_id=excluded.principal_id,session_digest=excluded.session_digest,
                admin_generation=excluded.admin_generation,claim_digest=excluded.claim_digest,
                claim_generation=claim.claim_generation+1,claim_version=claim.claim_version+1,
                claimed_comment_version=excluded.claimed_comment_version,
                expires_at=clock_timestamp()+interval '2 minutes',state=excluded.state
            where claim.state<>$8 or claim.expires_at<=clock_timestamp()
                or claim.claimed_comment_version<>excluded.claimed_comment_version
                or not exists (
                    select from public.admin_principal p join public.admin_session s on s.principal_id=p.id
                    where p.id=claim.principal_id and p.enabled and p.generation=claim.admin_generation
                        and s.digest=claim.session_digest and s.generation=p.generation and s.expires_at>clock_timestamp()
                        and exists (select from public.admin_passkey_credential where principal_id=p.id)
                )
            returning claim_generation,claim_version,expires_at
            """, r => new AdminModerationClaim(target.ArticleId, target.CommentId, version, token,
                r.GetInt64(0), r.GetInt64(1), r.GetUnixMilliseconds(2)),
            () => new BusinessException(Rejection.Conflict, "The pending comment is already claimed."),
            target.ArticleId, target.CommentId, admin.Id, admin.Digest, admin.Snapshot.Generation,
            ClaimDigest(token), version, ClaimActive);
    }

    internal Task<AdminModerationClaim> RenewCommentClaim(string? session, AdminModerationClaim claim, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await CheckClaim(db, tx, admin, Receipt(claim), ct);
            return await SqlCommands.QueryRequired(db, tx, ct, """
                update public.admin_comment_claim set claim_version=claim_version+1,
                    expires_at=clock_timestamp()+interval '2 minutes'
                where article_id=$1 and comment_id=$2 and expires_at>clock_timestamp()
                returning claim_version, expires_at
                """, r => claim with { ClaimVersion = r.GetInt64(0), ExpiresAt = r.GetUnixMilliseconds(1) },
                ModerationChanged, claim.ArticleId, claim.CommentId);
        }, ct);

    internal Task ReleaseCommentClaim(string? session, AdminModerationClaim claim, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await CheckClaim(db, tx, admin, Receipt(claim), ct);
            await CloseClaim(db, tx, claim.ArticleId, claim.CommentId, ClaimReleased, ct);
            return true;
        }, ct);

    internal Task<byte[]> BeginModerationDecisionStepUp(string? session, AdminModerationDecision decision, CancellationToken ct) =>
        stepUp.BeginStepUp(session, DecisionDigest(decision), (db, tx, admin) => CheckClaim(db, tx, admin, Receipt(decision), ct), ct);

    internal Task DecideComment(string? session, string? proof, AdminModerationDecision decision, CancellationToken ct,
        bool fenceVisibleMessages = false) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, DecisionDigest(decision), ct))
                throw new ModerationProofRequiredException();
            await CheckClaim(db, tx, admin, Receipt(decision), ct);
            var (_, notice) = await ApplyCommentDecision(db, tx, admin, Receipt(decision), checked((short)decision.Decision), decision.Reason, ct);
            if (notice) await CommentReplies.DeliverApproved(db, tx, decision.ArticleId, decision.CommentId, fenceVisibleMessages, ct);
            return true;
        }, ct);

    internal static async Task<(long AuditId, bool Notice)> ApplyCommentDecision(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminLiveSession admin, ClaimCoordinates claim, short status, string reason, CancellationToken ct)
    {
        if (await SqlCommands.Scalar(db, tx, ct, """
            update public.comment set moderation_status=$4, moderation_version=moderation_version+1
            where article_id=$1 and id=$2 and moderation_version=$3 and moderation_status=0 and not deleted
            returning reply_to_id is not null and reply_to_id=parent_id and author_mode=3
            """, claim.ArticleId, claim.CommentId, claim.CommentVersion, status) is not bool signedReply) throw ModerationChanged();
        await CloseClaim(db, tx, claim.ArticleId, claim.CommentId, ClaimCompleted, ct);
        return ((long)(await SqlCommands.Scalar(db, tx, ct, """
            insert into public.admin_comment_moderation
                (article_id,comment_id,principal_id,previous_status,next_status,reason,happened_at,comment_version)
            values($1,$2,$3,0,$4,$5,clock_timestamp(),$6) returning id
            """, claim.ArticleId, claim.CommentId, admin.Id, status, reason, claim.CommentVersion))!, status == 1 && signedReply);
    }

    internal sealed record ClaimCoordinates(int ArticleId, long CommentId, long CommentVersion, string Token, long Generation, long Version);

    internal static ClaimCoordinates Receipt(AdminModerationClaim claim) =>
        new(claim.ArticleId, claim.CommentId, claim.CommentVersion, claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);

    internal static ClaimCoordinates Receipt(AdminModerationDecision decision) =>
        new(decision.ArticleId, decision.CommentId, decision.CommentVersion, decision.ClaimToken, decision.ClaimGeneration, decision.ClaimVersion);

    internal static byte[] DecisionDigest(AdminModerationDecision decision) =>
        SHA256.HashData(Wire.EncodeAdminModerationDecision(decision));

    private static byte[] ClaimDigest(string token) => AdminSql.ChallengeDigest(token, null);

    private static async Task<long> LockPendingComment(NpgsqlConnection db, NpgsqlTransaction tx, int article, long comment,
        CancellationToken ct) =>
        (await SqlCommands.Scalar(db, tx, ct, """
            select c.moderation_version from public.comment c join public.article a on a.id=c.article_id
            join public.comment_submit_command s on s.article_id=c.article_id and s.comment_id=c.id
            where c.article_id=$1 and c.id=$2 and c.moderation_status=0 and not c.deleted and not a.deleted
            for update of c for share of a,s
            """, article, comment) as long?) ?? throw ModerationChanged();

    internal static async Task CheckClaim(NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin, ClaimCoordinates claim,
        CancellationToken ct)
    {
        if (await LockPendingComment(db, tx, claim.ArticleId, claim.CommentId, ct) != claim.CommentVersion)
            throw ModerationChanged();
        if (await SqlCommands.Scalar(db, tx, ct, """
            select 1 from public.admin_comment_claim
            where article_id=$1 and comment_id=$2 and claim_digest=$3 and principal_id=$4 and session_digest=$5
                and admin_generation=$6 and claim_generation=$7 and claim_version=$8
                and claimed_comment_version=$9 and state=$10 and expires_at>clock_timestamp()
            for update
            """, claim.ArticleId, claim.CommentId, ClaimDigest(claim.Token), admin.Id, admin.Digest, admin.Snapshot.Generation,
            claim.Generation, claim.Version, claim.CommentVersion, ClaimActive) is null) throw ModerationChanged();
    }

    private static async Task CloseClaim(NpgsqlConnection db, NpgsqlTransaction tx, int article, long comment, short state,
        CancellationToken ct)
    {
        if (await SqlCommands.Execute(db, tx, ct, """
            update public.admin_comment_claim set state=$3, claim_version=claim_version+1
            where article_id=$1 and comment_id=$2 and expires_at>clock_timestamp()
            """, article, comment, state) != 1) throw ModerationChanged();
    }

    private static BusinessException ModerationChanged() => new(Rejection.Conflict, "The pending comment or claim changed.");
}

internal sealed class ModerationProofRequiredException : ProofRequiredException;

internal sealed class AdminModerationBatchStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<IReadOnlyList<AdminModerationClaim>> AcquireModerationBatch(string? session,
        IReadOnlyList<AdminModerationClaimRequest> targets, CancellationToken ct) =>
        gate.WithLiveAdmin<IReadOnlyList<AdminModerationClaim>>(session, async (db, tx, admin) =>
        {
            await RequireModerationBatchSchema(db, tx, ct);
            var claims = new AdminModerationClaim[targets.Count];
            var conflicts = 0;
            foreach (var (target, index) in targets.Select((target, index) => (target, index))
                .OrderBy(row => row.target.ArticleId).ThenByDescending(row => row.target.CommentId))
            {
                try { claims[index] = await AdminModerationStore.AcquireCommentClaim(db, tx, admin, target, ct); }
                catch (BusinessException error) when (error.Rejection == Rejection.Conflict) { conflicts |= 1 << index; }
            }
            if (conflicts != 0) throw new ModerationBatchConflictException(conflicts);
            return claims;
        }, ct);

    internal Task<byte[]> BeginModerationBatchStepUp(string? session, byte[] frame, CancellationToken ct)
    {
        var decision = Wire.DecodeAdminModerationBatchDecision(frame);
        return stepUp.BeginStepUp(session, SHA256.HashData(frame), async (db, tx, admin) =>
        {
            await RequireModerationBatchSchema(db, tx, ct);
            await VerifyModerationBatchClaims(db, tx, admin, decision, ct);
        }, ct, AdminStepUpAction.ModerateCommentBatch);
    }

    internal Task<byte[]> CompleteModerationBatchStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.ModerateCommentBatch, ct, RequireModerationBatchSchema);

    internal Task<AdminModerationBatchReceipt> DecideModerationBatch(string? session, string? proof, byte[] frame,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        var decision = Wire.DecodeAdminModerationBatchDecision(frame);
        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await RequireModerationBatchSchema(db, tx, ct);
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, SHA256.HashData(frame), ct, AdminStepUpAction.ModerateCommentBatch))
                throw new ModerationProofRequiredException();
            var ordered = await VerifyModerationBatchClaims(db, tx, admin, decision, ct);
            var status = checked((short)decision.Decision);
            var batch = (long)(await SqlCommands.Scalar(db, tx, ct, """
                insert into public.admin_comment_batch(principal_id,session_reference,decision,item_count,decided_at)
                values($1,$2,$3,$4,clock_timestamp()) returning id
                """, admin.Id, SHA256.HashData(admin.Digest), status, decision.Rows.Count))!;
            var audits = new List<long>(ordered.Length);
            var approved = new List<AdminModerationStore.ClaimCoordinates>();
            foreach (var (row, index) in ordered)
            {
                var claim = Receipt(row);
                try
                {
                    var (audit, notice) = await AdminModerationStore.ApplyCommentDecision(db, tx, admin, claim, status, decision.Reason, ct);
                    audits.Add(audit);
                    if (notice) approved.Add(claim);
                }
                catch (BusinessException error) when (error.Rejection == Rejection.Conflict)
                { throw new ModerationBatchConflictException(1 << index); }
            }
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.admin_comment_batch_item(batch_id,moderation_id)
                select $1, audit_id from unnest($2::bigint[]) as audit_id
                """, batch, audits.ToArray());
            if (approved.Count > 0 && await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct))
                await DeliverModerationBatchNotices(db, tx, approved, fenceVisibleMessages, ct);
            return new AdminModerationBatchReceipt(batch, ordered.Length);
        }, ct);
    }

    private static async Task<(AdminModerationBatchItem Row, int Index)[]> VerifyModerationBatchClaims(NpgsqlConnection db,
        NpgsqlTransaction tx, AdminLiveSession admin, AdminModerationBatchDecision decision, CancellationToken ct)
    {
        var ordered = decision.Rows.Select((row, index) => (Row: row, Index: index))
            .OrderBy(target => target.Row.ArticleId).ThenByDescending(target => target.Row.CommentId).ToArray();
        var conflicts = 0;
        foreach (var (row, index) in ordered)
        {
            try
            {
                await AdminModerationStore.CheckClaim(db, tx, admin, Receipt(row), ct);
                if (decision.Decision == 1 && await SqlCommands.Scalar(db, tx, ct, """
                    select 1 from public.comment_blocked_region where article_id=$1 and comment_id=$2 limit 1
                    """, row.ArticleId, row.CommentId) is not null) conflicts |= 1 << index;
            }
            catch (BusinessException error) when (error.Rejection == Rejection.Conflict) { conflicts |= 1 << index; }
        }
        if (conflicts != 0) throw new ModerationBatchConflictException(conflicts);
        return ordered;
    }

    private static AdminModerationStore.ClaimCoordinates Receipt(AdminModerationBatchItem row) =>
        new(row.ArticleId, row.CommentId, row.CommentVersion, row.ClaimToken, row.ClaimGeneration, row.ClaimVersion);

    private static async Task DeliverModerationBatchNotices(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyList<AdminModerationStore.ClaimCoordinates> approved, bool fenceVisibleMessages, CancellationToken ct)
    {
        var notices = new List<CommentReplies.ApprovedNotice>(approved.Count);
        foreach (var row in approved)
            if (await CommentReplies.FindApprovedNotice(db, tx, row.ArticleId, row.CommentId, ct) is { } notice)
                notices.Add(notice);
        foreach (var notice in notices.OrderBy(n => n.Recipient).ThenBy(n => n.Article).ThenBy(n => n.Reply))
            await CommentReplies.DeliverNotice(db, tx, notice, fenceVisibleMessages, ct);
    }

    private static async Task RequireModerationBatchSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminCommentBatchSchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Batch moderation is unavailable.");
    }
}

internal sealed class ModerationBatchConflictException(int positions) : Exception
{
    internal int Positions { get; } = positions;
}

internal sealed class AdminCommentQueueStore(AdminSessionGate gate)
{
    internal Task<AdminCommentQueue> CommentQueue(string? token, IQueryCollection query, CancellationToken ct, Action? advertiseBatch = null) =>
        gate.WithSession(token, async (db, tx, _) =>
        {
            var (afterComment, afterArticle) = QueueCursor(query);
            if (advertiseBatch is not null && await CurrentSchema.HasAdminCommentBatchSchemaAsync(db, tx, ct)) advertiseBatch();
            var rows = await SqlCommands.QueryList(db, tx, ct, """
                select c.article_id,c.id,c.created_at,c.display_name,c.body
                from public.comment c
                join public.comment_submit_command s on s.article_id=c.article_id and s.comment_id=c.id
                join public.article a on a.id=c.article_id and not a.deleted
                where c.moderation_status=0 and not c.deleted and (c.id,c.article_id)>($1,$2)
                order by c.id,c.article_id limit $3
                """, r => new AdminPendingComment(r.GetInt32(0), r.GetInt64(1), r.GetUnixMilliseconds(2), r.GetString(3), r.GetString(4)),
                afterComment, afterArticle, WireLimits.AdminCommentQueueSize + 1);
            var hasMore = rows.Count > WireLimits.AdminCommentQueueSize;
            if (hasMore) rows.RemoveAt(WireLimits.AdminCommentQueueSize);
            return new AdminCommentQueue(rows, hasMore);
        }, ct);

    private static (long Comment, int Article) QueueCursor(IQueryCollection query)
    {
        if (query.Count == 0) return (0, 0);
        if (query.Count != 2 || query["afterComment"] is not { Count: 1 } comment || query["afterArticle"] is not { Count: 1 } article ||
            comment[0] is not { Length: > 0 and <= 19 } commentText || article[0] is not { Length: > 0 and <= 10 } articleText ||
            !long.TryParse(commentText, NumberStyles.None, CultureInfo.InvariantCulture, out long commentId) || commentId <= 0 ||
            !int.TryParse(articleText, NumberStyles.None, CultureInfo.InvariantCulture, out int articleId) || articleId <= 0)
            throw new BusinessException(Rejection.Invalid, "Invalid comment moderation cursor.");
        return (commentId, articleId);
    }
}

internal sealed class AdminCommentAppealStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<byte[]> ReadAppeals(string? session, IQueryCollection query, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await CommentAppeals.RequireSchema(db, tx, ct);
            var rows = await SqlCommands.QueryList(db, tx, ct, $"""
                select a.id,c.article_id,c.id,c.body,a.reason
                from public.comment_appeal a join public.comment c on c.article_id=a.article_id and c.id=a.comment_id
                {CommentAppeals.Adverse}
                where adverse.id=a.adverse_id and a.comment_version=c.moderation_version and not c.deleted
                    and ($1=0 or a.id<$1) and adverse.principal_id<>$2
                    and not exists (select 1 from public.comment_appeal_decision d where d.appeal_id=a.id)
                order by a.id desc limit $3
                """, row => new AdminAppealRow(row.GetInt64(0), row.GetInt32(1), row.GetInt64(2), row.GetString(3), row.GetString(4)),
                CommentAppeals.Before(query), admin.Id, Wire.CommentAppealPageSize + 1);
            var hasMore = rows.Count > Wire.CommentAppealPageSize;
            if (hasMore) rows.RemoveAt(Wire.CommentAppealPageSize);
            return Wire.EncodeAdminCommentAppeals(rows, hasMore);
        }, ct);

    internal Task<byte[]> BeginAppealStepUp(string? session, long id, byte[] frame, CancellationToken ct)
    {
        CommentAppeals.Reason(Wire.DecodeAdminAppeal(frame).Reason);
        return stepUp.BeginStepUp(session, AppealDecisionDigest(id, frame),
            async (db, tx, admin) => { await VerifyAppeal(db, tx, id, admin.Id, ct); }, ct, AdminStepUpAction.ReviewCommentAppeal);
    }

    internal Task<byte[]> CompleteAppealStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.ReviewCommentAppeal, ct, CommentAppeals.RequireSchema);

    internal Task<byte[]> DecideAppeal(string? session, long id, byte[] frame, string? proof, CancellationToken ct,
        bool fenceVisibleMessages = false)
    {
        var input = Wire.DecodeAdminAppeal(frame);
        var reason = CommentAppeals.Reason(input.Reason);
        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var (article, comment, version) = await VerifyAppeal(db, tx, id, admin.Id, ct);
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, AppealDecisionDigest(id, frame), ct, AdminStepUpAction.ReviewCommentAppeal))
                throw new ModerationProofRequiredException();
            bool granted = input.Decision == "granted";
            bool signedReply = false;
            if (granted)
            {
                if (await SqlCommands.Scalar(db, tx, ct, """
                    update public.comment set moderation_status=1,moderation_version=moderation_version+1
                    where article_id=$1 and id=$2 and moderation_version=$3 and moderation_status=2 and not deleted
                    returning reply_to_id is not null and reply_to_id=parent_id and author_mode=3
                    """, article, comment, version) is not bool positiveReply) throw AppealChanged();
                signedReply = positiveReply;
            }
            if (await SqlCommands.Execute(db, tx, ct, """
                with receipt as (
                    insert into public.comment_appeal_decision(appeal_id,principal_id,session_reference,granted,reason,decided_at)
                    values($1,$2,$3,$4,$5,clock_timestamp()) on conflict(appeal_id) do nothing returning appeal_id,decided_at
                )
                insert into public.comment_appeal_event(appeal_id,kind,previous_status,next_status,occurred_at)
                select appeal_id,2,2,$6,decided_at from receipt
                """, id, admin.Id, SHA256.HashData(admin.Digest), granted, reason, (short)(granted ? 1 : 2)) != 1) throw AppealChanged();
            if (signedReply) await CommentReplies.DeliverApproved(db, tx, article, comment, fenceVisibleMessages, ct);
            return Wire.EncodeAdminAppealResult(id);
        }, ct);
    }

    internal static byte[] AppealDecisionDigest(long id, byte[] frame)
    {
        Span<byte> coordinate = stackalloc byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(coordinate, id);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("FsusBlog v2 independent appeal review"u8);
        hash.AppendData(coordinate);
        hash.AppendData(frame);
        return hash.GetHashAndReset();
    }

    private static async Task<(int Article, long Comment, long Version)> VerifyAppeal(NpgsqlConnection db, NpgsqlTransaction tx,
        long id, Guid reviewer, CancellationToken ct)
    {
        await CommentAppeals.RequireSchema(db, tx, ct);
        if (id <= 0) throw AppealChanged();
        var target = await SqlCommands.QueryRequired(db, tx, ct, $"""
            select c.article_id,c.id,c.moderation_version,adverse.principal_id
            from public.comment_appeal a join public.comment c on c.article_id=a.article_id and c.id=a.comment_id
            {CommentAppeals.Adverse}
            where a.id=$1 and adverse.id=a.adverse_id and a.comment_version=c.moderation_version and not c.deleted
            for update of c
            """, row => reviewer == row.GetGuid(3)
                ? throw new BusinessException(Rejection.Forbidden, "The original moderator cannot decide this appeal.")
                : (row.GetInt32(0), row.GetInt64(1), row.GetInt64(2)),
            AppealChanged, id);
        if (await SqlCommands.Scalar(db, tx, ct,
            "select 1 from public.comment_appeal_decision where appeal_id=$1", id) is not null) throw AppealChanged();
        return target;
    }

    private static BusinessException AppealChanged() => new(Rejection.Conflict, "The pending appeal or underlying decision changed.");
}

internal sealed class AdminCommentHistoryStore(AdminSessionGate gate)
{
    private const int CommentTimelineEvents = 128;

    internal Task<byte[]> CommentTimeline(string? token, long id, IQueryCollection query, CancellationToken ct) =>
        gate.WithSession(token, async (db, tx, _) =>
        {
            var article = TimelineArticle(query);
            var hasOwnership = await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct);
            if (id <= 0 || (!article.HasValue && !hasOwnership))
                throw new BusinessException(Rejection.NotFound, "Comment moderation history is unavailable.");
            var target = article.HasValue ? "c.article_id=$2 and c.id=$1" : """
                (c.article_id,c.id)=(select o.article_id,o.comment_id from public.comment_account_owner o where o.comment_id=$1)
                """;
            var edits = await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct) ? """
                union all
                select e.comment_version,'edit',e.previous_status,e.moderation_status,'account','author_edited',e.happened_at,
                    'comment_author_edited',e.comment_version,null,null,null
                from target t join public.comment_author_edited e on (e.article_id,e.comment_id)=(t.article_id,t.id)
                """ : "";
            var deletions = hasOwnership ? """
                union all
                select d.comment_version,'delete',d.moderation_status,d.moderation_status,'account','author_deleted',d.happened_at,
                    'comment_author_deleted',d.comment_version,null,null,null
                from target t join public.comment_author_deleted d on (d.article_id,d.comment_id)=(t.article_id,t.id)
                """ : "";
            var appeals = await CurrentSchema.HasCommentAppealSchemaAsync(db, tx, ct) ? """
                union all
                select a.id,case e.kind when 1 then 'appeal' else 'appeal_decision' end,
                    e.previous_status,e.next_status,case e.kind when 1 then 'account' else 'admin' end,
                    case e.kind when 1 then a.reason else d.reason end,e.occurred_at,'comment_appeal_event',
                    a.comment_version+(case when e.kind=2 and e.previous_status<>e.next_status then 1 else 0 end),
                    case when e.kind=2 then d.principal_id end,null,a.id
                from target t join public.comment_appeal a on (a.article_id,a.comment_id)=(t.article_id,t.id)
                join public.comment_appeal_event e on e.appeal_id=a.id
                left join public.comment_appeal_decision d on d.appeal_id=a.id
                """ : "";
            await using var select = Store.Sql(db, tx, $$"""
                with target as (
                    select c.article_id,c.id,c.moderation_status,c.moderation_version,c.deleted,c.created_at
                    from public.comment c where {{target}}
                ), events(event_id,event_type,previous,next,actor,reason,happened_at,source,version,principal,role,appeal) as (
                    select t.id,'create',null::smallint,0::smallint,'system',null::text,t.created_at,'comment_submit_command',
                        1::bigint,null::uuid,null::text,null::bigint
                    from target t join public.comment_submit_command s on (s.article_id,s.comment_id)=(t.article_id,t.id)
                    union all
                    select m.id,case m.next_status when 1 then 'approve' else 'reject' end,m.previous_status,m.next_status,
                        'admin',m.reason,m.happened_at,'admin_comment_moderation',m.comment_version+1,m.principal_id,null,null
                    from target t join public.admin_comment_moderation m on (m.article_id,m.comment_id)=(t.article_id,t.id)
                    union all
                    select m.id,case m.next_status when 1 then 'approve' when 2 then 'reject' else 'hide' end,
                        m.previous_status,m.next_status,'database',m.reason,m.occurred_at,'comment_moderation_log',null,null,m.moderator_db_role,null
                    from target t join public.comment_moderation_log m on (m.article_id,m.comment_id)=(t.article_id,t.id)
                    {{edits}} {{deletions}} {{appeals}}
                )
                select t.article_id,t.moderation_status,t.moderation_version,t.deleted,
                    e.event_id,e.previous,e.next,e.event_type,e.actor,e.reason,e.happened_at,e.source,e.version,e.principal,e.role,e.appeal
                from target t left join events e on true
                order by e.happened_at,e.version nulls last,
                    case e.event_type when 'appeal' then 1 when 'appeal_decision' then 2 else 0 end,
                    e.source,e.event_id limit {{CommentTimelineEvents + 1}}
                """, article is int coordinates ? [id, coordinates] : [id]);
            await using var rows = await select.ExecuteReaderAsync(ct);
            await rows.ReadRequired(ct, () => new BusinessException(Rejection.NotFound, "Comment moderation history is unavailable."));
            var (targetArticle, current, currentVersion, deleted) = (rows.GetInt32(0), rows.GetInt16(1), rows.GetInt64(2), rows.GetBoolean(3));
            var events = new List<AdminCommentTimelineEvent>();
            var (projected, version, consistent, projectedDelete) = (current, 0L, !rows.IsDBNull(4), false);
            do
            {
                if (rows.IsDBNull(4)) break;
                if (events.Count == CommentTimelineEvents) throw new PublicUnavailableException();
                var operation = rows.GetString(7);
                var previous = rows.IsDBNull(5) ? (short?)null : rows.GetInt16(5);
                var next = rows.GetInt16(6);
                var eventVersion = rows.IsDBNull(12) ? (long?)null : rows.GetInt64(12);
                if (operation == "create")
                {
                    consistent &= events.Count == 0 && previous is null && next == 0;
                    version = 1;
                }
                else
                {
                    consistent &= !projectedDelete && previous == projected && previous.HasValue && version > 0;
                    if (previous != next || operation is "edit" or "delete") ++version;
                }
                consistent &= eventVersion == version && (!rows.IsDBNull(13) || rows.GetString(8) != "admin");
                projected = next;
                projectedDelete |= operation == "delete";
                events.Add(new(rows.GetInt64(4), id, operation, previous, next, rows.GetString(8),
                    rows.IsDBNull(9) ? null : rows.GetString(9), rows.GetDateTime(10), rows.GetString(11), eventVersion,
                    rows.IsDBNull(13) ? null : rows.GetGuid(13), rows.IsDBNull(14) ? null : rows.GetString(14),
                    rows.IsDBNull(15) ? null : rows.GetInt64(15)));
            } while (await rows.ReadAsync(ct));
            return Wire.EncodeAdminCommentTimeline(new(id, targetArticle, projected, current,
                consistent && projected == current && version == currentVersion && projectedDelete == deleted, deleted, events));
        }, ct);

    internal Task<(byte[] Frame, long? Next, int Article)> CommentRevisions<TPosition>(string? token, long id, TPosition state,
        Func<TPosition, (long Before, int Article)> readPosition, CancellationToken ct) =>
        gate.WithSession<(byte[], long?, int)>(token, async (db, tx, _) =>
        {
            if (id <= 0 || !await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct) ||
                !await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct))
                throw new BusinessException(Rejection.NotFound, "Comment revisions are unavailable.");
            var (before, article) = readPosition(state);
            var revisions = new List<AdminCommentRevision>();
            long? nextVersion = null;
            await SqlCommands.ReadAll(db, tx, ct, """
                with target as (
                    select c.article_id,c.id,c.body,c.created_at,c.edited_at,c.deleted,c.moderation_version,c.moderation_status,o.user_id
                    from public.comment_account_owner o
                    join public.comment c on (c.article_id,c.id)=(o.article_id,o.comment_id)
                    where o.comment_id=$1 and c.author_mode=3 and ($3=0 or c.article_id=$3)
                ), edits as (
                    select e.*,row_number() over (order by e.comment_version) as ordinal,
                        lag(e.body_digest) over (order by e.comment_version) as preceding_digest
                    from target t join public.comment_author_edited e
                        on (e.article_id,e.comment_id,e.user_id)=(t.article_id,t.id,t.user_id)
                ), latest as (
                    select body,happened_at,ordinal from edits order by ordinal desc limit 1
                ), deletion as (
                    select t.body,d.body_digest,d.happened_at,
                        t.deleted and d.comment_version=t.moderation_version and d.moderation_status=t.moderation_status
                        and d.happened_at>=coalesce(t.edited_at,t.created_at)
                        and d.body_digest=pg_catalog.sha256(convert_to(t.body,'UTF8'))
                        and exists(select from public.comment_author_delete_outbox o
                            where (o.article_id,o.comment_id)=(d.article_id,d.comment_id) and o.event_type='CommentDeleted') as coherent
                    from target t join public.comment_author_deleted d
                        on (d.article_id,d.comment_id,d.user_id)=(t.article_id,t.id,t.user_id)
                ), revisions as (
                    select 1::bigint as version,coalesce(e.previous_body,t.body) as content,
                        e.previous_body_digest as digest,'created' as operation,t.created_at as happened_at,true as coherent
                    from target t left join edits e on e.ordinal=1
                    union all
                    select ordinal+1,body,body_digest,'edited',happened_at,
                        previous_body_digest=coalesce(preceding_digest,previous_body_digest)
                        and previous_body_digest=pg_catalog.sha256(convert_to(previous_body,'UTF8'))
                    from edits
                    union all
                    select coalesce(l.ordinal,0)+2,d.body,d.body_digest,'deleted',d.happened_at,d.coherent
                    from deletion d left join latest l on true
                )
                select r.version,r.content,encode(computed,'hex'),r.operation,r.happened_at,
                    r.coherent and (r.digest is null or r.digest=computed)
                    and t.edited_at is not distinct from l.happened_at and t.body=coalesce(l.body,t.body)
                    and coalesce((select coherent from deletion),not t.deleted)
                from revisions r cross join target t left join latest l on true
                cross join lateral (select pg_catalog.sha256(convert_to(r.content,'UTF8')) as computed) digest_check
                where r.version<$2 order by r.version desc limit 65
                """, rows =>
            {
                if (nextVersion is not null) return;
                if (revisions.Count == 64) { nextVersion = revisions[^1].Version; return; }
                if (!rows.GetBoolean(5)) throw new PublicUnavailableException();
                revisions.Add(new(rows.GetInt64(0), rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetDateTime(4)));
            }, id, before, article);
            if (revisions.Count == 0) throw new BusinessException(Rejection.NotFound, "Comment revisions are unavailable.");
            return (Wire.EncodeAdminCommentRevisions(revisions), nextVersion, article);
        }, ct);

    private static int? TimelineArticle(IQueryCollection query)
    {
        if (query.Count == 0) return null;
        if (query.Count == 1 && query["articleId"] is { Count: 1 } values &&
            int.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0)
            return value;
        throw new BusinessException(Rejection.Invalid, "Invalid comment moderation history coordinates.");
    }
}
