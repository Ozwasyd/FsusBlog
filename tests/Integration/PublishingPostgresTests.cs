public sealed class PublishingPostgresTests
{
    [PostgresFact]
    public async Task APreviousEncodingGenerationCannotReadCurrentSearchPagesAtIdenticalPublicationCoordinates()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var actor = await fixture.SignIn("search owner", ct, canAuthor: true, minutes: 1);
        (int Id, long Revision, long Publication) coordinate;
        string generation, validator;
        byte[] bytes;
        await using (var first = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var article = await PublishArticle(first.Client, actor.Token, "Stable coordinates", "博客搜索的公开页", ct);
            using var detail = await first.Client.GetAsync(WireRoutes.PublicArticle.Replace("{id}", article.Id.ToString(CultureInfo.InvariantCulture)), ct);
            using var corpus = await first.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct);
            generation = Assert.Single(corpus.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            Assert.Equal(generation, Assert.Single(detail.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            bytes = await corpus.Content.ReadAsByteArrayAsync(ct);
            validator = $"\"{Convert.ToHexStringLower(SHA256.HashData(bytes))}\"";
            Assert.Equal(validator, corpus.Headers.ETag?.ToString());
            coordinate = (article.Id, article.Revision, await fixture.Scalar<long>(
                "select publication_id from public.article_publication where article_id=$1 and revision=$2", article.Id, article.Revision));
        }

        // Model a previous artifact encoder with the same persisted article and release:
        // hashing an alternative page's bytes must yield a distinct snapshot coordinate.
        var immutable = new Article(25, 30, 31, 2, 1, "Stable coordinates", "博客搜索的公开页",
            DateTimeOffset.UnixEpoch.AddDays(1), DateTimeOffset.UnixEpoch.AddDays(1), DateTimeOffset.UnixEpoch.AddDays(1));
        var alternate = new PublicSnapshot(1, [immutable with { Body = "博客的搜索公开页" }], new([], [], []), new WebPages(""),
            new PublicListCursor(TimeProvider.System), null, NullLogger.Instance, null, null, ct);
        var actual = new PublicSnapshot(1, [immutable], new([], [], []), new WebPages(""), new PublicListCursor(TimeProvider.System),
            null, NullLogger.Instance, null, null, ct);
        Assert.NotEqual(alternate.GenerationHeader, actual.GenerationHeader);

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        using var current = await restarted.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct);
        Assert.Equal((generation, validator), (Assert.Single(current.Headers.GetValues(WireHeaders.SearchIndexGeneration)), current.Headers.ETag?.ToString()));
        Assert.Equal(bytes, await current.Content.ReadAsByteArrayAsync(ct));
        using var conditional = new HttpRequestMessage(HttpMethod.Get, WireRoutes.PublicSearchCorpus);
        Assert.True(conditional.Headers.TryAddWithoutValidation("If-None-Match", validator));
        using var unchanged = Expect(NotModified, await restarted.Client.SendAsync(conditional, ct));
        Assert.Equal((validator, generation, "1", true),
            (unchanged.Headers.ETag?.ToString(), Assert.Single(unchanged.Headers.GetValues(WireHeaders.SearchIndexGeneration)),
                Assert.Single(unchanged.Headers.GetValues(WireHeaders.SearchIndexPages)), unchanged.Headers.CacheControl?.NoStore == true));
        Assert.Empty(await unchanged.Content.ReadAsByteArrayAsync(ct));
        var old = PreviousGeneration();
        using var head = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={old}");
        await CheckStatusAsync(Conflict, restarted.Client.SendAsync(head, ct));
        await CheckStatusAsync(Conflict, restarted.Client.GetAsync($"{WireRoutes.PublicSearchCorpus}?page=2&generation={old}", ct));
        using var staleConditional = new HttpRequestMessage(HttpMethod.Get, $"{WireRoutes.PublicSearchCorpus}?page=1&generation={old}");
        Assert.True(staleConditional.Headers.TryAddWithoutValidation("If-None-Match", validator));
        await CheckStatusAsync(Conflict, restarted.Client.SendAsync(staleConditional, ct));

        string PreviousGeneration()
        {
            Span<byte> legacy = stackalloc byte[20];
            BinaryPrimitives.WriteInt32LittleEndian(legacy, coordinate.Id);
            BinaryPrimitives.WriteInt64LittleEndian(legacy[4..], coordinate.Revision);
            BinaryPrimitives.WriteInt64LittleEndian(legacy[12..], coordinate.Publication);
            return (BinaryPrimitives.ReadInt64LittleEndian(SHA256.HashData(legacy)) & long.MaxValue).ToString(CultureInfo.InvariantCulture);
        }
    }

    [PostgresFact]
    public async Task LostBackendDisablesPublicationAndWritesUntilAReplacementAcquiresOwnership()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        var actor = await fixture.SignIn("lease owner", ct, canAuthor: true, minutes: 1);
        await using var first = await ServerProcess.Start(fixture.ConnectionString, ct);
        Assert.Contains("already owns this database", (await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            { await using var rejected = await ServerProcess.Start(fixture.ConnectionString, ct); })).Message);

        const string marker = "Visible only while the instance owns the database";
        var published = await PublishArticle(first.Client, actor.Token, marker, "lease test", ct);
        var article = $"/article/{published.Id}";
        Assert.Contains(marker, await first.Client.GetStringAsync(article, ct));

        await using var inspection = await fixture.DataSource.OpenConnectionAsync(ct);
        var oldOwner = await OwnerPid();
        Assert.True(oldOwner > 0);
        // Hold the transaction barrier an admitted writer keeps until it commits or rolls back.
        await using var admitted = await inspection.BeginTransactionAsync(ct);
        await FixtureSql.ExecuteAsync(inspection, admitted, ct, "select pg_catalog.pg_advisory_xact_lock_shared($1,$2)",
            PublicationLocks.HandoffClass, PublicationLocks.HandoffObject);
        Assert.True(await fixture.Scalar<bool>("select pg_catalog.pg_terminate_backend($1, 5000)", oldOwner));

        await WaitForHealth(first.Client, ServiceUnavailable, TimeSpan.FromSeconds(3), NoContent, ct);
        var forbidden = new ArticleCommand(0, 0, Guid.NewGuid(), "Old owner cannot write", "private");
        await VerifyOldOwnerClosed();

        // A replacement on the same primary drains database writers and rebuilds before binding.
        var replacement = ServerProcess.Start(fixture.ConnectionString, ct);
        while (!replacement.IsCompleted && !await HandoffBlocked()) await Task.Delay(15, ct);
        Assert.False(replacement.IsCompleted);
        await admitted.RollbackAsync(ct);
        await using var successor = await replacement;
        Assert.NotEqual(oldOwner, await OwnerPid());
        Assert.Contains(marker, await successor.Client.GetStringAsync(article, ct));
        await VerifyOldOwnerClosed();
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", forbidden.IdempotencyKey));
        await SiteAedsFixture.ArticleCommand(successor.Client, WireRoutes.Retract, actor.Token, null,
            new(published.Id, published.Revision, Guid.NewGuid(), "", ""), ct);
        await CheckStatusAsync(NotFound, successor.Client.GetAsync(article, ct));

        Task<int> OwnerPid() => fixture.Scalar<int>("""
            select l.pid from pg_catalog.pg_locks l join pg_catalog.pg_database d on d.oid=l.database
            where l.locktype='advisory' and d.datname=current_database() and l.objsubid=1
                and ((l.classid::bigint << 32) | l.objid::bigint)=$1 and l.mode='ExclusiveLock' and l.granted
            """, InstanceLease.OwnershipKey);

        Task<bool> HandoffBlocked() => fixture.Scalar<bool>("""
            select exists(select from pg_catalog.pg_locks l join pg_catalog.pg_database d on d.oid=l.database
                where l.locktype='advisory' and d.datname=current_database() and l.objsubid=2
                    and l.classid=$1::oid and l.objid=$2::oid and l.mode='ExclusiveLock' and not l.granted)
            """, PublicationLocks.HandoffClass, PublicationLocks.HandoffObject);

        async Task VerifyOldOwnerClosed()
        {
            await AssertPublicClosed(first.Client, ["/", article, WireRoutes.PublicIndex, WireRoutes.PublicSearchCorpus], marker, ct);
            var error = await SiteAedsFixture.ExpectStatus(first.Client, HttpMethod.Post, WireRoutes.Save,
                Wire.EncodeArticleCommand(forbidden), actor.Token, null, ServiceUnavailable, ct);
            _ = Aeds.Decode(error, FrameType.ApiError).Length;
        }
    }

    [PostgresFact]
    public async Task ProjectionFailureKeepsAllRepresentationsClosedUntilDurableRecovery()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var session = await fixture.SignIn("projection owner", ct, canAuthor: true, minutes: 1);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        const string marker = "projection fixture unique text";
        var saved = await SiteAedsFixture.SaveDraft(server.Client, session.Token, null, 0, 0, marker, "## Committed article", ct);
        var articlePath = $"/article/{saved.Id}";
        var paths = new[] { "/", articlePath, WireRoutes.PublicArticle.Replace("{id}", saved.Id.ToString(CultureInfo.InvariantCulture)),
            WireRoutes.PublicIndex, WireRoutes.PublicSearchCorpus };

        await fixture.Exec("alter table public.blog_outbox add constraint test_projection_failure check (kind <> 'publish' or processed_at is null)");
        var publish = new ArticleCommand(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Post, WireRoutes.Publish, Wire.EncodeArticleCommand(publish), session.Token, null, ServiceUnavailable, ct);
        await AssertPublicClosed(server.Client, paths, marker, ct);
        Assert.Equal(1L, await Pending("publish"));
        await fixture.Exec("alter table public.blog_outbox drop constraint test_projection_failure");
        var published = await SiteAedsFixture.ArticleCommand(server.Client, WireRoutes.Publish, session.Token, null, publish, ct);
        Assert.True(published.Published);
        Assert.Contains(marker, await server.Client.GetStringAsync(articlePath, ct));

        await fixture.Exec("alter table public.blog_outbox add constraint test_projection_failure check (kind <> 'retract' or processed_at is null)");
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Post, WireRoutes.Retract,
            Wire.EncodeArticleCommand(new(saved.Id, published.Revision, Guid.NewGuid(), "", "")), session.Token, null, ServiceUnavailable, ct);
        await AssertPublicClosed(server.Client, paths, marker, ct);
        Assert.Equal(1L, await Pending("retract"));
        await fixture.Exec("alter table public.blog_outbox drop constraint test_projection_failure");

        await WaitForHealth(server.Client, NoContent, TimeSpan.FromSeconds(15), null, ct);
        await CheckStatusAsync(NotFound, server.Client.GetAsync(articlePath, ct));
        Assert.Equal(0L, await Pending("retract"));

        Task<long> Pending(string action) => fixture.Scalar<long>(
            "select count(*) from public.blog_outbox where article_id=$1 and kind=$2 and processed_at is null", saved.Id, action);
    }

    [PostgresFact]
    public async Task WithdrawingInvalidatesOldHttpRepresentationsAcrossRestart()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var session = await fixture.SignIn("http publisher", ct, canAuthor: true, minutes: 1);
        const string marker = "public replacement unique marker";
        int articleId;
        string publishedGeneration, binary;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var published = await PublishArticle(server.Client, session.Token, "Snapshot <check>",
                $"## Publication heading\n\n{marker}\n\n[Read source](/archive)", ct);
            articleId = published.Id;
            binary = WireRoutes.PublicArticle.Replace("{id}", articleId.ToString(CultureInfo.InvariantCulture));
            using var html = Ok(await server.Client.GetAsync($"/article/{articleId}", ct));
            var page = await html.Content.ReadAsStringAsync(ct);
            Assert.All(["<h2>Publication heading</h2>", "href=\"/archive\"", marker], expected => Assert.Contains(expected, page));
            Assert.True(html.Headers.CacheControl?.NoStore);
            publishedGeneration = Assert.Single(html.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            using var corpus = Ok(await server.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct));
            Assert.Equal(publishedGeneration, Assert.Single(corpus.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            Assert.StartsWith("FSPK", Encoding.ASCII.GetString((await corpus.Content.ReadAsByteArrayAsync(ct)).AsSpan(0, 4)));
            using var detail = Ok(await server.Client.GetAsync(binary, ct));
            Assert.Equal(publishedGeneration, Assert.Single(detail.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            _ = Aeds.Decode(await detail.Content.ReadAsByteArrayAsync(ct), FrameType.ArticleDetail).Length;
            await SiteAedsFixture.ArticleCommand(server.Client, WireRoutes.Retract, session.Token, null,
                new(articleId, published.Revision, Guid.NewGuid(), "", ""), ct);
            await VerifyUnavailable(server.Client);
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        await VerifyUnavailable(restarted.Client);

        async Task VerifyUnavailable(HttpClient client)
        {
            foreach (var route in new[] { $"/article/{articleId}", binary })
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, route);
                request.Headers.IfNoneMatch.ParseAdd("*");
                using var response = Expect(NotFound, await client.SendAsync(request, ct));
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.DoesNotContain(marker, await response.Content.ReadAsStringAsync(ct));
            }
            Assert.DoesNotContain(marker, await ExpectString(Conflict, client.GetAsync($"{WireRoutes.PublicIndex}?page=1&generation={publishedGeneration}", ct), ct));
            using var staleCorpus = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={publishedGeneration}");
            await CheckStatusAsync(Conflict, client.SendAsync(staleCorpus, ct));
            using var current = Ok(await client.GetAsync(WireRoutes.PublicIndex, ct));
            Assert.NotEqual(publishedGeneration, Assert.Single(current.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        }
    }

    [PostgresFact]
    public async Task AFailedOutboxInsertRollsBackTheDraftAndAllowsAnExactRetry()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (store, publications) = await CreateProjection(fixture, ct, refresh: true);
        var session = await fixture.SignIn("transaction author", ct, canAuthor: true, minutes: 1);
        var command = new Edit(0, 0, Guid.NewGuid(), "Rollback fixture", "The draft must roll back with the event.");

        await fixture.Exec("alter table public.blog_outbox add constraint test_reject_save check (kind <> 'save')");
        Assert.Equal("test_reject_save", (await Assert.ThrowsAsync<PostgresException>(() =>
            publications.Command(store, session.Token, ArticleAction.Save, command, ct))).ConstraintName);
        Assert.Equal(0L, await fixture.Scalar<long>("""
            select (select count(*) from public.article) + (select count(*) from public.article_revision)
                + (select count(*) from public.article_command) + (select count(*) from public.blog_outbox)
            """));

        await fixture.Exec("alter table public.blog_outbox drop constraint test_reject_save");
        var saved = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.True(saved.Changed);
        var replay = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.Equal((saved.Article, false), (replay.Article, replay.Changed));
        await BusinessAssert.Denied(Rejection.Conflict, () =>
            publications.Command(store, session.Token, ArticleAction.Save, command with { Body = "different request" }, ct));
    }

    [PostgresFact]
    public async Task ReadOnlyExpiredAndRevokedSessionsCannotCreateArticles()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (store, publications) = await CreateProjection(fixture, ct);
        var edit = new Edit(0, 0, Guid.NewGuid(), "No unauthorized writes", "private");
        var reader = await fixture.SignIn("reader", ct, canAuthor: false, minutes: 1);
        var siteUser = await fixture.SignInSiteUser("site-reader", ct, minutes: 1);
        var author = await fixture.SignIn("author", ct, canAuthor: true, minutes: 1);
        var expiringAdmin = await fixture.SignIn("expiring-admin", ct, canAuthor: true, minutes: 1);
        Assert.Equal(1, await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", author.Id));
        Assert.Equal(1, await fixture.Exec("update public.admin_session set expires_at=clock_timestamp()-interval '1 second' where principal_id=$1", expiringAdmin.Id));
        foreach (var token in new[] { reader.Token, siteUser.Token, null, author.Token, expiringAdmin.Token })
            await BusinessAssert.Denied(Rejection.Unauthorized, () => publications.Command(store, token, ArticleAction.Save, edit, ct));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article"));
    }

    [PostgresFact]
    public async Task AStaleAuthoringHandleCannotCreateAnArticleInAnotherAccount()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (store, publications) = await CreateProjection(fixture, ct);
        var first = await fixture.SignIn("first author", ct, canAuthor: true, minutes: 1);
        var second = await fixture.SignIn("another author", ct, canAuthor: true, minutes: 1);
        var edit = new Edit(0, 0, Guid.NewGuid(), "Private draft", "Owner-only content.");

        await BusinessAssert.Denied(Rejection.Conflict, () => publications.Command(store, second.Token, ArticleAction.Save, edit, ct, first.Handle));
        Assert.Equal(0L, await fixture.Scalar<long>("""
            select (select count(*) from public.article) + (select count(*) from public.article_command) + (select count(*) from public.blog_outbox)
            """));
        Assert.Equal(first.Id, (await publications.Command(store, first.Token, ArticleAction.Save, edit, ct, first.Handle)).Article.Owner);
    }

    [PostgresFact]
    public async Task PublicationOrdinalsArePerArticleAndSurviveWithdrawal()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (store, publications) = await CreateProjection(fixture, ct);
        var session = await fixture.SignIn("publisher", ct, canAuthor: true, minutes: 1);
        var first = await CreateAndPublish("one");
        var second = await CreateAndPublish("two");
        Assert.NotEqual(first.Publication, second.Publication);
        Assert.Equal((1, 1), (first.PublicationNo, second.PublicationNo));

        var withdrawn = await publications.Command(store, session.Token, ArticleAction.Retract,
            new(first.Id, first.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.Null(publications.Snapshot!.Article(first.Id));
        await publications.Command(store, session.Token, ArticleAction.Publish,
            new(first.Id, withdrawn.Article.Revision, Guid.NewGuid(), "", ""), ct);
        var republished = publications.Snapshot!.Article(first.Id)!;
        Assert.Equal((2, second), (republished.PublicationNo, publications.Snapshot!.Article(second.Id)!));
        Assert.NotEqual(first.Publication, republished.Publication);

        async Task<Article> CreateAndPublish(string title)
        {
            var draft = await publications.Command(store, session.Token, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Published body"), ct);
            await publications.Command(store, session.Token, ArticleAction.Publish, new(draft.Article.Id, draft.Article.Revision, Guid.NewGuid(), "", ""), ct);
            return publications.Snapshot!.Article(draft.Article.Id)!;
        }
    }

    [PostgresFact]
    public async Task PublishAndRetractUseOneAuthorizedDurableRevision()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (store, publications) = await CreateProjection(fixture, ct, refresh: true);
        var issue = await fixture.IssueTicket("site reader ticket", ct, minutes: 1);
        await store.SignIn(issue.Ticket, ct);
        await BusinessAssert.Denied(Rejection.Unauthorized, () => store.SignIn(issue.Ticket, ct));
        var session = await fixture.SignIn("original owner", ct, canAuthor: true, minutes: 1);
        var command = new Edit(0, 0, Guid.NewGuid(), "Saved title", "Saved Markdown body");
        var settled = await Task.WhenAll(
            publications.Command(store, session.Token, ArticleAction.Save, command, ct),
            publications.Command(store, session.Token, ArticleAction.Save, command, ct));
        var saved = settled[0].Article;
        Assert.Equal(saved, settled[1].Article);
        Assert.Null(publications.Snapshot!.Article(saved.Id));

        var newDraft = (await publications.Command(store, session.Token, ArticleAction.Save,
            new(saved.Id, saved.Revision, Guid.NewGuid(), "Published title", "Published Markdown body"), ct)).Article;
        var oldPublication = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        await BusinessAssert.Denied(Rejection.Conflict, () => publications.Command(store, session.Token, ArticleAction.Publish, oldPublication, ct));
        var published = (await publications.Command(store, session.Token, ArticleAction.Publish,
            oldPublication with { ExpectedRevision = newDraft.Revision }, ct)).Article;
        Assert.Equal(published.Revision, publications.Snapshot!.Article(saved.Id)!.Revision);

        var readOnlyAdmin = await fixture.SignIn("read-only admin", ct, canAuthor: false, minutes: 1);
        var retract = new Edit(saved.Id, published.Revision, Guid.NewGuid(), "", "");
        await BusinessAssert.Denied(Rejection.Unauthorized, () => publications.Command(store, readOnlyAdmin.Token, ArticleAction.Retract, retract, ct));
        await BusinessAssert.Denied(Rejection.NotFound, () => publications.Command(store, session.Token, ArticleAction.Retract, retract with { Id = 999_999 }, ct));
        await publications.Command(store, session.Token, ArticleAction.Retract, retract, ct);
        Assert.Null(publications.Snapshot!.Article(saved.Id));
        Assert.Equal((4L, 4L), await fixture.QueryRow(
            "select count(*), count(distinct revision) from public.blog_outbox where article_id=$1",
            r => (r.GetInt64(0), r.GetInt64(1)), saved.Id));
    }

    private static async Task<Draft> PublishArticle(HttpClient client, string token, string title, string body, CancellationToken ct)
    {
        var saved = await SiteAedsFixture.SaveDraft(client, token, null, 0, 0, title, body, ct);
        return await SiteAedsFixture.ArticleCommand(client, WireRoutes.Publish, token, null, new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct);
    }

    private static async Task<(Store Store, Publications Publications)> CreateProjection(ScratchDatabase fixture, CancellationToken ct, bool refresh = false)
    {
        var publications = PublicationFixture.Project(fixture.DataSource);
        if (refresh) await publications.Refresh(ct);
        return (new Store(fixture.DataSource), publications);
    }

    private static async Task AssertPublicClosed(HttpClient client, string[] paths, string marker, CancellationToken ct)
    {
        foreach (var path in paths)
        {
            using var response = Expect(ServiceUnavailable, await client.GetAsync(path, ct));
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.DoesNotContain(marker, await response.Content.ReadAsStringAsync(ct));
        }
    }

    private static async Task WaitForHealth(HttpClient client, HttpStatusCode target, TimeSpan timeout, HttpStatusCode? interim, CancellationToken ct)
    {
        using var duration = CancellationTokenSource.CreateLinkedTokenSource(ct);
        duration.CancelAfter(timeout);
        while (true)
        {
            using var response = await client.GetAsync("/health/ready", duration.Token);
            if (response.StatusCode == target) return;
            if (interim is HttpStatusCode allowed) Assert.Equal(allowed, response.StatusCode);
            await Task.Delay(50, duration.Token);
        }
    }
}
