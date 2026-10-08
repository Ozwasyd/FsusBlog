using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
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
using FsusBlog.Server.Infrastructure.Audit;
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
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Serilog;
using Serilog.Core;
using Serilog.Events;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MfaLoginEndpointPostgresTests(
    PostgresSchemaMigrationFixture fixture,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private const string DeviceA = "issue-2348-device-a";
    private const string DeviceB = "issue-2348-device-b";

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task MfaEnabledPasskeyLogin_CreatesNoSessionUntilTotpContinuationCompletes()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);

        using HttpResponseMessage pendingResponse = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        Assert.Equal(HttpStatusCode.OK, pendingResponse.StatusCode);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(pendingResponse);
        Assert.Equal("mfa_required", pending.AuthPhase);
        Assert.Equal("standard", pending.MfaMode);
        Assert.False(string.IsNullOrWhiteSpace(pending.ChallengeToken));
        Assert.False(pendingResponse.Headers.TryGetValues("Set-Cookie", out _));
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(0, await host.CountSessionsAsync());

        using HttpResponseMessage pendingSensitiveAccess = await host.AccessProtectedEndpointAsync(
            pending.ChallengeToken!);
        Assert.Equal(HttpStatusCode.Unauthorized, pendingSensitiveAccess.StatusCode);
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));

        AuthAuthoritySnapshot beforeRefresh = await host.CaptureAuthorityAsync();
        int auditCount = host.AuthAuditEvents.Length;
        using HttpResponseMessage earlyRefresh = await host.RefreshAsync(
            pending.ChallengeToken!,
            pending.ChallengeToken!);
        await AssertRefreshRejectedAsync(earlyRefresh, "REFRESH_EXPIRED_OR_UNKNOWN", clearsCookies: true);
        Assert.Equal(beforeRefresh, await host.CaptureAuthorityAsync());
        AssertRefreshFailureAudit(host, auditCount, "expired-or-unknown");
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(0, await host.CountSessionsAsync());

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
        await host.AssertAccessTokenMatchesSessionAsync(completedResponse, stored);
        Assert.False(await host.ContinuationExistsAsync(pending.ChallengeToken!));

        using HttpResponseMessage replay = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            totp,
            DeviceA);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        Assert.Equal("MFA_CHALLENGE_EXPIRED", (await ReadErrorAsync(replay)).Message);
        Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(1, await host.CountSessionsAsync());
    }

    [Fact]
    public async Task MfaContinuation_ConcurrentTotpCompletionCreatesExactlyOnePostgresSession()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
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
            Assert.Equal(1, await host.CountSessionsAsync());
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
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);

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

        await host.ExpireContinuationThroughRedisTtlAsync(pending.ChallengeToken!);
        using HttpResponseMessage expired = await host.CompleteMfaAsync(
            pending.ChallengeToken!,
            ComputeCurrentTotp(host.MfaSecret),
            DeviceA);
        await AssertRejectedWithoutDetailLeakAsync(expired, "MFA_CHALLENGE_EXPIRED");

        using HttpResponseMessage revokedPendingResponse = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto revokedPending = await ReadLoginFlowAsync(revokedPendingResponse);
        // Exercise production RecordFailureAsync and canonical invalidation, not a
        // fixture-side deletion labelled "revocation".
        for (int attempt = 0; attempt < 5; attempt++)
        {
            using HttpResponseMessage failed = await host.CompleteMfaAsync(
                revokedPending.ChallengeToken!, null, DeviceA, "invalid-recovery-code");
            await AssertRejectedWithoutDetailLeakAsync(
                failed, attempt == 4 ? "MFA_CHALLENGE_LOCKED" : "MFA_CHALLENGE_INVALID");
        }
        Assert.False(await host.ContinuationExistsAsync(revokedPending.ChallengeToken!));
        using HttpResponseMessage revoked = await host.CompleteMfaAsync(
            revokedPending.ChallengeToken!,
            ComputeCurrentTotp(host.MfaSecret),
            DeviceA);
        await AssertRejectedWithoutDetailLeakAsync(revoked, "MFA_CHALLENGE_EXPIRED");

        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(0, await host.CountSessionsAsync());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task NonMfaPasskeyLogin_PreservesDirectSessionAndCookieSemantics()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);

        using HttpResponseMessage response = await host.PasskeyLoginAsync(host.NonMfaUser.Id, DeviceA);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AuthLoginFlowDto flow = await ReadLoginFlowAsync(response);
        Assert.Equal("authenticated", flow.AuthPhase);
        Assert.Null(flow.ChallengeToken);
        UserSession stored = Assert.Single(await host.GetActiveSessionsAsync(host.NonMfaUser.Id));
        Assert.Equal(ReadCookie(response, "SessionId"), stored.SessionId);
        Assert.Equal(HashToken(ReadCookie(response, "RefreshToken")), stored.RefreshTokenHash);
        Assert.Equal(UserSessionAuthenticationStrengths.WebAuthnUv, stored.AuthenticationStrength);
        await host.AssertAccessTokenMatchesSessionAsync(response, stored);
        Assert.Equal(0, host.ActiveContinuationCount);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "mfa-continuation-authority")]
    public async Task MfaContinuation_TwoAccountRecoveryProofsCannotCompleteEachOthersLogin()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        string codeA = Assert.Single(await host.SeedRecoveryCodesAsync(host.MfaUser.Id, 1));
        string codeB = Assert.Single(await host.SeedRecoveryCodesAsync(host.OtherMfaUser.Id, 1));
        Assert.NotEqual(codeA, codeB);
        string hashesA = await host.ReadRecoveryHashesAsync(host.MfaUser.Id);
        string hashesB = await host.ReadRecoveryHashesAsync(host.OtherMfaUser.Id);
        using HttpResponseMessage loginA = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        using HttpResponseMessage loginB = await host.PasskeyLoginAsync(host.OtherMfaUser.Id, DeviceA);
        AuthLoginFlowDto pendingA = await ReadLoginFlowAsync(loginA);
        AuthLoginFlowDto pendingB = await ReadLoginFlowAsync(loginB);
        Assert.NotEqual(pendingA.ChallengeToken, pendingB.ChallengeToken);

        using HttpResponseMessage swappedA = await host.CompleteMfaAsync(
            pendingA.ChallengeToken!, null, DeviceA, codeB);
        using HttpResponseMessage swappedB = await host.CompleteMfaAsync(
            pendingB.ChallengeToken!, null, DeviceA, codeA);
        await AssertRejectedWithoutDetailLeakAsync(swappedA, "MFA_CHALLENGE_INVALID");
        await AssertRejectedWithoutDetailLeakAsync(swappedB, "MFA_CHALLENGE_INVALID");
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.OtherMfaUser.Id));
        Assert.Equal(0, await host.CountSessionsAsync());
        Assert.Equal(hashesA, await host.ReadRecoveryHashesAsync(host.MfaUser.Id));
        Assert.Equal(hashesB, await host.ReadRecoveryHashesAsync(host.OtherMfaUser.Id));
        Assert.True(await host.ContinuationExistsAsync(pendingA.ChallengeToken!));
        Assert.True(await host.ContinuationExistsAsync(pendingB.ChallengeToken!));

        using HttpResponseMessage completedA = await host.CompleteMfaAsync(
            pendingA.ChallengeToken!, null, DeviceA, codeA);
        using HttpResponseMessage completedB = await host.CompleteMfaAsync(
            pendingB.ChallengeToken!, null, DeviceA, codeB);
        Assert.Equal(host.MfaUser.Id, (await ReadMfaResultAsync(completedA)).User?.AccountId);
        Assert.Equal(host.OtherMfaUser.Id, (await ReadMfaResultAsync(completedB)).User?.AccountId);
        await host.AssertAccessTokenMatchesSessionAsync(
            completedA, Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id)));
        await host.AssertAccessTokenMatchesSessionAsync(
            completedB, Assert.Single(await host.GetActiveSessionsAsync(host.OtherMfaUser.Id)));
        Assert.Equal(string.Empty, await host.ReadRecoveryHashesAsync(host.MfaUser.Id));
        Assert.Equal(string.Empty, await host.ReadRecoveryHashesAsync(host.OtherMfaUser.Id));
        Assert.False(await host.ContinuationExistsAsync(pendingA.ChallengeToken!));
        Assert.False(await host.ContinuationExistsAsync(pendingB.ChallengeToken!));
        Assert.Equal(2, await host.CountSessionsAsync());
    }

    [Theory]
    [InlineData(2)]
    [InlineData(6)]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "mfa-continuation-authority")]
    public async Task RecoveryCode_IndependentMfaContinuationsRaceAndReplayIssueOnlyOneSession(int participants)
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        IReadOnlyList<string> codes = await host.SeedRecoveryCodesAsync(host.MfaUser.Id, 2);
        string beforeHashes = await host.ReadRecoveryHashesAsync(host.MfaUser.Id);
        string expectedHashes = host.ConsumeRecoveryHash(beforeHashes, codes[0]);
        var continuations = new List<string>();
        for (int index = 0; index < participants; index++)
        {
            using HttpResponseMessage login = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
            AuthLoginFlowDto pending = await ReadLoginFlowAsync(login);
            Assert.False(login.Headers.TryGetValues("Set-Cookie", out _));
            continuations.Add(pending.ChallengeToken!);
        }
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        using var barrier = new Barrier(participants);
        Task<HttpResponseMessage>[] attempts = continuations.Select(challenge => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(20)));
                return await host.CompleteMfaAsync(challenge, null, DeviceA, codes[0]);
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap()).ToArray();
        HttpResponseMessage[] responses = await Task.WhenAll(attempts).WaitAsync(TimeSpan.FromSeconds(30));
        try
        {
            HttpResponseMessage winner = Assert.Single(responses, response => response.StatusCode == HttpStatusCode.OK);
            int winnerIndex = Array.IndexOf(responses, winner);
            Assert.Equal(host.MfaUser.Id, (await ReadMfaResultAsync(winner)).User?.AccountId);
            UserSession stored = Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
            Assert.Equal(UserSessionAuthenticationStrengths.Recovery, stored.AuthenticationStrength);
            await host.AssertAccessTokenMatchesSessionAsync(winner, stored);
            Assert.False(await host.ContinuationExistsAsync(continuations[winnerIndex]));
            foreach (HttpResponseMessage loser in responses.Where(response => response != winner))
            {
                await AssertRejectedWithoutDetailLeakAsync(loser, "MFA_CHALLENGE_INVALID");
                Assert.True(await host.ContinuationExistsAsync(continuations[Array.IndexOf(responses, loser)]));
            }
            Assert.Equal(expectedHashes, await host.ReadRecoveryHashesAsync(host.MfaUser.Id));
            Assert.Equal(0, await host.CountActiveSessionsAsync(host.OtherMfaUser.Id));
            Assert.Equal(1, await host.CountSessionsAsync());

            using HttpResponseMessage replay = await host.CompleteMfaAsync(
                continuations[winnerIndex], null, DeviceA, codes[0]);
            await AssertRejectedWithoutDetailLeakAsync(replay, "MFA_CHALLENGE_EXPIRED");
            using HttpResponseMessage freshLogin = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
            AuthLoginFlowDto fresh = await ReadLoginFlowAsync(freshLogin);
            using HttpResponseMessage replayWithFreshContinuation = await host.CompleteMfaAsync(
                fresh.ChallengeToken!, null, DeviceA, codes[0]);
            await AssertRejectedWithoutDetailLeakAsync(replayWithFreshContinuation, "MFA_CHALLENGE_INVALID");
            Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
            Assert.Equal(expectedHashes, await host.ReadRecoveryHashesAsync(host.MfaUser.Id));
            Assert.Equal(1, await host.CountSessionsAsync());

            using HttpResponseMessage retainedCode = await host.CompleteMfaAsync(
                fresh.ChallengeToken!, null, DeviceA, codes[1]);
            Assert.Equal(HttpStatusCode.OK, retainedCode.StatusCode);
            Assert.Equal(2, await host.CountActiveSessionsAsync(host.MfaUser.Id));
            Assert.Equal(2, await host.CountSessionsAsync());
            Assert.Equal(string.Empty, await host.ReadRecoveryHashesAsync(host.MfaUser.Id));
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
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-authentication-context-coherence")]
    public async Task CompletedMfaAccessToken_AfterCanonicalCacheInvalidationRejectsDatabaseContextMismatch()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        using HttpResponseMessage login = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(login);
        using HttpResponseMessage completed = await host.CompleteMfaAsync(
            pending.ChallengeToken!, ComputeCurrentTotp(host.MfaSecret), DeviceA);
        UserSession stored = Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        await host.AssertAccessTokenMatchesSessionAsync(completed, stored);
        await host.ChangeSessionStrengthAsync(stored.SessionId, UserSessionAuthenticationStrengths.WebAuthnUv);
        using HttpResponseMessage rejected = await host.AccessProtectedEndpointAsync(ReadCookie(completed, "AccessToken"));
        Assert.Equal(HttpStatusCode.Unauthorized, rejected.StatusCode);
        Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(1, await host.CountSessionsAsync());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-refresh-authority")]
    public async Task GuestRefresh_WithoutCookiesRejectsWithoutIssuingOrConsumingAuthority()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        AuthAuthoritySnapshot before = await host.CaptureAuthorityAsync();
        int auditCount = host.AuthAuditEvents.Length;

        using HttpResponseMessage rejected = await host.RefreshWithoutCookiesAsync();

        await AssertRefreshRejectedAsync(rejected, "会话已失效，请重新登录", clearsCookies: false);
        Assert.Equal(before, await host.CaptureAuthorityAsync());
        Assert.Equal(0, await host.CountSessionsAsync());
        // The mapped endpoint rejects before the rotation service or MFA verifier.
        Assert.Equal(auditCount, host.AuthAuditEvents.Length);
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-refresh-authority")]
    public async Task CompletedMfaRefresh_InactivePostgresSessionRejectsWithoutRotationOrProofConsumption(string scenario)
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        using HttpResponseMessage login = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(login);
        using HttpResponseMessage completed = await host.CompleteMfaAsync(
            pending.ChallengeToken!, ComputeCurrentTotp(host.MfaSecret), DeviceA);
        UserSession issued = Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        await host.AssertAccessTokenMatchesSessionAsync(completed, issued);
        string proof = await host.CreateRetainedProofAsync(issued.SessionId);
        using HttpResponseMessage controlLogin = await host.PasskeyLoginAsync(host.OtherMfaUser.Id, DeviceB);
        string controlContinuation = (await ReadLoginFlowAsync(controlLogin)).ChallengeToken!;
        await host.RevokeOrExpireSessionAsync(issued.SessionId, scenario);
        AuthAuthoritySnapshot before = await host.CaptureAuthorityAsync();
        int auditCount = host.AuthAuditEvents.Length;

        using HttpResponseMessage rejected = await host.RefreshAsync(
            ReadCookie(completed, "RefreshToken"), issued.SessionId);

        await AssertRefreshRejectedAsync(rejected, "REFRESH_EXPIRED_OR_UNKNOWN", clearsCookies: true);
        Assert.Equal(before, await host.CaptureAuthorityAsync());
        UserSession after = await host.ReadSessionAsync(issued.SessionId);
        Assert.Equal(issued.RefreshTokenHash, after.RefreshTokenHash);
        Assert.Equal(issued.RefreshFamilyId, after.RefreshFamilyId);
        Assert.Equal(issued.RefreshGeneration, after.RefreshGeneration);
        Assert.Equal(1, await host.CountSessionsAsync());
        Assert.Equal(0, await host.CountRefreshTombstonesAsync());
        Assert.True(await host.ContinuationExistsAsync(controlContinuation));
        AssertRefreshFailureAudit(host, auditCount, "expired-or-revoked");
        // The low-level consume oracle proves refresh left the issued proof intact;
        // it does not grant an inactive Session sensitive-action authorization.
        Assert.True(await host.ConsumeRetainedProofAsync(issued.SessionId, proof));
        Assert.False(await host.ConsumeRetainedProofAsync(issued.SessionId, proof));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "mfa-continuation-authority")]
    public async Task CompletedMfa_RealLogoutThenOldContinuationReplayCannotCreateAnotherSession()
    {
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        using HttpResponseMessage login = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(login);
        using HttpResponseMessage completed = await host.CompleteMfaAsync(
            pending.ChallengeToken!, ComputeCurrentTotp(host.MfaSecret), DeviceA);
        UserSession issued = Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        await host.AssertAccessTokenMatchesSessionAsync(completed, issued);
        string proof = await host.CreateRetainedProofAsync(issued.SessionId);
        Assert.False(await host.ContinuationExistsAsync(pending.ChallengeToken!));
        int auditCount = host.AuthAuditEvents.Length;

        using HttpResponseMessage logout = await host.LogoutAsync(
            ReadCookie(completed, "AccessToken"), ReadCookie(completed, "RefreshToken"), issued.SessionId);

        Assert.Equal(HttpStatusCode.OK, logout.StatusCode);
        await AssertEmptySuccessAsync(logout);
        AssertDeletedAuthCookies(logout, includesAdmin: true);
        UserSession revoked = await host.ReadSessionAsync(issued.SessionId);
        Assert.NotNull(revoked.RevokedAt);
        Assert.Equal("logout", revoked.RevokeReason);
        Assert.Equal(UserSessionMode.Revoked, revoked.SessionMode);
        Assert.Equal(issued.RefreshTokenHash, revoked.RefreshTokenHash);
        Assert.Equal(issued.RefreshGeneration, revoked.RefreshGeneration);
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(auditCount, host.AuthAuditEvents.Length);
        AuthAuthoritySnapshot beforeReplay = await host.CaptureAuthorityAsync();

        using HttpResponseMessage replay = await host.CompleteMfaAsync(
            pending.ChallengeToken!, ComputeCurrentTotp(host.MfaSecret), DeviceA);

        await AssertRejectedWithoutDetailLeakAsync(replay, "MFA_CHALLENGE_EXPIRED");
        Assert.Equal(beforeReplay, await host.CaptureAuthorityAsync());
        Assert.Equal(1, await host.CountSessionsAsync());
        Assert.Equal(0, await host.CountActiveSessionsAsync(host.MfaUser.Id));
        Assert.Equal(auditCount, host.AuthAuditEvents.Length);
        Assert.True(await host.ConsumeRetainedProofAsync(issued.SessionId, proof));
        Assert.False(await host.ConsumeRetainedProofAsync(issued.SessionId, proof));

        // Logout retires the old authority, not the account's ability to begin a
        // new canonical Passkey login. Do not recreate the fake terminal state.
        using HttpResponseMessage freshLogin = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        Assert.Equal("mfa_required", (await ReadLoginFlowAsync(freshLogin)).AuthPhase);
        Assert.False(freshLogin.Headers.TryGetValues("Set-Cookie", out _));
        Assert.Equal(1, await host.CountSessionsAsync());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task CompletedMfaToken_MappedPublicHandleWriteExecutesProductionCommandInPostgres()
    {
        const string PublicHandle = "mfa2348written";
        await using MfaLoginTestHost host = await MfaLoginTestHost.CreateAsync(fixture, redis);
        using HttpResponseMessage login = await host.PasskeyLoginAsync(host.MfaUser.Id, DeviceA);
        AuthLoginFlowDto pending = await ReadLoginFlowAsync(login);
        AuthAuthoritySnapshot beforePendingWrite = await host.CaptureAuthorityAsync();
        int pendingAuditCount = host.AuthAuditEvents.Length;
        using HttpResponseMessage pendingWrite = await host.WritePublicHandleAsync(pending.ChallengeToken!, PublicHandle);
        Assert.Equal(HttpStatusCode.Unauthorized, pendingWrite.StatusCode);
        // Default JWT authorization challenges before the mapped write handler;
        // unlike the refresh endpoint's AEDS error, its canonical body is empty.
        Assert.Empty(await pendingWrite.Content.ReadAsByteArrayAsync());
        Assert.Equal("Bearer", Assert.Single(pendingWrite.Headers.WwwAuthenticate).Scheme);
        Assert.False(pendingWrite.Headers.TryGetValues("Set-Cookie", out _));
        Assert.Equal(beforePendingWrite, await host.CaptureAuthorityAsync());
        Assert.Equal(pendingAuditCount, host.AuthAuditEvents.Length);
        Assert.Equal(0, await host.CountSessionsAsync());
        Assert.Equal(0, await host.CountRefreshTombstonesAsync());

        using HttpResponseMessage completed = await host.CompleteMfaAsync(
            pending.ChallengeToken!, ComputeCurrentTotp(host.MfaSecret), DeviceA);
        UserSession issued = Assert.Single(await host.GetActiveSessionsAsync(host.MfaUser.Id));
        await host.AssertAccessTokenMatchesSessionAsync(completed, issued);
        User before = await host.ReadUserAsync(host.MfaUser.Id);
        User otherBefore = await host.ReadUserAsync(host.OtherMfaUser.Id);
        string recoveryHashes = await host.ReadRecoveryHashesAsync(host.MfaUser.Id);
        AuthAuthoritySnapshot beforeWrite = await host.CaptureAuthorityAsync();
        int auditCount = host.AuthAuditEvents.Length;

        using HttpResponseMessage written = await host.WritePublicHandleAsync(
            ReadCookie(completed, "AccessToken"), PublicHandle);

        Assert.Equal(HttpStatusCode.OK, written.StatusCode);
        await AssertEmptySuccessAsync(written);
        Assert.False(written.Headers.TryGetValues("Set-Cookie", out _));
        User after = await host.ReadUserAsync(host.MfaUser.Id);
        Assert.Equal(PublicHandle, after.PublicHandle);
        Assert.Equal(before.PasskeySignalVersion + 1, after.PasskeySignalVersion);
        User otherAfter = await host.ReadUserAsync(host.OtherMfaUser.Id);
        Assert.Equal(otherBefore.PublicHandle, otherAfter.PublicHandle);
        Assert.Equal(otherBefore.PasskeySignalVersion, otherAfter.PasskeySignalVersion);
        Assert.Equal(recoveryHashes, await host.ReadRecoveryHashesAsync(host.MfaUser.Id));
        Assert.Equal(beforeWrite.Sessions, (await host.CaptureAuthorityAsync()).Sessions);
        Assert.False(await host.ContinuationExistsAsync(pending.ChallengeToken!));
        Assert.Equal(1, await host.CountSessionsAsync());
        Assert.Equal(0, await host.CountRefreshTombstonesAsync());
        Assert.Equal(auditCount, host.AuthAuditEvents.Length);
        // Public-handle is an existing authenticated write, not a step-up action.
        // Keep its production policy; do not add MFA or claim credential mutation.
    }

    private static async Task AssertRefreshRejectedAsync(
        HttpResponseMessage response,
        string message,
        bool clearsCookies)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        ErrorDetail error = await ReadErrorAsync(response);
        Assert.Equal(ErrorCode.Unauthorized, error.Code);
        Assert.Equal(message, error.Message);
        if (clearsCookies)
        {
            AssertDeletedAuthCookies(response, includesAdmin: false);
        }
        else
        {
            Assert.False(response.Headers.TryGetValues("Set-Cookie", out _));
        }
    }

    private static void AssertDeletedAuthCookies(HttpResponseMessage response, bool includesAdmin)
    {
        string[] names = includesAdmin
            ? ["AccessToken", "RefreshToken", "SessionId", "AdminAccessToken", "AdminSessionId"]
            : ["AccessToken", "RefreshToken", "SessionId"];
        string[] expected = names.SelectMany(static name => new[] { name, "__Host-" + name }).ToArray();
        string[] cookies = response.Headers.GetValues("Set-Cookie").ToArray();
        Assert.Equal(expected.Length, cookies.Length);
        foreach (string name in expected)
        {
            string cookie = Assert.Single(cookies, value => value.StartsWith(name + "=", StringComparison.Ordinal));
            Assert.StartsWith(name + "=;", cookie, StringComparison.Ordinal);
            Assert.Contains("expires=Thu, 01 Jan 1970 00:00:00 GMT", cookie, StringComparison.Ordinal);
        }
    }

    private static void AssertRefreshFailureAudit(MfaLoginTestHost host, int previousCount, string reason)
    {
        LogEvent audit = Assert.Single(host.AuthAuditEvents.Skip(previousCount));
        Assert.Equal(AuditSourceCatalog.Auth, Assert.IsType<ScalarValue>(audit.Properties[AuditPropertyNames.Source]).Value);
        Assert.Equal(AuditTypeCatalog.Security, Assert.IsType<ScalarValue>(audit.Properties[AuditPropertyNames.Type]).Value);
        Assert.Equal("refresh.failed", Assert.IsType<ScalarValue>(audit.Properties["AuditAction"]).Value);
        Assert.Equal(reason, Assert.IsType<ScalarValue>(audit.Properties["Reason"]).Value);
    }

    private static async Task AssertEmptySuccessAsync(HttpResponseMessage response)
    {
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.EmptySuccess, decoded.Value.FrameType);
    }

    private sealed record AuthAuthoritySnapshot(string Accounts, string Sessions, string Profiles, string Tombstones, string Cache);

    private sealed class AuthAuditSink : ILogEventSink
    {
        private readonly ConcurrentQueue<LogEvent> _events = new();

        public LogEvent[] Events => _events.ToArray();

        public void Emit(LogEvent logEvent)
        {
            if (logEvent.Properties.ContainsKey("AuditAction")
                && logEvent.Properties.TryGetValue(AuditPropertyNames.Source, out LogEventPropertyValue? source)
                && source is ScalarValue { Value: AuditSourceCatalog.Auth })
            {
                _events.Enqueue(logEvent);
            }
        }
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
        private readonly RedisMfaCache _cache;
        private readonly ITotpService _totp;
        private readonly AuthAuditSink _audit;

        private MfaLoginTestHost(
            WebApplication application,
            HttpClient client,
            SqlSugarClient db,
            RedisMfaCache cache,
            ITotpService totp,
            User mfaUser,
            User otherMfaUser,
            User nonMfaUser,
            string mfaSecret,
            string otherMfaSecret,
            AuthAuditSink audit)
        {
            _application = application;
            _client = client;
            _db = db;
            _cache = cache;
            _totp = totp;
            _audit = audit;
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
        public int ActiveContinuationCount => _cache.CountContinuations();
        public LogEvent[] AuthAuditEvents => _audit.Events;

        public static async Task<MfaLoginTestHost> CreateAsync(
            PostgresSchemaMigrationFixture fixture,
            PublicHotDeliveryRedisFixture redis)
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
                TimeProvider.System,
                new TotpService.RecoveryCodeHashPolicy(1024, 1, 1));
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

            RedisMfaCache cacheContext = await RedisMfaCache.CreateAsync(redis);
            UnifiedCache cache = cacheContext.Cache;
            var options = new WebApplicationOptions
            {
                EnvironmentName = Environments.Development
            };
            WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
            builder.WebHost.UseTestServer();
            var audit = new AuthAuditSink();
            builder.Logging.ClearProviders().AddSerilog(new LoggerConfiguration()
                .Enrich.FromLogContext()
                .WriteTo.Sink(audit)
                .CreateLogger(), dispose: true);
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = "issue-2348-jwt-signing-key-with-at-least-32-bytes",
                ["Jwt:Issuer"] = "issue-2348-tests",
                ["Jwt:Audience"] = "issue-2348-tests",
                ["ConnectionStrings:Redis"] = redis.ConnectionString,
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
            ReplaceSingleton<ICacheCompareExchangeStore>(builder.Services, cache);
            ReplaceSingleton<ICacheKeyResolver>(builder.Services, cacheContext.Keys);
            ReplaceSingleton<IUserSessionValidationCache>(
                builder.Services,
                new UserSessionValidationCache(
                    cacheContext.Keys,
                    cache,
                    cache,
                    cacheContext.Operations,
                    builder.Configuration));
            IUserLocalePreferenceReader localePreferences = Substitute.For<IUserLocalePreferenceReader>();
            localePreferences.GetAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
                .Returns(new UserLocalePreferenceDto(LocalePreferenceModes.Auto, null, 0, DateTime.UnixEpoch));
            ReplaceSingleton(builder.Services, localePreferences);
            IContentFilterService contentFilter = Substitute.For<IContentFilterService>();
            contentFilter.ValidateContent(Arg.Any<string>())
                .Returns(new ContentValidationResult(true, "ok", string.Empty));
            ReplaceSingleton(builder.Services, contentFilter);
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
                cacheContext,
                totp,
                mfaUser,
                otherMfaUser,
                nonMfaUser,
                mfaSecret,
                otherMfaSecret,
                audit);
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
            string? code,
            string deviceSignal,
            string? recoveryCode = null)
            => SendBinaryAsync(
                "/api/binary/auth/mfa/challenge",
                AedsFrameType.MfaChallengeVerifyRequest,
                PodBinaryCodec.EncodeMfaChallengeVerifyRequest(
                    new MfaChallengeVerifyRequestCoreModel(
                        challengeToken,
                        "login",
                        code,
                        recoveryCode)),
                deviceSignal);

        public Task<HttpResponseMessage> RefreshAsync(string refreshToken, string sessionId)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/api/binary/auth/refresh-token");
            request.Headers.Add("Cookie", $"RefreshToken={refreshToken}; SessionId={sessionId}");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            return _client.SendAsync(request);
        }

        public Task<HttpResponseMessage> RefreshWithoutCookiesAsync()
            => _client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/binary/auth/refresh-token"));

        public Task<HttpResponseMessage> LogoutAsync(string accessToken, string refreshToken, string sessionId)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/api/binary/auth/logout");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            request.Headers.Add("Cookie", $"RefreshToken={refreshToken}; SessionId={sessionId}");
            return _client.SendAsync(request);
        }

        public Task<HttpResponseMessage> WritePublicHandleAsync(string accessToken, string publicHandle)
        {
            var request = new HttpRequestMessage(HttpMethod.Put, "/api/binary/auth/public-handle")
            {
                Content = new ByteArrayContent(new AedsEncoder().Encode(
                    AedsFrameType.AuthUpdatePublicHandleRequest,
                    PodBinaryCodec.EncodeStringMutationRequest(publicHandle)))
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            return _client.SendAsync(request);
        }

        public Task<HttpResponseMessage> AccessProtectedEndpointAsync(string accessToken)
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

        public Task<int> CountSessionsAsync() => _db.Queryable<UserSession>().CountAsync();

        public Task<List<UserSession>> GetActiveSessionsAsync(int accountId)
            => _db.Queryable<UserSession>()
                .Where(session => session.UserId == accountId && session.RevokedAt == null)
                .ToListAsync();

        public Task<UserSession> ReadSessionAsync(string sessionId)
            => _db.Queryable<UserSession>().SingleAsync(session => session.SessionId == sessionId);

        public Task<User> ReadUserAsync(int accountId)
            => _db.Queryable<User>().SingleAsync(user => user.Id == accountId);

        public Task<int> CountRefreshTombstonesAsync() => _db.Queryable<UserRefreshTokenTombstone>().CountAsync();

        public async Task<AuthAuthoritySnapshot> CaptureAuthorityAsync()
        {
            return new AuthAuthoritySnapshot(
                await ReadRowsAsync("SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY id), '[]'::jsonb)::text FROM sys_user AS row"),
                await ReadRowsAsync("SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY sessionid), '[]'::jsonb)::text FROM sys_user_session AS row"),
                await ReadRowsAsync("SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY user_id), '[]'::jsonb)::text FROM user_mfa_profile AS row"),
                await ReadRowsAsync("SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY token_hash), '[]'::jsonb)::text FROM user_refresh_token_tombstone AS row"),
                await _cache.SnapshotAsync());
        }

        private async Task<string> ReadRowsAsync(string sql)
            => HashToken(Convert.ToString(await _db.Ado.GetScalarAsync(sql), CultureInfo.InvariantCulture)!);

        public async Task RevokeOrExpireSessionAsync(string sessionId, string scenario)
        {
            if (scenario == "revoked")
            {
                await using AsyncServiceScope scope = _application.Services.CreateAsyncScope();
                Assert.True(await scope.ServiceProvider.GetRequiredService<IUserSessionCommandService>()
                    .RevokeSessionAsync(MfaUser.Id, sessionId, "test-auth-refresh-revoke"));
                return;
            }
            string sql = scenario switch
            {
                "idle-expired" => "UPDATE sys_user_session SET idleexpiresat = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE sessionid = @SessionId",
                "absolute-expired" => "UPDATE sys_user_session SET absoluteexpiresat = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE sessionid = @SessionId",
                _ => throw new ArgumentOutOfRangeException(nameof(scenario))
            };
            Assert.Equal(1, await _db.Ado.ExecuteCommandAsync(sql, new SugarParameter("@SessionId", sessionId)));
            await _cache.Cache.RemoveAsync(CachePolicyId.SecurityUserSessionValidation, sessionId);
        }

        public async Task<string> CreateRetainedProofAsync(string sessionId)
        {
            await using AsyncServiceScope scope = _application.Services.CreateAsyncScope();
            // Seed a real canonical proof-store authority for the non-consumption
            // oracle, not a TOTP step-up endpoint or WebAuthn verification claim.
            return await scope.ServiceProvider.GetRequiredService<IMfaChallengeService>().CreateProofTokenAsync(
                MfaUser.Id, MfaUser.AccountSubjectHash!, sessionId,
                UserSecurityStepUpActions.PasskeyDelete, UserSessionAuthenticationMethods.Passkey, TimeSpan.FromMinutes(5));
        }

        public async Task<bool> ConsumeRetainedProofAsync(string sessionId, string proof)
        {
            await using AsyncServiceScope scope = _application.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<IMfaChallengeService>().ValidateAndConsumeProofTokenAsync(
                MfaUser.Id, MfaUser.AccountSubjectHash!, sessionId, UserSecurityStepUpActions.PasskeyDelete, proof);
        }

        public async Task AssertAccessTokenMatchesSessionAsync(HttpResponseMessage response, UserSession stored)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(ReadCookie(response, "SessionId"), stored.SessionId);
            Assert.Equal(HashToken(ReadCookie(response, "RefreshToken")), stored.RefreshTokenHash);
            string accessToken = ReadCookie(response, "AccessToken");
            JwtSecurityToken jwt = new JwtSecurityTokenHandler().ReadJwtToken(accessToken);
            Assert.Equal(stored.SessionId, jwt.Claims.Single(claim => claim.Type == "sid").Value);
            Assert.Equal(stored.AuthenticationMethod, jwt.Claims.Single(claim => claim.Type == "auth_method").Value);
            Assert.Equal(stored.AuthenticationStrength, jwt.Claims.Single(claim => claim.Type == "auth_strength").Value);
            Assert.Equal(
                new DateTimeOffset(DateTime.SpecifyKind(stored.AuthenticatedAtUtc, DateTimeKind.Utc)).ToUnixTimeSeconds(),
                long.Parse(jwt.Claims.Single(claim => claim.Type == "auth_time").Value, CultureInfo.InvariantCulture));
            // /auth/me is a protected account read, not action-bound sensitive authorization.
            // Its production JWT handler verifies the signature and the real PG Session.
            using HttpResponseMessage accountResponse = await AccessProtectedEndpointAsync(accessToken);
            Assert.Equal(HttpStatusCode.OK, accountResponse.StatusCode);
            var decoded = new AedsEncoder().TryDecode(await accountResponse.Content.ReadAsByteArrayAsync());
            Assert.True(decoded.IsSuccess);
            Assert.Equal(AedsFrameType.IdentityAccountSnapshot, decoded.Value.FrameType);
            Assert.True(PodBinaryCodec.TryDecodeIdentityAccountSnapshot(decoded.Value.Payload, out var account));
            Assert.Equal(stored.UserId, account.AccountId);
        }

        public async Task<IReadOnlyList<string>> SeedRecoveryCodesAsync(int accountId, int count)
        {
            IReadOnlyList<string> codes = _totp.GenerateRecoveryCodes(count);
            string hashes = _totp.HashRecoveryCodes(codes);
            await _db.Updateable<UserMfaProfile>()
                .SetColumns(profile => profile.MfaRecoveryCodesHash == hashes)
                .Where(profile => profile.UserId == accountId)
                .ExecuteCommandAsync();
            return codes;
        }

        public async Task<string> ReadRecoveryHashesAsync(int accountId)
            => (await _db.Queryable<UserMfaProfile>().SingleAsync(profile => profile.UserId == accountId)).MfaRecoveryCodesHash!;

        public string ConsumeRecoveryHash(string hashes, string code)
        {
            RecoveryCodeConsumeResult result = _totp.ConsumeRecoveryCode(hashes, code);
            Assert.True(result.Success);
            return result.UpdatedHashes;
        }

        public async Task ChangeSessionStrengthAsync(string sessionId, string strength)
        {
            await _db.Updateable<UserSession>()
                .SetColumns(session => session.AuthenticationStrength == strength)
                .Where(session => session.SessionId == sessionId)
                .ExecuteCommandAsync();
            // Force the canonical validator's PostgreSQL path after this test-only
            // row mutation; do not claim hot-cache invalidation from a direct SQL write.
            await _cache.Cache.RemoveAsync(CachePolicyId.SecurityUserSessionValidation, sessionId);
            Assert.Null(await _application.Services.GetRequiredService<IUserSessionValidationCache>()
                .ReadAsync(sessionId));
        }

        public Task<bool> ContinuationExistsAsync(string challengeToken)
            => _cache.Database.KeyExistsAsync(_cache.ResolveKey(challengeToken));

        public Task ExpireContinuationThroughRedisTtlAsync(string challengeToken)
            => _cache.ExpireThroughRedisTtlAsync(challengeToken);

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _application.DisposeAsync();
            await _cache.DisposeAsync();
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
                "risk:issue-2348",
                SecurityRiskPolicyFactory.DefaultPolicyVersion,
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

    // This adapter only owns isolated Redis resources and key inspection. All cache
    // reads, writes, failure counters and consume-once operations use UnifiedCache.
    private sealed class RedisMfaCache(
        ConnectionMultiplexer connection,
        UnifiedCache cache,
        CacheKeyResolver keys,
        string prefix) : IAsyncDisposable
    {
        public UnifiedCache Cache { get; } = cache;
        public CacheKeyResolver Keys { get; } = keys;
        public IDatabase Database { get; } = connection.GetDatabase();
        public IRedisOperationExecutor Operations { get; } = RedisOperationExecutor.ForTestConnection(connection);

        public static async Task<RedisMfaCache> CreateAsync(PublicHotDeliveryRedisFixture fixture)
        {
            ConnectionMultiplexer connection = await fixture.ConnectAsync();
            var scope = new MfaRuntimeKeyScope($"fsus-mfa-{Guid.NewGuid():N}:");
            var policies = new CachePolicyRegistry();
            var keys = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
            var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
            return new RedisMfaCache(connection, cache, keys, scope.ScopeToken);
        }

        public string ResolveKey(string challengeToken)
            => Keys.BuildKey(CachePolicyId.SecurityMfaChallenge, challengeToken);

        public int CountContinuations()
            => connection.GetServer(Assert.Single(connection.GetEndPoints()))
                .Keys(pattern: prefix + "fsus:sec:mfa-challenge:*").Count();

        public async Task<string> SnapshotAsync()
        {
            RedisKey[] keys = connection.GetServer(Assert.Single(connection.GetEndPoints()))
                .Keys(pattern: prefix + "*").OrderBy(static key => key.ToString(), StringComparer.Ordinal).ToArray();
            RedisValue[] values = keys.Length == 0 ? [] : await Database.StringGetAsync(keys);
            return HashToken(string.Join('|', keys.Select((key, index) =>
                key.ToString() + "=" + Convert.ToHexString(SHA256.HashData((byte[]?)values[index] ?? [])))));
        }

        public async Task ExpireThroughRedisTtlAsync(string challengeToken)
        {
            string key = ResolveKey(challengeToken);
            TimeSpan? issuedTtl = await Database.KeyTimeToLiveAsync(key);
            Assert.NotNull(issuedTtl);
            Assert.InRange(issuedTtl.Value, TimeSpan.FromMinutes(4), TimeSpan.FromMinutes(5));
            // Shorten only this test-owned key's physical TTL, as in the canonical
            // AnonymousCommentTicketRedisConcurrencyTests owner. Never DEL it.
            Assert.True(await Database.KeyExpireAsync(key, TimeSpan.FromMilliseconds(250)));
            TimeSpan? shortenedTtl = await Database.KeyTimeToLiveAsync(key);
            Assert.NotNull(shortenedTtl);
            Assert.InRange(shortenedTtl.Value, TimeSpan.Zero, TimeSpan.FromMilliseconds(250));
            Assert.NotNull(await Cache.GetStringAsync(CachePolicyId.SecurityMfaChallenge, challengeToken));
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (await Database.KeyExistsAsync(key))
            {
                Assert.True(DateTime.UtcNow < deadline, "Redis did not expire the MFA continuation TTL.");
                await Task.Delay(10);
            }
            Assert.Null(await Cache.GetStringAsync(CachePolicyId.SecurityMfaChallenge, challengeToken));
            Assert.False(await Cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaChallenge, challengeToken));
        }

        public async ValueTask DisposeAsync()
        {
            Cache.Dispose();
            RedisKey[] keys = connection.GetServer(Assert.Single(connection.GetEndPoints()))
                .Keys(pattern: prefix + "*").ToArray();
            if (keys.Length > 0)
            {
                await Database.KeyDeleteAsync(keys);
            }
            await connection.DisposeAsync();
        }
    }

    private sealed class MfaRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => prefix + key;
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
                ["issue-2348-postgres-endpoint-test"]);
    }
}
