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
            (PublicSearchFailure.GenerationChanged(), 409, "The public search index changed. Start again from the first page.", "search_generation_changed"),
            (PublicSearchFailure.BudgetExceeded(), 503, "This search exceeded its work budget. Refine your query and try again.", "search_budget_exceeded"),
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
        const string sampleArticle = "/api/v2/public/articles/1/10.aeds";

        async Task AssertShortCircuit(DefaultHttpContext ctx, RequestGuardOptions options, int expectedStatus)
        {
            var nextCalled = false;
            await ServerPipeline.ExecuteRequestGuardAsync(ctx, () => { nextCalled = true; return Task.CompletedTask; }, options, logger);
            Assert.Equal((false, expectedStatus), (nextCalled, ctx.Response.StatusCode));
        }

        // 1. Untrusted proxy peer fails closed with 403 before next()
        var untrusted = CreateContext("https", "blog.example.test", sampleArticle, IPAddress.Parse("198.51.100.7"));
        await AssertShortCircuit(untrusted, GuardOptions(trustLoopbackProxy: true), 403);
        Assert.Equal((Aeds.ContentType, "nosniff", "same-origin", ServerHttp.ContentSecurityPolicy),
            (untrusted.Response.ContentType, untrusted.Response.Headers.XContentTypeOptions.ToString(),
                untrusted.Response.Headers["Referrer-Policy"].ToString(), untrusted.Response.Headers.ContentSecurityPolicy.ToString()));
        var proxyError = SiteAedsFixture.DecodeApiError(ReadBody(untrusted));
        Assert.Equal(403, proxyError.Status);
        Assert.Contains("local reverse proxy", proxyError.Message, StringComparison.OrdinalIgnoreCase);

        // 2. Malformed forwarding headers return 400; HTTP forwarded proto returns 403
        foreach (var (address, protocol, expected) in new[] { ("not-an-ip", "https", 400), ("203.0.113.5", "http", 403) })
        {
            var forwarded = CreateContext("http", "blog.example.test", sampleArticle, IPAddress.Loopback);
            forwarded.Request.Headers["X-Forwarded-For"] = address;
            forwarded.Request.Headers["X-Forwarded-Proto"] = protocol;
            await AssertShortCircuit(forwarded, GuardOptions(trustLoopbackProxy: true), expected);
        }

        // 3. Lost lease fails closed with 503 + no-store and suppresses error log spam
        logger.Errors.Clear();
        var lostLease = PublicCtx(sampleArticle);
        await AssertShortCircuit(lostLease, GuardOptions(leaseCurrent: false), 503);
        Assert.Equal("no-store", lostLease.Response.Headers.CacheControl.ToString());
        Assert.Empty(logger.Errors);

        // 4. Non-admin origin hides admin & authoring routes with 404 + no-store before next()
        foreach (var hiddenPath in new[] { "/admin", "/admin/articles/write", "/api/v2/admin/identity/passkey/begin.aeds", "/api/v2/authoring/save.aeds" })
        {
            var hidden = PublicCtx(hiddenPath);
            await AssertShortCircuit(hidden, GuardOptions(adminIdentity: AdminOrigin), 404);
            Assert.Equal("no-store", hidden.Response.Headers.CacheControl.ToString());
            Assert.StartsWith(hiddenPath.StartsWith("/api", StringComparison.Ordinal) ? Aeds.ContentType : ServerHttp.TextContentType,
                hidden.Response.ContentType, StringComparison.Ordinal);
        }

        // 5. Published media rejects non-GET/HEAD with 405 and Allow: GET, HEAD
        var badMethod = PublicCtx($"{PublishedMediaEndpoints.PathPrefix}/1/1/abc", HttpMethods.Post);
        await AssertShortCircuit(badMethod, GuardOptions(publicMediaEnabled: true), 405);
        Assert.Equal(("GET, HEAD", "no-store"), (badMethod.Response.Headers.Allow.ToString(), badMethod.Response.Headers.CacheControl.ToString()));

        // 6. Cross-origin POST to /api fails closed with 403 before next()
        var crossOrigin = PublicCtx(WireRoutes.SignIn, HttpMethods.Post);
        crossOrigin.Request.Headers.Origin = "https://evil.example.test";
        await AssertShortCircuit(crossOrigin, GuardOptions(), 403);
        Assert.Equal("no-store", crossOrigin.Response.Headers.CacheControl.ToString());
        Assert.False(string.IsNullOrEmpty(crossOrigin.Response.Headers[WireHeaders.TraceId].ToString()));

        // 7. Client-aborted cancellation is swallowed silently without 500 or error log
        logger.Errors.Clear();
        using var abort = new CancellationTokenSource();
        var aborted = PublicCtx(sampleArticle);
        aborted.RequestAborted = abort.Token;
        await ServerPipeline.ExecuteRequestGuardAsync(aborted, () => { abort.Cancel(); throw new OperationCanceledException(abort.Token); }, GuardOptions(), logger);
        Assert.Equal(200, aborted.Response.StatusCode);
        Assert.Empty(ReadBody(aborted));
        Assert.Empty(logger.Errors);

        // 8. PrivateRead endpoint metadata hides exceptions as 404 with empty body
        var privateRead = CreateContext("https", "admin.example.test", "/api/v2/media/content/1", IPAddress.Loopback);
        privateRead.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(new MediaEndpoints.PrivateRead()), "private-read"));
        await ServerPipeline.ExecuteRequestGuardAsync(privateRead, () => throw new BusinessException(Rejection.Unauthorized, "nope"),
            GuardOptions(adminIdentity: AdminOrigin), logger);
        Assert.Equal((404, "private,no-store", "no-referrer"),
            (privateRead.Response.StatusCode, privateRead.Response.Headers.CacheControl.ToString(), privateRead.Response.Headers["Referrer-Policy"].ToString()));
        Assert.Empty(ReadBody(privateRead));

        // 9. PublicListFailure preserves details in AEDS error payload
        var cursorError = PublicCtx(sampleArticle);
        await ServerPipeline.ExecuteRequestGuardAsync(cursorError, () => throw PublicListFailure.InvalidCursor(), GuardOptions(), logger);
        var error = SiteAedsFixture.DecodeApiError(ReadBody(cursorError));
        Assert.Equal((400, 400, "article_cursor_invalid"), (cursorError.Response.StatusCode, error.Status, error.Details));

        static DefaultHttpContext PublicCtx(string path, string method = "GET") =>
            CreateContext("https", "blog.example.test", path, IPAddress.Loopback, method);
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
        var distDir = Directory.CreateTempSubdirectory("fsusblog-v2-routes-");
        using var cleanup = new MediaFixture.DirectoryCleanup(distDir);
        await File.WriteAllTextAsync(Path.Combine(distDir.FullName, "index.html"),
            "<!doctype html><html lang=\"en\"><head><title>Fsu's Blog</title></head><body><!--fsus-public-content--></body></html>", ct);

        var enabledEndpoints = await BuildEndpointSnapshots(fixture.ConnectionString, distDir.FullName, "https://admin.example.test", ct);
        foreach (var (route, methods, policy) in new (string, string[], string?)[]
        {
            (WireRoutes.PublicList, ["GET"], "query"), (WireRoutes.PublicArchive, ["GET"], "query"),
            (WireRoutes.PublicArticle, ["GET"], null), (WireRoutes.PublicRelatedReading, ["GET"], "query"),
            (WireRoutes.PublicSearch, ["GET"], "query"), (WireRoutes.PublicSearchV2, ["GET"], "query"), (WireRoutes.PublicArticleHot, ["GET", "HEAD"], null),
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

        var disabledEndpoints = await BuildEndpointSnapshots(fixture.ConnectionString, distDir.FullName, "", ct);
        Assert.DoesNotContain(disabledEndpoints, endpoint =>
            endpoint.Pattern.StartsWith("/admin", StringComparison.Ordinal) ||
            endpoint.Pattern.StartsWith("/api/v2/admin/", StringComparison.Ordinal) ||
            endpoint.RatePolicy == "admin-passkey");
        foreach (var (route, methods, policy) in new (string, string[], string?)[]
        {
            ("/", ["GET"], null), (WireRoutes.PublicList, ["GET"], "query"),
            (WireRoutes.SignIn, ["POST"], "sign-in"), ("/health/ready", ["GET"], null),
        }) AssertEndpoint(disabledEndpoints, route, methods, policy);
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

        Task<HttpResponseMessage> Send(HttpMethod method, string path, string host = "blog.example.test", bool sameOrigin = false)
        {
            using var req = new HttpRequestMessage(method, path);
            AttachOrigin(req, host);
            if (sameOrigin)
            {
                req.Headers.Add("Origin", $"https://{host}");
                req.Headers.Add("Sec-Fetch-Site", "same-origin");
            }
            return server.Client.SendAsync(req, ct);
        }

        for (var i = 0; i < 12; i++)
        {
            using var resp = Expect(NotFound, await Send(HttpMethod.Post, WireRoutes.AdminPasskeyBegin, sameOrigin: true));
            Assert.Equal((true, ServerHttp.ContentSecurityPolicy, 404), (resp.Headers.CacheControl?.NoStore,
                Assert.Single(resp.Headers.GetValues("Content-Security-Policy")),
                SiteAedsFixture.DecodeApiError(await resp.Content.ReadAsByteArrayAsync(ct)).Status));
        }
        for (var i = 0; i < 4; i++)
        {
            using var resp = Expect(NotFound, await Send(HttpMethod.Get, "/admin/articles/write"));
            Assert.True(resp.Headers.CacheControl?.NoStore);
        }
        for (var i = 0; i < 9; i++)
        {
            using var resp = await Send(HttpMethod.Post, WireRoutes.AdminPasskeyBegin, "admin.example.test", sameOrigin: true);
            if (i < 8) Assert.NotEqual(TooManyRequests, resp.StatusCode);
            else Assert.Equal((TooManyRequests, 429), (resp.StatusCode, SiteAedsFixture.DecodeApiError(await resp.Content.ReadAsByteArrayAsync(ct)).Status));
        }

        foreach (var adminRoute in new[] { "/admin", "/admin/articles/write", "/admin/canvas" })
        {
            using var resp = Ok(await Send(HttpMethod.Get, adminRoute, "admin.example.test"));
            Assert.Equal((true, "noindex", ServerHttp.ContentSecurityPolicy), (resp.Headers.CacheControl?.NoStore,
                Assert.Single(resp.Headers.GetValues("X-Robots-Tag")), Assert.Single(resp.Headers.GetValues("Content-Security-Policy"))));
            var html = await resp.Content.ReadAsStringAsync(ct);
            Assert.All(["<meta name=\"fsus-public-origin\" content=\"https://blog.example.test\">", "<meta name=\"robots\" content=\"noindex, follow\">"],
                expected => Assert.Contains(expected, html, StringComparison.Ordinal));
            Assert.All(["/site-appearance/", "public-initial"], forbidden => Assert.DoesNotContain(forbidden, html, StringComparison.Ordinal));
        }

        using (var home = Ok(await Send(HttpMethod.Get, "/")))
        {
            Assert.Equal(ServerHttp.ContentSecurityPolicy, Assert.Single(home.Headers.GetValues("Content-Security-Policy")));
            var html = await home.Content.ReadAsStringAsync(ct);
            Assert.Contains("public-initial", html, StringComparison.Ordinal);
            Assert.DoesNotContain("fsus-public-origin", html, StringComparison.Ordinal);
        }
        using (var comments = Ok(await Send(HttpMethod.Get, "/user/comments")))
        {
            Assert.Equal("noindex, nofollow", Assert.Single(comments.Headers.GetValues("X-Robots-Tag")));
            Assert.DoesNotContain("fsus-public-origin", await comments.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }
        using (var user = Expect(Redirect, await Send(HttpMethod.Get, "/user")))
            Assert.Equal("/user/identity/mfa", user.Headers.Location?.OriginalString);

        var err = SiteAedsFixture.DecodeApiError(await ExpectBytes(NotFound, Send(HttpMethod.Get, "/api/v2/does-not-exist.aeds"), ct));
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
        draft = await SiteAedsFixture.ArticleCommand(server.Client, WireRoutes.Publish, author.Token, null,
            new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""), ct);

        string publishedGeneration;
        using (var articleResp = Ok(await server.Client.GetAsync($"/article/{draft.Id}", ct)))
        {
            publishedGeneration = Assert.Single(articleResp.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            Assert.Contains("Parity Snapshot Title", await articleResp.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        await CheckStatusAsync(OK, server.Client.GetAsync($"{WireRoutes.PublicIndex}?generation={publishedGeneration}", ct));
        await SiteAedsFixture.ArticleCommand(server.Client, WireRoutes.Retract, author.Token, null,
            new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""), ct);

        foreach (var (path, status) in new[]
        {
            ($"{WireRoutes.PublicIndex}?generation={publishedGeneration}", Conflict),
            ($"{WireRoutes.PublicSearchCorpus}?generation={publishedGeneration}", Conflict),
            ($"/article/{draft.Id}", NotFound),
            (WireRoutes.PublicArticle.Replace("{id}", draft.Id.ToString()), NotFound)
        }) await CheckStatusAsync(status, server.Client.GetAsync(path, ct));

        Assert.True(await fixture.TerminateAdvisoryOwner(InstanceLease.OwnershipKey));

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
        string connectionString, string dist, string adminOrigin, CancellationToken ct)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DB"] = connectionString,
            ["FSUSBLOG_WEB_DIST"] = dist,
            ["Logging:LogLevel:Default"] = "Error",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = adminOrigin,
        });

        using var bootstrap = await ServerServices.ConfigureAsync(builder, ct);
        await using var app = builder.Build();
        ServerPipeline.UseRuntimeEvidence(app);
        using var stopLease = await ServerServices.InitializeRuntimeAsync(app, bootstrap);
        ServerPipeline.UseRequestPipeline(app, bootstrap);
        await ServerEndpoints.MapAsync(app, bootstrap);

        var sources = app.Services.GetServices<EndpointDataSource>().ToList();
        if (app is IEndpointRouteBuilder routeBuilder) sources.AddRange(routeBuilder.DataSources);
        return sources.Distinct().SelectMany(source => source.Endpoints).OfType<RouteEndpoint>()
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

    private static RequestGuardOptions GuardOptions(bool leaseCurrent = true, PasskeyConfiguration? adminIdentity = null,
        bool trustLoopbackProxy = false, bool publicMediaEnabled = false) =>
        new(() => leaseCurrent, adminIdentity, trustLoopbackProxy, publicMediaEnabled, false, null, null);

    private static DefaultHttpContext CreateContext(string scheme, string host, string path, IPAddress remoteIp, string method = "GET")
    {
        var services = new ServiceCollection();
        services.AddLogging();
        var ctx = new DefaultHttpContext { RequestServices = services.BuildServiceProvider() };
        (ctx.Request.Scheme, ctx.Request.Host, ctx.Request.Path, ctx.Request.Method) = (scheme, new HostString(host), path, method);
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
