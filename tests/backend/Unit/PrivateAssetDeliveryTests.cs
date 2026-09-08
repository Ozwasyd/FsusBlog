using System.Diagnostics;
using System.Security.Claims;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.PrivateAssets;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PrivateAssetDeliveryTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 4, 12, 0, 0, TimeSpan.Zero);
    private static readonly PrivateAssetAccessPurpose s_purpose = PrivateAssetAccessPurpose.Parse("invoice.download");

    [Theory]
    [InlineData(29, false)]
    [InlineData(30, true)]
    [InlineData(300, true)]
    [InlineData(600, true)]
    [InlineData(601, false)]
    public void TicketTtl_StartupValidatorEnforcesInclusiveBounds(int seconds, bool valid)
    {
        var options = new PrivateAssetTicketOptions { TimeToLive = TimeSpan.FromSeconds(seconds) };

        ValidateOptionsResult result = new PrivateAssetTicketOptionsValidator().Validate(null, options);

        Assert.Equal(valid, result.Succeeded);
    }

    [Fact]
    public void Purpose_RejectsEmptyWildcardAndUnboundedValues()
    {
        Assert.False(PrivateAssetAccessPurpose.TryParse(string.Empty, out _));
        Assert.False(PrivateAssetAccessPurpose.TryParse("*", out _));
        Assert.False(PrivateAssetAccessPurpose.TryParse("invoice.*", out _));
        Assert.False(PrivateAssetAccessPurpose.TryParse(new string('a', 65), out _));
        Assert.True(PrivateAssetAccessPurpose.TryParse("invoice.download", out _));
    }

    [Fact]
    public void Ticket_DefaultTtlAndPayloadContainRequiredFieldsWithoutPaths()
    {
        var time = new MutableTimeProvider(s_now);
        PrivateAssetTicketService tickets = CreateTickets(new EphemeralDataProtectionProvider(), time);
        AssetId assetId = AssetId.New();

        PrivateAssetTicketIssueResult result = tickets.Protect(assetId, s_purpose, "user:42");

        Assert.Equal(s_now.AddMinutes(5), result.ExpiresAtUtc);
        Assert.True(tickets.TryUnprotect(result.Ticket, out PrivateAssetTicketPayload? payload));
        Assert.NotNull(payload);
        Assert.Equal(assetId, payload.AssetId);
        Assert.Equal(s_purpose, payload.Purpose);
        Assert.Equal(s_now, payload.IssuedAtUtc);
        Assert.Equal("user:42", payload.SubjectPrincipalId);
        Assert.Equal(16, payload.Nonce.Length);
        Assert.DoesNotContain("/", result.Ticket, StringComparison.Ordinal);
        Assert.DoesNotContain("private", result.Ticket, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Ticket_TimeBoundariesTamperTruncateAndFutureIssueFailClosed()
    {
        IDataProtectionProvider provider = new EphemeralDataProtectionProvider();
        var time = new MutableTimeProvider(s_now);
        PrivateAssetTicketService issuer = CreateTickets(provider, time, TimeSpan.FromSeconds(30));
        PrivateAssetTicketIssueResult result = issuer.Protect(AssetId.New(), s_purpose, null);

        time.SetUtcNow(result.ExpiresAtUtc.AddTicks(-1));
        Assert.True(issuer.TryUnprotect(result.Ticket, out _));
        time.SetUtcNow(result.ExpiresAtUtc);
        Assert.False(issuer.TryUnprotect(result.Ticket, out _));

        string tampered = result.Ticket[..^1] + (result.Ticket[^1] == 'A' ? 'B' : 'A');
        Assert.False(issuer.TryUnprotect(tampered, out _));
        Assert.False(issuer.TryUnprotect(result.Ticket[..12], out _));

        var futureTime = new MutableTimeProvider(s_now.AddMinutes(1));
        string future = CreateTickets(provider, futureTime).Protect(AssetId.New(), s_purpose, null).Ticket;
        time.SetUtcNow(s_now);
        Assert.False(issuer.TryUnprotect(future, out _));
    }

    [Fact]
    public void Ticket_UnknownSchemaVersionFailsClosed()
    {
        IDataProtectionProvider provider = new EphemeralDataProtectionProvider();
        byte[] plaintext = PrivateAssetTicketService.Serialize(new PrivateAssetTicketPayload(
            AssetId.New(),
            s_purpose,
            s_now,
            s_now.AddMinutes(5),
            null,
            new byte[16]));
        plaintext[0] = 2;
        string ticket = WebEncoders.Base64UrlEncode(
            provider.CreateProtector(PrivateAssetTicketService.ProtectorPurpose).Protect(plaintext));

        Assert.False(CreateTickets(provider, new MutableTimeProvider(s_now)).TryUnprotect(ticket, out _));
    }

    [Fact]
    public void Ticket_RejectsEmptyAssetInvalidLifetimeAndMalformedUtf8()
    {
        IDataProtectionProvider provider = new EphemeralDataProtectionProvider();
        PrivateAssetTicketService tickets = CreateTickets(provider, new MutableTimeProvider(s_now));

        Assert.Throws<ArgumentException>(() => tickets.Protect(default, s_purpose, null));
        Assert.Throws<ArgumentException>(() => tickets.Protect(AssetId.New(), default, null));
        Assert.Throws<ArgumentException>(() => tickets.Protect(AssetId.New(), s_purpose, "\t"));

        foreach (TimeSpan ttl in new[] { TimeSpan.FromSeconds(29), TimeSpan.FromSeconds(601) })
        {
            string ticket = ProtectPayload(provider, new PrivateAssetTicketPayload(
                AssetId.New(),
                s_purpose,
                s_now,
                s_now.Add(ttl),
                null,
                new byte[16]));
            Assert.False(tickets.TryUnprotect(ticket, out _));
        }

        byte[] malformed = PrivateAssetTicketService.Serialize(new PrivateAssetTicketPayload(
            AssetId.New(),
            PrivateAssetAccessPurpose.Parse("aa"),
            s_now,
            s_now.AddMinutes(5),
            null,
            new byte[16]));
        malformed[34] = 0xc3;
        malformed[35] = 0x28;
        Assert.False(tickets.TryUnprotect(ProtectPlaintext(provider, malformed), out _));
    }

    [Fact]
    public void SharedKeyRing_AllowsSecondInstanceToValidate()
    {
        using var directory = new TemporaryDirectory();
        IDataProtectionProvider firstProvider = DataProtectionProvider.Create(
            new DirectoryInfo(directory.Path),
            configuration => configuration.SetApplicationName("FsusBlog"));
        string ticket = CreateTickets(firstProvider, new MutableTimeProvider(s_now))
            .Protect(AssetId.New(), s_purpose, "user:7").Ticket;
        IDataProtectionProvider secondProvider = DataProtectionProvider.Create(
            new DirectoryInfo(directory.Path),
            configuration => configuration.SetApplicationName("FsusBlog"));

        Assert.True(CreateTickets(secondProvider, new MutableTimeProvider(s_now)).TryUnprotect(ticket, out _));
    }

    [Fact]
    public async Task AccessService_BindsSubjectPurposeAndRequiresExplicitAnonymousGrant()
    {
        var metadata = new FakeMetadataSource();
        var subjectPolicy = new MutablePolicy(s_purpose, PrivateAssetAuthorizationGrant.Subject);
        PrivateAssetAccessService service = CreateAccess(metadata, [subjectPolicy]);
        ClaimsPrincipal user = Principal(42);

        PrivateAssetTicketIssueResult issued = Assert.IsType<PrivateAssetTicketIssueResult>(
            await service.IssueTicketAsync(metadata.AssetId, s_purpose, user));
        Assert.NotNull(await service.RedeemAsync(issued.Ticket, user));
        Assert.Null(await service.RedeemAsync(issued.Ticket, Principal(43)));
        Assert.Null(await CreateAccess(metadata, []).IssueTicketAsync(metadata.AssetId, s_purpose, new ClaimsPrincipal()));

        var anonymousPolicy = new MutablePolicy(s_purpose, PrivateAssetAuthorizationGrant.Anonymous);
        PrivateAssetAccessService anonymousService = CreateAccess(metadata, [anonymousPolicy]);
        PrivateAssetTicketIssueResult anonymousTicket = Assert.IsType<PrivateAssetTicketIssueResult>(
            await anonymousService.IssueTicketAsync(metadata.AssetId, s_purpose, new ClaimsPrincipal()));
        Assert.NotNull(await anonymousService.RedeemAsync(anonymousTicket.Ticket, new ClaimsPrincipal()));
    }

    [Fact]
    public async Task AccessService_RechecksPolicyAndAssetOnEveryRedemption()
    {
        var metadata = new FakeMetadataSource();
        var policy = new MutablePolicy(s_purpose, PrivateAssetAuthorizationGrant.Subject);
        PrivateAssetAccessService service = CreateAccess(metadata, [policy]);
        ClaimsPrincipal principal = Principal(9);
        PrivateAssetTicketIssueResult issued = Assert.IsType<PrivateAssetTicketIssueResult>(
            await service.IssueTicketAsync(metadata.AssetId, s_purpose, principal));
        int readsAfterIssue = metadata.FindCount;

        Assert.NotNull(await service.RedeemAsync(issued.Ticket, principal));
        policy.Grant = PrivateAssetAuthorizationGrant.Denied;
        Assert.Null(await service.RedeemAsync(issued.Ticket, principal));
        metadata.Available = false;
        Assert.Null(await service.RedeemAsync(issued.Ticket, principal));
        Assert.Equal(readsAfterIssue + 3, metadata.FindCount);
    }

    [Fact]
    public async Task AccessService_RevocationRaceFailsClosed()
    {
        var metadata = new FakeMetadataSource();
        var policy = new BlockingPolicy(s_purpose);
        PrivateAssetAccessService service = CreateAccess(metadata, [policy]);
        ClaimsPrincipal principal = Principal(11);
        policy.Block = false;
        PrivateAssetTicketIssueResult issued = Assert.IsType<PrivateAssetTicketIssueResult>(
            await service.IssueTicketAsync(metadata.AssetId, s_purpose, principal));
        policy.Block = true;

        Task<PrivateAssetAccessResult?> redemption = service.RedeemAsync(issued.Ticket, principal);
        await policy.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        policy.Revoked = true;
        policy.Release.TrySetResult();

        Assert.Null(await redemption);
    }

    [Fact]
    public async Task AccessService_RejectsWrongPurposeAndUsesOneMetadataReadPerRedemption()
    {
        IDataProtectionProvider provider = new EphemeralDataProtectionProvider();
        var time = new MutableTimeProvider(s_now);
        PrivateAssetTicketService tickets = CreateTickets(provider, time);
        var metadata = new FakeMetadataSource();
        var policy = new MutablePolicy(s_purpose, PrivateAssetAuthorizationGrant.Subject);
        var service = new PrivateAssetAccessService(metadata, [policy], tickets);
        ClaimsPrincipal principal = Principal(42);
        PrivateAssetTicketIssueResult issued = Assert.IsType<PrivateAssetTicketIssueResult>(
            await service.IssueTicketAsync(metadata.AssetId, s_purpose, principal));
        int metadataReadsBeforeRedeem = metadata.FindCount;
        int policyCallsBeforeRedeem = policy.CallCount;

        PrivateAssetAccessResult? result = await service.RedeemAsync(issued.Ticket, principal);

        Assert.NotNull(result);
        Assert.Null(result.Handle.Content);
        Assert.Equal(metadataReadsBeforeRedeem + 1, metadata.FindCount);
        Assert.Equal(policyCallsBeforeRedeem + 1, policy.CallCount);

        PrivateAssetAccessPurpose wrongPurpose = PrivateAssetAccessPurpose.Parse("invoice.preview");
        string wrongPurposeTicket = tickets.Protect(metadata.AssetId, wrongPurpose, "user:42").Ticket;
        Assert.Null(await service.RedeemAsync(wrongPurposeTicket, principal));
        Assert.Equal(metadataReadsBeforeRedeem + 1, metadata.FindCount);
    }

    [Fact]
    public async Task Endpoint_AllFailuresAreBodylessIndistinguishable404AndRangeIs416()
    {
        IPrivateAssetTicketRedemptionService access = new DeniedAccessService();
        IPrivateAssetResponseWriter writer = new OpenRestyPrivateAssetResponseWriter();
        foreach (string ticket in new[] { "invalid", "expired", "unauthorized", "deleted", "missing" })
        {
            var context = new DefaultHttpContext();
            context.Response.Body = new MemoryStream();

            await PrivateAssetEndpoints.HandleAsync(context, ticket, access, writer, CancellationToken.None);

            Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
            Assert.Equal(0, context.Response.ContentLength);
            Assert.Equal(0, context.Response.Body.Length);
        }

        var rangeContext = new DefaultHttpContext();
        rangeContext.Request.Headers.Range = "bytes=0-1";
        rangeContext.Response.Body = new MemoryStream();
        await PrivateAssetEndpoints.HandleAsync(rangeContext, "opaque", access, writer, CancellationToken.None);
        Assert.Equal(StatusCodes.Status416RangeNotSatisfiable, rangeContext.Response.StatusCode);
        Assert.Equal(0, rangeContext.Response.Body.Length);
    }

    [Fact]
    public async Task Endpoint_TestServerAllowsOnlyGetAndHeadAndRejectsRange()
    {
        await using WebApplication app = await StartPrivateAssetAppAsync(
            new DeniedAccessService(),
            new OpenRestyPrivateAssetResponseWriter());
        TestServer server = app.GetTestServer();

        HttpContext get = await SendAsync(server, HttpMethods.Get, "opaque");
        HttpContext head = await SendAsync(server, HttpMethods.Head, "opaque");
        HttpContext post = await SendAsync(server, HttpMethods.Post, "opaque");
        HttpContext range = await SendAsync(server, HttpMethods.Get, "opaque", hasRange: true);

        Assert.Equal(StatusCodes.Status404NotFound, get.Response.StatusCode);
        Assert.Equal(StatusCodes.Status404NotFound, head.Response.StatusCode);
        Assert.Equal(StatusCodes.Status405MethodNotAllowed, post.Response.StatusCode);
        Assert.Equal(StatusCodes.Status416RangeNotSatisfiable, range.Response.StatusCode);
        Assert.Equal(0, get.Response.ContentLength);
        Assert.Equal(0, head.Response.ContentLength);
        Assert.Equal(0, range.Response.ContentLength);
        Assert.Equal("private,no-store", get.Response.Headers.CacheControl);
        RouteEndpoint route = Assert.Single(((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>());
        Assert.Equal("/assets/private/{ticket}", route.RoutePattern.RawText);
    }

    [Fact]
    public async Task Endpoint_TestServerFailureClassesAreIndistinguishable()
    {
        IDataProtectionProvider provider = new EphemeralDataProtectionProvider();
        var time = new MutableTimeProvider(s_now);
        PrivateAssetTicketService tickets = CreateTickets(provider, time, TimeSpan.FromSeconds(30));
        var metadata = new FakeMetadataSource();
        var policy = new MutablePolicy(s_purpose, PrivateAssetAuthorizationGrant.Subject);
        var access = new PrivateAssetAccessService(metadata, [policy], tickets);
        ClaimsPrincipal principal = Principal(42);
        string validTicket = Assert.IsType<PrivateAssetTicketIssueResult>(
            await access.IssueTicketAsync(metadata.AssetId, s_purpose, principal)).Ticket;
        string expiredTicket = Assert.IsType<PrivateAssetTicketIssueResult>(
            await access.IssueTicketAsync(metadata.AssetId, s_purpose, principal)).Ticket;
        var store = new FakeStore(assetId: metadata.AssetId) { Available = false };
        await using WebApplication app = await StartPrivateAssetAppAsync(
            access,
            new KestrelPrivateAssetResponseWriter(store));
        TestServer server = app.GetTestServer();
        var responses = new List<HttpContext>();

        responses.Add(await SendAsync(server, HttpMethods.Get, "invalid", userId: 42));
        time.SetUtcNow(s_now.AddSeconds(30));
        responses.Add(await SendAsync(server, HttpMethods.Get, expiredTicket, userId: 42));
        time.SetUtcNow(s_now);
        responses.Add(await SendAsync(server, HttpMethods.Get, validTicket, userId: 43));
        metadata.Available = false;
        responses.Add(await SendAsync(server, HttpMethods.Get, validTicket, userId: 42));
        metadata.Available = true;
        responses.Add(await SendAsync(server, HttpMethods.Get, validTicket, userId: 42));

        foreach (HttpContext response in responses)
        {
            Assert.Equal(StatusCodes.Status404NotFound, response.Response.StatusCode);
            Assert.Equal(0, response.Response.ContentLength);
            Assert.Equal("private,no-store", response.Response.Headers.CacheControl);
            Assert.Equal("no-cache", response.Response.Headers.Pragma);
            Assert.Equal("nosniff", response.Response.Headers.XContentTypeOptions);
        }
    }

    [Fact]
    public async Task ProductionWriter_SetsPrivateHeadersWithoutOpeningBody()
    {
        var context = new DefaultHttpContext();
        var writer = new OpenRestyPrivateAssetResponseWriter();
        PrivateAssetReadHandle handle = FakeStore.CreateHandle(AssetId.New());

        await writer.WriteAsync(context, handle);

        Assert.Equal("private,no-store", context.Response.Headers.CacheControl);
        Assert.Equal("no-cache", context.Response.Headers.Pragma);
        Assert.Equal("nosniff", context.Response.Headers.XContentTypeOptions);
        Assert.StartsWith(OpenRestyPrivateAssetResponseWriter.InternalLocationPrefix, context.Response.Headers["X-Accel-Redirect"]);
        Assert.Null(handle.Content);
        Assert.DoesNotContain(
            typeof(PrivateAssetAccessService).GetConstructors(
                System.Reflection.BindingFlags.Instance
                | System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic)
                .SelectMany(static constructor => constructor.GetParameters()),
            static parameter => parameter.ParameterType == typeof(IPrivateAssetStore));
    }

    [Fact]
    public async Task KestrelWriter_HeadDoesNotOpenBodyAndGetStreamsLargeContent()
    {
        byte[] content = new byte[2 * 1024 * 1024];
        Random.Shared.NextBytes(content);
        var store = new FakeStore(content);
        var writer = new KestrelPrivateAssetResponseWriter(store);
        PrivateAssetReadHandle handle = FakeStore.CreateHandle(store.AssetId, content.LongLength);
        var head = new DefaultHttpContext();
        head.Request.Method = HttpMethods.Head;

        await writer.WriteAsync(head, handle);

        Assert.Equal(0, store.OpenCount);
        Assert.Equal(content.LongLength, head.Response.ContentLength);

        var get = new DefaultHttpContext();
        get.Request.Method = HttpMethods.Get;
        get.Response.Body = new MemoryStream();
        await writer.WriteAsync(get, handle);
        Assert.Equal(1, store.OpenCount);
        Assert.Equal(content, ((MemoryStream)get.Response.Body).ToArray());
    }

    [Fact]
    public async Task KestrelWriter_PropagatesCancellationWithoutBufferingBody()
    {
        byte[] content = new byte[2 * 1024 * 1024];
        var store = new FakeStore(content);
        var writer = new KestrelPrivateAssetResponseWriter(store);
        PrivateAssetReadHandle handle = FakeStore.CreateHandle(store.AssetId, content.LongLength);
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Response.Body = new MemoryStream();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => writer.WriteAsync(context, handle, cancellation.Token));

        Assert.Equal(1, store.OpenCount);
        Assert.Equal(0, context.Response.Body.Length);
    }

    [Fact]
    public void TicketAndStorageKey_AreRedactedFromAuditAndLogPath()
    {
        const string Ticket = "super-secret-private-ticket";
        var context = new DefaultHttpContext();
        context.Request.Path = "/assets/private/" + Ticket;

        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(context);

        Assert.Equal(PrivateAssetRoutePrivacy.RedactedPath, snapshot.RequestPath);
        Assert.DoesNotContain(Ticket, snapshot.RequestPath, StringComparison.Ordinal);
        Assert.Equal(PrivateAssetRoutePrivacy.RedactedPath, PrivateAssetRoutePrivacy.RedactPath(context.Request.Path));

        using var activity = new Activity("GET /assets/private/" + Ticket);
        FsusObservabilityServiceCollectionExtensions.RedactPrivateAssetActivity(activity, context.Request);
        Assert.DoesNotContain(Ticket, activity.DisplayName, StringComparison.Ordinal);
        Assert.All(activity.Tags, tag => Assert.DoesNotContain(Ticket, tag.Value, StringComparison.Ordinal));
        Assert.Equal(PrivateAssetRoutePrivacy.RedactedPath, activity.GetTagItem("url.path"));
    }

    [Fact]
    public void ProductionTopology_BindsAppAndInternalAliasToOneHostRoot()
    {
        string root = RepositoryRoot();
        string compose = File.ReadAllText(Path.Combine(root, "ops/docker/docker-compose.production.yml"));
        string gateway = File.ReadAllText(Path.Combine(root, "ops/gateway/production-openresty.conf"));

        Assert.Contains("device: /var/lib/fsusblog/storage", compose, StringComparison.Ordinal);
        Assert.Contains("fsus-storage:/app/storage", compose, StringComparison.Ordinal);
        Assert.Contains("location ^~ /_fsus/private-assets/", gateway, StringComparison.Ordinal);
        Assert.Contains("internal;", gateway, StringComparison.Ordinal);
        Assert.Contains("alias /var/lib/fsusblog/storage/shared/assets/private/;", gateway, StringComparison.Ordinal);
        Assert.Contains("location ^~ /assets/private/", gateway, StringComparison.Ordinal);
        Assert.Contains("access_log off;", gateway, StringComparison.Ordinal);
    }

    [Fact]
    public void DeliveryBoundary_BusinessModulesCannotBypassTheAccessService()
    {
        string root = RepositoryRoot();
        string modulesRoot = Path.Combine(root, "src/backend/Modules");
        string moduleSource = string.Join(
            '\n',
            Directory.GetFiles(modulesRoot, "*.cs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        foreach (string forbidden in new[]
        {
            "PrivateAssetTicketService",
            "AssetStorageKey",
            "PrivateAssetRoot",
            "X-Accel-Redirect"
        })
        {
            Assert.DoesNotContain(forbidden, moduleSource, StringComparison.Ordinal);
        }

        Assert.Equal(
            1,
            Directory.GetFiles(Path.Combine(root, "src/backend"), "*.cs", SearchOption.AllDirectories)
                .Count(path => File.ReadAllText(path).Contains(
                    "class PrivateAssetTicketService",
                    StringComparison.Ordinal)));
    }

    private static PrivateAssetTicketService CreateTickets(
        IDataProtectionProvider provider,
        TimeProvider time,
        TimeSpan? ttl = null)
        => new(
            provider,
            time,
            Options.Create(new PrivateAssetTicketOptions
            {
                TimeToLive = ttl ?? PrivateAssetTicketOptions.s_defaultTimeToLive
            }));

    private static PrivateAssetAccessService CreateAccess(
        FakeMetadataSource metadata,
        IEnumerable<IPrivateAssetAuthorizationPolicy> policies)
        => new(
            metadata,
            policies,
            CreateTickets(new EphemeralDataProtectionProvider(), new MutableTimeProvider(s_now)));

    private static string ProtectPayload(
        IDataProtectionProvider provider,
        PrivateAssetTicketPayload payload)
        => ProtectPlaintext(provider, PrivateAssetTicketService.Serialize(payload));

    private static string ProtectPlaintext(IDataProtectionProvider provider, byte[] plaintext)
        => WebEncoders.Base64UrlEncode(
            provider.CreateProtector(PrivateAssetTicketService.ProtectorPurpose).Protect(plaintext));

    private static async Task<WebApplication> StartPrivateAssetAppAsync(
        IPrivateAssetTicketRedemptionService access,
        IPrivateAssetResponseWriter writer)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration["AllowedHosts"] = "fsus.blog";
        builder.Services.AddRouting();
        builder.Services.AddSingleton(access);
        builder.Services.AddSingleton(writer);
        WebApplication app = builder.Build();
        app.UseRouting();
        app.UseFsusEndpointMetadataHeaders();
        app.Use(async (context, next) =>
        {
            if (long.TryParse(context.Request.Headers["X-Test-User"], out long userId))
            {
                context.User = Principal(userId);
            }

            await next();
        });
        app.MapPrivateAssetEndpoints();
        await app.StartAsync();
        return app;
    }

    private static Task<HttpContext> SendAsync(
        TestServer server,
        string method,
        string ticket,
        bool hasRange = false,
        long? userId = null)
        => server.SendAsync(context =>
        {
            context.Request.Method = method;
            context.Request.Host = new HostString("fsus.blog");
            context.Request.Path = "/assets/private/" + ticket;
            if (hasRange)
            {
                context.Request.Headers.Range = "bytes=0-1";
            }

            if (userId.HasValue)
            {
                context.Request.Headers["X-Test-User"] = userId.Value.ToString();
            }
        });

    private static ClaimsPrincipal Principal(long id)
        => new(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, id.ToString())], "test"));

    private static string RepositoryRoot()
        => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void SetUtcNow(DateTimeOffset value) => utcNow = value;
    }

    private sealed class MutablePolicy(
        PrivateAssetAccessPurpose purpose,
        PrivateAssetAuthorizationGrant grant) : IPrivateAssetAuthorizationPolicy
    {
        public PrivateAssetAccessPurpose Purpose { get; } = purpose;
        public PrivateAssetAuthorizationGrant Grant { get; set; } = grant;
        public int CallCount
        {
            get; private set;
        }

        public ValueTask<PrivateAssetAuthorizationGrant> AuthorizeAsync(
            PrivateAssetAuthorizationContext context,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            return ValueTask.FromResult(Grant);
        }
    }

    private sealed class BlockingPolicy(PrivateAssetAccessPurpose purpose) : IPrivateAssetAuthorizationPolicy
    {
        public PrivateAssetAccessPurpose Purpose { get; } = purpose;
        public bool Block
        {
            get; set;
        }
        public bool Revoked
        {
            get; set;
        }
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async ValueTask<PrivateAssetAuthorizationGrant> AuthorizeAsync(
            PrivateAssetAuthorizationContext context,
            CancellationToken cancellationToken = default)
        {
            if (Block)
            {
                Entered.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }

            return Revoked ? PrivateAssetAuthorizationGrant.Denied : PrivateAssetAuthorizationGrant.Subject;
        }
    }

    private sealed class FakeMetadataSource : IPrivateAssetMetadataSource
    {
        public AssetId AssetId { get; } = AssetId.New();
        public bool Available { get; set; } = true;
        public int FindCount
        {
            get; private set;
        }

        public Task<AssetRecord?> FindAsync(
            AssetId assetId,
            CancellationToken cancellationToken)
        {
            FindCount++;
            AssetRecord? record = Available && assetId == AssetId
                ? new AssetRecord(
                    AssetId,
                    "private",
                    LocalPrivateAssetStore.CreateStorageKey(AssetId, ".bin"),
                    "application/octet-stream",
                    ".bin",
                    3,
                    new string('a', 64),
                    null,
                    null,
                    42,
                    ContentAssetState.Active,
                    s_now,
                    s_now)
                : null;
            return Task.FromResult(record);
        }
    }

    private sealed class FakeStore : IPrivateAssetStore
    {
        private readonly byte[] _content;

        public FakeStore(byte[]? content = null, AssetId? assetId = null)
        {
            _content = content ?? [1, 2, 3];
            AssetId = assetId ?? AssetId.New();
        }

        public AssetId AssetId
        {
            get;
        }
        public bool Available { get; set; } = true;
        public int ValidateCount
        {
            get; private set;
        }
        public int OpenCount
        {
            get; private set;
        }

        public Task<AssetStorageKey> CreateAsync(
            PrivateAssetWriteRequest request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<PrivateAssetReadHandle?> OpenReadAsync(
            AssetId assetId,
            CancellationToken cancellationToken = default)
        {
            OpenCount++;
            PrivateAssetReadHandle? handle = Available
                ? CreateHandle(assetId, _content.LongLength, new MemoryStream(_content, writable: false))
                : null;
            return Task.FromResult(handle);
        }

        public Task<PrivateAssetReadHandle?> ValidateAsync(
            AssetId assetId,
            CancellationToken cancellationToken = default)
        {
            ValidateCount++;
            return Task.FromResult(Available ? CreateHandle(assetId, _content.LongLength) : null);
        }

        public Task DeleteAsync(AssetId assetId, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        internal static PrivateAssetReadHandle CreateHandle(
            AssetId assetId,
            long length = 3,
            Stream? content = null)
            => new(
                assetId,
                AssetStorageKey.Parse($"{assetId.ToString()[..2]}/{assetId}.bin"),
                "application/octet-stream",
                ".bin",
                length,
                new string('a', 64),
                content);
    }

    private sealed class DeniedAccessService : IPrivateAssetTicketRedemptionService
    {
        public Task<PrivateAssetAccessResult?> RedeemAsync(
            string ticket,
            ClaimsPrincipal principal,
            CancellationToken cancellationToken = default)
            => Task.FromResult<PrivateAssetAccessResult?>(null);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsus-private-ticket-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path
        {
            get;
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
