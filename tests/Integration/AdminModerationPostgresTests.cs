namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminModerationPostgresTests
{
    private static readonly Dictionary<string, string> AdminOriginSettings = new()
    {
        ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost",
        ["FSUSBLOG_ADMIN_RP_ID"] = "localhost",
    };

    [PostgresFact]
    public async Task BatchModerationRollsBackClaimsProofAuditAndBothRecipientJournalsOnFailure()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (first, second) = await SeedBatchReplies(fixture, 2, ct);
        var moderator = await AddModerator(fixture, "batch-reviewer", ct);
        var other = await AddModerator(fixture, "another-batch-reviewer", ct);
        var (_, moderation, batch, _, _) = CreateStores(fixture);

        var held = await moderation.AcquireCommentClaim(other.Token, new(1, 4), ct);
        var rejectedClaims = await Assert.ThrowsAsync<ModerationBatchConflictException>(() =>
            batch.AcquireModerationBatch(moderator.Token, [new(1, 4), new(1, 99), new(1, 3)], ct));
        // Request positions, not the database lock order: held and absent conflict; the valid third target rolls back.
        Assert.Equal(0b011, rejectedClaims.Positions);
        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.admin_comment_claim)=1 and exists (
                select from public.admin_comment_claim where comment_id=4 and principal_id=$1 and state=1 and claim_version=$2)
            """, other.Id, held.ClaimVersion));
        await moderation.ReleaseCommentClaim(other.Token, held, ct);

        var claims = await batch.AcquireModerationBatch(moderator.Token, [new(1, 3), new(1, 4)], ct);
        Assert.Equal(new long[] { 3, 4 }, claims.Select(claim => claim.CommentId));
        var renewed = await moderation.RenewCommentClaim(moderator.Token, claims[1], ct);
        const string reason = "Reviewed both attributed replies";
        var intent = new AdminModerationBatchDecision(1, reason, [BatchItem(claims[0]), BatchItem(renewed)]);
        var staleIntent = intent with { Rows = [BatchItem(claims[0]), BatchItem(claims[1])] };
        var stale = await Assert.ThrowsAsync<ModerationBatchConflictException>(() =>
            batch.BeginModerationBatchStepUp(moderator.Token, Wire.EncodeAdminModerationBatchDecision(staleIntent), ct));
        Assert.Equal(0b10, stale.Positions);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.admin_comment_batch_step_up"));

        var frame = Wire.EncodeAdminModerationBatchDecision(intent);
        Aeds.Decode(await batch.BeginModerationBatchStepUp(moderator.Token, frame, ct), FrameType.PasskeyLoginBegin);
        Assert.True(await fixture.Scalar<bool>("""
            select exists (select from public.admin_comment_batch_step_up
                where principal_id=$1 and session_digest=$2 and action=6 and kind=1 and options is not null and body_digest=$3)
            """, moderator.Id, moderator.Digest, SHA256.HashData(frame)));
        // The browser fixture exercises the real Passkey ceremony. These receipts test the database proof boundary
        // with deliberately chosen principals, actions, request bytes and rollback conditions.
        var (proof, digest) = await SeedDecisionProof(fixture, moderator, frame, batch: true, ct);
        var (foreignProof, foreignDigest) = await SeedDecisionProof(fixture, other, frame, batch: true, ct);
        var (singleProof, singleDigest) = await SeedDecisionProof(fixture, moderator, frame, batch: false, ct);
        foreach (var (session, token, candidate) in new[]
        {
            (moderator.Token, singleProof, frame),
            (moderator.Token, foreignProof, frame),
            (other.Token, proof, frame),
            (moderator.Token, proof, Wire.EncodeAdminModerationBatchDecision(intent with { Reason = "Changed reason" })),
            (moderator.Token, proof, Wire.EncodeAdminModerationBatchDecision(intent with { Rows = [intent.Rows[1], intent.Rows[0]] })),
        })
            await ProofRejected(session, token, candidate);

        await fixture.Exec("insert into public.comment_blocked_region values(1,4,'ZZ')");
        var blocked = await Assert.ThrowsAsync<ModerationBatchConflictException>(() =>
            batch.DecideModerationBatch(moderator.Token, proof, frame, fenceVisibleMessages: true, ct));
        Assert.Equal(0b10, blocked.Positions);
        await AssertRolledBack();
        await fixture.Exec("delete from public.comment_blocked_region where article_id=1 and comment_id=4");

        await fixture.Exec("alter table public.comment_reply_notice add constraint fixture_deny_second_reply_notice check (reply_id<>4)");
        var failure = await Assert.ThrowsAsync<PostgresException>(() =>
            batch.DecideModerationBatch(moderator.Token, proof, frame, fenceVisibleMessages: true, ct));
        Assert.Equal((PostgresErrorCodes.CheckViolation, "fixture_deny_second_reply_notice"), (failure.SqlState, failure.ConstraintName));
        await AssertRolledBack();
        await fixture.Exec("alter table public.comment_reply_notice drop constraint fixture_deny_second_reply_notice");

        var receipt = await batch.DecideModerationBatch(moderator.Token, proof, frame, fenceVisibleMessages: true, ct);
        Assert.True(receipt.BatchId > 0);
        Assert.Equal(2, receipt.Count);
        await ProofRejected(moderator.Token, proof, frame);
        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.admin_comment_batch)=1
                and exists (select from public.admin_comment_batch where id=$1 and principal_id=$2
                    and session_reference=$3 and decision=1 and item_count=2)
                and (select count(*) from public.admin_comment_batch_item i
                    join public.admin_comment_moderation a on a.id=i.moderation_id
                    join public.comment c on (c.article_id,c.id)=(a.article_id,a.comment_id)
                    join public.admin_comment_claim q on (q.article_id,q.comment_id)=(a.article_id,a.comment_id)
                    where i.batch_id=$1 and a.article_id=1 and a.comment_id in (3,4) and a.principal_id=$2
                        and a.previous_status=0 and a.next_status=1 and a.reason=$4 and c.moderation_status=1
                        and c.moderation_version=a.comment_version+1 and q.state=3 and q.principal_id=$2)=2
                and (select count(*) from public.admin_comment_moderation)=2
                and not exists (select from public.admin_comment_batch_step_up where digest=$5)
                and exists (select from public.admin_comment_batch_step_up where digest=$6)
                and exists (select from public.admin_step_up where digest=$7)
            """, receipt.BatchId, moderator.Id, SHA256.HashData(moderator.Digest), reason, digest, foreignDigest, singleDigest));
        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.inbox_conversation)=2 and (select count(*) from public.inbox_event)=4
                and (select count(*) from public.comment_reply_notice n
                    join public.inbox_delivery d on d.account_id=n.recipient_id
                    join public.comment c on (c.article_id,c.id)=(n.article_id,n.reply_id)
                    join public.comment_account_owner p on (p.article_id,p.comment_id,p.user_id)=(c.article_id,c.parent_id,n.recipient_id)
                    where (n.reply_id,n.recipient_id) in ((3,$1),(4,$2)) and d.last_sequence=2
                        and (select array_agg(e.kind order by e.sequence) from public.inbox_event e
                            where (e.account_id,e.conversation_id,e.message_id)=(n.recipient_id,n.conversation_id,n.message_id))
                            =array[12,13]::smallint[])=2
            """, first, second));
        await AssertPrivateNotice(first, second, 3);
        await AssertPrivateNotice(second, first, 4);

        Task ProofRejected(string session, string token, byte[] candidate) => Assert.ThrowsAsync<ModerationProofRequiredException>(() =>
            batch.DecideModerationBatch(session, token, candidate, fenceVisibleMessages: true, ct));

        async Task AssertRolledBack() => Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.comment where article_id=1 and id in (3,4)
                        and moderation_status=0 and moderation_version=1)=2
                and (select count(*) from public.admin_comment_claim where article_id=1 and comment_id in (3,4)
                        and state=1 and principal_id=$1 and ((comment_id=3 and claim_version=$2)
                            or (comment_id=4 and claim_version=$3)))=2
                and exists (select from public.admin_comment_batch_step_up where digest=$4 and kind=2)
                and not exists (select from public.admin_comment_batch)
                and not exists (select from public.admin_comment_batch_item)
                and not exists (select from public.admin_comment_moderation)
                and not exists (select from public.comment_reply_notice)
                and not exists (select from public.inbox_conversation)
                and not exists (select from public.inbox_message)
                and not exists (select from public.inbox_delivery)
                and not exists (select from public.inbox_event)
            """, moderator.Id, claims[0].ClaimVersion, renewed.ClaimVersion, digest));

        async Task AssertPrivateNotice(Guid recipient, Guid stranger, long reply)
        {
            var conversation = await fixture.Scalar<long>("select conversation_id from public.comment_reply_notice where reply_id=$1", reply);
            await fixture.InTx(async (db, read) =>
            {
                var own = await new InboxStore(db, read, recipient).GetAsync(conversation, null, 2, ct);
                Assert.NotNull(own);
                Assert.Contains($"Reply fixture {reply}。定位：/article/1#comment-{reply}", Assert.Single(own.Messages).Body, StringComparison.Ordinal);
                Assert.Null(await new InboxStore(db, read, stranger).GetAsync(conversation, null, 2, ct));
            }, ct);
        }
    }

    [PostgresFact]
    public async Task ConcurrentBatchesWithOppositeRecipientOrderCommitBothPrivateJournals()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (first, second) = await SeedBatchReplies(fixture, 4, ct);
        var left = await AddModerator(fixture, "batch-left-reviewer", ct);
        var right = await AddModerator(fixture, "batch-right-reviewer", ct);
        var (_, _, service, _, _) = CreateStores(fixture);
        // Descending comment locks encounter B,A in the left batch and A,B in the right batch.
        var leftClaims = await service.AcquireModerationBatch(left.Token, [new(1, 3), new(1, 4)], ct);
        var rightClaims = await service.AcquireModerationBatch(right.Token, [new(1, 5), new(1, 6)], ct);
        var leftFrame = Wire.EncodeAdminModerationBatchDecision(new(1, "Left batch review", leftClaims.Select(BatchItem).ToArray()));
        var rightFrame = Wire.EncodeAdminModerationBatchDecision(new(1, "Right batch review", rightClaims.Select(BatchItem).ToArray()));
        var (leftProof, _) = await SeedDecisionProof(fixture, left, leftFrame, batch: true, ct);
        var (rightProof, _) = await SeedDecisionProof(fixture, right, rightFrame, batch: true, ct);

        var results = await Task.WhenAll(
            service.DecideModerationBatch(left.Token, leftProof, leftFrame, fenceVisibleMessages: true, ct),
            service.DecideModerationBatch(right.Token, rightProof, rightFrame, fenceVisibleMessages: true, ct));
        Assert.All(results, result => Assert.Equal(2, result.Count));
        Assert.NotEqual(results[0].BatchId, results[1].BatchId);
        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.admin_comment_batch)=2
                and (select count(*) from public.admin_comment_batch_item)=4
                and (select count(*) from public.admin_comment_moderation)=4
                and (select count(*) from public.comment_reply_notice where (reply_id,recipient_id) in ((3,$1),(4,$2),(5,$2),(6,$1)))=4
                and (select count(*) from public.inbox_delivery)=2
                and (select count(*) from public.inbox_delivery where account_id in ($1,$2) and last_sequence=4)=2
                and (select count(*) from public.inbox_event)=8
            """, first, second));
    }

    [PostgresFact]
    public async Task ApprovedReplyNotifiesOnlyTheVisibleDirectParentOwnerAndRollsBackWithModeration()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        await AddPendingComment(fixture, ct);
        var recipient = await fixture.Scalar<Guid>("select owner_id from public.article where id=1");
        var sender = Guid.NewGuid();
        await fixture.SiteAccountAsync(sender, "Reply account", ct: ct);
        var (token, handle, _) = await fixture.SiteSessionAsync(sender, DateTimeOffset.UtcNow.AddMinutes(5), ct: ct);
        var (recipientToken, _, _) = await fixture.SiteSessionAsync(recipient, DateTimeOffset.UtcNow.AddMinutes(5), ct: ct);
        await fixture.Exec("insert into public.comment_public_handle(user_id,display_name) values($1,'Reply display'),($2,'Parent display')", sender, recipient);
        await fixture.Exec("insert into public.comment_account_owner(article_id,comment_id,user_id) values(1,1,$1)", recipient);
        await PublishCommentArticle(fixture, 1);
        await fixture.Exec("""
            insert into public.comment_public_write(article_id) values(1);
            update public.comment set moderation_status=1,moderation_version=2 where article_id=1 and id=1;
            select setval(pg_get_serial_sequence('public.comment','id'),1);
            """);
        var moderator = await AddModerator(fixture, "reply-reviewer", ct);
        var (_, admin, _, _, _) = CreateStores(fixture);
        var reply = new PublicCommentReply(1, 1, 1, "Reply display", "Independent public reply", Guid.NewGuid(), true);
        var optIn = new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS"] = "true", [CommentReplies.Setting] = "false" };
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct, optIn))
            await CheckStatusAsync(NotFound, Send(disabled, reply, true));
        optIn.Remove(CommentReplies.Setting);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, optIn);
        await CheckStatusAsync(Conflict, Send(server, reply, true, current: new string('a', 64)));
        await CheckStatusAsync(NotFound, Send(server, reply with { ParentId = 98765 }, true));
        var proof = await Proof(reply);
        await CheckStatusAsync(Unauthorized, Send(server, reply with { ParentId = 98765 }, false, proof));
        var pending = await Submit(reply, proof);
        Assert.Equal((0, false), (pending.ModerationStatus, pending.Replayed));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.inbox_event"));
        Assert.DoesNotContain(reply.Body, Encoding.UTF8.GetString(await server.Client.GetByteArrayAsync(WireRoutes.CommentRoots
            .Replace("{articleId:int}", "1", StringComparison.Ordinal), ct)), StringComparison.Ordinal);
        await fixture.Exec("insert into public.comment_blocked_region values(1,1,'ZZ')");
        await CheckStatusAsync(NotFound, Send(server, reply with { IdempotencyKey = Guid.NewGuid() }, true));
        await fixture.Exec("delete from public.comment_blocked_region");

        var (decision, adminProof, adminDigest) = await PrepareDecision(pending.CommentId);
        await fixture.Exec("alter table public.comment_reply_notice add constraint fixture_deny_reply_notice check (false)");
        Assert.Equal(PostgresErrorCodes.CheckViolation, (await Assert.ThrowsAsync<PostgresException>(() =>
            admin.DecideComment(moderator.Token, adminProof, decision, ct))).SqlState);
        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.inbox_conversation)=0
                and (select count(*) from public.inbox_event)=0
                and (select count(*) from public.admin_comment_moderation)=0
                and (select moderation_status=0 from public.comment where article_id=1 and id=$1)
                and exists(select 1 from public.admin_step_up where digest=$2)
            """, pending.CommentId, adminDigest));
        await fixture.Exec("alter table public.comment_reply_notice drop constraint fixture_deny_reply_notice");
        await admin.DecideComment(moderator.Token, adminProof, decision, ct);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => admin.DecideComment(moderator.Token, adminProof, decision, ct));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.comment_reply_notice n
            join public.admin_comment_moderation d on (d.article_id,d.comment_id)=(n.article_id,n.reply_id)
            join public.inbox_conversation c on (c.account_id,c.id)=(n.recipient_id,n.conversation_id)
            where n.reply_id=$1 and n.recipient_id=$2 and d.principal_id=$3 and n.moderation_version=d.comment_version+1
                and c.is_system and (select array_agg(e.kind order by e.sequence) from public.inbox_event e
                    where e.account_id=n.recipient_id and e.conversation_id=n.conversation_id
                        and e.message_id=n.message_id)=array[12,13]::smallint[]
            """, pending.CommentId, recipient, moderator.Id));
        var conversation = await fixture.Scalar<long>("select conversation_id from public.comment_reply_notice");
        var inboxPath = WireRoutes.InboxDetail.Replace("{id:long}", conversation.ToString(CultureInfo.InvariantCulture));
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Get, inboxPath, null, token, null, NotFound, ct);
        Assert.Contains($"Reply display 回复了您的评论：{reply.Body}。定位：/article/1#comment-{pending.CommentId}",
            Encoding.UTF8.GetString(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Get, inboxPath, null, recipientToken, null, OK, ct)),
            StringComparison.Ordinal);

        var nested = reply with { ParentId = pending.CommentId, IdempotencyKey = Guid.NewGuid(), Body = "Reply to my own comment" };
        var self = await Submit(nested, await Proof(nested));
        Assert.True(await fixture.Scalar<bool>("select root_id=1 and parent_id=$1 and depth=2 from public.comment where article_id=1 and id=$2",
            pending.CommentId, self.CommentId));
        var (selfDecision, selfProof, _) = await PrepareDecision(self.CommentId);
        await admin.DecideComment(moderator.Token, selfProof, selfDecision, ct);
        await fixture.Exec("delete from public.comment_public_write where article_id=1");
        var replay = await Submit(reply, await Proof(reply));
        Assert.Equal((pending.CommentId, true, 1, 1L, 2L), (replay.CommentId, replay.Replayed, replay.ModerationStatus,
            await fixture.Scalar<long>("select count(*) from public.comment_reply_notice"),
            await fixture.Scalar<long>("select count(*) from public.inbox_event")));

        async Task<HttpResponseMessage> Send(ServerProcess app, PublicCommentReply command, bool challenge, string? proofHeader = null, string? current = null)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, challenge ? WireRoutes.PublicCommentReplyPow : WireRoutes.SubmitPublicCommentReply,
                Wire.EncodePublicCommentReply(command), token, current ?? handle);
            request.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            if (challenge) request.Headers.Add(WireHeaders.PowClientNonce, ClientNonce);
            if (proofHeader is not null) request.Headers.Add(WireHeaders.PowProof, proofHeader);
            return await app.Client.SendAsync(request, ct);
        }

        async Task<string> Proof(PublicCommentReply command) =>
            PowFixture.SolveFrame(await OkBytes(Send(server, command, true), ct), ClientNonce, ct);

        async Task<PublicCommentSubmissionResult> Submit(PublicCommentReply command, string authorization) =>
            Wire.DecodePublicCommentSubmissionResult(await OkBytes(Send(server, command, false, authorization), ct));

        async Task<(AdminModerationDecision Decision, string Proof, byte[] Digest)> PrepareDecision(long comment)
        {
            var claim = await admin.AcquireCommentClaim(moderator.Token, new(1, comment), ct);
            var intent = new AdminModerationDecision(1, comment, 0, 1, "Reviewed visible reply fixture", claim.CommentVersion,
                claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
            var (proofToken, proofDigest) = await fixture.SeedStepUpProof("admin_step_up", moderator.Id, moderator.Digest, 1, AdminModerationStore.DecisionDigest(intent), ct: ct);
            return (intent, proofToken, proofDigest);
        }
    }

    private const string ClientNonce = "c1287bbaae554232a936d42a3f59bd0d";

    [PostgresFact]
    public async Task AppealRequiresAnOwnedAdverseReceiptAndAnIndependentBoundDecision()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await AddPendingComment(fixture, ct);
        var owner = await fixture.Scalar<Guid>("select owner_id from public.article where id=1");
        var actor = new Identity(owner, "Site fixture", 1, true, DateTimeOffset.UtcNow.AddMinutes(10));
        var authorSession = RandomNumberGenerator.GetBytes(32);
        var original = await AddModerator(fixture, "appeal-original", ct);
        var reviewer = await AddModerator(fixture, "appeal-reviewer", ct);
        var outsider = await fixture.SignInSiteUser("appeal-outsider", ct);
        await fixture.Exec("insert into public.comment_account_owner values(1,1,$1)", owner);
        await fixture.Exec("update public.comment set moderation_status=2,moderation_version=2 where article_id=1 and id=1");
        await Denied(Rejection.NotFound, () => IssueAppeal(actor, 1));
        var adverse = await fixture.Scalar<long>("""
            insert into public.admin_comment_moderation(article_id,comment_id,principal_id,previous_status,next_status,reason,happened_at,comment_version)
            values(1,1,$1,0,2,'Original reviewer rejects',clock_timestamp(),1) returning id
            """, original.Id);
        await Denied(Rejection.NotFound, () => IssueAppeal(actor with { Id = Guid.NewGuid() }, 1));
        var challenge = await IssueAppeal(actor, 1);
        const string reason = "The record was misunderstood.";
        await Denied(Rejection.NotFound, () => SubmitAppeal(RandomNumberGenerator.GetBytes(32), 1, challenge.Challenge));
        await SubmitAppeal(authorSession, 1, challenge.Challenge);
        await Denied(Rejection.Conflict, () => SubmitAppeal(authorSession, 1, challenge.Challenge));
        var appeal = await fixture.Scalar<long>("select id from public.comment_appeal where adverse_id=$1", adverse);
        var (_, _, _, service, history) = CreateStores(fixture);
        var payload = Aeds.Encode(FrameType.CommentAppealDecisionRequest, """
            {"decision":"granted","reason":"Independent review confirms the source."}
            """u8);
        await Denied(Rejection.Forbidden, () => service.BeginAppealStepUp(original.Token, appeal, payload, ct));
        await Denied(Rejection.Unauthorized, () => service.BeginAppealStepUp(outsider.Token, appeal, payload, ct));
        Aeds.Decode(await service.BeginAppealStepUp(reviewer.Token, appeal, payload, ct), FrameType.PasskeyLoginBegin);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideAppeal(reviewer.Token, appeal, payload, null, ct));
        var (proof, _) = await fixture.SeedStepUpProof("comment_appeal_admin_step_up", reviewer.Id, reviewer.Digest, 5,
            AdminCommentAppealStore.AppealDecisionDigest(appeal, payload), ct: ct);
        var altered = Aeds.Encode(FrameType.CommentAppealDecisionRequest, """
            {"decision":"denied","reason":"Independent review confirms the source."}
            """u8);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideAppeal(reviewer.Token, appeal, altered, proof, ct));
        await fixture.Exec("update public.comment set moderation_version=3 where article_id=1 and id=1");
        await Denied(Rejection.Conflict, () => service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.comment_appeal_decision"));
        await fixture.Exec("update public.comment set moderation_version=2 where article_id=1 and id=1");
        await fixture.Exec("alter table public.comment_appeal_decision add constraint fixture_refuse_audit check (false)");
        await Assert.ThrowsAsync<PostgresException>(() => service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct));
        Assert.Equal(((short)2, 1L), (await fixture.Scalar<short>("select moderation_status from public.comment where article_id=1 and id=1"),
            await fixture.Scalar<long>("select count(*) from public.comment_appeal_event")));
        await fixture.Exec("alter table public.comment_appeal_decision drop constraint fixture_refuse_audit");
        Aeds.Decode(await service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct), FrameType.CommentAppealDecisionResult);
        Assert.Equal((reviewer.Id, (short)1, (short)1), (await fixture.Scalar<Guid>("select principal_id from public.comment_appeal_decision"),
            await fixture.Scalar<short>("select moderation_status from public.comment where article_id=1 and id=1"),
            await fixture.Scalar<short>("select next_status from public.comment_appeal_event where kind=2")));
        await Denied(Rejection.Conflict, () => service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct));
        Assert.Equal((2L, 0L), (await fixture.Scalar<long>("select count(*) from public.comment_appeal_event"),
            await fixture.Scalar<long>("select count(*) from public.comment_appeal_admin_step_up where kind=2")));

        await fixture.Exec("""
            insert into public.comment(article_id,id,root_id,depth,moderation_status,moderation_version,deleted,body,author_mode,display_name,display_language,created_at)
            values(1,2,2,0,2,2,false,'Second rejection',3,'Fixture writer','en',clock_timestamp())
            """);
        await fixture.Exec("insert into public.comment_submit_command values($1,$2,$3,1,2)", owner, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("insert into public.comment_account_owner values(1,2,$1)", owner);
        await fixture.Exec("""
            insert into public.admin_comment_moderation(article_id,comment_id,principal_id,previous_status,next_status,reason,happened_at,comment_version)
            values(1,2,$1,0,2,'Original reviewer rejects again',clock_timestamp(),1)
            """, original.Id);
        await fixture.InTx(async (c, tx) =>
        {
            var secondChallenge = await CommentAppeals.Issue(c, tx, actor, authorSession, 2, ct);
            await CommentAppeals.Submit(c, tx, actor, authorSession, 2, new(reason, secondChallenge.Challenge), ct);
        }, ct);
        var secondAppeal = await fixture.Scalar<long>("select id from public.comment_appeal where comment_id=2");
        Aeds.Decode(await service.BeginAppealStepUp(reviewer.Token, secondAppeal, altered, ct), FrameType.PasskeyLoginBegin);
        var (secondProof, _) = await fixture.SeedStepUpProof("comment_appeal_admin_step_up", reviewer.Id, reviewer.Digest, 5,
            AdminCommentAppealStore.AppealDecisionDigest(secondAppeal, altered), ct: ct);

        var attempts = await Task.WhenAll(ResolveSecond(), ResolveSecond());
        Assert.Single(attempts, result => result);
        Assert.Single(attempts, result => !result);
        Assert.Equal(((short)2, (short)2), (await fixture.Scalar<short>("select moderation_status from public.comment where article_id=1 and id=2"),
            await fixture.Scalar<short>("select next_status from public.comment_appeal_event where appeal_id=$1 and kind=2", secondAppeal)));
        await fixture.Exec("""
            update public.comment_appeal_event e set occurred_at=m.happened_at
            from public.comment_appeal a join public.admin_comment_moderation m on m.id=a.adverse_id
            where e.appeal_id=a.id and a.id=$1
            """, secondAppeal);
        await CheckTimeline(1, 1, 3);
        await CheckTimeline(2, 2, 2);

        Task<CommentAuthorChallenge> IssueAppeal(Identity account, long id) =>
            fixture.InTx((c, tx) => CommentAppeals.Issue(c, tx, account, authorSession, id, ct), ct);
        Task SubmitAppeal(byte[] session, long id, string token) =>
            fixture.InTx((c, tx) => CommentAppeals.Submit(c, tx, actor, session, id, new(reason, token), ct), ct);

        async Task CheckTimeline(long comment, int status, long version)
        {
            using var receipt = DecodeJson(await history.CommentTimeline(reviewer.Token, comment, QueryCollection.Empty, ct), (FrameType)225);
            var actions = AssertTimeline(receipt.RootElement, status, ["create", "reject", "appeal", "appeal_decision"]);
            Assert.Equal((version, reviewer.Id), (actions[^1].GetProperty("commentVersion").GetInt64(), actions[^1].GetProperty("adminPrincipal").GetGuid()));
        }

        async Task<bool> ResolveSecond()
        {
            try { await service.DecideAppeal(reviewer.Token, secondAppeal, altered, secondProof, ct); return true; }
            catch (BusinessException changed) when (changed.Rejection == Rejection.Conflict) { return false; }
        }
    }

    [PostgresFact]
    public async Task ClaimSerializesOwnershipAndFencesEarlierVersions()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await AddPendingComment(fixture, ct);
        var first = await AddModerator(fixture, "first-moderator", ct);
        var second = await AddModerator(fixture, "second-moderator", ct);
        var siteUser = await fixture.SignInSiteUser("claim-site-user", ct);
        var (_, service, _, _, _) = CreateStores(fixture);
        var target = new AdminModerationClaimRequest(1, 1);
        await Denied(Rejection.Unauthorized, () => service.AcquireCommentClaim(siteUser.Token, target, ct));

        var (a, b) = await fixture.InTx(async (db, gate) =>
        {
            Assert.Equal(1, await FixtureSql.ScalarAsync(db, gate, ct, "select 1 from public.comment where article_id=1 and id=1 for update"));
            var firstAttempt = Attempt(first);
            var secondAttempt = Attempt(second);
            // The second contender can wait behind the first contender in the row-lock queue.
            await fixture.WaitForBlocked(db.ProcessID, 2, ct);
            Assert.False(firstAttempt.IsCompleted);
            Assert.False(secondAttempt.IsCompleted);
            return (firstAttempt, secondAttempt);
        }, ct);
        var results = await Task.WhenAll(a, b);
        var success = Assert.Single(results, result => result.Claim is not null);
        var conflict = Assert.Single(results, result => result.Denied is not null);
        Assert.Equal(Rejection.Conflict, conflict.Denied);
        var original = success.Claim!;
        Assert.Equal((1L, 1L, 1L), (original.CommentVersion, original.ClaimGeneration, original.ClaimVersion));

        await Denied(Rejection.Conflict, () => service.ReleaseCommentClaim(conflict.Admin.Token, original, ct));
        var renewed = await service.RenewCommentClaim(success.Admin.Token, original, ct);
        Assert.Equal((original.ClaimGeneration, original.ClaimVersion + 1, original.CommentVersion),
            (renewed.ClaimGeneration, renewed.ClaimVersion, renewed.CommentVersion));
        Assert.True(renewed.ExpiresAt >= original.ExpiresAt);
        await Denied(Rejection.Conflict, () => service.ReleaseCommentClaim(success.Admin.Token, original, ct));
        await service.ReleaseCommentClaim(success.Admin.Token, renewed, ct);

        var reclaimed = await service.AcquireCommentClaim(conflict.Admin.Token, target, ct);
        Assert.Equal(original.ClaimGeneration + 1, reclaimed.ClaimGeneration);
        Assert.True(reclaimed.ClaimVersion > renewed.ClaimVersion);
        Assert.NotEqual(original.ClaimToken, reclaimed.ClaimToken);
        await fixture.Exec("update public.admin_comment_claim set expires_at=clock_timestamp()-interval '1 second'");
        await Denied(Rejection.Conflict, () => service.RenewCommentClaim(conflict.Admin.Token, reclaimed, ct));
        var afterExpiry = await service.AcquireCommentClaim(success.Admin.Token, target, ct);
        Assert.Equal(reclaimed.ClaimGeneration + 1, afterExpiry.ClaimGeneration);

        await fixture.Exec("delete from public.admin_session where digest=$1", success.Admin.Digest);
        await Denied(Rejection.Unauthorized, () => service.RenewCommentClaim(success.Admin.Token, afterExpiry, ct));
        await Denied(Rejection.Unauthorized, () => service.ReleaseCommentClaim(success.Admin.Token, afterExpiry, ct));
        var afterRevocation = await service.AcquireCommentClaim(conflict.Admin.Token, target, ct);
        Assert.Equal(afterExpiry.ClaimGeneration + 1, afterRevocation.ClaimGeneration);
        Assert.True(afterRevocation.ClaimVersion > afterExpiry.ClaimVersion);
        Assert.Equal(conflict.Admin.Id, await fixture.Scalar<Guid>("""
            select principal_id from public.admin_comment_claim
            where article_id=1 and comment_id=1 and state=1 and expires_at>clock_timestamp()
            """));

        async Task<ClaimAttempt> Attempt(Moderator moderator)
        {
            try { return new(moderator, await service.AcquireCommentClaim(moderator.Token, target, ct), null); }
            catch (BusinessException error) { return new(moderator, null, error.Rejection); }
        }
    }

    [PostgresFact]
    public async Task DecisionKeepsProofAndClaimUntilAuditCommits()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await AddPendingComment(fixture, ct);
        var owner = await AddModerator(fixture, "decision-owner", ct);
        var other = await AddModerator(fixture, "another-moderator", ct);
        var (_, service, _, _, _) = CreateStores(fixture);
        var claim = await service.AcquireCommentClaim(owner.Token, new(1, 1), ct);
        var decision = new AdminModerationDecision(1, 1, 0, 1, "Reviewed the submitted comment", claim.CommentVersion,
            claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, null, decision, ct));
        await Denied(Rejection.Conflict, () => service.BeginModerationDecisionStepUp(other.Token, decision, ct));
        Aeds.Decode(await service.BeginModerationDecisionStepUp(owner.Token, decision, ct), FrameType.PasskeyLoginBegin);

        // Native Chrome covers actual assertion and proof issuance. This row only seeds the database consumer.
        var staleDecision = decision with { ClaimVersion = claim.ClaimVersion + 1 };
        var (staleProof, _) = await fixture.SeedStepUpProof("admin_step_up", owner.Id, owner.Digest, 1, AdminModerationStore.DecisionDigest(staleDecision), ct: ct);
        await Denied(Rejection.Conflict, () => service.DecideComment(owner.Token, staleProof, staleDecision, ct));

        var (proof, proofDigest) = await fixture.SeedStepUpProof("admin_step_up", owner.Id, owner.Digest, 1, AdminModerationStore.DecisionDigest(decision), ct: ct);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, proof,
            decision with { Reason = "A different moderation reason" }, ct));
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(other.Token, proof, decision, ct));
        await fixture.Exec("alter table public.admin_comment_moderation add constraint fixture_refuse_audit check (false)");
        Assert.Equal(PostgresErrorCodes.CheckViolation, (await Assert.ThrowsAsync<PostgresException>(() =>
            service.DecideComment(owner.Token, proof, decision, ct))).SqlState);
        Assert.True(await fixture.Scalar<bool>("""
            select c.moderation_status=0 and c.moderation_version=1 and s.state=1 and s.claim_version=$2
                and exists(select from public.admin_step_up where digest=$1)
            from public.comment c join public.admin_comment_claim s on (s.article_id,s.comment_id)=(c.article_id,c.id)
            where c.article_id=1 and c.id=1
            """, proofDigest, claim.ClaimVersion));

        await fixture.Exec("alter table public.admin_comment_moderation drop constraint fixture_refuse_audit");
        await service.DecideComment(owner.Token, proof, decision, ct);
        var audit = Assert.Single(await fixture.QueryRows("""
            select m.principal_id,m.previous_status,m.next_status,m.reason,m.comment_version,c.moderation_status,
                   c.moderation_version,s.state,s.claim_version,exists(select from public.admin_step_up where digest=$1)
            from public.admin_comment_moderation m
            join public.comment c on (c.article_id,c.id)=(m.article_id,m.comment_id)
            join public.admin_comment_claim s on (s.article_id,s.comment_id)=(m.article_id,m.comment_id)
            where m.article_id=1 and m.comment_id=1
            """, row => (row.GetGuid(0), row.GetInt16(1), row.GetInt16(2), row.GetString(3), row.GetInt64(4),
                row.GetInt16(5), row.GetInt64(6), row.GetInt16(7), row.GetInt64(8), row.GetBoolean(9)), proofDigest));
        Assert.Equal((owner.Id, (short)0, (short)1, decision.Reason, claim.CommentVersion, (short)1,
            claim.CommentVersion + 1, (short)3, claim.ClaimVersion + 1, false), audit);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, proof, decision, ct));
        await Denied(Rejection.Conflict, () => service.AcquireCommentClaim(other.Token, new(1, 1), ct));
    }

    private static (AdminSessionGate Gate, AdminModerationStore Moderation, AdminModerationBatchStore Batch,
        AdminCommentAppealStore Appeals, AdminCommentHistoryStore History) CreateStores(ScratchDatabase fixture)
    {
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var passkeys = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var stepUp = new AdminStepUpService(gate, passkeys);
        return (gate, new AdminModerationStore(gate, stepUp), new AdminModerationBatchStore(gate, stepUp),
            new AdminCommentAppealStore(gate, stepUp), new AdminCommentHistoryStore(gate));
    }

    private static Task<int> PublishCommentArticle(ScratchDatabase fixture, int articleId) => fixture.Exec($"""
        insert into public.article_publication(article_id,revision,published_at) values({articleId},1,clock_timestamp());
        insert into public.article_revision_rights values({articleId},1,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true);
        insert into public.article_publication_rights(article_id,publication_id,revision)
            select article_id,publication_id,revision from public.article_publication where article_id={articleId};
        update public.article set published_revision=1,publication_count=1 where id={articleId};
        """);

    private static async Task<(Guid First, Guid Second)> SeedBatchReplies(ScratchDatabase fixture, int count, CancellationToken ct)
    {
        await AddPendingComment(fixture, ct);
        var first = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var second = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var sender = Guid.NewGuid();
        await fixture.Exec("""
            insert into public.blog_user(id,name,enabled,generation)
            values($1,'First parent author',true,1),($2,'Second parent author',true,1),($3,'Reply author',true,1)
            """, first, second, sender);
        await PublishCommentArticle(fixture, 1);
        await fixture.Exec("""
            update public.comment set moderation_status=1,moderation_version=2 where article_id=1 and id=1;
            insert into public.comment(article_id,id,root_id,depth,moderation_status,moderation_version,deleted,
                body,author_mode,display_name,display_language,created_at)
                values(1,2,2,0,1,2,false,'Second visible parent',3,'Second parent','en',clock_timestamp());
            """);
        await fixture.Exec("insert into public.comment_account_owner values(1,1,$1),(1,2,$2)", first, second);
        for (var i = 0; i < count; i++)
        {
            var reply = i + 3L;
            var parent = i % 4 is 0 or 3 ? 1L : 2L;
            await fixture.Exec("""
                insert into public.comment(article_id,id,root_id,parent_id,parent_depth,reply_to_id,depth,moderation_status,
                    deleted,body,author_mode,display_name,display_language,created_at)
                values(1,$1,$2,$2,0,$2,1,0,false,$3,3,'Batch reply author','en',clock_timestamp())
                """, reply, parent, FormattableString.Invariant($"Reply fixture {reply}"));
            await fixture.Exec("insert into public.comment_account_owner values(1,$1,$2)", reply, sender);
            await fixture.Exec("insert into public.comment_submit_command values($1,$2,$3,1,$4)",
                sender, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32), reply);
        }
        return (first, second);
    }

    private static AdminModerationBatchItem BatchItem(AdminModerationClaim claim) =>
        new(claim.ArticleId, claim.CommentId, claim.CommentVersion, claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion, 0);

    private static Task<(string Token, byte[] Digest)> SeedDecisionProof(ScratchDatabase fixture, Moderator moderator,
        byte[] frame, bool batch, CancellationToken ct) =>
        fixture.SeedStepUpProof(batch ? "admin_comment_batch_step_up" : "admin_step_up", moderator.Id, moderator.Digest,
            batch ? 6 : 1, SHA256.HashData(frame), ct: ct);

    internal static async Task AddPendingComment(ScratchDatabase fixture, CancellationToken ct, params string[] bodies)
    {
        if (bodies.Length == 0) bodies = ["Awaiting review"];
        var member = Guid.NewGuid();
        await fixture.SiteAccountAsync(member, "Site fixture", ct: ct);
        await fixture.AdminPrincipalAsync(member, "site-fixture", ct: ct);
        await fixture.Exec("""
            with article as (
                insert into public.article(owner_id,revision,title,body,deleted)
                values($1,1,'Fixture article','Fixture article',false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            select id,1,'Fixture article','Fixture article',clock_timestamp() from article
            """, member);
        for (var i = 0; i < bodies.Length; i++)
        {
            long id = i + 1;
            await fixture.Exec("""
                insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
                values(1,$1,$1,0,0,false,$2,3,'Fixture writer','en',clock_timestamp())
                """, id, bodies[i]);
            await fixture.Exec("insert into public.comment_submit_command values($1,$2,$3,1,$4)", member, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32), id);
        }
    }

    private static async Task<Moderator> AddModerator(ScratchDatabase fixture, string handle, CancellationToken ct)
    {
        var (principal, token, digest) = await fixture.AdminAsync(handle, 10, RandomNumberGenerator.GetBytes(32), [2], ct);
        return new(principal, token, digest);
    }

    private sealed record Moderator(Guid Id, string Token, byte[] Digest);
    private sealed record ClaimAttempt(Moderator Admin, AdminModerationClaim? Claim, Rejection? Denied);
}
