using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using System.Net;

public sealed class PublishingPostgresTests
{
    [PostgresFact]
    public async Task LostBackendDisablesPublicationAndWritesUntilAReplacementAcquiresOwnership()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var actor = await store.SignIn((await IssueTicket(fixture.DataSource, "lease owner", true, ct)).Token, ct);
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
        await using (var share = Store.Sql(inspection, admitted, "select pg_catalog.pg_advisory_xact_lock_shared($1,$2)",
            FsusBlogV2.Storage.PublicationLocks.HandoffClass, FsusBlogV2.Storage.PublicationLocks.HandoffObject))
            await share.ExecuteNonQueryAsync(ct);
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
            await using var ownership = Store.Sql(control, null, """
                select l.pid from pg_catalog.pg_locks l
                join pg_catalog.pg_database d on d.oid=l.database
                where l.locktype='advisory' and d.datname=current_database() and l.objsubid=1
                    and ((l.classid::bigint << 32) | l.objid::bigint)=$1 and l.mode='ExclusiveLock' and l.granted
                """, InstanceLease.OwnershipKey);
            return (int)(await ownership.ExecuteScalarAsync(ct))!;
        }

        async Task<bool> HandoffBlocked()
        {
            await using var waiting = Store.Sql(control, null, """
                select exists(select from pg_catalog.pg_locks l
                    join pg_catalog.pg_database d on d.oid=l.database
                    where l.locktype='advisory' and d.datname=current_database() and l.objsubid=2
                        and l.classid=$1::oid and l.objid=$2::oid and l.mode='ExclusiveLock' and not l.granted)
                """, FsusBlogV2.Storage.PublicationLocks.HandoffClass, FsusBlogV2.Storage.PublicationLocks.HandoffObject);
            return (bool)(await waiting.ExecuteScalarAsync(ct))!;
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
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "projection owner", true, ct)).Token, ct);
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

        async Task<object?> Pending(string action)
        {
            await using var cmd = Store.Sql(database, null,
                "select count(*) from public.blog_outbox where article_id=$1 and kind=$2 and processed_at is null", saved.Id, action);
            return await cmd.ExecuteScalarAsync(ct);
        }

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
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "http publisher", true, ct)).Token, ct);
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
        using var request = new HttpRequestMessage(HttpMethod.Post, route);
        request.Headers.Add("Cookie", $"fsus-v2-session={token}");
        request.Content = new ByteArrayContent(Wire.EncodeArticleCommand(command));
        request.Content.Headers.ContentType = new("application/octet-stream");
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(expected, response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    [PostgresFact]
    public async Task AFailedOutboxInsertRollsBackTheDraftAndAllowsAnExactRetry()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "transaction author", true, ct)).Token, ct);
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

        await using (var removeFault = Store.Sql(db, null, "alter table public.blog_outbox drop constraint test_reject_save"))
            await removeFault.ExecuteNonQueryAsync(ct);
        var saved = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.True(saved.Changed);
        var replay = await publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        Assert.Equal(saved.Article, replay.Article);
        Assert.False(replay.Changed);
        var mismatch = await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, session.Token, ArticleAction.Save, command with { Body = "different request" }, ct));
        Assert.Equal(Rejection.Conflict, mismatch.Rejection);
    }

    [PostgresFact]
    public async Task ReadOnlyExpiredAndRevokedSessionsCannotCreateArticles()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        var edit = new Edit(0, 0, Guid.NewGuid(), "No unauthorized writes", "private");
        var reader = await store.SignIn((await IssueTicket(fixture.DataSource, "reader", false, ct)).Token, ct);
        var author = await store.SignIn((await IssueTicket(fixture.DataSource, "author", true, ct)).Token, ct);

        await AssertDenied(reader.Token, Rejection.Forbidden);
        await AssertDenied(null, Rejection.Unauthorized);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var revoke = Store.Sql(db, null, "update public.blog_user set generation=generation+1 where id=$1", author.User.Id))
            Assert.Equal(1, await revoke.ExecuteNonQueryAsync(ct));
        await AssertDenied(author.Token, Rejection.Unauthorized);
        await using (var expire = Store.Sql(db, null, "update public.user_session set expires_at=clock_timestamp()-interval '1 second' where user_id=$1", reader.User.Id))
            Assert.Equal(1, await expire.ExecuteNonQueryAsync(ct));
        await AssertDenied(reader.Token, Rejection.Unauthorized);
        await using var count = Store.Sql(db, null, "select count(*) from public.article");
        Assert.Equal(0L, await count.ExecuteScalarAsync(ct));

        async Task AssertDenied(string? session, Rejection expected)
        {
            var denial = await Assert.ThrowsAsync<BusinessException>(() => publications.Command(store, session, ArticleAction.Save, edit, ct));
            Assert.Equal(expected, denial.Rejection);
        }
    }

    [PostgresFact]
    public async Task AStaleAuthoringHandleCannotCreateAnArticleInAnotherAccount()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance);
        var first = await store.SignIn((await IssueTicket(fixture.DataSource, "first author", true, ct)).Token, ct);
        var second = await store.SignIn((await IssueTicket(fixture.DataSource, "another author", true, ct)).Token, ct);
        var handle = FsusBlog.V2.Server.Sessions.SiteSessions.Id(first.User.Id, Store.TokenDigest(first.Token)!);
        var edit = new Edit(0, 0, Guid.NewGuid(), "Private draft", "Owner-only content.");

        var conflict = await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, second.Token, ArticleAction.Save, edit, ct, handle));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var verify = Store.Sql(db, null, """
            select (select count(*) from public.article) + (select count(*) from public.article_command)
                + (select count(*) from public.blog_outbox)
            """)) Assert.Equal(0L, await verify.ExecuteScalarAsync(ct));

        var saved = await publications.Command(store, first.Token, ArticleAction.Save, edit, ct, handle);
        Assert.Equal(first.User.Id, saved.Article.Owner);
    }

    [PostgresFact]
    public async Task PublicationOrdinalsArePerArticleAndSurviveWithdrawal()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        var session = await store.SignIn((await IssueTicket(fixture.DataSource, "publisher", true, ct)).Token, ct);
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
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var issue = await IssueTicket(fixture.DataSource, "original owner", true, ct);
        var session = await store.SignIn(issue.Token, ct);
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(() => store.SignIn(issue.Token, ct))).Rejection);
        var command = new Edit(0, 0, Guid.NewGuid(), "Saved title", "Saved Markdown body");
        var first = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var retry = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var saved = (await first).Article;
        Assert.Equal(saved, (await retry).Article);
        Assert.Null(publications.Snapshot!.Article(saved.Id));

        var next = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "Published title", "Published Markdown body");
        var newDraft = (await publications.Command(store, session.Token, ArticleAction.Save, next, ct)).Article;
        var oldPublication = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.Conflict, (await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, session.Token, ArticleAction.Publish, oldPublication, ct))).Rejection);
        var publish = oldPublication with { ExpectedRevision = newDraft.Revision };
        var published = (await publications.Command(store, session.Token, ArticleAction.Publish, publish, ct)).Article;
        Assert.Equal(published.Revision, publications.Snapshot!.Article(saved.Id)!.Revision);

        var outsider = await store.SignIn((await IssueTicket(fixture.DataSource, "other author", true, ct)).Token, ct);
        var retract = new Edit(saved.Id, published.Revision, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.NotFound, (await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, outsider.Token, ArticleAction.Retract, retract, ct))).Rejection);
        await publications.Command(store, session.Token, ArticleAction.Retract, retract, ct);
        Assert.Null(publications.Snapshot!.Article(saved.Id));
        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var rows = Store.Sql(connection, null, "select count(*), count(distinct revision) from public.blog_outbox where article_id=$1", saved.Id);
        await using var result = await rows.ExecuteReaderAsync(ct);
        Assert.True(await result.ReadAsync(ct));
        Assert.Equal(4, result.GetInt64(0));
        Assert.Equal(4, result.GetInt64(1));
    }

    private static async Task<(Guid Id, string Token)> IssueTicket(NpgsqlDataSource source, string name, bool author, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var secret = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        await using var connection = await source.OpenConnectionAsync(ct);
        await using (var user = Store.Sql(connection, null, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, author))
            await user.ExecuteNonQueryAsync(ct);
        await using (var ticket = Store.Sql(connection, null, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '1 minute')",
            System.Security.Cryptography.SHA256.HashData(secret), id)) await ticket.ExecuteNonQueryAsync(ct);
        return (id, Convert.ToHexStringLower(secret));
    }
}
