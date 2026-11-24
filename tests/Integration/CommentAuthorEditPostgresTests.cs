namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminModerationPostgresTests
{
    [PostgresFact]
    public async Task ApprovedOwnerEditCommitsOneRevisionAndReturnsToReviewWithoutDuplicatingReplyNotice()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (owner, outsider) = await SeedBatchReplies(fixture, 1, ct);
        // The shared reply fixture starts with an approved parent. Start this timeline at submission.
        await fixture.Exec("update public.comment_submit_command set user_id=$1 where article_id=1 and comment_id=1", owner);
        await fixture.Exec("update public.comment set moderation_status=0,moderation_version=1 where article_id=1 and id=1");
        var createdAt = await fixture.Scalar<DateTime>("select created_at from public.comment where article_id=1 and id=1");
        var replyOwner = await fixture.Scalar<Guid>("select user_id from public.comment_account_owner where comment_id=3");
        var actor = new Identity(owner, "Parent author", 1, false, DateTimeOffset.UtcNow.AddMinutes(10));
        var replier = actor with { Id = replyOwner, Name = "Reply author" };
        var (session, otherSession) = (RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(32));
        var moderator = await AddModerator(fixture, "comment-edit-reviewer", ct);
        var (_, review, _, _, _) = CreateStores(fixture);
        var publicRead = new CommentReadStore(fixture.DataSource);
        await Approve(1);
        await Approve(3);
        var delivered = await fixture.Scalar<long>("select message_id from public.comment_reply_notice where reply_id=3");

        var original = await fixture.InTx((conn, tx) => CommentAuthorEdits.Detail(conn, tx, owner, 1, ct), ct);
        Assert.Equal((1, 2L, "Awaiting review"), (original.ArticleId, original.CurrentVersion, original.Body));
        await Denied(Rejection.NotFound, () => fixture.InTx((conn, tx) => CommentAuthorEdits.Detail(conn, tx, outsider, 1, ct), ct));
        await fixture.Exec("insert into public.comment_blocked_region values(1,1,'ZZ')");
        await Denied(Rejection.NotFound, () => Issue(actor, session, 1));
        await fixture.Exec("delete from public.comment_blocked_region where article_id=1 and comment_id=1");
        await fixture.Exec("update public.comment set created_at=clock_timestamp()-interval '31 minutes' where article_id=1 and id=1");
        await Denied(Rejection.NotFound, () => fixture.InTx((conn, tx) => CommentAuthorEdits.Detail(conn, tx, owner, 1, ct), ct));
        await fixture.Exec("update public.comment set created_at=$1 where article_id=1 and id=1", createdAt);

        const string edited = "Revised root text for a second review.";
        var expired = await Issue(actor, session, 1);
        await fixture.Exec("update public.comment_author_edit_challenge set expires_at=clock_timestamp()-interval '1 second'");
        await Denied(Rejection.NotFound, () => Edit(actor, session, 1, new(expired.CurrentVersion, edited, expired.Challenge)));
        var mismatch = await Issue(actor, session, 1);
        await fixture.Exec("update public.comment_author_edit_challenge set publication_id=publication_id+1");
        await Denied(Rejection.Conflict, () => Edit(actor, session, 1, new(mismatch.CurrentVersion, edited, mismatch.Challenge)));

        var proof = await Issue(actor, session, 1);
        var command = new CommentAuthorEditRequest(proof.CurrentVersion, $"  {edited}  ", proof.Challenge);
        Assert.Equal(original.CurrentVersion, proof.CurrentVersion);
        foreach (var (rejection, testActor, testSession, testCmd) in new[]
        {
            (Rejection.NotFound, actor, otherSession, command),
            (Rejection.NotFound, actor with { Generation = 2 }, session, command),
            (Rejection.Conflict, actor, session, command with { ExpectedVersion = command.ExpectedVersion + 1 }),
            (Rejection.Invalid, actor, session, command with { Content = original.Body }),
        })
            await Denied(rejection, () => Edit(testActor, testSession, 1, testCmd));

        await fixture.Exec("alter table public.comment_author_edit_outbox add constraint fixture_refuse_edit check (false)");
        var failed = await Assert.ThrowsAsync<PostgresException>(() => Edit(actor, session, 1, command));
        Assert.Equal((PostgresErrorCodes.CheckViolation, "fixture_refuse_edit"), (failed.SqlState, failed.ConstraintName));
        Assert.True(await fixture.Scalar<bool>("""
            select c.body=$1 and c.moderation_version=2 and c.moderation_status=1 and c.edited_at is null
                and (select count(*) from public.comment_author_edit_challenge)=1
                and not exists(select from public.comment_author_edited)
                and not exists(select from public.comment_author_edit_outbox)
            from public.comment c where c.article_id=1 and c.id=1
            """, original.Body));
        await fixture.Exec("alter table public.comment_author_edit_outbox drop constraint fixture_refuse_edit");

        var outcomes = await Task.WhenAll(Attempt(), Attempt());
        var receipt = Assert.Single(outcomes.OfType<CommentAuthorMutation>());
        Assert.Single(outcomes, result => result is null);
        Assert.Equal((true, "ok", original.CurrentVersion + 1, 0),
            (receipt.Success, receipt.Code, receipt.CurrentVersion, receipt.ModerationStatus));
        Assert.True(receipt.EditedAtUtc.HasValue);
        Assert.True(await fixture.Scalar<bool>("""
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
            """, owner, original.Body, edited));

        var pending = Encoding.UTF8.GetString(await publicRead.Roots(1, null, 10, ct));
        Assert.Contains("Reply fixture 3", pending, StringComparison.Ordinal);
        foreach (var hidden in new[] { "Fixture writer", original.Body, edited })
            Assert.DoesNotContain(hidden, pending, StringComparison.Ordinal);
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
        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.comment_reply_notice where reply_id=3 and message_id=$1)=1
                and (select count(*) from public.inbox_message)=1
                and exists(select from public.comment where article_id=1 and id=3 and root_id=1 and parent_id=1
                    and reply_to_id=1 and parent_depth=0 and depth=1 and not deleted and edited_at is not null)
            """, delivered));

        var siteUser = await fixture.SignInSiteUser("comment-history-site-user", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, AdminOriginSettings);
        const string historyRoute = "/api/binary/author/comments/1/revisions";
        foreach (var (status, token, path, adminOrigin) in new (HttpStatusCode, string?, string, bool)[]
        {
            (NotFound, moderator.Token, historyRoute, false),
            (Unauthorized, null, historyRoute, true),
            (Unauthorized, siteUser.Token, historyRoute, true),
            (BadRequest, moderator.Token, historyRoute + "?before=2&before=3", true),
            (BadRequest, moderator.Token, historyRoute + "?articleId=1&articleId=2", true),
            (NotFound, moderator.Token, historyRoute + "?articleId=2", true),
        })
            await History(status, token, path, adminOrigin);
        using (var history = DecodeJson(await History(OK, moderator.Token), FrameType.CommentRevisionList))
            Assert.Collection(history.RootElement.EnumerateArray(),
                row => AssertRevision(row, 2, "edited", edited),
                row => AssertRevision(row, 1, "created", original.Body));
        using (var page = DecodeJson(await History(OK, moderator.Token, historyRoute + "?before=2"), FrameType.CommentRevisionList))
            AssertRevision(Assert.Single(page.RootElement.EnumerateArray()), 1, "created", original.Body);
        await fixture.Exec("update public.comment_author_edited set body_digest=decode(repeat('00',32),'hex') where comment_id=1");
        await History(ServiceUnavailable, moderator.Token);
        await fixture.Exec("update public.comment_author_edited set body_digest=pg_catalog.sha256(convert_to(body,'UTF8')) where comment_id=1");
        var (ownerToken, ownerHandle, _) = await fixture.SiteSessionAsync(owner, DateTimeOffset.UtcNow.AddMinutes(5), ct: ct);
        using var deleteGrant = await AsOwner(WireRoutes.CommentAuthorChallenge, FrameType.CommentManagementChallengeRequest,
            """{"purpose":"delete","capabilitySecret":null}"""u8.ToArray(), FrameType.CommentManagementChallengeResponse);
        var approvedVersion = deleteGrant.RootElement.GetProperty("currentVersion").GetInt64();
        Assert.Equal((true, receipt.CurrentVersion + 1), (deleteGrant.RootElement.GetProperty("issued").GetBoolean(), approvedVersion));
        var deleteCommand = JsonSerializer.SerializeToUtf8Bytes(new
        {
            challenge = deleteGrant.RootElement.GetProperty("challenge").GetString(), capabilitySecret = ""
        });
        using var deletion = await AsOwner(WireRoutes.CommentAuthorDelete, FrameType.CommentAuthorStatusRequest,
            deleteCommand, FrameType.CommentAuthorMutationResult);
        var result = deletion.RootElement;
        var deletedVersion = result.GetProperty("currentVersion").GetInt64();
        Assert.Equal((true, "ok", approvedVersion + 1, 1, receipt.EditedAtUtc),
            (result.GetProperty("success").GetBoolean(), result.GetProperty("code").GetString(), deletedVersion,
                result.GetProperty("moderationStatus").GetInt32(), (DateTime?)result.GetProperty("editedAtUtc").GetDateTime()));
        Assert.True(await fixture.Scalar<bool>("""
            select c.deleted and c.body=$3 and c.moderation_version=$2 and c.moderation_status=1
                and d.user_id=$1 and d.comment_version=$2 and d.moderation_status=c.moderation_status
                and d.body_digest=pg_catalog.sha256(convert_to(c.body,'UTF8')) and d.happened_at>=c.edited_at
                and o.event_type='CommentDeleted' and not exists(select from public.comment_author_delete_challenge)
            from public.comment c join public.comment_author_deleted d on (d.article_id,d.comment_id)=(c.article_id,c.id)
            join public.comment_author_delete_outbox o on (o.article_id,o.comment_id)=(d.article_id,d.comment_id)
            where c.article_id=1 and c.id=1
            """, owner, deletedVersion, edited));

        const string rootTimeline = "/api/binary/author/comments/1/moderation-timeline?articleId=1";
        using (var timeline = DecodeJson(await History(OK, moderator.Token, rootTimeline), FrameType.CommentModerationTimeline))
        {
            var events = AssertTimeline(timeline.RootElement, 1, ["create", "approve", "edit", "approve", "delete"],
                [1, 2, 3, 4, deletedVersion], deleted: true, forbidden: edited);
            Assert.Equal((1, 1, "comment_author_deleted"), (events[^1].GetProperty("previousStatus").GetInt32(),
                events[^1].GetProperty("nextStatus").GetInt32(), events[^1].GetProperty("transitionSource").GetString()));
        }
        using (var history = DecodeJson(await History(OK, moderator.Token, historyRoute + "?articleId=1"), FrameType.CommentRevisionList))
            Assert.Collection(history.RootElement.EnumerateArray(),
                row => AssertRevision(row, 3, "deleted", edited),
                row => AssertRevision(row, 2, "edited", edited),
                row => AssertRevision(row, 1, "created", original.Body));
        var deletedTree = Encoding.UTF8.GetString(await server.Client.GetByteArrayAsync("/api/binary/comment/1", ct));
        Assert.Contains("已删除评论", deletedTree, StringComparison.Ordinal);
        Assert.Contains(editedReply, deletedTree, StringComparison.Ordinal);
        foreach (var hidden in new[] { edited, original.Body, "Fixture writer" })
            Assert.DoesNotContain(hidden, deletedTree, StringComparison.Ordinal);
        Assert.Equal(CommentReadWire.Context(null, [], []), await server.Client.GetByteArrayAsync("/api/binary/comment/1/context/1", ct));

        await fixture.Exec("update public.comment_author_deleted set comment_version=comment_version+1 where article_id=1 and comment_id=1");
        await RejectDeletedHistory();
        await fixture.Exec("update public.comment_author_deleted set comment_version=$1 where article_id=1 and comment_id=1", deletedVersion);
        await fixture.Exec("delete from public.comment_author_delete_outbox where article_id=1 and comment_id=1");
        await RejectDeletedHistory();
        await fixture.Exec("insert into public.comment_author_delete_outbox values(1,1,'CommentDeleted')");
        await History(OK, moderator.Token, historyRoute + "?before=3&articleId=1");

        const string timelineRoute = "/api/binary/author/comments/3/moderation-timeline";
        await History(NotFound, moderator.Token, timelineRoute, adminOrigin: false);
        await History(Unauthorized, siteUser.Token, timelineRoute);
        await History(NotFound, moderator.Token, timelineRoute + "?articleId=2");
        var timelinePacket = await History(OK, moderator.Token, timelineRoute);
        Assert.Equal(timelinePacket, await History(OK, moderator.Token, timelineRoute + "?articleId=1"));
        using (var timeline = DecodeJson(timelinePacket, FrameType.CommentModerationTimeline))
        {
            var events = AssertTimeline(timeline.RootElement, 1, ["create", "approve", "edit", "approve"], [1, 2, 3, 4], forbidden: editedReply);
            Assert.Equal(moderator.Id, events[1].GetProperty("adminPrincipal").GetGuid());
        }
        await fixture.Exec("""
            with changed as (
                update public.comment set moderation_status=3,moderation_version=moderation_version+1
                where article_id=1 and id=3 returning *
            )
            insert into public.comment_moderation_log(article_id,comment_id,previous_status,next_status,moderator_db_role,reason)
            select article_id,id,1,moderation_status,current_user,'Recorded offline correction' from changed
            """);
        using (var timeline = DecodeJson(await History(OK, moderator.Token, timelineRoute), FrameType.CommentModerationTimeline))
        {
            var state = timeline.RootElement;
            var last = state.GetProperty("events")[4];
            Assert.Equal((false, 3, "comment_moderation_log", JsonValueKind.Null), (state.GetProperty("consistent").GetBoolean(),
                state.GetProperty("currentStatus").GetInt32(), last.GetProperty("transitionSource").GetString(), last.GetProperty("commentVersion").ValueKind));
        }
        await fixture.Exec("""
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
            """);
        const string replyHistory = "/api/binary/author/comments/3/revisions";
        var firstPage = await History(OK, moderator.Token, replyHistory + "?articleId=1", link: $"<{replyHistory}?before=2&articleId=1>; rel=\"next\"");
        Assert.Equal(firstPage, await History(OK, moderator.Token, replyHistory, link: $"<{replyHistory}?before=2>; rel=\"next\""));
        using (var history = DecodeJson(firstPage, FrameType.CommentRevisionList))
        {
            Assert.Equal(64, history.RootElement.GetArrayLength());
            AssertRevision(history.RootElement[0], 65, "edited", "Historical edit 63");
            AssertRevision(history.RootElement[63], 2, "edited", editedReply);
        }
        using (var history = DecodeJson(await History(OK, moderator.Token, replyHistory + "?before=2&articleId=1"), FrameType.CommentRevisionList))
            Assert.Equal(1, Assert.Single(history.RootElement.EnumerateArray()).GetProperty("version").GetInt32());
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", moderator.Id);
        await History(Unauthorized, moderator.Token);
        await History(Unauthorized, moderator.Token, timelineRoute);

        async Task<byte[]> History(HttpStatusCode expected, string? token, string path = historyRoute, bool adminOrigin = true, string? link = null)
        {
            using var response = Expect(expected, await SiteAedsFixture.AdminSend(server.Client, HttpMethod.Get, path, token, ct,
                configure: adminOrigin ? null : req => req.Headers.Host = null));
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(link, response.Headers.TryGetValues("Link", out var values) ? Assert.Single(values) : null);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<JsonDocument> AsOwner(string route, FrameType kind, byte[] payload, FrameType expected) =>
            DecodeJson(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, route.Replace("{id:long}", "1", StringComparison.Ordinal),
                Aeds.Encode(kind, payload), ownerToken, ownerHandle, OK, ct), expected);

        async Task RejectDeletedHistory()
        {
            await History(ServiceUnavailable, moderator.Token);
            await History(ServiceUnavailable, moderator.Token, historyRoute + "?before=3&articleId=1");
        }

        Task<CommentAuthorChallenge> Issue(Identity account, byte[] digest, long id) =>
            fixture.InTx((conn, tx) => CommentAuthorEdits.Issue(conn, tx, account, digest, id, ct), ct);

        Task<CommentAuthorMutation> Edit(Identity account, byte[] digest, long id, CommentAuthorEditRequest input) =>
            fixture.InTx((conn, tx) => CommentAuthorEdits.Apply(conn, tx, account, digest, id, input, ct), ct);

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
            var grant = await SeedDecisionProof(fixture, moderator, Wire.EncodeAdminModerationDecision(decision), batch: false, ct);
            await review.DecideComment(moderator.Token, grant.Token, decision, ct);
        }
    }

    [PostgresFact]
    public async Task PendingOwnerEditUsesOneCurrentProofAndKeepsTheCommentPrivate()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (rootOwner, outsider) = await SeedBatchReplies(fixture, 1, ct);
        var owner = await fixture.Scalar<Guid>("select user_id from public.comment_account_owner where comment_id=3");
        var ownerSession = await SiteSession(owner);
        var alternateSession = await SiteSession(owner);
        var outsiderSession = await SiteSession(outsider);
        var moderator = await AddModerator(fixture, "pending-comment-reviewer", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, AdminOriginSettings);

        const string original = "Reply fixture 3";
        const string edited = "Revised pending text with 中文 🧭.";
        var detailRoute = WireRoutes.CommentAuthorEditDetail.Replace("{id:long}", "3", StringComparison.Ordinal) + "?state=pending";
        var challengeRoute = WireRoutes.CommentAuthorChallenge.Replace("{id:long}", "3", StringComparison.Ordinal);
        var editRoute = WireRoutes.CommentAuthorEdit.Replace("{id:long}", "3", StringComparison.Ordinal);
        foreach (var (path, status, session) in new (string, HttpStatusCode, (string Token, string? Handle))[]
        {
            (WireRoutes.CommentAuthorEditDetail.Replace("{id:long}", "1", StringComparison.Ordinal) + "?state=pending", NotFound, await SiteSession(rootOwner)),
            (detailRoute + "&state=pending", BadRequest, ownerSession),
            (detailRoute, NotFound, outsiderSession),
            (detailRoute, Conflict, (ownerSession.Token, alternateSession.Handle)),
        })
            await Send(HttpMethod.Get, path, status, session);
        var detail = Wire.DecodeCommentAuthorEditDetail(await Send(HttpMethod.Get, detailRoute, OK, ownerSession));
        var publication = await fixture.Scalar<long>("select publication_id from public.article_publication where article_id=1");
        Assert.Equal(new CommentAuthorEditDetail(1, publication, 1, original), detail);

        var challenge = Aeds.Encode(FrameType.CommentManagementChallengeRequest, """{"purpose":"edit","capabilitySecret":null}"""u8);
        await Send(HttpMethod.Post, challengeRoute, NotFound, outsiderSession, challenge);
        using var grant = DecodeJson(await Send(HttpMethod.Post, challengeRoute, OK, ownerSession, challenge), FrameType.CommentManagementChallengeResponse);
        Assert.Equal((true, detail.CurrentVersion), (grant.RootElement.GetProperty("issued").GetBoolean(), grant.RootElement.GetProperty("currentVersion").GetInt64()));
        var proof = grant.RootElement.GetProperty("challenge").GetString();
        byte[] EditFrame(long expectedVersion) => Aeds.Encode(FrameType.CommentAuthorEditRequest,
            JsonSerializer.SerializeToUtf8Bytes(new { expectedVersion, content = edited, challenge = proof }));
        var edit = EditFrame(detail.CurrentVersion);
        foreach (var (status, session, frame) in new[]
        {
            (NotFound, outsiderSession, edit),
            (NotFound, alternateSession, edit),
            (Conflict, ownerSession, EditFrame(detail.CurrentVersion + 1)),
        })
            await Send(HttpMethod.Post, editRoute, status, session, frame);
        using var response = DecodeJson(await Send(HttpMethod.Post, editRoute, OK, ownerSession, edit), FrameType.CommentAuthorMutationResult);
        var mutation = response.RootElement;
        var version = mutation.GetProperty("currentVersion").GetInt64();
        Assert.Equal((true, "ok", detail.CurrentVersion + 1, 0),
            (mutation.GetProperty("success").GetBoolean(), mutation.GetProperty("code").GetString(), version, mutation.GetProperty("moderationStatus").GetInt32()));
        await Send(HttpMethod.Post, editRoute, NotFound, ownerSession, edit);
        Assert.Equal(detail with { CurrentVersion = version, Body = edited },
            Wire.DecodeCommentAuthorEditDetail(await Send(HttpMethod.Get, detailRoute, OK, ownerSession)));

        Assert.True(await fixture.Scalar<bool>("""
            select c.moderation_status=0 and c.moderation_version=$2 and c.body=$3 and not c.deleted
                and c.parent_id=1 and c.root_id=1 and c.reply_to_id=1 and c.depth=1
                and e.user_id=$1 and e.previous_status=0 and e.moderation_status=0 and e.previous_version=$2-1
                and e.comment_version=$2 and e.previous_body=$4 and e.body=$3 and e.happened_at=c.edited_at
                and (select count(*) from public.comment_author_edit_outbox)=1 and o.event_type='CommentEdited'
                and not exists(select from public.comment_author_edit_challenge)
            from public.comment_author_edited e join public.comment_author_edit_outbox o using(article_id,comment_id,comment_version)
            join public.comment c on (c.article_id,c.id)=(e.article_id,e.comment_id)
            where e.article_id=1 and e.comment_id=3
            """, owner, version, edited, original));

        const string history = "/api/binary/author/comments/3";
        await SiteAedsFixture.AdminStatus(server.Client, HttpMethod.Get, history + "/revisions?articleId=1", null, ct, NotFound,
            configure: req => req.Headers.Host = null);
        using var revisions = DecodeJson(await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Get, history + "/revisions?articleId=1", moderator.Token, ct),
            FrameType.CommentRevisionList);
        Assert.Collection(revisions.RootElement.EnumerateArray(),
            row => AssertRevision(row, 2, "edited", edited),
            row => AssertRevision(row, 1, "created", original));
        using var timeline = DecodeJson(await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Get, history + "/moderation-timeline?articleId=1", moderator.Token, ct),
            FrameType.CommentModerationTimeline);
        var events = AssertTimeline(timeline.RootElement, 0, ["create", "edit"], [1, version], deleted: false, forbidden: edited);
        Assert.Equal((JsonValueKind.Null, 0, 0, "comment_author_edited"), (events[0].GetProperty("previousStatus").ValueKind,
            events[1].GetProperty("previousStatus").GetInt32(), events[1].GetProperty("nextStatus").GetInt32(), events[1].GetProperty("transitionSource").GetString()));
        var publicRoots = Encoding.UTF8.GetString(await Send(HttpMethod.Get, "/api/binary/comment/1", OK));
        Assert.Contains("Awaiting review", publicRoots, StringComparison.Ordinal);
        Assert.DoesNotContain(original, publicRoots, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, publicRoots, StringComparison.Ordinal);
        Assert.Equal(CommentReadWire.Context(null, [], []), await Send(HttpMethod.Get, "/api/binary/comment/1/context/3", OK));

        async Task<(string Token, string? Handle)> SiteSession(Guid account)
        {
            var (sessionToken, sessionId, _) = await fixture.SiteSessionAsync(account, DateTimeOffset.UtcNow.AddMinutes(5), ct: ct);
            return (sessionToken, sessionId);
        }

        Task<byte[]> Send(HttpMethod method, string path, HttpStatusCode expected, (string Token, string? Handle)? session = null, byte[]? frame = null) =>
            SiteAedsFixture.ExpectStatus(server.Client, method, path, frame, session?.Token, session?.Handle, expected, ct);
    }

    private static JsonDocument DecodeJson(byte[] frame, FrameType kind) => JsonDocument.Parse(Aeds.Decode(frame, kind).ToArray());

    private static JsonElement[] AssertTimeline(JsonElement state, int status, string[] eventTypes,
        long[]? versions = null, bool? deleted = null, string? forbidden = null)
    {
        Assert.Equal((true, status, status), (state.GetProperty("consistent").GetBoolean(),
            state.GetProperty("currentStatus").GetInt32(), state.GetProperty("projectedStatus").GetInt32()));
        if (deleted is bool expectedDeleted) Assert.Equal(expectedDeleted, state.GetProperty("deleted").GetBoolean());
        var events = state.GetProperty("events").EnumerateArray().ToArray();
        Assert.Equal(eventTypes, events.Select(row => row.GetProperty("eventType").GetString()));
        if (versions is not null) Assert.Equal(versions, events.Select(row => row.GetProperty("commentVersion").GetInt64()));
        if (forbidden is not null) Assert.DoesNotContain(forbidden, state.GetRawText(), StringComparison.Ordinal);
        return events;
    }

    private static void AssertRevision(JsonElement row, int version, string operation, string text) =>
        Assert.Equal((version, operation, "public", text, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text))), DateTimeKind.Utc),
            (row.GetProperty("version").GetInt32(), row.GetProperty("operation").GetString(), row.GetProperty("actorMode").GetString(),
                row.GetProperty("content").GetString(), row.GetProperty("contentSha256").GetString(), row.GetProperty("createdAtUtc").GetDateTime().Kind));

    [Fact]
    public void CommentEditWireUsesFrame217AndRejectsAmbiguousVersionsAndAnonymousFields()
    {
        Assert.Equal((217, 33003), ((int)FrameType.CommentAuthorEditRequest, (int)FrameType.CommentAuthorEditDetail));
        const string proof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        var decoded = Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":2,"content":"Edit body","challenge":"{{proof}}"}""")));
        Assert.Equal(new(2, "Edit body", proof), decoded);
        var detail = new CommentAuthorEditDetail(3, 5, 7, "Exact body");
        Assert.Equal(detail, Wire.DecodeCommentAuthorEditDetail(Wire.EncodeCommentAuthorEditDetail(detail)));
        foreach (var bad in new[]
        {
            $$"""{"expectedVersion":"2","content":"Edit body","challenge":"{{proof}}"}""",
            $$"""{"expectedVersion":2,"content":"Edit body","challenge":"{{proof}}","capabilitySecret":"x"}""",
        })
            Assert.Throws<ProtocolException>(() => Wire.DecodeCommentAuthorEditRequest(
                Aeds.Encode(FrameType.CommentAuthorEditRequest, Encoding.UTF8.GetBytes(bad))));
    }
}
