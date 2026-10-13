using System.Text;
using System.Text.Json;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultOperationProtocolTests
{
    [Fact]
    public void Identity_BindsFullPlanAndAgentRequestDeadlineDeterministically()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        Assert.Equal(identity, ArticleVaultOperationFixture.Identity(plan));
        Assert.NotEqual(identity.OperationIdentity, ArticleVaultOperationVerifier.Bind(
            plan, "agent-other", ArticleVaultOperationFixture.DigestA,
            ArticleVaultOperationFixture.DigestB, plan.ExpiresAtUnixMs).OperationIdentity);
        ArticleVaultOperationIdentity[] mutations =
        [
            identity with { SiteIdentity = "site-other" },
            identity with { VaultIdentity = "vault-other" },
            identity with { DeviceIdentity = "device-other" },
            identity with { PlanSha256 = ArticleVaultOperationFixture.DigestA },
            identity with { PlanReference = "plan-other" },
            identity with { AgentIdentity = "" },
            identity with { DeadlineUnixMs = plan.ExpiresAtUnixMs + 1 }
        ];
        foreach (ArticleVaultOperationIdentity mutation in mutations)
        {
            ArticleVaultOperationIdentity resealed = mutation with
            {
                OperationIdentity = ArticleVaultOperationCodec.ComputeOperationIdentity(mutation)
            };
            resealed = resealed with { ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(resealed) };
            Assert.False(ArticleVaultOperationVerifier.ValidateIdentity(resealed, plan).IsValid);
        }
    }

    [Fact]
    public void History_RequiresExactTipAndEveryHashLinkedPredecessor()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, planned, VaultOperationState.Validating);
        Assert.True(ArticleVaultOperationVerifier.VerifyHistory(
            identity, plan, [planned, validating], 1, validating.ContentSha256).IsValid);
        Assert.False(ArticleVaultOperationVerifier.VerifyHistory(
            identity, plan, [validating], 1, validating.ContentSha256).IsValid);
        Assert.Equal("article_vault_operation_tip_mismatch", ArticleVaultOperationVerifier.VerifyHistory(
            identity, plan, [planned, validating], 1, planned.ContentSha256).ReasonCode);
        Assert.False(ArticleVaultOperationVerifier.VerifyHistory(
            identity, plan, [planned, validating], 0, planned.ContentSha256).IsValid);
        Assert.False(ArticleVaultOperationVerifier.VerifyHistory(
            identity, plan, [planned, validating with { PreviousCheckpointSha256 = ArticleVaultOperationFixture.DigestA }],
            1, validating.ContentSha256).IsValid);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CancelOrExpiry_AfterPossibleServerCommitRequiresRecoveryAndRetainsBase(bool expiry)
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint executing = ArticleVaultOperationFixture.Executing(identity, plan);
        ArticleVaultOperationCheckpoint recovery = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, executing, VaultOperationState.RecoveryRequired, VaultServerCommitDisposition.Unknown,
            reason: "server_outcome_unknown", cancelled: !expiry,
            time: expiry ? identity.DeadlineUnixMs + 1 : executing.RecordedAtUnixMs + 1);
        Assert.True(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, executing, recovery).IsValid);
        Assert.All(recovery.Articles, static item => Assert.Equal(item.BaseBeforeSha256, item.BaseAfterSha256));
        Assert.False(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, executing,
            ArticleVaultOperationFixture.Seal(recovery with { State = VaultOperationState.Cancelled })).IsValid);
        Assert.False(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, executing,
            ArticleVaultOperationFixture.Seal(recovery with { State = VaultOperationState.Failed })).IsValid);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CancelOrExpiry_BeforeServerStagePreventsExecution(bool expiry)
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        ArticleVaultOperationCheckpoint cancelled = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, planned, VaultOperationState.Cancelled, reason: "operation_interrupted",
            cancelled: !expiry, time: expiry ? identity.DeadlineUnixMs + 1 : planned.RecordedAtUnixMs + 1);
        Assert.True(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, planned, cancelled).IsValid);
        Assert.False(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, planned,
            ArticleVaultOperationFixture.Seal(cancelled with { State = VaultOperationState.Validating, ReasonCode = null })).IsValid);
    }

    [Theory]
    [InlineData(VaultOperationState.Cancelled)]
    [InlineData(VaultOperationState.Failed)]
    [InlineData(VaultOperationState.Blocked)]
    public void TerminalHistory_CannotBecomeSyncedOrBeResumed(VaultOperationState terminalState)
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, ArticleVaultOperationFixture.Checkpoint(identity, plan), VaultOperationState.Validating);
        ArticleVaultOperationCheckpoint terminal = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, validating, terminalState, reason: "operation_stopped");
        Assert.True(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, validating, terminal).IsValid);
        Assert.False(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, terminal,
            ArticleVaultOperationFixture.Checkpoint(identity, plan, terminal, VaultOperationState.Validating)).IsValid);
        Assert.False(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, terminal,
            ArticleVaultOperationFixture.Checkpoint(identity, plan, terminal, VaultOperationState.Synced)).IsValid);
    }

    [Fact]
    public void ServerSuccess_IsApplyingUntilActualMaterializationCapabilityVerifiesBase()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint executing = ArticleVaultOperationFixture.Executing(identity, plan);
        ArticleVaultOperationCheckpoint materializing = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, executing, VaultOperationState.MaterializingLocal, VaultServerCommitDisposition.Accepted,
            new VaultOperationStageReference(plan.ResultCandidateIdentity, ArticleVaultOperationFixture.DigestA));
        Assert.True(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, executing, materializing).IsValid);
        Assert.Equal(VaultArticleState.Applying, ArticleVaultOperationVerifier.ArticleState(materializing.State));
        Assert.Equal("article_vault_operation_materialization_capability_missing",
            ArticleVaultOperationVerifier.ValidateAppend(identity, plan, materializing,
                ArticleVaultOperationFixture.Checkpoint(identity, plan, materializing, VaultOperationState.Synced,
                    VaultServerCommitDisposition.Accepted, materializing.ServerResult)).ReasonCode);
    }

    [Fact]
    public void LocalFailure_BaseAdvanceAndReceiptReplacementFailClosed()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint materializing = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, ArticleVaultOperationFixture.Executing(identity, plan), VaultOperationState.MaterializingLocal,
            VaultServerCommitDisposition.Accepted,
            new VaultOperationStageReference(plan.ResultCandidateIdentity, ArticleVaultOperationFixture.DigestA));
        ArticleVaultOperationCheckpoint recovery = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, materializing, VaultOperationState.RecoveryRequired, VaultServerCommitDisposition.Accepted,
            materializing.ServerResult, reason: "local_verify_failed");
        Assert.True(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, materializing, recovery).IsValid);
        Assert.Equal("article_vault_operation_base_mismatch", ArticleVaultOperationVerifier.ValidateAppend(
            identity, plan, materializing, ArticleVaultOperationFixture.Seal(recovery with
            {
                Articles = [recovery.Articles[0] with { BaseAfterSha256 = ArticleVaultOperationFixture.DigestC }]
            })).ReasonCode);
        Assert.False(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, materializing,
            ArticleVaultOperationFixture.Seal(recovery with
            {
                ServerResult = recovery.ServerResult! with { ContentSha256 = ArticleVaultOperationFixture.DigestB }
            })).IsValid);
    }

    [Fact]
    public void RecoveryHistory_CannotAdmitResumeFromHashLinkedAcceptedResultAlone()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationIdentity identity = ArticleVaultOperationFixture.Identity(plan);
        ArticleVaultOperationCheckpoint planned = ArticleVaultOperationFixture.Checkpoint(identity, plan);
        ArticleVaultOperationCheckpoint validating = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, planned, VaultOperationState.Validating);
        ArticleVaultOperationCheckpoint executing = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, validating, VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown);
        ArticleVaultOperationCheckpoint recovery = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, executing, VaultOperationState.RecoveryRequired, VaultServerCommitDisposition.Unknown,
            reason: "server_outcome_unknown");
        ArticleVaultOperationCheckpoint accepted = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, recovery, VaultOperationState.RecoveryRequired, VaultServerCommitDisposition.Accepted,
            new VaultOperationStageReference(plan.ResultCandidateIdentity, ArticleVaultOperationFixture.DigestA),
            reason: "local_materialization_pending");
        ArticleVaultOperationCheckpoint resume = ArticleVaultOperationFixture.Checkpoint(
            identity, plan, accepted, VaultOperationState.MaterializingLocal, VaultServerCommitDisposition.Accepted,
            accepted.ServerResult);

        Assert.True(ArticleVaultOperationVerifier.VerifyHistory(identity, plan,
            [planned, validating, executing, recovery, accepted], accepted.Sequence, accepted.ContentSha256).IsValid);
        Assert.Equal("article_vault_operation_resume_capability_missing",
            ArticleVaultOperationVerifier.ValidateAppend(identity, plan, accepted, resume).ReasonCode);
        Assert.Equal("article_vault_operation_resume_capability_missing",
            ArticleVaultOperationVerifier.VerifyHistory(identity, plan,
                [planned, validating, executing, recovery, accepted, resume], resume.Sequence, resume.ContentSha256).ReasonCode);
    }

    [Fact]
    public void ClosedCodec_RejectsUnknownFieldsAndNumericStateRatherThanWarning()
    {
        ArticleVaultSyncPlan plan = ArticleVaultOperationFixture.Plan();
        ArticleVaultOperationCheckpoint checkpoint = ArticleVaultOperationFixture.Checkpoint(
            ArticleVaultOperationFixture.Identity(plan), plan);
        string json = Encoding.UTF8.GetString(ArticleVaultOperationCodec.Serialize(checkpoint));
        Assert.Throws<JsonException>(() => ArticleVaultOperationCodec.Deserialize<ArticleVaultOperationCheckpoint>(
            Encoding.UTF8.GetBytes(json[..^1] + ",\"unknown\":true}")));
        Assert.Throws<JsonException>(() => ArticleVaultOperationCodec.Deserialize<ArticleVaultOperationCheckpoint>(
            Encoding.UTF8.GetBytes(json.Replace("\"planned\"", "0", StringComparison.Ordinal))));
    }
}

