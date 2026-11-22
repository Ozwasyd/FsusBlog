using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CommentOwnSearchDeletePostgresTests
{
    [PostgresFact]
    public async Task OwnedCommentSearchFiltersSafelyAndQuickDeleteRemovesComment()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        var admin = await FixtureSql.AdminAsync(db, ct, "comment-search-admin", 15, RandomNumberGenerator.GetBytes(32), [2]);
        var reader = await fixture.SignInSiteUser("comment-search-reader", ct);
        var currentSessionId = SiteSessions.Id(reader.Id, Store.TokenDigest(reader.Token)!);

        var publishedArticle = await SeedArticle(db, ct, admin.Id, "AEDS Binary Architecture", published: true);
        // Simulate an unpublished newer draft edit changing article.title while published_revision stays at revision 1.
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.article_revision (article_id, revision, title, body, happened_at)
            values ($1, 2, 'Unpublished Newer Draft Title', '# body v2', now())
            """, publishedArticle);
        await FixtureSql.ExecuteAsync(db, null, ct,
            "update public.article set revision = 2, title = 'Unpublished Newer Draft Title' where id = $1",
            publishedArticle);
        var draftArticle = await SeedArticle(db, ct, admin.Id, "Secret Draft Title", published: false);

        await SeedOwnedComment(db, ct, reader.Id, publishedArticle, 1, 1, false, "Great write-up on PostgreSQL locking.");
        await SeedOwnedComment(db, ct, reader.Id, publishedArticle, 2, 0, false, "Pending benchmark note for review.");
        await SeedOwnedComment(db, ct, reader.Id, publishedArticle, 3, 2, false, "Rejected off-topic remark.", admin.Id, "Decision note mentions unique-appeal-marker.");
        await SeedOwnedComment(db, ct, reader.Id, draftArticle, 4, 1, false, "Comment on draft article.");
        await SeedOwnedComment(db, ct, reader.Id, publishedArticle, 5, 2, true, "Deleted secret body should never match search.", admin.Id, "Retained appeal decision.");
        await SeedOwnedComment(db, ct, reader.Id, publishedArticle, 6, 0, false, "Expired pending note outside 30m window.", ageMinutes: 31);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // Unknown query parameter must fail closed with 400.
        using (var badParam = SiteRequest(HttpMethod.Get, WireRoutes.CommentAuthorAppeals + "?evil=1", reader.Token, currentSessionId))
        using (var res = await server.Client.SendAsync(badParam, ct))
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        // Invalid status filter must fail closed with 400.
        using (var badStatus = SiteRequest(HttpMethod.Get, WireRoutes.CommentAuthorAppeals + "?status=unknown", reader.Token, currentSessionId))
        using (var res = await server.Client.SendAsync(badStatus, ct))
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        // Keyword search matches comment body case-insensitively and returns Cache-Control: private, no-store.
        var bodyMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=POSTGRESQL", ct);
        Assert.Equal([1L], bodyMatches.Select(r => r.CommentId).ToArray());

        // Keyword search matches review decision reason.
        var reasonMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=unique-appeal-marker", ct);
        Assert.Equal([3L], reasonMatches.Select(r => r.CommentId).ToArray());

        // Keyword search matches published article title, but NEVER unpublished draft article title or deleted comment body.
        var pubTitleMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=Binary%20Architecture", ct);
        Assert.Equal([6L, 5L, 3L, 2L, 1L], pubTitleMatches.Select(r => r.CommentId).ToArray());

        var draftTitleMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=Secret%20Draft", ct);
        Assert.Empty(draftTitleMatches);

        var newerDraftTitleMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=Unpublished%20Newer", ct);
        Assert.Empty(newerDraftTitleMatches);

        var deletedBodyMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=Deleted%20secret%20body", ct);
        Assert.Empty(deletedBodyMatches);

        // Status filter combines cleanly with keyword search, editability window, and before cursor.
        var pendingOnly = await FetchOwned(server.Client, reader.Token, currentSessionId, "?status=pending", ct);
        Assert.Equal([6L, 2L], pendingOnly.Select(r => r.CommentId).ToArray());
        // Fresh pending comment #2 is editable; >30m expired pending comment #6 is NOT editable.
        Assert.False(pendingOnly.Single(r => r.CommentId == 6L).Editable);
        Assert.True(pendingOnly.Single(r => r.CommentId == 2L).Editable);
        Assert.False(bodyMatches.Single().Editable);

        var rejectedBefore = await FetchOwned(server.Client, reader.Token, currentSessionId, "?status=rejected&before=5", ct);
        Assert.Equal([3L], rejectedBefore.Select(r => r.CommentId).ToArray());

        // Quick delete flow (challenge + delete) removes non-appealed comment from owned list.
        var challengeReq = Aeds.Encode(FrameType.CommentManagementChallengeRequest,
            Encoding.UTF8.GetBytes("""{"purpose":"delete","capabilitySecret":null}"""));
        string proof;
        using (var chReq = SiteRequest(HttpMethod.Post, WireRoutes.CommentAuthorChallenge.Replace("{id:long}", "2"), reader.Token, currentSessionId, challengeReq))
        using (var res = await server.Client.SendAsync(chReq, ct))
        {
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var payload = Aeds.Decode(await res.Content.ReadAsByteArrayAsync(ct), FrameType.CommentManagementChallengeResponse);
            using var doc = JsonDocument.Parse(payload.ToArray());
            proof = doc.RootElement.GetProperty("challenge").GetString()!;
        }

        var deleteReq = Aeds.Encode(FrameType.CommentAuthorStatusRequest,
            JsonSerializer.SerializeToUtf8Bytes(new { challenge = proof, capabilitySecret = "" }));
        using (var del = SiteRequest(HttpMethod.Post, WireRoutes.CommentAuthorDelete.Replace("{id:long}", "2"), reader.Token, currentSessionId, deleteReq))
        using (var res = await server.Client.SendAsync(del, ct))
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var pendingAfterDelete = await FetchOwned(server.Client, reader.Token, currentSessionId, "?status=pending", ct);
        Assert.Equal([6L], pendingAfterDelete.Select(r => r.CommentId).ToArray());
    }

    private static async Task<int> SeedArticle(NpgsqlConnection db, CancellationToken ct, Guid ownerId, string title, bool published)
    {
        await using var tx = await db.BeginTransactionAsync(ct);
        await FixtureSql.ExecuteAsync(db, tx, ct, "set constraints all deferred");
        var id = (int)(await FixtureSql.ScalarAsync(db, tx, ct, """
            insert into public.article (owner_id, revision, title, body, published_revision, publication_count, deleted)
            values ($1, 1, $2, '# body', $3, $4, false)
            returning id
            """, ownerId, title, published ? 1L : DBNull.Value, published ? 1 : 0))!;
        await FixtureSql.ExecuteAsync(db, tx, ct, """
            insert into public.article_revision (article_id, revision, title, body, happened_at)
            values ($1, 1, $2, '# body', now())
            """, id, title);
        if (published)
        {
            var pubId = (long)(await FixtureSql.ScalarAsync(db, tx, ct, """
                insert into public.article_publication (article_id, revision, publication_no, published_at)
                values ($1, 1, 1, now())
                returning publication_id
                """, id))!;
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_revision_rights
                    (article_id, revision, enabled, license_type, copyright_holder, copyright_year, rights_statement,
                     attribution_template, copy_policy, max_excerpt_chars, allow_code_copy, show_public_badge, proof_binding_enabled)
                values ($1, 1, true, 'CC-BY-4.0', 'FsusBlog', 2026, 'Attribution required', '', 'excerpt', 500, true, true, false)
                """, id);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_publication_rights (article_id, publication_id, revision)
                values ($1, $2, 1)
                """, id, pubId);
        }
        await tx.CommitAsync(ct);
        return id;
    }

    private static async Task SeedOwnedComment(NpgsqlConnection db, CancellationToken ct, Guid userId, int articleId,
        long id, short status, bool deleted, string body, Guid? moderatorId = null, string? decisionReason = null, int ageMinutes = 0)
    {
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.comment
                (article_id, id, root_id, depth, moderation_status, deleted, body, author_mode, display_name, display_language, created_at, moderation_version)
            values ($1, $2, $2, 0, $3, $4, $5, 3, 'Reader', 'zh-CN', now() - make_interval(mins => $6), 2)
            """, articleId, id, status, deleted, body, ageMinutes);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.comment_account_owner (article_id, comment_id, user_id) values ($1, $2, $3)
            """, articleId, id, userId);
        if (moderatorId is not null && decisionReason is not null)
        {
            await FixtureSql.ExecuteAsync(db, null, ct, """
                insert into public.comment_submit_command (user_id, command_id, fingerprint, article_id, comment_id)
                values ($1, $2, $3, $4, $5)
                """, userId, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32), articleId, id);
            var adverseId = (long)(await FixtureSql.ScalarAsync(db, null, ct, """
                insert into public.admin_comment_moderation
                    (article_id, comment_id, principal_id, previous_status, next_status, reason, happened_at, comment_version)
                values ($1, $2, $3, 0, 2, 'mod reason', now(), 1)
                returning id
                """, articleId, id, moderatorId.Value))!;
            var appealId = (long)(await FixtureSql.ScalarAsync(db, null, ct, """
                insert into public.comment_appeal
                    (article_id, comment_id, user_id, adverse_id, comment_version, reason, submitted_at)
                values ($1, $2, $3, $4, 2, 'Valid technical context for appeal review.', now())
                returning id
                """, articleId, id, userId, adverseId))!;
            await FixtureSql.ExecuteAsync(db, null, ct, """
                insert into public.comment_appeal_decision (appeal_id, principal_id, session_reference, granted, reason, decided_at)
                values ($1, $2, $3, false, $4, now())
                """, appealId, moderatorId.Value, RandomNumberGenerator.GetBytes(32), decisionReason);
        }
    }

    private static async Task<List<(int ArticleId, long CommentId, string Body, int Status, int Appeal, string Reason, bool Editable)>> FetchOwned(
        HttpClient client, string cookie, string sessionId, string query, CancellationToken ct)
    {
        using var req = SiteRequest(HttpMethod.Get, WireRoutes.CommentAuthorAppeals + query, cookie, sessionId);
        using var res = await client.SendAsync(req, ct);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.CacheControl?.NoStore);
        var payload = Aeds.Decode(await res.Content.ReadAsByteArrayAsync(ct), FrameType.CommentAuthorAppeals);
        var pos = 0;
        _ = ReadByte(payload, ref pos);
        var count = ReadI32(payload, ref pos);
        var rows = new List<(int, long, string, int, int, string, bool)>(count);
        for (var i = 0; i < count; i++)
            rows.Add((ReadI32(payload, ref pos), ReadI64(payload, ref pos), ReadText(payload, ref pos),
                ReadI32(payload, ref pos), ReadI32(payload, ref pos), ReadText(payload, ref pos), ReadByte(payload, ref pos) == 1));
        Assert.Equal(payload.Length, pos);
        return rows;

        static byte ReadByte(ReadOnlySpan<byte> buf, ref int p) => buf[p++];
        static int ReadI32(ReadOnlySpan<byte> buf, ref int p) { var v = BinaryPrimitives.ReadInt32LittleEndian(buf[p..]); p += 4; return v; }
        static long ReadI64(ReadOnlySpan<byte> buf, ref int p) { var v = BinaryPrimitives.ReadInt64LittleEndian(buf[p..]); p += 8; return v; }
        static string ReadText(ReadOnlySpan<byte> buf, ref int p)
        {
            var len = ReadI32(buf, ref p);
            var text = Encoding.UTF8.GetString(buf.Slice(p, len));
            p += len;
            return text;
        }
    }

    private static HttpRequestMessage SiteRequest(HttpMethod method, string path, string cookie, string sessionId, byte[]? body = null)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.Add("Cookie", $"fsus-v2-session={cookie}");
        req.Headers.Add(WireHeaders.CurrentSession, sessionId);
        if (body is not null)
        {
            req.Content = new ByteArrayContent(body);
            req.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(Aeds.ContentType);
        }
        return req;
    }
}
