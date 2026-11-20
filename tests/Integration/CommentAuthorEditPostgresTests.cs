using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminModerationPostgresTests
{
    [PostgresFact]
    public async Task ApprovedOwnerEditCommitsOneRevisionAndReturnsToReviewWithoutDuplicatingReplyNotice()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (owner, outsider) = await SeedBatchReplies(db, 1, ct);
        // The shared reply fixture starts with an approved parent. Start this timeline at submission.
        await Execute(db, "update public.comment_submit_command set user_id=$1 where article_id=1 and comment_id=1", ct, owner);
        await Execute(db, "update public.comment set moderation_status=0,moderation_version=1 where article_id=1 and id=1", ct);
        var createdAt = await ReadDatabase<DateTime>(db, "select created_at from public.comment where article_id=1 and id=1", ct);
        var replyOwner = await ReadDatabase<Guid>(db, "select user_id from public.comment_account_owner where comment_id=3", ct);
        var actor = new Identity(owner, "Parent author", 1, false, DateTimeOffset.UtcNow.AddMinutes(10));
        var replier = actor with { Id = replyOwner, Name = "Reply author" };
        var session = RandomNumberGenerator.GetBytes(32);
        var otherSession = RandomNumberGenerator.GetBytes(32);
        var moderator = await AddModerator(db, "comment-edit-reviewer", ct);
        var (_, review, _, _, _) = CreateStores(fixture);
        var publicRead = new CommentReadStore(fixture.DataSource);
        await Approve(1);
        await Approve(3);
        var delivered = await ReadDatabase<long>(db, "select message_id from public.comment_reply_notice where reply_id=3", ct);

        var original = await Own((conn, tx) => CommentAuthorEdits.Detail(conn, tx, owner, 1, ct));
        Assert.Equal(1, original.ArticleId);
        Assert.Equal(2, original.CurrentVersion);
        Assert.Equal("Awaiting review", original.Body);
        await Denied(Rejection.NotFound, () => Own((conn, tx) => CommentAuthorEdits.Detail(conn, tx, outsider, 1, ct)));
        await Execute(db, "insert into public.comment_blocked_region values(1,1,'ZZ')", ct);
        await Denied(Rejection.NotFound, () => Issue(actor, session, 1));
        await Execute(db, "delete from public.comment_blocked_region where article_id=1 and comment_id=1", ct);
        await Execute(db, "update public.comment set created_at=clock_timestamp()-interval '31 minutes' where article_id=1 and id=1", ct);
        await Denied(Rejection.NotFound, () => Own((conn, tx) => CommentAuthorEdits.Detail(conn, tx, owner, 1, ct)));
        await Execute(db, "update public.comment set created_at=$1 where article_id=1 and id=1", ct, createdAt);

        const string edited = "Revised root text for a second review.";
        var expired = await Issue(actor, session, 1);
        await Execute(db, "update public.comment_author_edit_challenge set expires_at=clock_timestamp()-interval '1 second'", ct);
        await Denied(Rejection.NotFound, () => Edit(actor, session, 1, new(expired.CurrentVersion, edited, expired.Challenge)));
        var mismatch = await Issue(actor, session, 1);
        await Execute(db, "update public.comment_author_edit_challenge set publication_id=publication_id+1", ct);
        await Denied(Rejection.Conflict, () => Edit(actor, session, 1, new(mismatch.CurrentVersion, edited, mismatch.Challenge)));

        var proof = await Issue(actor, session, 1);
        var command = new CommentAuthorEditRequest(proof.CurrentVersion, $"  {edited}  ", proof.Challenge);
        Assert.Equal(original.CurrentVersion, proof.CurrentVersion);
        await Denied(Rejection.NotFound, () => Edit(actor, otherSession, 1, command));
        await Denied(Rejection.NotFound, () => Edit(actor with { Generation = 2 }, session, 1, command));
        await Denied(Rejection.Conflict, () => Edit(actor, session, 1, command with { ExpectedVersion = command.ExpectedVersion + 1 }));
        await Denied(Rejection.Invalid, () => Edit(actor, session, 1, command with { Content = original.Body }));

        await Execute(db, "alter table public.comment_author_edit_outbox add constraint fixture_refuse_edit check (false)", ct);
        var failed = await Assert.ThrowsAsync<PostgresException>(() => Edit(actor, session, 1, command));
        Assert.Equal(PostgresErrorCodes.CheckViolation, failed.SqlState);
        Assert.Equal("fixture_refuse_edit", failed.ConstraintName);
        Assert.True(await ReadDatabase<bool>(db, """
            select c.body=$1 and c.moderation_version=2 and c.moderation_status=1 and c.edited_at is null
                and (select count(*) from public.comment_author_edit_challenge)=1
                and not exists(select from public.comment_author_edited)
                and not exists(select from public.comment_author_edit_outbox)
            from public.comment c where c.article_id=1 and c.id=1
            """, ct, original.Body));
        await Execute(db, "alter table public.comment_author_edit_outbox drop constraint fixture_refuse_edit", ct);

        var outcomes = await Task.WhenAll(Attempt(), Attempt());
        var receipt = Assert.Single(outcomes.OfType<CommentAuthorMutation>());
        Assert.Single(outcomes, result => result is null);
        Assert.Equal((true, "ok", original.CurrentVersion + 1, 0),
            (receipt.Success, receipt.Code, receipt.CurrentVersion, receipt.ModerationStatus));
        Assert.True(receipt.EditedAtUtc.HasValue);
        Assert.True(await ReadDatabase<bool>(db, """
            select e.user_id=$1 and e.previous_version=2 and e.comment_version=3 and e.previous_status=1
                and e.moderation_status=0 and e.previous_body=$2 and e.body=$3
                and e.previous_body_digest=pg_catalog.sha256(convert_to($2,'UTF8'))
                and e.body_digest=pg_catalog.sha256(convert_to($3,'UTF8')) and e.happened_at=c.edited_at
                and c.body=$3 and c.parent_id is null and c.root_id=1 and c.depth=0 and not c.deleted
                and o.event_type='CommentEdited' and not exists(select from public.comment_author_edit_challenge)
            from public.comment_author_edited e
            join public.comment_author_edit_outbox o using(article_id,comment_id,comment_version)
            join public.comment c on (c.article_id,c.id)=(e.article_id,e.comment_id)
            where e.article_id=1 and e.comment_id=1
            """, ct, owner, original.Body, edited));

        var pending = Encoding.UTF8.GetString(await publicRead.Roots(1, null, 10, ct));
        Assert.Contains("Reply fixture 3", pending, StringComparison.Ordinal);
        Assert.DoesNotContain("Fixture writer", pending, StringComparison.Ordinal);
        Assert.DoesNotContain(original.Body, pending, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, pending, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, Encoding.UTF8.GetString(await publicRead.Context(1, 1, 6, ct)), StringComparison.Ordinal);
        await Approve(1);
        var republished = Encoding.UTF8.GetString(await publicRead.Roots(1, null, 10, ct));
        Assert.Contains(edited, republished, StringComparison.Ordinal);
        Assert.DoesNotContain(original.Body, republished, StringComparison.Ordinal);

        var replyProof = await Issue(replier, otherSession, 3);
        const string editedReply = "Revised reply whose earlier notice is retained.";
        await Edit(replier, otherSession, 3, new(replyProof.CurrentVersion, editedReply, replyProof.Challenge));
        await Approve(3);
        Assert.Contains(editedReply, Encoding.UTF8.GetString(await publicRead.Context(1, 3, 6, ct)), StringComparison.Ordinal);
        Assert.True(await ReadDatabase<bool>(db, """
            select (select count(*) from public.comment_reply_notice where reply_id=3 and message_id=$1)=1
                and (select count(*) from public.inbox_message)=1
                and exists(select from public.comment where article_id=1 and id=3 and root_id=1 and parent_id=1
                    and reply_to_id=1 and parent_depth=0 and depth=1 and not deleted and edited_at is not null)
            """, ct, delivered));

        var siteUser = await fixture.SignInSiteUser("comment-history-site-user", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost"
        });
        const string historyRoute = "/api/binary/author/comments/1/revisions";
        await History(HttpStatusCode.NotFound, moderator.Token, adminOrigin: false);
        await History(HttpStatusCode.Unauthorized, null);
        await History(HttpStatusCode.Unauthorized, siteUser.Token);
        await History(HttpStatusCode.BadRequest, moderator.Token, historyRoute + "?before=2&before=3");
        await History(HttpStatusCode.BadRequest, moderator.Token, historyRoute + "?articleId=1&articleId=2");
        await History(HttpStatusCode.NotFound, moderator.Token, historyRoute + "?articleId=2");
        using (var history = JsonDocument.Parse(Aeds.Decode(await History(HttpStatusCode.OK, moderator.Token), (FrameType)222).ToArray()))
        {
            Assert.Collection(history.RootElement.EnumerateArray(),
                row => AssertRevision(row, 2, "edited", edited),
                row => AssertRevision(row, 1, "created", original.Body));
        }
        using (var page = JsonDocument.Parse(Aeds.Decode(
            await History(HttpStatusCode.OK, moderator.Token, historyRoute + "?before=2"), (FrameType)222).ToArray()))
            AssertRevision(Assert.Single(page.RootElement.EnumerateArray()), 1, "created", original.Body);
        await Execute(db, "update public.comment_author_edited set body_digest=decode(repeat('00',32),'hex') where comment_id=1", ct);
        await History(HttpStatusCode.ServiceUnavailable, moderator.Token);
        await Execute(db, "update public.comment_author_edited set body_digest=pg_catalog.sha256(convert_to(body,'UTF8')) where comment_id=1", ct);
        var ownerToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var ownerDigest = Store.TokenDigest(ownerToken)!;
        await Execute(db, """
            insert into public.user_session(digest,user_id,generation,expires_at) values($1,$2,1,now()+interval '5 minutes')
            """, ct, ownerDigest, owner);
        using var deleteGrant = await AsOwner(WireRoutes.CommentAuthorChallenge, FrameType.CommentManagementChallengeRequest,
            """{"purpose":"delete","capabilitySecret":null}"""u8.ToArray(), FrameType.CommentManagementChallengeResponse);
        Assert.True(deleteGrant.RootElement.GetProperty("issued").GetBoolean());
        var approvedVersion = deleteGrant.RootElement.GetProperty("currentVersion").GetInt64();
        Assert.Equal(receipt.CurrentVersion + 1, approvedVersion);
        var deleteCommand = JsonSerializer.SerializeToUtf8Bytes(new
        {
            challenge = deleteGrant.RootElement.GetProperty("challenge").GetString(),
            capabilitySecret = ""
        });
        using var deletion = await AsOwner(WireRoutes.CommentAuthorDelete, FrameType.CommentAuthorStatusRequest,
            deleteCommand, FrameType.CommentAuthorMutationResult);
        var result = deletion.RootElement;
        Assert.True(result.GetProperty("success").GetBoolean());
        Assert.Equal("ok", result.GetProperty("code").GetString());
        var deletedVersion = result.GetProperty("currentVersion").GetInt64();
        Assert.Equal(approvedVersion + 1, deletedVersion);
        Assert.Equal(1, result.GetProperty("moderationStatus").GetInt32());
        Assert.Equal(receipt.EditedAtUtc, (DateTime?)result.GetProperty("editedAtUtc").GetDateTime());
        Assert.True(await ReadDatabase<bool>(db, """
            select c.deleted and c.body=$3 and c.moderation_version=$2 and c.moderation_status=1
                and d.user_id=$1 and d.comment_version=$2 and d.moderation_status=c.moderation_status
                and d.body_digest=pg_catalog.sha256(convert_to(c.body,'UTF8')) and d.happened_at>=c.edited_at
                and o.event_type='CommentDeleted' and not exists(select from public.comment_author_delete_challenge)
            from public.comment c join public.comment_author_deleted d on (d.article_id,d.comment_id)=(c.article_id,c.id)
            join public.comment_author_delete_outbox o on (o.article_id,o.comment_id)=(d.article_id,d.comment_id)
            where c.article_id=1 and c.id=1
            """, ct, owner, deletedVersion, edited));

        const string rootTimeline = "/api/binary/author/comments/1/moderation-timeline?articleId=1";
        using (var timeline = JsonDocument.Parse(Aeds.Decode(await History(HttpStatusCode.OK, moderator.Token, rootTimeline),
            FrameType.CommentModerationTimeline).ToArray()))
        {
            var state = timeline.RootElement;
            Assert.True(state.GetProperty("consistent").GetBoolean());
            Assert.True(state.GetProperty("deleted").GetBoolean());
            Assert.Equal(1, state.GetProperty("currentStatus").GetInt32());
            Assert.Equal(1, state.GetProperty("projectedStatus").GetInt32());
            var events = state.GetProperty("events").EnumerateArray().ToArray();
            Assert.Equal(new[] { "create", "approve", "edit", "approve", "delete" },
                events.Select(row => row.GetProperty("eventType").GetString()));
            Assert.Equal(new[] { 1L, 2L, 3L, 4L, deletedVersion }, events.Select(row => row.GetProperty("commentVersion").GetInt64()));
            Assert.Equal(1, events[^1].GetProperty("previousStatus").GetInt32());
            Assert.Equal(1, events[^1].GetProperty("nextStatus").GetInt32());
            Assert.Equal("comment_author_deleted", events[^1].GetProperty("transitionSource").GetString());
            Assert.DoesNotContain(edited, state.GetRawText(), StringComparison.Ordinal);
        }
        using (var history = JsonDocument.Parse(Aeds.Decode(await History(HttpStatusCode.OK, moderator.Token, historyRoute + "?articleId=1"),
            FrameType.CommentRevisionList).ToArray()))
        {
            Assert.Collection(history.RootElement.EnumerateArray(),
                row => AssertRevision(row, 3, "deleted", edited),
                row => AssertRevision(row, 2, "edited", edited),
                row => AssertRevision(row, 1, "created", original.Body));
        }
        var deletedTree = Encoding.UTF8.GetString(await server.Client.GetByteArrayAsync("/api/binary/comment/1", ct));
        Assert.Contains("已删除评论", deletedTree, StringComparison.Ordinal);
        Assert.Contains(editedReply, deletedTree, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, deletedTree, StringComparison.Ordinal);
        Assert.DoesNotContain(original.Body, deletedTree, StringComparison.Ordinal);
        Assert.DoesNotContain("Fixture writer", deletedTree, StringComparison.Ordinal);
        Assert.Equal(CommentReadWire.Context(null, [], []), await server.Client.GetByteArrayAsync("/api/binary/comment/1/context/1", ct));

        await Execute(db, "update public.comment_author_deleted set comment_version=comment_version+1 where article_id=1 and comment_id=1", ct);
        await RejectDeletedHistory();
        await Execute(db, "update public.comment_author_deleted set comment_version=$1 where article_id=1 and comment_id=1", ct, deletedVersion);
        await Execute(db, "delete from public.comment_author_delete_outbox where article_id=1 and comment_id=1", ct);
        await RejectDeletedHistory();
        await Execute(db, "insert into public.comment_author_delete_outbox values(1,1,'CommentDeleted')", ct);
        await History(HttpStatusCode.OK, moderator.Token, historyRoute + "?before=3&articleId=1");

        const string timelineRoute = "/api/binary/author/comments/3/moderation-timeline";
        await History(HttpStatusCode.NotFound, moderator.Token, timelineRoute, adminOrigin: false);
        await History(HttpStatusCode.Unauthorized, siteUser.Token, timelineRoute);
        await History(HttpStatusCode.NotFound, moderator.Token, timelineRoute + "?articleId=2");
        var timelinePacket = await History(HttpStatusCode.OK, moderator.Token, timelineRoute);
        Assert.Equal(timelinePacket, await History(HttpStatusCode.OK, moderator.Token, timelineRoute + "?articleId=1"));
        using (var timeline = JsonDocument.Parse(Aeds.Decode(timelinePacket, (FrameType)225).ToArray()))
        {
            var state = timeline.RootElement;
            Assert.True(state.GetProperty("consistent").GetBoolean());
            Assert.Equal(1, state.GetProperty("currentStatus").GetInt32());
            Assert.Equal(1, state.GetProperty("projectedStatus").GetInt32());
            var events = state.GetProperty("events").EnumerateArray().ToArray();
            Assert.Equal(new[] { "create", "approve", "edit", "approve" },
                events.Select(row => row.GetProperty("eventType").GetString()));
            Assert.Equal(new[] { 1L, 2L, 3L, 4L }, events.Select(row => row.GetProperty("commentVersion").GetInt64()));
            Assert.Equal(moderator.Id, events[1].GetProperty("adminPrincipal").GetGuid());
            Assert.DoesNotContain(editedReply, state.GetRawText());
        }
        await Execute(db, """
            with changed as (
                update public.comment set moderation_status=3,moderation_version=moderation_version+1
                where article_id=1 and id=3 returning *
            )
            insert into public.comment_moderation_log(article_id,comment_id,previous_status,next_status,moderator_db_role,reason)
            select article_id,id,1,moderation_status,current_user,'Recorded offline correction' from changed
            """, ct);
        using (var timeline = JsonDocument.Parse(Aeds.Decode(await History(HttpStatusCode.OK, moderator.Token, timelineRoute),
            (FrameType)225).ToArray()))
        {
            var state = timeline.RootElement;
            Assert.False(state.GetProperty("consistent").GetBoolean());
            Assert.Equal(3, state.GetProperty("currentStatus").GetInt32());
            var last = state.GetProperty("events")[4];
            Assert.Equal("comment_moderation_log", last.GetProperty("transitionSource").GetString());
            Assert.Equal(JsonValueKind.Null, last.GetProperty("commentVersion").ValueKind);
        }
        await Execute(db, """
            with current_reply as (
                select c.article_id,c.id,o.user_id,c.body,c.edited_at,c.moderation_version
                from public.comment c join public.comment_account_owner o on (c.article_id,c.id)=(o.article_id,o.comment_id)
                where (c.article_id,c.id)=(1,3)
            ), added as (
                insert into public.comment_author_edited
                select c.article_id,c.id,c.user_id,c.moderation_version+2*n,c.moderation_version+2*n-1,1,0,
                    prior.body,'Historical edit '||n,pg_catalog.sha256(convert_to(prior.body,'UTF8')),
                    pg_catalog.sha256(convert_to('Historical edit '||n,'UTF8')),c.edited_at+n*interval '1 second'
                from current_reply c cross join generate_series(1,63) n
                cross join lateral (select case when n=1 then c.body else 'Historical edit '||(n-1) end as body) prior
                returning body,happened_at,comment_version
            ), newest as (select * from added order by comment_version desc limit 1)
            update public.comment c set body=n.body,edited_at=n.happened_at,moderation_version=n.comment_version
            from newest n where (c.article_id,c.id)=(1,3)
            """, ct);
        const string replyHistory = "/api/binary/author/comments/3/revisions";
        var firstPage = await History(HttpStatusCode.OK, moderator.Token, replyHistory + "?articleId=1",
            link: $"<{replyHistory}?before=2&articleId=1>; rel=\"next\"");
        Assert.Equal(firstPage, await History(HttpStatusCode.OK, moderator.Token, replyHistory,
            link: $"<{replyHistory}?before=2>; rel=\"next\""));
        using (var history = JsonDocument.Parse(Aeds.Decode(firstPage, FrameType.CommentRevisionList).ToArray()))
        {
            Assert.Equal(64, history.RootElement.GetArrayLength());
            AssertRevision(history.RootElement[0], 65, "edited", "Historical edit 63");
            AssertRevision(history.RootElement[63], 2, "edited", editedReply);
        }
        var finalPage = await History(HttpStatusCode.OK, moderator.Token, replyHistory + "?before=2&articleId=1");
        using (var history = JsonDocument.Parse(Aeds.Decode(finalPage, FrameType.CommentRevisionList).ToArray()))
            Assert.Equal(1, Assert.Single(history.RootElement.EnumerateArray()).GetProperty("version").GetInt32());
        await Execute(db, "update public.admin_principal set generation=generation+1 where id=$1", ct, moderator.Id);
        await History(HttpStatusCode.Unauthorized, moderator.Token);
        await History(HttpStatusCode.Unauthorized, moderator.Token, timelineRoute);

        async Task<byte[]> History(HttpStatusCode expected, string? token, string path = historyRoute, bool adminOrigin = true, string? link = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (adminOrigin) request.Headers.Host = "localhost";
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-admin-session={token}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(link, response.Headers.TryGetValues("Link", out var values) ? Assert.Single(values) : null);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<JsonDocument> AsOwner(string route, FrameType kind, byte[] payload, FrameType expected)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, route.Replace("{id:long}", "1", StringComparison.Ordinal))
                { Content = new ByteArrayContent(Aeds.Encode(kind, payload)) };
            request.Content.Headers.ContentType = new(Aeds.ContentType);
            request.Headers.Add("Cookie", $"fsus-v2-session={ownerToken}");
            request.Headers.Add(WireHeaders.CurrentSession, SiteSessions.Id(owner, ownerDigest));
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return JsonDocument.Parse(Aeds.Decode(await response.Content.ReadAsByteArrayAsync(ct), expected).ToArray());
        }

        async Task RejectDeletedHistory()
        {
            await History(HttpStatusCode.ServiceUnavailable, moderator.Token);
            await History(HttpStatusCode.ServiceUnavailable, moderator.Token, historyRoute + "?before=3&articleId=1");
        }

        async Task<T> Own<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> action)
        {
            await using var conn = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            var result = await action(conn, tx);
            await tx.CommitAsync(ct);
            return result;
        }

        Task<CommentAuthorChallenge> Issue(Identity account, byte[] digest, long id) =>
            Own((conn, tx) => CommentAuthorEdits.Issue(conn, tx, account, digest, id, ct));

        Task<CommentAuthorMutation> Edit(Identity account, byte[] digest, long id, CommentAuthorEditRequest input) =>
            Own((conn, tx) => CommentAuthorEdits.Apply(conn, tx, account, digest, id, input, ct));

        async Task<CommentAuthorMutation?> Attempt()
        {
            try { return await Edit(actor, session, 1, command); }
            catch (BusinessException error) when (error.Rejection == Rejection.NotFound) { return null; }
        }

        async Task Approve(long id)
        {
            var claim = await review.AcquireCommentClaim(moderator.Token, new(1, id), ct);
            var decision = new AdminModerationDecision(1, id, 0, 1, "Review the exact current comment body", claim.CommentVersion,
                claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
            var grant = await SeedDecisionProof(db, moderator, Wire.EncodeAdminModerationDecision(decision), batch: false, ct);
            await review.DecideComment(moderator.Token, grant.Token, decision, ct);
        }
    }

    [PostgresFact]
    public async Task PendingOwnerEditUsesOneCurrentProofAndKeepsTheCommentPrivate()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (rootOwner, outsider) = await SeedBatchReplies(db, 1, ct);
        var owner = await ReadDatabase<Guid>(db, "select user_id from public.comment_account_owner where comment_id=3", ct);
        var ownerSession = await SiteSession(owner);
        var alternateSession = await SiteSession(owner);
        var outsiderSession = await SiteSession(outsider);
        var moderator = await AddModerator(db, "pending-comment-reviewer", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost"
        });

        const string original = "Reply fixture 3";
        const string edited = "Revised pending text with 中文 🧭.";
        var detailRoute = WireRoutes.CommentAuthorEditDetail.Replace("{id:long}", "3", StringComparison.Ordinal) + "?state=pending";
        var challengeRoute = WireRoutes.CommentAuthorChallenge.Replace("{id:long}", "3", StringComparison.Ordinal);
        var editRoute = WireRoutes.CommentAuthorEdit.Replace("{id:long}", "3", StringComparison.Ordinal);
        await Send(HttpMethod.Get, WireRoutes.CommentAuthorEditDetail.Replace("{id:long}", "1", StringComparison.Ordinal) + "?state=pending",
            HttpStatusCode.NotFound, await SiteSession(rootOwner));
        await Send(HttpMethod.Get, detailRoute + "&state=pending", HttpStatusCode.BadRequest, ownerSession);
        await Send(HttpMethod.Get, detailRoute, HttpStatusCode.NotFound, outsiderSession);
        await Send(HttpMethod.Get, detailRoute, HttpStatusCode.Conflict, (ownerSession.Cookie, alternateSession.Handle));
        var detail = Wire.DecodeCommentAuthorEditDetail(await Send(HttpMethod.Get, detailRoute, HttpStatusCode.OK, ownerSession));
        var publication = await ReadDatabase<long>(db, "select publication_id from public.article_publication where article_id=1", ct);
        Assert.Equal(new CommentAuthorEditDetail(1, publication, 1, original), detail);

        var challenge = Aeds.Encode(FrameType.CommentManagementChallengeRequest, """{"purpose":"edit","capabilitySecret":null}"""u8);
        await Send(HttpMethod.Post, challengeRoute, HttpStatusCode.NotFound, outsiderSession, challenge);
        using var grant = JsonDocument.Parse(Aeds.Decode(await Send(HttpMethod.Post, challengeRoute, HttpStatusCode.OK, ownerSession, challenge),
            FrameType.CommentManagementChallengeResponse).ToArray());
        Assert.True(grant.RootElement.GetProperty("issued").GetBoolean());
        Assert.Equal(detail.CurrentVersion, grant.RootElement.GetProperty("currentVersion").GetInt64());
        var proof = grant.RootElement.GetProperty("challenge").GetString();
        byte[] EditFrame(long expectedVersion) => Aeds.Encode(FrameType.CommentAuthorEditRequest,
            JsonSerializer.SerializeToUtf8Bytes(new { expectedVersion, content = edited, challenge = proof }));
        var edit = EditFrame(detail.CurrentVersion);
        await Send(HttpMethod.Post, editRoute, HttpStatusCode.NotFound, outsiderSession, edit);
        await Send(HttpMethod.Post, editRoute, HttpStatusCode.NotFound, alternateSession, edit);
        await Send(HttpMethod.Post, editRoute, HttpStatusCode.Conflict, ownerSession, EditFrame(detail.CurrentVersion + 1));
        using var response = JsonDocument.Parse(Aeds.Decode(await Send(HttpMethod.Post, editRoute, HttpStatusCode.OK, ownerSession, edit),
            FrameType.CommentAuthorMutationResult).ToArray());
        var mutation = response.RootElement;
        Assert.True(mutation.GetProperty("success").GetBoolean());
        Assert.Equal("ok", mutation.GetProperty("code").GetString());
        var version = mutation.GetProperty("currentVersion").GetInt64();
        Assert.Equal(detail.CurrentVersion + 1, version);
        Assert.Equal(0, mutation.GetProperty("moderationStatus").GetInt32());
        await Send(HttpMethod.Post, editRoute, HttpStatusCode.NotFound, ownerSession, edit);
        Assert.Equal(detail with { CurrentVersion = version, Body = edited },
            Wire.DecodeCommentAuthorEditDetail(await Send(HttpMethod.Get, detailRoute, HttpStatusCode.OK, ownerSession)));

        Assert.True(await ReadDatabase<bool>(db, """
            select c.moderation_status=0 and c.moderation_version=$2 and c.body=$3 and not c.deleted
                and c.parent_id=1 and c.root_id=1 and c.reply_to_id=1 and c.depth=1
                and e.user_id=$1 and e.previous_status=0 and e.moderation_status=0 and e.previous_version=$2-1
                and e.comment_version=$2 and e.previous_body=$4 and e.body=$3 and e.happened_at=c.edited_at
                and (select count(*) from public.comment_author_edit_outbox)=1 and o.event_type='CommentEdited'
                and not exists(select from public.comment_author_edit_challenge)
            from public.comment_author_edited e join public.comment_author_edit_outbox o using(article_id,comment_id,comment_version)
            join public.comment c on (c.article_id,c.id)=(e.article_id,e.comment_id)
            where e.article_id=1 and e.comment_id=3
            """, ct, owner, version, edited, original));

        const string history = "/api/binary/author/comments/3";
        await Send(HttpMethod.Get, history + "/revisions?articleId=1", HttpStatusCode.NotFound);
        var administrator = (Cookie: $"fsus-v2-admin-session={moderator.Token}", Handle: (string?)null);
        using var revisions = JsonDocument.Parse(Aeds.Decode(await Send(HttpMethod.Get, history + "/revisions?articleId=1",
            HttpStatusCode.OK, administrator, admin: true), FrameType.CommentRevisionList).ToArray());
        Assert.Collection(revisions.RootElement.EnumerateArray(),
            row => AssertRevision(row, 2, "edited", edited),
            row => AssertRevision(row, 1, "created", original));
        using var timeline = JsonDocument.Parse(Aeds.Decode(await Send(HttpMethod.Get, history + "/moderation-timeline?articleId=1",
            HttpStatusCode.OK, administrator, admin: true), FrameType.CommentModerationTimeline).ToArray());
        var state = timeline.RootElement;
        Assert.True(state.GetProperty("consistent").GetBoolean());
        Assert.False(state.GetProperty("deleted").GetBoolean());
        Assert.Equal(0, state.GetProperty("currentStatus").GetInt32());
        Assert.Equal(0, state.GetProperty("projectedStatus").GetInt32());
        var events = state.GetProperty("events").EnumerateArray().ToArray();
        Assert.Equal(new[] { "create", "edit" }, events.Select(row => row.GetProperty("eventType").GetString()));
        Assert.Equal(new[] { 1L, version }, events.Select(row => row.GetProperty("commentVersion").GetInt64()));
        Assert.Equal(JsonValueKind.Null, events[0].GetProperty("previousStatus").ValueKind);
        Assert.Equal(0, events[1].GetProperty("previousStatus").GetInt32());
        Assert.Equal(0, events[1].GetProperty("nextStatus").GetInt32());
        Assert.Equal("comment_author_edited", events[1].GetProperty("transitionSource").GetString());
        Assert.DoesNotContain(edited, state.GetRawText(), StringComparison.Ordinal);
        var publicRoots = Encoding.UTF8.GetString(await Send(HttpMethod.Get, "/api/binary/comment/1", HttpStatusCode.OK));
        Assert.Contains("Awaiting review", publicRoots, StringComparison.Ordinal);
        Assert.DoesNotContain(original, publicRoots, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, publicRoots, StringComparison.Ordinal);
        Assert.Equal(CommentReadWire.Context(null, [], []),
            await Send(HttpMethod.Get, "/api/binary/comment/1/context/3", HttpStatusCode.OK));

        async Task<(string Cookie, string? Handle)> SiteSession(Guid account)
        {
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            var digest = Store.TokenDigest(token)!;
            await Execute(db, """
                insert into public.user_session(digest,user_id,generation,expires_at) values($1,$2,1,now()+interval '5 minutes')
                """, ct, digest, account);
            return ($"fsus-v2-session={token}", SiteSessions.Id(account, digest));
        }

        async Task<byte[]> Send(HttpMethod method, string path, HttpStatusCode expected,
            (string Cookie, string? Handle)? session = null, byte[]? frame = null, bool admin = false)
        {
            using var request = new HttpRequestMessage(method, path);
            if (admin) request.Headers.Host = "localhost";
            if (session is { } credential)
            {
                request.Headers.Add("Cookie", credential.Cookie);
                if (credential.Handle is not null) request.Headers.Add(WireHeaders.CurrentSession, credential.Handle);
            }
            if (frame is not null)
            {
                request.Content = new ByteArrayContent(frame);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
            }
            using var result = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, result.StatusCode);
            if (admin) Assert.True(result.Headers.CacheControl?.NoStore);
            return await result.Content.ReadAsByteArrayAsync(ct);
        }
    }

    static void AssertRevision(JsonElement row, int version, string operation, string text)
    {
        Assert.Equal(version, row.GetProperty("version").GetInt32());
        Assert.Equal(operation, row.GetProperty("operation").GetString());
        Assert.Equal("public", row.GetProperty("actorMode").GetString());
        Assert.Equal(text, row.GetProperty("content").GetString());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text))), row.GetProperty("contentSha256").GetString());
        Assert.Equal(DateTimeKind.Utc, row.GetProperty("createdAtUtc").GetDateTime().Kind);
    }

    [Fact]
    public void CommentEditWireUsesFrame217AndRejectsAmbiguousVersionsAndAnonymousFields()
    {
        Assert.Equal(217, (int)FrameType.CommentAuthorEditRequest);
        Assert.Equal(33003, (int)FrameType.CommentAuthorEditDetail);
        const string proof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        var decoded = Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":2,"content":"Edit body","challenge":"{{proof}}"}""")));
        Assert.Equal(new(2, "Edit body", proof), decoded);
        var detail = new CommentAuthorEditDetail(3, 5, 7, "Exact body");
        Assert.Equal(detail, Wire.DecodeCommentAuthorEditDetail(Wire.EncodeCommentAuthorEditDetail(detail)));
        Assert.Throws<ProtocolException>(() => Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":"2","content":"Edit body","challenge":"{{proof}}"}"""))));
        Assert.Throws<ProtocolException>(() => Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":2,"content":"Edit body","challenge":"{{proof}}","capabilitySecret":"x"}"""))));
    }
}
