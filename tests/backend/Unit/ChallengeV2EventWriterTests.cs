using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ChallengeV2EventWriterTests
{
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task WriteAsync_DropsLowValueTelemetryWhenNormalQueueIsFullButKeepsReplayEvent()
    {
        var logger = new CapturingLogger<ChallengeV2AuditEventQueue>();
        var queue = new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions
            {
                Capacity = 1,
                HighValueCapacity = 1,
                BatchSize = 8,
                FlushWindowMs = 10
            }),
            logger);

        await queue.WriteAsync(CreateEvent("low-1", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        await queue.WriteAsync(CreateEvent("low-2", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        await queue.WriteAsync(CreateEvent("replay-1", SecurityChallengeAttemptOutcomes.Replayed, "perception_replayed"), CancellationToken.None);

        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.NormalQueuedCount);
        Assert.Equal(1, snapshot.HighValueQueuedCount);
        Assert.Equal(1, snapshot.DroppedLowValueCount);
        Assert.Equal(0, snapshot.DroppedHighValueCount);
        Assert.Contains(logger.Messages, static message => message.Contains("challenge-v2-audit-event-dropped", StringComparison.Ordinal));

        Assert.True(queue.TryRead(out ChallengeV2AuditEvent? replay));
        Assert.NotNull(replay);
        Assert.Equal("replay-1", replay.Attempt.ChallengeId);
        Assert.True(replay.IsHighValue);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task FlushOnceAsync_WritesQueuedAttemptsInConfiguredBatches()
    {
        var persistence = new RecordingChallengePersistence();
        await using ServiceProvider provider = new ServiceCollection()
            .AddScoped<ISecurityChallengePersistenceService>(_ => persistence)
            .BuildServiceProvider(new ServiceProviderOptions
            {
                ValidateScopes = true,
                ValidateOnBuild = true
            });
        var queue = new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions
            {
                Capacity = 8,
                HighValueCapacity = 8,
                BatchSize = 2,
                FlushWindowMs = 10
            }),
            new CapturingLogger<ChallengeV2AuditEventQueue>());
        var worker = new ChallengeV2AuditEventWriterWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new ChallengeV2EventWriterOptions { BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<ChallengeV2AuditEventWriterWorker>());

        await queue.WriteAsync(CreateEvent("success-1", SecurityChallengeAttemptOutcomes.Verified), CancellationToken.None);
        await queue.WriteAsync(CreateEvent("failure-1", SecurityChallengeAttemptOutcomes.Failed, "perception_text_answer_invalid"), CancellationToken.None);
        await queue.WriteAsync(CreateEvent("replay-1", SecurityChallengeAttemptOutcomes.Replayed, "perception_replayed"), CancellationToken.None);

        int flushed = await worker.FlushOnceAsync(CancellationToken.None);

        Assert.Equal(2, flushed);
        Assert.Equal(2, persistence.Attempts.Count);
        Assert.Equal("replay-1", persistence.Attempts[0].ChallengeId);
        Assert.Equal("success-1", persistence.Attempts[1].ChallengeId);
        Assert.Equal(1, queue.Snapshot().NormalQueuedCount);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task WriteAsync_LogsStructuredFallbackWhenHighValueLaneIsFull()
    {
        var logger = new CapturingLogger<ChallengeV2AuditEventQueue>();
        var queue = new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions
            {
                Capacity = 1,
                HighValueCapacity = 1,
                BatchSize = 8,
                FlushWindowMs = 10
            }),
            logger);

        await queue.WriteAsync(CreateEvent("replay-1", SecurityChallengeAttemptOutcomes.Replayed, "perception_replayed"), CancellationToken.None);
        await queue.WriteAsync(CreateEvent("replay-2", SecurityChallengeAttemptOutcomes.Replayed, "perception_replayed"), CancellationToken.None);

        ChallengeV2AuditEventQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(1, snapshot.HighValueQueuedCount);
        Assert.Equal(1, snapshot.DroppedHighValueCount);
        Assert.Contains(logger.Messages, static message =>
            message.Contains("challenge-v2-audit-event-fallback", StringComparison.Ordinal) &&
            message.Contains("replay-2", StringComparison.Ordinal) &&
            message.Contains("perception_replayed", StringComparison.Ordinal));
    }

    private static ChallengeV2AuditEvent CreateEvent(string challengeId, string outcome, string? reason = null)
        => ChallengeV2AuditEvent.FromAttempt(
            new SecurityChallengeAttemptRequest(
                challengeId,
                outcome,
                reason,
                HashB,
                HashA,
                HashA,
                "trace-test",
                Traceparent,
                DateTime.UtcNow),
            ChallengeV2EventKind.FromAttempt(outcome, reason, "auth.login"),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionMicroInteractionV2),
            "auth.login");

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt
            {
                AttemptId = Guid.NewGuid().ToString("N"),
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

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }
}
