using System.Buffers;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AdminPasskeyJoinedEndpointPostgresTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task Login_JoinedCredentialAndPrincipalIssueMatchingPersistedSessionAndRejectReplay()
    {
        await using AdminHost host = await AdminHost.CreateAsync(postgres, redis);
        string challenge = await host.BeginLoginAsync();
        using HttpResponseMessage completed = await host.CompleteAsync(challenge, host.CredentialA, stepUp: false);
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        AdminSession stored = Assert.Single(await host.Db.Queryable<AdminSession>().ToListAsync());
        Assert.Equal(host.PrincipalA.Id, stored.AdminPrincipalId);
        string accessToken = Cookie(completed, "AdminAccessToken");
        Assert.Equal(Cookie(completed, "AdminSessionId"), stored.SessionId);
        Assert.Equal(Hash(accessToken), stored.AccessTokenHash);
        JwtSecurityToken jwt = new JwtSecurityTokenHandler().ReadJwtToken(accessToken);
        Assert.Equal(host.PrincipalA.Id.ToString(CultureInfo.InvariantCulture), jwt.Claims.Single(c => c.Type == "admin_id").Value);
        Assert.Equal(stored.SessionId, jwt.Claims.Single(c => c.Type == "admin_sid").Value);
        Assert.Equal(1, host.FidoCalls);
        Assert.Equal(1, host.AssertionCommandsAtFido);
        Assert.Equal(1, host.FidoResults);
        Assert.Equal(host.CredentialA.SignCount + 1, (await host.ReadCredentialAsync()).SignCount);
        Assert.NotNull((await host.Db.Queryable<AdminPrincipal>().SingleAsync(p => p.Id == host.PrincipalA.Id)).LastLoginAtUtc);
        using HttpResponseMessage protectedRead = await host.SendAsync("/api/binary/auth/admin/me", null, accessToken, HttpMethod.Get);
        Assert.Equal(HttpStatusCode.OK, protectedRead.StatusCode);

        using HttpResponseMessage replay = await host.CompleteAsync(challenge, host.CredentialA, stepUp: false);
        await AssertDeniedAsync(replay, "Admin login challenge expired");
        Assert.Equal(1, host.FidoCalls);
        Assert.Equal(1, await host.Db.Queryable<AdminSession>().CountAsync());
    }

    [Theory]
    [InlineData("unknown-credential")]
    [InlineData("orphan-credential")]
    [InlineData("principal-disabled")]
    public async Task Login_JoinedReadRejectsMissingOrInactivePrincipalBeforeFidoAndSessionIssuance(string state)
    {
        await using AdminHost host = await AdminHost.CreateAsync(postgres, redis);
        string challenge = await host.BeginLoginAsync();
        AdminPasskeyCredential credential = host.CredentialA;
        if (state == "unknown-credential")
        {
            credential = new AdminPasskeyCredential { CredentialId = WebEncoders.Base64UrlEncode([90, 91, 92]) };
        }
        else if (state == "orphan-credential")
        {
            await host.Db.Updateable<AdminPasskeyCredential>()
                .SetColumns(c => c.AdminPrincipalId == long.MaxValue)
                .Where(c => c.Id == credential.Id).ExecuteCommandAsync();
        }
        else
        {
            await host.Db.Updateable<AdminPrincipal>().SetColumns(p => p.Status == AdminPrincipalStatus.Disabled)
                .Where(p => p.Id == host.PrincipalA.Id).ExecuteCommandAsync();
        }
        using HttpResponseMessage rejected = await host.CompleteAsync(challenge, credential, stepUp: false);
        await AssertDeniedAsync(rejected, state == "principal-disabled" ? "Admin principal is disabled" : "Admin Passkey credential not found");
        Assert.Equal(1, host.AssertionSqlCommands);
        Assert.Equal(0, host.FidoCalls);
        Assert.Equal(0, host.FidoResults);
        Assert.Equal(0, await host.Db.Queryable<AdminSession>().CountAsync());
        Assert.Equal(host.CredentialA.SignCount, (await host.ReadCredentialAsync()).SignCount);
        Assert.Null((await host.Db.Queryable<AdminPrincipal>().SingleAsync(p => p.Id == host.PrincipalA.Id)).LastLoginAtUtc);
        Assert.False(await host.ChallengeExistsAsync(challenge, stepUp: false));
    }

    [Fact]
    public async Task StepUp_JoinedOwnedCredentialAndLiveSessionMintOnlyBoundOneUseProof()
    {
        await using AdminHost host = await AdminHost.CreateAsync(postgres, redis);
        AdminSession session = await host.SeedSessionAsync();
        string challenge = await host.BeginStepUpAsync();
        using HttpResponseMessage completed = await host.CompleteAsync(challenge, host.CredentialA, stepUp: true);
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        var decoded = new AedsEncoder().TryDecode(await completed.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.MfaChallengeResult, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeMfaChallengeResult(decoded.Value.Payload, out var result));
        Assert.True(result.Verified);
        Assert.False(string.IsNullOrWhiteSpace(result.ProofToken));
        Assert.False(completed.Headers.TryGetValues("Set-Cookie", out _));
        Assert.Equal(1, host.FidoCalls);
        Assert.Equal(1, host.AssertionCommandsAtFido);
        Assert.Equal(1, host.FidoResults);
        Assert.Equal(host.CredentialA.SignCount + 1, (await host.ReadCredentialAsync()).SignCount);
        Assert.Equal(1, await host.Db.Queryable<AdminSession>().CountAsync());
        Assert.False(await host.Admins.ValidateAndConsumeAdminStepUpProofTokenAsync(host.PrincipalB.Id, session.SessionId, "admin-sensitive", result.ProofToken!));
        Assert.False(await host.Admins.ValidateAndConsumeAdminStepUpProofTokenAsync(host.PrincipalA.Id, "other-session", "admin-sensitive", result.ProofToken!));
        Assert.False(await host.Admins.ValidateAndConsumeAdminStepUpProofTokenAsync(host.PrincipalA.Id, session.SessionId, "wrong-action", result.ProofToken!));
        Assert.True(await host.Admins.ValidateAndConsumeAdminStepUpProofTokenAsync(host.PrincipalA.Id, session.SessionId, "admin-sensitive", result.ProofToken!));
        Assert.False(await host.Admins.ValidateAndConsumeAdminStepUpProofTokenAsync(host.PrincipalA.Id, session.SessionId, "admin-sensitive", result.ProofToken!));
        using HttpResponseMessage replay = await host.CompleteAsync(challenge, host.CredentialA, stepUp: true);
        await AssertDeniedAsync(replay, "Admin step-up challenge expired");
        Assert.Equal(1, host.FidoCalls);
    }

    [Theory]
    [InlineData("foreign-credential")]
    [InlineData("orphan-credential")]
    [InlineData("principal-disabled")]
    [InlineData("revoked-session")]
    [InlineData("idle-expired-session")]
    [InlineData("absolute-expired-session")]
    [InlineData("deleted-session")]
    [InlineData("foreign-session")]
    public async Task StepUp_JoinedReadRechecksCredentialPrincipalAndSessionBeforeFidoOrProof(string state)
    {
        await using AdminHost host = await AdminHost.CreateAsync(postgres, redis);
        AdminSession session = await host.SeedSessionAsync();
        string challenge = await host.BeginStepUpAsync();
        AdminPasskeyCredential credential = host.CredentialA;
        // Deliberately retain the already-authorized local projection after these
        // direct test SQL mutations. This qualifies the assertion's PG joined read,
        // not hot-projection convergence or distributed invalidation.
        switch (state)
        {
            case "foreign-credential":
                credential = host.CredentialB;
                break;
            case "orphan-credential":
                await host.Db.Updateable<AdminPasskeyCredential>().SetColumns(c => c.AdminPrincipalId == long.MaxValue)
                    .Where(c => c.Id == host.CredentialA.Id).ExecuteCommandAsync();
                break;
            case "principal-disabled":
                await host.Db.Updateable<AdminPrincipal>().SetColumns(p => p.Status == AdminPrincipalStatus.Disabled)
                    .Where(p => p.Id == host.PrincipalA.Id).ExecuteCommandAsync();
                break;
            case "revoked-session":
                await host.Db.Updateable<AdminSession>().SetColumns(s => s.RevokedAtUtc == DateTime.UtcNow)
                    .Where(s => s.SessionId == session.SessionId).ExecuteCommandAsync();
                break;
            case "idle-expired-session":
                await host.Db.Ado.ExecuteCommandAsync(
                    "UPDATE admin_session SET idleexpiresatutc = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE sessionid = @sid",
                    new SugarParameter("@sid", session.SessionId));
                break;
            case "absolute-expired-session":
                await host.Db.Ado.ExecuteCommandAsync(
                    "UPDATE admin_session SET absoluteexpiresatutc = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE sessionid = @sid",
                    new SugarParameter("@sid", session.SessionId));
                break;
            case "deleted-session":
                await host.Db.Deleteable<AdminSession>().Where(s => s.SessionId == session.SessionId).ExecuteCommandAsync();
                break;
            case "foreign-session":
                await host.Db.Updateable<AdminSession>().SetColumns(s => s.AdminPrincipalId == host.PrincipalB.Id)
                    .Where(s => s.SessionId == session.SessionId).ExecuteCommandAsync();
                break;
        }
        using HttpResponseMessage rejected = await host.CompleteAsync(challenge, credential, stepUp: true);
        await AssertDeniedAsync(rejected, state == "principal-disabled" ? "Admin principal is disabled" : "Admin Passkey credential not found");
        Assert.Equal(1, host.AssertionSqlCommands);
        Assert.Equal(0, host.FidoCalls);
        Assert.Equal(0, host.FidoResults);
        Assert.Equal(host.CredentialA.SignCount, (await host.ReadCredentialAsync()).SignCount);
        Assert.Equal(state == "deleted-session" ? 0 : 1, await host.Db.Queryable<AdminSession>().CountAsync());
        Assert.False(await host.ChallengeExistsAsync(challenge, stepUp: true));
        Assert.Equal(0, host.CountProofs());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task JoinedRowVersion_ConcurrentMetadataChangeRejectsAssertionWithoutSessionOrProof(bool stepUp)
    {
        await using AdminHost host = await AdminHost.CreateAsync(postgres, redis);
        if (stepUp)
        {
            await host.SeedSessionAsync();
        }
        string challenge = stepUp ? await host.BeginStepUpAsync() : await host.BeginLoginAsync();
        host.BeforeFidoResult = async () =>
        {
            using SqlSugarClient otherWriter = PostgresSqlSugarTestClient.Create(host.ConnectionString);
            string changedName = "concurrent-metadata-change";
            Assert.Equal(1, await otherWriter.Updateable<AdminPasskeyCredential>()
                .SetColumns(c => c.DeviceFriendlyName == changedName)
                .Where(c => c.Id == host.CredentialA.Id).ExecuteCommandAsync());
        };
        using HttpResponseMessage rejected = await host.CompleteAsync(challenge, host.CredentialA, stepUp);
        await AssertDeniedAsync(rejected, stepUp ? "Admin step-up Passkey assertion failed" : "Admin Passkey assertion failed");
        Assert.Equal(1, host.FidoCalls);
        Assert.Equal(1, host.AssertionCommandsAtFido);
        Assert.Equal(1, host.FidoResults);
        Assert.Equal(host.CredentialA.SignCount, (await host.ReadCredentialAsync()).SignCount);
        Assert.Equal(stepUp ? 1 : 0, await host.Db.Queryable<AdminSession>().CountAsync());
        Assert.Equal(0, host.CountProofs());
    }

    private static async Task AssertDeniedAsync(HttpResponseMessage response, string message)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        Assert.Equal(message, PodBinaryCodec.ToErrorDetail(error).Message);
        Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
    }

    private static string Cookie(HttpResponseMessage response, string name)
        => Assert.Single(response.Headers.GetValues("Set-Cookie"), value => value.StartsWith(name + "=", StringComparison.Ordinal))
            .Split(';', 2)[0][(name.Length + 1)..];

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private sealed class AdminHost : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly HttpClient _client;
        private readonly ConnectionMultiplexer _redis;
        private readonly UnifiedCache _cache;
        private readonly CacheKeyResolver _keys;
        private readonly string _prefix;
        private string? _accessToken;
        private string? _assertionChallenge;
        private bool _assertionStepUp;
        private int _assertionSqlCommands;

        private AdminHost(WebApplication app, SqlSugarClient db, string connectionString,
            ConnectionMultiplexer redis, UnifiedCache cache, CacheKeyResolver keys, string prefix,
            AdminPrincipal principalA, AdminPrincipal principalB, AdminPasskeyCredential credentialA, AdminPasskeyCredential credentialB)
        {
            _app = app;
            _client = app.GetTestClient();
            Db = db;
            ConnectionString = connectionString;
            _redis = redis;
            _cache = cache;
            _keys = keys;
            _prefix = prefix;
            PrincipalA = principalA;
            PrincipalB = principalB;
            CredentialA = credentialA;
            CredentialB = credentialB;
            db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref _assertionSqlCommands);
        }

        public SqlSugarClient Db
        {
            get;
        }
        public string ConnectionString
        {
            get;
        }
        public AdminPrincipal PrincipalA
        {
            get;
        }
        public AdminPrincipal PrincipalB
        {
            get;
        }
        public AdminPasskeyCredential CredentialA
        {
            get;
        }
        public AdminPasskeyCredential CredentialB
        {
            get;
        }
        public IAdminPrincipalService Admins => _app.Services.GetRequiredService<IAdminPrincipalService>();
        public int FidoCalls
        {
            get; private set;
        }
        public int FidoResults
        {
            get; private set;
        }
        public int AssertionCommandsAtFido
        {
            get; private set;
        }
        public int AssertionSqlCommands => Volatile.Read(ref _assertionSqlCommands);
        public Func<Task>? BeforeFidoResult
        {
            get; set;
        }

        public static async Task<AdminHost> CreateAsync(PostgresSchemaMigrationFixture postgres, PublicHotDeliveryRedisFixture redis)
        {
            string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
            SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
            PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminPasskeyCredential), typeof(AdminSession));
            AdminPrincipal principalA = SeedPrincipal(db, "admin-a");
            AdminPrincipal principalB = SeedPrincipal(db, "admin-b");
            AdminPasskeyCredential credentialA = SeedCredential(db, principalA.Id, [1, 2, 3], [11, 12, 13], 17);
            AdminPasskeyCredential credentialB = SeedCredential(db, principalB.Id, [4, 5, 6], [21, 22, 23], 29);
            ConnectionMultiplexer connection = await redis.ConnectAsync();
            var scope = new AdminRuntimeScope($"fsus-admin-joined-{Guid.NewGuid():N}:");
            var policies = new CachePolicyRegistry();
            var keys = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
            var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Development });
            builder.WebHost.UseTestServer();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:KeyVersion"] = "admin-joined",
                ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
                ["Jwt:Issuer"] = "admin-joined-tests",
                ["Jwt:Audience"] = "admin-joined-tests",
                ["ConnectionStrings:Redis"] = redis.ConnectionString,
                ["ConnectionStrings:DefaultConnection"] = connectionString,
                ["CORS_ALLOWED_HOSTS"] = "http://localhost",
                ["AuthCookies:AllowInsecureTransportCookies"] = "true"
            });
            builder.Services.AddFsusApiFoundation(builder.Configuration).AddFsusRuntimeServices(builder.Configuration);
            builder.Services.RemoveAll<IHostedService>();
            builder.Services.AddRateLimiter(options => options.AddFixedWindowLimiter("fixed_ip", limiter =>
            {
                limiter.PermitLimit = 100;
                limiter.Window = TimeSpan.FromMinutes(1);
                limiter.QueueLimit = 0;
                limiter.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
                limiter.AutoReplenishment = true;
            }));
            builder.Services.AddSingleton<IAedsEncoder, AedsEncoder>();
            builder.Services.AddSingleton<IBinaryRequestBinder, BinaryRequestBinder>();
            builder.Services.AddScoped<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>();
            var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(32, 32, 1024 * 1024));
            Assert.True(projection.MarkReady(0));
            var runtime = AdminSessionProjectionRuntimeOptions.FromConfiguration(builder.Configuration);
            var authority = new AdminSessionProjectionAuthorityReader(db, projection, runtime, TimeProvider.System);
            var distributed = new DistributedInvalidationOptions { RuntimeMode = RuntimeModeKind.Single, NodeId = "admin-joined-test" };
            var coordinator = new AdminSessionProjectionMutationCoordinator(authority, projection,
                new DistributedInvalidationEventFactory(distributed, scope, TimeProvider.System), distributed,
                Substitute.For<IDistributedInvalidationPublisher>());
            builder.Services.RemoveAll<IAdminSessionValidationService>();
            builder.Services.RemoveAll<AdminSessionTouchScheduler>();
            builder.Services.AddSingleton(provider => new AdminSessionTouchScheduler(
                provider.GetRequiredService<IServiceScopeFactory>(), runtime, TimeProvider.System,
                NullLogger<AdminSessionTouchScheduler>.Instance));
            builder.Services.AddSingleton<IAdminSessionValidationService>(provider => new AdminSessionValidationService(projection,
                provider.GetRequiredService<AdminSessionTouchScheduler>()));
            IFido2 fido = Substitute.For<IFido2>();
            fido.GetAssertionOptions(Arg.Any<GetAssertionOptionsParams>()).Returns(_ => new AssertionOptions
            {
                Challenge = RandomNumberGenerator.GetBytes(32),
                RpId = "localhost",
                Timeout = 60_000,
                UserVerification = UserVerificationRequirement.Required,
                AllowCredentials = []
            });
            builder.Services.RemoveAll<IAdminPrincipalService>();
            builder.Services.AddSingleton<IAdminPrincipalService>(provider => new AdminPrincipalService(fido, db, cache, cache,
                provider.GetRequiredService<IJwtHelper>(), builder.Configuration, NullLogger<AdminPrincipalService>.Instance,
                Substitute.For<IAdminAuditLogChannel>(), coordinator));
            WebApplication app = builder.Build();
            app.UseRouting();
            app.UseRateLimiter();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapBinaryEndpoints();
            await app.StartAsync();
            var host = new AdminHost(app, db, connectionString, connection, cache, keys, scope.ScopeToken,
                principalA, principalB, credentialA, credentialB);
            host._publishSeededSession = async sessionId =>
            {
                PreparedAdminSessionProjectionMutation prepared = await coordinator.PrepareSessionsAsync([sessionId]);
                await coordinator.PublishPreparedAsync(prepared);
            };
            // Only the cryptographic verifier is a test port. Credential/principal/session
            // loads, row-version CAS, challenge/proof consumption and endpoint auth are real.
            fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>()).Returns(async call =>
            {
                host.FidoCalls++;
                host.AssertionCommandsAtFido = Volatile.Read(ref host._assertionSqlCommands);
                Assert.False(await host.ChallengeExistsAsync(host._assertionChallenge!, host._assertionStepUp));
                MakeAssertionParams parameters = call.ArgAt<MakeAssertionParams>(0);
                AdminPasskeyCredential expected = parameters.AssertionResponse.Id == credentialA.CredentialId ? credentialA : credentialB;
                Assert.Equal(WebEncoders.Base64UrlDecode(expected.PublicKey), parameters.StoredPublicKey);
                Assert.Equal((uint)expected.SignCount, parameters.StoredSignatureCounter);
                Assert.True(await parameters.IsUserHandleOwnerOfCredentialIdCallback(
                    new IsUserHandleOwnerOfCredentialIdParams(WebEncoders.Base64UrlDecode(expected.CredentialId), WebEncoders.Base64UrlDecode(expected.UserHandle)), default));
                Assert.False(await parameters.IsUserHandleOwnerOfCredentialIdCallback(
                    new IsUserHandleOwnerOfCredentialIdParams(WebEncoders.Base64UrlDecode(expected.CredentialId), BitConverter.GetBytes(expected.AdminPrincipalId)), default));
                if (host.BeforeFidoResult is not null)
                {
                    await host.BeforeFidoResult();
                }
                host.FidoResults++;
                return new VerifyAssertionResult { CredentialId = parameters.AssertionResponse.RawId, SignCount = parameters.StoredSignatureCounter + 1 };
            });
            return host;
        }

        public async Task<AdminSession> SeedSessionAsync()
        {
            var session = new AdminSession
            {
                SessionId = "admin-joined-session",
                AdminPrincipalId = PrincipalA.Id,
                ValidationVersion = 1,
                CreatedAtUtc = DateTime.UtcNow,
                IdleExpiresAtUtc = DateTime.UtcNow.AddHours(1),
                AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(2)
            };
            _accessToken = _app.Services.GetRequiredService<IJwtHelper>().GenerateAdminAccessToken(PrincipalA, session, [AdminPermissions.AdminManage]).Token;
            session.AccessTokenHash = Hash(_accessToken);
            await Db.Insertable(session).ExecuteCommandAsync();
            // The same authority reader used by the runtime populates the test host's
            // actual local projection via a prepared mutation, not an always-Valid validator.
            await PublishSeededSessionAsync(session.SessionId);
            return session;
        }

        private Func<string, Task>? _publishSeededSession;

        private Task PublishSeededSessionAsync(string sessionId) => _publishSeededSession!(sessionId);

        public async Task<string> BeginLoginAsync()
        {
            using HttpResponseMessage response = await SendAsync("/api/binary/auth/admin/login/passkey/begin");
            return await ReadChallengeAsync(response);
        }

        public async Task<string> BeginStepUpAsync()
        {
            using HttpResponseMessage response = await SendAsync("/api/binary/auth/admin/step-up/passkey/begin", null, _accessToken);
            return await ReadChallengeAsync(response);
        }

        private static async Task<string> ReadChallengeAsync(HttpResponseMessage response)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
            Assert.True(decoded.IsSuccess);
            Assert.Equal(AedsFrameType.PasskeyLoginBegin, decoded.Value.FrameType);
            Assert.True(PodBinaryCodec.TryDecodePasskeyLoginBegin(decoded.Value.Payload, out var begin));
            return begin.ChallengeToken;
        }

        public Task<HttpResponseMessage> CompleteAsync(string challenge, AdminPasskeyCredential credential, bool stepUp)
        {
            _assertionChallenge = challenge;
            _assertionStepUp = stepUp;
            Interlocked.Exchange(ref _assertionSqlCommands, 0);
            byte[] authenticatorData = new byte[37];
            var assertion = new PasskeyLoginCompleteCoreModel
            {
                ChallengeToken = challenge,
                Id = credential.CredentialId,
                RawId = WebEncoders.Base64UrlDecode(credential.CredentialId),
                ClientDataBytes = [1, 2, 3],
                AuthenticatorData = authenticatorData,
                Signature = [4, 5, 6]
            };
            var payload = new ArrayBufferWriter<byte>();
            PodBinaryCodec.WritePasskeyLoginCompleteRequest(assertion, payload);
            byte[] frame = new AedsEncoder().Encode(AedsFrameType.PasskeyLoginCompleteRequest, payload.WrittenSpan.ToArray());
            return SendAsync(stepUp ? "/api/binary/auth/admin/step-up/passkey/complete" : "/api/binary/auth/admin/login/passkey/complete",
                frame, stepUp ? _accessToken : null);
        }

        public Task<HttpResponseMessage> SendAsync(string route, byte[]? body = null, string? accessToken = null, HttpMethod? method = null)
        {
            var request = new HttpRequestMessage(method ?? HttpMethod.Post, route);
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            }
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            if (accessToken is not null)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            }
            return _client.SendAsync(request);
        }

        public Task<AdminPasskeyCredential> ReadCredentialAsync()
            => Db.Queryable<AdminPasskeyCredential>().SingleAsync(c => c.Id == CredentialA.Id);

        public Task<bool> ChallengeExistsAsync(string token, bool stepUp)
            => _redis.GetDatabase().KeyExistsAsync(_keys.BuildKey(CachePolicyId.SecurityPasskeyAuthChallenge,
                (stepUp ? "admin-stepup:" : "admin-login:") + token));

        public int CountProofs() => _redis.GetServer(Assert.Single(_redis.GetEndPoints()))
            .Keys(pattern: _prefix + "fsus:sec:mfa-proof:*").Count();

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.DisposeAsync();
            _cache.Dispose();
            Db.Dispose();
            RedisKey[] keys = _redis.GetServer(Assert.Single(_redis.GetEndPoints())).Keys(pattern: _prefix + "*").ToArray();
            if (keys.Length > 0)
            {
                await _redis.GetDatabase().KeyDeleteAsync(keys);
            }
            await _redis.DisposeAsync();
        }

        private static AdminPrincipal SeedPrincipal(SqlSugarClient db, string handle)
        {
            var principal = new AdminPrincipal
            {
                Handle = handle,
                Status = AdminPrincipalStatus.Active,
                Permissions = AdminPermissions.AdminManage,
                ValidationVersion = 1
            };
            principal.Id = db.Insertable(principal).ExecuteReturnBigIdentity();
            return principal;
        }

        private static AdminPasskeyCredential SeedCredential(SqlSugarClient db, long principalId, byte[] credentialId, byte[] publicKey, long count)
        {
            var credential = new AdminPasskeyCredential
            {
                AdminPrincipalId = principalId,
                CredentialId = WebEncoders.Base64UrlEncode(credentialId),
                UserHandle = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32)),
                PublicKey = WebEncoders.Base64UrlEncode(publicKey),
                SignCount = count,
                AaGuid = Guid.Empty.ToString()
            };
            credential.Id = db.Insertable(credential).ExecuteReturnBigIdentity();
            return credential;
        }
    }

    private sealed class AdminRuntimeScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => prefix + key;
    }
}
