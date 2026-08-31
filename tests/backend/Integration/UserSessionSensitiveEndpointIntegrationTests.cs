using System.Collections.Concurrent;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Governance;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UserSessionSensitiveEndpointIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string HostName = "session-sensitive.test";

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task CurrentFullAuthSession_RealLoginAndMappedEndpointExecuteBusinessAction()
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        SessionTokenResponseDto login = await scenario.LoginAsync(FullAuthContext(scenario.Now));

        using HttpResponseMessage response = await scenario.SendAsync(login.AccessToken, "current-full-handle");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await scenario.ProfileCommands.Received(1).UpdatePublicHandleAsync(
            scenario.User.Id,
            "current-full-handle",
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
    public async Task MfaPendingWithoutPersistedSession_IsRejectedBeforeBusinessWithNoDatabaseWrite()
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        string token = scenario.Jwt.GenerateAccessToken(
            scenario.User,
            "mfa-pending-session",
            FullAuthContext(scenario.Now)).Token;
        DatabaseSnapshot before = await scenario.CaptureDatabaseAsync();

        using HttpResponseMessage response = await scenario.SendAsync(token, "pending-handle");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await scenario.AssertRejectedWithoutSideEffectsAsync(before);
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("logged-out")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
    public async Task RevokedOrLoggedOutSession_IsRejectedBeforeBusinessWithNoDatabaseWrite(string scenarioName)
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        SessionTokenResponseDto login = await scenario.LoginAsync(FullAuthContext(scenario.Now));
        bool revoked = scenarioName switch
        {
            "revoked" => await scenario.Sessions.RevokeSessionAsync(scenario.User.Id, login.SessionId),
            "logged-out" => await scenario.Sessions.RevokeRefreshTokenAsync(login.RefreshToken),
            _ => throw new ArgumentOutOfRangeException(nameof(scenarioName))
        };
        Assert.True(revoked);
        DatabaseSnapshot before = await scenario.CaptureDatabaseAsync();

        using HttpResponseMessage response = await scenario.SendAsync(login.AccessToken, "revoked-handle");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await scenario.AssertRejectedWithoutSideEffectsAsync(before);
    }

    [Theory]
    [InlineData("jwt")]
    [InlineData("idle")]
    [InlineData("absolute")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-expiration-enforcement")]
    public async Task ExpiredTokenOrSession_IsRejectedBeforeBusinessWithNoDatabaseWrite(string scenarioName)
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        UserSessionAuthenticationContext authContext = FullAuthContext(scenario.Now);
        SessionTokenResponseDto login = await scenario.LoginAsync(authContext);
        string accessToken = login.AccessToken;
        if (scenarioName == "jwt")
        {
            accessToken = CreateExplicitToken(
                scenario.User,
                login.SessionId,
                authContext,
                scenario.Now.AddMinutes(-30),
                scenario.Now.AddMinutes(-1));
        }
        else
        {
            DateTime expiredAt = scenario.Now.UtcDateTime.AddMinutes(-1);
            var update = scenario.Db.Updateable<UserSession>()
                .Where(session => session.SessionId == login.SessionId);
            int changed = scenarioName switch
            {
                "idle" => await update.SetColumns(session => session.IdleExpiresAt == expiredAt).ExecuteCommandAsync(),
                "absolute" => await update.SetColumns(session => session.AbsoluteExpiresAt == expiredAt).ExecuteCommandAsync(),
                _ => throw new ArgumentOutOfRangeException(nameof(scenarioName))
            };
            Assert.Equal(1, changed);
            scenario.Cache.RemoveState(login.SessionId);
        }
        DatabaseSnapshot before = await scenario.CaptureDatabaseAsync();

        using HttpResponseMessage response = await scenario.SendAsync(accessToken, "expired-handle");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await scenario.AssertRejectedWithoutSideEffectsAsync(before);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-authentication-context-coherence")]
    public async Task ForgedFullAuthClaimsAgainstLowStrengthDatabaseSession_AreRejectedWithoutSideEffects()
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        var lowStrength = new UserSessionAuthenticationContext(
            UserSessionAuthenticationMethods.Other,
            UserSessionAuthenticationStrengths.LegacyUnverified,
            scenario.Now.UtcDateTime);
        SessionTokenResponseDto login = await scenario.LoginAsync(lowStrength, mfaVerified: false);
        string forged = scenario.Jwt.GenerateAccessToken(
            scenario.User,
            login.SessionId,
            FullAuthContext(scenario.Now)).Token;
        DatabaseSnapshot before = await scenario.CaptureDatabaseAsync();

        using HttpResponseMessage response = await scenario.SendAsync(forged, "forged-handle");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await scenario.AssertRejectedWithoutSideEffectsAsync(before);
    }

    [Theory]
    [InlineData("wrong-session-id")]
    [InlineData("wrong-user-id")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-principal-binding")]
    public async Task WrongSessionOrUserIdentity_IsRejectedWithoutSideEffects(string scenarioName)
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        UserSessionAuthenticationContext authContext = FullAuthContext(scenario.Now);
        SessionTokenResponseDto login = await scenario.LoginAsync(authContext);
        User tokenUser = scenarioName == "wrong-user-id"
            ? new User
            {
                Id = scenario.User.Id + 1000,
                IdentityKind = scenario.User.IdentityKind,
                AccountSubjectHash = scenario.User.AccountSubjectHash,
                RegistrationState = scenario.User.RegistrationState
            }
            : scenario.User;
        string tokenSessionId = scenarioName == "wrong-session-id"
            ? "unknown-session-id"
            : login.SessionId;
        string forged = scenario.Jwt.GenerateAccessToken(tokenUser, tokenSessionId, authContext).Token;
        DatabaseSnapshot before = await scenario.CaptureDatabaseAsync();

        using HttpResponseMessage response = await scenario.SendAsync(forged, "mismatch-handle");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await scenario.AssertRejectedWithoutSideEffectsAsync(before);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task RefreshRotation_RejectsOldRefreshAuthorityAndCurrentAccessExecutesBusinessAction()
    {
        await using ScenarioContext scenario = await CreateScenarioAsync();
        SessionTokenResponseDto login = await scenario.LoginAsync(FullAuthContext(scenario.Now));

        RefreshTokenRotationResult rotation = await scenario.Sessions.RotateRefreshTokenAsync(
            login.RefreshToken,
            login.SessionId);

        Assert.True(rotation.Success);
        TokenResponseDto current = Assert.IsType<TokenResponseDto>(rotation.Tokens);
        Assert.False(await scenario.Sessions.VerifyRefreshRotationAsync(login.RefreshToken, login.SessionId));
        Assert.True(await scenario.Sessions.VerifyRefreshRotationAsync(current.RefreshToken, login.SessionId));
        using HttpResponseMessage response = await scenario.SendAsync(current.AccessToken, "refreshed-handle");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await scenario.ProfileCommands.Received(1).UpdatePublicHandleAsync(
            scenario.User.Id,
            "refreshed-handle",
            Arg.Any<CancellationToken>());
    }

    private async Task<ScenarioContext> CreateScenarioAsync()
    {
        var now = new DateTimeOffset(2026, 8, 28, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new TestBusinessTimeProvider(now);
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(UserSession),
            typeof(UserRefreshTokenTombstone));
        User user = await SeedAccountAsync(db, now.UtcDateTime);
        var cache = new InMemorySessionValidationCache();
        var profileCommands = Substitute.For<IUserProfileCommandService>();
        profileCommands.UpdatePublicHandleAsync(
                Arg.Any<int>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult((true, "ok")));
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, "ok", string.Empty));

        WebApplication app = await StartHostAsync(
            db,
            cache,
            profileCommands,
            contentFilter,
            timeProvider);
        IJwtHelper jwt = app.Services.GetRequiredService<IJwtHelper>();
        var metadataProtector = new UserSessionMetadataProtector(
            new SecurityRiskPseudonymizer(
                1,
                Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray()));
        var login = new UserLoginWorkflowService(
            db,
            NullLogger<UserLoginWorkflowService>.Instance,
            jwt,
            cache,
            Substitute.For<IAuthRiskService>(),
            metadataProtector,
            new ConfigurationBuilder().Build(),
            timeProvider: timeProvider);
        var sessions = new UserSessionCommandService(
            db,
            NullLogger<UserSessionCommandService>.Instance,
            jwt,
            cache,
            timeProvider: timeProvider);
        return new ScenarioContext(
            app,
            db,
            user,
            cache,
            profileCommands,
            contentFilter,
            jwt,
            login,
            sessions,
            now);
    }

    private static async Task<WebApplication> StartHostAsync(
        ISqlSugarClient db,
        IUserSessionValidationCache cache,
        IUserProfileCommandService profileCommands,
        IContentFilterService contentFilter,
        TimeProvider timeProvider)
    {
        var options = new WebApplicationOptions { EnvironmentName = Environments.Development };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = TestSecrets.IntegrationJwtSigningKey,
            ["Jwt:KeyVersion"] = "issue-2345",
            ["Jwt:Issuer"] = "FsusBlog.Issue2345.Tests",
            ["Jwt:Audience"] = "FsusBlog.Issue2345.Tests",
            ["Jwt:AccessTokenExpiresMinutes"] = "15",
            ["Jwt:RotationWindowDays"] = "30",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true",
            ["AllowedHosts"] = HostName,
            ["CORS_ALLOWED_HOSTS"] = $"https://{HostName}",
            ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
            ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=unused;Username=test;Password=test",
            ["Security:IpHashKey"] = "issue-2345-ip-hash-key"
        });
        builder.Services
            .AddFsusApiFoundation(builder.Configuration, timeProvider)
            .AddFsusRuntimeServices(builder.Configuration);
        builder.Services.RemoveAll<IHostedService>();
        builder.Services.AddSingleton(db);
        builder.Services.AddSingleton<IUserSessionValidationCache>(cache);
        builder.Services.AddSingleton<IUserSessionValidationService>(
            new UserSessionValidationService(db, cache, timeProvider: timeProvider));
        builder.Services.AddSingleton(profileCommands);
        builder.Services.AddSingleton(contentFilter);

        WebApplication app = builder.Build();
        app.UseMiddleware<ApiBinaryResponseMiddleware>();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapFsusApplicationRoutes();
        await app.StartAsync();
        return app;
    }

    private static async Task<User> SeedAccountAsync(SqlSugarClient db, DateTime now)
    {
        var user = new User
        {
            PublicHandle = $"issue2345-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            RegistrationState = AccountRegistrationStates.Active,
            AccountSubjectHash = new string('a', AccountSubjectHashRequirement.Sha256HexLength),
            Status = 0,
            PrivacyInitializedAt = now
        };
        user.Id = await db.Insertable(user).ExecuteReturnIdentityAsync();
        return user;
    }

    private static UserSessionAuthenticationContext FullAuthContext(DateTimeOffset now)
        => new(
            UserSessionAuthenticationMethods.Passkey,
            UserSessionAuthenticationStrengths.WebAuthnUv,
            now.UtcDateTime);

    private static HttpRequestMessage CreatePutHandleRequest(string accessToken, string publicHandle)
    {
        var aeds = new AedsEncoder();
        byte[] payload = PodBinaryCodec.EncodeStringMutationRequest(publicHandle);
        byte[] frame = aeds.Encode(AedsFrameType.AuthUpdatePublicHandleRequest, payload);
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/binary/auth/public-handle")
        {
            Content = new ByteArrayContent(frame)
        };
        request.Headers.Host = HostName;
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return request;
    }

    private static string CreateExplicitToken(
        User user,
        string sessionId,
        UserSessionAuthenticationContext context,
        DateTimeOffset notBefore,
        DateTimeOffset expires)
    {
        var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(TestSecrets.IntegrationJwtSigningKey))
        {
            KeyId = "issue-2345"
        };
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString(CultureInfo.InvariantCulture)),
            new("identity_kind", user.IdentityKind),
            new(AccountSubjectHasher.ClaimType, user.AccountSubjectHash!),
            new("sid", sessionId),
            new("mfa", "1"),
            new("auth_method", context.Method),
            new("auth_strength", context.Strength),
            new(UserSessionModes.ClaimType, UserSessionModes.ToClaimValue(context.SessionMode)),
            new("auth_time", new DateTimeOffset(context.AuthenticatedAtUtc).ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture))
        };
        var descriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            IssuedAt = notBefore.UtcDateTime,
            NotBefore = notBefore.UtcDateTime,
            Expires = expires.UtcDateTime,
            Issuer = "FsusBlog.Issue2345.Tests",
            Audience = "FsusBlog.Issue2345.Tests",
            SigningCredentials = new SigningCredentials(signingKey, SecurityAlgorithms.HmacSha256Signature)
        };
        var handler = new JwtSecurityTokenHandler();
        return handler.WriteToken(handler.CreateToken(descriptor));
    }

    private readonly record struct DatabaseSnapshot(
        string UserVersion,
        string? SessionVersions,
        int UserCount,
        int SessionCount,
        int RefreshTombstoneCount);

    private sealed class ScenarioContext(
        WebApplication app,
        SqlSugarClient db,
        User user,
        InMemorySessionValidationCache cache,
        IUserProfileCommandService profileCommands,
        IContentFilterService contentFilter,
        IJwtHelper jwt,
        UserLoginWorkflowService login,
        UserSessionCommandService sessions,
        DateTimeOffset now) : IAsyncDisposable
    {
        public SqlSugarClient Db => db;
        public User User => user;
        public InMemorySessionValidationCache Cache => cache;
        public IUserProfileCommandService ProfileCommands => profileCommands;
        public IJwtHelper Jwt => jwt;
        public UserLoginWorkflowService Login => login;
        public UserSessionCommandService Sessions => sessions;
        public DateTimeOffset Now => now;

        public async Task<SessionTokenResponseDto> LoginAsync(
            UserSessionAuthenticationContext context,
            bool mfaVerified = true)
        {
            var result = await login.CompleteLoginAsync(
                user,
                "203.0.113.45",
                "issue-2345-device",
                "issue-2345-agent",
                mfaVerified,
                rememberMe: false,
                context);
            Assert.True(result.Success, result.Message);
            return Assert.IsType<SessionTokenResponseDto>(result.Data);
        }

        public async Task<HttpResponseMessage> SendAsync(string accessToken, string publicHandle)
        {
            using HttpClient client = app.GetTestClient();
            using HttpRequestMessage request = CreatePutHandleRequest(accessToken, publicHandle);
            return await client.SendAsync(request);
        }

        public async Task<DatabaseSnapshot> CaptureDatabaseAsync()
        {
            string userVersion = Convert.ToString(
                await db.Ado.GetScalarAsync(
                    "SELECT xmin::text FROM sys_user WHERE id = @UserId",
                    new SugarParameter("@UserId", user.Id)),
                CultureInfo.InvariantCulture)!;
            string? sessionVersions = Convert.ToString(
                await db.Ado.GetScalarAsync(
                    "SELECT string_agg(xmin::text, ',' ORDER BY sessionid) FROM sys_user_session WHERE userid = @UserId",
                    new SugarParameter("@UserId", user.Id)),
                CultureInfo.InvariantCulture);
            return new DatabaseSnapshot(
                userVersion,
                sessionVersions,
                await db.Queryable<User>().CountAsync(),
                await db.Queryable<UserSession>().CountAsync(),
                await db.Queryable<UserRefreshTokenTombstone>().CountAsync());
        }

        public async Task AssertRejectedWithoutSideEffectsAsync(DatabaseSnapshot before)
        {
            await profileCommands.DidNotReceive().UpdatePublicHandleAsync(
                Arg.Any<int>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
            _ = contentFilter.DidNotReceive().ValidateContent(Arg.Any<string>());
            Assert.Equal(before, await CaptureDatabaseAsync());
        }

        public async ValueTask DisposeAsync()
        {
            await app.DisposeAsync();
        }
    }

    private sealed class InMemorySessionValidationCache : IUserSessionValidationCache
    {
        private readonly ConcurrentDictionary<string, UserSessionValidationCacheState> _states =
            new(StringComparer.Ordinal);

        public void RemoveState(string sessionId)
        {
            _states.TryRemove(sessionId, out _);
        }

        public Task<UserSessionValidationCacheState?> ReadAsync(
            string sessionId,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _states.TryGetValue(sessionId, out UserSessionValidationCacheState? state);
            return Task.FromResult(state);
        }

        public Task<bool> PublishAsync(
            UserSessionValidationCacheState state,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            bool published = allowOverwrite
                ? Upsert(state)
                : _states.TryAdd(state.SessionId, state);
            return Task.FromResult(published);
        }

        public Task PublishManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> states,
            bool allowOverwrite,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (UserSessionValidationCacheState state in states)
            {
                if (allowOverwrite)
                {
                    _ = Upsert(state);
                }
                else
                {
                    _states.TryAdd(state.SessionId, state);
                }
            }
            return Task.CompletedTask;
        }

        public Task InvalidateManyAsync(
            IReadOnlyList<UserSessionValidationCacheState> states,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (UserSessionValidationCacheState state in states)
            {
                _states.TryRemove(state.SessionId, out _);
            }
            return Task.CompletedTask;
        }

        private bool Upsert(UserSessionValidationCacheState state)
        {
            _states[state.SessionId] = state;
            return true;
        }
    }
}
