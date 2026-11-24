using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ServerCompositionParityTests
{
    private static readonly PasskeyConfiguration AdminOrigin = new(new Uri("https://admin.example.test"), "admin.example.test");

    [Fact]
    public void ExceptionMappingCoversEveryKnownAndUnknownFailureConsistently()
    {
        foreach (var (error, status, message, details) in new (Exception, int, string, string?)[]
        {
            (new BusinessException(Rejection.Invalid, "bad input"), 400, "bad input", null),
            (new BusinessException(Rejection.Unauthorized, "login required"), 401, "login required", null),
            (new BusinessException(Rejection.Forbidden, "denied"), 403, "denied", null),
            (new BusinessException(Rejection.NotFound, "missing"), 404, "missing", null),
            (new BusinessException(Rejection.Conflict, "stale"), 409, "stale", null),
            (new BusinessException((Rejection)999, "unexpected"), 500, "unexpected", null),
            (PublicListFailure.InvalidCursor(), 400, "Invalid or expired article cursor.", "article_cursor_invalid"),
            (new AuthorHeadingBudgetException(), 422, "A saved article exceeds the heading parser's work limit.", null),
            (new ProtocolException("bad frame"), 400, "Invalid AEDS payload.", null),
            (new BadHttpRequestException("Expected AEDS.", 415), 415, "Invalid HTTP request.", null),
            (new PublicUnavailableException(), 503, "This operation is temporarily unavailable.", null),
            (new NpgsqlException("db down"), 503, "This operation is temporarily unavailable.", null),
            (new InvalidOperationException("boom"), 500, "An internal error occurred.", null),
        })
            Assert.Equal((status, message, details), ServerHttp.MapException(error));
    }

    [Fact]
    public async Task RequestGuardEnforcesProxyLeaseOriginHeadersMutationAndFailClosedExceptions()
    {
        var logger = new RecordingLogger();

        async Task AssertShortCircuit(DefaultHttpContext ctx, RequestGuardOptions options, int expectedStatus)
        {
            var nextCalled = false;
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            }, options, logger);
            Assert.False(nextCalled);
            Assert.Equal(expectedStatus, ctx.Response.StatusCode);
        }

        async Task AssertForwardingRejected(string address, string protocol, int expectedStatus)
        {
            var ctx = CreateContext("http", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            ctx.Request.Headers["X-Forwarded-For"] = address;
            ctx.Request.Headers["X-Forwarded-Proto"] = protocol;
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => Task.CompletedTask,
                GuardOptions(trustLoopbackProxy: true), logger);
            Assert.Equal(expectedStatus, ctx.Response.StatusCode);
        }

        // 1. Untrusted proxy peer fails closed with 403 before next()
        {
            var ctx = CreateContext("https", "blog.example.test", "/api/v2/public/articles/1/10.aeds",
                IPAddress.Parse("198.51.100.7"));
            await AssertShortCircuit(ctx, GuardOptions(trustLoopbackProxy: true), 403);
            Assert.Equal(Aeds.ContentType, ctx.Response.ContentType);
            Assert.Equal("nosniff", ctx.Response.Headers.XContentTypeOptions.ToString());
            Assert.Equal("same-origin", ctx.Response.Headers["Referrer-Policy"].ToString());
            Assert.Equal(ServerHttp.ContentSecurityPolicy, ctx.Response.Headers.ContentSecurityPolicy.ToString());
            var error = SiteAedsFixture.DecodeApiError(ReadBody(ctx));
            Assert.Equal(403, error.Status);
            Assert.Contains("local reverse proxy", error.Message, StringComparison.OrdinalIgnoreCase);
        }

        // 2. Malformed forwarding headers return 400; HTTP forwarded proto returns 403
        await AssertForwardingRejected("not-an-ip", "https", 400);
        await AssertForwardingRejected("203.0.113.5", "http", 403);

        // 3. Lost lease fails closed with 503 + no-store and suppresses error log spam
        {
            logger.Errors.Clear();
            var ctx = CreateContext("https", "blog.example.test", "/api/v2/public/articles/1/10.aeds", IPAddress.Loopback);
            await AssertShortCircuit(ctx, GuardOptions(leaseCurrent: false), 503);
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
            Assert.Empty(logger.Errors);
        }

        // 4. Non-admin origin hides admin & authoring routes with 404 + no-store before next()
        foreach (var hiddenPath in new[] { "/admin", "/admin/articles/write", "/api/v2/admin/identity/passkey/begin.aeds", "/api/v2/authoring/save.aeds" })
        {
            var ctx = CreateContext("https", "blog.example.test", hiddenPath, IPAddress.Loopback);
            await AssertShortCircuit(ctx, GuardOptions(adminIdentity: AdminOrigin), 404);
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
            var expectedType = hiddenPath.StartsWith("/api", StringComparison.Ordinal) ? Aeds.ContentType : ServerHttp.TextContentType;
            Assert.StartsWith(expectedType, ctx.Response.ContentType, StringComparison.Ordinal);
        }

        // 5. Published media rejects non-GET/HEAD with 405 and Allow: GET, HEAD
        {
            var ctx = CreateContext("https", "blog.example.test", $"{PublishedMediaEndpoints.PathPrefix}/1/1/abc",
                IPAddress.Loopback, HttpMethods.Post);
            await AssertShortCircuit(ctx, GuardOptions(publicMediaEnabled: true), 405);
            Assert.Equal("GET, HEAD", ctx.Response.Headers.Allow.ToString());
            Assert.Equal("no-store", ctx.Response.Headers.CacheControl.ToString());
        }

        // 6. Cross-origin POST to /api fails closed with 403 before next()
        {
            var ctx = CreateContext("https", "blog.example.test", WireRoutes.SignIn, IPAddress.Loopback, HttpMethods.Post);
            ctx.Request.Headers.Origin = "https://evil.example.test";
            await AssertShortCircuit(ctx, GuardOptions(), 403);
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
            var error = SiteAedsFixture.DecodeApiError(ReadBody(ctx));
            Assert.Equal((400, "article_cursor_invalid"), (error.Status, error.Details));
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

            foreach (var (route, methods, policy) in new (string, string[], string?)[]
            {
                (WireRoutes.PublicList, ["GET"], "query"), (WireRoutes.PublicArchive, ["GET"], "query"),
                (WireRoutes.PublicArticle, ["GET"], null), (WireRoutes.PublicRelatedReading, ["GET"], "query"),
                (WireRoutes.PublicSearch, ["GET"], "query"), (WireRoutes.PublicArticleHot, ["GET", "HEAD"], null),
                (WireRoutes.PublicIndex, ["GET"], null), (WireRoutes.PublicSearchCorpus, ["GET", "HEAD"], null),
                (WireRoutes.SignIn, ["POST"], "sign-in"), (WireRoutes.Session, ["GET"], null),
                (WireRoutes.AuthoringSession, ["GET"], "command"), (WireRoutes.SignOut, ["POST"], "command"),
                (WireRoutes.Draft, ["GET"], "command"), (WireRoutes.AdminPasskeyBegin, ["POST"], "admin-passkey"),
                (WireRoutes.AdminSession, ["GET"], "command"),
            }) AssertEndpoint(enabledEndpoints, route, methods, policy);
            foreach (var route in new[] { WireRoutes.Save, WireRoutes.Publish, WireRoutes.Retract, WireRoutes.Delete, WireRoutes.Restore })
                AssertEndpoint(enabledEndpoints, route, ["POST"], "command");
            foreach (var route in new[]
            {
                "/", "/article/{id:int}", "/archive", "/search", "/login", "/register",
                "/user", "/user/comments", "/user/identity/mfa", "/user/messagebox", "/health/ready",
                "/admin", "/admin/articles/write", "/admin/articles/edit/{id:int}", "/admin/canvas/{id:guid}"
            }) AssertEndpoint(enabledEndpoints, route, ["GET"], null);
            Assert.Contains(enabledEndpoints, endpoint => endpoint.Pattern == "/api/{**rest}");

            var disabledEndpoints = await BuildEndpointSnapshots(fixture.ConnectionString, dist, new Dictionary<string, string?>
            {
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "",
            }, ct);

            Assert.DoesNotContain(disabledEndpoints, endpoint =>
                endpoint.Pattern.StartsWith("/admin", StringComparison.Ordinal) ||
                endpoint.Pattern.StartsWith("/api/v2/admin/", StringComparison.Ordinal));
            Assert.DoesNotContain(disabledEndpoints, endpoint => endpoint.RatePolicy == "admin-passkey");
            foreach (var (route, methods, policy) in new (string, string[], string?)[]
            {
                ("/", ["GET"], null), (WireRoutes.PublicList, ["GET"], "query"),
                (WireRoutes.SignIn, ["POST"], "sign-in"), ("/health/ready", ["GET"], null),
            }) AssertEndpoint(disabledEndpoints, route, methods, policy);
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

        async Task<HttpResponseMessage> SendGet(string path, string host = "blog.example.test")
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, path);
            AttachOrigin(req, host);
            return await server.Client.SendAsync(req, ct);
        }

        async Task<HttpResponseMessage> SendPasskey(string host)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, WireRoutes.AdminPasskeyBegin);
            AttachOrigin(req, host);
            req.Headers.Add("Origin", $"https://{host}");
            req.Headers.Add("Sec-Fetch-Site", "same-origin");
            return await server.Client.SendAsync(req, ct);
        }

        for (var i = 0; i < 12; i++)
        {
            using var resp = Expect(NotFound, await SendPasskey("blog.example.test"));
            Assert.True(resp.Headers.CacheControl?.NoStore);
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(resp.Headers.GetValues("Content-Security-Policy")));
            Assert.Equal(404, SiteAedsFixture.DecodeApiError(await resp.Content.ReadAsByteArrayAsync(ct)).Status);
        }

        for (var i = 0; i < 4; i++)
        {
            using var resp = Expect(NotFound, await SendGet("/admin/articles/write"));
            Assert.True(resp.Headers.CacheControl?.NoStore);
        }

        for (var i = 0; i < 9; i++)
        {
            using var resp = await SendPasskey("admin.example.test");
            if (i < 8) Assert.NotEqual(TooManyRequests, resp.StatusCode);
            else
            {
                Assert.Equal(TooManyRequests, resp.StatusCode);
                Assert.Equal(429, SiteAedsFixture.DecodeApiError(await resp.Content.ReadAsByteArrayAsync(ct)).Status);
            }
        }

        foreach (var adminRoute in new[] { "/admin", "/admin/articles/write", "/admin/canvas" })
        {
            using var resp = Ok(await SendGet(adminRoute, "admin.example.test"));
            Assert.True(resp.Headers.CacheControl?.NoStore);
            Assert.Equal("noindex", Assert.Single(resp.Headers.GetValues("X-Robots-Tag")));
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(resp.Headers.GetValues("Content-Security-Policy")));
            var html = await resp.Content.ReadAsStringAsync(ct);
            Assert.All(["<meta name=\"fsus-public-origin\" content=\"https://blog.example.test\">", "<meta name=\"robots\" content=\"noindex, follow\">"],
                expected => Assert.Contains(expected, html, StringComparison.Ordinal));
            Assert.All(["/site-appearance/", "public-initial"], forbidden => Assert.DoesNotContain(forbidden, html, StringComparison.Ordinal));
        }

        using (var home = Ok(await SendGet("/")))
        {
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(home.Headers.GetValues("Content-Security-Policy")));
            var html = await home.Content.ReadAsStringAsync(ct);
            Assert.Contains("public-initial", html, StringComparison.Ordinal);
            Assert.DoesNotContain("fsus-public-origin", html, StringComparison.Ordinal);
        }

        using (var comments = Ok(await SendGet("/user/comments")))
        {
            Assert.Equal("noindex, nofollow", Assert.Single(comments.Headers.GetValues("X-Robots-Tag")));
            Assert.DoesNotContain("fsus-public-origin", await comments.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        using (var user = Expect(Redirect, await SendGet("/user")))
            Assert.Equal("/user/identity/mfa", user.Headers.Location?.OriginalString);

        var err = SiteAedsFixture.DecodeApiError(await ExpectBytes(NotFound, SendGet("/api/v2/does-not-exist.aeds"), ct));
        Assert.Equal((404, "Unknown API route."), (err.Status, err.Message));
    }

    [PostgresFact]
    public async Task SnapshotGenerationRetractionAndLeaseLossFailClosed()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var author = await fixture.SignIn("parity-author", ct, canAuthor: true);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var draft = await SiteAedsFixture.SaveDraft(server.Client, author.Token, null, 0, 0,
            "Parity Snapshot Title", "Parity snapshot body content.", ct);
        draft = Wire.DecodeDraft(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, WireRoutes.Publish,
            Wire.EncodeArticleCommand(new(draft.Id, draft.Revision, Guid.NewGuid(), "", "")), author.Token, null, OK, ct));

        string publishedGeneration;
        using (var articleResp = Ok(await server.Client.GetAsync($"/article/{draft.Id}", ct)))
        {
            publishedGeneration = Assert.Single(articleResp.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            Assert.Contains("Parity Snapshot Title", await articleResp.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        await CheckStatusAsync(OK, server.Client.GetAsync($"{WireRoutes.PublicIndex}?generation={publishedGeneration}", ct));
        await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, WireRoutes.Retract,
            Wire.EncodeArticleCommand(new(draft.Id, draft.Revision, Guid.NewGuid(), "", "")), author.Token, null, OK, ct);

        foreach (var (path, status) in new[]
        {
            ($"{WireRoutes.PublicIndex}?generation={publishedGeneration}", Conflict),
            ($"{WireRoutes.PublicSearchCorpus}?generation={publishedGeneration}", Conflict),
            ($"/article/{draft.Id}", NotFound),
            (WireRoutes.PublicArticle.Replace("{id}", draft.Id.ToString()), NotFound)
        }) await CheckStatusAsync(status, server.Client.GetAsync(path, ct));

        Assert.True(await fixture.Scalar<bool>("""
            select pg_terminate_backend(l.pid) from pg_catalog.pg_locks l
            join pg_catalog.pg_stat_activity s on s.pid = l.pid
            where l.locktype = 'advisory' and l.database = s.datid and s.datname = current_database()
              and l.objsubid = 1 and ((l.classid::bigint << 32) | l.objid::bigint) = $1 and l.mode = 'ExclusiveLock' and l.granted
            """, InstanceLease.OwnershipKey));

        HttpStatusCode readyStatus = NoContent;
        for (var attempt = 0; attempt < 40 && readyStatus != ServiceUnavailable; attempt++)
        {
            await Task.Delay(100, ct);
            using var probe = await server.Client.GetAsync("/health/ready", ct);
            readyStatus = probe.StatusCode;
        }
        Assert.Equal(ServiceUnavailable, readyStatus);

        foreach (var path in new[] { "/", "/api/v2/public/articles/1/10.aeds", $"/article/{draft.Id}" })
        {
            using var resp = Expect(ServiceUnavailable, await server.Client.GetAsync(path, ct));
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
