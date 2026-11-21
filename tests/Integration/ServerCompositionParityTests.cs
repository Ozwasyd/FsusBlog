using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ServerCompositionParityTests
{
    private static readonly PasskeyConfiguration AdminOrigin = new(new Uri("https://admin.example.test"), "admin.example.test");

    [Fact]
    public void ExceptionMappingCoversEveryKnownAndUnknownFailureConsistently()
    {
        Assert.Equal((400, "bad input", null), ServerHttp.MapException(new BusinessException(Rejection.Invalid, "bad input")));
        Assert.Equal((401, "login required", null), ServerHttp.MapException(new BusinessException(Rejection.Unauthorized, "login required")));
        Assert.Equal((403, "denied", null), ServerHttp.MapException(new BusinessException(Rejection.Forbidden, "denied")));
        Assert.Equal((404, "missing", null), ServerHttp.MapException(new BusinessException(Rejection.NotFound, "missing")));
        Assert.Equal((409, "stale", null), ServerHttp.MapException(new BusinessException(Rejection.Conflict, "stale")));
        Assert.Equal((500, "unexpected", null), ServerHttp.MapException(new BusinessException((Rejection)999, "unexpected")));

        Assert.Equal((400, "Invalid or expired article cursor.", "article_cursor_invalid"),
            ServerHttp.MapException(PublicListFailure.InvalidCursor()));
        Assert.Equal((422, "A saved article exceeds the heading parser's work limit.", null),
            ServerHttp.MapException(new AuthorHeadingBudgetException()));
        Assert.Equal((400, "Invalid AEDS payload.", null),
            ServerHttp.MapException(new ProtocolException("bad frame")));
        Assert.Equal((415, "Invalid HTTP request.", null),
            ServerHttp.MapException(new BadHttpRequestException("Expected AEDS.", 415)));
        Assert.Equal((503, "This operation is temporarily unavailable.", null),
            ServerHttp.MapException(new PublicUnavailableException()));
        Assert.Equal((503, "This operation is temporarily unavailable.", null),
            ServerHttp.MapException(new NpgsqlException("db down")));
        Assert.Equal((500, "An internal error occurred.", null),
            ServerHttp.MapException(new InvalidOperationException("boom")));
    }

    [Fact]
    public async Task RequestGuardEnforcesProxyLeaseOriginHeadersMutationAndFailClosedExceptions()
    {
        var logger = new RecordingLogger();

        // 1. Untrusted proxy peer fails closed with 403 before next()
        {
            var nextCalled = false;
            var ctx = CreateContext("https", "blog.example.test", "/api/v2/public/articles/1/10.aeds",
                IPAddress.Parse("198.51.100.7"));
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => { nextCalled = true; return Task.CompletedTask; },
                GuardOptions(trustLoopbackProxy: true), logger);
            Assert.False(nextCalled);
            Assert.Equal(403, ctx.Response.StatusCode);
            Assert.Equal(Aeds.ContentType, ctx.Response.ContentType);
            Assert.Equal("nosniff", ctx.Response.Headers.XContentTypeOptions.ToString());
            Assert.Equal("same-origin", ctx.Response.Headers["Referrer-Policy"].ToString());
            Assert.Equal(ServerHttp.ContentSecurityPolicy, ctx.Response.Headers.ContentSecurityPolicy.ToString());
            var error = DecodeApiError(ReadBody(ctx));
            Assert.Equal(403, error.Status);
            Assert.Contains("local reverse proxy", error.Message, StringComparison.OrdinalIgnoreCase);
        }

        // 2. Malformed forwarding headers return 400; HTTP forwarded proto returns 403
        {
            var ctx = CreateContext("http", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            ctx.Request.Headers["X-Forwarded-For"] = "not-an-ip";
            ctx.Request.Headers["X-Forwarded-Proto"] = "https";
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => Task.CompletedTask,
                GuardOptions(trustLoopbackProxy: true), logger);
            Assert.Equal(400, ctx.Response.StatusCode);
        }
        {
            var ctx = CreateContext("http", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            ctx.Request.Headers["X-Forwarded-For"] = "203.0.113.5";
            ctx.Request.Headers["X-Forwarded-Proto"] = "http";
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => Task.CompletedTask,
                GuardOptions(trustLoopbackProxy: true), logger);
            Assert.Equal(403, ctx.Response.StatusCode);
        }

        // 3. Lost lease fails closed with 503 + no-store and suppresses error log spam
        {
            var nextCalled = false;
            logger.Errors.Clear();
            var ctx = CreateContext("https", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => { nextCalled = true; return Task.CompletedTask; },
                GuardOptions(leaseCurrent: false), logger);
            Assert.False(nextCalled);
            Assert.Equal(503, ctx.Response.StatusCode);
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
            Assert.Empty(logger.Errors);
        }

        // 4. Non-admin origin hides admin & authoring routes with 404 + no-store before next()
        foreach (var hiddenPath in new[] { "/admin", "/admin/articles/write", "/api/v2/admin/identity/passkey/begin.aeds", "/api/v2/authoring/save.aeds" })
        {
            var nextCalled = false;
            var ctx = CreateContext("https", "blog.example.test", hiddenPath, IPAddress.Loopback);
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => { nextCalled = true; return Task.CompletedTask; },
                GuardOptions(adminIdentity: AdminOrigin), logger);
            Assert.False(nextCalled);
            Assert.Equal(404, ctx.Response.StatusCode);
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
            var expectedType = hiddenPath.StartsWith("/api", StringComparison.Ordinal) ? Aeds.ContentType : ServerHttp.TextContentType;
            Assert.StartsWith(expectedType, ctx.Response.ContentType, StringComparison.Ordinal);
        }

        // 5. Published media rejects non-GET/HEAD with 405 and Allow: GET, HEAD
        {
            var nextCalled = false;
            var ctx = CreateContext("https", "blog.example.test", $"{PublishedMediaEndpoints.PathPrefix}/1/1/abc",
                IPAddress.Loopback, HttpMethods.Post);
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => { nextCalled = true; return Task.CompletedTask; },
                GuardOptions(publicMediaEnabled: true), logger);
            Assert.False(nextCalled);
            Assert.Equal(405, ctx.Response.StatusCode);
            Assert.Equal("GET, HEAD", ctx.Response.Headers.Allow.ToString());
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
        }

        // 6. Cross-origin POST to /api fails closed with 403 before next()
        {
            var nextCalled = false;
            var ctx = CreateContext("https", "blog.example.test", WireRoutes.SignIn, IPAddress.Loopback, HttpMethods.Post);
            ctx.Request.Headers.Origin = "https://evil.example.test";
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => { nextCalled = true; return Task.CompletedTask; },
                GuardOptions(), logger);
            Assert.False(nextCalled);
            Assert.Equal(403, ctx.Response.StatusCode);
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
            Assert.False(string.IsNullOrEmpty(ctx.Response.Headers[WireHeaders.TraceId].ToString()));
        }

        // 7. Client-aborted cancellation is swallowed silently without 500 or error log
        {
            logger.Errors.Clear();
            using var abort = new CancellationTokenSource();
            var ctx = CreateContext("https", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            ctx.RequestAborted = abort.Token;
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () =>
            {
                abort.Cancel();
                throw new OperationCanceledException(abort.Token);
            }, GuardOptions(), logger);
            Assert.Equal(200, ctx.Response.StatusCode);
            Assert.Empty(ReadBody(ctx));
            Assert.Empty(logger.Errors);
        }

        // 8. PrivateRead endpoint metadata hides exceptions as 404 with empty body
        {
            var ctx = CreateContext("https", "admin.example.test", "/api/v2/media/content/1", IPAddress.Loopback);
            ctx.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(new MediaEndpoints.PrivateRead()), "private-read"));
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => throw new BusinessException(Rejection.Unauthorized, "nope"),
                GuardOptions(adminIdentity: AdminOrigin), logger);
            Assert.Equal(404, ctx.Response.StatusCode);
            Assert.Equal("private,no-store", ctx.Response.Headers.CacheControl.ToString());
            Assert.Equal("no-referrer", ctx.Response.Headers["Referrer-Policy"].ToString());
            Assert.Empty(ReadBody(ctx));
        }

        // 9. PublicListFailure preserves details in AEDS error payload
        {
            var ctx = CreateContext("https", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => throw PublicListFailure.InvalidCursor(),
                GuardOptions(), logger);
            Assert.Equal(400, ctx.Response.StatusCode);
            var error = DecodeApiError(ReadBody(ctx));
            Assert.Equal(400, error.Status);
            Assert.Equal("article_cursor_invalid", error.Details);
        }
    }

    [Fact]
    public void RequireCurrentSnapshotStripsGenerationHeaderAndFailsClosedWhenSnapshotChanges()
    {
        var pages = new WebPages("<html><head></head><body><!--fsus-public-content--></body></html>");
        var projection = new PublicProjection();
        var first = new PublicSnapshot(1, [], new([], [], []), pages, new PublicListCursor(TimeProvider.System),
            null, NullLogger.Instance, null, null, CancellationToken.None);
        var second = new PublicSnapshot(2, [], new([], [], []), pages, new PublicListCursor(TimeProvider.System),
            first, NullLogger.Instance, null, null, CancellationToken.None);
        projection.Replace(first);

        using var unusedSource = NpgsqlDataSource.Create("Host=127.0.0.1;Database=unused");
        var publications = new Publications(unusedSource, pages, NullLogger<Publications>.Instance, projection: projection);

        var ctx = CreateContext("https", "blog.example.test", "/", IPAddress.Loopback);
        var current = ServerHttp.Snapshot(ctx, publications);
        Assert.Same(first, current);
        Assert.Equal(first.GenerationHeader, ctx.Response.Headers[WireHeaders.SearchIndexGeneration].ToString());
        ServerHttp.RequireCurrentSnapshot(ctx, publications, current);

        projection.Replace(second);
        Assert.Throws<PublicUnavailableException>(() => ServerHttp.RequireCurrentSnapshot(ctx, publications, current));
        Assert.False(ctx.Response.Headers.ContainsKey(WireHeaders.SearchIndexGeneration));
    }

    [PostgresFact]
    public async Task EndpointTablePreservesRoutesMethodsRatePoliciesAndOmitsAdminWhenDisabled()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var dist = Directory.CreateTempSubdirectory("fsusblog-v2-routes-").FullName;
        try
        {
            await File.WriteAllTextAsync(Path.Combine(dist, "index.html"),
                "<!doctype html><html lang=\"en\"><head><title>Fsu's Blog</title></head><body><!--fsus-public-content--></body></html>", ct);

            // 1. Enabled admin & public origin
            var enabledEndpoints = await BuildEndpointSnapshots(fixture.ConnectionString, dist, new Dictionary<string, string?>
            {
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            }, ct);

            AssertEndpoint(enabledEndpoints, WireRoutes.PublicList, ["GET"], "query");
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicArchive, ["GET"], "query");
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicArticle, ["GET"], null);
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicRelatedReading, ["GET"], "query");
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicSearch, ["GET"], "query");
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicArticleHot, ["GET", "HEAD"], null);
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicIndex, ["GET"], null);
            AssertEndpoint(enabledEndpoints, WireRoutes.PublicSearchCorpus, ["GET", "HEAD"], null);
            AssertEndpoint(enabledEndpoints, WireRoutes.SignIn, ["POST"], "sign-in");
            AssertEndpoint(enabledEndpoints, WireRoutes.Session, ["GET"], null);
            AssertEndpoint(enabledEndpoints, WireRoutes.AuthoringSession, ["GET"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.SignOut, ["POST"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.Draft, ["GET"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.Save, ["POST"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.Publish, ["POST"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.Retract, ["POST"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.Delete, ["POST"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.Restore, ["POST"], "command");
            AssertEndpoint(enabledEndpoints, WireRoutes.AdminPasskeyBegin, ["POST"], "admin-passkey");
            AssertEndpoint(enabledEndpoints, WireRoutes.AdminSession, ["GET"], "command");
            AssertEndpoint(enabledEndpoints, "/", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/article/{id:int}", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/archive", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/search", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/login", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/register", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/user", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/user/comments", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/user/identity/mfa", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/user/messagebox", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/health/ready", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/admin", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/admin/articles/write", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/admin/articles/edit/{id:int}", ["GET"], null);
            AssertEndpoint(enabledEndpoints, "/admin/canvas/{id:guid}", ["GET"], null);
            Assert.Contains(enabledEndpoints, endpoint => endpoint.Pattern == "/api/{**rest}");

            // 2. Explicitly disabled admin: no /admin* or /api/v2/admin/* endpoints registered
            var disabledEndpoints = await BuildEndpointSnapshots(fixture.ConnectionString, dist, new Dictionary<string, string?>
            {
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "",
            }, ct);

            Assert.DoesNotContain(disabledEndpoints, endpoint =>
                endpoint.Pattern.StartsWith("/admin", StringComparison.Ordinal) ||
                endpoint.Pattern.StartsWith("/api/v2/admin/", StringComparison.Ordinal));
            Assert.DoesNotContain(disabledEndpoints, endpoint => endpoint.RatePolicy == "admin-passkey");
            AssertEndpoint(disabledEndpoints, "/", ["GET"], null);
            AssertEndpoint(disabledEndpoints, WireRoutes.PublicList, ["GET"], "query");
            AssertEndpoint(disabledEndpoints, WireRoutes.SignIn, ["POST"], "sign-in");
            AssertEndpoint(disabledEndpoints, "/health/ready", ["GET"], null);
        }
        finally
        {
            Directory.Delete(dist, recursive: true);
        }
    }

    [PostgresFact]
    public async Task NonAdminOriginHidesAdminBeforeRateLimiterAndShellHeadersMatchContract()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));

        static void AttachOrigin(HttpRequestMessage request, string host)
        {
            request.Headers.Host = host;
            request.Headers.Add("X-Forwarded-Proto", "https");
            request.Headers.Add("X-Forwarded-For", "198.51.100.42");
        }

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
        }, request => AttachOrigin(request, "blog.example.test"));

        // 1. Burst > admin-passkey limit (8/min) from public origin: every response MUST be 404 (never 429)
        for (var i = 0; i < 12; i++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, WireRoutes.AdminPasskeyBegin);
            AttachOrigin(req, "blog.example.test");
            req.Headers.Add("Origin", "https://blog.example.test");
            req.Headers.Add("Sec-Fetch-Site", "same-origin");
            using var resp = await server.Client.SendAsync(req, ct);
            Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            Assert.True(resp.Headers.CacheControl?.NoStore);
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(resp.Headers.GetValues("Content-Security-Policy")));
            var err = DecodeApiError(await resp.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(404, err.Status);
        }

        for (var i = 0; i < 4; i++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "/admin/articles/write");
            AttachOrigin(req, "blog.example.test");
            using var resp = await server.Client.SendAsync(req, ct);
            Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            Assert.True(resp.Headers.CacheControl?.NoStore);
        }

        // 2. Real admin origin still has its full 8-request quota; 9th request gets 429
        for (var i = 0; i < 9; i++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, WireRoutes.AdminPasskeyBegin);
            AttachOrigin(req, "admin.example.test");
            req.Headers.Add("Origin", "https://admin.example.test");
            req.Headers.Add("Sec-Fetch-Site", "same-origin");
            using var resp = await server.Client.SendAsync(req, ct);
            if (i < 8)
                Assert.NotEqual(HttpStatusCode.TooManyRequests, resp.StatusCode);
            else
            {
                Assert.Equal(HttpStatusCode.TooManyRequests, resp.StatusCode);
                var err = DecodeApiError(await resp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal(429, err.Status);
            }
        }

        // 3. Admin/authoring document shells carry fsus-public-origin, noindex, no appearance CSS, and CSP
        foreach (var adminRoute in new[] { "/admin", "/admin/articles/write", "/admin/canvas" })
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, adminRoute);
            AttachOrigin(req, "admin.example.test");
            using var resp = await server.Client.SendAsync(req, ct);
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            Assert.True(resp.Headers.CacheControl?.NoStore);
            Assert.Equal("noindex", Assert.Single(resp.Headers.GetValues("X-Robots-Tag")));
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(resp.Headers.GetValues("Content-Security-Policy")));
            var html = await resp.Content.ReadAsStringAsync(ct);
            Assert.Contains("<meta name=\"fsus-public-origin\" content=\"https://blog.example.test\">", html, StringComparison.Ordinal);
            Assert.Contains("<meta name=\"robots\" content=\"noindex, follow\">", html, StringComparison.Ordinal);
            Assert.DoesNotContain("/site-appearance/", html, StringComparison.Ordinal);
            Assert.DoesNotContain("public-initial", html, StringComparison.Ordinal);
        }

        // 4. Public / reader / redirect / fallback shells match contract without leaking fsus-public-origin
        using (var homeReq = new HttpRequestMessage(HttpMethod.Get, "/"))
        {
            AttachOrigin(homeReq, "blog.example.test");
            using var home = await server.Client.SendAsync(homeReq, ct);
            Assert.Equal(HttpStatusCode.OK, home.StatusCode);
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(home.Headers.GetValues("Content-Security-Policy")));
            var html = await home.Content.ReadAsStringAsync(ct);
            Assert.Contains("public-initial", html, StringComparison.Ordinal);
            Assert.DoesNotContain("fsus-public-origin", html, StringComparison.Ordinal);
        }

        using (var commentsReq = new HttpRequestMessage(HttpMethod.Get, "/user/comments"))
        {
            AttachOrigin(commentsReq, "blog.example.test");
            using var comments = await server.Client.SendAsync(commentsReq, ct);
            Assert.Equal(HttpStatusCode.OK, comments.StatusCode);
            Assert.Equal("noindex, nofollow", Assert.Single(comments.Headers.GetValues("X-Robots-Tag")));
            Assert.DoesNotContain("fsus-public-origin", await comments.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        using (var userReq = new HttpRequestMessage(HttpMethod.Get, "/user"))
        {
            AttachOrigin(userReq, "blog.example.test");
            using var user = await server.Client.SendAsync(userReq, ct);
            Assert.Equal(HttpStatusCode.Redirect, user.StatusCode);
            Assert.Equal("/user/identity/mfa", user.Headers.Location?.OriginalString);
        }

        using (var unknownApiReq = new HttpRequestMessage(HttpMethod.Get, "/api/v2/does-not-exist.aeds"))
        {
            AttachOrigin(unknownApiReq, "blog.example.test");
            using var unknown = await server.Client.SendAsync(unknownApiReq, ct);
            Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
            var err = DecodeApiError(await unknown.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(404, err.Status);
            Assert.Equal("Unknown API route.", err.Message);
        }
    }

    [PostgresFact]
    public async Task SnapshotGenerationRetractionAndLeaseLossFailClosed()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var author = await fixture.SignIn("parity-author", ct, canAuthor: true);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // 1. Save & publish an article
        var draft = await SiteAedsFixture.SaveDraft(server.Client, author.Token, null, 0, 0,
            "Parity Snapshot Title", "Parity snapshot body content.", ct);
        using (var publishResp = await SiteAedsFixture.Send(server.Client, HttpMethod.Post, WireRoutes.Publish,
            Wire.EncodeArticleCommand(new(draft.Id, draft.Revision, Guid.NewGuid(), "", "")), author.Token, null, ct))
        {
            publishResp.EnsureSuccessStatusCode();
            draft = Wire.DecodeDraft(await publishResp.Content.ReadAsByteArrayAsync(ct));
        }

        string publishedGeneration;
        using (var articleResp = await server.Client.GetAsync($"/article/{draft.Id}", ct))
        {
            Assert.Equal(HttpStatusCode.OK, articleResp.StatusCode);
            publishedGeneration = Assert.Single(articleResp.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            Assert.Contains("Parity Snapshot Title", await articleResp.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        using (var indexResp = await server.Client.GetAsync($"{WireRoutes.PublicIndex}?generation={publishedGeneration}", ct))
        {
            Assert.Equal(HttpStatusCode.OK, indexResp.StatusCode);
        }

        // 2. Retract article -> generation advances, old generation returns 409, article returns 404
        using (var retractResp = await SiteAedsFixture.Send(server.Client, HttpMethod.Post, WireRoutes.Retract,
            Wire.EncodeArticleCommand(new(draft.Id, draft.Revision, Guid.NewGuid(), "", "")), author.Token, null, ct))
        {
            retractResp.EnsureSuccessStatusCode();
        }

        using (var staleIndex = await server.Client.GetAsync($"{WireRoutes.PublicIndex}?generation={publishedGeneration}", ct))
        {
            Assert.Equal(HttpStatusCode.Conflict, staleIndex.StatusCode);
        }

        using (var staleCorpus = await server.Client.GetAsync($"{WireRoutes.PublicSearchCorpus}?generation={publishedGeneration}", ct))
        {
            Assert.Equal(HttpStatusCode.Conflict, staleCorpus.StatusCode);
        }

        using (var missingHtml = await server.Client.GetAsync($"/article/{draft.Id}", ct))
        {
            Assert.Equal(HttpStatusCode.NotFound, missingHtml.StatusCode);
        }

        using (var missingWire = await server.Client.GetAsync(WireRoutes.PublicArticle.Replace("{id}", draft.Id.ToString()), ct))
        {
            Assert.Equal(HttpStatusCode.NotFound, missingWire.StatusCode);
        }

        // 3. Revoke PostgreSQL advisory lease connection -> server fails closed with 503 + no-store
        await using (var adminDb = await fixture.DataSource.OpenConnectionAsync(ct))
        await using (var killLease = new NpgsqlCommand("""
            select pg_terminate_backend(l.pid)
            from pg_catalog.pg_locks l
            join pg_catalog.pg_stat_activity s on s.pid = l.pid
            where l.locktype = 'advisory'
              and l.database = s.datid
              and s.datname = current_database()
              and l.objsubid = 1
              and ((l.classid::bigint << 32) | l.objid::bigint) = $1
              and l.mode = 'ExclusiveLock'
              and l.granted
            """, adminDb))
        {
            killLease.Parameters.AddWithValue(InstanceLease.OwnershipKey);
            var terminated = await killLease.ExecuteScalarAsync(ct);
            Assert.Equal(true, terminated);
        }

        HttpStatusCode readyStatus = HttpStatusCode.NoContent;
        for (var attempt = 0; attempt < 40 && readyStatus != HttpStatusCode.ServiceUnavailable; attempt++)
        {
            await Task.Delay(100, ct);
            using var probe = await server.Client.GetAsync("/health/ready", ct);
            readyStatus = probe.StatusCode;
        }
        Assert.Equal(HttpStatusCode.ServiceUnavailable, readyStatus);

        foreach (var path in new[] { "/", "/api/v2/public/articles/1/10.aeds", $"/article/{draft.Id}" })
        {
            using var resp = await server.Client.GetAsync(path, ct);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, resp.StatusCode);
            Assert.True(resp.Headers.CacheControl?.NoStore);
        }
    }

    private sealed record EndpointSnapshot(string Pattern, string[] Methods, string? RatePolicy);

    private static async Task<IReadOnlyList<EndpointSnapshot>> BuildEndpointSnapshots(
        string connectionString, string dist, Dictionary<string, string?> overrides, CancellationToken ct)
    {
        var builder = WebApplication.CreateBuilder();
        var config = new Dictionary<string, string?>
        {
            ["FSUSBLOG_DB"] = connectionString,
            ["FSUSBLOG_WEB_DIST"] = dist,
            ["Logging:LogLevel:Default"] = "Error",
        };
        foreach (var (key, value) in overrides) config[key] = value;
        builder.Configuration.AddInMemoryCollection(config);

        using var bootstrap = await ServerServices.ConfigureAsync(builder, ct);
        await using var app = builder.Build();
        ServerPipeline.UseRuntimeEvidence(app);
        using var stopLease = await ServerServices.InitializeRuntimeAsync(app, bootstrap);
        ServerPipeline.UseRequestPipeline(app, bootstrap);
        await ServerEndpoints.MapAsync(app, bootstrap);

        var sources = app.Services.GetServices<EndpointDataSource>().ToList();
        if (app is IEndpointRouteBuilder routeBuilder)
            sources.AddRange(routeBuilder.DataSources);

        return sources.Distinct()
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(endpoint => new EndpointSnapshot(
                endpoint.RoutePattern.RawText ?? "",
                endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods.OrderBy(m => m, StringComparer.Ordinal).ToArray() ?? [],
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName))
            .ToArray();
    }

    private static void AssertEndpoint(IReadOnlyList<EndpointSnapshot> endpoints, string pattern, string[] expectedMethods, string? expectedPolicy)
    {
        var normalizedExpected = expectedMethods.OrderBy(m => m, StringComparer.Ordinal).ToArray();
        var matches = endpoints.Where(e => e.Pattern == pattern).ToArray();
        Assert.NotEmpty(matches);
        Assert.Contains(matches, e => e.Methods.SequenceEqual(normalizedExpected) && e.RatePolicy == expectedPolicy);
    }

    private static RequestGuardOptions GuardOptions(
        bool leaseCurrent = true,
        PasskeyConfiguration? adminIdentity = null,
        bool trustLoopbackProxy = false,
        bool publicMediaEnabled = false) => new(
            LeaseIsCurrent: () => leaseCurrent,
            AdminIdentity: adminIdentity,
            TrustLoopbackProxy: trustLoopbackProxy,
            PublicMediaEnabled: publicMediaEnabled,
            HasPublicationProofs: false,
            SiteTraffic: null,
            TrafficOrigin: null);

    private static DefaultHttpContext CreateContext(string scheme, string host, string path, IPAddress remoteIp, string method = "GET")
    {
        var services = new ServiceCollection();
        services.AddLogging();
        var ctx = new DefaultHttpContext
        {
            RequestServices = services.BuildServiceProvider(),
        };
        ctx.Request.Scheme = scheme;
        ctx.Request.Host = new HostString(host);
        ctx.Request.Path = path;
        ctx.Request.Method = method;
        ctx.Connection.RemoteIpAddress = remoteIp;
        ctx.Response.Body = new MemoryStream();
        return ctx;
    }

    private static byte[] ReadBody(HttpContext ctx) => ((MemoryStream)ctx.Response.Body).ToArray();

    private static (int Status, string Message, string Details, string TraceId) DecodeApiError(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.ApiError);
        var status = BinaryPrimitives.ReadInt32LittleEndian(payload.Slice(WireLayouts.ErrorStatusOffset, 4));
        var message = ReadFixedText(payload[WireLayouts.ErrorMessageOffset..WireLayouts.ErrorDetailsOffset]);
        var details = ReadFixedText(payload[WireLayouts.ErrorDetailsOffset..WireLayouts.ErrorTraceIdOffset]);
        var traceId = ReadFixedText(payload[WireLayouts.ErrorTraceIdOffset..]);
        return (status, message, details, traceId);

        static string ReadFixedText(ReadOnlySpan<byte> slice)
        {
            var zero = slice.IndexOf((byte)0);
            return Encoding.UTF8.GetString(zero < 0 ? slice : slice[..zero]);
        }
    }

    private sealed class RecordingLogger : ILogger
    {
        internal List<string> Errors { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel >= LogLevel.Error) Errors.Add(formatter(state, exception));
        }
    }
}