internal static class ArticleVaultOperationFixture
{
    internal const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    internal const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    internal static ArticleVaultSyncPlan Plan()
        => Plan(out _, out _, out _, "body\r\n"u8.ToArray());

    private static ArticleVaultSyncPlan Plan(
        out ArticleVaultRootManifest root,
        out ArticleVaultArticleManifest article,
        out ArticleVaultServerObservation observation,
        byte[] source)
    {
        VaultArticleCoordinate coordinate = new(
            ArticleVaultSchemas.Coordinate, 1, true, false, 4,
            ArticleVaultManifestCodec.CaptureSourceBytes(source), DigestB, DigestC, "draft", DigestC, string.Empty);
        coordinate = coordinate with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate) };
        const string path = "articles/portable-article.md";
        article = new(
            ArticleVaultSchemas.ArticleManifest, 1, "site-primary", "vault-primary", "device-primary",
            "portable-article", "101", new VaultPathProjection(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)),
            new VaultArticleCoordinates(coordinate, coordinate, coordinate),
            new VaultOperationWatermarks(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article) };
        root = new(
            ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory), article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity,
            [new VaultArticleReference(article.PortableArticleIdentity, ".fsus/articles/portable-article.json", article.ContentSha256, path)],
            [], string.Empty);
        root = root with { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root) };
        observation = new(
            ArticleVaultPlanSchemas.ServerObservation, 1, article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity,
            article.PortableArticleIdentity, article.ServerArticleIdentity, coordinate, string.Empty);
        observation = observation with { ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation) };
        ArticleVaultPlanBuildResult result = ArticleVaultSyncPlanner.Build(new(
            root, [article], [observation], [new VaultPlanGroupRequest("group-primary", [article.PortableArticleIdentity], [])],
            VaultSyncDirection.Sync, 1_800_000_000_000, 1_800_000_060_000, false));
        Assert.Empty(result.Errors);
        return Assert.IsType<ArticleVaultSyncPlan>(result.Plan);
    }

    internal static ArticleVaultSealedExecutionBundle Bundle(byte[] source)
    {
        ArticleVaultSyncPlan plan = Plan(out ArticleVaultRootManifest root, out ArticleVaultArticleManifest article,
            out ArticleVaultServerObservation observation, source);
        ArticleVaultExecutionPayload payload = new(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
        payload = payload with { ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload) };
        ArticleVaultSealedExecutionBundle bundle = new(ArticleVaultExecutionSchemas.Bundle, 1,
            plan.PlanCandidateIdentity, plan.ContentSha256, 1001, plan, root, [article], [observation], payload, string.Empty);
        return bundle with { ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle) };
    }

    internal static ArticleVaultExecutionResult NoOpResult(ArticleVaultSealedExecutionBundle bundle)
    {
        VaultSyncPlanGroup group = Assert.Single(bundle.Plan.Groups);
        VaultSyncPlanItem item = Assert.Single(group.Items);
        string idempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);
        ArticleVaultOperationResultReceipt operation = new(ArticleVaultExecutionSchemas.OperationReceipt, 1,
            bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanSha256, group.GroupIdentity, item.OperationIdentity,
            item.PortableArticleIdentity, item.Decision, ArticleVaultOperationOutcome.NoOp, 101, 4, 4,
            "article-service/noop", null, null, [], [], idempotency, item.Server.Source!.Sha256, null, string.Empty);
        operation = operation with { ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(operation) };
        ArticleVaultGroupResultReceipt groupReceipt = new(ArticleVaultExecutionSchemas.GroupReceipt, 1,
            bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanSha256, group.GroupIdentity, idempotency,
            true, [operation], null, string.Empty);
        groupReceipt = groupReceipt with { ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(groupReceipt) };
        ArticleVaultExecutionResult result = new(ArticleVaultExecutionSchemas.Result, 1, bundle.Plan.ResultCandidateIdentity,
            bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.PlanReference, bundle.PlanSha256,
            bundle.Plan.IdempotencyKey, ArticleVaultExecutionOutcome.NoOp, [groupReceipt], null, bundle.Plan.CreatedAtUnixMs + 1, string.Empty);
        return result with { ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(result) };
    }

    internal static ArticleVaultOperationIdentity Identity(ArticleVaultSyncPlan plan)
        => ArticleVaultOperationVerifier.Bind(plan, "agent-primary", DigestA, DigestB, plan.ExpiresAtUnixMs);

    internal static ArticleVaultOperationCheckpoint Executing(ArticleVaultOperationIdentity identity, ArticleVaultSyncPlan plan)
    {
        ArticleVaultOperationCheckpoint validating = Checkpoint(identity, plan, Checkpoint(identity, plan), VaultOperationState.Validating);
        return Checkpoint(identity, plan, validating, VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown);
    }

    internal static ArticleVaultOperationCheckpoint Checkpoint(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        ArticleVaultOperationCheckpoint? previous = null,
        VaultOperationState state = VaultOperationState.Planned,
        VaultServerCommitDisposition commit = VaultServerCommitDisposition.NotStarted,
        VaultOperationStageReference? server = null,
        string? reason = null,
        bool cancelled = false,
        long? time = null)
        => Seal(new(ArticleVaultOperationSchemas.Checkpoint, 1, identity.OperationIdentity, identity.ContentSha256,
            previous?.Sequence + 1 ?? 0, previous?.ContentSha256, time ?? (previous?.RecordedAtUnixMs + 1 ?? plan.CreatedAtUnixMs),
            state, commit, server, null,
            plan.Groups.SelectMany(static group => group.Items).OrderBy(static item => item.PortableArticleIdentity, StringComparer.Ordinal)
                .Select(static item => new VaultOperationArticleOutcome(item.PortableArticleIdentity, item.Base.ContentSha256, item.Base.ContentSha256)).ToArray(),
            cancelled, reason, string.Empty));

    internal static ArticleVaultOperationCheckpoint Seal(ArticleVaultOperationCheckpoint checkpoint)
        => checkpoint with { ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(checkpoint) };
}
