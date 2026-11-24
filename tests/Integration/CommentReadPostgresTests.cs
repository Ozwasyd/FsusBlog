namespace FsusBlog.V2.Integration.Tests;

public sealed class CommentReadPostgresTests
{
    private static readonly Guid AccountId = Guid.Parse("87dead9a-1591-4eae-846c-0192aaeeccca");
    private const long Start = 9007199254740993;
    private const string VisibleBody = "Visible public text 独立";
    private const string VisibleAuthor = "Public Display Name";
    private static readonly string[] PrivateText = ["hidden private", "private author", "pending text", "deleted body", "regional secret", "private article body"];

    [PostgresFact]
    public async Task PublicFramesExposeOnlyApprovedVisibleTextAndBoundedTreeRelations()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await Seed(fixture, ct);
        var read = new CommentReadStore(fixture.DataSource);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var rootFrame = await read.Roots(1, null, 5, ct);
        var roots = Payload(rootFrame, FrameType.CommentTreeRootCursor);
        var hiddenRoot = NextNode(roots, 13) + 4;
        Assert.Equal((2, Start + 13, Start + 1, (byte)1, Start + 2),
            (Read32(roots, 9), Read64(roots, 13), Read64(roots, hiddenRoot), roots[hiddenRoot + 40], Read64(roots, NextNode(roots, hiddenRoot) + 4)));
        Assert.Contains(VisibleBody, Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);
        Assert.Contains(VisibleAuthor, Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);

        var childrenFrame = await read.Children(1, Start + 1, null, 5, ct);
        var children = Payload(childrenFrame, FrameType.CommentChildCursor);
        Assert.Equal((Start + 1, 5, Start + 6, Start + 2, 0L), // A redacted reply target's private ID is omitted.
            (Read64(children, 8), Read32(children, 24), Read64(children, 16), Read64(children, 32), Read64(children, 32 + 24)));
        var next = Payload(await read.Children(1, Start + 1, Start + 6, 5, ct), FrameType.CommentChildCursor);
        Assert.Equal((1, 0L, Start + 7), (Read32(next, 24), Read64(next, 16), Read64(next, 32)));
        var grandchild = Payload(await read.Children(1, Start + 2, null, 5, ct), FrameType.CommentChildCursor);
        Assert.Equal((1, Start + 8), (Read32(grandchild, 24), Read64(grandchild, 32)));

        var contextFrame = await read.Context(1, Start + 3, 2, ct);
        var context = Payload(contextFrame, FrameType.CommentPermalinkContext);
        Assert.Equal((Start + 3, Start + 1, 1, 2, (byte)1, Start + 3), // A hidden ancestor is a redacted structural tombstone.
            (Read64(context, 0), Read64(context, 8), Read32(context, 16), Read32(context, 20), context[32 + 40], Read64(context, NextNode(context, 32))));

        var unavailable = await read.Context(1, Start + 99, 6, ct);
        Assert.Equal(32, Payload(unavailable, FrameType.CommentPermalinkContext).Length);
        foreach (var (article, id) in new[] { (1, Start + 1), (1, Start + 9), (1, Start + 10), (1, Start + 11), (2, Start + 12), (1, Start + 12) })
            Assert.Equal(unavailable, await read.Context(article, id, 6, ct));

