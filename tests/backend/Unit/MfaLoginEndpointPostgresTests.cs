using System.Buffers;
using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Governance;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MfaLoginEndpointPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const string DeviceA = "issue-2348-device-a";
    private const string DeviceB = "issue-2348-device-b";

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task MfaEnabledPasskeyLogin_CreatesNoSessionUntilTotpContinuationCompletes()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture);

        using HttpResponseMessage pendingResponse = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        Assert.Equal(HttpStatusCode.OK, pendingResponse.StatusCode);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(pendingResponse);
        Assert.Equal("mfa_required", pending.AuthPhase);
        Assert.Equal("standard", pending.MfaMode);
        Assert.False(string.IsNullOrWhiteSpace(pending.ChallengeToken));
        Assert.False(pendingResponse.Headers.TryGetValues("Set-Cookie", out _));
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));

        using HttpResponseMessage pendingSensitiveAccess = await host.AccessSensitiveEndpointAsync(
            pending.ChallengeToken!);
        Assert.Equal(HttpStatusCode.Unauthorized, pendingSensitiveAccess.StatusCode);
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));

        using HttpResponseMessage earlyRefresh = await host.RefreshAsync(
            pending.ChallengeToken!,
            pending.ChallengeToken!);
        Assert.Equal(HttpStatusCode.Unauthorized, earlyRefresh.StatusCode);
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));

        string totp = ComputeCurrentTotp(host.MfaSecret);
        using HttpResponseMessage completedResponse = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            totp,
            DeviceA);
        Assert.Equal(HttpStatusCode.OK, completedResponse.StatusCode);
        MfaChallengeResultDto completed = await ReadMfaResultAsync(completedResponse);
        Assert.True(completed.Verified);
        Assert.Equal(host.MfaUser.Id, completed.User?.AccountId);

        UserSession stored = Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        string refreshToken = ReadCookie(completedResponse, "RefreshToken");
        Assert.Equal(ReadCookie(completedResponse, "SessionId"), stored.SessionId);
        Assert.Equal(HashToken(refreshToken), stored.RefreshTokenHash);
        Assert.True(stored.MfaVerified);
        Assert.Equal(UserSessionAuthenticationStrengths.Mfa, stored.AuthenticationStrength);
        Assert.NotEqual(DeviceA, stored.DeviceSignalHash);

        using HttpResponseMessage replay = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            totp,
            DeviceA);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        Assert.Equal("MFA_CHALLENGE_EXPIRED", (await ReadErrorAsync(replay)).Message);
        Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
    }

    [Fact]
    public async Task MfaContinuation_ConcurrentTotpCompletionCreatesExactlyOnePostgresSession()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture);
        using HttpResponseMessage pendingResponse = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(pendingResponse);
        string totp = ComputeCurrentTotp(host.MfaSecret);

        Task<HttpResponseMessage>[] attempts = Enumerable.Range(0, 6)
            .Select(_ => host.CompleteMfaAsync(pending.ChallengeToken!, totp, DeviceA))
            .ToArray();
        HttpResponseMessage[] responses = await Task.WhenAll(attempts);
        try
        {
            Assert.Single(responses, static response => response.StatusCode == HttpStatusCode.OK);
            Assert.All(
                responses.Where(static response => response.StatusCode != HttpStatusCode.OK),
                static response => Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode));
            Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        }
        finally
        {
            foreach (HttpResponseMessage response in responses)
            {
                response.Dispose();
            }
        }
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "mfa-continuation-authority")]
    public async Task MfaContinuation_RejectsMissingCrossUserCrossDeviceExpiredAndRevokedUseWithoutSession()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture);

        using HttpResponseMessage missing = await host.CompleteMfaAsync(
            "not-a-issued-continuation",
            ComputeCurrentTotp(host.MfaSecret),
            DeviceA);
        await AssertRejectedWithoutDetailLeakAsync(missing, "MFA_CHALLENGE_EXPIRED");

        using HttpResponseMessage pendingResponse = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(pendingResponse);

        using HttpResponseMessage crossUser = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            ComputeCurrentTotp(host.OtherMfaSecret),
            DeviceA);
        await AssertRejectedWithoutDetailLeakAsync(crossUser, "MFA_CHALLENGE_INVALID");

        using HttpResponseMessage crossDevice = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            ComputeCurrentTotp(host.MfaSecret),
            DeviceB);
        await AssertRejectedWithoutDetailLeakAsync(crossDevice, "MFA_CHALLENGE_EXPIRED");
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));

        host.ExpireContinuation(pending.ChallengeToken!);
        using HttpResponseMessage expired = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            ComputeCurrentTotp(host.MfaSecret),
            DeviceA);
        await AssertRejectedWithoutDetailLeakAsync(expired, "MFA_CHALLENGE_EXPIRED");

        using HttpResponseMessage revokedPendingResponse = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto revokedPending = await ReadLoginFlowAsync(revokedPendingResponse);
        host.RevokeContinuation(revokedPending.ChallengeToken!);
        using HttpResponseMessage revoked = await host.CompleteMfaAsync(
            revokedPending.ChallengeToken!,
            ComputeCurrentTotp(host.MfaSecret),
            DeviceA);
        await AssertRejectedWithoutDetailLeakAsync(revoked, "MFA_CHALLENGE_EXPIRED");

        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task NonMfaPasskeyLogin_PreservesDirectSessionAndCookieSemantics()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture);

        using HttpResponseMessage response = await host.PasskeyLoginAsync(host.NonMfaUser.Id, DeviceA);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AuthLoginFlowDto flow = await ReadLoginFlowAsync(response);
        Assert.Equal("authenticated", flow.AuthPhase);
        Assert.Null(flow.ChallengeToken);
        UserSession stored = Assert.Single(await host.GetActiveSessionsAsync(host.NonMfaUser.Id));
        Assert.Equal(ReadCookie(response, "SessionId"), stored.SessionId);
        Assert.Equal(HashToken(ReadCookie(response, "RefreshToken")), stored.RefreshTokenHash);
        Assert.Equal(UserSessionAuthenticationStrengths.WebAuthnUv, stored.AuthenticationStrength);
        Assert.Equal(0, host.ActiveContinuationCount);
    }

    private static async Task AssertRejectedWithoutDetailLeakAsync(
        HttpResponseMessage response,
        string expectedMessage)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        ErrorDetail error = await ReadErrorAsync(response);
        Assert.Equal(expectedMessage, error.Message);
        Assert.DoesNotContain("account", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("user", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("totp", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
    }

    private static async Task<AuthLoginFlowDto> ReadLoginFlowAsync(HttpResponseMessage response)
    {
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.AuthLoginFlow, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeAuthLoginFlow(decoded.Value.Payload, out AuthLoginFlowDto flow));
        return flow;
    }

    private static async Task<MfaChallengeResultDto> ReadMfaResultAsync(HttpResponseMessage response)
    {
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.MfaChallengeResult, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeMfaChallengeResult(decoded.Value.Payload, out MfaChallengeResultDto result));
        return result;
    }

    private static async Task<ErrorDetail> ReadErrorAsync(HttpResponseMessage response)
    {
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        return PodBinaryCodec.ToErrorDetail(error);
    }

    private static string ReadCookie(HttpResponseMessage response, string name)
    {
        string prefix = name + "=";
        string cookie = Assert.Single(
            response.Headers.GetValues("Set-Cookie"),
            value => value.StartsWith(prefix, StringComparison.Ordinal));
        return cookie.Split(';', 2, StringSplitOptions.TrimEntries)[0][prefix.Length..];
    }

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string ComputeCurrentTotp(string secret)
    {
        const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        int buffer = 0;
        int bits = 0;
        var key = new List<byte>();
        foreach (char character in secret.TrimEnd('=').ToUpperInvariant())
        {
            int value = Alphabet.IndexOf(character, StringComparison.Ordinal);
            Assert.InRange(value, 0, 31);
            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits >= 8)
            {
                bits -= 8;
                key.Add((byte)(buffer >> bits));
                buffer &= (1 << bits) - 1;
            }
        }

        Span<byte> counter = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(
            counter,
            DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);
        byte[] hash = HMACSHA1.HashData([.. key], counter);
        int offset = hash[^1] & 0x0F;
        int binary = ((hash[offset] & 0x7F) << 24)
            | (hash[offset + 1] << 16)
            | (hash[offset + 2] << 8)
            | hash[offset + 3];
        return (binary % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
    }

    private sealed class MfaLoginTestHost : IAsyncDisposable
    {
        private readonly WebApplication _application;
        private readonly HttpClient _client;
        private readonly SqlSugarClient _db;
        private readonly InMemoryMfaCache _cache;

        private MfaLoginTestHost(
            WebApplication application,
            HttpClient client,
            SqlSugarClient db,
            InMemoryMfaCache cache,
            User mfaUser,
            User otherMfaUser,
            User nonMfaUser,
            string mfaSecret,
            string otherMfaSecret)
        {
            _application = application;
            _client = client;
            _db = db;
            _cache = cache;
            MfaUser = mfaUser;
            OtherMfaUser = otherMfaUser;
            NonMfaUser = nonMfaUser;
            MfaSecret = mfaSecret;
            OtherMfaSecret = otherMfaSecret;
        }

        public User MfaUser
        {
            get;
        }
        public User OtherMfaUser
        {
            get;
        }
        public User NonMfaUser
        {
            get;
        }
        public string MfaSecret
        {
            get;
        }
        public string OtherMfaSecret
        {
            get;
        }
        public int ActiveContinuationCount => _cache.ActiveStringCount;

        public static async Task<MfaLoginTestHost> CreateAsync(PostgresSchemaMigrationFixture fixture)
        {
            string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
            var db = PostgresSqlSugarTestClient.Create(connectionString);
            PostgresSqlSugarTestClient.InitTables(
                db,
                typeof(User),
                typeof(UserSession),
                typeof(UserRefreshTokenTombstone),
                typeof(UserMfaProfile));

            User mfaUser = SeedUser(db, mfaEnabled: true, 'a');
            User otherMfaUser = SeedUser(db, mfaEnabled: true, 'b');
            User nonMfaUser = SeedUser(db, mfaEnabled: false, 'c');
            var totp = new TotpService(
                new EphemeralDataProtectionProvider(),
                TimeProvider.System);
            string mfaSecret = SeedMfaProfile(db, totp, mfaUser.Id);
            string otherMfaSecret = SeedMfaProfile(db, totp, otherMfaUser.Id);

            var passkeys = Substitute.For<IPasskeyService>();
            passkeys.CompleteAssertionAsync(
                    Arg.Any<PasskeyLoginCompleteCoreModel>(),
                    Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    PasskeyLoginCompleteCoreModel request = call.ArgAt<PasskeyLoginCompleteCoreModel>(0);
                    User user = request.Id switch
                    {
                        "mfa-credential" => mfaUser,
                        "other-mfa-credential" => otherMfaUser,
                        "non-mfa-credential" => nonMfaUser,
                        _ => throw new InvalidOperationException("Unknown test credential.")
                    };
                    return Task.FromResult<(bool Success, string Message, User? User, int? CredentialRowId)>(
                        (true, "ok", user, 41));
                });

            var cache = new InMemoryMfaCache();
            var options = new WebApplicationOptions
            {
                EnvironmentName = Environments.Development
            };
            WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
            builder.WebHost.UseTestServer();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = "issue-2348-jwt-signing-key-with-at-least-32-bytes",
                ["Jwt:Issuer"] = "issue-2348-tests",
                ["Jwt:Audience"] = "issue-2348-tests",
                ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
                ["ConnectionStrings:DefaultConnection"] = connectionString,
                ["CORS_ALLOWED_HOSTS"] = "http://localhost",
                ["AuthCookies:AllowInsecureTransportCookies"] = "true",
                ["Security:Pow:BaseDifficulty"] = "1",
                ["Security:Pow:MaxDifficulty"] = "1",
                ["Security:IpHashKey"] = "issue-2348-ip-hash-key",
                ["MfaChallenge:TicketSigningKey"] = "issue-2348-mfa-ticket-signing-key-at-least-32-bytes",
                [SecurityRiskPseudonymizer.CurrentEpochKey] = "1",
                [SecurityRiskPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(
                    Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray())
            });

            builder.Services
                .AddFsusApiFoundation(builder.Configuration)
                .AddFsusRuntimeServices(builder.Configuration);
            builder.Services.RemoveAll<IHostedService>();
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
            builder.Services.AddScoped<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>();
            builder.Services.AddSingleton<AuthCookieService>();

            ReplaceSingleton(builder.Services, passkeys);
            ReplaceSingleton<ITotpService>(builder.Services, totp);
            ReplaceSingleton<ICacheStringReader>(builder.Services, cache);
            ReplaceSingleton<ICacheStringWriter>(builder.Services, cache);
            ReplaceSingleton<ICacheCounterStore>(builder.Services, cache);
            ReplaceSingleton<ICacheOneTimeStore>(builder.Services, cache);
            ReplaceSingleton<ICacheInvalidationStore>(builder.Services, cache);
            ReplaceSingleton<IUserSessionValidationCache>(
                builder.Services,
                Substitute.For<IUserSessionValidationCache>());
            IUserLocalePreferenceReader localePreferences = Substitute.For<IUserLocalePreferenceReader>();
            localePreferences.GetAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
                .Returns(new UserLocalePreferenceDto(LocalePreferenceModes.Auto, null, 0, DateTime.UnixEpoch));
            ReplaceSingleton(builder.Services, localePreferences);
            ReplaceSingleton<ISecurityRiskSignalSink>(builder.Services, new NoopRiskSignalSink());
            ReplaceSingleton<ISecurityRiskScoreReader>(builder.Services, new ZeroRiskScoreReader());
            ReplaceSingleton<ISecurityRiskPolicyProvider>(
                builder.Services,
                new FixedRiskPolicyProvider(CreateRiskPolicy()));
            ReplaceSingleton<IRiskDecisionService>(builder.Services, new AlwaysAllowRiskDecisionService());
            ReplaceSingleton<ISecurityChallengeProofService>(
                builder.Services,
                Substitute.For<ISecurityChallengeProofService>());
            builder.Services.RemoveAll<AdaptivePowGovernor>();
            builder.Services.AddSingleton(new AdaptivePowGovernor(cache, builder.Configuration));

            WebApplication app = builder.Build();
            app.UseRouting();
            app.Use(async (context, next) =>
            {
                context.Connection.RemoteIpAddress = IPAddress.Loopback;
                await next();
            });
            app.UseRateLimiter();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapBinaryEndpoints();
            await app.StartAsync();

            return new MfaLoginTestHost(
                app,
                app.GetTestClient(),
                db,
                cache,
                mfaUser,
                otherMfaUser,
                nonMfaUser,
                mfaSecret,
                otherMfaSecret);
        }

        public Task<HttpResponseMessage> PasskeyLoginAsync(int accountId, string deviceSignal)
        {
            string credential = accountId == MfaUser.Id
                ? "mfa-credential"
                : accountId == OtherMfaUser.Id
                    ? "other-mfa-credential"
                    : "non-mfa-credential";
            var request = new PasskeyLoginCompleteCoreModel
            {
                ChallengeToken = "passkey-challenge",
                Id = credential,
                RawId = [1, 2, 3],
                ClientDataBytes = [4, 5, 6],
                AuthenticatorData = [7, 8, 9],
                Signature = [10, 11, 12],
                UserHandle = [13],
                RememberMe = false
            };
            var writer = new ArrayBufferWriter<byte>();
            PodBinaryCodec.WritePasskeyLoginCompleteRequest(request, writer);
            return SendBinaryAsync(
                "/api/binary/auth/passkey/login/complete",
                AedsFrameType.PasskeyLoginCompleteRequest,
                writer.WrittenSpan.ToArray(),
                deviceSignal);
        }

        public Task<HttpResponseMessage> CompleteMfaAsync(
            string challengeToken,
            string code,
            string deviceSignal)
            => SendBinaryAsync(
                "/api/binary/auth/mfa/challenge",
                AedsFrameType.MfaChallengeVerifyRequest,
                PodBinaryCodec.EncodeMfaChallengeVerifyRequest(
                    new MfaChallengeVerifyRequestCoreModel(
                        challengeToken,
                        "login",
                        code,
                        null)),
                deviceSignal);

        public Task<HttpResponseMessage> RefreshAsync(string refreshToken, string sessionId)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/api/binary/auth/refresh-token");
            request.Headers.Add("Cookie", $"RefreshToken={refreshToken}; SessionId={sessionId}");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            return _client.SendAsync(request);
        }

        public Task<HttpResponseMessage> AccessSensitiveEndpointAsync(string accessToken)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/auth/me");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            return _client.SendAsync(request);
        }

        public Task<int> CountActiveSessionsAsync(int accountId)
            => _db.Queryable<UserSession>()
                .Where(session => session.UserId == accountId && session.RevokedAt == null)
                .CountAsync();

        public Task<List<UserSession>> GetActiveSessionsAsync(int accountId)
            => _db.Queryable<UserSession>()
                .Where(session => session.UserId == accountId && session.RevokedAt == null)
                .ToListAsync();

        public void ExpireContinuation(string challengeToken) => _cache.Remove(challengeToken);

        public void RevokeContinuation(string challengeToken) => _cache.Remove(challengeToken);

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _application.DisposeAsync();
            _db.Dispose();
        }

        private Task<HttpResponseMessage> SendBinaryAsync(
            string route,
            AedsFrameType frameType,
            byte[] payload,
            string deviceSignal)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, route)
            {
                Content = new ByteArrayContent(new AedsEncoder().Encode(frameType, payload))
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            request.Headers.UserAgent.ParseAdd("issue-2348-test-agent");
            request.Headers.Add("X-Fsus-Device-Fp", deviceSignal);
            return _client.SendAsync(request);
        }

        private static User SeedUser(SqlSugarClient db, bool mfaEnabled, char subjectCharacter)
        {
            var user = new User
            {
                PublicHandle = $"issue-2348-{subjectCharacter}-{Guid.NewGuid():N}"[..32],
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                AccountSubjectHash = new string(subjectCharacter, AccountSubjectHashRequirement.Sha256HexLength),
                RegistrationState = AccountRegistrationStates.Active,
                PasskeyEnabled = true,
                PasskeyUserHandle = $"issue-2348-handle-{Guid.NewGuid():N}",
                PrivacyInitializedAt = DateTime.UtcNow,
                Status = 0,
                MfaEnabled = mfaEnabled
            };
            user.Id = db.Insertable(user).ExecuteReturnIdentity();
            return user;
        }

        private static string SeedMfaProfile(SqlSugarClient db, ITotpService totp, int accountId)
        {
            string secret = totp.GenerateSecret();
            db.Insertable(new UserMfaProfile
            {
                UserId = accountId,
                MfaSecretEncrypted = totp.ProtectSecret(secret),
                MfaRecoveryCodesHash = string.Empty,
                MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion,
                MfaVerifiedAt = DateTime.UtcNow,
                UpdatedAtUtc = DateTime.UtcNow
            }).ExecuteCommand();
            return secret;
        }

        private static void ReplaceSingleton<T>(IServiceCollection services, T instance)
            where T : class
        {
            services.RemoveAll<T>();
            services.AddSingleton(instance);
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
                "risk:issue-2348",
                SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
                DateTimeOffset.UnixEpoch,
                SecuritySystemModes.Enforce,
                200,
                125,
                "risk:issue-2348:lkg",
                defaultPolicy,
                new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce
                });
        }
    }

    private sealed class InMemoryMfaCache :
        ICacheStringReader,
        ICacheStringWriter,
        ICacheCounterStore,
        ICacheOneTimeStore,
        ICacheInvalidationStore
    {
        private readonly Lock _gate = new();
        private readonly Dictionary<string, string> _strings = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _counters = new(StringComparer.Ordinal);

        public int ActiveStringCount
        {
            get
            {
                lock (_gate)
                {
                    return _strings.Count;
                }
            }
        }

        public Task<string?> GetStringAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                return Task.FromResult(_strings.GetValueOrDefault(identity));
            }
        }

        public Task SetStringAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                _strings[identity] = value;
            }
            return Task.CompletedTask;
        }

        public Task<long> IncrementAsync(
            CachePolicyId policyId,
            string identity,
            long value = 1,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                long next = _counters.GetValueOrDefault(identity) + value;
                _counters[identity] = next;
                return Task.FromResult(next);
            }
        }

        public Task<long[]> IncrementManyAsync(
            CachePolicyId policyId,
            IReadOnlyList<string> identities,
            long value = 1,
            CancellationToken cancellationToken = default)
            => IncrementManyWithExpiryAsync(
                policyId,
                identities,
                TimeSpan.FromMinutes(10),
                value,
                cancellationToken);

        public Task<long[]> IncrementManyWithExpiryAsync(
            CachePolicyId policyId,
            IReadOnlyList<string> identities,
            TimeSpan ttl,
            long value = 1,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                var result = new long[identities.Count];
                for (int index = 0; index < identities.Count; index++)
                {
                    string identity = identities[index];
                    result[index] = _counters.GetValueOrDefault(identity) + value;
                    _counters[identity] = result[index];
                }
                return Task.FromResult(result);
            }
        }

        public Task<bool> ConsumeOnceAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                return Task.FromResult(_strings.Remove(identity));
            }
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                if (!_strings.Remove(identity, out string? value))
                {
                    return Task.FromResult(new CacheReadResult<T>(false, default));
                }

                (bool success, T? decoded) = decoder(Encoding.UTF8.GetBytes(value));
                return Task.FromResult(new CacheReadResult<T>(success, success ? decoded : default));
            }
        }

        public Task RemoveAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Remove(identity);
            return Task.CompletedTask;
        }

        public Task RemoveManyAsync(
            IReadOnlyList<CacheKeyIdentity> keys,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                foreach (CacheKeyIdentity key in keys)
                {
                    _strings.Remove(key.Identity);
                }
            }
            return Task.CompletedTask;
        }

        public Task RemoveByPrefixAsync(
            CachePolicyId policyId,
            string identityPrefix,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                foreach (string key in _strings.Keys
                    .Where(key => key.StartsWith(identityPrefix, StringComparison.Ordinal))
                    .ToArray())
                {
                    _strings.Remove(key);
                }
            }
            return Task.CompletedTask;
        }

        public Task RemoveByPrefixManyAsync(
            IReadOnlyList<CachePrefixIdentity> prefixes,
            CancellationToken cancellationToken = default)
            => Task.WhenAll(prefixes.Select(prefix => RemoveByPrefixAsync(
                prefix.PolicyId,
                prefix.IdentityPrefix,
                cancellationToken)));

        public void Remove(string identity)
        {
            lock (_gate)
            {
                _strings.Remove(identity);
            }
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
                ["issue-2348-postgres-endpoint-test"]);
    }
}
