using System.Buffers;
using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthCookieExpiryFlowTests
{
    private static readonly DateTimeOffset UserAccessTokenExpiresAtUtc =
        DateTimeOffset.FromUnixTimeSeconds(1_956_528_000);
    private static readonly DateTimeOffset AdminAccessTokenExpiresAtUtc =
        DateTimeOffset.FromUnixTimeSeconds(1_956_531_600);

    [Theory]
    [InlineData(AuthExpiryFlow.AnonymousBootstrap)]
    [InlineData(AuthExpiryFlow.MfaLogin)]
    [InlineData(AuthExpiryFlow.Refresh)]
    [InlineData(AuthExpiryFlow.PasskeyLogin)]
    [InlineData(AuthExpiryFlow.AdminBootstrap)]
    [InlineData(AuthExpiryFlow.AdminLogin)]
    [InlineData(AuthExpiryFlow.LocalAuthFixture)]
    [Trait("Category", "SecurityStateMachine")]
    public async Task MappedAuthFlows_EmitExactIssuedAccessTokenExpiry(AuthExpiryFlow flow)
    {
        await using AuthCookieExpiryHarness harness = await AuthCookieExpiryHarness.CreateAsync(
            LocalAuthFixtureRefreshResult.Ready(string.Empty, string.Empty));

        using HttpResponseMessage response = await harness.SendAsync(flow);

        Assert.Equal(
            flow == AuthExpiryFlow.LocalAuthFixture ? HttpStatusCode.Found : HttpStatusCode.OK,
            response.StatusCode);
        Assert.Equal(
            flow is AuthExpiryFlow.AdminBootstrap or AuthExpiryFlow.AdminLogin
                ? AdminAccessTokenExpiresAtUtc
                : UserAccessTokenExpiresAtUtc,
            ReadCookieExpiry(
                response,
                flow is AuthExpiryFlow.AdminBootstrap or AuthExpiryFlow.AdminLogin
                    ? "AdminAccessToken"
                    : "AccessToken"));

        if (flow == AuthExpiryFlow.LocalAuthFixture)
        {
            Assert.Equal(AdminAccessTokenExpiresAtUtc, ReadCookieExpiry(response, "AdminAccessToken"));
        }
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public async Task LocalAuthFixtureRunnerFailure_EmitsNoCookies()
    {
        await using AuthCookieExpiryHarness harness = await AuthCookieExpiryHarness.CreateAsync(
            LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh failed"));

        using HttpResponseMessage response = await harness.SendLocalFixtureAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal(1, harness.LocalFixtureRunnerCallCount);
        Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
    }

    private static DateTimeOffset ReadCookieExpiry(HttpResponseMessage response, string cookieName)
    {
        string cookie = Assert.Single(
            response.Headers.GetValues("Set-Cookie"),
            value => value.StartsWith(cookieName + "=", StringComparison.Ordinal));
        string expires = Assert.Single(
            cookie.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            static attribute => attribute.StartsWith("expires=", StringComparison.OrdinalIgnoreCase));
        return DateTimeOffset.ParseExact(
            expires["expires=".Length..],
            "R",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public enum AuthExpiryFlow
    {
        AnonymousBootstrap,
        MfaLogin,
        Refresh,
        PasskeyLogin,
        AdminBootstrap,
        AdminLogin,
        LocalAuthFixture
    }

    private sealed class AuthCookieExpiryHarness : IAsyncDisposable
    {
        private const string FixtureSecret = "issue-1053-local-fixture-secret";
        private const string AccountSubjectHash =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        private readonly WebApplication _app;
        private readonly HttpClient _client;
        private readonly string _fixtureDirectory;
        private readonly ConfigurableLocalAuthFixtureRefreshRunner _localFixtureRunner;

        private AuthCookieExpiryHarness(
            WebApplication app,
            HttpClient client,
            string fixtureDirectory,
            ConfigurableLocalAuthFixtureRefreshRunner localFixtureRunner)
        {
            _app = app;
            _client = client;
            _fixtureDirectory = fixtureDirectory;
            _localFixtureRunner = localFixtureRunner;
        }

        public int LocalFixtureRunnerCallCount => _localFixtureRunner.CallCount;

        public static async Task<AuthCookieExpiryHarness> CreateAsync(
            LocalAuthFixtureRefreshResult configuredFixtureResult)
        {
            string fixtureDirectory = Path.Combine(
                Path.GetTempPath(),
                $"fsusblog-issue-1053-{Guid.NewGuid():N}");
            Directory.CreateDirectory(fixtureDirectory);
            string userStorageStatePath = Path.Combine(fixtureDirectory, "user.storage-state.json");
            string adminStorageStatePath = Path.Combine(fixtureDirectory, "admin.storage-state.json");
            WriteStorageState(
                userStorageStatePath,
                ("AccessToken", "fixture-user-access", UserAccessTokenExpiresAtUtc),
                ("RefreshToken", "fixture-user-refresh", null),
                ("SessionId", "fixture-user-session", null));
            WriteStorageState(
                adminStorageStatePath,
                ("AdminAccessToken", "fixture-admin-access", AdminAccessTokenExpiresAtUtc),
                ("AdminSessionId", "fixture-admin-session", null));

            LocalAuthFixtureRefreshResult fixtureResult = configuredFixtureResult.Success
                ? LocalAuthFixtureRefreshResult.Ready(userStorageStatePath, adminStorageStatePath)
                : configuredFixtureResult;
            var fixtureRunner = new ConfigurableLocalAuthFixtureRefreshRunner(fixtureResult);

            IAnonymousAccountBootstrapService anonymousBootstrap =
                Substitute.For<IAnonymousAccountBootstrapService>();
            IUserLoginWorkflowService loginWorkflow = Substitute.For<IUserLoginWorkflowService>();
            IUserSessionCommandService sessions = Substitute.For<IUserSessionCommandService>();
            IMfaChallengeService mfaChallenges = Substitute.For<IMfaChallengeService>();
            IPasskeyService passkeys = Substitute.For<IPasskeyService>();
            IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
            IPowService pow = Substitute.For<IPowService>();
            IUnifiedCache cache = Substitute.For<IUnifiedCache>();
            IHotArticlesCacheVersionProvider hotArticlesVersion =
                Substitute.For<IHotArticlesCacheVersionProvider>();
            ISecurityChallengeProofService challengeProofs =
                Substitute.For<ISecurityChallengeProofService>();

            UserAccountSnapshot account = new(
                42,
                0,
                null,
                false,
                null,
                PublicHandle: "quiet-reader",
                IdentityKind: AnonymousIdentityRuntime.AnonymousAccountKind,
                PasskeyEnabled: true,
                AccountSubjectHash: AccountSubjectHash);
            SessionTokenResponseDto sessionTokens = new(
                "issued-user-access",
                UserAccessTokenExpiresAtUtc,
                "issued-user-refresh",
                "issued-user-session",
                DateTime.SpecifyKind(UserAccessTokenExpiresAtUtc.UtcDateTime.AddDays(7), DateTimeKind.Utc));

            anonymousBootstrap.BootstrapAsync(
                    Arg.Any<string?>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(bool Success, string Message, UserAccountSnapshot? User)>(
                    (true, "ok", account)));
            loginWorkflow.CompleteLoginAsync(
                    Arg.Any<int>(),
                    Arg.Any<string>(),
                    Arg.Any<string?>(),
                    Arg.Any<string?>(),
                    Arg.Any<bool>(),
                    Arg.Any<bool>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(
                    bool Success,
                    string Message,
                    SessionTokenResponseDto? Data,
                    UserAccountSnapshot? User)>((true, "ok", sessionTokens, account)));
            loginWorkflow.VerifyMfaOrRecoveryCodeAsync(
                    Arg.Any<int>(),
                    Arg.Any<string?>(),
                    Arg.Any<string?>(),
                    Arg.Any<bool>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult(true));

            var mfaTicket = new MfaChallengeTicket
            {
                TicketId = "mfa-ticket",
                AccountId = account.Id,
                AccountSubjectHash = AccountSubjectHash,
                Type = "login",
                Action = "login",
                RememberMe = true
            };
            mfaChallenges.GetChallengeAsync("mfa-ticket")
                .Returns(Task.FromResult<MfaChallengeTicket?>(mfaTicket));
            mfaChallenges.ConsumeChallengeAsync("mfa-ticket").Returns(Task.CompletedTask);

            var passkeyUser = new User
            {
                Id = account.Id,
                IdentityKind = account.IdentityKind,
                AccountSubjectHash = AccountSubjectHash
            };
            passkeys.CompleteAssertionAsync(
                    Arg.Any<PasskeyLoginCompleteCoreModel>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(bool Success, string Message, User? User)>(
                    (true, "ok", passkeyUser)));

            var refreshTokens = new TokenResponseDto(
                "rotated-user-access",
                "rotated-user-refresh",
                UserAccessTokenExpiresAtUtc.UtcDateTime.AddDays(7),
                "rotated-user-session",
                UserAccessTokenExpiresAtUtc);
            sessions.RefreshTokenWithExpiryAsync(
                    "old-refresh",
                    "old-session",
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(bool Success, TokenResponseDto? Data, DateTime ExpiresAt)>(
                    (true, refreshTokens, UserAccessTokenExpiresAtUtc.UtcDateTime.AddDays(7))));

            var adminTokens = new AdminSessionTokens(
                "issued-admin-access",
                AdminAccessTokenExpiresAtUtc,
                "issued-admin-session",
                AdminAccessTokenExpiresAtUtc.UtcDateTime.AddHours(8));
            adminPrincipals.CompleteBootstrapPasskeyRegistrationAsync(
                    Arg.Any<string?>(),
                    Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                    Arg.Any<AdminAuthClientContext>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(bool Success, string Message, AdminSessionTokens? Tokens)>(
                    (true, "ok", adminTokens)));
            adminPrincipals.CompleteAdminAssertionAsync(
                    Arg.Any<PasskeyLoginCompleteCoreModel>(),
                    Arg.Any<AdminAuthClientContext>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(bool Success, string Message, AdminSessionTokens? Tokens)>(
                    (true, "ok", adminTokens)));

            pow.VerifyAsync(Arg.Any<IPowRequest>(), Arg.Any<string>(), Arg.Any<string?>())
                .Returns(Task.FromResult(true));
            cache.GetStringAsync(
                    CachePolicyId.SecurityPowRisk,
                    Arg.Any<string>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<string?>(null));

            var options = new WebApplicationOptions
            {
                EnvironmentName = Environments.Development
            };
            WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
            builder.WebHost.UseTestServer();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AuthCookies:AllowInsecureTransportCookies"] = "true",
                ["Security:Pow:BaseDifficulty"] = "1",
                ["Security:Pow:MaxDifficulty"] = "1",
                ["Security:IpHashKey"] = "issue-1053-ip-hash-key",
                [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "true",
                [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = FixtureSecret
            });

            builder.Services.AddLogging();
            builder.Services.AddAuthorization();
            builder.Services.AddRateLimiter(rateLimiting =>
                rateLimiting.AddFixedWindowLimiter("fixed_ip", limiter =>
                {
                    limiter.PermitLimit = 100;
                    limiter.QueueLimit = 0;
                    limiter.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
                    limiter.Window = TimeSpan.FromMinutes(1);
                    limiter.AutoReplenishment = true;
                }));
            builder.Services.AddSingleton<IAedsEncoder, AedsEncoder>();
            builder.Services.AddSingleton<IBinaryRequestBinder, BinaryRequestBinder>();
            builder.Services.AddSingleton(hotArticlesVersion);
            builder.Services.AddScoped<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>();
            builder.Services.AddSingleton<AuthCookieService>();
            builder.Services.AddSingleton<AuthBinaryApplicationFacade>();
            builder.Services.AddSingleton(anonymousBootstrap);
            builder.Services.AddSingleton(loginWorkflow);
            builder.Services.AddSingleton(sessions);
            builder.Services.AddSingleton(mfaChallenges);
            builder.Services.AddSingleton(passkeys);
            builder.Services.AddSingleton(adminPrincipals);
            builder.Services.AddSingleton(pow);
            builder.Services.AddSingleton(cache);
            builder.Services.AddSingleton(new AdaptivePowGovernor(cache, builder.Configuration));
            builder.Services.AddSingleton<ISecurityRiskSignalSink>(new NoopRiskSignalSink());
            builder.Services.AddSingleton<ISecurityRiskScoreReader>(new ZeroRiskScoreReader());
            builder.Services.AddSingleton<ISecurityRiskPolicyProvider>(
                new FixedRiskPolicyProvider(CreateRiskPolicy()));
            builder.Services.AddSingleton<IRiskControlContextFactory>(
                new RiskControlContextFactory(builder.Environment, builder.Configuration));
            builder.Services.AddSingleton<IRiskDecisionService>(new AlwaysAllowRiskDecisionService());
            builder.Services.AddSingleton(challengeProofs);
            builder.Services.AddSingleton<ILocalAuthFixtureRefreshRunner>(fixtureRunner);
            builder.Services.AddTransient<RequiresPowFilter>();
            builder.Services.AddTransient<RequiresRiskControlFilter>();

            WebApplication app = builder.Build();
            app.UseRouting();
            app.Use(async (context, next) =>
            {
                context.Connection.RemoteIpAddress = IPAddress.Loopback;
                await next();
            });
            app.UseRateLimiter();
            app.UseAuthorization();
            app.MapBinaryEndpoints();
            app.MapLocalAuthFixtureEndpoints();
            await app.StartAsync();

            return new AuthCookieExpiryHarness(
                app,
                app.GetTestClient(),
                fixtureDirectory,
                fixtureRunner);
        }

        public Task<HttpResponseMessage> SendAsync(AuthExpiryFlow flow)
            => flow switch
            {
                AuthExpiryFlow.AnonymousBootstrap => SendBinaryAsync(
                    "/api/binary/auth/anonymous/bootstrap",
                    AedsFrameType.AuthAnonymousBootstrapRequest,
                    PodBinaryCodec.EncodeAuthAnonymousBootstrapRequest(
                        new AuthAnonymousBootstrapRequestCoreModel("quiet-reader", AcceptedGuidelines: true)),
                    addPowProof: true),
                AuthExpiryFlow.MfaLogin => SendBinaryAsync(
                    "/api/binary/auth/mfa/challenge",
                    AedsFrameType.MfaChallengeVerifyRequest,
                    PodBinaryCodec.EncodeMfaChallengeVerifyRequest(
                        new MfaChallengeVerifyRequestCoreModel("mfa-ticket", "login", "123456", null))),
                AuthExpiryFlow.Refresh => SendRefreshAsync(),
                AuthExpiryFlow.PasskeyLogin => SendBinaryAsync(
                    "/api/binary/auth/passkey/login/complete",
                    AedsFrameType.PasskeyLoginCompleteRequest,
                    EncodeWithWriter(writer => PodBinaryCodec.WritePasskeyLoginCompleteRequest(
                        CreatePasskeyLoginRequest(),
                        writer))),
                AuthExpiryFlow.AdminBootstrap => SendBinaryAsync(
                    "/api/binary/auth/admin/bootstrap/passkey/complete",
                    AedsFrameType.PasskeyRegisterCompleteRequest,
                    EncodeWithWriter(writer => PodBinaryCodec.WritePasskeyRegisterCompleteRequest(
                        CreatePasskeyRegisterRequest(),
                        writer)),
                    adminBootstrapToken: "bootstrap-token"),
                AuthExpiryFlow.AdminLogin => SendBinaryAsync(
                    "/api/binary/auth/admin/login/passkey/complete",
                    AedsFrameType.PasskeyLoginCompleteRequest,
                    EncodeWithWriter(writer => PodBinaryCodec.WritePasskeyLoginCompleteRequest(
                        CreatePasskeyLoginRequest(),
                        writer))),
                AuthExpiryFlow.LocalAuthFixture => SendLocalFixtureAsync(),
                _ => throw new ArgumentOutOfRangeException(nameof(flow), flow, null)
            };

        public Task<HttpResponseMessage> SendLocalFixtureAsync()
        {
            const string route = "/api/local/auth-fixture/admin";
            _ = EndpointContractApplication.Find(_app, route, HttpMethods.Get);
            var request = new HttpRequestMessage(HttpMethod.Get, route);
            request.Headers.Add("X-Fsus-Local-Auth-Fixture-Secret", FixtureSecret);
            return _client.SendAsync(request);
        }

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.DisposeAsync();
            if (Directory.Exists(_fixtureDirectory))
            {
                Directory.Delete(_fixtureDirectory, recursive: true);
            }
        }

        private Task<HttpResponseMessage> SendBinaryAsync(
            string route,
            AedsFrameType frameType,
            byte[] payload,
            bool addPowProof = false,
            string? adminBootstrapToken = null)
        {
            _ = EndpointContractApplication.Find(_app, route, HttpMethods.Post);
            var request = new HttpRequestMessage(HttpMethod.Post, route)
            {
                Content = CreateBinaryContent(frameType, payload)
            };
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            request.Headers.UserAgent.ParseAdd("issue-1053-auth-cookie-expiry-tests");
            request.Headers.Add("X-Fsus-Device-Fp", "issue-1053-device");
            if (addPowProof)
            {
                request.Headers.Add("X-Fsus-Pow-Proof", CreatePowProof());
            }

            if (adminBootstrapToken is not null)
            {
                request.Headers.Add("X-Fsus-Admin-Bootstrap-Token", adminBootstrapToken);
            }

            return _client.SendAsync(request);
        }

        private Task<HttpResponseMessage> SendRefreshAsync()
        {
            const string route = "/api/binary/auth/refresh-token";
            _ = EndpointContractApplication.Find(_app, route, HttpMethods.Post);
            var request = new HttpRequestMessage(HttpMethod.Post, route);
            request.Headers.Add("Cookie", "RefreshToken=old-refresh; SessionId=old-session");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            return _client.SendAsync(request);
        }

        private static ByteArrayContent CreateBinaryContent(AedsFrameType frameType, byte[] payload)
        {
            var content = new ByteArrayContent(new AedsEncoder().Encode(frameType, payload));
            content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            return content;
        }

        private static byte[] EncodeWithWriter(Action<IBufferWriter<byte>> write)
        {
            var writer = new ArrayBufferWriter<byte>();
            write(writer);
            return writer.WrittenSpan.ToArray();
        }

        private static PasskeyRegisterCompleteCoreModel CreatePasskeyRegisterRequest()
            => new()
            {
                SessionKey = "registration-session",
                Id = "credential-1",
                RawId = [1, 2, 3],
                ClientDataBytes = [4, 5, 6],
                AttestationObject = [7, 8, 9],
                Transports = [5],
                FriendlyName = "Issue 1053 test key"
            };

        private static PasskeyLoginCompleteCoreModel CreatePasskeyLoginRequest()
            => new()
            {
                ChallengeToken = "challenge-1",
                Id = "credential-1",
                RawId = [1, 2, 3],
                ClientDataBytes = [4, 5, 6],
                AuthenticatorData = [7, 8, 9],
                Signature = [10, 11, 12],
                UserHandle = [13],
                RememberMe = true
            };

        private static void WriteStorageState(
            string path,
            params (string Name, string Value, DateTimeOffset? ExpiresAtUtc)[] cookies)
        {
            var payload = new
            {
                cookies = cookies.Select(cookie => new
                {
                    name = cookie.Name,
                    value = cookie.Value,
                    expires = cookie.ExpiresAtUtc?.ToUnixTimeSeconds()
                }),
                origins = Array.Empty<object>()
            };
            File.WriteAllText(path, JsonSerializer.Serialize(payload));
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
            BinaryPrimitives.WriteInt64LittleEndian(
                bytes.AsSpan(9, sizeof(long)),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            int offset = 17;
            foreach (string value in fields)
            {
                int byteCount = Encoding.UTF8.GetByteCount(value);
                BinaryPrimitives.WriteUInt16LittleEndian(
                    bytes.AsSpan(offset, sizeof(ushort)),
                    (ushort)byteCount);
                offset += sizeof(ushort);
                Encoding.UTF8.GetBytes(value, bytes.AsSpan(offset, byteCount));
                offset += byteCount;
            }

            return Convert.ToBase64String(bytes);
        }

        private static SecurityRiskPolicySnapshotV2 CreateRiskPolicy()
        {
            var defaultPolicy = new SecurityRiskActionPolicy(
                "*",
                new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
                Sha256PowChallengeProvider.WireKind,
                1,
                null,
                AnonymousWriteAllowed: false);
            return new SecurityRiskPolicySnapshotV2(
                "risk:issue-1053",
                SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
                DateTimeOffset.UnixEpoch,
                SecuritySystemModes.Enforce,
                200,
                125,
                "risk:issue-1053:lkg",
                defaultPolicy,
                new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce
                });
        }
    }

    private sealed class ConfigurableLocalAuthFixtureRefreshRunner(
        LocalAuthFixtureRefreshResult result) : ILocalAuthFixtureRefreshRunner
    {
        public int CallCount { get; private set; }

        public Task<LocalAuthFixtureRefreshResult> RefreshAsync(
            HttpContext context,
            IWebHostEnvironment environment,
            CancellationToken cancellationToken)
        {
            CallCount++;
            return Task.FromResult(result);
        }
    }

    private sealed class NoopRiskSignalSink : ISecurityRiskSignalSink
    {
        public ValueTask AddRiskAsync(
            SecurityRiskSignal signal,
            CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;
    }

    private sealed class ZeroRiskScoreReader : ISecurityRiskScoreReader
    {
        public Task<int> GetRiskScoreAsync(
            SecurityRiskSubject subject,
            CancellationToken cancellationToken = default)
            => Task.FromResult(0);

        public Task<int> GetRiskScoreAsync(
            HttpContext context,
            CancellationToken cancellationToken = default)
            => Task.FromResult(0);

        public Task ResetRiskAsync(
            SecurityRiskSubject subject,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicySnapshotV2 policy)
        : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicySnapshot CurrentRiskPolicy =>
            SecurityRiskPolicySnapshotV2Adapter.ToLegacy(policy);

        public SecurityRiskPolicySnapshotV2 CurrentRiskPolicyV2 => policy;
    }

    private sealed class AlwaysAllowRiskDecisionService : IRiskDecisionService
    {
        public RiskDecision Decide(
            RiskControlContext context,
            SecurityRiskPolicySnapshotV2 policy,
            int currentRiskScore)
            => new(
                RiskDecisionKind.Allow,
                context.ActionName,
                context.RouteKey,
                currentRiskScore,
                currentRiskScore,
                0,
                [],
                policy.PolicyVersion,
                ["issue-1053-direct-behavior-test"]);
    }
}