        var thread = await read.Thread(1, Start + 1, null, 20, ct);
        Assert.Equal(7, Read32(Payload(thread, FrameType.CommentThreadReplyCursor), 17));
        foreach (var (path, frame) in new[]
        {
            ("/api/binary/comment/1?limit=5", rootFrame),
            ($"/api/binary/comment/1/children/{Start + 1}?limit=5", childrenFrame),
            ($"/api/binary/comment/1/context/{Start + 3}?window=2", contextFrame),
            ($"/api/binary/comment/1/thread/{Start + 1}", thread),
            ($"/api/binary/comment/2/context/{Start + 12}", unavailable),
        })
        {
            using var response = Ok(await server.Client.GetAsync(path, ct));
            Assert.Equal((Aeds.ContentType, true), (response.Content.Headers.ContentType?.MediaType, response.Headers.CacheControl?.NoStore));
            Assert.Equal(frame, await response.Content.ReadAsByteArrayAsync(ct));
        }
        foreach (var frame in new[] { rootFrame, childrenFrame, contextFrame, thread, unavailable })
            foreach (var text in PrivateText)
                Assert.DoesNotContain(text, Encoding.UTF8.GetString(frame), StringComparison.Ordinal);
        Assert.Equal(0, Read32(Payload(await read.Roots(2, null, 10, ct), FrameType.CommentTreeRootCursor), 9));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, (await Assert.ThrowsAsync<PostgresException>(() =>
            fixture.Exec("update public.comment set parent_id=$1, parent_depth=0, root_id=$1, depth=1 where article_id=2", Start + 1))).SqlState);
        await fixture.Exec("update public.article set published_revision=null where id=1");
        Assert.Equal(unavailable, await read.Context(1, Start + 3, 6, ct));
        Assert.Equal(0, Read32(Payload(await read.Roots(1, null, 10, ct), FrameType.CommentTreeRootCursor), 9));
        Assert.Equal(unavailable, await server.Client.GetByteArrayAsync($"/api/binary/comment/1/context/{Start + 3}", ct));
    }

    [PostgresFact]
    public async Task PublicCommentSubmissionRequiresOptInAndDurablyKeepsOrderedConcurrentRetriesPending()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await Seed(fixture, ct);
        var (token, _, _) = await fixture.SiteSessionAsync(AccountId, DateTimeOffset.UtcNow.AddMinutes(5), ct: ct);
        await fixture.Exec("insert into public.comment_public_handle(user_id,display_name) values($1,'Public Handle')", AccountId);
        await fixture.Exec("insert into public.comment_public_write(article_id) values(1)");

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS"] = "true" });
        var input = new PublicCommentSubmission(1, 1, Guid.NewGuid(), true, "Public Handle", "pending submission body");
        foreach (var (status, cmd, auth, key, chal, proof) in new (HttpStatusCode, PublicCommentSubmission, bool, bool, bool, string?)[]
        {
            (Unauthorized, input, false, true, false, null),
            (Unauthorized, input, true, true, false, null),
            (BadRequest, input, true, true, false, "bad!"),
            (Forbidden, input with { Publication = 9000 }, true, true, true, null),
            (Conflict, input with { DisplayName = "Changed public handle" }, true, true, true, null),
            (BadRequest, input, true, false, false, null),
        })
            await CheckStatusAsync(status, Send(cmd, auth, key, chal, proof));
        Assert.Equal("Public Handle", Wire.DecodePublicCommentEligibility(
            await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Get, "/api/v2/comments/eligibility/1.aeds?publication=1", null, token, null, OK, ct)).DisplayName);
        var sameProof = await ObtainProof(input);
        await CheckStatusAsync(Unauthorized, Send(input with { Body = "different body" }, proof: sameProof));
        var (anotherToken, _, _) = await fixture.SiteSessionAsync(AccountId, DateTimeOffset.UtcNow.AddMinutes(5), ct: ct);
        await CheckStatusAsync(Unauthorized, Send(input, proof: sameProof, sessionToken: anotherToken));
        var concurrent = await Task.WhenAll(Send(input, proof: sameProof), Send(input, proof: sameProof));
        using var replayDenied = Assert.Single(concurrent, response => response.StatusCode == Unauthorized);
        var freshProof = await ObtainProof(input);
        var receipts = new[] { Assert.Single(concurrent, response => response.StatusCode == OK), await Send(input, proof: freshProof) }
            .Select(async resp => Wire.DecodePublicCommentSubmissionResult(await OkBytes(Task.FromResult(resp), ct))).ToArray();
        var settled = await Task.WhenAll(receipts);
        Assert.Single(settled, receipt => receipt.Replayed);
        Assert.All(settled, receipt => Assert.Equal(0, receipt.ModerationStatus));
        Assert.Equal(settled[0].CommentId, settled[1].CommentId);
        await CheckStatusAsync(Conflict, Send(input with { Body = "different body" }, challenge: true));
        Assert.DoesNotContain("pending submission body", Encoding.UTF8.GetString(await server.Client.GetByteArrayAsync("/api/binary/comment/1", ct)), StringComparison.Ordinal);
        await fixture.Exec("delete from public.comment_public_write where article_id=1");
        await CheckStatusAsync(Forbidden, Send(input with { IdempotencyKey = Guid.NewGuid() }, challenge: true));
        Assert.True(Wire.DecodePublicCommentSubmissionResult(await OkBytes(Send(input, proof: await ObtainProof(input)), ct)).Replayed);
        Assert.Equal((1L, 3L), (await fixture.Scalar<long>("select count(*) from public.comment_submit_command"),
            await fixture.Scalar<long>("select count(*) from public.scoped_pow_consumed")));

        async Task<string> ObtainProof(PublicCommentSubmission command)
        {
            using var response = Ok(await Send(command, challenge: true));
            Assert.True(response.Headers.CacheControl?.NoStore);
            return PowFixture.SolveFrame(await response.Content.ReadAsByteArrayAsync(ct), ClientNonce, ct);
        }

        async Task<HttpResponseMessage> Send(PublicCommentSubmission command, bool authenticated = true, bool keyHeader = true,
            bool challenge = false, string? proof = null, string? sessionToken = null)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, challenge ? WireRoutes.PublicCommentPowChallenge : WireRoutes.SubmitPublicComment,
                Wire.EncodePublicCommentSubmission(command), authenticated ? sessionToken ?? token : null, handle: null);
            if (keyHeader) request.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            if (challenge) request.Headers.Add(WireHeaders.PowClientNonce, ClientNonce);
            if (proof is not null) request.Headers.Add(WireHeaders.PowProof, proof);
            return await server.Client.SendAsync(request, ct);
        }
    }

    private const string ClientNonce = "61287bbaae554232a936d42a3f59bd05";

    [PostgresFact]
    public async Task ProofChecksBindSourceAndExpireAndRollbackWithItsTransaction()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var clock = new PowTime();
        var authority = new ScopedPow(clock);
        var session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var source = IPAddress.Parse("192.0.2.1");
        var otherSource = IPAddress.Parse("192.0.2.2");
        byte[] frame = [174, 26, 55];
        var challenge = authority.Issue(PowScope.PublicCommentSubmit, "", session, source, ClientNonce, frame);
        var proof = PowWire.ReadProof(PowFixture.Solve(challenge, ClientNonce, ct));

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            foreach (var (scope, res, ip, bytes, p) in new (PowScope, string, IPAddress, byte[], PowProof)[]
            {
                (PowScope.PublicCommentSubmit, "", otherSource, frame, proof),
                (PowScope.InboxCreate, "", source, frame, proof),
                (PowScope.PublicCommentSubmit, "other-resource", source, frame, proof),
                (PowScope.PublicCommentSubmit, "", source, [174, 26, 56], proof),
                (PowScope.PublicCommentSubmit, "", source, frame, proof with { Difficulty = WireLimits.PowChallengeDifficulty - 1 }),
            })
                await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, scope, res, session, ip, bytes, p, ct));
            await Consume(db, tx);
            await tx.RollbackAsync(ct);
        }

        await fixture.InTx(Consume, ct);
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await Assert.ThrowsAsync<ScopedPowFailure>(() => Consume(db, tx));
            clock.Now = clock.Now.AddSeconds(WireLimits.PowChallengeSeconds);
            await Assert.ThrowsAsync<ScopedPowFailure>(() => Consume(db, tx));
        }

        Task Consume(NpgsqlConnection conn, NpgsqlTransaction tx) =>
            authority.Consume(conn, tx, PowScope.PublicCommentSubmit, "", session, source, frame, proof, ct);
    }

    [PostgresFact]
    public async Task RootProofPolicyRejectsUnspentGenerationAfterRollbackToTheSameLifetime()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        var admin = Guid.NewGuid();
        await fixture.AdminPrincipalAsync(admin, "root-proof-operator", ct: ct);
        var clock = new PowTime();
        var authority = new ScopedPow(clock);
        var session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var source = IPAddress.Parse("192.0.2.1");
        byte[] frame = [174, 26, 55];
        var initial = await fixture.InTx((db, tx) => RootCommentPowPolicy.Read(db, tx, ct), ct);
        Assert.Equal(new RootCommentPowPolicy(1, 120), initial);
        var old = Issue(initial);

        await fixture.InTx(async (db, tx) =>
        {
            var shorter = await (await RootCommentPowPolicy.Read(db, tx, ct, update: true)).Activate(db, tx, admin, 60, rollback: false, ct);
            Assert.Equal(2, shorter.Generation);
            Assert.NotEqual(initial.Digest, shorter.Digest);
            var underShorterPolicy = Issue(shorter);
            var previousTime = clock.Now;
            clock.Now = previousTime.AddSeconds(60);
            await Assert.ThrowsAsync<ScopedPowFailure>(() => Consume(db, tx, underShorterPolicy, shorter));
            clock.Now = previousTime;
        }, ct);
        await fixture.InTx(async (db, tx) =>
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct, update: true);
            var previous = await current.PreviousSeconds(db, tx, ct);
            Assert.Equal(120, previous);
            var restored = await current.Activate(db, tx, admin, previous, rollback: true, ct);
            Assert.Equal((new RootCommentPowPolicy(3, 120), initial.Digest), (restored, restored.Digest));
            await Assert.ThrowsAsync<ScopedPowFailure>(() => Consume(db, tx, old, restored));
            await Consume(db, tx, Issue(restored), restored);
        }, ct);
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.scoped_pow_consumed"));

        PowProof Issue(RootCommentPowPolicy policy) =>
            PowWire.ReadProof(PowFixture.Solve(authority.Issue(PowScope.PublicCommentSubmit, "", session, source, ClientNonce, frame, policy), ClientNonce, ct));
        Task Consume(NpgsqlConnection db, NpgsqlTransaction tx, PowProof proof, RootCommentPowPolicy policy) =>
            authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, frame, proof, ct, policy);
    }

    [Fact]
    public void ProofIssuanceCapsPerSessionAndPerTrustedSource()
    {
        var authority = new ScopedPow(new PowTime());
        var first = IPAddress.Parse("192.0.2.1");
        var next = IPAddress.Parse("192.0.2.2");
        for (int i = 0; i < 8; i++) authority.Issue(PowScope.PublicCommentSubmit, "", "session", first, ClientNonce, [1]);
        Assert.Equal(429, Assert.Throws<ScopedPowFailure>(() => authority.Issue(PowScope.PublicCommentSubmit, "", "session", next, ClientNonce, [1])).Status);
        for (int i = 0; i < 16; i++) authority.Issue(PowScope.PublicCommentSubmit, "", i.ToString(), first, ClientNonce, [1]);
        Assert.Equal(429, Assert.Throws<ScopedPowFailure>(() => authority.Issue(PowScope.PublicCommentSubmit, "", "another", first, ClientNonce, [1])).Status);
        Assert.NotNull(authority.Issue(PowScope.PublicCommentSubmit, "", "another", next, ClientNonce, [1]));
    }

    private sealed class PowTime : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static string PublishArticleSql(int id) => $"""
        insert into public.article_publication(article_id,revision,published_at) values ({id},1,now());
        insert into public.article_revision_rights values({id},1,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true);
        insert into public.article_publication_rights (article_id,publication_id,revision)
            select article_id,publication_id,revision from public.article_publication where article_id={id};
        """;

    private static Task Seed(ScratchDatabase fixture, CancellationToken ct) => fixture.InTx(async (db, tx) =>
    {
        await FixtureSql.ExecuteAsync(db, tx, ct, $"""
            insert into public.blog_user(id,name,enabled,generation)
            values ('87dead9a-1591-4eae-846c-0192aaeeccca','comment fixture',true,1);
            insert into public.admin_principal(id,handle,user_handle,enabled,generation)
            values ('87dead9a-1591-4eae-846c-0192aaeeccca','comment-fixture',decode(repeat('11',32),'hex'),true,1);
            insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted)
            overriding system value values
            (1,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'visible article','text',1,1,false),
            (2,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'private article','text',null,0,false);
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            values (1,1,'visible article','text',now()),(2,1,'private article','text',now());
            {PublishArticleSql(1)}
            """);

        await Add(1, 0, null, 0, 0); // Unattached pending root is completely absent.
        await Add(1, 1, null, 1, 3, body: "hidden private", author: "private author");
        for (var index = 2; index <= 7; index++)
            await Add(1, index, 1, 1, 1, replyTo: 1, body: index == 3 ? VisibleBody : "child comment");
        await Add(1, 8, 2, 1, 1, depth: 2, body: "public grandchild");
        await Add(1, 9, 1, 1, 0, body: "pending text");
        await Add(1, 10, 1, 1, 1, deleted: true, body: "deleted body");
        await Add(1, 11, 1, 1, 1, body: "regional secret");
        await Add(2, 12, null, 12, 1, body: "private article body");
        await Add(1, 13, null, 13, 1, body: "public root");
        await FixtureSql.ExecuteAsync(db, tx, ct, "insert into public.comment_blocked_region values (1,$1,'CN')", Start + 11);

        Task Add(int article, int id, int? parent, int root, short status, int depth = 1,
            bool deleted = false, int? replyTo = null, string body = "comment", string author = VisibleAuthor) =>
            FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.comment(article_id,id,parent_id,root_id,parent_depth,reply_to_id,depth,moderation_status,deleted,
                    body,author_mode,display_name,display_language,created_at)
                values ($1,$2,nullif($3,0),$4,nullif($5,-1),nullif($6,0),$7,$8,$9,$10,3,$11,'en',now())
                """, article, Start + id, parent is { } p ? Start + p : 0L, Start + root, parent.HasValue ? depth - 1 : -1,
                replyTo is { } r ? Start + r : 0L, parent.HasValue ? depth : 0, status, deleted, body, author);
    }, ct);

    [PostgresFact]
    public async Task CommentReadEndpointsAdvertiseWriteHeaderOnlyForOpenPublishedArticlesWhenEnabled()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await Seed(fixture, ct);
        await fixture.Exec($"""
            insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted)
            overriding system value values (3,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'closed comments article','text',1,1,false);
            insert into public.article_revision(article_id,revision,title,body,happened_at) values (3,1,'closed comments article','text',now());
            {PublishArticleSql(3)}
            insert into public.comment_public_write(article_id) values (1),(2);
            """);

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            foreach (var (path, advertised) in new[]
            {
                (WireRoutes.CommentRoots.Replace("{articleId:int}", "1", StringComparison.Ordinal), true),
                (WireRoutes.CommentContext.Replace("{articleId:int}", "1", StringComparison.Ordinal).Replace("{commentId:long}", (Start + 13).ToString(), StringComparison.Ordinal), true),
                (WireRoutes.CommentRoots.Replace("{articleId:int}", "3", StringComparison.Ordinal), false),
                (WireRoutes.CommentRoots.Replace("{articleId:int}", "2", StringComparison.Ordinal), false),
            })
            {
                using var response = Ok(await server.Client.GetAsync(path, ct));
                if (advertised) Assert.Equal(["1"], response.Headers.GetValues(WireHeaders.PublicCommentWriteEnabled));
                else Assert.False(response.Headers.Contains(WireHeaders.PublicCommentWriteEnabled));
            }
        }

        await using var disabledServer = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS"] = "false" });
        using var disabledRoots = Ok(await disabledServer.Client.GetAsync(WireRoutes.CommentRoots.Replace("{articleId:int}", "1", StringComparison.Ordinal), ct));
        Assert.False(disabledRoots.Headers.Contains(WireHeaders.PublicCommentWriteEnabled));
    }

    private static byte[] Payload(byte[] body, FrameType type) => Aeds.Decode(body, type).ToArray();
    private static int Read32(byte[] bytes, int offset) => BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset));
    private static long Read64(byte[] bytes, int offset) => BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(offset));
    private static int NextNode(byte[] bytes, int offset) => offset + 64 + Read32(bytes, offset + 60);
}
