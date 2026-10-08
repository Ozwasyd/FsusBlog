using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

// Ordinary contract/dispatch unit fixtures only. No native lease, root, peer or runtime admission.
[Trait("Category", "ArticleVaultAgentDispatch")]
public sealed class ArticleVaultAgentDispatchTests
{
    [Fact]
    public void ResultWire_RequiresTheSameRequestAndOriginalFrameLength()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentRequest request = fixture.Request(ArticleVaultAgentCommand.InspectStatus, null);
        ArticleVaultAgentCommandReceipt receipt = ArticleVaultAgentCommandReceipts.Create(request,
            1000, ArticleVaultAgentCommandStatus.Completed, null, fixture.Running.ContentSha256);
        Assert.Equal(receipt, ArticleVaultAgentCommandReceipts.Decode(
            ArticleVaultAgentCommandReceipts.EncodeForRequest(request, 1000, receipt)));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentCommandReceipts.EncodeForRequest(request, 1001, receipt));
        ArticleVaultAgentRequest another = fixture.Request(ArticleVaultAgentCommand.InspectStatus, null, "another-request");
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentCommandReceipts.EncodeForRequest(another, 1000, receipt));
    }

    [Fact]
    public async Task Planner_UsesOriginalInputAndReturnsOnlyItsCanonicalPlanDigest()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentReference reference = fixture.Dispatch.RegisterPlannerInput(fixture.Input);
        ArticleVaultAgentRequest request = fixture.Request(ArticleVaultAgentCommand.RequestPlanner, reference);
        ArticleVaultAgentCommandReceipt receipt = await fixture.Dispatch.DispatchAsync(request, 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Completed, receipt.Status);
        Assert.Equal(ArticleVaultSyncPlanner.Build(fixture.Input).Plan!.ContentSha256, receipt.CanonicalResultSha256);
        Assert.Equal("agent_plan_only", receipt.ReasonCode);
        Assert.Equal(receipt, ArticleVaultAgentCommandReceipts.Decode(ArticleVaultAgentProtocol.Encode(receipt)));
        Assert.Equal(0, fixture.Executions);
    }

    [Theory]
    [InlineData(ArticleVaultAgentCommand.ObserveBatch, ArticleVaultAgentReferenceKind.ObservationBatch)]
    [InlineData(ArticleVaultAgentCommand.RequestPlanner, ArticleVaultAgentReferenceKind.PlannerInput)]
    [InlineData(ArticleVaultAgentCommand.ExecuteVerifiedPlan, ArticleVaultAgentReferenceKind.VerifiedPlan)]
    [InlineData(ArticleVaultAgentCommand.MaterializeVerifiedInstruction, ArticleVaultAgentReferenceKind.VerifiedMaterializationInstruction)]
    public async Task Starting_BlocksBusinessCommandsWithoutCallingTheExecutionPort(
        ArticleVaultAgentCommand command, ArticleVaultAgentReferenceKind kind)
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentRequest request = fixture.Request(command, new(kind, "input-test", ArticleVaultAgentDispatchFixture.Digest));
        ArticleVaultAgentLifecycleReceipt starting = ArticleVaultAgentLifecycle.Initial(fixture.Binding, ArticleVaultAgentPlatform.Linux, 0);
        ArticleVaultAgentCommandReceipt receipt = await fixture.Dispatch.DispatchAsync(request, 1000, starting, default);
        Assert.Equal("agent_dispatch_lifecycle_not_running", receipt.ReasonCode);
        Assert.Equal(ArticleVaultAgentCommandStatus.Blocked, receipt.Status);
        Assert.Equal(0, fixture.Executions);
    }

    [Fact]
    public async Task ExactRegisteredOperation_ReturnsServerResultAndRejectsAnotherRequest()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        await fixture.RegisterAsync();
        ArticleVaultAgentRequest request = fixture.ExecuteRequest();
        ArticleVaultAgentCommandReceipt result = await fixture.Dispatch.DispatchAsync(request, 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Completed, result.Status);
        Assert.Equal("agent_server_result_only", result.ReasonCode);
        Assert.Equal(ArticleVaultAgentDispatchFixture.Digest, result.CanonicalResultSha256);
        ArticleVaultAgentCommandReceipt duplicate = await fixture.Dispatch.DispatchAsync(request, 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Blocked, duplicate.Status);
        ArticleVaultAgentRequest another = fixture.Request(ArticleVaultAgentCommand.ExecuteVerifiedPlan, request.Reference, "other-request");
        Assert.Equal("agent_execution_operation_binding_missing",
            (await fixture.Dispatch.DispatchAsync(another, 1000, fixture.Running, default)).ReasonCode);
        Assert.Equal(1, fixture.Executions);
    }

    [Fact]
    public async Task MissingCurrentAdmission_ReturnsItsExactHandlerReason()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        await fixture.RegisterAsync();
        fixture.Execute = _ => throw new InvalidDataException("agent_current_operation_execution_admission_missing");
        ArticleVaultAgentCommandReceipt result = await fixture.Dispatch.DispatchAsync(fixture.ExecuteRequest(), 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Blocked, result.Status);
        Assert.Equal("agent_current_operation_execution_admission_missing", result.ReasonCode);
        Assert.Null(result.CanonicalResultSha256);
    }

    [Fact]
    public async Task CancelDuringExecution_PreservesActualResultWithoutInventingTerminalCancellation()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        await fixture.RegisterAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Execute = async _ =>
        {
            entered.SetResult();
            await release.Task;
            return fixture.Result();
        };
        Task<ArticleVaultAgentCommandReceipt> execution = fixture.Dispatch.DispatchAsync(fixture.ExecuteRequest(), 1000, fixture.Running, default);
        await entered.Task;
        ArticleVaultAgentRequest cancel = fixture.Request(ArticleVaultAgentCommand.Cancel,
            new(ArticleVaultAgentReferenceKind.Operation, fixture.Identity.OperationIdentity, fixture.Identity.ContentSha256), "cancel-request");
        ArticleVaultAgentCommandReceipt acknowledged = await fixture.Dispatch.DispatchAsync(cancel, 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Blocked, acknowledged.Status);
        Assert.Equal("agent_canonical_recovery_required", acknowledged.ReasonCode);
        Assert.Equal(fixture.History[^1].ContentSha256, acknowledged.CanonicalResultSha256);
        release.SetResult();
        ArticleVaultAgentCommandReceipt interrupted = await execution;
        Assert.Equal(ArticleVaultAgentCommandStatus.Blocked, interrupted.Status);
        Assert.Equal("agent_execution_recovery_required", interrupted.ReasonCode);
        Assert.Equal(ArticleVaultAgentDispatchFixture.Digest, interrupted.CanonicalResultSha256);
    }

    [Fact]
    public async Task CanonicalCancelledHistory_IsRequiredForCancelledReceipt()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture(cancelled: true);
        await fixture.RegisterAsync();
        ArticleVaultAgentRequest request = fixture.Request(ArticleVaultAgentCommand.Cancel,
            new(ArticleVaultAgentReferenceKind.Operation, fixture.Identity.OperationIdentity, fixture.Identity.ContentSha256));
        ArticleVaultAgentCommandReceipt receipt = await fixture.Dispatch.DispatchAsync(request, 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Cancelled, receipt.Status);
        Assert.Equal(fixture.Reference.CheckpointSha256, receipt.CanonicalResultSha256);
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentCommandReceipts.Create(request,
            1000, ArticleVaultAgentCommandStatus.Cancelled, "cancel_requested"));
    }

    [Fact]
    public async Task DurableCancellation_AdvancesOnlyTheBoundInventoryPointer()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        await fixture.RegisterAsync();
        ArticleVaultAgentRequest cancel = fixture.Request(ArticleVaultAgentCommand.Cancel,
            new(ArticleVaultAgentReferenceKind.Operation, fixture.Identity.OperationIdentity, fixture.Identity.ContentSha256));
        ArticleVaultAgentCommandReceipt receipt = await fixture.Dispatch.DispatchAsync(cancel, 1000, fixture.Running, default);
        ArticleVaultAgentOperationReference durable = Assert.Single(fixture.Dispatch.InspectOperationReferences());
        Assert.Equal(fixture.Reference.CheckpointSequence + 1, durable.CheckpointSequence);
        Assert.Equal(receipt.CanonicalResultSha256, durable.CheckpointSha256);
        Assert.Equal(fixture.Identity, durable.Identity);
        Assert.Equal(VaultOperationState.RecoveryRequired, fixture.History[^1].State);
        ArticleVaultAgentCommandReceipt execute = await fixture.Dispatch.DispatchAsync(fixture.ExecuteRequest(), 1000, fixture.Running, default);
        Assert.Equal("agent_execution_cancelled_or_active", execute.ReasonCode);
        Assert.Equal(0, fixture.Executions);
    }

    [Fact]
    public async Task UnchangedNonCancelledHistory_CannotAcknowledgeDurableCancellation()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        await fixture.RegisterAsync();
        fixture.Cancel = () => Task.FromResult(new ArticleVaultAgentOperationSnapshot(fixture.Plan, fixture.History));
        ArticleVaultAgentRequest cancel = fixture.Request(ArticleVaultAgentCommand.Cancel,
            new(ArticleVaultAgentReferenceKind.Operation, fixture.Identity.OperationIdentity, fixture.Identity.ContentSha256));
        ArticleVaultAgentCommandReceipt receipt = await fixture.Dispatch.DispatchAsync(cancel, 1000, fixture.Running, default);
        Assert.Equal("agent_cancel_canonical_receipt_unavailable", receipt.ReasonCode);
        Assert.Null(receipt.CanonicalResultSha256);
        Assert.Equal(fixture.Reference, Assert.Single(fixture.Dispatch.InspectOperationReferences()));
    }

    [Fact]
    public async Task Revoke_AndUnavailableProducerCommandsCannotBecomeSuccess()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentRequest materialize = fixture.Request(ArticleVaultAgentCommand.MaterializeVerifiedInstruction,
            new(ArticleVaultAgentReferenceKind.VerifiedMaterializationInstruction, "instruction-test", ArticleVaultAgentDispatchFixture.Digest));
        Assert.Equal("agent_native_conditional_materializer_missing",
            (await fixture.Dispatch.DispatchAsync(materialize, 1000, fixture.Running, default)).ReasonCode);
        ArticleVaultAgentCommandReceipt revoke = await fixture.Dispatch.DispatchAsync(
            fixture.Request(ArticleVaultAgentCommand.Revoke, null, "revoke-request"), 1000, fixture.Running, default);
        Assert.Equal(ArticleVaultAgentCommandStatus.Admitted, revoke.Status);
        Assert.Null(revoke.CanonicalResultSha256);
        Assert.Equal(ArticleVaultAgentCommandStatus.Blocked, (await fixture.Dispatch.DispatchAsync(
            fixture.Request(ArticleVaultAgentCommand.InspectStatus, null, "status-request"), 1000, fixture.Running, default)).Status);
    }
}

