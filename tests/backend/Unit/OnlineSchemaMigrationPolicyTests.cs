using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationPolicyTests
{
    [Fact]
    public void ArticleAssetReferenceLedger_IsExplicitAdditiveExpand()
    {
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog()
            .GetMetadata()[ArticleAssetReferenceMigrationDefinitions.MigrationId];

        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Contains("article_asset_reference_recheck", metadata.Validators);
    }

    [Fact]
    public void ExistingRegistry_IsExplicitlyClassifiedWithoutInferringOnlinePhases()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadata =
            new OnlineSchemaMigrationCatalog().GetMetadata();

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(descriptors, metadata);

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(descriptors.Count, metadata.Count);
        OnlineSchemaMigrationMetadata passkeyExpand =
            metadata["20260711-post-recovery-passkey-completion-idempotency"];
        OnlineSchemaMigrationMetadata publicArticleProjectionExpand =
            metadata["20260714-post-public-article-projection"];
        OnlineSchemaMigrationMetadata articleOutboxClaimLeaseExpand =
            metadata["20260715-post-article-mutation-outbox-claim-lease"];
        OnlineSchemaMigrationMetadata activeReleaseFenceWitnessExpand =
            metadata["20260715-post-active-release-fence-durable-witness"];
        OnlineSchemaMigrationMetadata activeReleaseFencedCommitExpand =
            metadata["20260715-post-active-release-fenced-commit-ledger"];
        OnlineSchemaMigrationMetadata readEventRetirementCompat =
            metadata["20260715-pre-read-event-retirement-compat"];
        OnlineSchemaMigrationMetadata readEventRetirementContract =
            metadata["20260715-post-read-event-retirement"];
        OnlineSchemaMigrationMetadata anonymousEligibilityPredicateExpand =
            metadata["20260716-pre-anonymous-eligibility-predicate"];
        OnlineSchemaMigrationMetadata subjectExpand =
            metadata[AccountSubjectHashOnlineBackfillHandler.ExpandMigrationId];
        OnlineSchemaMigrationMetadata subjectBackfill =
            metadata[AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId];
        OnlineSchemaMigrationMetadata articleAssetReferences =
            metadata[ArticleAssetReferenceMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata articlePublicationCoordinates =
            metadata["20260719-pre-article-publication-coordinates"];
        OnlineSchemaMigrationMetadata articlePublicationConsistency =
            metadata["20260719-post-article-publication-consistency"];
        OnlineSchemaMigrationMetadata commentModerationEvent =
            metadata["20260719-post-comment-moderation-event"];
        OnlineSchemaMigrationMetadata messageAdminQueue =
            metadata["20260719-post-message-admin-queue-state"];
        OnlineSchemaMigrationMetadata messageMutationOutbox =
            metadata[MessageMutationOutboxMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata messageMutationIdempotency =
            metadata[MessageMutationIdempotencyMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata conversationStatusAudit =
            metadata[ConversationStatusAuditMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata messageUnreadAuthority =
            metadata[MessageUnreadAuthorityMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata userSessionMultiDevice =
            metadata[UserSessionMultiDeviceMigrationDefinitions.MigrationId];
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, passkeyExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, publicArticleProjectionExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articleOutboxClaimLeaseExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, activeReleaseFenceWitnessExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, activeReleaseFencedCommitExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, readEventRetirementCompat.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, readEventRetirementContract.Phase);
        Assert.True(readEventRetirementContract.Destructive);
        Assert.False(readEventRetirementContract.LegacyBootstrapOnly);
        Assert.Equal(TimeSpan.FromDays(30), readEventRetirementContract.MinimumRetentionWindow);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, anonymousEligibilityPredicateExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, subjectExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Backfill, subjectBackfill.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articleAssetReferences.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articlePublicationCoordinates.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articlePublicationConsistency.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, commentModerationEvent.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageAdminQueue.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageMutationOutbox.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageMutationIdempotency.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, conversationStatusAudit.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageUnreadAuthority.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, userSessionMultiDevice.Phase);
        Assert.True(userSessionMultiDevice.Destructive);
        Assert.False(userSessionMultiDevice.LegacyBootstrapOnly);
        Assert.Equal(AccountSubjectHashBackfillStep.BatchSize, subjectBackfill.BatchSize);
        Assert.Equal("last_account_id", subjectBackfill.ResumeTokenName);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint, subjectBackfill.RollbackMode);
        Assert.All(new[] { passkeyExpand, publicArticleProjectionExpand, articleOutboxClaimLeaseExpand, activeReleaseFenceWitnessExpand, activeReleaseFencedCommitExpand, readEventRetirementCompat, anonymousEligibilityPredicateExpand, subjectExpand, subjectBackfill, articleAssetReferences, articlePublicationCoordinates, articlePublicationConsistency, commentModerationEvent, messageAdminQueue, messageMutationOutbox, messageMutationIdempotency, conversationStatusAudit, messageUnreadAuthority }, classification =>
        {
            Assert.False(classification.LegacyBootstrapOnly);
            Assert.False(classification.Destructive);
            Assert.False(classification.RequiresExclusiveMode);
        });
        var onlineIds = new HashSet<string>(StringComparer.Ordinal)
        {
            passkeyExpand.MigrationId,
            publicArticleProjectionExpand.MigrationId,
            articleOutboxClaimLeaseExpand.MigrationId,
            activeReleaseFenceWitnessExpand.MigrationId,
            activeReleaseFencedCommitExpand.MigrationId,
            readEventRetirementCompat.MigrationId,
            readEventRetirementContract.MigrationId,
            anonymousEligibilityPredicateExpand.MigrationId,
            subjectExpand.MigrationId,
            subjectBackfill.MigrationId,
            articleAssetReferences.MigrationId,
            articlePublicationCoordinates.MigrationId,
            articlePublicationConsistency.MigrationId,
            commentModerationEvent.MigrationId,
            messageAdminQueue.MigrationId,
            messageMutationOutbox.MigrationId,
            messageMutationIdempotency.MigrationId,
            conversationStatusAudit.MigrationId,
            messageUnreadAuthority.MigrationId,
            userSessionMultiDevice.MigrationId
        };
        Assert.All(metadata.Values.Where(classification =>
            !onlineIds.Contains(classification.MigrationId)), classification =>
        {
            Assert.Equal(OnlineSchemaMigrationPhase.Contract, classification.Phase);
            Assert.True(classification.LegacyBootstrapOnly);
            Assert.True(classification.Destructive);
            Assert.True(classification.RequiresExclusiveMode);
            Assert.Equal(OnlineSchemaMigrationRollbackMode.BackupRestore, classification.RollbackMode);
            Assert.NotNull(classification.ContractAfterRelease);
            Assert.True(classification.MinimumRetentionWindow > TimeSpan.Zero);
        });
    }

    [Fact]
    public void Expand_RejectsDropRenameTighteningAndRewriteOperations()
    {
        var descriptor = new SchemaMigrationDescriptor(
            "20260712-pre-invalid-expand",
            "invalid expand",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("ALTER TABLE article ALTER COLUMN title TYPE varchar(64);"),
                new DropColumnStep("article", "legacy_title", DestructiveMigrationProofs.For("20260418-post-content-cleanup"))
            ]);
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            destructive: false);

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.False(report.Valid);
        Assert.Contains(report.Violations, violation =>
            violation.Code == "schema_destructive_operation_not_contract");
    }

    [Fact]
    public void Backfill_RequiresBoundedBatchAndDurableResumeToken()
    {
        var descriptor = new SchemaMigrationDescriptor(
            "20260712-post-invalid-backfill",
            "invalid backfill",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps: []);
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Backfill,
            destructive: false) with
        {
            BatchSize = null,
            ResumeTokenName = null
        };

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.Contains(report.Violations, violation =>
            violation.Code == "schema_backfill_not_resumable");
    }

    [Fact]
    public void CommandLine_ParsesStableRolloutInterface()
    {
        OnlineSchemaMigrationCommand expand = OnlineSchemaMigrationCommandLine.Parse(
        [
            "migrate",
            "--phase", "expand",
            "--release-manifest", "/run/release.json",
            "--env-file", "/run/server.env",
            "--dry-run"
        ]);
        OnlineSchemaMigrationCommand backfill = OnlineSchemaMigrationCommandLine.Parse(
        [
            "migrate",
            "--phase", "backfill-resume",
            "--id", "20260712-post-example-backfill",
            "--release-manifest", "/run/release.json",
            "--env-file", "/run/server.env"
        ]);
        OnlineSchemaMigrationCommand contractDryRun = OnlineSchemaMigrationCommandLine.Parse(
        [
            "migrate",
            "--phase", "contract",
            "--release-manifest", "/run/release.json",
            "--env-file", "/run/server.env",
            "--evidence", "/run/contract-evidence.json",
            "--dry-run"
        ]);

        Assert.Equal(OnlineSchemaMigrationPhase.Expand, expand.Phase);
        Assert.True(expand.DryRun);
        Assert.Equal("/run/release.json", expand.ReleaseManifestPath);
        Assert.Equal(OnlineSchemaMigrationPhase.Backfill, backfill.Phase);
        Assert.Equal("20260712-post-example-backfill", backfill.MigrationId);
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, contractDryRun.Phase);
        Assert.False(contractDryRun.ConfirmDestructive);
    }

    [Fact]
    public void CommandLine_RequiresExplicitConfirmationForMutatingContract()
    {
        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() =>
            OnlineSchemaMigrationCommandLine.Parse(
            [
                "migrate",
                "--phase", "contract",
                "--evidence", "/run/contract-evidence.json"
            ]));

        Assert.Equal("schema_contract_evidence_and_confirmation_required", exception.Message);
    }

    [Fact]
    public void ContractGate_RequiresNAndNMinusOneWindowAndOperationalEvidence()
    {
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            "20260701-post-example-contract",
            OnlineSchemaMigrationPhase.Contract,
            destructive: true) with
        {
            ContractAfterRelease = "20260710-contract-fence",
            MinimumRetentionWindow = TimeSpan.FromDays(7),
            RequiresExclusiveMode = true,
            RollbackMode = OnlineSchemaMigrationRollbackMode.BackupRestore
        };
        DateTimeOffset now = DateTimeOffset.Parse("2026-07-20T00:00:00Z");
        var incompleteEvidence = new OnlineSchemaContractEvidence(
            CurrentReleaseUsesOldSchema: true,
            PreviousRollbackReleaseUsesOldSchema: true,
            BackfillComplete: false,
            BackfillVerified: false,
            ObservationStartedAtUtc: now.AddDays(-1),
            BackupRestoreVerifiedAtUtc: null,
            SlotSwitchInProgress: true,
            DestructiveChangeConfirmed: false,
            RollbackManifestSealed: false,
            OldWritesDisabled: false,
            ExclusiveModeEnabled: false);

        IReadOnlyList<OnlineSchemaCompatibilityIssue> issues = OnlineSchemaContractGate.Evaluate(
            metadata,
            incompleteEvidence,
            "20260709-current",
            "20260708-previous",
            now,
            TimeSpan.FromHours(24));

        Assert.Contains(issues, issue => issue.Code == "schema_contract_release_window_open");
        Assert.Contains(issues, issue => issue.Code == "schema_contract_backfill_incomplete");
        Assert.Contains(issues, issue => issue.Code == "schema_contract_slot_switch_in_progress");
        Assert.Contains(issues, issue => issue.Code == "schema_contract_backup_restore_stale");
        Assert.Contains(issues, issue => issue.Code == "schema_contract_confirmation_missing");
    }

    [Fact]
    public void EnvironmentFile_IsParsedAsDataWithoutShellExpansion()
    {
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(
                path,
                "export ConnectionStrings__DefaultConnection='Host=db;Password=$(not-executed)'\n"
                + "FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE=20260719-previous\n");

            IReadOnlyDictionary<string, string?> values = OnlineSchemaMigrationEnvironmentFile.Read(path);

            Assert.Equal(
                "Host=db;Password=$(not-executed)",
                values["ConnectionStrings:DefaultConnection"]);
            Assert.Equal(
                "20260719-previous",
                values["FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE"]);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ReleaseManifest_BindsRequestedReleaseAndNMinusOneIdentity()
    {
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(
                path,
                """
                {
                  "schema": "fsusblog.release-manifest.v1",
                  "releaseId": "20260720-current",
                  "schemaCompatibility": {
                    "minRelease": "20260701-schema",
                    "maxRelease": "20260731-schema"
                  }
                }
                """);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FSUSBLOG_RELEASE_MANIFEST_PATH"] = path,
                    ["FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE"] = "20260719-previous"
                })
                .Build();
            var provider = new OnlineSchemaReleaseManifestProvider(configuration);

            OnlineSchemaReleaseManifest manifest = provider.Load("20260720-current");

            Assert.Equal("20260719-previous", manifest.PreviousRollbackRelease);
            Assert.Throws<InvalidOperationException>(() => provider.Load("20260721-other"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static OnlineSchemaMigrationMetadata CreateMetadata(
        string migrationId,
        OnlineSchemaMigrationPhase phase,
        bool destructive)
        => new(
            migrationId,
            phase,
            new OnlineSchemaReleaseRange("20260701-release", "20260731-release"),
            RequiresExclusiveMode: false,
            Destructive: destructive,
            RollbackMode: destructive
                ? OnlineSchemaMigrationRollbackMode.BackupRestore
                : phase == OnlineSchemaMigrationPhase.Backfill
                    ? OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint
                    : OnlineSchemaMigrationRollbackMode.CompatibleCode,
            EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
            BatchSize: phase == OnlineSchemaMigrationPhase.Backfill ? 100 : null,
            ResumeTokenName: phase == OnlineSchemaMigrationPhase.Backfill ? "last_id" : null,
            IntroducedAtRelease: "20260701-release",
            ContractAfterRelease: phase == OnlineSchemaMigrationPhase.Contract ? "20260710-contract-fence" : null,
            MinimumRetentionWindow: phase == OnlineSchemaMigrationPhase.Contract ? TimeSpan.FromDays(7) : TimeSpan.Zero,
            Validators: ["test-validator"]);
}
