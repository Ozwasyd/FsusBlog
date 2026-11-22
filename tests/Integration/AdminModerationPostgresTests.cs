using static System.Net.HttpStatusCode;
using static FsusBlog.V2.Integration.Tests.HttpResponseAssert;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using static FsusBlog.V2.Integration.Tests.BusinessAssert;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminModerationPostgresTests
{
    [PostgresFact]
    public async Task BatchModerationRollsBackClaimsProofAuditAndBothRecipientJournalsOnFailure()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (first, second) = await SeedBatchReplies(db, 2, ct);
        var moderator = await AddModerator(db, "batch-reviewer", ct);
        var other = await AddModerator(db, "another-batch-reviewer", ct);
        var (_, moderation, batch, _, _) = CreateStores(fixture);

        var held = await moderation.AcquireCommentClaim(other.Token, new(1, 4), ct);
        var rejectedClaims = await Assert.ThrowsAsync<ModerationBatchConflictException>(() =>
            batch.AcquireModerationBatch(moderator.Token, [new(1, 4), new(1, 99), new(1, 3)], ct));
        // Request positions, not the database lock order: held and absent conflict; the valid third target rolls back.
        Assert.Equal(0b011, rejectedClaims.Positions);
        Assert.True(await ReadDatabase<bool>(db, """
            select (select count(*) from public.admin_comment_claim)=1 and exists (
                select from public.admin_comment_claim where comment_id=4 and principal_id=$1 and state=1 and claim_version=$2)
            """, ct, other.Id, held.ClaimVersion));
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
        Assert.Equal(0L, await ReadDatabase<long>(db, "select count(*) from public.admin_comment_batch_step_up", ct));

        var frame = Wire.EncodeAdminModerationBatchDecision(intent);
        var challenge = await batch.BeginModerationBatchStepUp(moderator.Token, frame, ct);
        Aeds.Decode(challenge, FrameType.PasskeyLoginBegin);
        Assert.True(await ReadDatabase<bool>(db, """
            select exists (select from public.admin_comment_batch_step_up
                where principal_id=$1 and session_digest=$2 and action=6 and kind=1 and options is not null and body_digest=$3)
            """, ct, moderator.Id, moderator.Digest, SHA256.HashData(frame)));
        // The browser fixture exercises the real Passkey ceremony. These receipts test the database proof boundary
        // with deliberately chosen principals, actions, request bytes and rollback conditions.
        var (proof, digest) = await SeedDecisionProof(db, moderator, frame, batch: true, ct);
        var (foreignProof, foreignDigest) = await SeedDecisionProof(db, other, frame, batch: true, ct);
        var (singleProof, singleDigest) = await SeedDecisionProof(db, moderator, frame, batch: false, ct);
        await ProofRejected(moderator.Token, singleProof, frame);
        await ProofRejected(moderator.Token, foreignProof, frame);
        await ProofRejected(other.Token, proof, frame);
        await ProofRejected(moderator.Token, proof, Wire.EncodeAdminModerationBatchDecision(intent with { Reason = "Changed reason" }));
        await ProofRejected(moderator.Token, proof, Wire.EncodeAdminModerationBatchDecision(intent with { Rows = [intent.Rows[1], intent.Rows[0]] }));

        await Execute(db, "insert into public.comment_blocked_region values(1,4,'ZZ')", ct);
        var blocked = await Assert.ThrowsAsync<ModerationBatchConflictException>(() =>
            batch.DecideModerationBatch(moderator.Token, proof, frame, fenceVisibleMessages: true, ct));
        Assert.Equal(0b10, blocked.Positions);
        await AssertRolledBack();
        await Execute(db, "delete from public.comment_blocked_region where article_id=1 and comment_id=4", ct);

        await Execute(db, """
            alter table public.comment_reply_notice add constraint fixture_deny_second_reply_notice check (reply_id<>4)
            """, ct);
        var failure = await Assert.ThrowsAsync<PostgresException>(() =>
            batch.DecideModerationBatch(moderator.Token, proof, frame, fenceVisibleMessages: true, ct));
        Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        Assert.Equal("fixture_deny_second_reply_notice", failure.ConstraintName);
        await AssertRolledBack();
        await Execute(db, "alter table public.comment_reply_notice drop constraint fixture_deny_second_reply_notice", ct);

        var receipt = await batch.DecideModerationBatch(moderator.Token, proof, frame, fenceVisibleMessages: true, ct);
        Assert.True(receipt.BatchId > 0);
        Assert.Equal(2, receipt.Count);
        await ProofRejected(moderator.Token, proof, frame);
        Assert.True(await ReadDatabase<bool>(db, """
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
            """, ct, receipt.BatchId, moderator.Id, SHA256.HashData(moderator.Digest), reason, digest, foreignDigest, singleDigest));
        Assert.True(await ReadDatabase<bool>(db, """
            select (select count(*) from public.inbox_conversation)=2 and (select count(*) from public.inbox_event)=4
                and (select count(*) from public.comment_reply_notice n
                    join public.inbox_delivery d on d.account_id=n.recipient_id
                    join public.comment c on (c.article_id,c.id)=(n.article_id,n.reply_id)
                    join public.comment_account_owner p on (p.article_id,p.comment_id,p.user_id)=(c.article_id,c.parent_id,n.recipient_id)
                    where (n.reply_id,n.recipient_id) in ((3,$1),(4,$2)) and d.last_sequence=2
                        and (select array_agg(e.kind order by e.sequence) from public.inbox_event e
                            where (e.account_id,e.conversation_id,e.message_id)=(n.recipient_id,n.conversation_id,n.message_id))
                            =array[12,13]::smallint[])=2
            """, ct, first, second));
        await AssertPrivateNotice(first, second, 3);
        await AssertPrivateNotice(second, first, 4);

        Task ProofRejected(string session, string token, byte[] candidate) => Assert.ThrowsAsync<ModerationProofRequiredException>(() =>
            batch.DecideModerationBatch(session, token, candidate, fenceVisibleMessages: true, ct));

        async Task AssertRolledBack()
        {
            Assert.True(await ReadDatabase<bool>(db, """
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
                """, ct, moderator.Id, claims[0].ClaimVersion, renewed.ClaimVersion, digest));
        }

        async Task AssertPrivateNotice(Guid recipient, Guid stranger, long reply)
        {
            var conversation = await ReadDatabase<long>(db, "select conversation_id from public.comment_reply_notice where reply_id=$1", ct, reply);
            await using var read = await db.BeginTransactionAsync(ct);
            var own = await new InboxStore(db, read, recipient).GetAsync(conversation, null, 2, ct);
            Assert.NotNull(own);
            Assert.Contains($"Reply fixture {reply}。定位：/article/1#comment-{reply}", Assert.Single(own.Messages).Body, StringComparison.Ordinal);
            Assert.Null(await new InboxStore(db, read, stranger).GetAsync(conversation, null, 2, ct));
        }
    }

    [PostgresFact]
    public async Task ConcurrentBatchesWithOppositeRecipientOrderCommitBothPrivateJournals()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (first, second) = await SeedBatchReplies(db, 4, ct);
        var left = await AddModerator(db, "batch-left-reviewer", ct);
        var right = await AddModerator(db, "batch-right-reviewer", ct);
        var (_, _, service, _, _) = CreateStores(fixture);
        // Descending comment locks encounter B,A in the left batch and A,B in the right batch.
        var leftClaims = await service.AcquireModerationBatch(left.Token, [new(1, 3), new(1, 4)], ct);
        var rightClaims = await service.AcquireModerationBatch(right.Token, [new(1, 5), new(1, 6)], ct);
        var leftFrame = Wire.EncodeAdminModerationBatchDecision(new(1, "Left batch review", leftClaims.Select(BatchItem).ToArray()));
        var rightFrame = Wire.EncodeAdminModerationBatchDecision(new(1, "Right batch review", rightClaims.Select(BatchItem).ToArray()));
        var (leftProof, _) = await SeedDecisionProof(db, left, leftFrame, batch: true, ct);
        var (rightProof, _) = await SeedDecisionProof(db, right, rightFrame, batch: true, ct);

        var results = await Task.WhenAll(
            service.DecideModerationBatch(left.Token, leftProof, leftFrame, fenceVisibleMessages: true, ct),
            service.DecideModerationBatch(right.Token, rightProof, rightFrame, fenceVisibleMessages: true, ct));
        Assert.All(results, result => Assert.Equal(2, result.Count));
        Assert.NotEqual(results[0].BatchId, results[1].BatchId);
        Assert.True(await ReadDatabase<bool>(db, """
            select (select count(*) from public.admin_comment_batch)=2
                and (select count(*) from public.admin_comment_batch_item)=4
                and (select count(*) from public.admin_comment_moderation)=4
                and (select count(*) from public.comment_reply_notice where (reply_id,recipient_id) in ((3,$1),(4,$2),(5,$2),(6,$1)))=4
                and (select count(*) from public.inbox_delivery)=2
                and (select count(*) from public.inbox_delivery where account_id in ($1,$2) and last_sequence=4)=2
                and (select count(*) from public.inbox_event)=8
            """, ct, first, second));
    }

    [PostgresFact]
    public async Task ApprovedReplyNotifiesOnlyTheVisibleDirectParentOwnerAndRollsBackWithModeration()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await AddPendingComment(db, ct);
        var recipient = await Scalar<Guid>("select owner_id from public.article where id=1");
        var sender = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var recipientToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var handle = SiteSessions.Id(sender, Store.TokenDigest(token)!);
        await Execute(db, """
            insert into public.blog_user(id,name,enabled,generation) values($1,'Reply account',true,1)
            """, ct, sender);
        await Execute(db, """
            insert into public.user_session(digest,user_id,generation,expires_at)
                values($1,$2,1,now()+interval '5 minutes'),($3,$4,1,now()+interval '5 minutes')
            """, ct, Store.TokenDigest(token)!, sender, Store.TokenDigest(recipientToken)!, recipient);
        await Execute(db, "insert into public.comment_public_handle(user_id,display_name) values($1,'Reply display'),($2,'Parent display')",
            ct, sender, recipient);
        await Execute(db, "insert into public.comment_account_owner(article_id,comment_id,user_id) values(1,1,$1)", ct, recipient);
        await Execute(db, """
            insert into public.comment_public_write(article_id) values(1);
            insert into public.article_publication(article_id,revision,published_at) values(1,1,now());
            insert into public.article_revision_rights values(1,1,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true);
            insert into public.article_publication_rights(article_id,publication_id,revision)
                select article_id,publication_id,revision from public.article_publication where article_id=1;
            update public.article set published_revision=1,publication_count=1 where id=1;
            update public.comment set moderation_status=1,moderation_version=2 where article_id=1 and id=1;
            select setval(pg_get_serial_sequence('public.comment','id'),1);
            """, ct);
        var moderator = await AddModerator(db, "reply-reviewer", ct);
        var (_, admin, _, _, _) = CreateStores(fixture);
        var reply = new PublicCommentReply(1, 1, 1, "Reply display", "Independent public reply", Guid.NewGuid(), true);
        var optIn = new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS"] = "true",
            [CommentReplies.Setting] = "false",
        };
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct, optIn))
        {
            using var absent = Expect(NotFound, await Send(disabled, reply, true));
        }
        optIn.Remove(CommentReplies.Setting);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, optIn);
        CheckStatus(Conflict, await Send(server, reply, true, current: new string('a', 64)));
        CheckStatus(NotFound, await Send(server, reply with { ParentId = 98765 }, true));
        var proof = await Proof(reply);
        CheckStatus(Unauthorized, await Send(server, reply with { ParentId = 98765 }, false, proof));
        var pending = await Submit(reply, proof);
        Assert.Equal(0, pending.ModerationStatus);
        Assert.False(pending.Replayed);
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.inbox_event"));
        Assert.DoesNotContain(reply.Body, Encoding.UTF8.GetString(await server.Client.GetByteArrayAsync(WireRoutes.CommentRoots
            .Replace("{articleId:int}", "1", StringComparison.Ordinal), ct)), StringComparison.Ordinal);
        await Execute(db, "insert into public.comment_blocked_region values(1,1,'ZZ')", ct);
        CheckStatus(NotFound, await Send(server, reply with { IdempotencyKey = Guid.NewGuid() }, true));
        await Execute(db, "delete from public.comment_blocked_region", ct);

        var (decision, adminProof, adminDigest) = await PrepareDecision(pending.CommentId);
        await Execute(db, "alter table public.comment_reply_notice add constraint fixture_deny_reply_notice check (false)", ct);
        var failed = await Assert.ThrowsAsync<PostgresException>(() => admin.DecideComment(moderator.Token, adminProof, decision, ct));
        Assert.Equal(PostgresErrorCodes.CheckViolation, failed.SqlState);
        Assert.True(await Scalar<bool>("""
            select (select count(*) from public.inbox_conversation)=0
                and (select count(*) from public.inbox_event)=0
                and (select count(*) from public.admin_comment_moderation)=0
                and (select moderation_status=0 from public.comment where article_id=1 and id=$1)
                and exists(select 1 from public.admin_step_up where digest=$2)
            """, pending.CommentId, adminDigest));
        await Execute(db, "alter table public.comment_reply_notice drop constraint fixture_deny_reply_notice", ct);
        await admin.DecideComment(moderator.Token, adminProof, decision, ct);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => admin.DecideComment(moderator.Token, adminProof, decision, ct));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.comment_reply_notice n
            join public.admin_comment_moderation d on (d.article_id,d.comment_id)=(n.article_id,n.reply_id)
            join public.inbox_conversation c on (c.account_id,c.id)=(n.recipient_id,n.conversation_id)
            where n.reply_id=$1 and n.recipient_id=$2 and d.principal_id=$3 and n.moderation_version=d.comment_version+1
                and c.is_system and (select array_agg(e.kind order by e.sequence) from public.inbox_event e
                    where e.account_id=n.recipient_id and e.conversation_id=n.conversation_id
                        and e.message_id=n.message_id)=array[12,13]::smallint[]
            """, pending.CommentId, recipient, moderator.Id));
        var conversation = await Scalar<long>("select conversation_id from public.comment_reply_notice");
        Assert.Equal(HttpStatusCode.NotFound, (await ReadInbox(token)).Status);
        var visible = await ReadInbox(recipientToken);
        Assert.Equal(HttpStatusCode.OK, visible.Status);
        Assert.Contains($"Reply display 回复了您的评论：{reply.Body}。定位：/article/1#comment-{pending.CommentId}", visible.Body,
            StringComparison.Ordinal);

        var nested = reply with { ParentId = pending.CommentId, IdempotencyKey = Guid.NewGuid(), Body = "Reply to my own comment" };
        var self = await Submit(nested, await Proof(nested));
        Assert.True(await Scalar<bool>("select root_id=1 and parent_id=$1 and depth=2 from public.comment where article_id=1 and id=$2",
            pending.CommentId, self.CommentId));
        var (selfDecision, selfProof, _) = await PrepareDecision(self.CommentId);
        await admin.DecideComment(moderator.Token, selfProof, selfDecision, ct);
        await Execute(db, "delete from public.comment_public_write where article_id=1", ct);
        var replay = await Submit(reply, await Proof(reply));
        Assert.Equal(pending.CommentId, replay.CommentId);
        Assert.True(replay.Replayed);
        Assert.Equal(1, replay.ModerationStatus);
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.comment_reply_notice"));
        Assert.Equal(2L, await Scalar<long>("select count(*) from public.inbox_event"));

        async Task<T> Scalar<T>(string sql, params object[] parameters)
        {
            return Assert.IsType<T>(await FixtureSql.ScalarAsync(db, null, ct, sql, parameters));
        }

        async Task<HttpResponseMessage> Send(ServerProcess app, PublicCommentReply command, bool challenge, string? proofHeader = null,
            string? current = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, challenge ? WireRoutes.PublicCommentReplyPow : WireRoutes.SubmitPublicCommentReply)
            { Content = new ByteArrayContent(Wire.EncodePublicCommentReply(command)) };
            request.Content.Headers.ContentType = new(Aeds.ContentType);
            request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            request.Headers.Add(WireHeaders.CurrentSession, current ?? handle);
            request.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            if (challenge) request.Headers.Add(WireHeaders.PowClientNonce, ClientNonce);
            if (proofHeader is not null) request.Headers.Add(WireHeaders.PowProof, proofHeader);
            return await app.Client.SendAsync(request, ct);
        }

        async Task<string> Proof(PublicCommentReply command)
        {
            using var response = Ok(await Send(server, command, true));
            return PowFixture.SolveFrame(await response.Content.ReadAsByteArrayAsync(ct), ClientNonce, ct);
        }

        async Task<PublicCommentSubmissionResult> Submit(PublicCommentReply command, string authorization)
        {
            using var response = Ok(await Send(server, command, false, authorization));
            return Wire.DecodePublicCommentSubmissionResult(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task<(HttpStatusCode Status, string Body)> ReadInbox(string session)
        {
            var path = WireRoutes.InboxDetail.Replace("{id:long}", conversation.ToString(System.Globalization.CultureInfo.InvariantCulture));
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.Add("Cookie", $"fsus-v2-session={session}");
            using var response = await server.Client.SendAsync(request, ct);
            return (response.StatusCode, Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync(ct)));
        }

        async Task<(AdminModerationDecision Decision, string Proof, byte[] Digest)> PrepareDecision(long comment)
        {
            var claim = await admin.AcquireCommentClaim(moderator.Token, new(1, comment), ct);
            var intent = new AdminModerationDecision(1, comment, 0, 1, "Reviewed visible reply fixture", claim.CommentVersion,
                claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
            var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            var digest = SHA256.HashData(Encoding.ASCII.GetBytes(token));
            await Execute(db, """
                insert into public.admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
                values($1,$2,$3,1,1,$4,null,clock_timestamp()+interval '45 seconds',2)
                """, ct, digest, moderator.Id, moderator.Digest, AdminModerationStore.DecisionDigest(intent));
            return (intent, token, digest);
        }
    }

    private const string ClientNonce = "c1287bbaae554232a936d42a3f59bd0d";

    [PostgresFact]
    public async Task AppealRequiresAnOwnedAdverseReceiptAndAnIndependentBoundDecision()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await AddPendingComment(db, ct);
        var owner = (Guid)(await Scalar("select owner_id from public.article where id=1"))!;
        var actor = new Identity(owner, "Site fixture", 1, true, DateTimeOffset.UtcNow.AddMinutes(10));
        var authorSession = RandomNumberGenerator.GetBytes(32);
        var original = await AddModerator(db, "appeal-original", ct);
        var reviewer = await AddModerator(db, "appeal-reviewer", ct);
        var outsider = await fixture.SignInSiteUser("appeal-outsider", ct);
        await Execute(db, "insert into public.comment_account_owner values(1,1,$1)", ct, owner);
        await Execute(db, "update public.comment set moderation_status=2,moderation_version=2 where article_id=1 and id=1", ct);
        await using (var rejected = await db.BeginTransactionAsync(ct))
            await Denied(Rejection.NotFound, () => CommentAppeals.Issue(db, rejected, actor, authorSession, 1, ct));
        var adverse = (long)(await Scalar("""
            insert into public.admin_comment_moderation(article_id,comment_id,principal_id,previous_status,next_status,reason,happened_at,comment_version)
            values(1,1,$1,0,2,'Original reviewer rejects',clock_timestamp(),1) returning id
            """, original.Id))!;
        await using (var wrongOwner = await db.BeginTransactionAsync(ct))
            await Denied(Rejection.NotFound, () => CommentAppeals.Issue(db, wrongOwner, actor with { Id = Guid.NewGuid() }, authorSession, 1, ct));
        CommentAuthorChallenge challenge;
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            challenge = await CommentAppeals.Issue(db, tx, actor, authorSession, 1, ct);
            await tx.CommitAsync(ct);
        }
        const string reason = "The record was misunderstood.";
        await using (var wrongSession = await db.BeginTransactionAsync(ct))
            await Denied(Rejection.NotFound, () => CommentAppeals.Submit(db, wrongSession, actor, RandomNumberGenerator.GetBytes(32),
                1, new(reason, challenge.Challenge), ct));
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await CommentAppeals.Submit(db, tx, actor, authorSession, 1, new(reason, challenge.Challenge), ct);
            await tx.CommitAsync(ct);
        }
        await using (var retry = await db.BeginTransactionAsync(ct))
            await Denied(Rejection.Conflict, () => CommentAppeals.Submit(db, retry, actor, authorSession, 1, new(reason, challenge.Challenge), ct));
        var appeal = (long)(await Scalar("select id from public.comment_appeal where adverse_id=$1", adverse))!;
        var (_, _, _, service, history) = CreateStores(fixture);
        var payload = Aeds.Encode(FrameType.CommentAppealDecisionRequest, """
            {"decision":"granted","reason":"Independent review confirms the source."}
            """u8);
        await Denied(Rejection.Forbidden, () => service.BeginAppealStepUp(original.Token, appeal, payload, ct));
        await Denied(Rejection.Unauthorized, () => service.BeginAppealStepUp(outsider.Token, appeal, payload, ct));
        Aeds.Decode(await service.BeginAppealStepUp(reviewer.Token, appeal, payload, ct), FrameType.PasskeyLoginBegin);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideAppeal(reviewer.Token, appeal, payload, null, ct));
        var proof = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await Execute(db, """
            insert into public.comment_appeal_admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
            values($1,$2,$3,1,5,$4,clock_timestamp()+interval '45 seconds',2)
            """, ct, SHA256.HashData(Encoding.ASCII.GetBytes(proof)), reviewer.Id, reviewer.Digest, AdminCommentAppealStore.AppealDecisionDigest(appeal, payload));
        var altered = Aeds.Encode(FrameType.CommentAppealDecisionRequest, """
            {"decision":"denied","reason":"Independent review confirms the source."}
            """u8);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideAppeal(reviewer.Token, appeal, altered, proof, ct));
        await Execute(db, "update public.comment set moderation_version=3 where article_id=1 and id=1", ct);
        await Denied(Rejection.Conflict, () => service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct));
        Assert.Equal(0L, await Scalar("select count(*) from public.comment_appeal_decision"));
        await Execute(db, "update public.comment set moderation_version=2 where article_id=1 and id=1", ct);
        await Execute(db, "alter table public.comment_appeal_decision add constraint fixture_refuse_audit check (false)", ct);
        await Assert.ThrowsAsync<PostgresException>(() => service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct));
        Assert.Equal((short)2, await Scalar("select moderation_status from public.comment where article_id=1 and id=1"));
        Assert.Equal(1L, await Scalar("select count(*) from public.comment_appeal_event"));
        await Execute(db, "alter table public.comment_appeal_decision drop constraint fixture_refuse_audit", ct);
        Aeds.Decode(await service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct), FrameType.CommentAppealDecisionResult);
        Assert.Equal(reviewer.Id, await Scalar("select principal_id from public.comment_appeal_decision"));
        Assert.Equal((short)1, await Scalar("select moderation_status from public.comment where article_id=1 and id=1"));
        Assert.Equal((short)1, await Scalar("select next_status from public.comment_appeal_event where kind=2"));
        await Denied(Rejection.Conflict, () => service.DecideAppeal(reviewer.Token, appeal, payload, proof, ct));
        Assert.Equal(2L, await Scalar("select count(*) from public.comment_appeal_event"));
        Assert.Equal(0L, await Scalar("select count(*) from public.comment_appeal_admin_step_up where kind=2"));

        await Execute(db, """
            insert into public.comment(article_id,id,root_id,depth,moderation_status,moderation_version,deleted,body,author_mode,display_name,display_language,created_at)
            values(1,2,2,0,2,2,false,'Second rejection',3,'Fixture writer','en',clock_timestamp())
            """, ct);
        await Execute(db, "insert into public.comment_submit_command values($1,$2,$3,1,2)", ct, owner,
            Guid.NewGuid(), RandomNumberGenerator.GetBytes(32));
        await Execute(db, "insert into public.comment_account_owner values(1,2,$1)", ct, owner);
        await Execute(db, """
            insert into public.admin_comment_moderation(article_id,comment_id,principal_id,previous_status,next_status,reason,happened_at,comment_version)
            values(1,2,$1,0,2,'Original reviewer rejects again',clock_timestamp(),1)
            """, ct, original.Id);
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var secondChallenge = await CommentAppeals.Issue(db, tx, actor, authorSession, 2, ct);
            await CommentAppeals.Submit(db, tx, actor, authorSession, 2, new(reason, secondChallenge.Challenge), ct);
            await tx.CommitAsync(ct);
        }
        var secondAppeal = (long)(await Scalar("select id from public.comment_appeal where comment_id=2"))!;
        Aeds.Decode(await service.BeginAppealStepUp(reviewer.Token, secondAppeal, altered, ct), FrameType.PasskeyLoginBegin);
        var secondProof = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await Execute(db, """
            insert into public.comment_appeal_admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
            values($1,$2,$3,1,5,$4,clock_timestamp()+interval '45 seconds',2)
            """, ct, SHA256.HashData(Encoding.ASCII.GetBytes(secondProof)), reviewer.Id, reviewer.Digest,
            AdminCommentAppealStore.AppealDecisionDigest(secondAppeal, altered));

        var attempts = await Task.WhenAll(ResolveSecond(), ResolveSecond());
        Assert.Single(attempts, result => result);
        Assert.Single(attempts, result => !result);
        Assert.Equal((short)2, await Scalar("select moderation_status from public.comment where article_id=1 and id=2"));
        Assert.Equal((short)2, await Scalar("select next_status from public.comment_appeal_event where appeal_id=$1 and kind=2", secondAppeal));
        await Execute(db, """
            update public.comment_appeal_event e set occurred_at=m.happened_at
            from public.comment_appeal a join public.admin_comment_moderation m on m.id=a.adverse_id
            where e.appeal_id=a.id and a.id=$1
            """, ct, secondAppeal);
        await CheckTimeline(1, 1, 3);
        await CheckTimeline(2, 2, 2);

        async Task CheckTimeline(long comment, int status, long version)
        {
            var frame = await history.CommentTimeline(reviewer.Token, comment, QueryCollection.Empty, ct);
            using var receipt = JsonDocument.Parse(Aeds.Decode(frame, (FrameType)225).ToArray());
            Assert.True(receipt.RootElement.GetProperty("consistent").GetBoolean());
            Assert.Equal(status, receipt.RootElement.GetProperty("currentStatus").GetInt32());
            var actions = receipt.RootElement.GetProperty("events").EnumerateArray().ToArray();
            Assert.Equal(new[] { "create", "reject", "appeal", "appeal_decision" },
                actions.Select(row => row.GetProperty("eventType").GetString()));
            Assert.Equal(version, actions[^1].GetProperty("commentVersion").GetInt64());
            Assert.Equal(reviewer.Id, actions[^1].GetProperty("adminPrincipal").GetGuid());
        }

        async Task<bool> ResolveSecond()
        {
            try
            {
                await service.DecideAppeal(reviewer.Token, secondAppeal, altered, secondProof, ct);
                return true;
            }
            catch (BusinessException changed) when (changed.Rejection == Rejection.Conflict) { return false; }
        }

        Task<object?> Scalar(string sql, params object[] args) =>
            FixtureSql.ScalarAsync(db, null, ct, sql, args);
    }

    [PostgresFact]
    public async Task ClaimSerializesOwnershipAndFencesEarlierVersions()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await AddPendingComment(db, ct);
        var first = await AddModerator(db, "first-moderator", ct);
        var second = await AddModerator(db, "second-moderator", ct);
        var siteUser = await fixture.SignInSiteUser("claim-site-user", ct);
        var (_, service, _, _, _) = CreateStores(fixture);
        var target = new AdminModerationClaimRequest(1, 1);
        await Denied(Rejection.Unauthorized, () => service.AcquireCommentClaim(siteUser.Token, target, ct));

        ClaimAttempt[] results;
        await using (var gate = await db.BeginTransactionAsync(ct))
        {
            Assert.Equal(1, await FixtureSql.ScalarAsync(db, gate, ct, "select 1 from public.comment where article_id=1 and id=1 for update"));
            var a = Attempt(first);
            var b = Attempt(second);
            await using var observer = await fixture.DataSource.OpenConnectionAsync(ct);
            // The second contender can wait behind the first contender in the row-lock queue.
            await using var blocked = Store.Sql(observer, null, """
                select count(*) from pg_catalog.pg_stat_activity a
                where a.datname=current_database() and a.pid<>pg_backend_pid()
                  and cardinality(pg_catalog.pg_blocking_pids(a.pid))>0
                """);
            while (!a.IsCompleted && !b.IsCompleted && (long)(await blocked.ExecuteScalarAsync(ct))! < 2)
                await Task.Delay(15, ct);
            Assert.False(a.IsCompleted);
            Assert.False(b.IsCompleted);
            await gate.CommitAsync(ct);
            results = await Task.WhenAll(a, b);
        }
        var success = Assert.Single(results, result => result.Claim is not null);
        var conflict = Assert.Single(results, result => result.Denied is not null);
        Assert.Equal(Rejection.Conflict, conflict.Denied);
        var original = success.Claim!;
        Assert.Equal(1L, original.CommentVersion);
        Assert.Equal(1L, original.ClaimGeneration);
        Assert.Equal(1L, original.ClaimVersion);

        await Denied(Rejection.Conflict, () => service.ReleaseCommentClaim(conflict.Admin.Token, original, ct));
        var renewed = await service.RenewCommentClaim(success.Admin.Token, original, ct);
        Assert.Equal(original.ClaimGeneration, renewed.ClaimGeneration);
        Assert.Equal(original.ClaimVersion + 1, renewed.ClaimVersion);
        Assert.Equal(original.CommentVersion, renewed.CommentVersion);
        Assert.True(renewed.ExpiresAt >= original.ExpiresAt);
        await Denied(Rejection.Conflict, () => service.ReleaseCommentClaim(success.Admin.Token, original, ct));
        await service.ReleaseCommentClaim(success.Admin.Token, renewed, ct);

        var reclaimed = await service.AcquireCommentClaim(conflict.Admin.Token, target, ct);
        Assert.Equal(original.ClaimGeneration + 1, reclaimed.ClaimGeneration);
        Assert.True(reclaimed.ClaimVersion > renewed.ClaimVersion);
        Assert.NotEqual(original.ClaimToken, reclaimed.ClaimToken);
        await Execute(db, "update public.admin_comment_claim set expires_at=clock_timestamp()-interval '1 second'", ct);
        await Denied(Rejection.Conflict, () => service.RenewCommentClaim(conflict.Admin.Token, reclaimed, ct));
        var afterExpiry = await service.AcquireCommentClaim(success.Admin.Token, target, ct);
        Assert.Equal(reclaimed.ClaimGeneration + 1, afterExpiry.ClaimGeneration);

        await Execute(db, "delete from public.admin_session where digest=$1", ct, success.Admin.Digest);
        await Denied(Rejection.Unauthorized, () => service.RenewCommentClaim(success.Admin.Token, afterExpiry, ct));
        await Denied(Rejection.Unauthorized, () => service.ReleaseCommentClaim(success.Admin.Token, afterExpiry, ct));
        var afterRevocation = await service.AcquireCommentClaim(conflict.Admin.Token, target, ct);
        Assert.Equal(afterExpiry.ClaimGeneration + 1, afterRevocation.ClaimGeneration);
        Assert.True(afterRevocation.ClaimVersion > afterExpiry.ClaimVersion);
        Assert.Equal(conflict.Admin.Id, await FixtureSql.ScalarAsync(db, null, ct, """
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
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await AddPendingComment(db, ct);
        var owner = await AddModerator(db, "decision-owner", ct);
        var other = await AddModerator(db, "another-moderator", ct);
        var (_, service, _, _, _) = CreateStores(fixture);
        var claim = await service.AcquireCommentClaim(owner.Token, new(1, 1), ct);
        var decision = new AdminModerationDecision(1, 1, 0, 1, "Reviewed the submitted comment", claim.CommentVersion,
            claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, null, decision, ct));
        await Denied(Rejection.Conflict, () => service.BeginModerationDecisionStepUp(other.Token, decision, ct));
        Aeds.Decode(await service.BeginModerationDecisionStepUp(owner.Token, decision, ct), FrameType.PasskeyLoginBegin);

        // Native Chrome covers actual assertion and proof issuance. This row only seeds the database consumer.
        var staleDecision = decision with { ClaimVersion = claim.ClaimVersion + 1 };
        var (staleProof, _) = await SeedProof(staleDecision);
        await Denied(Rejection.Conflict, () => service.DecideComment(owner.Token, staleProof, staleDecision, ct));

        var (proof, proofDigest) = await SeedProof(decision);

        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, proof,
            decision with { Reason = "A different moderation reason" }, ct));
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(other.Token, proof, decision, ct));
        await Execute(db, "alter table public.admin_comment_moderation add constraint fixture_refuse_audit check (false)", ct);
        var rejected = await Assert.ThrowsAsync<PostgresException>(() => service.DecideComment(owner.Token, proof, decision, ct));
        Assert.Equal(PostgresErrorCodes.CheckViolation, rejected.SqlState);
        Assert.Equal(true, await FixtureSql.ScalarAsync(db, null, ct, """
            select c.moderation_status=0 and c.moderation_version=1 and s.state=1 and s.claim_version=$2
                and exists(select from public.admin_step_up where digest=$1)
            from public.comment c join public.admin_comment_claim s on (s.article_id,s.comment_id)=(c.article_id,c.id)
            where c.article_id=1 and c.id=1
            """, proofDigest, claim.ClaimVersion));

        await Execute(db, "alter table public.admin_comment_moderation drop constraint fixture_refuse_audit", ct);
        await service.DecideComment(owner.Token, proof, decision, ct);
        await using var audit = Store.Sql(db, null, """
            select m.principal_id,m.previous_status,m.next_status,m.reason,m.comment_version,c.moderation_status,
                   c.moderation_version,s.state,s.claim_version,
                   exists(select from public.admin_step_up where digest=$1)
            from public.admin_comment_moderation m
            join public.comment c on (c.article_id,c.id)=(m.article_id,m.comment_id)
            join public.admin_comment_claim s on (s.article_id,s.comment_id)=(m.article_id,m.comment_id)
            where m.article_id=1 and m.comment_id=1
            """, proofDigest);
        await using var row = await audit.ExecuteReaderAsync(ct);
        Assert.True(await row.ReadAsync(ct));
        Assert.Equal(owner.Id, row.GetGuid(0));
        Assert.Equal((short)0, row.GetInt16(1));
        Assert.Equal((short)1, row.GetInt16(2));
        Assert.Equal(decision.Reason, row.GetString(3));
        Assert.Equal(claim.CommentVersion, row.GetInt64(4));
        Assert.Equal((short)1, row.GetInt16(5));
        Assert.Equal(claim.CommentVersion + 1, row.GetInt64(6));
        Assert.Equal((short)3, row.GetInt16(7));
        Assert.Equal(claim.ClaimVersion + 1, row.GetInt64(8));
        Assert.False(row.GetBoolean(9));
        Assert.False(await row.ReadAsync(ct));
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, proof, decision, ct));
        await Denied(Rejection.Conflict, () => service.AcquireCommentClaim(other.Token, new(1, 1), ct));

        async Task<(string Token, byte[] Digest)> SeedProof(AdminModerationDecision value)
        {
            var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            var digest = SHA256.HashData(Encoding.ASCII.GetBytes(token));
            await Execute(db, """
                insert into public.admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
                values($1,$2,$3,1,1,$4,null,clock_timestamp()+interval '45 seconds',2)
                on conflict(session_digest,kind) do update set digest=excluded.digest,body_digest=excluded.body_digest,
                    expires_at=excluded.expires_at
                """, ct, digest, owner.Id, owner.Digest, AdminModerationStore.DecisionDigest(value));
            return (token, digest);
        }
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

    private static async Task<(Guid First, Guid Second)> SeedBatchReplies(NpgsqlConnection db, int count, CancellationToken ct)
    {
        await AddPendingComment(db, ct);
        var first = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var second = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var sender = Guid.NewGuid();
        await Execute(db, """
            insert into public.blog_user(id,name,enabled,generation)
            values($1,'First parent author',true,1),($2,'Second parent author',true,1),($3,'Reply author',true,1)
            """, ct, first, second, sender);
        await Execute(db, """
            insert into public.article_publication(article_id,revision,published_at) values(1,1,now());
            insert into public.article_revision_rights values(1,1,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true);
            insert into public.article_publication_rights(article_id,publication_id,revision)
                select article_id,publication_id,revision from public.article_publication where article_id=1;
            update public.article set published_revision=1,publication_count=1 where id=1;
            update public.comment set moderation_status=1,moderation_version=2 where article_id=1 and id=1;
            insert into public.comment(article_id,id,root_id,depth,moderation_status,moderation_version,deleted,
                body,author_mode,display_name,display_language,created_at)
                values(1,2,2,0,1,2,false,'Second visible parent',3,'Second parent','en',clock_timestamp());
            """, ct);
        await Execute(db, "insert into public.comment_account_owner values(1,1,$1),(1,2,$2)", ct, first, second);
        for (var i = 0; i < count; i++)
        {
            var reply = i + 3L;
            var parent = i % 4 is 0 or 3 ? 1L : 2L;
            await Execute(db, """
                insert into public.comment(article_id,id,root_id,parent_id,parent_depth,reply_to_id,depth,moderation_status,
                    deleted,body,author_mode,display_name,display_language,created_at)
                values(1,$1,$2,$2,0,$2,1,0,false,$3,3,'Batch reply author','en',clock_timestamp())
                """, ct, reply, parent, FormattableString.Invariant($"Reply fixture {reply}"));
            await Execute(db, "insert into public.comment_account_owner values(1,$1,$2)", ct, reply, sender);
            await Execute(db, "insert into public.comment_submit_command values($1,$2,$3,1,$4)", ct,
                sender, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32), reply);
        }
        return (first, second);
    }

    private static AdminModerationBatchItem BatchItem(AdminModerationClaim claim) =>
        new(claim.ArticleId, claim.CommentId, claim.CommentVersion, claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion, 0);

    private static async Task<(string Token, byte[] Digest)> SeedDecisionProof(NpgsqlConnection db, Moderator moderator,
        byte[] frame, bool batch, CancellationToken ct)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var digest = SHA256.HashData(Encoding.ASCII.GetBytes(token));
        var table = batch ? "admin_comment_batch_step_up" : "admin_step_up";
        await Execute(db, $"""
            insert into public.{table}(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
            values($1,$2,$3,1,$4,$5,null,clock_timestamp()+interval '45 seconds',2)
            """, ct, digest, moderator.Id, moderator.Digest, batch ? 6 : 1, SHA256.HashData(frame));
        return (token, digest);
    }

    private static async Task<T> ReadDatabase<T>(NpgsqlConnection db, string sql, CancellationToken ct, params object[] parameters)
    {
        return Assert.IsType<T>(await FixtureSql.ScalarAsync(db, null, ct, sql, parameters));
    }

    private static async Task AddPendingComment(NpgsqlConnection db, CancellationToken ct)
    {
        var member = Guid.NewGuid();
        await Execute(db, "insert into public.blog_user(id,name,enabled,generation) values($1,'Site fixture',true,1)",
            ct, member);
        await FixtureSql.AdminPrincipalAsync(db, null, ct, member, "site-fixture");
        await Execute(db, """
            with article as (
                insert into public.article(owner_id,revision,title,body,deleted)
                values($1,1,'Fixture article','Fixture article',false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            select id,1,'Fixture article','Fixture article',clock_timestamp() from article
            """, ct, member);
        await Execute(db, """
            insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
            values(1,1,1,0,0,false,'Awaiting review',3,'Fixture writer','en',clock_timestamp())
            """, ct);
        await Execute(db, "insert into public.comment_submit_command values($1,$2,$3,1,1)", ct, member,
            Guid.NewGuid(), RandomNumberGenerator.GetBytes(32));
    }

    private static async Task<Moderator> AddModerator(NpgsqlConnection db, string handle, CancellationToken ct, bool canModerate = true)
    {
        var (principal, token, digest) = await FixtureSql.AdminAsync(db, ct, handle, 10, RandomNumberGenerator.GetBytes(32), [2]);
        return new(principal, token, digest);
    }

    private static Task Execute(NpgsqlConnection db, string sql, CancellationToken ct, params object[] parameters) =>
        FixtureSql.ExecuteAsync(db, null, ct, sql, parameters);

    private sealed record Moderator(Guid Id, string Token, byte[] Digest);
    private sealed record ClaimAttempt(Moderator Admin, AdminModerationClaim? Claim, Rejection? Denied);
}
