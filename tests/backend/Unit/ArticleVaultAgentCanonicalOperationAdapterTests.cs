using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultAgentCanonicalOperationAdapterTests
{
    [Fact]
    public async Task PersistedResult_UsesOriginalExecutorReplayWithoutCallingWriter()
    {
        var fixture = new Fixture();
        ArticleVaultAgentCanonicalResult result = await fixture.Adapter.ExecuteAsync(fixture.Reference, default);
        Assert.Equal(fixture.Result.ContentSha256, result.ResultSha256);
        Assert.Equal(ArticleVaultAgentCanonicalOutcome.NoOp, result.Outcome);
        Assert.Equal(fixture.Reference.Identity.OperationIdentity, result.OperationIdentity);
        await fixture.Writer.DidNotReceiveWithAnyArgs().ExecuteGroupAsync(default!, default!, default!, default);
        await fixture.Observations.DidNotReceiveWithAnyArgs().ObserveGroupAsync(default!, default!, default);
    }

    [Fact]
    public async Task HistoricalCheckpointWithoutResult_DoesNotAdmitFirstExecution()
    {
        var fixture = new Fixture();
        fixture.Store.LoadResultAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ArticleVaultExecutionResult?>(null));
        InvalidDataException error = await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Adapter.ExecuteAsync(fixture.Reference, default));
        Assert.Equal("agent_current_operation_execution_admission_missing", error.Message);
        await fixture.Writer.DidNotReceiveWithAnyArgs().ExecuteGroupAsync(default!, default!, default!, default);
    }

    [Fact]
    public async Task ResultReadBackDrift_CannotProduceACompletedCommandResult()
    {
        var fixture = new Fixture();
        fixture.Store.LoadResultAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ArticleVaultExecutionResult?>(fixture.Result),
                Task.FromResult<ArticleVaultExecutionResult?>(fixture.Result),
                Task.FromResult<ArticleVaultExecutionResult?>(fixture.Result with
                {
                    ContentSha256 = new string('f', 64)
                }));
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Adapter.ExecuteAsync(fixture.Reference, default));
    }

    [Fact]
    public async Task CancellationBeforeExecution_AppendsCanonicalCancelledFact()
    {
        var fixture = new Fixture(beforeExecution: true);
        ArticleVaultAgentOperationSnapshot cancelled = await fixture.Adapter.CancelAsync(fixture.Reference, default);
        ArticleVaultOperationCheckpoint tip = cancelled.History[^1];
        Assert.Equal(VaultOperationState.Cancelled, tip.State);
        Assert.Equal(VaultServerCommitDisposition.NotStarted, tip.ServerCommit);
        Assert.True(tip.CancellationRequested);
        Assert.Equal(fixture.Reference.CheckpointSha256, tip.PreviousCheckpointSha256);
        Assert.Equal(fixture.Reference.CheckpointSequence + 1, tip.Sequence);
        await fixture.Checkpoints.Received(1).AppendAsync(fixture.Reference.Identity, cancelled.Plan, tip, default);
        await fixture.Writer.DidNotReceiveWithAnyArgs().ExecuteGroupAsync(default!, default!, default!, default);
    }

    [Fact]
    public async Task CancellationWithUnknownServerResult_AppendsRecoveryWithoutInventingReceipt()
    {
        var fixture = new Fixture();
        ArticleVaultAgentOperationSnapshot cancelled = await fixture.Adapter.CancelAsync(fixture.Reference, default);
        ArticleVaultOperationCheckpoint tip = cancelled.History[^1];
        Assert.Equal(VaultOperationState.RecoveryRequired, tip.State);
        Assert.Equal(VaultServerCommitDisposition.Unknown, tip.ServerCommit);
        Assert.Null(tip.ServerResult);
        Assert.True(tip.CancellationRequested);
        Assert.All(tip.Articles, article => Assert.Equal(article.BaseBeforeSha256, article.BaseAfterSha256));
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Fact]
    public async Task CanonicalCancelledPointer_ReplaysWithoutAppendingAgain()
    {
        var fixture = new Fixture(beforeExecution: true);
        ArticleVaultAgentOperationSnapshot first = await fixture.Adapter.CancelAsync(fixture.Reference, default);
        ArticleVaultOperationCheckpoint tip = first.History[^1];
        ArticleVaultAgentOperationSnapshot replay = await fixture.Adapter.CancelAsync(
            new(fixture.Reference.Identity, tip.Sequence, tip.ContentSha256), default);
        Assert.Equal(tip.ContentSha256, replay.History[^1].ContentSha256);
        await fixture.Checkpoints.ReceivedWithAnyArgs(1).AppendAsync(default!, default!, default!, default);
    }

    [Fact]
    public async Task CompetingCanonicalAppend_CannotReturnCancellationSuccess()
    {
        var fixture = new Fixture();
        fixture.Checkpoints.AppendAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
            Arg.Any<ArticleVaultOperationCheckpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new ArticleVaultExecutionRejectedException("article_vault_operation_append_conflict")));
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => fixture.Adapter.CancelAsync(fixture.Reference, default));
        Assert.Equal("article_vault_operation_append_conflict", error.ReasonCode);
        Assert.Equal(fixture.Reference.CheckpointSequence + 1, fixture.History.Count);
    }

    [Fact]
    public async Task CancellationReadBackDrift_CannotBecomeDurableProof()
    {
        var fixture = new Fixture();
        fixture.Checkpoints.ReadThroughAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
            Arg.Is<long>(sequence => sequence > fixture.Reference.CheckpointSequence), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IReadOnlyList<ArticleVaultOperationCheckpoint>>(fixture.History.ToArray()));
        InvalidDataException error = await Assert.ThrowsAsync<InvalidDataException>(
            () => fixture.Adapter.CancelAsync(fixture.Reference, default));
        Assert.Equal("article_vault_operation_history_missing", error.Message);
    }

    // Ordinary source-composition fixtures; no live database, native control or platform admission.
    private sealed class Fixture
    {
        private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        public IArticleVaultExecutionStore Store { get; } = Substitute.For<IArticleVaultExecutionStore>();
        public IArticleVaultCanonicalGroupWriter Writer { get; } = Substitute.For<IArticleVaultCanonicalGroupWriter>();
        public IArticleVaultCurrentObservationAuthority Observations { get; } = Substitute.For<IArticleVaultCurrentObservationAuthority>();
        public IArticleVaultOperationCheckpointStore Checkpoints { get; } = Substitute.For<IArticleVaultOperationCheckpointStore>();
        public List<ArticleVaultOperationCheckpoint> History { get; } = [];
        public ArticleVaultAgentCanonicalOperationAdapter Adapter
        {
            get;
        }
        public ArticleVaultAgentOperationReference Reference
        {
            get;
        }
        public ArticleVaultExecutionResult Result
        {
            get;
        }

        public Fixture(bool beforeExecution = false)
        {
            var binding = new ArticleVaultAgentBinding("site-test", "vault-test", "device-test", "agent-test", "session-test", Digest, Digest, "1.0.0", 1);
            VaultArticleCoordinate coordinate = new(ArticleVaultSchemas.Coordinate, 1, true, false, 4,
                ArticleVaultManifestCodec.CaptureSourceBytes("unit-source\n"u8), Digest, Digest, "draft", Digest, string.Empty);
            coordinate = coordinate with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
            };
            const string Path = "articles/portable-test.md";
            ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, binding.SiteIdentity,
                binding.VaultIdentity, binding.DeviceIdentity, "portable-test", "101", new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
                new(coordinate, coordinate, coordinate), new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
            article = article with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
            };
            ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
                new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
                binding.SiteIdentity, binding.VaultIdentity, binding.DeviceIdentity,
                [new("portable-test", ".fsus/articles/portable-test.json", article.ContentSha256, Path)], [], string.Empty);
            root = root with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
            };
            ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1,
                binding.SiteIdentity, binding.VaultIdentity, binding.DeviceIdentity, "portable-test", "101", coordinate, string.Empty);
            observation = observation with
            {
                ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
            };
            ArticleVaultSyncPlan plan = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
                [new("group-test", ["portable-test"], [])], VaultSyncDirection.Sync, 0, 60000, false)).Plan!;
            ArticleVaultExecutionPayload payload = new(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
            payload = payload with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
            };
            ArticleVaultSealedExecutionBundle bundle = new(ArticleVaultExecutionSchemas.Bundle, 1, plan.PlanCandidateIdentity,
                plan.ContentSha256, 1001, plan, root, [article], [observation], payload, string.Empty);
            bundle = bundle with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
            };
            ArticleVaultOperationIdentity identity = ArticleVaultOperationVerifier.Bind(plan, binding.AgentInstanceIdentity, Digest, Digest, 60000);
            List<ArticleVaultOperationCheckpoint> history = History;
            VaultOperationState[] states = beforeExecution
                ? [VaultOperationState.Planned, VaultOperationState.Validating]
                : [VaultOperationState.Planned, VaultOperationState.Validating, VaultOperationState.ExecutingServer];
            foreach (VaultOperationState state in states)
            {
                ArticleVaultOperationCheckpoint checkpoint = new(ArticleVaultOperationSchemas.Checkpoint, 1, identity.OperationIdentity,
                    identity.ContentSha256, history.Count, history.LastOrDefault()?.ContentSha256, history.Count,
                    state, state == VaultOperationState.ExecutingServer ? VaultServerCommitDisposition.Unknown : VaultServerCommitDisposition.NotStarted,
                    null, null, [new("portable-test", coordinate.ContentSha256, coordinate.ContentSha256)], false, null, string.Empty);
                history.Add(checkpoint with
                {
                    ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(checkpoint)
                });
            }

            Reference = new(identity, history[^1].Sequence, history[^1].ContentSha256);
            VaultSyncPlanGroup group = plan.Groups[0];
            VaultSyncPlanItem item = group.Items[0];
            string idempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(plan, group);
            ArticleVaultOperationResultReceipt operation = new(ArticleVaultExecutionSchemas.OperationReceipt, 1,
                plan.SiteIdentity, plan.VaultIdentity, plan.ContentSha256, group.GroupIdentity, item.OperationIdentity,
                item.PortableArticleIdentity, item.Decision, ArticleVaultOperationOutcome.NoOp, 101, 4, 4,
                "article-service/noop", null, null, [], [], idempotency, coordinate.Source!.Sha256, null, string.Empty);
            operation = operation with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(operation)
            };
            ArticleVaultGroupResultReceipt grouped = new(ArticleVaultExecutionSchemas.GroupReceipt, 1, plan.SiteIdentity,
                plan.VaultIdentity, plan.ContentSha256, group.GroupIdentity, idempotency, true, [operation], null, string.Empty);
            grouped = grouped with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(grouped)
            };
            ArticleVaultExecutionResult result = new(ArticleVaultExecutionSchemas.Result, 1, plan.ResultCandidateIdentity,
                plan.SiteIdentity, plan.VaultIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, plan.IdempotencyKey,
                ArticleVaultExecutionOutcome.NoOp, [grouped], null, 3, string.Empty);
            Result = result with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(result)
            };
            Store.LoadSealedAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(bundle);
            Store.LoadResultAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Result);
            Checkpoints.ReadThroughAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
                Arg.Any<long>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(call =>
                    Task.FromResult<IReadOnlyList<ArticleVaultOperationCheckpoint>>(history
                        .Where(checkpoint => checkpoint.Sequence <= call.ArgAt<long>(2)).ToArray()));
            Checkpoints.AppendAsync(Arg.Any<ArticleVaultOperationIdentity>(), Arg.Any<ArticleVaultSyncPlan>(),
                Arg.Any<ArticleVaultOperationCheckpoint>(), Arg.Any<CancellationToken>()).Returns(call =>
                {
                    ArticleVaultOperationCheckpoint next = call.ArgAt<ArticleVaultOperationCheckpoint>(2);
                    ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, history[^1], next));
                    history.Add(next);
                    return Task.CompletedTask;
                });
            var time = new UnitTimeProvider();
            var executor = new ArticleVaultSyncPlanExecutor(Store, Observations, Writer, time);
            Adapter = new(Store, Checkpoints, executor, binding, root.ContentSha256, 1001, time);
        }
    }

    private sealed class UnitTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(50);
    }
}
