using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Security;
using Npgsql;

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
        using var time = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = time.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await Seed(fixture, ct);
        var read = new CommentReadStore(fixture.DataSource);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var rootFrame = await read.Roots(1, null, 5, ct);
        var roots = Payload(rootFrame, FrameType.CommentTreeRootCursor);
        Assert.Equal(2, Read32(roots, 9));
        Assert.Equal(Start + 13, Read64(roots, 13));
        var hiddenRoot = NextNode(roots, 13) + 4;
        Assert.Equal(Start + 1, Read64(roots, hiddenRoot));
        Assert.Equal(1, roots[hiddenRoot + 40]);
        Assert.Equal(Start + 2, Read64(roots, NextNode(roots, hiddenRoot) + 4));
        Assert.Contains(VisibleBody, Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);
        Assert.Contains(VisibleAuthor, Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);

        var childrenFrame = await read.Children(1, Start + 1, null, 5, ct);
        var children = Payload(childrenFrame, FrameType.CommentChildCursor);
        Assert.Equal(Start + 1, Read64(children, 8));
        Assert.Equal(5, Read32(children, 24));
        Assert.Equal(Start + 6, Read64(children, 16));
        Assert.Equal(Start + 2, Read64(children, 32));
        Assert.Equal(0, Read64(children, 32 + 24)); // A redacted reply target's private ID is omitted.
        var next = Payload(await read.Children(1, Start + 1, Start + 6, 5, ct), FrameType.CommentChildCursor);
        Assert.Equal(1, Read32(next, 24));
        Assert.Equal(0, Read64(next, 16));
        Assert.Equal(Start + 7, Read64(next, 32));
        var grandchild = Payload(await read.Children(1, Start + 2, null, 5, ct), FrameType.CommentChildCursor);
        Assert.Equal(1, Read32(grandchild, 24));
        Assert.Equal(Start + 8, Read64(grandchild, 32));

        var contextFrame = await read.Context(1, Start + 3, 2, ct);
        var context = Payload(contextFrame, FrameType.CommentPermalinkContext);
        Assert.Equal(Start + 3, Read64(context, 0));
        Assert.Equal(Start + 1, Read64(context, 8));
        Assert.Equal(1, Read32(context, 16));
        Assert.Equal(2, Read32(context, 20));
        Assert.Equal(1, context[32 + 40]); // A hidden ancestor is a redacted structural tombstone.
        Assert.Equal(Start + 3, Read64(context, NextNode(context, 32)));

        var unavailable = await read.Context(1, Start + 99, 6, ct);
        Assert.Equal(32, Payload(unavailable, FrameType.CommentPermalinkContext).Length);
        foreach (var id in new[] { Start + 1, Start + 9, Start + 10, Start + 11 })
            Assert.Equal(unavailable, await read.Context(1, id, 6, ct));
        Assert.Equal(unavailable, await read.Context(2, Start + 12, 6, ct));
        Assert.Equal(unavailable, await read.Context(1, Start + 12, 6, ct));

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
            using var response = await server.Client.GetAsync(path, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(frame, await response.Content.ReadAsByteArrayAsync(ct));
        }
        foreach (var frame in new[] { rootFrame, childrenFrame, contextFrame, thread, unavailable })
            foreach (var text in PrivateText)
                Assert.DoesNotContain(text, Encoding.UTF8.GetString(frame), StringComparison.Ordinal);
        var noPublic = Payload(await read.Roots(2, null, 10, ct), FrameType.CommentTreeRootCursor);
        Assert.Equal(0, Read32(noPublic, 9));

        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var crossArticle = Store.Sql(connection, null,
            "update public.comment set parent_id=$1, parent_depth=0, root_id=$1, depth=1 where article_id=2",
            Start + 1))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => crossArticle.ExecuteNonQueryAsync(ct));
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
        }
        await FixtureSql.ExecuteAsync(connection, null, ct, "update public.article set published_revision=null where id=1");
        Assert.Equal(unavailable, await read.Context(1, Start + 3, 6, ct));
        Assert.Equal(0, Read32(Payload(await read.Roots(1, null, 10, ct), FrameType.CommentTreeRootCursor), 9));
        Assert.Equal(unavailable, await server.Client.GetByteArrayAsync($"/api/binary/comment/1/context/{Start + 3}", ct));
    }

    [PostgresFact]
    public async Task PublicCommentSubmissionRequiresOptInAndDurablyKeepsOrderedConcurrentRetriesPending()
    {
        using var time = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = time.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await Seed(fixture, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var token = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            with session as (
                insert into public.user_session(digest,user_id,generation,expires_at)
                values($1,$2,1,now()+interval '5 minutes')
            ), handle as (
                insert into public.comment_public_handle(user_id,display_name) values($2,'Public Handle')
            )
            insert into public.comment_public_write(article_id) values(1)
            """, Store.TokenDigest(token)!, AccountId);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS"] = "true" });
        var input = new PublicCommentSubmission(1, 1, Guid.NewGuid(), true, "Public Handle", "pending submission body");
        using (var unauthenticated = await Send(input, authenticated: false))
            Assert.Equal(HttpStatusCode.Unauthorized, unauthenticated.StatusCode);
        using (var missing = await Send(input))
            Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);
        using (var invalid = await Send(input, proof: "bad!"))
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using (var stale = await Send(input with { Publication = 9000 }, challenge: true))
            Assert.Equal(HttpStatusCode.Forbidden, stale.StatusCode);
        using (var mismatch = await Send(input with { DisplayName = "Changed public handle" }, challenge: true))
            Assert.Equal(HttpStatusCode.Conflict, mismatch.StatusCode);
        using (var missingHeader = await Send(input, keyHeader: false))
            Assert.Equal(HttpStatusCode.BadRequest, missingHeader.StatusCode);
        using (var request = new HttpRequestMessage(HttpMethod.Get, "/api/v2/comments/eligibility/1.aeds?publication=1"))
        {
            request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var eligible = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, eligible.StatusCode);
            Assert.Equal("Public Handle", Wire.DecodePublicCommentEligibility(await eligible.Content.ReadAsByteArrayAsync(ct)).DisplayName);
        }
        var sameProof = await ObtainProof(input);
        using (var changed = await Send(input with { Body = "different body" }, proof: sameProof))
            Assert.Equal(HttpStatusCode.Unauthorized, changed.StatusCode);
        var anotherToken = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at)
            values($1,$2,1,now()+interval '5 minutes')
            """, Store.TokenDigest(anotherToken)!, AccountId);
        using (var wrongSession = await Send(input, proof: sameProof, sessionToken: anotherToken))
            Assert.Equal(HttpStatusCode.Unauthorized, wrongSession.StatusCode);
        var concurrent = await Task.WhenAll(Send(input, proof: sameProof), Send(input, proof: sameProof));
        Assert.Single(concurrent, response => response.StatusCode == HttpStatusCode.Unauthorized);
        using var replayDenied = concurrent.Single(response => response.StatusCode == HttpStatusCode.Unauthorized);
        var freshProof = await ObtainProof(input);
        var results = new[] { concurrent.Single(response => response.StatusCode == HttpStatusCode.OK), await Send(input, proof: freshProof) };
        var receipts = new List<PublicCommentSubmissionResult>();
        foreach (var response in results)
        {
            using (response)
            {
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                receipts.Add(Wire.DecodePublicCommentSubmissionResult(await response.Content.ReadAsByteArrayAsync(ct)));
            }
        }
        Assert.Single(receipts, receipt => receipt.Replayed);
        Assert.All(receipts, receipt => Assert.Equal(0, receipt.ModerationStatus));
        Assert.Equal(receipts[0].CommentId, receipts[1].CommentId);
        using (var conflict = await Send(input with { Body = "different body" }, challenge: true))
            Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var rootFrame = await server.Client.GetByteArrayAsync("/api/binary/comment/1", ct);
        Assert.DoesNotContain("pending submission body", Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);
        await FixtureSql.ExecuteAsync(db, null, ct, "delete from public.comment_public_write where article_id=1");
        using (var policyClosed = await Send(input with { IdempotencyKey = Guid.NewGuid() }, challenge: true))
            Assert.Equal(HttpStatusCode.Forbidden, policyClosed.StatusCode);
        using (var lateRetry = await Send(input, proof: await ObtainProof(input)))
            Assert.True(Wire.DecodePublicCommentSubmissionResult(await lateRetry.Content.ReadAsByteArrayAsync(ct)).Replayed);
        Assert.Equal(1L, await FixtureSql.ScalarAsync(db, null, ct, "select count(*) from public.comment_submit_command"));
        Assert.Equal(3L, await FixtureSql.ScalarAsync(db, null, ct, "select count(*) from public.scoped_pow_consumed"));

        async Task<string> ObtainProof(PublicCommentSubmission command)
        {
            using var response = await Send(command, challenge: true);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            var challenge = Payload(await response.Content.ReadAsByteArrayAsync(ct), FrameType.PowChallenge);
            var salt = Encoding.UTF8.GetString(challenge.AsSpan(0, 64)).TrimEnd('\0');
            var signature = Encoding.UTF8.GetString(challenge.AsSpan(76)).TrimEnd('\0');
            var bits = Read32(challenge, 64);
            var timestamp = Read64(challenge, 68);
            return Solve(salt, signature, bits, timestamp, ClientNonce);
        }

        async Task<HttpResponseMessage> Send(PublicCommentSubmission command, bool authenticated = true, bool keyHeader = true,
            bool challenge = false, string? proof = null, string? sessionToken = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, challenge ? WireRoutes.PublicCommentPowChallenge : WireRoutes.SubmitPublicComment)
            {
                Content = new ByteArrayContent(Wire.EncodePublicCommentSubmission(command))
            };
            request.Content.Headers.ContentType = new(Aeds.ContentType);
            if (keyHeader) request.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            if (authenticated) request.Headers.Add("Cookie", $"fsus-v2-session={sessionToken ?? token}");
            if (challenge) request.Headers.Add(WireHeaders.PowClientNonce, ClientNonce);
            if (proof is not null) request.Headers.Add(WireHeaders.PowProof, proof);
            return await server.Client.SendAsync(request, ct);
        }
    }

    private const string ClientNonce = "61287bbaae554232a936d42a3f59bd05";

    [PostgresFact]
    public async Task ProofChecksBindSourceAndExpireAndRollbackWithItsTransaction()
    {
        using var time = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = time.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var clock = new PowTime();
        var authority = new ScopedPow(clock);
        var session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var source = IPAddress.Parse("192.0.2.1");
        var otherSource = IPAddress.Parse("192.0.2.2");
        byte[] frame = [174, 26, 55];
        var challenge = authority.Issue(PowScope.PublicCommentSubmit, "", session, source, ClientNonce, frame);
        var proof = PowWire.ReadProof(Solve(challenge.Salt, challenge.Signature, challenge.Difficulty, challenge.Timestamp, ClientNonce));

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, otherSource, frame, proof, ct));
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.InboxCreate, "", session, source, frame, proof, ct));
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.PublicCommentSubmit, "other-resource", session, source, frame, proof, ct));
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, [174, 26, 56], proof, ct));
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, frame,
                proof with { Difficulty = WireLimits.PowChallengeDifficulty - 1 }, ct));
            await authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, frame, proof, ct);
            await tx.RollbackAsync(ct);
        }

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, frame, proof, ct);
            await tx.CommitAsync(ct);
        }

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, frame, proof, ct));
            clock.Now = clock.Now.AddSeconds(WireLimits.PowChallengeSeconds);
            await Assert.ThrowsAsync<ScopedPowFailure>(() => authority.Consume(db, tx, PowScope.PublicCommentSubmit, "", session, source, frame, proof, ct));
        }
    }

    [PostgresFact]
    public async Task RootProofPolicyRejectsUnspentGenerationAfterRollbackToTheSameLifetime()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var admin = Guid.NewGuid();
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_principal(id,handle,user_handle,enabled,generation)
            values($1,'root-proof-operator',$2,true,1)
            """, admin, RandomNumberGenerator.GetBytes(32));
        var clock = new PowTime();
        var authority = new ScopedPow(clock);
        var session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var source = IPAddress.Parse("192.0.2.1");
        byte[] frame = [174, 26, 55];
        RootCommentPowPolicy initial;
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            initial = await RootCommentPowPolicy.Read(db, tx, ct);
            await tx.CommitAsync(ct);
        }
        Assert.Equal(new RootCommentPowPolicy(1, 120), initial);
        var old = Issue(initial);

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct, update: true);
            var shorter = await current.Activate(db, tx, admin, 60, rollback: false, ct);
            Assert.Equal(2, shorter.Generation);
            Assert.NotEqual(initial.Digest, shorter.Digest);
            await tx.CommitAsync(ct);
        }
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct);
            var underShorterPolicy = Issue(current);
            var previousTime = clock.Now;
            clock.Now = previousTime.AddSeconds(60);
            await Assert.ThrowsAsync<ScopedPowFailure>(() => Consume(tx, underShorterPolicy, current));
            clock.Now = previousTime;
            await tx.CommitAsync(ct);
        }
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct, update: true);
            var previous = await current.PreviousSeconds(db, tx, ct);
            Assert.Equal(120, previous);
            await current.Activate(db, tx, admin, previous, rollback: true, ct);
            await tx.CommitAsync(ct);
        }
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var restored = await RootCommentPowPolicy.Read(db, tx, ct);
            Assert.Equal(new RootCommentPowPolicy(3, 120), restored);
            Assert.Equal(initial.Digest, restored.Digest);
            await Assert.ThrowsAsync<ScopedPowFailure>(() => Consume(tx, old, restored));
            await Consume(tx, Issue(restored), restored);
            await tx.CommitAsync(ct);
        }
        Assert.Equal(1L, await FixtureSql.ScalarAsync(db, null, ct, "select count(*) from public.scoped_pow_consumed"));

        PowProof Issue(RootCommentPowPolicy policy)
        {
            var challenge = authority.Issue(PowScope.PublicCommentSubmit, "", session, source, ClientNonce, frame, policy);
            return PowWire.ReadProof(Solve(challenge.Salt, challenge.Signature, challenge.Difficulty, challenge.Timestamp, ClientNonce));
        }

        Task Consume(NpgsqlTransaction tx, PowProof proof, RootCommentPowPolicy policy) =>
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

    internal static string Solve(string salt, string signature, int bits, long timestamp, string clientNonce)
    {
        for (var i = 0; i < 1_000_000; i++)
        {
            var nonce = i.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{salt}:{nonce}:{clientNonce}"));
            if (hash[0] != 0 || hash[1] >= 16) continue;
            Assert.Equal(12, bits);
            using var output = new MemoryStream();
            using var writer = new BinaryWriter(output);
            writer.Write("FPOW"u8);
            writer.Write((byte)1);
            writer.Write(bits);
            writer.Write(timestamp);
            foreach (var value in new[] { salt, nonce, signature, clientNonce })
            {
                var encoded = Encoding.UTF8.GetBytes(value);
                writer.Write((ushort)encoded.Length);
                writer.Write(encoded);
            }
            return Convert.ToBase64String(output.ToArray());
        }
        throw new InvalidOperationException("No valid proof within test iteration budget.");
    }

    private static async Task Seed(ScratchDatabase fixture, CancellationToken ct)
    {
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        await FixtureSql.ExecuteAsync(db, tx, ct, """
            insert into public.blog_user(id,name,can_author,enabled,generation)
            values ('87dead9a-1591-4eae-846c-0192aaeeccca','comment fixture',true,true,1);
            insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted)
            overriding system value values
            (1,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'visible article','text',1,1,false),
            (2,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'private article','text',null,0,false);
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            values (1,1,'visible article','text',now()),(2,1,'private article','text',now());
            insert into public.article_publication(article_id,revision,published_at) values (1,1,now());
            insert into public.article_revision_rights values(1,1,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true);
            insert into public.article_publication_rights (article_id,publication_id,revision)
                select article_id,publication_id,revision from public.article_publication where article_id=1;
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
        await tx.CommitAsync(ct);

        async Task Add(int article, int id, int? parent, int root, short status, int depth = 1,
            bool deleted = false, int? replyTo = null, string body = "comment", string author = VisibleAuthor)
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.comment(article_id,id,parent_id,root_id,parent_depth,reply_to_id,depth,moderation_status,deleted,
                    body,author_mode,display_name,display_language,created_at)
                values ($1,$2,nullif($3,0),$4,nullif($5,-1),nullif($6,0),$7,$8,$9,$10,3,$11,'en',now())
                """, article, Start + id, parent is { } p ? Start + p : 0L, Start + root, parent.HasValue ? depth - 1 : -1, replyTo is { } r ? Start + r : 0L, parent.HasValue ? depth : 0, status, deleted, body, author);
        }
    }

    private static byte[] Payload(byte[] body, FrameType type) => Aeds.Decode(body, type).ToArray();
    private static int Read32(byte[] bytes, int offset) => BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset));
    private static long Read64(byte[] bytes, int offset) => BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(offset));
    private static int NextNode(byte[] bytes, int offset) => offset + 64 + Read32(bytes, offset + 60);
}
