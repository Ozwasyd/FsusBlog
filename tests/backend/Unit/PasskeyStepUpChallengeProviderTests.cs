using System.Net;
using System.Security.Claims;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PasskeyStepUpChallengeProviderTests
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-18T12:00:00Z");
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void RuntimeServices_RegisterPasskeyStepUpProviders()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        Assert.Contains(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(PasskeyStepUpV1ChallengeProvider)
                && item.Lifetime == ServiceLifetime.Scoped);
        Assert.Contains(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(AdminPasskeyStepUpV1ChallengeProvider)
                && item.Lifetime == ServiceLifetime.Scoped);
    }

    [Fact]
    public async Task UserProvider_IssueAsync_RequiresOrdinaryAuthenticatedUserAndReturnsPasskeyPayload()
    {
        var fixture = CreateUserFixture();
        SecurityChallengeProviderIssueRequest request = CreateIssueRequest(CreateUserContext());

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.PasskeyStepUpV1, result.Assignment.Kind);
        Assert.Equal(PasskeyStepUpV1ChallengeProvider.Algorithm, result.ProviderPayload["algorithm"]);
        Assert.Equal("stepup-token", result.ProviderPayload["challengeToken"]);
        Assert.Contains("\"challengeToken\":\"stepup-token\"", result.ProviderPayload["optionsJson"], StringComparison.Ordinal);
        Assert.Equal(42, fixture.Passkeys.BeginStepUpAccountId);
        Assert.Equal(result.Assignment.ChallengeId, Assert.Single(fixture.Persistence.Issues).ChallengeId);
    }

    [Fact]
    public async Task UserProvider_IssueAsync_RejectsAdminPrincipal()
    {
        var fixture = CreateUserFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(CreateAdminContext()),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("passkey_step_up_user_required", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Equal(0, fixture.Passkeys.BeginStepUpAccountId);
    }

    [Fact]
    public async Task UserProvider_IssueAsync_RejectsUnauthenticatedRequest()
    {
        var fixture = CreateUserFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(CreateContext()),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("passkey_step_up_user_required", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Equal(0, fixture.Passkeys.BeginStepUpAccountId);
    }

    [Fact]
    public async Task UserProvider_VerifyAsync_ConsumesUserStepUpAndRecordsVerifiedAttempt()
    {
        var fixture = CreateUserFixture();
        PasskeyLoginCompleteCoreModel assertion = CreateAssertion("stepup-token");

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(CreateUserContext(), PasskeyStepUpV1ChallengeProvider.WireKind, CreateVerifyPayload(assertion)),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(42, fixture.Passkeys.CompleteStepUpAccountId);
        Assert.NotNull(fixture.Passkeys.CompleteStepUpRequest);
        Assert.Equal(assertion.ChallengeToken, fixture.Passkeys.CompleteStepUpRequest.ChallengeToken);
        Assert.Equal(assertion.Id, fixture.Passkeys.CompleteStepUpRequest.Id);
        Assert.Equal(assertion.RawId, fixture.Passkeys.CompleteStepUpRequest.RawId);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, attempt.Outcome);
        Assert.Equal("ok", attempt.Reason);
    }

    [Fact]
    public async Task UserProvider_VerifyAsync_RejectsAdminProofPayloadShape()
    {
        var fixture = CreateUserFixture();
        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["proofToken"] = "admin-proof-token"
        };

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(CreateUserContext(), PasskeyStepUpV1ChallengeProvider.WireKind, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("passkey_step_up_payload_invalid", result.Reason);
        Assert.Equal(0, fixture.Passkeys.CompleteStepUpAccountId);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, Assert.Single(fixture.Persistence.Attempts).Outcome);
    }

    [Fact]
    public async Task AdminProvider_IssueAndVerifyUseVerifyOnlyAdminPasskeyPath()
    {
        var fixture = CreateAdminFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(CreateAdminContext()),
            CancellationToken.None);

        SecurityChallengeProviderVerifyResult verified = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(CreateAdminContext(), AdminPasskeyStepUpV1ChallengeProvider.WireKind, CreateVerifyPayload(CreateAssertion("admin-stepup-token"))),
            CancellationToken.None);

        Assert.True(issued.Succeeded, issued.Reason);
        Assert.NotNull(issued.Assignment);
        Assert.Equal(SecurityChallengeKind.AdminPasskeyStepUpV1, issued.Assignment.Kind);
        Assert.Equal(AdminPasskeyStepUpV1ChallengeProvider.Algorithm, issued.ProviderPayload["algorithm"]);
        Assert.True(verified.Succeeded, verified.Reason);
        Assert.Equal(42, fixture.Admins.BeginStepUpAdminId);
        Assert.Equal("admin-sid-1", fixture.Admins.BeginStepUpSessionId);
        Assert.Equal(42, fixture.Admins.VerifyOnlyAdminId);
        Assert.Equal("admin-sid-1", fixture.Admins.VerifyOnlySessionId);
        Assert.Equal(0, fixture.Admins.CompleteStepUpCalls);
        Assert.Equal(0, fixture.Admins.CreateProofCalls);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, Assert.Single(fixture.Persistence.Attempts).Outcome);
    }

    [Fact]
    public async Task AdminProvider_IssueAsync_RejectsOrdinaryUser()
    {
        var fixture = CreateAdminFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(CreateUserContext()),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("admin_passkey_step_up_admin_required", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
    }

    private static UserProviderFixture CreateUserFixture()
    {
        var passkeys = new FakePasskeyService();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        return new UserProviderFixture(
            new PasskeyStepUpV1ChallengeProvider(passkeys, persistence, clock),
            passkeys,
            persistence);
    }

    private static AdminProviderFixture CreateAdminFixture()
    {
        var admins = new FakeAdminPrincipalService();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        return new AdminProviderFixture(
            new AdminPasskeyStepUpV1ChallengeProvider(admins, persistence, clock),
            admins,
            persistence);
    }

    private static SecurityChallengeProviderIssueRequest CreateIssueRequest(HttpContext context)
        => new(
            context,
            PasskeyStepUpV1ChallengeProvider.WireKind,
            "profile.email.change",
            "user:42:email",
            "tenant-main",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            2,
            Traceparent);

    private static SecurityChallengeProviderVerifyRequest CreateVerifyRequest(
        HttpContext context,
        string kind,
        IReadOnlyDictionary<string, string> payload)
        => new(
            context,
            kind,
            SecurityChallengeContracts.CreateChallengeId(),
            "profile.email.change",
            "user:42:email",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            payload);

    private static Dictionary<string, string> CreateVerifyPayload(PasskeyLoginCompleteCoreModel assertion)
        => new(StringComparer.Ordinal)
        {
            ["assertionJson"] = JsonSerializer.Serialize(assertion, PasskeyStepUpV1ChallengeProvider.JsonOptionsForTests)
        };

    private static PasskeyLoginCompleteCoreModel CreateAssertion(string token)
        => new()
        {
            ChallengeToken = token,
            Id = "credential-id",
            RawId = [1, 2, 3],
            ClientDataBytes = [4, 5, 6],
            AuthenticatorData = [7, 8, 9],
            Signature = [10, 11, 12],
            UserHandle = [13, 14],
            RememberMe = false
        };

    private static DefaultHttpContext CreateUserContext()
    {
        var context = CreateContext();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)
            ],
            "unit"));
        return context;
    }

    private static DefaultHttpContext CreateAdminContext()
    {
        var context = CreateContext();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "42"),
                new Claim("admin_sid", "admin-sid-1")
            ],
            "unit"));
        return context;
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-step-up-unit";
        context.Request.Headers["traceparent"] = Traceparent;
        context.Request.Headers["X-Fsus-Device-Fp"] = "device-123";
        return context;
    }

    private sealed record UserProviderFixture(
        PasskeyStepUpV1ChallengeProvider Provider,
        FakePasskeyService Passkeys,
        RecordingChallengePersistence Persistence);

    private sealed record AdminProviderFixture(
        AdminPasskeyStepUpV1ChallengeProvider Provider,
        FakeAdminPrincipalService Admins,
        RecordingChallengePersistence Persistence);

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }

    private sealed class FakePasskeyService : IPasskeyService
    {
        public int BeginStepUpAccountId
        {
            get; private set;
        }
        public int CompleteStepUpAccountId
        {
            get; private set;
        }
        public PasskeyLoginCompleteCoreModel? CompleteStepUpRequest
        {
            get; private set;
        }

        public Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginStepUpAssertionAsync(int accountId, CancellationToken cancellationToken = default)
        {
            BeginStepUpAccountId = accountId;
            var options = new PasskeyLoginBeginCoreModel
            {
                ChallengeToken = "stepup-token",
                Timeout = 60_000,
                RpId = "localhost",
                UserVerification = 2,
                Challenge = [1, 2, 3],
                AllowCredentials = []
            };
            return Task.FromResult<(bool, string, PasskeyAuthBeginData?)>((true, "ok", new PasskeyAuthBeginData(options)));
        }

        public Task<(bool Success, string Message)> CompleteStepUpAssertionAsync(int accountId, PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default)
        {
            CompleteStepUpAccountId = accountId;
            CompleteStepUpRequest = request;
            return Task.FromResult((true, "ok"));
        }

        public Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginActionStepUpAssertionAsync(int accountId, string action, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<(bool Success, string Message, string Action)> CompleteActionStepUpAssertionAsync(int accountId, PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginRegistrationAsync(int accountId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<(bool Success, string Message)> CompleteRegistrationAsync(int accountId, PasskeyRegisterCompleteCoreModel request, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<RecoveryPasskeyRegistrationResult> CompleteRecoveryRegistrationAsync(RecoveryKeySession session, string recoverySessionHash, string recoveryRequestHash, PasskeyRegisterCompleteCoreModel request, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<RecoveryPasskeyRegistrationResult?> TryResolveRecoveryRegistrationAsync(string recoverySessionHash, string recoveryRequestHash, string registrationSessionKey, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAssertionAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<(bool Success, string Message, User? User)> CompleteAssertionAsync(PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IList<PasskeyCredentialSummaryDto>> GetCredentialsAsync(int accountId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<PasskeyCredentialMutationResult> RemoveCredentialAsync(int accountId, int credId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> RenameCredentialAsync(int accountId, int credId, string name, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeAdminPrincipalService : IAdminPrincipalService
    {
        public long BeginStepUpAdminId
        {
            get; private set;
        }
        public string? BeginStepUpSessionId
        {
            get; private set;
        }
        public long VerifyOnlyAdminId
        {
            get; private set;
        }
        public string? VerifyOnlySessionId
        {
            get; private set;
        }
        public int CompleteStepUpCalls
        {
            get; private set;
        }
        public int CreateProofCalls
        {
            get; private set;
        }

        public Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminStepUpAssertionAsync(long adminPrincipalId, string adminSessionId, CancellationToken cancellationToken = default)
        {
            BeginStepUpAdminId = adminPrincipalId;
            BeginStepUpSessionId = adminSessionId;
            var options = new PasskeyLoginBeginCoreModel
            {
                ChallengeToken = "admin-stepup-token",
                Timeout = 60_000,
                RpId = "localhost",
                UserVerification = 2,
                Challenge = [1, 2, 3],
                AllowCredentials = []
            };
            return Task.FromResult<(bool, string, PasskeyAuthBeginData?)>((true, "ok", new PasskeyAuthBeginData(options)));
        }

        public Task<(bool Success, string Message)> VerifyAdminStepUpAssertionAsync(
            long adminPrincipalId,
            string adminSessionId,
            PasskeyLoginCompleteCoreModel request,
            AdminAuthClientContext clientContext,
            CancellationToken cancellationToken = default)
        {
            VerifyOnlyAdminId = adminPrincipalId;
            VerifyOnlySessionId = adminSessionId;
            return Task.FromResult((true, "ok"));
        }

        public Task<(bool Success, string Message, string? ProofToken)> CompleteAdminStepUpAssertionAsync(long adminPrincipalId, string adminSessionId, PasskeyLoginCompleteCoreModel request, AdminAuthClientContext clientContext, CancellationToken cancellationToken = default)
        {
            CompleteStepUpCalls++;
            return Task.FromResult<(bool, string, string?)>((true, "ok", "admin-proof-token"));
        }

        public Task<string> CreateAdminStepUpProofTokenAsync(long adminPrincipalId, string adminSessionId, string action, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
            CreateProofCalls++;
            return Task.FromResult("admin-proof-token");
        }

        public Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginBootstrapPasskeyRegistrationAsync(string? bootstrapToken, string? handle, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteBootstrapPasskeyRegistrationAsync(string? bootstrapToken, PasskeyRegisterCompleteCoreModel request, AdminAuthClientContext clientContext, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminAssertionAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteAdminAssertionAsync(PasskeyLoginCompleteCoreModel request, AdminAuthClientContext clientContext, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ValidateAndConsumeAdminStepUpProofTokenAsync(long adminPrincipalId, string adminSessionId, string action, string token, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IReadOnlyList<AdminSessionSummaryDto>> GetAdminSessionsAsync(long adminPrincipalId, string currentSessionId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> EnsureAdminSessionBelongsToPrincipalAsync(long adminPrincipalId, string sessionId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> LogoutAdminSessionAsync(long adminPrincipalId, string sessionId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AdminSessionRevokeResult> RevokeAdminSessionAsync(long adminPrincipalId, string sessionId, string reason, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<int> RevokeOtherAdminSessionsAsync(long adminPrincipalId, string currentSessionId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeIssueRequest> Issues { get; } = [];
        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
        {
            Issues.Add(request);
            return Task.FromResult(new SecurityChallenge
            {
                ChallengeId = request.ChallengeId,
                Status = SecurityChallengeStatuses.Issued,
                Kind = request.Kind,
                Algorithm = request.Algorithm,
                Action = request.Action,
                RouteKey = request.RouteKey,
                SubjectHash = request.SubjectHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                PolicyVersion = request.PolicyVersion,
                PayloadHash = request.PayloadHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                IssuedAtUtc = request.IssuedAtUtc,
                ExpiresAtUtc = request.ExpiresAtUtc
            });
        }

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt
            {
                AttemptId = SecurityChallengeContracts.CreateChallengeId(),
                ChallengeId = request.ChallengeId,
                Outcome = request.Outcome,
                Reason = request.Reason,
                PayloadHash = request.PayloadHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                AttemptedAtUtc = request.AttemptedAtUtc ?? DateTime.UtcNow
            });
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => Task.FromResult(false);
    }
}
