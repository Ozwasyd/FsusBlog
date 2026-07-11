using System.Buffers.Binary;
using System.Net;
using System.Security.Claims;
using System.Text;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using NSubstitute;

namespace FsusBlog.Server.Tests.TestInfrastructure;

public static class EndpointContractApplication
{
    public static WebApplication Create()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddAuthorization();
        builder.Services.AddOutputCache();
        WebApplication app = builder.Build();
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapSecurityEndpoints();
        return app;
    }

    public static RouteEndpoint Find(
        IEndpointRouteBuilder application,
        string routePattern,
        string httpMethod)
    {
        RouteEndpoint[] matches = application.DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(endpoint => string.Equals(
                NormalizeRoute(endpoint.RoutePattern.RawText),
                NormalizeRoute(routePattern),
                StringComparison.Ordinal))
            .Where(endpoint => endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                .Contains(httpMethod, StringComparer.Ordinal) == true)
            .ToArray();

        return Assert.Single(matches);
    }

    private static string NormalizeRoute(string? route)
        => string.Concat('/', (route ?? string.Empty).Trim().TrimStart('/'));
}

public sealed class EndpointSecurityTestServerOptions
{
    public bool AccountBanned { get; init; }

    public int FixedIpPermitLimit { get; init; } = 100;

    public RiskDecisionKind RiskDecision { get; init; } = RiskDecisionKind.Challenge;

    public Func<string, bool> AdminStepUpProofValidator { get; init; } =
        static proof => string.Equals(proof, "admin-proof-valid", StringComparison.Ordinal);

    public Func<string, SecurityChallengeProofConsumeResult> RiskProofConsumer { get; init; } =
        static proof => proof switch
        {
            "risk-proof-valid" => SecurityChallengeProofConsumeResult.Success(CreateProofClaims()),
            "risk-proof-expired" => SecurityChallengeProofConsumeResult.Rejected("proof_expired"),
            "risk-proof-scope" => SecurityChallengeProofConsumeResult.Rejected("route_key_mismatch"),
            _ => SecurityChallengeProofConsumeResult.Rejected("proof_replayed_or_missing")
        };

    private static SecurityChallengeProofClaims CreateProofClaims()
        => new(
            EndpointSecurityTestServer.ChallengeId,
            EndpointSecurityTestServer.ChallengeKind,
            RiskActionNames.RecoveryKeyVerify,
            "recovery-key.verify",
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            DateTimeOffset.UtcNow.AddMinutes(-1),
            DateTimeOffset.UtcNow.AddMinutes(4),
            "test-nonce",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion);
}

public sealed class EndpointSecurityTestServer : IDisposable
{
    public const string ChallengeId = "018ff2fe-7a68-7cc0-9e6c-111111111111";
    public const string ChallengeKind = "sha256PowV1";
    public const string AccountSubjectHash = "4f88d848f31c5b367d4b606d8f3e4dc0ab85636094b93bc8bb3f0d2a6b2c5514";

    private readonly TestServer _server;

    private EndpointSecurityTestServer(
        TestServer server,
        IAdminPrincipalService adminPrincipals,
        IArticleEndpointService articles,
        IAuditEventService auditEvents,
        IUserSessionCommandService sessions,
        IPasskeyService passkeys,
        IPowService pow,
        ISecurityChallengeProofService riskProofs,
        ISecurityRiskScoreReader riskScores,
        CapturingEndpointRiskSink riskSink)
    {
        _server = server;
        AdminPrincipals = adminPrincipals;
        Articles = articles;
        AuditEvents = auditEvents;
        Sessions = sessions;
        Passkeys = passkeys;
        Pow = pow;
        RiskProofs = riskProofs;
        RiskScores = riskScores;
        RiskSink = riskSink;
    }

    public IAdminPrincipalService AdminPrincipals { get; }

    public IArticleEndpointService Articles { get; }

    public IAuditEventService AuditEvents { get; }

    public IUserSessionCommandService Sessions { get; }

    public IPasskeyService Passkeys { get; }

    public IPowService Pow { get; }

    public ISecurityChallengeProofService RiskProofs { get; }

    public ISecurityRiskScoreReader RiskScores { get; }

    public CapturingEndpointRiskSink RiskSink { get; }

    public HttpClient CreateClient() => _server.CreateClient();

