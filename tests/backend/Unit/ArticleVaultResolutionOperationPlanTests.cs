using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultResolutionOperationPlanTests
{
    [Fact]
    public void NewOperation_UsesCanonicalPlannerAndBinderWithoutChangingObservedCoordinates()
    {
        ArticleVaultResolutionPlanInput current = ArticleVaultResolutionProposalFixture.Create();
        ArticleVaultResolutionPlan proposal = ArticleVaultResolutionPlanner.Build(current).Plan!;
        byte[] original = ArticleVaultSyncPlanCodec.Serialize(current.Metadata.Plan);
        ArticleVaultResolutionOperationPlan plan = ArticleVaultResolutionOperationPlanner.Build(proposal, current).Plan!;

        Assert.True(ArticleVaultResolutionOperationPlanner.VerifyCurrent(plan, proposal, current).IsValid);
        Assert.NotEqual(current.Metadata.Plan.PlanCandidateIdentity, plan.SyncPlan.PlanCandidateIdentity);
        Assert.Equal(proposal.ContentSha256, plan.Operation.RequestSha256);
        Assert.True(ArticleVaultOperationVerifier.ValidateIdentity(plan.Operation, plan.SyncPlan).IsValid);
        Assert.Equal(VaultSyncPlanStatus.Blocked, plan.SyncPlan.Status);
        VaultSyncPlanItem before = Assert.Single(Assert.Single(current.Metadata.Plan.Groups).Items);
        VaultSyncPlanItem after = Assert.Single(Assert.Single(plan.SyncPlan.Groups).Items);
        Assert.Equal(before.Base, after.Base);
        Assert.Equal(before.Local, after.Local);
        Assert.Equal(before.Server, after.Server);
        Assert.Equal(before.Preconditions, after.Preconditions);
        Assert.NotEqual(proposal.ExpectedOutput!.MetadataManifestSha256, after.Local.MetadataManifestSha256);
        Assert.Equal(original, ArticleVaultSyncPlanCodec.Serialize(current.Metadata.Plan));
        Assert.Equal("article_vault_resolution_operation_canonical_planner_decision_admission_missing",
            ArticleVaultResolutionOperationPlanner.RequireExecutionAdmission(plan, proposal, current).ReasonCode);
    }

    [Fact]
    public void SameConfirmation_IsDeterministicAndDifferentClosedDecisionCreatesAnotherOperation()
    {
        ArticleVaultResolutionPlanInput current = ArticleVaultResolutionProposalFixture.Create();
        ArticleVaultResolutionPlan proposal = ArticleVaultResolutionPlanner.Build(current).Plan!;
        ArticleVaultResolutionOperationPlan first = ArticleVaultResolutionOperationPlanner.Build(proposal, current).Plan!;
        Assert.Equal(first.ContentSha256, ArticleVaultResolutionOperationPlanner.Build(proposal, current).Plan!.ContentSha256);
        ArticleVaultResolutionPlanInput later = current with
        {
            Metadata = current.Metadata with
            {
                Context = current.Metadata.Context with
                {
                    NowUnixMs = current.Metadata.Context.NowUnixMs + 1
                }
            }
        };
        Assert.True(ArticleVaultResolutionOperationPlanner.VerifyCurrent(first, proposal, later).IsValid);
        ArticleVaultResolutionPlanInput cancelled = current with
        {
            Decisions = [new(VaultConflictType.MetadataDisjoint, VaultConflictAction.CancelOperation,
                VaultConflictDisposition.Automatic, null)]
        };
        ArticleVaultResolutionPlan cancelProposal = ArticleVaultResolutionPlanner.Build(cancelled).Plan!;
        ArticleVaultResolutionOperationPlan second = ArticleVaultResolutionOperationPlanner.Build(cancelProposal, cancelled).Plan!;
        Assert.NotEqual(first.Operation.OperationIdentity, second.Operation.OperationIdentity);
        Assert.NotEqual(first.SyncPlan.PlanCandidateIdentity, second.SyncPlan.PlanCandidateIdentity);
        Assert.Equal(VaultSyncPlanStatus.Cancelled, second.SyncPlan.Status);
        Assert.Null(second.ExpectedOutput);
        Assert.Equal("article_vault_resolution_operation_cancelled",
            ArticleVaultResolutionOperationPlanner.RequireExecutionAdmission(second, cancelProposal, cancelled).ReasonCode);
    }

    [Fact]
    public void CurrentDrift_RejectsBeforeCreatingAnotherPlan()
    {
        ArticleVaultResolutionPlanInput current = ArticleVaultResolutionProposalFixture.Create();
        ArticleVaultResolutionPlan proposal = ArticleVaultResolutionPlanner.Build(current).Plan!;
        ArticleVaultResolutionPlanInput changed = current with
        {
            Confirmation = current.Confirmation with
            {
                ActorIdentity = "other-actor"
            }
        };
        Assert.Null(ArticleVaultResolutionOperationPlanner.Build(proposal, changed).Plan);
        changed = current with
        {
            Metadata = current.Metadata with
            {
                Context = current.Metadata.Context with
                {
                    NowUnixMs = proposal.ExpiresAtUnixMs + 1
                }
            }
        };
        Assert.Null(ArticleVaultResolutionOperationPlanner.Build(proposal, changed).Plan);
    }

    [Fact]
    public void ResealedWrongOriginOrExpectedOutput_FailsIndependentCurrentVerification()
    {
        ArticleVaultResolutionPlanInput current = ArticleVaultResolutionProposalFixture.Create();
        ArticleVaultResolutionPlan proposal = ArticleVaultResolutionPlanner.Build(current).Plan!;
        ArticleVaultResolutionOperationPlan plan = ArticleVaultResolutionOperationPlanner.Build(proposal, current).Plan!;
        ArticleVaultResolutionOperationPlan changed = plan with
        {
            OriginalSyncPlan = plan.OriginalSyncPlan with
            {
                ContentSha256 = new('b', 64)
            }
        };
        changed = changed with
        {
            ContentSha256 = ArticleVaultResolutionOperationPlanner.ComputeContentSha256(changed)
        };
        Assert.False(ArticleVaultResolutionOperationPlanner.VerifyCurrent(changed, proposal, current).IsValid);
        changed = plan with
        {
            ExpectedOutput = plan.ExpectedOutput! with
            {
                SourceSha256 = new('b', 64)
            }
        };
        changed = changed with
        {
            ContentSha256 = ArticleVaultResolutionOperationPlanner.ComputeContentSha256(changed)
        };
        Assert.False(ArticleVaultResolutionOperationPlanner.VerifyCurrent(changed, proposal, current).IsValid);
    }
}
