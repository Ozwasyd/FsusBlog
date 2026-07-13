using System.Net;
using FsusBlog.Core.Common;
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
    [InlineData("risk-proof-invalid", "proof_replayed_or_missing")]
    [InlineData("risk-proof-expired", "proof_expired")]
    [InlineData("risk-proof-scope", "route_key_mismatch")]
    public async Task TestServer_InvalidExpiredAndWrongScopeRiskProofsReturnOneStableError(
        string proof,
        string expectedReason)
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
        Assert.Equal("RISK_CHALLENGE_PROOF_REJECTED", error.Message);
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
    public async Task TestServer_BannedAccountBlocksNormalWriteButAllowsExplicitRestrictedAction()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions { AccountBanned = true });
        using HttpClient client = CreateIsolatedClient(server);

        using var blockedWrite = new HttpRequestMessage(HttpMethod.Post, "/api/binary/comment");
        EndpointSecurityTestServer.AddAnonymousAccount(blockedWrite);
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

        using var allowedRestrictedAction = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/auth/sessions/session-other/revoke");
        EndpointSecurityTestServer.AddAnonymousAccount(allowedRestrictedAction);
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
        EndpointSecurityTestServer.AddAnonymousAccount(allowAnonymousAuth);
        using HttpResponseMessage authResponse = await client.SendAsync(allowAnonymousAuth);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, authResponse.StatusCode);
        Assert.Equal(
            "RISK_CHALLENGE_PROOF_REQUIRED",
            (await EndpointSecurityTestServer.ReadErrorAsync(authResponse)).Message);
    }

    [Fact]
    public async Task TestServer_RateLimiterShortCircuitsRiskWithStableBinaryError()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions { FixedIpPermitLimit = 1 });
        using HttpClient client = CreateIsolatedClient(server);

        using HttpResponseMessage first = await client.PostAsync(
            "/api/binary/auth/recovery-key/verify",
            content: null);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, first.StatusCode);

        using HttpResponseMessage rateLimited = await client.PostAsync(
            "/api/binary/auth/recovery-key/verify",
            content: null);
        Assert.Equal(HttpStatusCode.TooManyRequests, rateLimited.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(60), rateLimited.Headers.RetryAfter?.Delta);
        ErrorDetail error = await EndpointSecurityTestServer.ReadErrorAsync(rateLimited);
        Assert.Equal(ErrorCode.InfraFailure, error.Code);
        Assert.Equal("HTTP 429", error.Message);
        await server.RiskScores.Received(1).GetRiskScoreAsync(
            Arg.Any<HttpContext>(),
            Arg.Any<CancellationToken>());
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
