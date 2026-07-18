using System.Collections.Concurrent;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SecurityStateMachine")]
public sealed class RecoveryPasskeyCompletionStateTests
{
    [Fact]
    public async Task AuthenticatorValidationFailure_RestoresPendingSessionAndAllowsRetry()
    {
        const string Token = "recovery-session-authenticator-retry";
        var cache = new AtomicRecoveryCache();
        cache.SeedPending(Token, ActiveSession());
        var passkeys = CreatePasskeysWithoutDurableCompletion();
        int attempt = 0;
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromResult(Interlocked.Increment(ref attempt) == 1
                ? RecoveryPasskeyRegistrationResult.ValidationFailed("通行密钥验证失败，请重试")
                : RecoveryPasskeyRegistrationResult.Completed()));
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);
        PasskeyRegisterCompleteCoreModel request = Request(Token, "authenticator");

        Result<RecoveryPasskeyBindOutcome> failed = await service.CompletePasskeyBindAsync(Token, request);
        Result<RecoveryKeySession> pending = await service.GetRecoverySessionAsync(Token);
        Result<RecoveryPasskeyBindOutcome> retried = await service.CompletePasskeyBindAsync(Token, request);

        Assert.False(failed.IsSuccess);
        Assert.Equal(ErrorCode.Validation, failed.Error.Code);
        Assert.True(pending.IsSuccess);
        Assert.True(retried.IsSuccess);
        Assert.False(retried.Value.WasIdempotentReplay);
        Assert.Equal(2, attempt);
    }

    [Fact]
    public async Task DatabaseFailure_RestoresPendingSessionAndAllowsSameRequestRetry()
    {
        const string Token = "recovery-session-database-retry";
        var cache = new AtomicRecoveryCache();
        cache.SeedPending(Token, ActiveSession());
        var passkeys = CreatePasskeysWithoutDurableCompletion();
        int attempt = 0;
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromResult(Interlocked.Increment(ref attempt) == 1
                ? RecoveryPasskeyRegistrationResult.RetryableFailure()
                : RecoveryPasskeyRegistrationResult.Completed()));
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);
        PasskeyRegisterCompleteCoreModel request = Request(Token, "database");

        Result<RecoveryPasskeyBindOutcome> failed = await service.CompletePasskeyBindAsync(Token, request);
        Result<RecoveryPasskeyBindOutcome> retried = await service.CompletePasskeyBindAsync(Token, request);

        Assert.False(failed.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, failed.Error.Code);
        Assert.Equal("RECOVERY_PASSKEY_RETRYABLE", failed.Error.Message);
        Assert.True(retried.IsSuccess);
        Assert.Equal(2, attempt);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ConcurrentDoubleSubmit_AllowsOnlyOneLogicalCompletion()
    {
        const string Token = "recovery-session-concurrent";
        var cache = new AtomicRecoveryCache();
        cache.SeedPending(Token, ActiveSession());
        var passkeys = CreatePasskeysWithoutDurableCompletion();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int completionCalls = 0;
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                Interlocked.Increment(ref completionCalls);
                entered.TrySetResult();
                await release.Task;
                return RecoveryPasskeyRegistrationResult.Completed();
            });
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);
        PasskeyRegisterCompleteCoreModel request = Request(Token, "concurrent");

        Task<Result<RecoveryPasskeyBindOutcome>> firstTask = service.CompletePasskeyBindAsync(Token, request);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Result<RecoveryPasskeyBindOutcome> second = await service.CompletePasskeyBindAsync(Token, request);
        release.TrySetResult();
        Result<RecoveryPasskeyBindOutcome> first = await firstTask;

        Assert.True(first.IsSuccess);
        Assert.False(second.IsSuccess);
        Assert.Equal(ErrorCode.Conflict, second.Error.Code);
        Assert.Equal("RECOVERY_PASSKEY_COMPLETION_IN_PROGRESS", second.Error.Message);
        Assert.Equal(1, completionCalls);
    }

    [Fact]
    public async Task ResponseLostAfterCommit_ReplayReturnsIdempotentSuccessWithoutSecondMutation()
    {
        const string Token = "recovery-session-response-loss";
        var cache = new AtomicRecoveryCache();
        cache.SeedPending(Token, ActiveSession());
        var passkeys = Substitute.For<IPasskeyService>();
        bool durableCompletion = false;
        int completionCalls = 0;
        passkeys.TryResolveRecoveryRegistrationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromResult<RecoveryPasskeyRegistrationResult?>(
                durableCompletion ? RecoveryPasskeyRegistrationResult.AlreadyCompleted() : null));
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref completionCalls);
                durableCompletion = true;
                return Task.FromException<RecoveryPasskeyRegistrationResult>(new IOException("response lost after commit"));
            });
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);
        PasskeyRegisterCompleteCoreModel request = Request(Token, "response-loss");

        Result<RecoveryPasskeyBindOutcome> lost = await service.CompletePasskeyBindAsync(Token, request);
        Result<RecoveryPasskeyBindOutcome> replay = await service.CompletePasskeyBindAsync(Token, request);

        Assert.False(lost.IsSuccess);
        Assert.Equal("RECOVERY_PASSKEY_RETRYABLE", lost.Error.Message);
        Assert.True(replay.IsSuccess);
        Assert.True(replay.Value.WasIdempotentReplay);
        Assert.Equal(1, completionCalls);
    }

    [Fact]
    public async Task CompletedSession_ReplayWithDifferentRequestIsRejected()
    {
        const string Token = "recovery-session-request-binding";
        var cache = new AtomicRecoveryCache();
        cache.SeedPending(Token, ActiveSession());
        var passkeys = Substitute.For<IPasskeyService>();
        string? completedRequestHash = null;
        passkeys.TryResolveRecoveryRegistrationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(call => Task.FromResult<RecoveryPasskeyRegistrationResult?>(
                completedRequestHash is null
                    ? null
                    : string.Equals(completedRequestHash, call.ArgAt<string>(1), StringComparison.Ordinal)
                        ? RecoveryPasskeyRegistrationResult.AlreadyCompleted()
                        : RecoveryPasskeyRegistrationResult.Conflict("RECOVERY_PASSKEY_ALREADY_COMPLETED_WITH_DIFFERENT_REQUEST")));
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                completedRequestHash = call.ArgAt<string>(2);
                return Task.FromResult(RecoveryPasskeyRegistrationResult.Completed());
            });
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);

        Assert.True((await service.CompletePasskeyBindAsync(Token, Request(Token, "first"))).IsSuccess);
        Result<RecoveryPasskeyBindOutcome> different = await service.CompletePasskeyBindAsync(
            Token,
            Request(Token, "different"));

        Assert.False(different.IsSuccess);
        Assert.Equal(ErrorCode.Conflict, different.Error.Code);
        Assert.Equal("RECOVERY_PASSKEY_ALREADY_COMPLETED_WITH_DIFFERENT_REQUEST", different.Error.Message);
    }

    [Fact]
    public async Task ExpiredPendingSession_RejectsWithoutCallingPasskeyMutation()
    {
        const string Token = "recovery-session-expired";
        var cache = new AtomicRecoveryCache();
        cache.SeedPending(Token, new RecoveryKeySession(
            42,
            false,
            DateTime.UtcNow.AddMinutes(-20),
            DateTime.UtcNow.AddSeconds(-1)));
        var passkeys = CreatePasskeysWithoutDurableCompletion();
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);

        Result<RecoveryPasskeyBindOutcome> result = await service.CompletePasskeyBindAsync(
            Token,
            Request(Token, "expired"));

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Unauthorized, result.Error.Code);
        Assert.Equal("RECOVERY_SESSION_EXPIRED", result.Error.Message);
        await passkeys.DidNotReceive().CompleteRecoveryRegistrationAsync(
            Arg.Any<RecoveryKeySession>(),
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<PasskeyRegisterCompleteCoreModel>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ExpiredCompletingLease_RecoversPendingAndCompletesSameRequestRetry()
    {
        const string Token = "recovery-session-expired-completing";
        var cache = new AtomicRecoveryCache();
        cache.SeedCompleting(
            Token,
            ActiveSession(),
            requestHash: new string('A', 64),
            leaseExpiresAtUtc: DateTime.UtcNow.AddSeconds(-5));
        var passkeys = CreatePasskeysWithoutDurableCompletion();
        int completionCalls = 0;
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref completionCalls);
                return Task.FromResult(RecoveryPasskeyRegistrationResult.Completed());
            });
        RecoveryKeyService service = CreateService(cache.Cache, passkeys);

        Result<RecoveryPasskeyBindOutcome> result = await service.CompletePasskeyBindAsync(
            Token,
            Request(Token, "expired-completing-retry"));

        Assert.True(result.IsSuccess, result.Error.Message);
        Assert.False(result.Value.WasIdempotentReplay);
        Assert.Equal(1, completionCalls);
        Assert.True(cache.ReplacementCount >= 3);
    }

    [Fact]
    public void LegacyPendingEnvelope_RemainsReadableAcrossDeployment()
    {
        RecoveryKeySession session = ActiveSession();
        string legacy = $"{session.AccountId}|{(session.RevokePasskeys ? "1" : "0")}|{session.IssuedAtUtc.Ticks}|{session.ExpiresAtUtc.Ticks}";

        Assert.True(RecoveryKeyService.TryDecodeSessionEnvelope(legacy, out RecoverySessionEnvelope? decoded));
        Assert.NotNull(decoded);
        Assert.Equal(RecoveryPasskeyCompletionState.Pending, decoded.State);
        Assert.Equal(session, decoded.Session);
    }

    private static RecoveryKeySession ActiveSession()
        => new(42, true, DateTime.UtcNow.AddMinutes(-1), DateTime.UtcNow.AddMinutes(9));

    private static PasskeyRegisterCompleteCoreModel Request(string token, string marker)
        => new()
        {
            SessionKey = $"challenge-{marker}",
            Id = $"credential-{marker}",
            RawId = System.Text.Encoding.UTF8.GetBytes($"raw-{marker}"),
            ClientDataBytes = System.Text.Encoding.UTF8.GetBytes($"client-{marker}"),
            AttestationObject = System.Text.Encoding.UTF8.GetBytes($"attestation-{marker}"),
            Transports = [1, 2],
            FriendlyName = marker,
            MfaProofToken = token
        };

    private static IPasskeyService CreatePasskeysWithoutDurableCompletion()
    {
        var passkeys = Substitute.For<IPasskeyService>();
        passkeys.TryResolveRecoveryRegistrationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<RecoveryPasskeyRegistrationResult?>(null));
        return passkeys;
    }

    private static RecoveryKeyService CreateService(IUnifiedCache cache, IPasskeyService passkeys)
        => new(
            Substitute.For<ISqlSugarClient>(),
            cache,
            new ConfigurationBuilder().Build(),
            passkeys,
            NullLogger<RecoveryKeyService>.Instance,
            Substitute.For<IUserSessionValidationCache>());

    private sealed class AtomicRecoveryCache
    {
        private readonly object _sync = new();
        private readonly ConcurrentDictionary<string, string> _strings = new(StringComparer.Ordinal);

        public AtomicRecoveryCache()
        {
            Cache = Substitute.For<IUnifiedCache>();
            Cache.GetStringAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                    lock (_sync)
                    {
                        return Task.FromResult(_strings.TryGetValue(key, out string? value) ? value : null);
                    }
                });
            Cache.TrySetStringIfValueAsync(
                    Arg.Any<CachePolicyId>(),
                    Arg.Any<string>(),
                    Arg.Any<string>(),
                    Arg.Any<string>(),
                    Arg.Any<string>(),
                    Arg.Any<TimeSpan?>(),
                    Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                    string compareKey = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(3));
                    string expected = call.ArgAt<string>(4);
                    lock (_sync)
                    {
                        if (!_strings.TryGetValue(compareKey, out string? current) ||
                            !string.Equals(current, expected, StringComparison.Ordinal))
                        {
                            return Task.FromResult(false);
                        }

                        _strings[key] = call.ArgAt<string>(2);
                        ReplacementCount++;
                        return Task.FromResult(true);
                    }
                });
            Cache.RemoveAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    string key = Key(call.ArgAt<CachePolicyId>(0), call.ArgAt<string>(1));
                    lock (_sync)
                    {
                        _strings.TryRemove(key, out _);
                    }
                    return Task.CompletedTask;
                });
        }

        public IUnifiedCache Cache
        {
            get;
        }

        public int ReplacementCount
        {
            get; private set;
        }

        public void SeedPending(string token, RecoveryKeySession session)
        {
            string identity = RecoveryKeyService.BuildSessionIdentity(token);
            _strings[Key(CachePolicyId.SecurityRecoveryKeySession, identity)] =
                RecoveryKeyService.EncodeSessionEnvelope(RecoveryKeyService.ToPendingEnvelope(session));
        }

        public void SeedCompleting(
            string token,
            RecoveryKeySession session,
            string requestHash,
            DateTime leaseExpiresAtUtc)
        {
            string identity = RecoveryKeyService.BuildSessionIdentity(token);
            _strings[Key(CachePolicyId.SecurityRecoveryKeySession, identity)] =
                RecoveryKeyService.EncodeSessionEnvelope(new RecoverySessionEnvelope(
                    session,
                    RecoveryPasskeyCompletionState.Completing,
                    requestHash,
                    "expired-lease",
                    leaseExpiresAtUtc));
        }

        private static string Key(CachePolicyId policyId, string identity)
            => $"{policyId}:{identity}";
    }
}
