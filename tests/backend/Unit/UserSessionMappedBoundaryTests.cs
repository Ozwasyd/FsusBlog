using System.Net;
using System.Net.Http.Headers;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
namespace FsusBlog.Server.Tests.Unit;

[CollectionDefinition(nameof(UserSessionMappedBoundaryCollection))]
public sealed class UserSessionMappedBoundaryCollection
    : ICollectionFixture<UserSessionMappedBoundaryTests.MappedBoundaryHostFixture>;

[Collection(nameof(UserSessionMappedBoundaryCollection))]
[Trait("Category", "SecurityStateMachine")]
public sealed class UserSessionMappedBoundaryTests(
    UserSessionMappedBoundaryTests.MappedBoundaryHostFixture fixture)
{
    [Fact]
    public async Task MappedNotificationStreamPreflight_RevokedOrdinaryJwtRejectsBeforeAdmissionAndClearsUserCookies()
    {
        MappedBoundaryHost host = fixture.PrepareForTest();
        WebApplication app = host.Application;
        IssuedAccessToken token = IssueRevokedToken(app, "revoked-notification-session");
        using HttpClient client = app.GetTestClient();
        using var request = CreateRevokedRequest(
            HttpMethod.Get,
            "/api/notifications/stream/preflight",
            token.Token,
            "revoked-notification-session");
        request.Headers.Add("X-Fsus-Notification-Stream-Protocol", "fsus-aeds.v2");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        AssertUserCookiesCleared(response);
        AedsDecodeResult frame = await DecodeFrameAsync(response);
        Assert.Equal(AedsFrameType.ApiError, frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(frame.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.Unauthorized, error.Code);
        Assert.Equal("auth_failed", error.Message);
        await host.UserValidator.Received(1).ValidateAsync(
            Arg.Is<System.Security.Claims.ClaimsPrincipal>(principal =>
                principal.FindFirst("sid") != null
                && principal.FindFirst("sid")!.Value == "revoked-notification-session"),
            Arg.Any<CancellationToken>());
        await host.Admission.DidNotReceive().ValidateAsync(
            Arg.Any<string?>(),
            Arg.Any<CancellationToken>());
        await host.RiskScores.DidNotReceive().GetRiskScoreAsync(
            Arg.Any<HttpContext>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task MappedProtectedBinarySessions_RevokedOrdinaryJwtRejectsBeforeHandlerAndClearsUserCookies()
    {
        MappedBoundaryHost host = fixture.PrepareForTest();
        WebApplication app = host.Application;
        IssuedAccessToken token = IssueRevokedToken(app, "revoked-binary-session");
        using HttpClient client = app.GetTestClient();
        using var request = CreateRevokedRequest(
            HttpMethod.Get,
            "/api/binary/auth/sessions",
            token.Token,
            "revoked-binary-session");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        AssertUserCookiesCleared(response);
        AedsDecodeResult frame = await DecodeFrameAsync(response);
        Assert.Equal(AedsFrameType.ApiError, frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(frame.Payload, out var errorPod));
        Assert.Equal(ErrorCode.Unauthorized, PodBinaryCodec.ToErrorDetail(errorPod).Code);
        await host.UserValidator.Received(1).ValidateAsync(
            Arg.Is<System.Security.Claims.ClaimsPrincipal>(principal =>
                principal.FindFirst("sid") != null
                && principal.FindFirst("sid")!.Value == "revoked-binary-session"),
            Arg.Any<CancellationToken>());
        await host.Sessions.DidNotReceive().GetUserSessionsAsync(
            Arg.Any<int>(),
            Arg.Any<string?>(),
            Arg.Any<CancellationToken>());
    }

    private static async Task<MappedBoundaryHost> StartHostAsync()
    {
        var options = new WebApplicationOptions { EnvironmentName = Environments.Production };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = "issue-1052-mapped-boundary-signing-key-at-least-32-bytes",
            ["Jwt:Issuer"] = "issue-1052-mapped-boundary-tests",
            ["Jwt:Audience"] = "issue-1052-mapped-boundary-tests",
            ["Jwt:AccessTokenExpiresMinutes"] = "15",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true",
            ["AllowedHosts"] = "session-boundary.test",
            ["CORS_ALLOWED_HOSTS"] = "https://session-boundary.test",
            ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
            ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=fsusblog_session_boundary;Username=test;Password=test",
            ["Security:IpHashKey"] = "session-boundary-ip-hash-key"
        });
        builder.Services
            .AddFsusApiFoundation(builder.Configuration)
            .AddFsusRuntimeServices(builder.Configuration);
        builder.Services.RemoveAll<IHostedService>();
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(
                Arg.Any<System.Security.Claims.ClaimsPrincipal>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Invalid("user_session_revoked")));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        var sessions = Substitute.For<IUserSessionCommandService>();
        var admission = Substitute.For<INotificationStreamAdmissionService>();
        admission.ValidateAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(NotificationStreamAdmissionResult.Allowed));
        var riskScores = Substitute.For<ISecurityRiskScoreReader>();
        var cache = Substitute.For<IUnifiedCache>();
        var handshake = new NotificationStreamHandshakeService(
            Substitute.For<IPowService>(),
            new AdaptivePowGovernor(cache, builder.Configuration),
            riskScores,
            Substitute.For<ISecurityRiskPolicyProvider>(),
            Substitute.For<IRiskControlContextFactory>(),
            Substitute.For<IRiskDecisionService>(),
            Substitute.For<ISecurityChallengeProofService>(),
            Substitute.For<ISecurityRiskSignalSink>(),
            admission,
            Substitute.For<INotificationStreamAudienceResolver>(),
            new NotificationStreamOriginSnapshotProvider(builder.Configuration),
            builder.Environment,
            NullLoggerFactory.Instance);

        builder.Services.AddSingleton<AuthCookieService>();
        builder.Services.AddSingleton<IUserSessionValidationService>(userValidator);
        builder.Services.AddSingleton<IAdminSessionValidationService>(adminValidator);
        builder.Services.AddSingleton<IUserSessionCommandService>(sessions);
        builder.Services.AddSingleton(Substitute.For<ISqlSugarClient>());
        builder.Services.AddSingleton(Substitute.For<IPowService>());
        builder.Services.AddSingleton<INotificationStreamHandshakeService>(handshake);
        builder.Services.AddSingleton<IAedsEncoder, AedsEncoder>();
        builder.Services.AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>();
        builder.Services.AddSingleton<ProductionReadinessSnapshotCache>();
        builder.Services.AddAuthorization();
        builder.Services.AddOutputCache();

        WebApplication app = builder.Build();
        app.UseMiddleware<ApiBinaryResponseMiddleware>();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapFsusApplicationRoutes();
        await app.StartAsync();
        return new MappedBoundaryHost(app, userValidator, sessions, admission, riskScores);
    }

    public sealed class MappedBoundaryHostFixture : IAsyncLifetime
    {
        private MappedBoundaryHost? _host;

        public async Task InitializeAsync()
        {
            _host = await StartHostAsync();
        }

        public async Task DisposeAsync()
        {
            if (_host is not null)
            {
                await _host.Application.DisposeAsync();
                _host = null;
            }
        }

        internal MappedBoundaryHost PrepareForTest()
        {
            MappedBoundaryHost host = Assert.IsType<MappedBoundaryHost>(_host);
            host.Reset();
            return host;
        }
    }

    private static IssuedAccessToken IssueRevokedToken(WebApplication app, string sessionId)
        => app.Services.GetRequiredService<IJwtHelper>().GenerateAccessToken(
            new User
            {
                Id = 42,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                AccountSubjectHash = new string('a', AccountSubjectHashRequirement.Sha256HexLength)
            },
            sessionId,
            mfaVerified: true);

    private static HttpRequestMessage CreateRevokedRequest(
        HttpMethod method,
        string path,
        string accessToken,
        string sessionId)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Host = "session-boundary.test";
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Add(
            "Cookie",
            $"AccessToken={accessToken}; RefreshToken=refresh-token; SessionId={sessionId}");
        return request;
    }

    private static void AssertUserCookiesCleared(HttpResponseMessage response)
    {
        string[] cookies = response.Headers.TryGetValues("Set-Cookie", out IEnumerable<string>? values)
            ? values.ToArray()
            : [];
        Assert.Contains(cookies, value => value.StartsWith("AccessToken=", StringComparison.Ordinal));
        Assert.Contains(cookies, value => value.StartsWith("RefreshToken=", StringComparison.Ordinal));
        Assert.Contains(cookies, value => value.StartsWith("SessionId=", StringComparison.Ordinal));
        Assert.DoesNotContain(cookies, value =>
            value.StartsWith("AdminAccessToken=", StringComparison.Ordinal) ||
            value.StartsWith("AdminSessionId=", StringComparison.Ordinal) ||
            value.StartsWith("__Host-AdminAccessToken=", StringComparison.Ordinal) ||
            value.StartsWith("__Host-AdminSessionId=", StringComparison.Ordinal));
    }

    private static async Task<AedsDecodeResult> DecodeFrameAsync(HttpResponseMessage response)
    {
        byte[] bytes = await response.Content.ReadAsByteArrayAsync();
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(bytes);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    internal sealed record MappedBoundaryHost(
        WebApplication Application,
        IUserSessionValidationService UserValidator,
        IUserSessionCommandService Sessions,
        INotificationStreamAdmissionService Admission,
        ISecurityRiskScoreReader RiskScores)
    {
        public void Reset()
        {
            UserValidator.ClearReceivedCalls();
            Sessions.ClearReceivedCalls();
            Admission.ClearReceivedCalls();
            RiskScores.ClearReceivedCalls();
        }
    }
}
