namespace FsusBlog.V2.Integration.Tests;

public sealed class CommentOwnSearchDeletePostgresTests
{
    [PostgresFact]
    public async Task OwnedCommentSearchFiltersSafelyAndQuickDeleteRemovesComment()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var admin = await fixture.AdminAsync("comment-search-admin", 15, RandomNumberGenerator.GetBytes(32), [2], ct);
        var reader = await fixture.SignInSiteUser("comment-search-reader", ct);
        var currentSessionId = SiteSessions.Id(reader.Id, Store.TokenDigest(reader.Token)!);

        var publishedArticle = await SeedArticle(fixture, ct, admin.Id, "AEDS Binary Architecture", published: true);
        // Simulate an unpublished newer draft edit changing article.title while published_revision stays at revision 1.
        await fixture.Exec("""
            insert into public.article_revision (article_id, revision, title, body, happened_at)
            values ($1, 2, 'Unpublished Newer Draft Title', '# body v2', now())
            """, publishedArticle);
        await fixture.Exec("update public.article set revision = 2, title = 'Unpublished Newer Draft Title' where id = $1", publishedArticle);
        var draftArticle = await SeedArticle(fixture, ct, admin.Id, "Secret Draft Title", published: false);

        await SeedOwnedComment(fixture, reader.Id, publishedArticle, 1, 1, false, "Great write-up on PostgreSQL locking.");
        await SeedOwnedComment(fixture, reader.Id, publishedArticle, 2, 0, false, "Pending benchmark note for review.");
        await SeedOwnedComment(fixture, reader.Id, publishedArticle, 3, 2, false, "Rejected off-topic remark.", admin.Id, "Decision note mentions unique-appeal-marker.");
        await SeedOwnedComment(fixture, reader.Id, draftArticle, 4, 1, false, "Comment on draft article.");
        await SeedOwnedComment(fixture, reader.Id, publishedArticle, 5, 2, true, "Deleted secret body should never match search.", admin.Id, "Retained appeal decision.");
        await SeedOwnedComment(fixture, reader.Id, publishedArticle, 6, 0, false, "Expired pending note outside 30m window.", ageMinutes: 31);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // Unknown query parameter and invalid status filter must fail closed with 400.
        foreach (var bad in new[] { "?evil=1", "?status=unknown" })
            await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Get, WireRoutes.CommentAuthorAppeals + bad,
                null, reader.Token, currentSessionId, BadRequest, ct);

        // Keyword search matches comment body, review decision reason, and published article title,
        // but NEVER unpublished draft article title or deleted comment body.
        var bodyMatches = await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=POSTGRESQL", ct);
        Assert.Equal([1L], bodyMatches.Select(r => r.CommentId));
        Assert.Equal([3L], (await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=unique-appeal-marker", ct)).Select(r => r.CommentId));
        Assert.Equal([6L, 5L, 3L, 2L, 1L], (await FetchOwned(server.Client, reader.Token, currentSessionId, "?q=Binary%20Architecture", ct)).Select(r => r.CommentId));
        foreach (var hiddenQuery in new[] { "?q=Secret%20Draft", "?q=Unpublished%20Newer", "?q=Deleted%20secret%20body" })
            Assert.Empty(await FetchOwned(server.Client, reader.Token, currentSessionId, hiddenQuery, ct));

        // Status filter combines cleanly with keyword search, editability window, and before cursor.
        var pendingOnly = await FetchOwned(server.Client, reader.Token, currentSessionId, "?status=pending", ct);
        Assert.Equal([6L, 2L], pendingOnly.Select(r => r.CommentId));
        // Fresh pending comment #2 is editable; >30m expired pending comment #6 is NOT editable.
        Assert.False(pendingOnly.Single(r => r.CommentId == 6L).Editable);
        Assert.True(pendingOnly.Single(r => r.CommentId == 2L).Editable);
        Assert.False(bodyMatches.Single().Editable);
        Assert.Equal([3L], (await FetchOwned(server.Client, reader.Token, currentSessionId, "?status=rejected&before=5", ct)).Select(r => r.CommentId));

        // Quick delete flow (challenge + delete) removes non-appealed comment from owned list.
        var challengeReq = Aeds.Encode(FrameType.CommentManagementChallengeRequest,
            Encoding.UTF8.GetBytes("""{"purpose":"delete","capabilitySecret":null}"""));
        var challengePayload = Aeds.Decode(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post,
            WireRoutes.CommentAuthorChallenge.Replace("{id:long}", "2"), challengeReq, reader.Token, currentSessionId, OK, ct),
            FrameType.CommentManagementChallengeResponse);
        using var doc = JsonDocument.Parse(challengePayload.ToArray());
        var proof = doc.RootElement.GetProperty("challenge").GetString()!;

        var deleteReq = Aeds.Encode(FrameType.CommentAuthorStatusRequest,
            JsonSerializer.SerializeToUtf8Bytes(new { challenge = proof, capabilitySecret = "" }));
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Post, WireRoutes.CommentAuthorDelete.Replace("{id:long}", "2"),
            deleteReq, reader.Token, currentSessionId, OK, ct);

        Assert.Equal([6L], (await FetchOwned(server.Client, reader.Token, currentSessionId, "?status=pending", ct)).Select(r => r.CommentId));
    }

    private static Task<int> SeedArticle(ScratchDatabase fixture, CancellationToken ct, Guid ownerId, string title, bool published) =>
        fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, "set constraints all deferred");
            var id = (int)(await FixtureSql.ScalarAsync(db, tx, ct, """
                insert into public.article (owner_id, revision, title, body, published_revision, publication_count, deleted)
                values ($1, 1, $2, '# body', $3, $4, false) returning id
                """, ownerId, title, published ? 1L : DBNull.Value, published ? 1 : 0))!;
            await FixtureSql.ExecuteAsync(db, tx, ct,
                "insert into public.article_revision (article_id, revision, title, body, happened_at) values ($1, 1, $2, '# body', now())",
                id, title);
            if (published)
            {
                var pubId = (long)(await FixtureSql.ScalarAsync(db, tx, ct,
                    "insert into public.article_publication (article_id, revision, publication_no, published_at) values ($1, 1, 1, now()) returning publication_id",
                    id))!;
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article_revision_rights
                        (article_id, revision, enabled, license_type, copyright_holder, copyright_year, rights_statement,
                         attribution_template, copy_policy, max_excerpt_chars, allow_code_copy, show_public_badge, proof_binding_enabled)
                    values ($1, 1, true, 'CC-BY-4.0', 'FsusBlog', 2026, 'Attribution required', '', 'excerpt', 500, true, true, false)
                    """, id);
                await FixtureSql.ExecuteAsync(db, tx, ct,
                    "insert into public.article_publication_rights (article_id, publication_id, revision) values ($1, $2, 1)", id, pubId);
            }
            return id;
        }, ct);

    private static async Task SeedOwnedComment(ScratchDatabase fixture, Guid userId, int articleId,
        long id, short status, bool deleted, string body, Guid? moderatorId = null, string? decisionReason = null, int ageMinutes = 0)
    {
        await fixture.Exec("""
            insert into public.comment
                (article_id, id, root_id, depth, moderation_status, deleted, body, author_mode, display_name, display_language, created_at, moderation_version)
            values ($1, $2, $2, 0, $3, $4, $5, 3, 'Reader', 'zh-CN', now() - make_interval(mins => $6), 2)
            """, articleId, id, status, deleted, body, ageMinutes);
        await fixture.Exec("insert into public.comment_account_owner (article_id, comment_id, user_id) values ($1, $2, $3)", articleId, id, userId);
        if (moderatorId is not null && decisionReason is not null)
        {
            await fixture.Exec("""
                insert into public.comment_submit_command (user_id, command_id, fingerprint, article_id, comment_id)
                values ($1, $2, $3, $4, $5)
                """, userId, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32), articleId, id);
            var adverseId = await fixture.Scalar<long>("""
                insert into public.admin_comment_moderation
                    (article_id, comment_id, principal_id, previous_status, next_status, reason, happened_at, comment_version)
                values ($1, $2, $3, 0, 2, 'mod reason', now(), 1) returning id
                """, articleId, id, moderatorId.Value);
            var appealId = await fixture.Scalar<long>("""
                insert into public.comment_appeal
                    (article_id, comment_id, user_id, adverse_id, comment_version, reason, submitted_at)
                values ($1, $2, $3, $4, 2, 'Valid technical context for appeal review.', now()) returning id
                """, articleId, id, userId, adverseId);
            await fixture.Exec("""
                insert into public.comment_appeal_decision (appeal_id, principal_id, session_reference, granted, reason, decided_at)
                values ($1, $2, $3, false, $4, now())
                """, appealId, moderatorId.Value, RandomNumberGenerator.GetBytes(32), decisionReason);
        }
    }

    private static async Task<List<(int ArticleId, long CommentId, string Body, int Status, int Appeal, string Reason, bool Editable)>> FetchOwned(
        HttpClient client, string cookie, string sessionId, string query, CancellationToken ct)
    {
        var frame = await SiteAedsFixture.ExpectPrivate(client, HttpMethod.Get, WireRoutes.CommentAuthorAppeals + query, null, cookie, sessionId, OK, ct);
        using var reader = InboxFixture.Reader(frame, FrameType.CommentAuthorAppeals);
        _ = reader.ReadByte();
        var count = reader.ReadInt32();
        var rows = new List<(int, long, string, int, int, string, bool)>(count);
        for (var i = 0; i < count; i++)
            rows.Add((reader.ReadInt32(), reader.ReadInt64(), InboxFixture.Text(reader),
                reader.ReadInt32(), reader.ReadInt32(), InboxFixture.Text(reader), reader.ReadByte() == 1));
        Assert.Equal(reader.BaseStream.Length, reader.BaseStream.Position);
        return rows;
    }
}
