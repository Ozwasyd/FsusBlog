using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using System.Net;
using System.Security.Cryptography;

public sealed class PublishingPostgresTests
{
    [PostgresFact]
    public async Task APreviousEncodingGenerationCannotReadCurrentSearchPagesAtIdenticalPublicationCoordinates()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var store = new Store(fixture.DataSource);
        var actor = await fixture.SignIn("search owner", ct, canAuthor: true, minutes: 1);
        (int Id, long Revision, long Publication) coordinate;
        string generation;
        string validator;
        byte[] bytes;
        await using (var first = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var saved = Wire.DecodeDraft(await Write(first.Client, actor.Token, WireRoutes.Save,
                new(0, 0, Guid.NewGuid(), "Stable coordinates", "博客搜索的公开页"), ct));
            var article = Wire.DecodeDraft(await Write(first.Client, actor.Token, WireRoutes.Publish,
                new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct));
            using var detail = await first.Client.GetAsync(WireRoutes.PublicArticle.Replace("{id}",
                article.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)), ct);
            using var corpus = await first.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct);
            generation = Assert.Single(corpus.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            Assert.Equal(generation, Assert.Single(detail.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            bytes = await corpus.Content.ReadAsByteArrayAsync(ct);
            validator = $"\"{Convert.ToHexStringLower(SHA256.HashData(bytes))}\"";
            Assert.Equal(validator, corpus.Headers.ETag?.ToString());
            await using var database = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var publication = Store.Sql(database, null,
                "select publication_id from public.article_publication where article_id=$1 and revision=$2", article.Id, article.Revision);
            coordinate = (article.Id, article.Revision, (long)(await publication.ExecuteScalarAsync(ct))!);
        }

        // Model a previous artifact encoder with the same persisted article and release:
        // hashing an alternative page's bytes must yield a distinct snapshot coordinate.
        var immutable = new Article(25, 30, 31, 2, 1, "Stable coordinates", "博客搜索的公开页",
            DateTimeOffset.UnixEpoch.AddDays(1), DateTimeOffset.UnixEpoch.AddDays(1), DateTimeOffset.UnixEpoch.AddDays(1));
        var time = TimeProvider.System;
        var alternate = new PublicSnapshot(1, [immutable with { Body = "博客的搜索公开页" }], new([], [], []), new WebPages(""),
            new PublicListCursor(time), null, NullLogger.Instance, null, null, ct);
        var actual = new PublicSnapshot(1, [immutable], new([], [], []), new WebPages(""), new PublicListCursor(time),
            null, NullLogger.Instance, null, null, ct);
        Assert.NotEqual(alternate.GenerationHeader, actual.GenerationHeader);

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        using var current = await restarted.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct);
        Assert.Equal(generation, Assert.Single(current.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        Assert.Equal(bytes, await current.Content.ReadAsByteArrayAsync(ct));
        Assert.Equal(validator, current.Headers.ETag?.ToString());
        using var conditional = new HttpRequestMessage(HttpMethod.Get, WireRoutes.PublicSearchCorpus);
        Assert.True(conditional.Headers.TryAddWithoutValidation("If-None-Match", validator));
        using var unchanged = await restarted.Client.SendAsync(conditional, ct);
        Assert.Equal(HttpStatusCode.NotModified, unchanged.StatusCode);
        Assert.Equal(validator, unchanged.Headers.ETag?.ToString());
        Assert.Equal(generation, Assert.Single(unchanged.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        Assert.Equal("1", Assert.Single(unchanged.Headers.GetValues(WireHeaders.SearchIndexPages)));
        Assert.True(unchanged.Headers.CacheControl?.NoStore);
        Assert.Empty(await unchanged.Content.ReadAsByteArrayAsync(ct));
        var old = PreviousGeneration();
        using var head = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={old}");
        using var rejectedHead = await restarted.Client.SendAsync(head, ct);
        using var rejectedPage = await restarted.Client.GetAsync($"{WireRoutes.PublicSearchCorpus}?page=2&generation={old}", ct);
        using var staleConditional = new HttpRequestMessage(HttpMethod.Get,
            $"{WireRoutes.PublicSearchCorpus}?page=1&generation={old}");
        Assert.True(staleConditional.Headers.TryAddWithoutValidation("If-None-Match", validator));
        using var rejectedConditional = await restarted.Client.SendAsync(staleConditional, ct);
        Assert.Equal(HttpStatusCode.Conflict, rejectedHead.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, rejectedPage.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, rejectedConditional.StatusCode);

        string PreviousGeneration()
        {
            var (id, revision, publication) = coordinate;
            Span<byte> legacy = stackalloc byte[20];
            System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(legacy, id);
            System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(legacy[4..], revision);
            System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(legacy[12..], publication);
            var oldDigest = System.Security.Cryptography.SHA256.HashData(legacy);
            return (System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(oldDigest) & long.MaxValue)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    [PostgresFact]
    public async Task LostBackendDisablesPublicationAndWritesUntilAReplacementAcquiresOwnership()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        var store = new Store(fixture.DataSource);
        var actor = await fixture.SignIn("lease owner", ct, canAuthor: true, minutes: 1);
        await using var first = await ServerProcess.Start(fixture.ConnectionString, ct);
        var deniedStart = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var rejected = await ServerProcess.Start(fixture.ConnectionString, ct);
        });
        Assert.Contains("already owns this database", deniedStart.Message);

        const string marker = "Visible only while the instance owns the database";
        var saved = Wire.DecodeDraft(await Write(first.Client, actor.Token, WireRoutes.Save,
            new(0, 0, Guid.NewGuid(), marker, "lease test"), ct));
        var published = Wire.DecodeDraft(await Write(first.Client, actor.Token, WireRoutes.Publish,
            new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct));
        var article = $"/article/{published.Id}";
        Assert.Contains(marker, await first.Client.GetStringAsync(article, ct));

        await using var control = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var inspection = await fixture.DataSource.OpenConnectionAsync(ct);
        var oldOwner = await OwnerPid();
        Assert.True(oldOwner > 0);
        // Hold the transaction barrier an admitted writer keeps until it commits or rolls back.
        await using var admitted = await inspection.BeginTransactionAsync(ct);
        await FixtureSql.ExecuteAsync(inspection, admitted, ct, "select pg_catalog.pg_advisory_xact_lock_shared($1,$2)", FsusBlogV2.Storage.PublicationLocks.HandoffClass, FsusBlogV2.Storage.PublicationLocks.HandoffObject);
        await using (var terminate = Store.Sql(control, null, "select pg_catalog.pg_terminate_backend($1, 5000)", oldOwner))
            Assert.True((bool)(await terminate.ExecuteScalarAsync(ct))!);

        using (var duration = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            duration.CancelAfter(TimeSpan.FromSeconds(3));
            while (true)
            {
                using var readiness = await first.Client.GetAsync("/health/ready", duration.Token);
                if (readiness.StatusCode == HttpStatusCode.ServiceUnavailable) break;
                Assert.Equal(HttpStatusCode.NoContent, readiness.StatusCode);
                await Task.Delay(25, duration.Token);
            }
        }
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
        using (var uncommitted = Store.Sql(inspection, null, "select count(*) from public.article_command where command_id=$1", forbidden.IdempotencyKey))
            Assert.Equal(0L, await uncommitted.ExecuteScalarAsync(ct));
        await Write(successor.Client, actor.Token, WireRoutes.Retract,
            new(published.Id, published.Revision, Guid.NewGuid(), "", ""), ct);
        using var withdrawn = await successor.Client.GetAsync(article, ct);
        Assert.Equal(HttpStatusCode.NotFound, withdrawn.StatusCode);

        async Task<int> OwnerPid()
        {
            return (int)(await FixtureSql.ScalarAsync(control, null, ct, """
                select l.pid from pg_catalog.pg_locks l
                join pg_catalog.pg_database d on d.oid=l.database
                where l.locktype='advisory' and d.datname=current_database() and l.objsubid=1
                    and ((l.classid::bigint << 32) | l.objid::bigint)=$1 and l.mode='ExclusiveLock' and l.granted
                """, InstanceLease.OwnershipKey))!;
        }

        async Task<bool> HandoffBlocked()
        {
            return (bool)(await FixtureSql.ScalarAsync(control, null, ct, """
                select exists(select from pg_catalog.pg_locks l
                    join pg_catalog.pg_database d on d.oid=l.database
                    where l.locktype='advisory' and d.datname=current_database() and l.objsubid=2
                        and l.classid=$1::oid and l.objid=$2::oid and l.mode='ExclusiveLock' and not l.granted)
                """, FsusBlogV2.Storage.PublicationLocks.HandoffClass, FsusBlogV2.Storage.PublicationLocks.HandoffObject))!;
        }

        async Task VerifyOldOwnerClosed()
        {
            foreach (var route in new[] { "/", article, WireRoutes.PublicIndex, WireRoutes.PublicSearchCorpus })
            {
                using var response = await first.Client.GetAsync(route, ct);
                Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.DoesNotContain(marker, await response.Content.ReadAsStringAsync(ct));
            }
            var error = await Write(first.Client, actor.Token, WireRoutes.Save, forbidden, ct, HttpStatusCode.ServiceUnavailable);
            _ = Aeds.Decode(error, FrameType.ApiError).Length;
        }
    }

    [PostgresFact]
    public async Task ProjectionFailureKeepsAllRepresentationsClosedUntilDurableRecovery()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var session = await fixture.SignIn("projection owner", ct, canAuthor: true, minutes: 1);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        await using var database = await fixture.DataSource.OpenConnectionAsync(ct);
        const string marker = "projection fixture unique text";
        var saved = Wire.DecodeDraft(await Write(server.Client, session.Token, WireRoutes.Save,
            new(0, 0, Guid.NewGuid(), marker, "## Committed article"), ct));
        var articlePath = $"/article/{saved.Id}";
        var binaryPath = WireRoutes.PublicArticle.Replace("{id}", saved.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var paths = new[] { "/", articlePath, binaryPath, WireRoutes.PublicIndex, WireRoutes.PublicSearchCorpus };

        await InjectFailure("publish");
        var publish = new ArticleCommand(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        await Write(server.Client, session.Token, WireRoutes.Publish, publish, ct, HttpStatusCode.ServiceUnavailable);
        await AssertPublicClosed();
        Assert.Equal(1L, await Pending("publish"));
        await RemoveFailure();
        var published = Wire.DecodeDraft(await Write(server.Client, session.Token, WireRoutes.Publish, publish, ct));
        Assert.True(published.Published);
        Assert.Contains(marker, await server.Client.GetStringAsync(articlePath, ct));

        await InjectFailure("retract");
        var withdraw = new ArticleCommand(saved.Id, published.Revision, Guid.NewGuid(), "", "");
        await Write(server.Client, session.Token, WireRoutes.Retract, withdraw, ct, HttpStatusCode.ServiceUnavailable);
        await AssertPublicClosed();
        Assert.Equal(1L, await Pending("retract"));
        await RemoveFailure();

        using var ready = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (true)
        {
            using var response = await server.Client.GetAsync("/health/ready", ready.Token);
            if (response.StatusCode == HttpStatusCode.NoContent) break;
            await Task.Delay(100, ready.Token);
        }
        using var absent = await server.Client.GetAsync(articlePath, ct);
        Assert.Equal(HttpStatusCode.NotFound, absent.StatusCode);
        Assert.Equal(0L, await Pending("retract"));

        async Task InjectFailure(string action)
        {
            var sql = action == "publish"
                ? "alter table public.blog_outbox add constraint test_projection_failure check (kind <> 'publish' or processed_at is null)"
                : "alter table public.blog_outbox add constraint test_projection_failure check (kind <> 'retract' or processed_at is null)";
            await using var cmd = Store.Sql(database, null, sql);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        async Task RemoveFailure()
        {
            await using var cmd = Store.Sql(database, null, "alter table public.blog_outbox drop constraint test_projection_failure");
            await cmd.ExecuteNonQueryAsync(ct);
        }

        Task<object?> Pending(string action) =>
            FixtureSql.ScalarAsync(database, null, ct, "select count(*) from public.blog_outbox where article_id=$1 and kind=$2 and processed_at is null", saved.Id, action);

        async Task AssertPublicClosed()
        {
            foreach (var path in paths)
            {
                using var response = await server.Client.GetAsync(path, ct);
                Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.DoesNotContain(marker, await response.Content.ReadAsStringAsync(ct));
            }
        }
    }

    [PostgresFact]
    public async Task WithdrawingInvalidatesOldHttpRepresentationsAcrossRestart()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var session = await fixture.SignIn("http publisher", ct, canAuthor: true, minutes: 1);
        const string marker = "public replacement unique marker";
        int articleId;
        string publishedGeneration;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var saved = Wire.DecodeDraft(await Write(server.Client, session.Token, WireRoutes.Save,
                new(0, 0, Guid.NewGuid(), "Snapshot <check>", $"## Publication heading\n\n{marker}\n\n[Read source](/archive)"), ct));
            articleId = saved.Id;
            var published = Wire.DecodeDraft(await Write(server.Client, session.Token, WireRoutes.Publish,
                new(articleId, saved.Revision, Guid.NewGuid(), "", ""), ct));
            using var html = await server.Client.GetAsync($"/article/{articleId}", ct);
            var page = await html.Content.ReadAsStringAsync(ct);
            Assert.Equal(HttpStatusCode.OK, html.StatusCode);
            Assert.Contains("<h2>Publication heading</h2>", page);
            Assert.Contains("href=\"/archive\"", page);
            Assert.Contains(marker, page);
            Assert.True(html.Headers.CacheControl?.NoStore);
            publishedGeneration = Assert.Single(html.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            using var corpus = await server.Client.GetAsync(WireRoutes.PublicSearchCorpus, ct);
            Assert.Equal(HttpStatusCode.OK, corpus.StatusCode);
            Assert.Equal(publishedGeneration, Assert.Single(corpus.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            Assert.StartsWith("FSPK", System.Text.Encoding.ASCII.GetString((await corpus.Content.ReadAsByteArrayAsync(ct)).AsSpan(0, 4)));
            var binary = WireRoutes.PublicArticle.Replace("{id}", articleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            using var detail = await server.Client.GetAsync(binary, ct);
            Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
            Assert.Equal(publishedGeneration, Assert.Single(detail.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            _ = Aeds.Decode(await detail.Content.ReadAsByteArrayAsync(ct), FrameType.ArticleDetail).Length;
            await Write(server.Client, session.Token, WireRoutes.Retract,
                new(articleId, published.Revision, Guid.NewGuid(), "", ""), ct);
            await VerifyUnavailable(server.Client, binary);
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        var binaryAfterRestart = WireRoutes.PublicArticle.Replace("{id}", articleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        await VerifyUnavailable(restarted.Client, binaryAfterRestart);

        async Task VerifyUnavailable(HttpClient client, string binary)
        {
            foreach (var route in new[] { $"/article/{articleId}", binary })
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, route);
                request.Headers.IfNoneMatch.ParseAdd("*");
                using var response = await client.SendAsync(request, ct);
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.DoesNotContain(marker, await response.Content.ReadAsStringAsync(ct));
            }
            using var previous = await client.GetAsync($"{WireRoutes.PublicIndex}?page=1&generation={publishedGeneration}", ct);
            Assert.Equal(HttpStatusCode.Conflict, previous.StatusCode);
            Assert.DoesNotContain(marker, await previous.Content.ReadAsStringAsync(ct));
            using var staleCorpus = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={publishedGeneration}");
            using var staleResult = await client.SendAsync(staleCorpus, ct);
            Assert.Equal(HttpStatusCode.Conflict, staleResult.StatusCode);
            using var current = await client.GetAsync(WireRoutes.PublicIndex, ct);
            Assert.Equal(HttpStatusCode.OK, current.StatusCode);
            Assert.NotEqual(publishedGeneration, Assert.Single(current.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        }
    }

    private static async Task<byte[]> Write(HttpClient client, string token, string route, ArticleCommand command, CancellationToken ct,
        HttpStatusCode expected = HttpStatusCode.OK)
    {
        using var request = SiteAedsFixture.Request(HttpMethod.Post, route, Wire.EncodeArticleCommand(command),
            token, handle: null);
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(expected, response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    [PostgresFact]
    public async Task AFailedOutboxInsertRollsBackTheDraftAndAllowsAnExactRetry()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var session = await fixture.SignIn("transaction author", ct, canAuthor: true, minutes: 1);
        var command = new Edit(0, 0, Guid.NewGuid(), "Rollback fixture", "The draft must roll back with the event.");

        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var reject = Store.Sql(db, null, """
            alter table public.blog_outbox add constraint test_reject_save check (kind <> 'save')
            """)) await reject.ExecuteNonQueryAsync(ct);
        var error = await Assert.ThrowsAsync<PostgresException>(() => publications.Command(store, session.Token, ArticleAction.Save, command, ct));
        Assert.Equal("test_reject_save", error.ConstraintName);

        await using (var verify = Store.Sql(db, null, """
            select (select count(*) from public.article) + (select count(*) from public.article_revision)
                + (select count(*) from public.article_command) + (select count(*) from public.blog_outbox)
            """)) Assert.Equal(0L, await verify.ExecuteScalarAsync(ct));

        await FixtureSql.ExecuteAsync(db, null, ct, "alter table public.blog_outbox drop constraint test_reject_save");
        var saved = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.True(saved.Changed);
        var replay = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.Equal(saved.Article, replay.Article);
        Assert.False(replay.Changed);
        await BusinessAssert.Denied(Rejection.Conflict, () =>
            publications.Command(store, session.Token, ArticleAction.Save, command with { Body = "different request" }, ct));
    }

    [PostgresFact]
    public async Task ReadOnlyExpiredAndRevokedSessionsCannotCreateArticles()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        var edit = new Edit(0, 0, Guid.NewGuid(), "No unauthorized writes", "private");
        var reader = await fixture.SignIn("reader", ct, canAuthor: false, minutes: 1);
        var siteUser = await fixture.SignInSiteUser("site-reader", ct, minutes: 1);
        var author = await fixture.SignIn("author", ct, canAuthor: true, minutes: 1);
        var expiringAdmin = await fixture.SignIn("expiring-admin", ct, canAuthor: true, minutes: 1);

        await AssertDenied(reader.Token, Rejection.Unauthorized);
        await AssertDenied(siteUser.Token, Rejection.Unauthorized);
        await AssertDenied(null, Rejection.Unauthorized);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, "update public.admin_principal set generation=generation+1 where id=$1", author.Id));
        await AssertDenied(author.Token, Rejection.Unauthorized);
        Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, "update public.admin_session set expires_at=clock_timestamp()-interval '1 second' where principal_id=$1", expiringAdmin.Id));
        await AssertDenied(expiringAdmin.Token, Rejection.Unauthorized);
        Assert.Equal(0L, await FixtureSql.ScalarAsync(db, null, ct, "select count(*) from public.article"));

        Task AssertDenied(string? session, Rejection expected) => BusinessAssert.Denied(expected,
            () => publications.Command(store, session, ArticleAction.Save, edit, ct));
    }

    [PostgresFact]
    public async Task AStaleAuthoringHandleCannotCreateAnArticleInAnotherAccount()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var first = await fixture.SignIn("first author", ct, canAuthor: true, minutes: 1);
        var second = await fixture.SignIn("another author", ct, canAuthor: true, minutes: 1);
        var handle = first.Handle;
        var edit = new Edit(0, 0, Guid.NewGuid(), "Private draft", "Owner-only content.");

        await BusinessAssert.Denied(Rejection.Conflict, () =>
            publications.Command(store, second.Token, ArticleAction.Save, edit, ct, handle));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var verify = Store.Sql(db, null, """
            select (select count(*) from public.article) + (select count(*) from public.article_command)
                + (select count(*) from public.blog_outbox)
            """)) Assert.Equal(0L, await verify.ExecuteScalarAsync(ct));

        var saved = await publications.Command(store, first.Token, ArticleAction.Save, edit, ct, handle);
        Assert.Equal(first.Id, saved.Article.Owner);
    }

    [PostgresFact]
    public async Task PublicationOrdinalsArePerArticleAndSurviveWithdrawal()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        var session = await fixture.SignIn("publisher", ct, canAuthor: true, minutes: 1);
        var first = await CreateAndPublish("one");
        var second = await CreateAndPublish("two");
        Assert.NotEqual(first.Publication, second.Publication);
        Assert.Equal(1, first.PublicationNo);
        Assert.Equal(1, second.PublicationNo);

        var withdrawn = await publications.Command(store, session.Token, ArticleAction.Retract,
            new(first.Id, first.Revision, Guid.NewGuid(), "", ""), ct);
        Assert.Null(publications.Snapshot!.Article(first.Id));
        await publications.Command(store, session.Token, ArticleAction.Publish,
            new(first.Id, withdrawn.Article.Revision, Guid.NewGuid(), "", ""), ct);
        var republished = publications.Snapshot!.Article(first.Id)!;
        Assert.Equal(2, republished.PublicationNo);
        Assert.NotEqual(first.Publication, republished.Publication);
        Assert.Equal(second, publications.Snapshot!.Article(second.Id)!);

        async Task<FsusBlog.V2.Contracts.Article> CreateAndPublish(string title)
        {
            var draft = await publications.Command(store, session.Token, ArticleAction.Save,
                new(0, 0, Guid.NewGuid(), title, "Published body"), ct);
            await publications.Command(store, session.Token, ArticleAction.Publish,
                new(draft.Article.Id, draft.Article.Revision, Guid.NewGuid(), "", ""), ct);
            return publications.Snapshot!.Article(draft.Article.Id)!;
        }
    }

    [PostgresFact]
    public async Task PublishAndRetractUseOneAuthorizedDurableRevision()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var issue = await fixture.IssueTicket("site reader ticket", ct, canAuthor: false, minutes: 1);
        await store.SignIn(issue.Ticket, ct);
        await BusinessAssert.Denied(Rejection.Unauthorized, () => store.SignIn(issue.Ticket, ct));
        var session = await fixture.SignIn("original owner", ct, canAuthor: true, minutes: 1);
        var command = new Edit(0, 0, Guid.NewGuid(), "Saved title", "Saved Markdown body");
        var first = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var retry = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var saved = (await first).Article;
        Assert.Equal(saved, (await retry).Article);
        Assert.Null(publications.Snapshot!.Article(saved.Id));

        var next = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "Published title", "Published Markdown body");
        var newDraft = (await publications.Command(store, session.Token, ArticleAction.Save, next, ct)).Article;
        var oldPublication = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        await BusinessAssert.Denied(Rejection.Conflict, () =>
            publications.Command(store, session.Token, ArticleAction.Publish, oldPublication, ct));
        var publish = oldPublication with { ExpectedRevision = newDraft.Revision };
        var published = (await publications.Command(store, session.Token, ArticleAction.Publish, publish, ct)).Article;
        Assert.Equal(published.Revision, publications.Snapshot!.Article(saved.Id)!.Revision);

        var readOnlyAdmin = await fixture.SignIn("read-only admin", ct, canAuthor: false, minutes: 1);
        var retract = new Edit(saved.Id, published.Revision, Guid.NewGuid(), "", "");
        await BusinessAssert.Denied(Rejection.Unauthorized, () =>
            publications.Command(store, readOnlyAdmin.Token, ArticleAction.Retract, retract, ct));
        await BusinessAssert.Denied(Rejection.NotFound, () =>
            publications.Command(store, session.Token, ArticleAction.Retract, retract with { Id = 999_999 }, ct));
        await publications.Command(store, session.Token, ArticleAction.Retract, retract, ct);
        Assert.Null(publications.Snapshot!.Article(saved.Id));
        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var rows = Store.Sql(connection, null, "select count(*), count(distinct revision) from public.blog_outbox where article_id=$1", saved.Id);
        await using var result = await rows.ExecuteReaderAsync(ct);
        Assert.True(await result.ReadAsync(ct));
        Assert.Equal(4, result.GetInt64(0));
        Assert.Equal(4, result.GetInt64(1));
    }
}