internal sealed class ArticleVaultAgentDispatchFixture : IArticleVaultAgentCanonicalOperations, IDisposable
{
    internal const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal ArticleVaultPlanRequest Input
    {
        get;
    }
    internal ArticleVaultSyncPlan Plan
    {
        get;
    }
    internal ArticleVaultOperationIdentity Identity
    {
        get;
    }
    internal ArticleVaultAgentOperationReference Reference
    {
        get;
    }
    internal ArticleVaultAgentDispatchScope Dispatch
    {
        get;
    }
    internal ArticleVaultAgentBinding Binding
    {
        get;
    } = new("site-test", "vault-test", "device-test",
        "agent-test", "session-test", Digest, Digest, "1.0.0", 1);
    internal ArticleVaultAgentLifecycleReceipt Running
    {
        get;
    }
    internal IReadOnlyList<ArticleVaultOperationCheckpoint> History
    {
        get; private set;
    }
    internal int Executions
    {
        get; private set;
    }
    internal Func<CancellationToken, Task<ArticleVaultAgentCanonicalResult>>? Execute
    {
        get; set;
    }
    internal Func<Task<ArticleVaultAgentOperationSnapshot>>? Cancel
    {
        get; set;
    }

    internal ArticleVaultAgentDispatchFixture(bool cancelled = false)
    {
        VaultArticleCoordinate coordinate = new(ArticleVaultSchemas.Coordinate, 1, true, false, 4,
            ArticleVaultManifestCodec.CaptureSourceBytes("unit-source\n"u8), Digest, Digest, "draft", Digest, string.Empty);
        coordinate = coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
        const string Path = "articles/portable-test.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, Binding.SiteIdentity,
            Binding.VaultIdentity, Binding.DeviceIdentity, "portable-test", "101",
            new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)), new(coordinate, coordinate, coordinate),
            new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            Binding.SiteIdentity, Binding.VaultIdentity, Binding.DeviceIdentity,
            [new("portable-test", ".fsus/articles/portable-test.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1,
            Binding.SiteIdentity, Binding.VaultIdentity, Binding.DeviceIdentity, "portable-test", "101", coordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        Input = new(root, [article], [observation], [new("group-test", ["portable-test"], [])], VaultSyncDirection.Sync, 0, 60000, false);
        Plan = ArticleVaultSyncPlanner.Build(Input).Plan!;
        Identity = ArticleVaultOperationVerifier.Bind(Plan, Binding.AgentInstanceIdentity, Digest, Digest, 60000);
        ArticleVaultOperationCheckpoint planned = Checkpoint(null, VaultOperationState.Planned, VaultServerCommitDisposition.NotStarted);
        if (cancelled)
        {
            History = [planned, Checkpoint(planned, VaultOperationState.Cancelled, VaultServerCommitDisposition.NotStarted)];
        }
        else
        {
            ArticleVaultOperationCheckpoint validating = Checkpoint(planned, VaultOperationState.Validating, VaultServerCommitDisposition.NotStarted);
            History = [planned, validating, Checkpoint(validating, VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown)];
        }

        Reference = new(Identity, History[^1].Sequence, History[^1].ContentSha256);
        Dispatch = new(Binding, root.ContentSha256, this, new UnitTimeProvider());
        ArticleVaultAgentLifecycleReceipt stopped = ArticleVaultAgentLifecycle.Initial(Binding, ArticleVaultAgentPlatform.Linux, 0);
        ArticleVaultAgentLifecycleReceipt running = stopped with
        {
            NewState = ArticleVaultAgentLifecycleState.Running,
            RescanRequired = false,
            LeaseGeneration = 1,
            LeaseReceiptSha256 = Digest,
            IpcReceiptSha256 = Digest,
            Recovery = new(root.ContentSha256, Digest, Digest, Digest, Digest),
            ProducerReceiptSha256 = Digest,
            ContentSha256 = string.Empty
        };
        Running = running with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(running)
        };
    }

    internal Task RegisterAsync() => Dispatch.RegisterOperationAsync(Reference, "execute-request", "cancel-test", default);

    internal ArticleVaultAgentRequest ExecuteRequest()
        => Request(ArticleVaultAgentCommand.ExecuteVerifiedPlan,
            new(ArticleVaultAgentReferenceKind.VerifiedPlan, Plan.PlanCandidateIdentity, Plan.ContentSha256), "execute-request");

    internal ArticleVaultAgentRequest Request(ArticleVaultAgentCommand command, ArticleVaultAgentReference? reference, string id = "request-test")
    {
        var request = new ArticleVaultAgentRequest(ArticleVaultAgentProtocol.RequestSchema, Binding, id,
            1, Digest, command, 1000, "cancel-test", reference, string.Empty);
        return request with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(request)
        };
    }

    internal ArticleVaultAgentCanonicalResult Result()
        => new(Identity.OperationIdentity, Identity.ContentSha256, Plan.ContentSha256,
            Plan.ResultCandidateIdentity, Digest, ArticleVaultAgentCanonicalOutcome.NoOp);

    public Task<ArticleVaultAgentOperationSnapshot> ReadAsync(ArticleVaultAgentOperationReference reference, CancellationToken cancellationToken)
        => Task.FromResult(new ArticleVaultAgentOperationSnapshot(Plan, History));

    public Task<ArticleVaultAgentCanonicalResult> ExecuteAsync(ArticleVaultAgentOperationReference reference, CancellationToken cancellationToken)
    {
        Executions++;
        return Execute?.Invoke(cancellationToken) ?? Task.FromResult(Result());
    }

    public Task<ArticleVaultAgentOperationSnapshot> CancelAsync(ArticleVaultAgentOperationReference reference, CancellationToken cancellationToken)
    {
        if (Cancel is not null)
        {
            return Cancel();
        }

        ArticleVaultOperationCheckpoint tip = History[^1];
        if (tip.State != VaultOperationState.Cancelled && !tip.CancellationRequested)
        {
            ArticleVaultOperationCheckpoint next = tip with
            {
                Sequence = tip.Sequence + 1,
                PreviousCheckpointSha256 = tip.ContentSha256,
                RecordedAtUnixMs = 50,
                State = VaultOperationState.RecoveryRequired,
                CancellationRequested = true,
                ReasonCode = "unit_cancel_recovery",
                ContentSha256 = string.Empty
            };
            next = next with
            {
                ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(next)
            };
            ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateAppend(Identity, Plan, tip, next));
            History = [.. History, next];
        }

        return Task.FromResult(new ArticleVaultAgentOperationSnapshot(Plan, History));
    }

    public void Dispose() => Dispatch.Dispose();

    private ArticleVaultOperationCheckpoint Checkpoint(
        ArticleVaultOperationCheckpoint? previous, VaultOperationState state, VaultServerCommitDisposition commit)
    {
        var checkpoint = new ArticleVaultOperationCheckpoint(ArticleVaultOperationSchemas.Checkpoint, 1,
            Identity.OperationIdentity, Identity.ContentSha256, previous?.Sequence + 1 ?? 0, previous?.ContentSha256,
            previous?.RecordedAtUnixMs + 1 ?? 0, state, commit, null, null,
            Plan.Groups.SelectMany(static group => group.Items).Select(static item => new VaultOperationArticleOutcome(
                item.PortableArticleIdentity, item.Base.ContentSha256, item.Base.ContentSha256)).ToArray(),
            state == VaultOperationState.Cancelled, state == VaultOperationState.Cancelled ? "unit_cancelled" : null, string.Empty);
        return checkpoint with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(checkpoint)
        };
    }

    private sealed class UnitTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(50);
    }
}
