using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionChallengeV2E2eTests
{
    private const string BusinessFlow = "comment.create";
    private const string RouteKey = "/api/binary/comment/article/42";
    private const string PolicyVersion = "risk-policy-perception-v2-e2e";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    private const string FixedAnswer = "A7K2M";

    [Fact]
    public async Task CommentCreateFlow_IssueRenderVerifyProofResume_WritesReleaseEvidence()
    {
        using PerceptionE2eFixture fixture = PerceptionE2eFixture.Create();
        List<double> issueDurations = [];
        List<double> renderDurations = [];
        List<double> verifyDurations = [];

        await fixture.RunIssueRenderVerifyAsync(resumeBusinessAction: false, CancellationToken.None);

        CommentResumeResult? resumed = null;
        for (int i = 0; i < 12; i++)
        {
            PerceptionE2eRun run = await fixture.RunIssueRenderVerifyAsync(
                resumeBusinessAction: i == 0,
                CancellationToken.None);
            issueDurations.Add(run.IssueElapsed.TotalMilliseconds);
            renderDurations.Add(run.RenderElapsed.TotalMilliseconds);
            verifyDurations.Add(run.VerifyElapsed.TotalMilliseconds);
            resumed ??= run.ResumeResult;
        }

        Assert.NotNull(resumed);
        Assert.True(resumed.Accepted, resumed.Reason);
        Assert.Equal("comment-created", resumed.Status);
        Assert.Single(fixture.CreatedComments);
        Assert.Contains(fixture.DrainAuditEvents(), static item =>
            item.Attempt.Outcome == SecurityChallengeAttemptOutcomes.Verified &&
            string.Equals(item.Attempt.Reason, "ok", StringComparison.Ordinal));

        ChallengeV2AuditEventQueueSnapshot auditSnapshot = fixture.AuditSnapshot;
        Assert.True(auditSnapshot.NormalQueuedCount + fixture.DrainedAuditEventCount > 0);
        Assert.Equal(0, auditSnapshot.DroppedLowValueCount);
        Assert.Equal(0, auditSnapshot.DroppedHighValueCount);

        var evidence = new PerceptionE2eEvidence(
            "fsusblog.perception-v2.e2e-runtime@v1",
            "ok",
            532,
            DateTimeOffset.UtcNow.ToString("O"),
            "security/matrices/perception-v2.yml",
            new PerceptionE2eWorkflow(
                BusinessFlow,
                "perceptionTextTaskV2",
                ["issue", "render", "verify", "proof", "business-action-resume"],
                ["text-task"],
                ["comment.create"]),
            new PerceptionE2eCoverage(
                ["comment.create:issue-render-verify-proof-resume"],
                ["wrong-answer", "expired", "duplicate-submit", "action-mismatch", "route-mismatch"],
                ["issue-p99", "verify-gate-latency", "async-audit-queue-nonblocking"]),
            new PerceptionE2eMetrics(
                Percentile(issueDurations, 0.99),
                Percentile(verifyDurations, 0.99),
                Percentile(renderDurations, 0.95),
                auditSnapshot.NormalQueuedCount + fixture.DrainedAuditEventCount,
                auditSnapshot.DroppedLowValueCount,
                auditSnapshot.DroppedHighValueCount),
            ["localization and microInteraction remain covered by provider/frontend matrix lanes; #532 adds the first true comment.create runtime E2E gate only."]);

        WriteEvidence(evidence);
    }

    [Fact]
    public async Task CommentCreateFlow_FailsClosedForWrongAnswerExpiredReplayAndBindingMismatch()
    {
        using (PerceptionE2eFixture fixture = PerceptionE2eFixture.Create())
        {
            PerceptionIssuedChallenge challenge = await fixture.IssueAsync(CancellationToken.None);
            Dictionary<string, string> wrongAnswer = fixture.RenderAndSolve(challenge);
            wrongAnswer["answerText"] = "WRONG";

            SecurityChallengeOrchestrationVerifyResult result = await fixture.VerifyAsync(
                challenge,
                wrongAnswer,
                CancellationToken.None);

            Assert.False(result.Succeeded);
            Assert.Equal("perception_challenge_failed", result.Reason);
            Assert.Contains(fixture.DrainAuditEvents(), static item =>
                string.Equals(item.Attempt.Reason, "perception_text_answer_invalid", StringComparison.Ordinal));
        }

        using (PerceptionE2eFixture fixture = PerceptionE2eFixture.Create())
        {
            PerceptionIssuedChallenge challenge = await fixture.IssueAsync(CancellationToken.None);
            fixture.Advance(TimeSpan.FromMinutes(6));

            SecurityChallengeOrchestrationVerifyResult result = await fixture.VerifyAsync(
                challenge,
                fixture.RenderAndSolve(challenge),
                CancellationToken.None);

            Assert.False(result.Succeeded);
            Assert.Equal("perception_challenge_failed", result.Reason);
            Assert.Contains(fixture.DrainAuditEvents(), static item =>
                string.Equals(item.Attempt.Reason, "perception_token_invalid", StringComparison.Ordinal));
        }

        using (PerceptionE2eFixture fixture = PerceptionE2eFixture.Create())
        {
            PerceptionE2eRun run = await fixture.RunIssueRenderVerifyAsync(
                resumeBusinessAction: true,
                CancellationToken.None);
            Assert.NotNull(run.ResumeResult);
            Assert.True(run.ResumeResult.Accepted, run.ResumeResult.Reason);

            CommentResumeResult replay = await fixture.ResumeCommentCreateAsync(
                run.Challenge,
                run.VerifyResult.ProofToken!,
                CancellationToken.None);

            Assert.False(replay.Accepted);
            Assert.Equal("proof_replayed_or_missing", replay.Reason);
            Assert.Single(fixture.CreatedComments);
        }

        foreach ((string? actionOverride, string? routeOverride, string expectedReason) in new (string?, string?, string)[]
        {
            ("comment.update", null, "perception_action_mismatch"),
            (null, "/api/binary/comment/article/99", "perception_route_key_mismatch")
        })
        {
            using PerceptionE2eFixture fixture = PerceptionE2eFixture.Create();
            PerceptionIssuedChallenge challenge = await fixture.IssueAsync(CancellationToken.None);

            SecurityChallengeOrchestrationVerifyResult result = await fixture.VerifyAsync(
                challenge,
                fixture.RenderAndSolve(challenge),
                CancellationToken.None,
                actionOverride,
                routeOverride);

            Assert.False(result.Succeeded);
            Assert.Equal("perception_challenge_failed", result.Reason);
            Assert.Contains(fixture.DrainAuditEvents(), item =>
                string.Equals(item.Attempt.Reason, expectedReason, StringComparison.Ordinal));
        }
    }

    private static double Percentile(IReadOnlyList<double> values, double percentile)
    {
        Assert.NotEmpty(values);
        double[] ordered = [.. values.OrderBy(static item => item)];
        int index = Math.Clamp((int)Math.Ceiling(percentile * ordered.Length) - 1, 0, ordered.Length - 1);
        return Math.Round(ordered[index], 3);
    }

    private static void WriteEvidence(PerceptionE2eEvidence evidence)
    {
        string outputPath = BackendTestPaths.FromRoot(".tmp", "security", "perception-v2-e2e-runtime.json");
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        File.WriteAllText(
            outputPath,
            JsonSerializer.Serialize(evidence, s_evidenceJsonOptions) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static readonly JsonSerializerOptions s_renderRecipeJsonOptions = CreateRenderRecipeJsonOptions();

    private static readonly JsonSerializerOptions s_evidenceJsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private static JsonSerializerOptions CreateRenderRecipeJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return options;
    }

    private sealed class PerceptionE2eFixture : IDisposable
    {
        private readonly MutableTimeProvider _clock;
        private readonly SecurityChallengeOrchestrator _orchestrator;
        private readonly SecurityChallengeProofService _proofService;
        private readonly RecordingChallengePersistence _persistence;
        private readonly ChallengeV2AuditEventQueue _auditQueue;

        private PerceptionE2eFixture(
            MutableTimeProvider clock,
            SecurityChallengeOrchestrator orchestrator,
            SecurityChallengeProofService proofService,
            RecordingChallengePersistence persistence,
            ChallengeV2AuditEventQueue auditQueue)
        {
            _clock = clock;
            _orchestrator = orchestrator;
            _proofService = proofService;
            _persistence = persistence;
            _auditQueue = auditQueue;
        }

        public List<CommentCreateRecord> CreatedComments { get; } = [];

        public int DrainedAuditEventCount
        {
            get; private set;
        }

        public ChallengeV2AuditEventQueueSnapshot AuditSnapshot => _auditQueue.Snapshot();

        public static PerceptionE2eFixture Create()
        {
            var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Security:PerceptionV2:TextTask:FixedText"] = FixedAnswer,
                    ["Security:PerceptionV2:SigningKey"] = "perception-v2-e2e-signing-key"
                })
                .Build();
            var tokenOptions = new PerceptionSealedTokenOptions
            {
                CurrentKeyVersion = "current",
                Keys =
                {
                    ["current"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("perception-v2-e2e-key")))
                }
            };
            var tokenProtector = new PerceptionChallengeV2TokenProtector(
                new PerceptionSealedTokenService(new StaticOptionsMonitor<PerceptionSealedTokenOptions>(tokenOptions), clock));
            var issueService = new PerceptionChallengeV2IssueService(
                new DefaultPerceptionChallengeV2TaskSource(configuration),
                tokenProtector,
                clock);
            var gate = new RecordingPerceptionRedisGate(clock);
            var riskSink = new CapturingRiskSink();
            var auditQueue = new ChallengeV2AuditEventQueue(
                Options.Create(new ChallengeV2EventWriterOptions { Capacity = 1024, HighValueCapacity = 128 }),
                NullLogger<ChallengeV2AuditEventQueue>.Instance);
            var verifyService = new PerceptionChallengeV2VerifyService(tokenProtector, gate, riskSink, auditQueue, clock);
            var provider = new PerceptionTextTaskV2Provider(issueService, verifyService);
            var persistence = new RecordingChallengePersistence();
            var proofService = new SecurityChallengeProofService(new MemoryProofCache(), persistence, clock);
            var orchestrator = new SecurityChallengeOrchestrator([provider], proofService, riskSink);
            return new PerceptionE2eFixture(clock, orchestrator, proofService, persistence, auditQueue);
        }

        public void Advance(TimeSpan value) => _clock.Advance(value);

        public async Task<PerceptionE2eRun> RunIssueRenderVerifyAsync(
            bool resumeBusinessAction,
            CancellationToken cancellationToken)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            PerceptionIssuedChallenge challenge = await IssueAsync(cancellationToken);
            TimeSpan issueElapsed = stopwatch.Elapsed;

            stopwatch.Restart();
            Dictionary<string, string> rendered = RenderAndSolve(challenge);
            TimeSpan renderElapsed = stopwatch.Elapsed;

            stopwatch.Restart();
            SecurityChallengeOrchestrationVerifyResult verified = await VerifyAsync(challenge, rendered, cancellationToken);
            TimeSpan verifyElapsed = stopwatch.Elapsed;
            Assert.True(verified.Succeeded, verified.Reason);
            Assert.False(string.IsNullOrWhiteSpace(verified.ProofToken));

            CommentResumeResult? resumeResult = null;
            if (resumeBusinessAction)
            {
                resumeResult = await ResumeCommentCreateAsync(challenge, verified.ProofToken!, cancellationToken);
            }

            return new PerceptionE2eRun(challenge, verified, resumeResult, issueElapsed, renderElapsed, verifyElapsed);
        }

        public async Task<PerceptionIssuedChallenge> IssueAsync(CancellationToken cancellationToken)
        {
            SecurityChallengeOrchestrationIssueResult result = await _orchestrator.IssueAsync(
                new SecurityChallengeOrchestrationIssueRequest(
                    new DefaultHttpContext(),
                    CreateDecision(),
                    "tenant-main",
                    Hash("anonymous-comment-subject"),
                    Hash("198.51.100.44"),
                    Hash("device-fingerprint"),
                    Traceparent),
                cancellationToken);

            Assert.True(result.Succeeded, result.Reason);
            Assert.NotNull(result.Envelope);
            SecurityChallengeAssignment assignment = Assert.Single(result.Envelope.Assignments);
            Assert.Equal(PerceptionTextTaskV2Provider.WireKind, SecurityChallengeContracts.ToWireName(assignment.Kind));
            Assert.True(result.ProviderPayloads.TryGetValue(assignment.ChallengeId, out var providerPayload));
            return new PerceptionIssuedChallenge(assignment, providerPayload);
        }

        public Dictionary<string, string> RenderAndSolve(PerceptionIssuedChallenge challenge)
        {
            Assert.True(challenge.ProviderPayload.TryGetValue("recipeJson", out string? recipeJson));
            RenderRecipeV2? recipe = JsonSerializer.Deserialize<RenderRecipeV2>(recipeJson, s_renderRecipeJsonOptions);
            Assert.NotNull(recipe);
            Assert.Equal(RenderRecipeV2TaskKind.Character, recipe.TaskKind);
            Assert.Equal("text", recipe.PresentationHints["inputMode"]);

            var payload = new Dictionary<string, string>(challenge.ProviderPayload, StringComparer.Ordinal)
            {
                ["answerText"] = FixedAnswer.ToLowerInvariant(),
                ["solveDurationMs"] = "1250",
                ["clientRenderMode"] = "test-fixture:recipe-json"
            };
            return payload;
        }

        public Task<SecurityChallengeOrchestrationVerifyResult> VerifyAsync(
            PerceptionIssuedChallenge challenge,
            IReadOnlyDictionary<string, string> providerPayload,
            CancellationToken cancellationToken,
            string? actionOverride = null,
            string? routeOverride = null)
            => _orchestrator.VerifyAsync(
                new SecurityChallengeOrchestrationVerifyRequest(
                    new DefaultHttpContext(),
                    PerceptionTextTaskV2Provider.WireKind,
                    challenge.Assignment.ChallengeId,
                    actionOverride ?? BusinessFlow,
                    routeOverride ?? RouteKey,
                    challenge.Assignment.SubjectHash,
                    challenge.Assignment.ClientIpHash,
                    challenge.Assignment.DeviceFpHash,
                    PolicyVersion,
                    providerPayload),
                cancellationToken);

        public async Task<CommentResumeResult> ResumeCommentCreateAsync(
            PerceptionIssuedChallenge challenge,
            string proofToken,
            CancellationToken cancellationToken,
            string? routeOverride = null)
        {
            SecurityChallengeProofConsumeResult consumed = await _proofService.ConsumeProofAsync(
                new SecurityChallengeProofConsumeRequest(
                    proofToken,
                    challenge.Assignment.ChallengeId,
                    PerceptionTextTaskV2Provider.WireKind,
                    BusinessFlow,
                    routeOverride ?? RouteKey,
                    challenge.Assignment.SubjectHash,
                    challenge.Assignment.ClientIpHash,
                    challenge.Assignment.DeviceFpHash,
                    PolicyVersion),
                cancellationToken);
            if (!consumed.Accepted)
            {
                return new CommentResumeResult(false, consumed.Reason, "blocked");
            }

            CreatedComments.Add(new CommentCreateRecord("article-42", "perception-v2 accepted comment"));
            return new CommentResumeResult(true, "ok", "comment-created");
        }

        public List<ChallengeV2AuditEvent> DrainAuditEvents()
        {
            var events = new List<ChallengeV2AuditEvent>();
            while (_auditQueue.TryRead(out ChallengeV2AuditEvent? auditEvent) && auditEvent is not null)
            {
                events.Add(auditEvent);
            }

            DrainedAuditEventCount += events.Count;
            return events;
        }

        public void Dispose()
        {
            _persistence.Dispose();
        }

        private static RiskDecision CreateDecision()
            => new(
                RiskDecisionKind.Challenge,
                BusinessFlow,
                RouteKey,
                60,
                60,
                1,
                [PerceptionTextTaskV2Provider.WireKind],
                PolicyVersion,
                ["perception-v2-e2e"]);
    }

    private sealed record PerceptionIssuedChallenge(
        SecurityChallengeAssignment Assignment,
        IReadOnlyDictionary<string, string> ProviderPayload);

    private sealed record PerceptionE2eRun(
        PerceptionIssuedChallenge Challenge,
        SecurityChallengeOrchestrationVerifyResult VerifyResult,
        CommentResumeResult? ResumeResult,
        TimeSpan IssueElapsed,
        TimeSpan RenderElapsed,
        TimeSpan VerifyElapsed);

    private sealed record CommentResumeResult(bool Accepted, string Reason, string Status);

    private sealed record CommentCreateRecord(string ArticleId, string Body);

    private sealed record PerceptionE2eEvidence(
        string Schema,
        string Status,
        int Issue,
        string GeneratedAtUtc,
        string Source,
        PerceptionE2eWorkflow Workflow,
        PerceptionE2eCoverage Coverage,
        PerceptionE2eMetrics Metrics,
        IReadOnlyList<string> KnownGaps);

    private sealed record PerceptionE2eWorkflow(
        string BusinessFlow,
        string ChallengeKind,
        IReadOnlyList<string> Path,
        IReadOnlyList<string> TaskKinds,
        IReadOnlyList<string> BusinessFlows);

    private sealed record PerceptionE2eCoverage(
        IReadOnlyList<string> SuccessCases,
        IReadOnlyList<string> FailureCases,
        IReadOnlyList<string> PerformanceCases);

    private sealed record PerceptionE2eMetrics(
        double IssueP99Ms,
        double VerifyGateP99Ms,
        double ClientRenderP95Ms,
        long AuditQueueObservedCount,
        long AuditQueueDroppedLowValueCount,
        long AuditQueueDroppedHighValueCount);

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan value) => _utcNow = _utcNow.Add(value);
    }

    private sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; } = value;

        public T Get(string? name) => CurrentValue;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    private sealed class CapturingRiskSink : ISecurityRiskSignalSink
    {
        public List<SecurityRiskSignal> Signals { get; } = [];

        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
        {
            Signals.Add(signal);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class RecordingPerceptionRedisGate(TimeProvider timeProvider) : IPerceptionChallengeV2RedisGate
    {
        private readonly HashSet<string> _consumed = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, long> _attemptCounts = new(StringComparer.Ordinal);

        public Task<PerceptionChallengeV2AttemptGateResult> RegisterAttemptAsync(
            string challengeId,
            DateTimeOffset expiresAt,
            int maxAttempts,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (expiresAt <= timeProvider.GetUtcNow())
            {
                return Task.FromResult(PerceptionChallengeV2AttemptGateResult.Rejected("challenge_expired", 0));
            }

            long next = _attemptCounts.AddOrUpdate(challengeId, 1, static (_, current) => current + 1);
            return Task.FromResult(next <= Math.Max(1, maxAttempts)
                ? PerceptionChallengeV2AttemptGateResult.Accepted(next)
                : PerceptionChallengeV2AttemptGateResult.Rejected("attempt_exceeded", next));
        }

        public Task<PerceptionChallengeV2ConsumeResult> TryConsumeOnceAsync(
            string challengeId,
            DateTimeOffset expiresAt,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (expiresAt <= timeProvider.GetUtcNow())
            {
                return Task.FromResult(new PerceptionChallengeV2ConsumeResult(false, "challenge_expired"));
            }

            return Task.FromResult(_consumed.Add(challengeId)
                ? PerceptionChallengeV2ConsumeResult.ConsumedOnce
                : PerceptionChallengeV2ConsumeResult.Replayed);
        }
    }

    private sealed class MemoryProofCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, byte[]> _raw = new(StringComparer.Ordinal);

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            _raw[BuildKey(policyId, identity)] = value.ToArray();
            return Task.CompletedTask;
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            if (!_raw.TryRemove(BuildKey(policyId, identity), out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{version}:{identity}";

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<T>(false, default));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<byte[]>(false, default));

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<ReadOnlyMemory<byte>>(false, default));

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(null);

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => Task.FromResult(value);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<IAsyncDisposable>(NoopAsyncDisposable.Instance);
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService, IDisposable
    {
        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
            => Task.FromResult(new SecurityChallenge
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

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(
            SecurityChallengeAttemptRequest request,
            CancellationToken cancellationToken = default)
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

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public void Dispose()
        {
            Attempts.Clear();
        }
    }

    private sealed class NoopAsyncDisposable : IAsyncDisposable
    {
        public static NoopAsyncDisposable Instance { get; } = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private static string Hash(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
