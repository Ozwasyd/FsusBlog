using System.Net;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthRiskControlEndpointContractTests(
    EndpointSecurityDefaultServerFixture defaultServerFixture)
    : IClassFixture<EndpointSecurityDefaultServerFixture>
{
    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AuthRiskEndpointMetadata_ComesFromFinalEndpointDataSource()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        var expected = new (string Route, string Action, string RouteKey, Type[] Filters)[]
        {
            (
                "/api/binary/auth/passkey/login/begin",
                RiskActionNames.AuthPasskeyBegin,
                "auth.passkey.begin",
                new[] { typeof(RequiresRiskControlFilter) }),
            (
                "/api/binary/auth/passkey/login/complete",
                RiskActionNames.AuthPasskeyComplete,
                "auth.passkey.complete",
                new[] { typeof(RequiresRiskControlFilter) }),
            (
                "/api/binary/auth/recovery-key/verify",
                RiskActionNames.RecoveryKeyVerify,
                "recovery-key.verify",
                new[] { typeof(RequiresRiskControlFilter), typeof(RequiresPowFilter) })
        };

        Assert.All(expected, item =>
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, item.Route, HttpMethods.Post);
            Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
            Assert.Equal(
                "fixed_ip",
                Assert.IsType<EnableRateLimitingAttribute>(
                    endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
            Assert.Equal(
                new RiskActionEndpointMetadata(item.Action, item.RouteKey),
                endpoint.Metadata.GetMetadata<RiskActionEndpointMetadata>());
            Assert.NotNull(endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>());
            Assert.Equal(
                item.Filters,
                endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
                    .Select(static metadata => metadata.FilterType)
                    .ToArray());
        });
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task PasswordLoginEndpoint_IsNotAProductionRiskControlledCapability()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint[] legacyPasswordLogin = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => string.Equals(
                (endpoint.RoutePattern.RawText ?? string.Empty).TrimStart('/'),
                "api/binary/auth/login",
                StringComparison.Ordinal))
            .ToArray();
        Assert.Empty(legacyPasswordLogin);
    }

    [Theory]
    [InlineData("/api/binary/auth/recovery-key/verify", false)]
    [InlineData("/api/binary/comment", true)]
    public async Task TestServer_RiskControlShortCircuitsPowUntilRiskProofIsAccepted(
        string route,
        bool requiresAccount)
    {
        EndpointSecurityTestServer server = DefaultServer();
        using HttpClient client = CreateIsolatedClient(server);

        using var missingRiskProof = new HttpRequestMessage(HttpMethod.Post, route);
        if (requiresAccount)
        {
            EndpointSecurityTestServer.AddAnonymousAccount(missingRiskProof);
        }

        using HttpResponseMessage missingRiskResponse = await client.SendAsync(missingRiskProof);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, missingRiskResponse.StatusCode);
        ErrorDetail missingRiskError = await EndpointSecurityTestServer.ReadErrorAsync(missingRiskResponse);
        Assert.Equal(ErrorCode.Forbidden, missingRiskError.Code);
        Assert.Equal("RISK_CHALLENGE_PROOF_REQUIRED", missingRiskError.Message);
        await server.RiskProofs.DidNotReceive().ConsumeProofAsync(
            Arg.Any<SecurityChallengeProofConsumeRequest>(),
            Arg.Any<CancellationToken>());
        await server.Pow.DidNotReceive().VerifyAsync(
            Arg.Any<IPowRequest>(),
            Arg.Any<string>(),
            Arg.Any<string?>());

        using var acceptedRiskProof = new HttpRequestMessage(HttpMethod.Post, route);
        if (requiresAccount)
        {
            EndpointSecurityTestServer.AddAnonymousAccount(acceptedRiskProof);
        }
        EndpointSecurityTestServer.AddRiskProof(acceptedRiskProof, "risk-proof-valid");

        using HttpResponseMessage powRequiredResponse = await client.SendAsync(acceptedRiskProof);
        Assert.Equal(HttpStatusCode.Unauthorized, powRequiredResponse.StatusCode);
        ErrorDetail powRequired = await EndpointSecurityTestServer.ReadErrorAsync(powRequiredResponse);
        Assert.Equal(ErrorCode.Unauthorized, powRequired.Code);
        Assert.Contains("Header", powRequired.Message, StringComparison.Ordinal);
        await server.RiskProofs.Received(1).ConsumeProofAsync(
            Arg.Any<SecurityChallengeProofConsumeRequest>(),
            Arg.Any<CancellationToken>());
        Assert.Contains(server.RiskSink.Signals, static signal => signal.Reason == SecurityRiskReason.PowInvalid);
    }

    [Theory]
    [InlineData("/api/binary/auth/passkey/login/begin")]
    [InlineData("/api/binary/auth/passkey/login/complete")]
    public async Task TestServer_PasskeyRiskControlShortCircuitsHandlersWithoutInventingPow(
        string route)
    {
        EndpointSecurityTestServer server = DefaultServer();
        using HttpClient client = CreateIsolatedClient(server);

        using HttpResponseMessage response = await client.PostAsync(route, content: null);

        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, response.StatusCode);
        Assert.Equal(
            "RISK_CHALLENGE_PROOF_REQUIRED",
            (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
        await server.Passkeys.DidNotReceive().BeginAssertionAsync(Arg.Any<CancellationToken>());
        await server.Passkeys.DidNotReceive().CompleteAssertionAsync(
            Arg.Any<FsusBlog.Core.Mapping.Models.PasskeyLoginCompleteCoreModel>(),
            Arg.Any<CancellationToken>());
        await server.Pow.DidNotReceive().VerifyAsync(
            Arg.Any<IPowRequest>(),
            Arg.Any<string>(),
            Arg.Any<string?>());
    }

    [Fact]
    public async Task TestServer_ValidPasskeyBeginRiskProofReachesHandlerWithoutPow()
    {
        EndpointSecurityTestServer server = DefaultServer();
        using HttpClient client = CreateIsolatedClient(server);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/auth/passkey/login/begin");
        EndpointSecurityTestServer.AddRiskProof(request, "risk-proof-valid");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal(
            "passkey-handler-reached",
            (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
        await server.Passkeys.Received(1).BeginAssertionAsync(Arg.Any<CancellationToken>());
        await server.Pow.DidNotReceive().VerifyAsync(
            Arg.Any<IPowRequest>(),
            Arg.Any<string>(),
            Arg.Any<string?>());
    }

    [Theory]
    [InlineData("risk-proof-invalid", "proof_replayed_or_missing", "RISK_CHALLENGE_PROOF_REPLAYED", SecurityChallengeProofOutcomes.ReplayedOrMissing)]
    [InlineData("risk-proof-expired", "proof_expired", "RISK_CHALLENGE_PROOF_EXPIRED", SecurityChallengeProofOutcomes.Expired)]
    [InlineData("risk-proof-scope", "route_key_mismatch", "RISK_CHALLENGE_PROOF_BINDING_MISMATCH", SecurityChallengeProofOutcomes.BindingMismatch)]
    public async Task TestServer_InvalidExpiredAndWrongScopeRiskProofsReturnSafeOutcome(
        string proof,
        string expectedReason,
        string expectedPublicError,
        string expectedOutcome)
    {
        EndpointSecurityTestServer server = DefaultServer();
        using HttpClient client = CreateIsolatedClient(server);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/auth/recovery-key/verify");
        EndpointSecurityTestServer.AddRiskProof(request, proof);

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, response.StatusCode);
        ErrorDetail error = await EndpointSecurityTestServer.ReadErrorAsync(response);
        Assert.Equal(ErrorCode.Forbidden, error.Code);
        Assert.Equal(expectedPublicError, error.Message);
        Assert.Equal(expectedOutcome, response.Headers.GetValues(RequiresRiskControlFilter.ChallengeProofOutcomeHeaderName).Single());
        Assert.Contains(
            server.RiskSink.Signals,
            signal => string.Equals(
                signal.Detail,
                $"challenge_proof_rejected:{expectedReason}",
                StringComparison.Ordinal));
        await server.Pow.DidNotReceive().VerifyAsync(
            Arg.Any<IPowRequest>(),
            Arg.Any<string>(),
            Arg.Any<string?>());
    }

    [Fact]
    public async Task TestServer_AdminMutationEnforcesIdentityPermissionPowAndStepUpBeforeMutation()
    {
        EndpointSecurityTestServer server = DefaultServer();
        using HttpClient client = CreateIsolatedClient(server);

        using HttpResponseMessage unauthenticated = await client.SendAsync(AdminTrashRequest());
        Assert.Equal(HttpStatusCode.Unauthorized, unauthenticated.StatusCode);
        Assert.Equal(
            ErrorCode.Unauthorized,
            (await EndpointSecurityTestServer.ReadErrorAsync(unauthenticated)).Code);

        using var ordinaryAccountRequest = AdminTrashRequest();
        EndpointSecurityTestServer.AddAnonymousAccount(ordinaryAccountRequest);
        using HttpResponseMessage ordinaryAccount = await client.SendAsync(ordinaryAccountRequest);
        Assert.Equal(HttpStatusCode.Forbidden, ordinaryAccount.StatusCode);

        using var missingPermissionRequest = AdminTrashRequest();
        EndpointSecurityTestServer.AddAdminPrincipal(missingPermissionRequest);
        using HttpResponseMessage missingPermission = await client.SendAsync(missingPermissionRequest);
        Assert.Equal(HttpStatusCode.Forbidden, missingPermission.StatusCode);

        using var missingPowRequest = AdminTrashRequest();
        EndpointSecurityTestServer.AddAdminPrincipal(missingPowRequest, AdminPermissions.ArticleWrite);
        using HttpResponseMessage missingPow = await client.SendAsync(missingPowRequest);
        Assert.Equal(HttpStatusCode.Unauthorized, missingPow.StatusCode);
        Assert.Contains(
            "Header",
            (await EndpointSecurityTestServer.ReadErrorAsync(missingPow)).Message,
            StringComparison.Ordinal);
        await server.AdminPrincipals.DidNotReceive().ValidateAndConsumeAdminStepUpProofTokenAsync(
            Arg.Any<long>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());

        using var missingStepUpRequest = AdminTrashRequest(addPow: true);
        EndpointSecurityTestServer.AddAdminPrincipal(missingStepUpRequest, AdminPermissions.ArticleWrite);
        using HttpResponseMessage missingStepUp = await client.SendAsync(missingStepUpRequest);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, missingStepUp.StatusCode);
        Assert.Equal(
            "MFA_PROOF_REQUIRED",
            (await EndpointSecurityTestServer.ReadErrorAsync(missingStepUp)).Message);

        foreach (string rejectedProof in new[]
        {
            "admin-proof-invalid",
            "admin-proof-expired",
            "admin-proof-wrong-scope"
        })
        {
            using var rejectedRequest = AdminTrashRequest(addPow: true, stepUpProof: rejectedProof);
            EndpointSecurityTestServer.AddAdminPrincipal(rejectedRequest, AdminPermissions.ArticleWrite);
            using HttpResponseMessage rejected = await client.SendAsync(rejectedRequest);
            Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, rejected.StatusCode);
            Assert.Equal(
                "MFA_PROOF_REQUIRED",
                (await EndpointSecurityTestServer.ReadErrorAsync(rejected)).Message);
        }

        using var acceptedRequest = AdminTrashRequest(addPow: true, stepUpProof: "admin-proof-valid");
        EndpointSecurityTestServer.AddAdminPrincipal(acceptedRequest, AdminPermissions.ArticleWrite);
        using HttpResponseMessage accepted = await client.SendAsync(acceptedRequest);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        await server.Articles.Received(1).ClearTrashAsync(Arg.Any<CancellationToken>());
        await server.AdminPrincipals.Received(4).ValidateAndConsumeAdminStepUpProofTokenAsync(
            17,
            "admin-session-17",
            AdminSensitiveStepUpMetadata.DefaultAction,
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public async Task TestServer_BannedAccountBlocksNormalWriteButAllowsExplicitRestrictedAction()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create();
        using HttpClient client = CreateIsolatedClient(server);
        string accessToken = server.IssueAnonymousAccountAccessToken();

        using var activeWrite = new HttpRequestMessage(HttpMethod.Delete, "/api/binary/comment/73?reason=test");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(activeWrite, accessToken);
        EndpointSecurityTestServer.AddPowProof(activeWrite);
        using HttpResponseMessage active = await client.SendAsync(activeWrite);
        Assert.Equal(HttpStatusCode.OK, active.StatusCode);
        await server.Comments.Received(1).DeleteCommentAsAccountAsync(73, 42, "test");

        server.ResetObservations();
        server.Blacklist.GetBanStateAsync(42, EndpointSecurityTestServer.AccountSubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(true, "test-restricted", "private reason")));

        using var blockedWrite = new HttpRequestMessage(HttpMethod.Delete, "/api/binary/comment/73?reason=test");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(blockedWrite, accessToken);
        EndpointSecurityTestServer.AddPowProof(blockedWrite);
        using HttpResponseMessage blocked = await client.SendAsync(blockedWrite);
        Assert.Equal((HttpStatusCode)StatusCodes.Status423Locked, blocked.StatusCode);
        ErrorDetail blockedError = await EndpointSecurityTestServer.ReadErrorAsync(blocked);
        Assert.Equal(ErrorCode.Forbidden, blockedError.Code);
        Assert.Equal("ACCOUNT_BANNED_WRITE_LOCKED", blockedError.Details);
        Assert.DoesNotContain("private reason", blockedError.Message, StringComparison.Ordinal);
        await server.RiskScores.DidNotReceive().GetRiskScoreAsync(
            Arg.Any<HttpContext>(),
            Arg.Any<CancellationToken>());
        await server.Pow.DidNotReceive().VerifyAsync(
            Arg.Any<IPowRequest>(),
            Arg.Any<string>(),
            Arg.Any<string?>());
        await server.Comments.DidNotReceive().DeleteCommentAsAccountAsync(
            Arg.Any<long>(),
            Arg.Any<int>(),
            Arg.Any<string>());

        using var allowedRead = new HttpRequestMessage(HttpMethod.Get, "/api/binary/auth/me");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(allowedRead, accessToken);
        using HttpResponseMessage read = await client.SendAsync(allowedRead);
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);

        using var allowedRestrictedAction = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/auth/sessions/session-other/revoke");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(allowedRestrictedAction, accessToken);
        using HttpResponseMessage allowed = await client.SendAsync(allowedRestrictedAction);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        await server.Sessions.Received(1).RevokeSessionAsync(
            42,
            "session-other",
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());

        using var allowAnonymousAuth = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/auth/passkey/login/begin");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(allowAnonymousAuth, accessToken);
        using HttpResponseMessage authResponse = await client.SendAsync(allowAnonymousAuth);
        Assert.Equal((HttpStatusCode)StatusCodes.Status423Locked, authResponse.StatusCode);
        Assert.Equal(
            "ACCOUNT_BANNED_WRITE_LOCKED",
            (await EndpointSecurityTestServer.ReadErrorAsync(authResponse)).Details);
    }

    [Fact]
    public async Task TestServer_RestrictedSessionUsesExplicitWhitelistForReadsAndWrites()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create();
        using HttpClient client = CreateIsolatedClient(server);
        server.Sessions.GetUserSessionsAsync(42, "account-session-42", Arg.Any<CancellationToken>())
            .Returns([]);

        using var blockedRead = new HttpRequestMessage(HttpMethod.Get, "/api/binary/auth/passkey/credentials");
        EndpointSecurityTestServer.AddRestrictedAnonymousAccount(blockedRead);
        using HttpResponseMessage blocked = await client.SendAsync(blockedRead);
        Assert.Equal((HttpStatusCode)StatusCodes.Status423Locked, blocked.StatusCode);
        Assert.Equal("ACCOUNT_BANNED_WRITE_LOCKED", (await EndpointSecurityTestServer.ReadErrorAsync(blocked)).Details);

        using var blockedPublic = new HttpRequestMessage(HttpMethod.Post, "/api/binary/auth/passkey/login/begin");
        EndpointSecurityTestServer.AddRestrictedAnonymousAccount(blockedPublic);
        using HttpResponseMessage publicResponse = await client.SendAsync(blockedPublic);
        Assert.Equal((HttpStatusCode)StatusCodes.Status423Locked, publicResponse.StatusCode);

        using var allowedRead = new HttpRequestMessage(HttpMethod.Get, "/api/binary/auth/sessions");
        EndpointSecurityTestServer.AddRestrictedAnonymousAccount(allowedRead);
        using HttpResponseMessage allowed = await client.SendAsync(allowedRead);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public async Task TestServer_DeletedAccountReturnsUnauthorizedAndBlocksAllAccess()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create();
        string accessToken = server.IssueAnonymousAccountAccessToken();
        server.Users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(
            new UserAccountSnapshot(42, 2, null, false, DateTime.UtcNow, AccountSubjectHash: EndpointSecurityTestServer.AccountSubjectHash)));
        using HttpClient client = CreateIsolatedClient(server);

        using var blockedGet = new HttpRequestMessage(HttpMethod.Get, "/api/binary/auth/me");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(blockedGet, accessToken);
        using HttpResponseMessage responseGet = await client.SendAsync(blockedGet);
        Assert.Equal(HttpStatusCode.Unauthorized, responseGet.StatusCode);
        ErrorDetail getError = await EndpointSecurityTestServer.ReadErrorAsync(responseGet);
        Assert.Equal(ErrorCode.Unauthorized, getError.Code);
        Assert.Contains("账户已注销", getError.Message, StringComparison.Ordinal);

        using var blockedPost = new HttpRequestMessage(HttpMethod.Delete, "/api/binary/comment/73");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(blockedPost, accessToken);
        EndpointSecurityTestServer.AddPowProof(blockedPost);
        using HttpResponseMessage responsePost = await client.SendAsync(blockedPost);
        Assert.Equal(HttpStatusCode.Unauthorized, responsePost.StatusCode);
        ErrorDetail postError = await EndpointSecurityTestServer.ReadErrorAsync(responsePost);
        Assert.Equal(ErrorCode.Unauthorized, postError.Code);
        Assert.Contains("账户已注销", postError.Message, StringComparison.Ordinal);

        using var blockedRestricted = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/auth/sessions/session-other/revoke");
        EndpointSecurityTestServer.AddAnonymousAccountAccessToken(blockedRestricted, accessToken);
        using HttpResponseMessage responseRestricted = await client.SendAsync(blockedRestricted);
        Assert.Equal(HttpStatusCode.Unauthorized, responseRestricted.StatusCode);

        await server.Sessions.DidNotReceive().RevokeSessionAsync(
            Arg.Any<int>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await server.Articles.DidNotReceive().ClearTrashAsync(Arg.Any<CancellationToken>());
        await server.Comments.DidNotReceive().DeleteCommentAsAccountAsync(
            Arg.Any<long>(),
            Arg.Any<int>(),
            Arg.Any<string>());
        await server.AuditEvents.DidNotReceive().RecordHighValueAsync(
            Arg.Any<AuditEvent>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task TestServer_RateLimiterShortCircuitsRiskWithStableBinaryError()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions { FixedIpPermitLimit = 1 });
        using HttpClient client = CreateIsolatedClient(server);

        // Under full-suite load a single request can take tens of seconds. The production
        // fixed_ip window is 1 minute, so a lone "second request" can miss the window and
        // see another 428. Keep a short burst after the first response so we still hit 429
        // even if the window rolls once under load.
        using HttpResponseMessage first = await client.PostAsync(
            "/api/binary/auth/recovery-key/verify",
            content: null);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, first.StatusCode);

        HttpResponseMessage? rateLimited = null;
        int riskCallsBeforeRateLimit = -1;
        for (int attempt = 0; attempt < 6; attempt++)
        {
            int riskCallsBeforeAttempt = server.RiskScores.ReceivedCalls().Count();
            HttpResponseMessage candidate = await client.PostAsync(
                "/api/binary/auth/recovery-key/verify",
                content: null);
            if (candidate.StatusCode == HttpStatusCode.TooManyRequests)
            {
                rateLimited = candidate;
                riskCallsBeforeRateLimit = riskCallsBeforeAttempt;
                break;
            }

            Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, candidate.StatusCode);
            candidate.Dispose();
        }

        Assert.NotNull(rateLimited);
        using (rateLimited)
        {
            Assert.Equal(HttpStatusCode.TooManyRequests, rateLimited.StatusCode);
            Assert.Equal(TimeSpan.FromSeconds(60), rateLimited.Headers.RetryAfter?.Delta);
            ErrorDetail error = await EndpointSecurityTestServer.ReadErrorAsync(rateLimited);
            Assert.Equal(ErrorCode.InfraFailure, error.Code);
            Assert.Equal("HTTP 429", error.Message);
        }

        // Risk runs only for non-rate-limited attempts; at least one 428 must have
        // scored, while the observed 429 itself must short-circuit before risk.
        await server.RiskScores.Received().GetRiskScoreAsync(
            Arg.Any<HttpContext>(),
            Arg.Any<CancellationToken>());
        Assert.Equal(riskCallsBeforeRateLimit, server.RiskScores.ReceivedCalls().Count());
    }

    private static HttpRequestMessage AdminTrashRequest(
        bool addPow = false,
        string? stepUpProof = null)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Delete,
            "/api/binary/admin/article/trash");
        request.Headers.Add("Origin", "https://console.example.test");
        if (addPow)
        {
            EndpointSecurityTestServer.AddPowProof(request);
        }
        if (stepUpProof is not null)
        {
            request.Headers.Add(AdminSensitiveStepUpMetadata.DefaultProofHeader, stepUpProof);
        }

        return request;
    }

    private EndpointSecurityTestServer DefaultServer()
    {
        defaultServerFixture.Server.ResetObservations();
        Assert.Equal(0, defaultServerFixture.Server.ObservationCount);
        return defaultServerFixture.Server;
    }

    private static HttpClient CreateIsolatedClient(EndpointSecurityTestServer server)
    {
        HttpClient client = server.CreateClient();
        string remoteIp = Assert.Single(client.DefaultRequestHeaders.GetValues("X-Test-Remote-Ip"));
        IReadOnlyList<string> issuedIps = server.IssuedClientIps;
        Assert.Equal(remoteIp, issuedIps[^1]);
        Assert.Equal(issuedIps.Count, issuedIps.Distinct(StringComparer.Ordinal).Count());
        return client;
    }
}
