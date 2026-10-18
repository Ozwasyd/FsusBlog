using System.Buffers.Binary;
using System.Collections.ObjectModel;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Storage;
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
    private static readonly Lazy<RouteEndpoint[]> s_snapshotEndpoints = new(
        BuildEndpointSnapshot,
        LazyThreadSafetyMode.ExecutionAndPublication);

    public static WebApplication Create()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        AddContractServices(builder);
        WebApplication app = builder.Build();
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapSecurityEndpoints();
        return app;
    }

    public static EndpointContractSnapshot CreateSnapshot()
        => new(s_snapshotEndpoints.Value);

    private static RouteEndpoint[] BuildEndpointSnapshot()
    {
        WebApplication app = Create();
        try
        {
            return ((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>()
                .Select(CloneEndpoint)
                .ToArray();
        }
        finally
        {
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    private static RouteEndpoint CloneEndpoint(RouteEndpoint endpoint)
    {
        var builder = new RouteEndpointBuilder(
            endpoint.RequestDelegate ?? throw new InvalidOperationException($"Endpoint has no request delegate: {endpoint.DisplayName}"),
            endpoint.RoutePattern,
            endpoint.Order)
        {
            DisplayName = endpoint.DisplayName
        };
        foreach (object metadata in endpoint.Metadata)
        {
            builder.Metadata.Add(metadata);
        }

        return (RouteEndpoint)builder.Build();
    }

    public static void AddContractServices(WebApplicationBuilder builder)
    {
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
            ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=fsusblog_endpoint_contract;Username=test;Password=test",
            ["Jwt:SecretKey"] = "endpoint-contract-test-secret-key-at-least-32-bytes",
            ["Jwt:KeyVersion"] = "endpoint-contract-v1",
            ["Jwt:Issuer"] = "FsusBlogEndpointContractTests",
            ["Jwt:Audience"] = "FsusBlogEndpointContractTests",
            ["CORS_ALLOWED_HOSTS"] = "https://console.example.test",
            ["Security:IpHashKey"] = "endpoint-contract-ip-hash-key"
        });
        builder.Services
            .AddFsusApiFoundation(builder.Configuration)
            .AddFsusRuntimeServices(builder.Configuration)
            .AddFsusRateLimiting();
        builder.Services.RemoveAll<IHostedService>();
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

public sealed class EndpointContractSnapshot : IEndpointRouteBuilder, IDisposable, IAsyncDisposable
{
    private static readonly IServiceProvider s_emptyServices = new EmptyServiceProvider();
    private readonly ReadOnlyCollection<EndpointDataSource> _dataSources;

    internal EndpointContractSnapshot(RouteEndpoint[] endpoints)
    {
        var dataSource = new DefaultEndpointDataSource(endpoints.Cast<Endpoint>());
        _dataSources = Array.AsReadOnly<EndpointDataSource>([dataSource]);
    }

    public ICollection<EndpointDataSource> DataSources => _dataSources;

    public IServiceProvider ServiceProvider => s_emptyServices;

    public IApplicationBuilder CreateApplicationBuilder()
        => throw new NotSupportedException("Endpoint contract snapshots are immutable.");

    public void Dispose()
    {
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private sealed class EmptyServiceProvider : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }
}

public sealed class EndpointSecurityTestServerOptions
{
    public long AdminPrincipalId { get; init; } = 17;

    public Action<IServiceCollection>? ConfigureServices
    {
        get; init;
    }

    public bool AccountBanned
    {
        get; init;
    }

    public bool MapAuthoringEndpoints
    {
        get; init;
    }

    public bool MapFontThemeAdminEndpoints
    {
        get; init;
    }

    public int FixedIpPermitLimit { get; init; } = 100;

    public RiskDecisionKind RiskDecision { get; init; } = RiskDecisionKind.Challenge;

    public Func<string, bool> AdminStepUpProofValidator
    {
        get; init;
    } =
        static proof => string.Equals(proof, "admin-proof-valid", StringComparison.Ordinal);

    public Func<string, SecurityChallengeProofConsumeResult> RiskProofConsumer
    {
        get; init;
    } =
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

    private readonly WebApplication _application;
    private readonly string _dataProtectionRoot;
    private readonly object _issuedClientIpsGate = new();
    private readonly List<string> _issuedClientIps = [];
    private int _clientSequence;

    private EndpointSecurityTestServer(
        WebApplication application,
        IAdminPrincipalService adminPrincipals,
        IArticleEndpointService articles,
        IAuditEventService auditEvents,
        ICommentEndpointService comments,
        IUserSessionCommandService sessions,
        IPasskeyService passkeys,
        IPowService pow,
        ISecurityChallengeProofService riskProofs,
        ISecurityRiskScoreReader riskScores,
        CapturingEndpointRiskSink riskSink,
        IBlacklistService blacklist,
        IUserAccountReader users,
        ICacheStringReader cache,
        IRiskDecisionService riskDecision,
        string dataProtectionRoot)
    {
        _application = application;
        _dataProtectionRoot = dataProtectionRoot;
        AdminPrincipals = adminPrincipals;
        Articles = articles;
        AuditEvents = auditEvents;
        Comments = comments;
        Sessions = sessions;
        Passkeys = passkeys;
        Pow = pow;
        RiskProofs = riskProofs;
        RiskScores = riskScores;
        RiskSink = riskSink;
        Blacklist = blacklist;
        Users = users;
        Cache = cache;
        RiskDecision = riskDecision;
    }

    public IAdminPrincipalService AdminPrincipals
    {
        get;
    }

    public IArticleEndpointService Articles
    {
        get;
    }

    public IAuditEventService AuditEvents
    {
        get;
    }

    public ICommentEndpointService Comments
    {
        get;
    }

    public IUserSessionCommandService Sessions
    {
        get;
    }

    public IPasskeyService Passkeys
    {
        get;
    }

    public IPowService Pow
    {
        get;
    }

    public ISecurityChallengeProofService RiskProofs
    {
        get;
    }

    public ISecurityRiskScoreReader RiskScores
    {
        get;
    }

    public CapturingEndpointRiskSink RiskSink
    {
        get;
    }

    public IBlacklistService Blacklist
    {
        get;
    }

    public IUserAccountReader Users
    {
        get;
    }

    public ICacheStringReader Cache
    {
        get;
    }

    public IRiskDecisionService RiskDecision
    {
        get;
    }

    public IReadOnlyList<string> IssuedClientIps
    {
        get
        {
            lock (_issuedClientIpsGate)
            {
                return _issuedClientIps.ToArray();
            }
        }
    }

    public int ObservationCount
        => AdminPrincipals.ReceivedCalls().Count()
           + Articles.ReceivedCalls().Count()
           + AuditEvents.ReceivedCalls().Count()
           + Comments.ReceivedCalls().Count()
           + Sessions.ReceivedCalls().Count()
           + Passkeys.ReceivedCalls().Count()
           + Pow.ReceivedCalls().Count()
           + RiskProofs.ReceivedCalls().Count()
           + RiskScores.ReceivedCalls().Count()
           + Blacklist.ReceivedCalls().Count()
           + Users.ReceivedCalls().Count()
           + Cache.ReceivedCalls().Count()
           + RiskDecision.ReceivedCalls().Count()
           + RiskSink.Signals.Count;

    public HttpClient CreateClient()
    {
        int sequence = Interlocked.Increment(ref _clientSequence);
        string remoteIp = $"198.18.{((sequence - 1) / 254) % 256}.{((sequence - 1) % 254) + 1}";
        lock (_issuedClientIpsGate)
        {
            if (_issuedClientIps.Contains(remoteIp, StringComparer.Ordinal))
            {
                throw new InvalidOperationException($"Endpoint security test client IP was reused: {remoteIp}");
            }

            _issuedClientIps.Add(remoteIp);
        }

        HttpClient client = _application.GetTestClient();
        client.DefaultRequestHeaders.Add("X-Test-Remote-Ip", remoteIp);
        return client;
    }

    public void ResetObservations()
    {
        AdminPrincipals.ClearReceivedCalls();
        Articles.ClearReceivedCalls();
        AuditEvents.ClearReceivedCalls();
        Comments.ClearReceivedCalls();
        Sessions.ClearReceivedCalls();
        Passkeys.ClearReceivedCalls();
        Pow.ClearReceivedCalls();
        RiskProofs.ClearReceivedCalls();
        RiskScores.ClearReceivedCalls();
        Blacklist.ClearReceivedCalls();
        Users.ClearReceivedCalls();
        Cache.ClearReceivedCalls();
        RiskDecision.ClearReceivedCalls();
        RiskSink.Clear();
    }

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
        var comments = Substitute.For<ICommentEndpointService>();
        comments.DeleteCommentAsAccountAsync(Arg.Any<long>(), 42, Arg.Any<string>()).Returns(true);
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
        var accountStates = new AccountStateProjection(new EndpointAccountStateProjectionSource(users));
        var userSessionValidator = Substitute.For<IUserSessionValidationService>();
        userSessionValidator.ValidateAsync(Arg.Any<ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Valid));
        var cache = Substitute.For<ICacheStringReader>();
        cache.GetStringAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));

        AntiCrawlerPolicySnapshot antiCrawler = CreateAntiCrawlerPolicy(options.FixedIpPermitLimit);
        var riskPolicy = Substitute.For<ISecurityRiskPolicyProvider>();
        riskPolicy.CurrentRiskPolicyV2.Returns(SecurityRiskPolicySnapshotV2Adapter.FromLegacy(antiCrawler));

        string dataProtectionRoot = CreateDataProtectionRoot();
        const string DataProtectionCertificatePassword = "endpoint-security-test-certificate-password";
        string dataProtectionCertificatePath = CreateDataProtectionCertificate(
            dataProtectionRoot,
            DataProtectionCertificatePassword);
        var webOptions = new WebApplicationOptions { EnvironmentName = Environments.Production };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(webOptions);
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CORS_ALLOWED_HOSTS"] = "https://console.example.test",
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
            ["Jwt:SecretKey"] = "endpoint-security-test-secret-key-at-least-32-bytes",
            ["Jwt:Issuer"] = "FsusBlogEndpointSecurityTests",
            ["Jwt:Audience"] = "FsusBlogEndpointSecurityTests",
            ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
            ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Port=5432;Database=fsusblog_endpoint_security;Username=test;Password=test",
            ["DataProtection:ApplicationName"] = ReleaseStorageLayout.RequiredDataProtectionApplicationName,
            ["DataProtection:KeyRingPath"] = Path.Combine(
                        dataProtectionRoot,
                        "key-ring"),
            [DataProtectionKeyProtection.ModeKey] = "Certificate",
            [DataProtectionKeyProtection.CurrentCertificatePathKey] = dataProtectionCertificatePath,
            [DataProtectionKeyProtection.CurrentCertificatePasswordKey] = DataProtectionCertificatePassword,
            ["RateLimiting:AdminPermitLimit"] = options.FixedIpPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["RateLimiting:AdminQueueLimit"] = "0",
            ["Security:Pow:BaseDifficulty"] = "1",
            ["Security:Pow:MaxDifficulty"] = "1",
            ["Security:IpHashKey"] = "endpoint-security-test-key",
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "1",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = "ZW5kcG9pbnQtcmlzay1wc2V1ZG9ueW0ta2V5LTMyYnl0ZXMh",
            ["Moderation:Pepper"] = "endpoint-security-moderation-pepper-at-least-32-bytes"
        });
        builder.Services.AddLogging();
        builder.Services.AddRouting();
        builder.Services
            .AddFsusApiFoundation(builder.Configuration)
            .AddFsusRuntimeServices(builder.Configuration)
            .AddFsusRateLimiting();
        builder.Services.RemoveAll<IHostedService>();
        builder.Services.AddSingleton<IAntiCrawlerPolicyProvider>(new FixedAntiCrawlerPolicyProvider(antiCrawler));
        builder.Services.AddSingleton<IAedsEncoder, AedsEncoder>();
        builder.Services.AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>();
        builder.Services.AddSingleton(blacklist);
        builder.Services.AddSingleton(users);
        builder.Services.RemoveAll<IAccountStateProjection>();
        builder.Services.AddSingleton<IAccountStateProjection>(accountStates);
        builder.Services.AddSingleton<ICacheStringReader>(cache);
        builder.Services.AddSingleton(pow);
        builder.Services.AddSingleton(new AdaptivePowGovernor(cache, builder.Configuration));
        builder.Services.AddSingleton<ISecurityRiskSignalSink>(riskSink);
        builder.Services.AddSingleton(riskScores);
        builder.Services.AddSingleton(riskPolicy);
        builder.Services.AddSingleton<IRiskControlContextFactory>(
            new RiskControlContextFactory(builder.Environment, builder.Configuration));
        builder.Services.AddSingleton(riskDecision);
        builder.Services.AddSingleton(riskProofs);
        builder.Services.AddSingleton(adminPrincipals);
        builder.Services.AddSingleton(articles);
        builder.Services.AddSingleton(auditEvents);
        builder.Services.AddSingleton(comments);
        builder.Services.AddSingleton(sessions);
        builder.Services.AddSingleton(passkeys);
        builder.Services.AddSingleton(userSessionValidator);
        builder.Services.AddTransient<CommentRiskActionFilter>();
        builder.Services.AddTransient<RequiresRiskControlFilter>();
        builder.Services.AddTransient<RequiresPowFilter>();
        builder.Services.AddTransient<RiskAwarePublicReadFilter>();
        options.ConfigureServices?.Invoke(builder.Services);

        WebApplication app = builder.Build();
        app.UseMiddleware<ApiBinaryResponseMiddleware>();
        app.UseRouting();
        app.UseFsusEndpointMetadataHeaders();
        app.UseAuthentication();
        app.Use((context, next) => ApplyTestRequestContextAsync(context, next, options.AdminPrincipalId));
        app.UseRateLimiter();
        app.UseMiddleware<BannedUserMiddleware>();
        app.UseAuthorization();
        app.MapBinaryEndpoints();
        if (options.MapAuthoringEndpoints)
        {
            app.MapAuthoringEndpoints();
        }
        if (options.MapFontThemeAdminEndpoints)
        {
            app.MapFontAdminEndpoints();
            app.MapThemeAdminEndpoints();
        }
        app.StartAsync().GetAwaiter().GetResult();

        return new EndpointSecurityTestServer(
            app,
            adminPrincipals,
            articles,
            auditEvents,
            comments,
            sessions,
            passkeys,
            pow,
            riskProofs,
            riskScores,
            riskSink,
            blacklist,
            users,
            cache,
            riskDecision,
            dataProtectionRoot);
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

    public string IssueAnonymousAccountAccessToken(string sessionId = "account-session-42")
        => _application.Services.GetRequiredService<IJwtHelper>().GenerateAccessToken(
            new User
            {
                Id = 42,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                AccountSubjectHash = AccountSubjectHash
            },
            sessionId,
            mfaVerified: true).Token;

    public static void AddAnonymousAccountAccessToken(HttpRequestMessage request, string accessToken)
        => request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

    public static void AddRestrictedAnonymousAccount(HttpRequestMessage request)
    {
        AddAnonymousAccount(request);
        request.Headers.Add("X-Test-Session-Mode", UserSessionModes.ToClaimValue(UserSessionMode.Restricted));
    }

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

    public void Dispose()
    {
        try
        {
            _application.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        finally
        {
            TryDeleteDirectory(_dataProtectionRoot);
        }
    }

    private static async Task ApplyTestRequestContextAsync(HttpContext context, Func<Task> next, long adminPrincipalId)
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
                new("admin_id", adminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
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
            var claims = new List<Claim>
            {
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AccountSubjectHasher.ClaimType, AccountSubjectHash),
                new Claim("sid", "account-session-42")
            };
            string sessionMode = context.Request.Headers["X-Test-Session-Mode"].ToString();
            if (!string.IsNullOrWhiteSpace(sessionMode))
            {
                claims.Add(new Claim(UserSessionModes.ClaimType, sessionMode));
            }
            context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "endpoint-test"));
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

    private static string CreateDataProtectionRoot()
    {
        string path = Path.Combine(
            Path.GetTempPath(),
            "fsusblog-endpoint-security-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string CreateDataProtectionCertificate(string root, string password)
    {
        using RSA rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=FsusBlog Endpoint Security Tests",
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyEncipherment,
            critical: true));
        using X509Certificate2 certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-5),
            DateTimeOffset.UtcNow.AddDays(30));
        string path = Path.Combine(root, "data-protection.pfx");
        File.WriteAllBytes(path, certificate.Export(X509ContentType.Pkcs12, password));
        return path;
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
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

    private sealed class EndpointAccountStateProjectionSource(IUserAccountReader users)
        : IAccountStateProjectionSource
    {
        public async ValueTask<AccountStateSnapshot> LoadAsync(
            int accountId,
            CancellationToken cancellationToken)
        {
            UserAccountSnapshot? account = await users.GetAccountByIdAsync(accountId);
            if (!account.HasValue)
            {
                return new AccountStateSnapshot
                {
                    AccountId = accountId,
                    Generation = 0,
                    Knowledge = AccountStateKnowledge.Missing
                };
            }

            UserAccountSnapshot current = account.Value;
            return new AccountStateSnapshot
            {
                AccountId = current.Id,
                Generation = 1,
                Knowledge = current.Status == 2 || current.DeletedAt.HasValue
                    ? AccountStateKnowledge.Deleted
                    : AccountStateKnowledge.Present,
                AccountSubjectHash = current.AccountSubjectHash,
                Status = current.Status,
                BanReason = current.BanReason,
                DeletedAt = current.DeletedAt,
                IdentityKind = current.IdentityKind,
                RegistrationState = current.RegistrationState,
                MfaEnabled = current.MfaEnabled,
                PasskeyEnabled = current.PasskeyEnabled,
                RecoveryEnabled = current.RecoveryEnabled,
                PublicHandle = current.PublicHandle,
                AnonymousCredentialStatus = current.AnonymousCredentialStatus,
                AnonymousCredentialLevel = current.AnonymousCredentialLevel
            };
        }
    }

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

    public void Clear()
    {
        lock (_signals)
        {
            _signals.Clear();
        }
    }
}

public sealed class EndpointSecurityDefaultServerFixture : IDisposable
{
    public EndpointSecurityTestServer Server { get; } = EndpointSecurityTestServer.Create();

    public void Dispose() => Server.Dispose();
}
