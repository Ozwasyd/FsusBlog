using System.Collections.Immutable;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultRecoveryJournal")]
public sealed class ArticleVaultRecoveryJournalTests
{
    [Fact]
    public void ExactCheckpointHistory_IsStructurallyBoundAndNeverPhysicalRecoveryProof()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ArticleVaultResolutionPlan plan = ArticleVaultResolutionPlanner.Build(input).Plan!;
        ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan,
            VaultRecoveryState.Prepared, VaultRecoveryState.ServerCommitting, VaultRecoveryState.ServerCommitted,
            VaultRecoveryState.LocalMaterializing, VaultRecoveryState.RecoveryRequired,
            VaultRecoveryState.RolledForward, VaultRecoveryState.Complete);
        VaultRecoveryReference checkpoint = Tip(plan, history);
        Assert.True(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, checkpoint).IsValid);
        Assert.Equal("article_vault_recovery_canonical_materializer_and_operation_admission_missing",
            ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan, input, history, checkpoint).ReasonCode);
        foreach (ArticleVaultRecoveryJournal journal in history)
        {
            byte[] bytes = ArticleVaultRecoveryJournalVerifier.Serialize(journal);
            Assert.Equal(journal.ContentSha256, ArticleVaultRecoveryJournalVerifier.Deserialize(bytes).ContentSha256);
            Assert.DoesNotContain("local title", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(VaultRecoveryState.Cancelled)]
    [InlineData(VaultRecoveryState.Failed)]
    public void BeforeServerFailureOrCancel_HasNoServerLocalOrNewBaseReceipt(VaultRecoveryState terminal)
    {
        ArticleVaultResolutionPlan plan = Plan();
        ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan, VaultRecoveryState.Prepared, terminal);
        Assert.True(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, Tip(plan, history)).IsValid);
        Assert.Null(history[^1].ServerResult);
        Assert.Null(history[^1].LocalMaterialization);
        Assert.Null(history[^1].AfterBaseSha256);
    }

    [Theory]
    [InlineData(VaultRecoveryState.Prepared)]
    [InlineData(VaultRecoveryState.ServerCommitting)]
    [InlineData(VaultRecoveryState.ServerCommitted)]
    [InlineData(VaultRecoveryState.LocalMaterializing)]
    [InlineData(VaultRecoveryState.RecoveryRequired)]
    public void CrashAtEachCheckpoint_RetainsExactObligationAndCannotBecomeComplete(VaultRecoveryState state)
    {
        ArticleVaultResolutionPlan plan = Plan();
        List<VaultRecoveryState> states = [VaultRecoveryState.Prepared];
        if (state != VaultRecoveryState.Prepared)
        {
            states.Add(VaultRecoveryState.ServerCommitting);
        }

        if (state is VaultRecoveryState.ServerCommitted or VaultRecoveryState.LocalMaterializing or VaultRecoveryState.RecoveryRequired)
        {
            states.Add(VaultRecoveryState.ServerCommitted);
        }

        if (state is VaultRecoveryState.LocalMaterializing or VaultRecoveryState.RecoveryRequired)
        {
            states.Add(VaultRecoveryState.LocalMaterializing);
        }

        if (state == VaultRecoveryState.RecoveryRequired)
        {
            states.Add(VaultRecoveryState.RecoveryRequired);
        }

        ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan, states.ToArray());
        Assert.True(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, Tip(plan, history)).IsValid);
        Assert.Null(history[^1].BaseCommit);
        Assert.Null(history[^1].AfterBaseSha256);
        Assert.NotEqual(VaultRecoveryState.Complete, history[^1].State);
    }

    [Fact]
    public void ServerCommittedHistory_CannotBeDeletedCancelledFailedOrOverwritten()
    {
        ArticleVaultResolutionPlan plan = Plan();
        foreach (VaultRecoveryState terminal in new[] { VaultRecoveryState.Cancelled, VaultRecoveryState.Failed, VaultRecoveryState.Complete })
        {
            ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan,
                VaultRecoveryState.Prepared, VaultRecoveryState.ServerCommitting, VaultRecoveryState.ServerCommitted, terminal);
            Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, Tip(plan, history)).IsValid);
        }

        ImmutableArray<ArticleVaultRecoveryJournal> original = History(plan,
            VaultRecoveryState.Prepared, VaultRecoveryState.ServerCommitting, VaultRecoveryState.ServerCommitted, VaultRecoveryState.RecoveryRequired);
        ArticleVaultRecoveryJournal changed = Seal(original[^1] with
        {
            ServerResult = null
        });
        ImmutableArray<ArticleVaultRecoveryJournal> erased = original.SetItem(original.Length - 1, changed);
        Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, erased, Tip(plan, erased)).IsValid);
    }

    [Fact]
    public void LatestDuplicateMissingAndCrossOperationCheckpoints_AreRejected()
    {
        ArticleVaultResolutionPlan plan = Plan();
        ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan, VaultRecoveryState.Prepared, VaultRecoveryState.ServerCommitting);
        Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history, new("latest", history[^1].ContentSha256)).IsValid);
        Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, history.Add(history[^1]), Tip(plan, history)).IsValid);
        Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [history[^1]], Tip(plan, history)).IsValid);
        ArticleVaultRecoveryJournal other = Seal(history[^1] with
        {
            VaultIdentity = "other-vault"
        });
        Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [history[0], other], Tip(plan, [history[0], other])).IsValid);
        ArticleVaultRecoveryJournal tampered = history[^1] with
        {
            PreviousCheckpointSha256 = VaultResolutionTestInputs.Digest
        };
        Assert.False(ArticleVaultRecoveryJournalVerifier.VerifyHistory(plan, [history[0], tampered], Tip(plan, [history[0], tampered])).IsValid);
    }

    [Fact]
    public void BackupCapacityTtlPrivacyAndCleanupPolicy_RejectUnboundedPlaintextRetention()
    {
        ArticleVaultRecoveryJournal journal = History(Plan(), VaultRecoveryState.Prepared)[0];
        VaultRecoveryBackupPolicy[] policies =
        [
            journal.BackupPolicy with { MaxBytes = ArticleVaultRecoveryJournalVerifier.MaxBackupBytes + 1 },
            journal.BackupPolicy with { MaxBytes = 0 },
            journal.BackupPolicy with { DeleteAfterUnixMs = journal.CreatedAtUnixMs },
            journal.BackupPolicy with { DeleteAfterUnixMs = journal.CreatedAtUnixMs + ArticleVaultRecoveryJournalVerifier.MaxBackupRetentionMs + 1 },
            journal.BackupPolicy with { EncryptionRequired = false },
            journal.BackupPolicy with { PrivacyClass = "public" },
            journal.BackupPolicy with { CleanupPolicyIdentity = "delete-user-source" }
        ];
        foreach (VaultRecoveryBackupPolicy policy in policies)
        {
            Assert.False(ArticleVaultRecoveryJournalVerifier.ValidateStructure(Seal(journal with
            {
                BackupPolicy = policy
            })).IsValid);
        }
    }

    [Fact]
    public void RecoveryRevalidatesCurrentGitAndServerCoordinatesBeforeMissingAuthorityRefusal()
    {
        ArticleVaultResolutionPlanInput input = VaultResolutionTestInputs.Create();
        ArticleVaultResolutionPlan plan = ArticleVaultResolutionPlanner.Build(input).Plan!;
        ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan,
            VaultRecoveryState.Prepared, VaultRecoveryState.ServerCommitting, VaultRecoveryState.ServerCommitted, VaultRecoveryState.RecoveryRequired);
        ArticleVaultResolutionPlanInput changed = input with
        {
            Git = input.Git with
            {
                ContentSha256 = VaultResolutionTestInputs.Digest
            }
        };
        Assert.Equal("article_vault_resolution_stale_git_facts",
            ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(plan, changed, history, Tip(plan, history)).ReasonCode);
    }

    [Fact]
    public void UnknownExecutableFieldsAndBaseReceiptMismatch_FailClosed()
    {
        ArticleVaultResolutionPlan plan = Plan();
        ImmutableArray<ArticleVaultRecoveryJournal> history = History(plan,
            VaultRecoveryState.Prepared, VaultRecoveryState.ServerCommitting, VaultRecoveryState.ServerCommitted,
            VaultRecoveryState.LocalMaterializing, VaultRecoveryState.Complete);
        ArticleVaultRecoveryJournal complete = history[^1];
        Assert.False(ArticleVaultRecoveryJournalVerifier.ValidateStructure(Seal(complete with
        {
            BaseCommit = null
        })).IsValid);
        Assert.False(ArticleVaultRecoveryJournalVerifier.ValidateStructure(Seal(complete with
        {
            AfterBaseSha256 = null
        })).IsValid);
        string json = Encoding.UTF8.GetString(ArticleVaultRecoveryJournalVerifier.Serialize(complete));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRecoveryJournalVerifier.Deserialize(
            Encoding.UTF8.GetBytes(json[..^1] + ",\"shell\":\"rm -rf\"}")));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRecoveryJournalVerifier.Deserialize(new byte[1_048_577]));
    }

    private static ArticleVaultResolutionPlan Plan() => ArticleVaultResolutionPlanner.Build(VaultResolutionTestInputs.Create()).Plan!;

    // These references are deliberately nondurable fixture values. Passing history structure must
    // still fail RequireRecoveryAdmission; no fixture receipt is promoted to execution evidence.
    private static ImmutableArray<ArticleVaultRecoveryJournal> History(ArticleVaultResolutionPlan plan, params VaultRecoveryState[] states)
    {
        var history = ImmutableArray.CreateBuilder<ArticleVaultRecoveryJournal>();
        foreach (VaultRecoveryState state in states)
        {
            ArticleVaultRecoveryJournal? previous = history.Count == 0 ? null : history[^1];
            bool committed = previous?.ServerResult is not null || state is VaultRecoveryState.ServerCommitted
                or VaultRecoveryState.LocalMaterializing or VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward or VaultRecoveryState.Complete;
            bool materialized = state is VaultRecoveryState.Complete or VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward;
            ArticleVaultRecoveryJournal journal = new(ArticleVaultRecoveryJournalVerifier.Schema, 1, plan.ResolutionOperationIdentity,
                plan.ContentSha256, plan.Binding.SiteIdentity, plan.Binding.VaultIdentity, plan.Binding.DeviceIdentity,
                history.Count, previous?.ContentSha256, state, new("backup-one", VaultResolutionTestInputs.Digest),
                new(1024, VaultResolutionTestInputs.Now + 60_000, true, "private-source", "owned-encrypted-backup-expiry-v1"),
                committed ? new("server-result-one", VaultResolutionTestInputs.Digest) : null,
                materialized ? new("materialization-one", VaultResolutionTestInputs.Digest) : null,
                materialized ? new("base-commit-one", VaultResolutionTestInputs.Digest) : null,
                plan.Binding.Coordinates.Base.ContentSha256, materialized ? VaultResolutionTestInputs.Digest : null,
                VaultResolutionTestInputs.Now + history.Count, string.Empty);
            history.Add(Seal(journal));
        }

        return history.ToImmutable();
    }

    private static VaultRecoveryReference Tip(ArticleVaultResolutionPlan plan, ImmutableArray<ArticleVaultRecoveryJournal> history)
        => new(plan.ResolutionOperationIdentity + "-checkpoint-" + history[^1].Sequence, history[^1].ContentSha256);

    private static ArticleVaultRecoveryJournal Seal(ArticleVaultRecoveryJournal journal)
        => journal with
        {
            ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(journal)
        };
}
