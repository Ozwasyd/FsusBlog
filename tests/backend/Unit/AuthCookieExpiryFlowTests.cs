using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
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
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

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

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

[Collection(nameof(EnvironmentVariableCollection))]
public sealed class AuthCookieExpiryFlowTests(AuthCookieExpiryFlowTests.AuthCookieExpiryFixture fixture)
    : IClassFixture<AuthCookieExpiryFlowTests.AuthCookieExpiryFixture>
{
    private static readonly DateTimeOffset s_userAccessTokenExpiresAtUtc =
        DateTimeOffset.FromUnixTimeSeconds(1_956_528_000);
    private static readonly DateTimeOffset s_adminAccessTokenExpiresAtUtc =
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
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task MappedAuthFlows_EmitExactIssuedAccessTokenExpiry(AuthExpiryFlow flow)
    {
        using HttpResponseMessage response = await fixture.SendSuccessAsync(flow);
        Assert.Equal(
            flow == AuthExpiryFlow.LocalAuthFixture ? HttpStatusCode.Found : HttpStatusCode.OK,
            response.StatusCode);
        if (flow == AuthExpiryFlow.AnonymousBootstrap)
        {
            DateTimeOffset enrollmentExpiry = ReadCookieExpiry(response, "EnrollmentToken");
            Assert.InRange(
                enrollmentExpiry,
                DateTimeOffset.UtcNow.AddMinutes(19),
                DateTimeOffset.UtcNow.AddMinutes(21));
            Assert.DoesNotContain(
                response.Headers.GetValues("Set-Cookie"),
                value => value.StartsWith("AccessToken=", StringComparison.Ordinal));
            return;
        }

        if (flow == AuthExpiryFlow.PasskeyLogin)
        {
            AssertCookieHasNoExpiry(response, "AccessToken");
            AssertCookieHasNoExpiry(response, "RefreshToken");
            AssertCookieHasNoExpiry(response, "SessionId");
            return;
        }

        Assert.Equal(
            flow is AuthExpiryFlow.AdminBootstrap or AuthExpiryFlow.AdminLogin
                ? s_adminAccessTokenExpiresAtUtc
                : s_userAccessTokenExpiresAtUtc,
            ReadCookieExpiry(
                response,
                flow is AuthExpiryFlow.AdminBootstrap or AuthExpiryFlow.AdminLogin
                    ? "AdminAccessToken"
                    : "AccessToken"));

        if (flow == AuthExpiryFlow.LocalAuthFixture)
        {
            Assert.Equal(s_adminAccessTokenExpiresAtUtc, ReadCookieExpiry(response, "AdminAccessToken"));
            Assert.Equal("/user/manage", response.Headers.Location?.OriginalString);
        }
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-article-local-auth-fixture-runner-failure-emits-no-cookies")]
    public async Task LocalAuthFixtureRunnerFailure_EmitsNoCookies()
    {
        (HttpResponseMessage response, int runnerCallCount) = await fixture.SendFailureAsync();
        using (response)
        {
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            Assert.Equal(1, runnerCallCount);
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
        }
    }

    [Theory]
    [InlineData(true, HttpStatusCode.Found)]
    [InlineData(false, HttpStatusCode.InternalServerError)]
    [Trait("Category", "SecurityStateMachine")]
    public async Task LocalAuthFixture_RefreshesAdminProjectionBeforeIssuingCookies(
        bool projectionReady,
        HttpStatusCode expectedStatus)
    {
        LocalFixtureProjectionObservation observation =
            await fixture.SendLocalFixtureProjectionAsync(projectionReady);
        using HttpResponseMessage response = observation.Response;

        Assert.Equal(expectedStatus, response.StatusCode);
        Assert.Equal(1, observation.RefreshCalls);
        Assert.Equal("fixture-admin-session", observation.SessionId);
        Assert.Equal(projectionReady, response.Headers.TryGetValues("Set-Cookie", out _));
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-article-refresh-db-commit-then-post-cookie-verification-fault-deletes-staged-cookies-and-emits-metric")]
    public async Task Refresh_DbCommitThenPostCookieVerificationFault_DeletesStagedCookiesAndEmitsMetric()
    {
        var measurements = new ConcurrentBag<(string Name, double Value)>();
        using MeterListener listener = ListenToFsusMeasurements(measurements);

        (HttpResponseMessage response, int verificationCalls, int deliveryRevocations) =
            await fixture.SendPostCommitVerificationFaultAsync();
        using (response)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.Equal(2, verificationCalls);
            string[] cookies = response.Headers.GetValues("Set-Cookie").ToArray();
            AssertDeletionCookieIsLast(cookies, "AccessToken");
            AssertDeletionCookieIsLast(cookies, "RefreshToken");
            AssertDeletionCookieIsLast(cookies, "SessionId");
            Assert.DoesNotContain(cookies, value =>
                value.StartsWith("AdminAccessToken=", StringComparison.Ordinal)
                || value.StartsWith("AdminSessionId=", StringComparison.Ordinal));
        }
        Assert.Equal(1, deliveryRevocations);

        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.cookie_write_failed_count"
            && measurement.Value == 1);
    }

    [Theory]
    [InlineData(MfaContinuationFailure.Expired, "MFA_CHALLENGE_EXPIRED", 0, 0)]
    [InlineData(MfaContinuationFailure.CrossDevice, "MFA_CHALLENGE_EXPIRED", 0, 0)]
    [InlineData(MfaContinuationFailure.ActionMismatch, "MFA_CHALLENGE_EXPIRED", 0, 0)]
    [InlineData(MfaContinuationFailure.WrongCode, "MFA_CHALLENGE_INVALID", 1, 0)]
    [InlineData(MfaContinuationFailure.Replay, "MFA_CHALLENGE_EXPIRED", 1, 1)]
    [Trait("Category", "SecurityStateMachine")]
    public async Task MfaContinuationFailure_EmitsNoSessionCookiesOrLoginSideEffects(
        MfaContinuationFailure failure,
        string expectedError,
        int expectedVerificationCalls,
        int expectedConsumeCalls)
    {
        MfaContinuationObservation observation = await fixture.SendMfaFailureAsync(failure);
        using HttpResponseMessage response = observation.Response;

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(expectedError, (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
        Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
        Assert.Equal(expectedVerificationCalls, observation.VerificationCalls);
        Assert.Equal(expectedConsumeCalls, observation.ConsumeCalls);
        Assert.Equal(0, observation.CompleteLoginCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", "SecurityStateMachine")]
    public async Task MfaContinuation_ValidTotpOrRecoveryCompletesExactlyOneLogin(bool useRecoveryCode)
    {
        MfaContinuationObservation observation = await fixture.SendMfaSuccessAsync(useRecoveryCode);
        using HttpResponseMessage response = observation.Response;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, observation.VerificationCalls);
        Assert.Equal(1, observation.ConsumeCalls);
        Assert.Equal(1, observation.CompleteLoginCalls);
        Assert.Contains(
            response.Headers.GetValues("Set-Cookie"),
            value => value.StartsWith("AccessToken=", StringComparison.Ordinal));
    }

    public sealed class AuthCookieExpiryFixture : IAsyncLifetime
    {
        private const string TemporalArtifactDigest =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        private readonly SemaphoreSlim _requestGate = new(1, 1);
        private ScopedEnvironmentVariables? _environment;
        private AuthCookieExpiryHarness? _successHarness;
        private AuthCookieExpiryHarness? _failureHarness;

        public async Task InitializeAsync()
        {
            _environment = new ScopedEnvironmentVariables(
            [
                ResolvedTemporalRoleContext.ArtifactEnvironmentVariable,
                ResolvedTemporalRoleContext.ArtifactDigestEnvironmentVariable
            ]);
            _environment.Set(
                ResolvedTemporalRoleContext.ArtifactEnvironmentVariable,
                JsonSerializer.Serialize(new
                {
                    schema = "fsusblog.resolved-temporal-roles.v1",
                    contextIdentity = new
                    {
                        producerId = "auth-session",
                        schedulerRunId = "auth-cookie-expiry-flow"
                    },
                    roles = new[]
                    {
                        Role("session.persistent-idle-expiry", s_userAccessTokenExpiresAtUtc),
                        Role("session.admin-persistent-idle-expiry", s_adminAccessTokenExpiresAtUtc)
                    },
                    contentDigest = TemporalArtifactDigest
                }));
            _environment.Set(
                ResolvedTemporalRoleContext.ArtifactDigestEnvironmentVariable,
                TemporalArtifactDigest);
            _successHarness = await AuthCookieExpiryHarness.CreateAsync(
                LocalAuthFixtureRefreshResult.Ready(string.Empty, string.Empty));
            _failureHarness = await AuthCookieExpiryHarness.CreateAsync(
                LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh failed"));
        }

        public async Task DisposeAsync()
        {
            if (_failureHarness is not null)
            {
                await _failureHarness.DisposeAsync();
            }
            if (_successHarness is not null)
            {
                await _successHarness.DisposeAsync();
            }
            _environment?.Dispose();
            _requestGate.Dispose();
        }

        private static object Role(string roleId, DateTimeOffset instant) => new
        {
            roleId,
            clockKind = "business-wall",
            semanticEffect = "included",
            precision = "millisecond",
            instantUtc = instant.UtcDateTime.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture)
        };

        internal async Task<HttpResponseMessage> SendSuccessAsync(AuthExpiryFlow flow)
        {
            await _requestGate.WaitAsync();
            try
            {
                AuthCookieExpiryHarness harness = Assert.IsType<AuthCookieExpiryHarness>(_successHarness);
                harness.PrepareForTest();
                return await harness.SendAsync(flow);
            }
            finally
            {
                _requestGate.Release();
            }
        }

        internal async Task<(HttpResponseMessage Response, int RunnerCallCount)> SendFailureAsync()
        {
            await _requestGate.WaitAsync();
            try
            {
                AuthCookieExpiryHarness harness = Assert.IsType<AuthCookieExpiryHarness>(_failureHarness);
                harness.PrepareForTest();
                HttpResponseMessage response = await harness.SendLocalFixtureAsync();
                return (response, harness.LocalFixtureRunnerCallCount);
            }
            finally
            {
                _requestGate.Release();
            }
        }

        internal async Task<LocalFixtureProjectionObservation> SendLocalFixtureProjectionAsync(
            bool projectionReady)
        {
            await _requestGate.WaitAsync();
            try
            {
                AuthCookieExpiryHarness harness = Assert.IsType<AuthCookieExpiryHarness>(_successHarness);
                harness.PrepareForTest();
                harness.ConfigureAdminProjectionRefresh(projectionReady);
                HttpResponseMessage response = await harness.SendLocalFixtureAsync();
                return new LocalFixtureProjectionObservation(
                    response,
                    harness.AdminProjectionRefreshCallCount,
                    harness.LastAdminProjectionSessionId);
            }
            finally
            {
                _requestGate.Release();
            }
        }

        internal async Task<(HttpResponseMessage Response, int VerificationCalls, int DeliveryRevocations)> SendPostCommitVerificationFaultAsync()
        {
            await _requestGate.WaitAsync();
            try
            {
                AuthCookieExpiryHarness harness = Assert.IsType<AuthCookieExpiryHarness>(_successHarness);
                harness.PrepareForTest();
                harness.ConfigurePostCookieVerificationFault();
                HttpResponseMessage response = await harness.SendAsync(AuthExpiryFlow.Refresh);
                return (response, harness.RefreshVerificationCallCount, harness.RefreshDeliveryRevocationCallCount);
            }
            finally
            {
                _requestGate.Release();
            }
        }

        internal async Task<MfaContinuationObservation> SendMfaFailureAsync(MfaContinuationFailure failure)
        {
            await _requestGate.WaitAsync();
            try
            {
                AuthCookieExpiryHarness harness = Assert.IsType<AuthCookieExpiryHarness>(_successHarness);
                harness.PrepareForTest();
                harness.ConfigureMfaFailure(failure);
                HttpResponseMessage response = await harness.SendMfaAsync(
                    failure == MfaContinuationFailure.ActionMismatch ? "profile.email" : "login",
                    failure == MfaContinuationFailure.CrossDevice ? "other-device" : "issue-1053-device");
                return new MfaContinuationObservation(
                    response,
                    harness.MfaVerificationCallCount,
                    harness.MfaConsumeCallCount,
                    harness.CompleteLoginCallCount);
            }
            finally
            {
                _requestGate.Release();
            }
        }

        internal async Task<MfaContinuationObservation> SendMfaSuccessAsync(bool useRecoveryCode)
        {
            await _requestGate.WaitAsync();
            try
            {
                AuthCookieExpiryHarness harness = Assert.IsType<AuthCookieExpiryHarness>(_successHarness);
                harness.PrepareForTest();
                HttpResponseMessage response = await harness.SendMfaAsync(
                    "login",
                    "issue-1053-device",
                    useRecoveryCode ? null : "123456",
                    useRecoveryCode ? "recovery-code" : null);
                return new MfaContinuationObservation(
                    response,
                    harness.MfaVerificationCallCount,
                    harness.MfaConsumeCallCount,
                    harness.CompleteLoginCallCount);
            }
            finally
            {
                _requestGate.Release();
            }
        }
    }

    private static void AssertDeletionCookieIsLast(string[] cookies, string cookieName)
    {
        string last = Assert.IsType<string>(cookies.Last(value =>
            value.StartsWith(cookieName + "=", StringComparison.Ordinal)));
        Assert.StartsWith(cookieName + "=;", last, StringComparison.Ordinal);
        Assert.Contains("expires=", last, StringComparison.OrdinalIgnoreCase);
    }

    private static MeterListener ListenToFsusMeasurements(
        ConcurrentBag<(string Name, double Value)> measurements)
    {
        var listener = new MeterListener();
        listener.InstrumentPublished = static (instrument, state) =>
        {
            if (instrument.Meter.Name == FsusObservability.MeterName)
            {
                state.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, _, _) =>
            measurements.Add((instrument.Name, value)));
        listener.SetMeasurementEventCallback<double>((instrument, value, _, _) =>
            measurements.Add((instrument.Name, value)));
        listener.Start();
        return listener;
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

    private static void AssertCookieHasNoExpiry(HttpResponseMessage response, string cookieName)
    {
        string cookie = Assert.Single(
            response.Headers.GetValues("Set-Cookie"),
            value => value.StartsWith(cookieName + "=", StringComparison.Ordinal));
        Assert.DoesNotContain(
            cookie.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            static attribute => attribute.StartsWith("expires=", StringComparison.OrdinalIgnoreCase));
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

    public enum MfaContinuationFailure
    {
        Expired,
        CrossDevice,
        ActionMismatch,
        WrongCode,
        Replay
    }

    public sealed record MfaContinuationObservation(
        HttpResponseMessage Response,
        int VerificationCalls,
        int ConsumeCalls,
        int CompleteLoginCalls);

    public sealed record LocalFixtureProjectionObservation(
        HttpResponseMessage Response,
        int RefreshCalls,
        string? SessionId);

    private sealed class AuthCookieExpiryHarness : IAsyncDisposable
    {
        private const string FixtureSecret = "issue-1053-local-fixture-secret";
        private const string AccountSubjectHash =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        private readonly WebApplication _app;
        private readonly HttpClient _client;
        private readonly string _fixtureDirectory;
        private readonly ConfigurableLocalAuthFixtureRefreshRunner _localFixtureRunner;
        private readonly IUserSessionCommandService _sessions;
        private readonly IUserLoginWorkflowService _loginWorkflow;
        private readonly IUserMfaVerificationService _mfaVerification;
        private readonly IMfaChallengeService _mfaChallenges;
        private readonly IAdminSessionProjectionAuthorityReader _adminProjectionAuthority;
        private readonly MfaChallengeTicket _mfaTicket;
        private readonly Action _prepareForTest;

        private AuthCookieExpiryHarness(
            WebApplication app,
            HttpClient client,
            string fixtureDirectory,
            ConfigurableLocalAuthFixtureRefreshRunner localFixtureRunner,
            IUserSessionCommandService sessions,
            IUserLoginWorkflowService loginWorkflow,
            IUserMfaVerificationService mfaVerification,
            IMfaChallengeService mfaChallenges,
            IAdminSessionProjectionAuthorityReader adminProjectionAuthority,
            MfaChallengeTicket mfaTicket,
            Action prepareForTest)
        {
            _app = app;
            _client = client;
            _fixtureDirectory = fixtureDirectory;
            _localFixtureRunner = localFixtureRunner;
            _sessions = sessions;
            _loginWorkflow = loginWorkflow;
            _mfaVerification = mfaVerification;
            _mfaChallenges = mfaChallenges;
            _adminProjectionAuthority = adminProjectionAuthority;
            _mfaTicket = mfaTicket;
            _prepareForTest = prepareForTest;
        }

        public int LocalFixtureRunnerCallCount => _localFixtureRunner.CallCount;

        public int AdminProjectionRefreshCallCount => _adminProjectionAuthority.ReceivedCalls().Count(call =>
            call.GetMethodInfo().Name == nameof(IAdminSessionProjectionAuthorityReader.RefreshSessionAsync));

        public string? LastAdminProjectionSessionId => _adminProjectionAuthority.ReceivedCalls()
            .Where(call => call.GetMethodInfo().Name == nameof(IAdminSessionProjectionAuthorityReader.RefreshSessionAsync))
            .Select(call => call.GetArguments()[0] as string)
            .LastOrDefault();

        public int RefreshVerificationCallCount => _sessions.ReceivedCalls().Count(call =>
            call.GetMethodInfo().Name == nameof(IUserSessionCommandService.VerifyRefreshRotationAsync));

        public int RefreshDeliveryRevocationCallCount => _sessions.ReceivedCalls().Count(call =>
            call.GetMethodInfo().Name == nameof(IUserSessionCommandService.RevokeRefreshDeliveryAsync));

        public int MfaVerificationCallCount => _mfaVerification.ReceivedCalls().Count(call =>
            call.GetMethodInfo().Name == nameof(IUserMfaVerificationService.VerifyMfaOrRecoveryCodeAsync));

        public int MfaConsumeCallCount => _mfaChallenges.ReceivedCalls().Count(call =>
            call.GetMethodInfo().Name == nameof(IMfaChallengeService.ConsumeChallengeOnceAsync));

        public int CompleteLoginCallCount => _loginWorkflow.ReceivedCalls().Count(call =>
            call.GetMethodInfo().Name == nameof(IUserLoginWorkflowService.CompleteLoginAsync));

        public void PrepareForTest() => _prepareForTest();

        public void ConfigureAdminProjectionRefresh(bool ready)
            => _adminProjectionAuthority.RefreshSessionAsync(
                    Arg.Any<string>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult(ready));

        public void ConfigurePostCookieVerificationFault()
        {
            _sessions.VerifyRefreshRotationAsync(
                    Arg.Any<string>(),
                    Arg.Any<string>(),
                    Arg.Any<CancellationToken>())
                .Returns(
                    _ => Task.FromResult(true),
                    _ => Task.FromException<bool>(new InvalidOperationException("simulated post-commit delivery fault")));
            _sessions.ClearReceivedCalls();
        }

        public void ConfigureMfaFailure(MfaContinuationFailure failure)
        {
            if (failure == MfaContinuationFailure.Expired)
            {
                _mfaChallenges.GetChallengeAsync(
                        "mfa-ticket",
                        "issue-1053-device",
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult<MfaChallengeTicket?>(null));
            }
            else if (failure == MfaContinuationFailure.WrongCode)
            {
                _mfaVerification.VerifyMfaOrRecoveryCodeAsync(
                        Arg.Any<int>(),
                        Arg.Any<string?>(),
                        Arg.Any<string?>(),
                        Arg.Any<bool>(),
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult(false));
            }
            else if (failure == MfaContinuationFailure.Replay)
            {
                _mfaChallenges.ConsumeChallengeOnceAsync(
                        _mfaTicket,
                        "issue-1053-device",
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult<MfaChallengeTicket?>(null));
            }

            _loginWorkflow.ClearReceivedCalls();
            _mfaVerification.ClearReceivedCalls();
            _mfaChallenges.ClearReceivedCalls();
        }

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
                ("AccessToken", CreateUnsignedJwt(s_userAccessTokenExpiresAtUtc), null),
                ("RefreshToken", "fixture-user-refresh", null),
                ("SessionId", "fixture-user-session", null));
            WriteStorageState(
                adminStorageStatePath,
                ("AdminAccessToken", CreateUnsignedJwt(s_adminAccessTokenExpiresAtUtc), null),
                ("AdminSessionId", "fixture-admin-session", null));

            LocalAuthFixtureRefreshResult fixtureResult = configuredFixtureResult.Success
                ? LocalAuthFixtureRefreshResult.Ready(userStorageStatePath, adminStorageStatePath)
                : configuredFixtureResult;
            var fixtureRunner = new ConfigurableLocalAuthFixtureRefreshRunner(fixtureResult);

            IAnonymousAccountBootstrapService anonymousBootstrap =
                Substitute.For<IAnonymousAccountBootstrapService>();
            IUserLoginWorkflowService loginWorkflow = Substitute.For<IUserLoginWorkflowService>();
            IUserMfaVerificationService mfaVerification = Substitute.For<IUserMfaVerificationService>();
            IUserSessionCommandService sessions = Substitute.For<IUserSessionCommandService>();
            IMfaChallengeService mfaChallenges = Substitute.For<IMfaChallengeService>();
            IPasskeyService passkeys = Substitute.For<IPasskeyService>();
            IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
            IUserLocalePreferenceReader localePreferences =
                Substitute.For<IUserLocalePreferenceReader>();
            IPowService pow = Substitute.For<IPowService>();
            IUnifiedCache cache = Substitute.For<IUnifiedCache>();
            IHotArticlesCacheVersionProvider hotArticlesVersion =
                Substitute.For<IHotArticlesCacheVersionProvider>();
            ISecurityChallengeProofService challengeProofs =
                Substitute.For<ISecurityChallengeProofService>();
            IAdminSessionProjectionAuthorityReader adminProjectionAuthority =
                Substitute.For<IAdminSessionProjectionAuthorityReader>();

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
            anonymousBootstrap.BootstrapAsync(
                    Arg.Any<string?>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult(new AnonymousAccountBootstrapResult(
                    true,
                    "ok",
                    account,
                    "enrollment-token-with-more-than-32-characters",
                    DateTime.UtcNow.AddMinutes(20))));
            mfaVerification.VerifyMfaOrRecoveryCodeAsync(
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
            mfaChallenges.GetChallengeAsync(
                    "mfa-ticket",
                    "issue-1053-device",
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<MfaChallengeTicket?>(mfaTicket));
            mfaChallenges.ConsumeChallengeOnceAsync(
                    mfaTicket,
                    "issue-1053-device",
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<MfaChallengeTicket?>(mfaTicket));
            localePreferences.GetAsync(
                    Arg.Any<int>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult(new UserLocalePreferenceDto(
                    LocalePreferenceModes.Auto,
                    null,
                    0,
                    DateTime.UnixEpoch)));

            var passkeyUser = new User
            {
                Id = account.Id,
                IdentityKind = account.IdentityKind,
                AccountSubjectHash = AccountSubjectHash
            };
            passkeys.CompleteAssertionAsync(
                    Arg.Any<PasskeyLoginCompleteCoreModel>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<(bool Success, string Message, User? User, int? CredentialRowId)>(
                    (true, "ok", passkeyUser, 41)));

            pow.VerifyAsync(Arg.Any<IPowRequest>(), Arg.Any<string>(), Arg.Any<string?>())
                .Returns(Task.FromResult(true));
            cache.GetStringAsync(
                    CachePolicyId.SecurityPowRisk,
                    Arg.Any<string>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<string?>(null));

            int testSequence = 0;
            void PrepareForTest()
            {
                anonymousBootstrap.ClearReceivedCalls();
                loginWorkflow.ClearReceivedCalls();
                mfaVerification.ClearReceivedCalls();
                sessions.ClearReceivedCalls();
                mfaChallenges.ClearReceivedCalls();
                passkeys.ClearReceivedCalls();
                adminPrincipals.ClearReceivedCalls();
                localePreferences.ClearReceivedCalls();
                pow.ClearReceivedCalls();
                cache.ClearReceivedCalls();
                hotArticlesVersion.ClearReceivedCalls();
                challengeProofs.ClearReceivedCalls();
                fixtureRunner.ResetCallCount();
                adminProjectionAuthority.ClearReceivedCalls();
                adminProjectionAuthority.RefreshSessionAsync(
                        Arg.Any<string>(),
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult(true));

                mfaVerification.VerifyMfaOrRecoveryCodeAsync(
                        Arg.Any<int>(),
                        Arg.Any<string?>(),
                        Arg.Any<string?>(),
                        Arg.Any<bool>(),
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult(true));
                mfaChallenges.GetChallengeAsync(
                        "mfa-ticket",
                        "issue-1053-device",
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult<MfaChallengeTicket?>(mfaTicket));
                mfaChallenges.ConsumeChallengeOnceAsync(
                        mfaTicket,
                        "issue-1053-device",
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult<MfaChallengeTicket?>(mfaTicket));

                string testId = Interlocked.Increment(ref testSequence)
                    .ToString(CultureInfo.InvariantCulture);
                loginWorkflow.CompleteLoginAsync(
                        Arg.Any<int>(),
                        Arg.Any<string>(),
                        Arg.Any<string?>(),
                        Arg.Any<string?>(),
                        Arg.Any<bool>(),
                        Arg.Any<bool>(),
                        Arg.Any<UserSessionAuthenticationContext?>(),
                        Arg.Any<CancellationToken>())
                    .Returns(call =>
                    {
                        string durationPolicy = call.ArgAt<bool>(5)
                            ? UserSessionDurationPolicies.Persistent30Days
                            : UserSessionDurationPolicies.BrowserSession;
                        var sessionTokens = new SessionTokenResponseDto(
                            $"issued-user-access-{testId}",
                            s_userAccessTokenExpiresAtUtc,
                            $"issued-user-refresh-{testId}",
                            $"issued-user-session-{testId}",
                            DateTime.SpecifyKind(
                                s_userAccessTokenExpiresAtUtc.UtcDateTime.AddDays(7),
                                DateTimeKind.Utc),
                            durationPolicy);
                        return Task.FromResult<(
                            bool Success,
                            string Message,
                            SessionTokenResponseDto? Data,
                            UserAccountSnapshot? User)>((true, "ok", sessionTokens, account));
                    });

                var refreshTokens = new TokenResponseDto(
                    $"rotated-user-access-{testId}",
                    $"rotated-user-refresh-{testId}",
                    s_userAccessTokenExpiresAtUtc.UtcDateTime.AddDays(7),
                    $"rotated-user-session-{testId}",
                    s_userAccessTokenExpiresAtUtc);
                sessions.RotateRefreshTokenAsync(
                        "old-refresh",
                        "old-session",
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult(new RefreshTokenRotationResult(
                        RefreshTokenRotationOutcome.Success,
                        refreshTokens,
                        s_userAccessTokenExpiresAtUtc.UtcDateTime.AddDays(7),
                        UserSessionDurationPolicies.Persistent30Days)));
                sessions.GetSessionByRefreshTokenAsync(
                        $"rotated-user-refresh-{testId}",
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult<UserSession?>(new UserSession
                    {
                        UserId = account.Id
                    }));
                sessions.VerifyRefreshRotationAsync(
                        Arg.Any<string>(),
                        Arg.Any<string>(),
                        Arg.Any<CancellationToken>())
                    .Returns(Task.FromResult(true));

                var adminTokens = new AdminSessionTokens(
                    $"issued-admin-access-{testId}",
                    s_adminAccessTokenExpiresAtUtc,
                    $"issued-admin-session-{testId}",
                    s_adminAccessTokenExpiresAtUtc.UtcDateTime.AddHours(8));
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
            }

            var options = new WebApplicationOptions
            {
                EnvironmentName = Environments.Development
            };
            WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
            builder.WebHost.UseTestServer();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = "issue-1053-auth-cookie-expiry-signing-key-at-least-32-bytes",
                ["Jwt:Issuer"] = "issue-1053-auth-cookie-expiry-tests",
                ["Jwt:Audience"] = "issue-1053-auth-cookie-expiry-tests",
                ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
                ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=fsusblog_auth_cookie_expiry;Username=test;Password=test",
                ["CORS_ALLOWED_HOSTS"] = "http://localhost",
                ["AuthCookies:AllowInsecureTransportCookies"] = "true",
                ["Security:Pow:BaseDifficulty"] = "1",
                ["Security:Pow:MaxDifficulty"] = "1",
                ["Security:IpHashKey"] = "issue-1053-ip-hash-key",
                [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "true",
                [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = FixtureSecret
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
            builder.Services.AddSingleton(hotArticlesVersion);
            builder.Services.AddScoped<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>();
            builder.Services.AddSingleton<AuthCookieService>();
            builder.Services.AddSingleton<AuthBinaryApplicationFacade>();
            builder.Services.AddSingleton(anonymousBootstrap);
            builder.Services.AddSingleton(loginWorkflow);
            builder.Services.AddSingleton(mfaVerification);
            builder.Services.AddSingleton(sessions);
            builder.Services.AddSingleton(mfaChallenges);
            builder.Services.AddSingleton(passkeys);
            builder.Services.AddSingleton(adminPrincipals);
            builder.Services.AddSingleton(localePreferences);
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
            builder.Services.AddSingleton(adminProjectionAuthority);
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
                fixtureRunner,
                sessions,
                loginWorkflow,
                mfaVerification,
                mfaChallenges,
                adminProjectionAuthority,
                mfaTicket,
                PrepareForTest);
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
            const string Route = "/api/local/auth-fixture/admin";
            _ = EndpointContractApplication.Find(_app, Route, HttpMethods.Get);
            var request = new HttpRequestMessage(HttpMethod.Get, Route);
            request.Headers.Add("X-Fsus-Local-Auth-Fixture-Secret", FixtureSecret);
            return _client.SendAsync(request);
        }

        public Task<HttpResponseMessage> SendMfaAsync(
            string action,
            string deviceSignal,
            string? code = "123456",
            string? recoveryCode = null)
            => SendBinaryAsync(
                "/api/binary/auth/mfa/challenge",
                AedsFrameType.MfaChallengeVerifyRequest,
                PodBinaryCodec.EncodeMfaChallengeVerifyRequest(
                    new MfaChallengeVerifyRequestCoreModel("mfa-ticket", action, code, recoveryCode)),
                deviceSignal: deviceSignal);

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
            string? adminBootstrapToken = null,
            string deviceSignal = "issue-1053-device")
        {
            _ = EndpointContractApplication.Find(_app, route, HttpMethods.Post);
            var request = new HttpRequestMessage(HttpMethod.Post, route)
            {
                Content = CreateBinaryContent(frameType, payload)
            };
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            request.Headers.UserAgent.ParseAdd("issue-1053-auth-cookie-expiry-tests");
            request.Headers.Add("X-Fsus-Device-Fp", deviceSignal);
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
            const string Route = "/api/binary/auth/refresh-token";
            _ = EndpointContractApplication.Find(_app, Route, HttpMethods.Post);
            var request = new HttpRequestMessage(HttpMethod.Post, Route);
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
                RememberMe = false
            };

        private static void WriteStorageState(
            string path,
            params (string Name, string Value, DateTimeOffset? ExpiresAtUtc)[] cookies)
        {
            var payload = new
            {
                receiptDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

        private static string CreateUnsignedJwt(DateTimeOffset expiresAtUtc)
        {
            string header = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes("{\"alg\":\"none\"}"));
            string payload = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(
                $"{{\"exp\":{expiresAtUtc.ToUnixTimeSeconds()}}}"));
            return $"{header}.{payload}.";
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

        private static SecurityRiskPolicy CreateRiskPolicy()
        {
            var defaultPolicy = new SecurityRiskActionPolicy(
                "*",
                new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
                Sha256PowChallengeProvider.WireKind,
                1,
                null,
                AnonymousWriteAllowed: false);
            return new SecurityRiskPolicy(
                "risk:issue-1053",
                SecurityRiskPolicyFactory.DefaultPolicyVersion,
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
        private int _callCount;

        public int CallCount => Volatile.Read(ref _callCount);

        public void ResetCallCount() => Interlocked.Exchange(ref _callCount, 0);

        public Task<LocalAuthFixtureRefreshResult> RefreshAsync(
            HttpContext context,
            IWebHostEnvironment environment,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _callCount);
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

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicy policy)
        : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicy CurrentRiskPolicy => policy;
    }

    private sealed class AlwaysAllowRiskDecisionService : IRiskDecisionService
    {
        public RiskDecision Decide(
            RiskControlContext context,
            SecurityRiskPolicy policy,
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