    public static EndpointSecurityTestServer Create(EndpointSecurityTestServerOptions? options = null)
    {
        options ??= new EndpointSecurityTestServerOptions();
        var adminPrincipals = Substitute.For<IAdminPrincipalService>();
        adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                Arg.Any<long>(),
                Arg.Any<string>(),
                AdminSensitiveStepUpMetadata.DefaultAction,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(call => options.AdminStepUpProofValidator(call.ArgAt<string>(3)));

        var articles = Substitute.For<IArticleEndpointService>();
        articles.ClearTrashAsync(Arg.Any<CancellationToken>()).Returns(3);
        var auditEvents = Substitute.For<IAuditEventService>();
        auditEvents.RecordHighValueAsync(Arg.Any<AuditEvent>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        var sessions = Substitute.For<IUserSessionCommandService>();
        sessions.RevokeSessionAsync(
                42,
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        var passkeys = Substitute.For<IPasskeyService>();
        passkeys.BeginAssertionAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<(bool Success, string Message, PasskeyAuthBeginData? Data)>(
                (false, "passkey-handler-reached", null)));

        var pow = Substitute.For<IPowService>();
        pow.VerifyAsync(Arg.Any<IPowRequest>(), Arg.Any<string>(), Arg.Any<string?>())
            .Returns(true);

        var riskProofs = Substitute.For<ISecurityChallengeProofService>();
        riskProofs.ConsumeProofAsync(
                Arg.Any<SecurityChallengeProofConsumeRequest>(),
                Arg.Any<CancellationToken>())
            .Returns(call => options.RiskProofConsumer(
                call.ArgAt<SecurityChallengeProofConsumeRequest>(0).ProofToken));

        var riskScores = Substitute.For<ISecurityRiskScoreReader>();
        riskScores.GetRiskScoreAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>())
            .Returns(50);
        var riskDecision = Substitute.For<IRiskDecisionService>();
        riskDecision.Decide(
                Arg.Any<RiskControlContext>(),
                Arg.Any<SecurityRiskPolicySnapshotV2>(),
                Arg.Any<int>())
            .Returns(call =>
            {
                RiskControlContext context = call.ArgAt<RiskControlContext>(0);
                return new RiskDecision(
                    options.RiskDecision,
                    context.ActionName,
                    context.RouteKey,
                    50,
                    50,
                    1,
                    options.RiskDecision is RiskDecisionKind.Challenge or RiskDecisionKind.StepUp
                        ? [ChallengeKind]
                        : [],
                    SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
                    ["endpoint-test"]);
            });

        var riskSink = new CapturingEndpointRiskSink();
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, AccountSubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(options.AccountBanned, "test-restricted", "private reason")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            0,
            null,
            false,
            null,
            AccountSubjectHash: AccountSubjectHash)));
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));

        AntiCrawlerPolicySnapshot antiCrawler = CreateAntiCrawlerPolicy(options.FixedIpPermitLimit);
        var riskPolicy = Substitute.For<ISecurityRiskPolicyProvider>();
        riskPolicy.CurrentRiskPolicyV2.Returns(SecurityRiskPolicySnapshotV2Adapter.FromLegacy(antiCrawler));

        var builder = new WebHostBuilder()
            .UseEnvironment("Production")
            .ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?>
                {
                    ["CORS_ALLOWED_HOSTS"] = "https://console.example.test",
                    ["ASPNETCORE_ENVIRONMENT"] = "Production",
                    ["Jwt:SecretKey"] = "endpoint-security-test-secret-key-at-least-32-bytes",
                    ["Jwt:Issuer"] = "FsusBlogEndpointSecurityTests",
                    ["Jwt:Audience"] = "FsusBlogEndpointSecurityTests",
                    ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
                    ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Port=5432;Database=fsusblog_endpoint_security;Username=test;Password=test",
                    ["DataProtection:ApplicationName"] = "FsusBlog",
                    ["DataProtection:KeyRingPath"] = Path.Combine(
                        Path.GetTempPath(),
                        "fsusblog-endpoint-security-tests",
                        "data-protection"),
                    ["RateLimiting:AdminPermitLimit"] = options.FixedIpPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["RateLimiting:AdminQueueLimit"] = "0",
                    ["Security:Pow:BaseDifficulty"] = "1",
                    ["Security:Pow:MaxDifficulty"] = "1",
                    ["Security:IpHashKey"] = "endpoint-security-test-key"
                }))
            .ConfigureServices((context, services) =>
            {
                services.AddLogging();
                services
                    .AddFsusApiFoundation(context.Configuration)
                    .AddFsusRuntimeServices(context.Configuration)
                    .AddFsusRateLimiting();
                services.RemoveAll<IHostedService>();
                services.AddSingleton<IAntiCrawlerPolicyProvider>(new FixedAntiCrawlerPolicyProvider(antiCrawler));
                services.AddSingleton<IAedsEncoder, AedsEncoder>();
                services.AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>();
                services.AddSingleton(blacklist);
                services.AddSingleton(users);
                services.AddSingleton<IUnifiedCache>(cache);
                services.AddSingleton(pow);
                services.AddSingleton(new AdaptivePowGovernor(cache, context.Configuration));
                services.AddSingleton<ISecurityRiskSignalSink>(riskSink);
                services.AddSingleton(riskScores);
                services.AddSingleton(riskPolicy);
                services.AddSingleton<IRiskControlContextFactory>(
                    new RiskControlContextFactory(context.HostingEnvironment, context.Configuration));
                services.AddSingleton(riskDecision);
                services.AddSingleton(riskProofs);
                services.AddSingleton(adminPrincipals);
                services.AddSingleton(articles);
                services.AddSingleton(auditEvents);
                services.AddSingleton(sessions);
                services.AddSingleton(passkeys);
                services.AddTransient<CommentRiskActionFilter>();
                services.AddTransient<RequiresRiskControlFilter>();
                services.AddTransient<RequiresPowFilter>();
                services.AddTransient<RiskAwarePublicReadFilter>();
            })
            .Configure(app =>
            {
                app.UseMiddleware<ApiBinaryResponseMiddleware>();
                app.UseRouting();
                app.Use(ApplyTestRequestContextAsync);
                app.UseRateLimiter();
                app.UseMiddleware<BannedUserMiddleware>();
                app.UseAuthorization();
                app.UseEndpoints(static endpoints => endpoints.MapBinaryEndpoints());
            });

        return new EndpointSecurityTestServer(
            new TestServer(builder),
            adminPrincipals,
            articles,
            auditEvents,
            sessions,
            passkeys,
            pow,
            riskProofs,
            riskScores,
            riskSink);
    }

    public static void AddAdminPrincipal(
        HttpRequestMessage request,
        params string[] permissions)
    {
        request.Headers.Add("X-Test-Principal", "admin");
        if (permissions.Length > 0)
        {
            request.Headers.Add("X-Test-Permissions", string.Join(',', permissions));
        }
    }

    public static void AddAnonymousAccount(HttpRequestMessage request)
        => request.Headers.Add("X-Test-Principal", "anonymous-account");

    public static void AddRiskProof(HttpRequestMessage request, string proof)
    {
        request.Headers.Add(RequiresRiskControlFilter.ChallengeProofHeaderName, proof);
        request.Headers.Add(RequiresRiskControlFilter.ChallengeIdHeaderName, ChallengeId);
        request.Headers.Add(RequiresRiskControlFilter.ChallengeKindHeaderName, ChallengeKind);
        request.Headers.Add("X-Fsus-Device-Fp", "device-endpoint-test");
    }

    public static void AddPowProof(HttpRequestMessage request)
        => request.Headers.Add("X-Fsus-Pow-Proof", CreatePowProof());

    public static async Task<ErrorDetail> ReadErrorAsync(HttpResponseMessage response)
    {
        byte[] body = await response.Content.ReadAsByteArrayAsync();
        var encoder = new AedsEncoder();
        Result<AedsDecodeResult> decoded = encoder.TryDecode(body);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        return PodBinaryCodec.ToErrorDetail(error);
    }

    public void Dispose() => _server.Dispose();

    private static async Task ApplyTestRequestContextAsync(HttpContext context, Func<Task> next)
    {
        string remoteIp = context.Request.Headers["X-Test-Remote-Ip"].ToString();
        context.Connection.RemoteIpAddress = IPAddress.TryParse(remoteIp, out IPAddress? parsed)
            ? parsed
            : IPAddress.Parse("198.51.100.17");

        string principal = context.Request.Headers["X-Test-Principal"].ToString();
        if (string.Equals(principal, "admin", StringComparison.Ordinal))
        {
            var claims = new List<Claim>
            {
                new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new("admin_id", "17"),
                new("admin_sid", "admin-session-17")
            };
            foreach (string permission in context.Request.Headers["X-Test-Permissions"].ToString()
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                claims.Add(new Claim(AdminPermissions.PermissionClaimType, permission));
            }

            context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "endpoint-test"));
        }
        else if (string.Equals(principal, "anonymous-account", StringComparison.Ordinal))
        {
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AccountSubjectHasher.ClaimType, AccountSubjectHash),
                new Claim("sid", "account-session-42")
            ],
            "endpoint-test"));
        }

        await next();
    }

    private static string CreatePowProof()
    {
        string[] fields = ["salt", "nonce", "signature", "browser-fingerprint"];
        int length = 17 + fields.Sum(static value => sizeof(ushort) + Encoding.UTF8.GetByteCount(value));
        byte[] bytes = new byte[length];
        bytes[0] = (byte)'F';
        bytes[1] = (byte)'P';
        bytes[2] = (byte)'O';
        bytes[3] = (byte)'W';
        bytes[4] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(5, sizeof(int)), 1);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(9, sizeof(long)), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        int offset = 17;
        foreach (string value in fields)
        {
            int byteCount = Encoding.UTF8.GetByteCount(value);
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset, sizeof(ushort)), (ushort)byteCount);
            offset += sizeof(ushort);
            Encoding.UTF8.GetBytes(value, bytes.AsSpan(offset, byteCount));
            offset += byteCount;
        }

        return Convert.ToBase64String(bytes);
    }

    private static AntiCrawlerPolicySnapshot CreateAntiCrawlerPolicy(int permitLimit)
        => new(
            "endpoint-security-test",
            DateTimeOffset.Parse("2026-07-11T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
            "test",
            "test",
            new AntiCrawlerPolicyOptions(
                SecuritySystemModes.Enforce,
                PublicReadChallengeEnabled: true,
                SearchCrawlerVerificationEnabled: true,
                SocialPreviewGuardEnabled: true,
                RiskScoringEnabled: true,
                EventPersistenceEnabled: true,
                DashboardAggregationEnabled: true,
                CidrAutoUpdateEnabled: false,
                IllegalPathHardAbortEnabled: true,
                RequireChallengeScore: 50,
                BlockScore: 100,
                MaxRiskScore: 200,
                DefaultRiskTtlSeconds: 600,
                ZeroRiskCacheTtlSeconds: 3,
                FixedIpPermitLimit: permitLimit,
                FixedIpQueueLimit: 0,
                VerifiedCrawlerFixedIpPermitLimit: permitLimit,
                PublicReadPermitLimit: permitLimit,
                PublicReadQueueLimit: 0,
                VerifiedCrawlerPublicReadPermitLimit: permitLimit,
                SocialPreviewPublicReadPermitLimit: permitLimit,
                ReadProofPermitLimit: permitLimit,
                CidrUpdateIntervalMinutes: 1440,
                CidrInitialDelaySeconds: 0,
                CidrMinUpdateIntervalMinutes: 30,
                GoogleCrawlerRangesUrl: "https://example.test/google.json",
                BingCrawlerRangesUrl: "https://example.test/bing.json",
                SnapshotPath: null,
                SocialPreviewAllowedPathPrefixes: ["/", "/article/"],
                BlockedUserAgentKeywords: ["curl"],
                SecurityChallengeReference: "security.pow"));

    private sealed class FixedAntiCrawlerPolicyProvider(AntiCrawlerPolicySnapshot current)
        : IAntiCrawlerPolicyProvider
    {
        public AntiCrawlerPolicySnapshot Current { get; } = current;
    }
}

public sealed class CapturingEndpointRiskSink : ISecurityRiskSignalSink
{
    private readonly List<SecurityRiskSignal> _signals = [];

    public IReadOnlyList<SecurityRiskSignal> Signals
    {
        get
        {
            lock (_signals)
            {
                return _signals.ToArray();
            }
        }
    }

    public ValueTask AddRiskAsync(
        SecurityRiskSignal signal,
        CancellationToken cancellationToken = default)
    {
        lock (_signals)
        {
            _signals.Add(signal);
        }

        return ValueTask.CompletedTask;
    }
}
