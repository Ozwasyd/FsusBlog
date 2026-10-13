using System.Text.Json;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationPolicyTests
{
    private static HistoricalMigrationFence Coordinate(string value)
        => HistoricalMigrationFence.FromLegacyMetadata(value);

    private static ReleaseId Release(string value)
        => ReleaseId.Parse(value);

    [Fact]
    public void DistributedInvalidationLedgers_AreExplicitAdditiveExpands()
    {
        ISchemaMigrationDescriptor convergence =
            DistributedInvalidationConvergenceObligationMigrationDefinitions.BuildMigration();
        ISchemaMigrationDescriptor delivery =
            DistributedInvalidationDeliveryLedgerMigrationDefinitions.BuildMigration();
        IReadOnlyDictionary<string, OfflineMigrationClassificationFact> catalog =
            OfflineMigrationClassificationFacts.All;
        var metadata = new Dictionary<string, OfflineMigrationClassificationFact>
        {
            [convergence.MigrationId] = catalog[convergence.MigrationId],
            [delivery.MigrationId] = catalog[delivery.MigrationId]
        };

        OfflineMigrationClassificationFactValidatorReport report =
            OfflineMigrationClassificationFactValidator.Validate(metadata);

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.All(metadata.Values, item =>
        {
            Assert.Equal(OfflineMigrationPhase.Expand, item.Phase);
            Assert.False(item.Destructive);
            Assert.False(item.RequiresExclusiveMode);
            Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, item.RollbackMode);
        });
    }

    [Fact]
    public void RefreshTokenLineage_IsExplicitAdditiveExpand()
    {
        ISchemaMigrationDescriptor descriptor = RefreshTokenLineageMigrationDefinitions.BuildMigration();
        OfflineMigrationClassificationFact metadata = OfflineMigrationClassificationFacts.All[descriptor.MigrationId];

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(new Dictionary<string, OfflineMigrationClassificationFact> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OfflineMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, metadata.RollbackMode);
    }

    [Fact]
    public void UserSessionModeAuthority_IsExplicitAdditiveExpand()
    {
        ISchemaMigrationDescriptor descriptor = UserSessionModeMigrationDefinitions.BuildMigration();
        OfflineMigrationClassificationFact metadata = OfflineMigrationClassificationFacts.All[descriptor.MigrationId];

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(new Dictionary<string, OfflineMigrationClassificationFact> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OfflineMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, metadata.RollbackMode);
    }

    [Fact]
    public void CommentGovernanceMigrations_AreExplicitlyClassified()
    {
        ISchemaMigrationDescriptor revisionDescriptor = CommentRevisionManagementMigrationDefinitions.BuildMigration();
        ISchemaMigrationDescriptor governanceDescriptor = CommentGovernanceMigrationDefinitions.BuildMigration();
        IReadOnlyDictionary<string, OfflineMigrationClassificationFact> metadata =
            OfflineMigrationClassificationFacts.All;

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [revisionDescriptor.MigrationId] = metadata[revisionDescriptor.MigrationId],
                [governanceDescriptor.MigrationId] = metadata[governanceDescriptor.MigrationId]
            });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));

        OfflineMigrationClassificationFact revision = metadata[revisionDescriptor.MigrationId];
        Assert.Equal(OfflineMigrationPhase.Expand, revision.Phase);
        Assert.False(revision.Destructive);
        Assert.False(revision.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, revision.RollbackMode);

        OfflineMigrationClassificationFact governance = metadata[governanceDescriptor.MigrationId];
        Assert.Equal(OfflineMigrationPhase.Contract, governance.Phase);
        Assert.True(governance.Destructive);
        Assert.True(governance.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.BackupRestore, governance.RollbackMode);
        Assert.NotNull(governance.ContractAfterFence);
        Assert.True(governance.MinimumRetentionWindow > TimeSpan.Zero);
    }

    [Fact]
    public void ArticleCommentPolicy_IsExplicitAdditiveExpand()
    {
        ISchemaMigrationDescriptor descriptor = ArticleCommentPolicyMigrationDefinitions.BuildMigration();
        OfflineMigrationClassificationFact metadata = OfflineMigrationClassificationFacts.All[descriptor.MigrationId];

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(new Dictionary<string, OfflineMigrationClassificationFact> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OfflineMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Contains("article_comment_policy_inheritance", metadata.Validators);
        Assert.Contains("thread_policy_scope", metadata.Validators);
        Assert.Contains("privacy_safe_slow_mode", metadata.Validators);
    }

    [Fact]
    public void ArticleAssetReferenceLedger_IsExplicitAdditiveExpand()
    {
        OfflineMigrationClassificationFact metadata = OfflineMigrationClassificationFacts.All[ArticleAssetReferenceMigrationDefinitions.MigrationId];

        Assert.Equal(OfflineMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Contains("article_asset_reference_recheck", metadata.Validators);
    }

    [Fact]
    public void ExistingRegistry_IsExplicitlyClassifiedWithoutInferringOnlinePhases()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        IReadOnlyDictionary<string, OfflineMigrationClassificationFact> metadata =
            OfflineMigrationClassificationFacts.All;

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(metadata);

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(descriptors.Count, metadata.Count);
        OfflineMigrationClassificationFact passkeyExpand =
            metadata["20260711-post-recovery-passkey-completion-idempotency"];
        OfflineMigrationClassificationFact publicArticleProjectionExpand =
            metadata["20260714-post-public-article-projection"];
        OfflineMigrationClassificationFact articleOutboxClaimLeaseExpand =
            metadata["20260715-post-article-mutation-outbox-claim-lease"];
        OfflineMigrationClassificationFact activeReleaseFenceWitnessExpand =
            metadata["20260715-post-active-release-fence-durable-witness"];
        OfflineMigrationClassificationFact activeReleaseFencedCommitExpand =
            metadata["20260715-post-active-release-fenced-commit-ledger"];
        OfflineMigrationClassificationFact readEventRetirementCompat =
            metadata["20260715-pre-read-event-retirement-compat"];
        OfflineMigrationClassificationFact readEventRetirementContract =
            metadata["20260715-post-read-event-retirement"];
        OfflineMigrationClassificationFact anonymousEligibilityPredicateExpand =
            metadata["20260716-pre-anonymous-eligibility-predicate"];
        OfflineMigrationClassificationFact subjectExpand =
            metadata[AccountSubjectHashOnlineBackfillHandler.ExpandMigrationId];
        OfflineMigrationClassificationFact subjectBackfill =
            metadata[AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId];
        OfflineMigrationClassificationFact articleAssetReferences =
            metadata[ArticleAssetReferenceMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact articlePublicationCoordinates =
            metadata["20260719-pre-article-publication-coordinates"];
        OfflineMigrationClassificationFact articlePublicationConsistency =
            metadata["20260719-post-article-publication-consistency"];
        OfflineMigrationClassificationFact articleMutationIdempotency =
            metadata[ArticleMutationIdempotencyMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact commentModerationEvent =
            metadata["20260719-post-comment-moderation-event"];
        OfflineMigrationClassificationFact messageAdminQueue =
            metadata["20260719-post-message-admin-queue-state"];
        OfflineMigrationClassificationFact messageMutationOutbox =
            metadata[MessageMutationOutboxMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact messageMutationIdempotency =
            metadata[MessageMutationIdempotencyMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact conversationStatusAudit =
            metadata[ConversationStatusAuditMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact messageUnreadAuthority =
            metadata[MessageUnreadAuthorityMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact passkeySignalVersion =
            metadata[PasskeySignalMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact commentMutationIdempotency =
            metadata[CommentMutationIdempotencyMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact scheduledPublishDueIndex =
            metadata[ScheduledPublishIndexMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact articleDraftBaseRevision =
            metadata[ArticleDraftBaseRevisionMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact accountEnrollment =
            metadata[AccountEnrollmentMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact refreshTokenLineage =
            metadata[RefreshTokenLineageMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact userSessionModeAuthority =
            metadata[UserSessionModeMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact userSessionAuthenticationContext =
            metadata[UserSessionAuthenticationContextMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact userSessionMetadataMinimization =
            metadata[UserSessionMetadataMinimizationMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact commentMutationOutbox =
            metadata[CommentMutationOutboxMigrationDefinitions.MigrationId];
        OfflineMigrationClassificationFact userSessionMultiDevice =
            metadata[UserSessionMultiDeviceMigrationDefinitions.MigrationId];
        Assert.Equal(OfflineMigrationPhase.Expand, passkeyExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, articleDraftBaseRevision.Phase);
        Assert.False(articleDraftBaseRevision.Destructive);
        Assert.Equal(OfflineMigrationPhase.Expand, publicArticleProjectionExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, articleOutboxClaimLeaseExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, activeReleaseFenceWitnessExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, activeReleaseFencedCommitExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, readEventRetirementCompat.Phase);
        Assert.Equal(OfflineMigrationPhase.Contract, readEventRetirementContract.Phase);
        Assert.True(readEventRetirementContract.Destructive);
        Assert.False(readEventRetirementContract.LegacyBootstrapOnly);
        Assert.Equal(TimeSpan.FromDays(30), readEventRetirementContract.MinimumRetentionWindow);
        Assert.Equal(OfflineMigrationPhase.Expand, anonymousEligibilityPredicateExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, subjectExpand.Phase);
        Assert.Equal(OfflineMigrationPhase.Backfill, subjectBackfill.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, articleAssetReferences.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, articlePublicationCoordinates.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, articlePublicationConsistency.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, articleMutationIdempotency.Phase);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, articleMutationIdempotency.RollbackMode);
        Assert.Equal(OfflineMigrationHistoricalLockRisk.Low, articleMutationIdempotency.EstimatedLockRisk);
        Assert.Contains("article_mutation_idempotency", articleMutationIdempotency.Validators);
        Assert.Equal(OfflineMigrationPhase.Expand, commentModerationEvent.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, messageAdminQueue.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, messageMutationOutbox.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, messageMutationIdempotency.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, conversationStatusAudit.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, messageUnreadAuthority.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, passkeySignalVersion.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, commentMutationIdempotency.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, scheduledPublishDueIndex.Phase);
        Assert.Equal(OfflineMigrationHistoricalLockRisk.Low, scheduledPublishDueIndex.EstimatedLockRisk);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, scheduledPublishDueIndex.RollbackMode);
        Assert.Equal(OfflineMigrationPhase.Expand, accountEnrollment.Phase);
        Assert.Equal(OfflineMigrationPhase.Expand, refreshTokenLineage.Phase);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, refreshTokenLineage.RollbackMode);
        Assert.Contains("refresh_tombstone_retention", refreshTokenLineage.Validators);
        Assert.Equal(OfflineMigrationPhase.Expand, userSessionModeAuthority.Phase);
        Assert.False(userSessionModeAuthority.Destructive);
        Assert.Equal(OfflineMigrationPhase.Contract, userSessionAuthenticationContext.Phase);
        Assert.True(userSessionAuthenticationContext.Destructive);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.BackupRestore, userSessionAuthenticationContext.RollbackMode);
        Assert.Equal(OfflineMigrationPhase.Contract, userSessionMetadataMinimization.Phase);
        Assert.True(userSessionMetadataMinimization.Destructive);
        Assert.True(userSessionMetadataMinimization.RequiresExclusiveMode);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.BackupRestore, userSessionMetadataMinimization.RollbackMode);
        Assert.Equal(OfflineMigrationPhase.Expand, commentMutationOutbox.Phase);
        Assert.False(commentMutationOutbox.Destructive);
        Assert.Equal(OfflineMigrationPhase.Contract, userSessionMultiDevice.Phase);
        Assert.True(userSessionMultiDevice.Destructive);
        Assert.False(userSessionMultiDevice.LegacyBootstrapOnly);
        Assert.Equal(AccountSubjectHashBackfillStep.BatchSize, subjectBackfill.BatchSize);
        Assert.Equal("last_account_id", subjectBackfill.ResumeTokenName);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.ResumeFromCheckpoint, subjectBackfill.RollbackMode);
        Assert.All(new[] { passkeyExpand, publicArticleProjectionExpand, articleOutboxClaimLeaseExpand, activeReleaseFenceWitnessExpand, activeReleaseFencedCommitExpand, readEventRetirementCompat, anonymousEligibilityPredicateExpand, subjectExpand, subjectBackfill, articleAssetReferences, articlePublicationCoordinates, articlePublicationConsistency, articleMutationIdempotency, commentModerationEvent, messageAdminQueue, messageMutationOutbox, messageMutationIdempotency, conversationStatusAudit, messageUnreadAuthority, passkeySignalVersion, commentMutationIdempotency, scheduledPublishDueIndex, articleDraftBaseRevision, accountEnrollment, refreshTokenLineage, userSessionModeAuthority }, classification =>
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
            articleMutationIdempotency.MigrationId,
            commentModerationEvent.MigrationId,
            messageAdminQueue.MigrationId,
            messageMutationOutbox.MigrationId,
            messageMutationIdempotency.MigrationId,
            conversationStatusAudit.MigrationId,
            messageUnreadAuthority.MigrationId,
            passkeySignalVersion.MigrationId,
            commentMutationIdempotency.MigrationId,
            ArticleCommentPolicyMigrationDefinitions.MigrationId,
            scheduledPublishDueIndex.MigrationId,
            articleDraftBaseRevision.MigrationId,
            ArticleDraftServerRevisionMigrationDefinitions.MigrationId,
            ArticleMutationOutboxVersionMigrationDefinitions.MigrationId,
            CommentRevisionManagementMigrationDefinitions.MigrationId,
            CommentGovernanceMigrationDefinitions.MigrationId,
            CommentModerationQueueMigrationDefinitions.MigrationId,
            ArticleResponsibilityVersionMigrationDefinitions.MigrationId,
            ArticleRevisionContentBlockMigrationDefinitions.MigrationId,
            ArticleRevisionRollbackMigrationDefinitions.MigrationId,
            ArticleTimeSemanticsMigrationDefinitions.MigrationId,
            accountEnrollment.MigrationId,
            refreshTokenLineage.MigrationId,
            userSessionModeAuthority.MigrationId,
            userSessionAuthenticationContext.MigrationId,
            userSessionMetadataMinimization.MigrationId,
            commentMutationOutbox.MigrationId,
            MessagePrivacyRetentionMigrationDefinitions.MigrationId,
            userSessionMultiDevice.MigrationId,
            DistributedInvalidationConvergenceObligationMigrationDefinitions.MigrationId,
            DistributedInvalidationDeliveryLedgerMigrationDefinitions.MigrationId,
            DistributedInvalidationFullReconcileMigrationDefinitions.MigrationId,
            CommentMutationOutboxClaimLeaseMigrationDefinitions.MigrationId,
            CommentMutationOutboxDeliveryReservationMigrationDefinitions.MigrationId,
            UserLocalePreferenceMigrationDefinitions.MigrationId,
            PluginRegistryMigrationDefinitions.MigrationId,
            ThemeRegistryMigrationDefinitions.MigrationId,
            ThemeActivationRuntimeMigrationDefinitions.MigrationId,
            CustomizationMigrationDefinitions.MigrationId,
            AuthoringCanvasDocumentMigrationDefinitions.MigrationId,
            AuthoringCanvasOperationJournalMigrationDefinitions.MigrationId,
            TaxonomyDescriptionMigrationDefinitions.MigrationId,
            AuthorArticlePinMigrationDefinitions.MigrationId,
            AuthorSavedViewMigrationDefinitions.MigrationId,
            ArticleTemplateAuthorityMigrationDefinitions.MigrationId,
            ArticleVaultExecutionMigrationDefinitions.MigrationId,
            ArticleCreateAuthorityMigrationDefinitions.MigrationId,
            ContentAssetCutoverMigrationDefinitions.PrototypeShapeMigrationId,
            ContentAssetCutoverMigrationDefinitions.MigrationId,
            BanStateProjectionMigrationDefinitions.MigrationId,
            AdminSessionProjectionMigrationDefinitions.MigrationId,
            AuthorRecentArticleHistoryMigrationDefinitions.MigrationId,
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId,
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId
        };
        Assert.All(metadata.Values.Where(classification =>
            !onlineIds.Contains(classification.MigrationId)), classification =>
        {
            Assert.Equal(OfflineMigrationPhase.Contract, classification.Phase);
            Assert.True(classification.LegacyBootstrapOnly);
            Assert.True(classification.Destructive);
            Assert.True(classification.RequiresExclusiveMode);
            Assert.Equal(OfflineMigrationHistoricalRollbackMode.BackupRestore, classification.RollbackMode);
            Assert.NotNull(classification.ContractAfterFence);
            Assert.True(classification.MinimumRetentionWindow > TimeSpan.Zero);
        });
    }

    [Fact]
    public void ExistingSeptemberAuthorityMigrations_RetainExplicitAdditiveClassifications()
    {
        IReadOnlyDictionary<string, OfflineMigrationClassificationFact> catalog = OfflineMigrationClassificationFacts.All;
        string[] ids =
        [
            BanStateProjectionMigrationDefinitions.MigrationId,
            AdminSessionProjectionMigrationDefinitions.MigrationId,
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId
        ];
        Assert.All(ids, id =>
        {
            OfflineMigrationClassificationFact metadata = catalog[id];
            Assert.Equal(OfflineMigrationPhase.Expand, metadata.Phase);
            Assert.False(metadata.Destructive);
            Assert.False(metadata.RequiresExclusiveMode);
            Assert.False(metadata.LegacyBootstrapOnly);
            Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, metadata.RollbackMode);
            Assert.Null(metadata.BatchSize);
            Assert.Null(metadata.ResumeTokenName);
            Assert.Null(metadata.ContractAfterFence);
            Assert.Equal(TimeSpan.Zero, metadata.MinimumRetentionWindow);
            Assert.Contains("descriptor_policy", metadata.Validators);
            Assert.Contains("n_minus_one_read_write", metadata.Validators);
        });
        Assert.Equal(OfflineMigrationHistoricalLockRisk.Medium, catalog[ids[0]].EstimatedLockRisk);
        Assert.Equal(OfflineMigrationHistoricalLockRisk.Medium, catalog[ids[1]].EstimatedLockRisk);
        Assert.Equal(OfflineMigrationHistoricalLockRisk.Medium, catalog[ids[2]].EstimatedLockRisk);
    }

    [Fact]
    public void PropertyCommandHistory_IsExplicitExpandThatDeclaresRequiredWriterIsolation()
    {
        string id = ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId;
        OfflineMigrationClassificationFact metadata = OfflineMigrationClassificationFacts.All[id];
        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(
            new Dictionary<string, OfflineMigrationClassificationFact> { [id] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OfflineMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.False(metadata.LegacyBootstrapOnly);
        Assert.Equal(OfflineMigrationHistoricalRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Equal(OfflineMigrationHistoricalLockRisk.Low, metadata.EstimatedLockRisk);
        Assert.Null(metadata.BatchSize);
        Assert.Null(metadata.ResumeTokenName);
        Assert.Null(metadata.ContractAfterFence);
        Assert.Equal(TimeSpan.Zero, metadata.MinimumRetentionWindow);
        Assert.Contains("article_property_definition_history_genesis_fail_closed", metadata.Validators);
        Assert.Contains("article_property_definition_history_signed_audit_binding", metadata.Validators);
        Assert.Contains("article_property_definition_authenticated_forward_replay", metadata.Validators);
        Assert.Contains("article_property_definition_history_write_isolation", metadata.Validators);
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
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Expand,
            destructive: false);

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(new Dictionary<string, OfflineMigrationClassificationFact> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid);
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
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Backfill,
            destructive: false) with
        {
            BatchSize = null,
            ResumeTokenName = null
        };

        OfflineMigrationClassificationFactValidatorReport report = OfflineMigrationClassificationFactValidator.Validate(new Dictionary<string, OfflineMigrationClassificationFact> { [descriptor.MigrationId] = metadata });

        Assert.Contains(report.Violations, violation =>
            violation.Code == "schema_backfill_not_resumable");
    }

    [Fact]
    public void CommandLine_ParsesStableRolloutInterface()
    {
        string[][] retiredInvocations =
        [
            [
                "migrate",
                "--phase", "expand",
                "--release-manifest", "/run/release.json",
                "--env-file", "/run/server.env",
                "--dry-run"
            ],
            [
                "migrate",
                "--phase", "backfill-resume",
                "--id", "20260712-post-example-backfill",
                "--release-manifest", "/run/release.json",
                "--env-file", "/run/server.env"
            ],
            [
                "migrate",
                "--phase", "contract",
                "--release-manifest", "/run/release.json",
                "--env-file", "/run/server.env",
                "--evidence", "/run/contract-evidence.json",
                "--dry-run"
            ]
        ];

        // Keep the historical test identity and exact old intents as refusal
        // controls; only the current Server parser is callable after retirement.
        foreach (string[] invocation in retiredInvocations)
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                ServerCommandLine.Parse(invocation));
            Assert.Equal("server_command_unknown", error.Message);
        }
        ServerCommand serve = ServerCommandLine.Parse(["serve", "--urls", "http://127.0.0.1:5000"]);
        Assert.Equal(ServerCommandKind.Serve, serve.Kind);
        Assert.Equal(new[] { "--urls", "http://127.0.0.1:5000" }, serve.HostArguments);
    }

    [Fact]
    public void CommandLine_RequiresExplicitConfirmationForMutatingContract()
    {
        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse(
            [
                "migrate",
                "--phase", "contract",
                "--evidence", "/run/contract-evidence.json"
            ]));

        Assert.Equal("server_command_unknown", exception.Message);
        InvalidOperationException confirmed = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse(
            [
                "migrate", "--phase", "contract", "--evidence", "/run/contract-evidence.json",
                "--confirm-destructive"
            ]));
        Assert.Equal("server_command_unknown", confirmed.Message);
    }

    [Fact]
    public void ContractGate_RequiresNAndNMinusOneWindowAndOperationalEvidence()
    {
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            "20260701-post-example-contract",
            OfflineMigrationPhase.Contract,
            destructive: true) with
        {
            ContractAfterFence = Coordinate("20260710-contract-fence"),
            MinimumRetentionWindow = TimeSpan.FromDays(7),
            RequiresExclusiveMode = true,
            RollbackMode = OfflineMigrationHistoricalRollbackMode.BackupRestore
        };
        DateTimeOffset now = DateTimeOffset.Parse("2026-07-20T00:00:00Z");
        var incompleteEvidence = new
        {
            CurrentReleaseUsesOldSchema = true,
            PreviousRollbackReleaseUsesOldSchema = true,
            BackfillComplete = false,
            BackfillVerified = false,
            ObservationStartedAtUtc = now.AddDays(-1),
            BackupRestoreVerifiedAtUtc = (DateTimeOffset?)null,
            SlotSwitchInProgress = true,
            DestructiveChangeConfirmed = false,
            RollbackManifestSealed = false,
            OldWritesDisabled = false,
            ExclusiveModeEnabled = false
        };

        OnlineSchemaMigrationCompatibilityTests.AssertHistoricalBytesRejected(JsonSerializer.SerializeToUtf8Bytes(new
        {
            metadata,
            incompleteEvidence,
            currentRelease = Release("20260709000000-111111111111").Value,
            previousRelease = Release("20260708000000-222222222222").Value,
            now,
            maximumBackupAge = TimeSpan.FromHours(24)
        }));
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
                + "SchemaMigration__CurrentReceipt__Path='/run/current-receipt.json'\n");

            IReadOnlyDictionary<string, string?> values = ServerCommandEnvironmentFile.Read(path);

            Assert.Equal(
                "Host=db;Password=$(not-executed)",
                values["ConnectionStrings:DefaultConnection"]);
            Assert.Equal(
                "/run/current-receipt.json",
                values["SchemaMigration:CurrentReceipt:Path"]);
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
                  "schema": "fsusblog.release-manifest.v2",
                  "releaseId": "20260720000000-aaaaaaaaaaaa",
                  "schemaCompatibility": {
                    "minimumCoordinate": "20260719000000-bbbbbbbbbbbb",
                    "maximumCoordinate": "20260720000000-aaaaaaaaaaaa"
                  }
                }
                """);
            // Exact historical bytes cannot authorize current-only startup.
            OnlineSchemaMigrationCompatibilityTests.AssertHistoricalBytesRejected(File.ReadAllBytes(path));
            Assert.Equal("20260719000000-bbbbbbbbbbbb", Release("20260719000000-bbbbbbbbbbbb").Value);
            Assert.NotEqual(Release("20260720000000-aaaaaaaaaaaa"), Release("20260721000000-cccccccccccc"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData("phase")]
    [InlineData("rollback")]
    [InlineData("lock-risk")]
    [InlineData("default-fence")]
    [InlineData("recorded-release")]
    [InlineData("missing-validators")]
    [InlineData("identity")]
    public void HistoricalClassification_RejectsUnknownOrCorruptRecordedFields(string field)
    {
        OfflineMigrationClassificationFact valid = OfflineMigrationClassificationFacts.All.Values.First();
        var positive = new Dictionary<string, OfflineMigrationClassificationFact> { [valid.MigrationId] = valid };
        Assert.True(OfflineMigrationClassificationFactValidator.Validate(positive).Valid);
        OfflineMigrationClassificationFact invalid = field switch
        {
            "phase" => valid with { Phase = (OfflineMigrationPhase)99 },
            "rollback" => valid with { RollbackMode = (OfflineMigrationHistoricalRollbackMode)99 },
            "lock-risk" => valid with { EstimatedLockRisk = (OfflineMigrationHistoricalLockRisk)99 },
            "default-fence" => valid with { MinimumHistoricalFence = default },
            "recorded-release" => valid with
            {
                IntroducedAtFence = HistoricalMigrationFence.FromRecordedValue(
                    Release("20260720000000-aaaaaaaaaaaa").Value,
                    Release("20260720000000-aaaaaaaaaaaa").Value)
            },
            "missing-validators" => valid with { Validators = [] },
            "identity" => valid with { MigrationId = "different-recorded-id" },
            _ => throw new ArgumentException("Unknown corruption control.", nameof(field))
        };
        var corrupted = new Dictionary<string, OfflineMigrationClassificationFact> { [valid.MigrationId] = invalid };

        Assert.False(OfflineMigrationClassificationFactValidator.Validate(corrupted).Valid);
    }

    [Fact]
    public void HistoricalClassification_CatalogAndValidatorCollectionsAreDetachedReadOnly()
    {
        OfflineMigrationClassificationFact valid = OfflineMigrationClassificationFacts.All.Values.First();
        var validators = Assert.IsAssignableFrom<IList<string>>(valid.Validators);
        Assert.True(validators.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => validators[0] = "forged-validator");
        Assert.True(OfflineMigrationClassificationFactValidator.Validate(
            new Dictionary<string, OfflineMigrationClassificationFact> { [valid.MigrationId] = valid }).Valid);
    }

    private static OfflineMigrationClassificationFact CreateMetadata(
        string migrationId,
        OfflineMigrationPhase phase,
        bool destructive)
        => new(
            migrationId,
            phase,
            Coordinate("20260701-release"), Coordinate("20260731-release"),
            RequiresExclusiveMode: false,
            Destructive: destructive,
            RollbackMode: destructive
                ? OfflineMigrationHistoricalRollbackMode.BackupRestore
                : phase == OfflineMigrationPhase.Backfill
                    ? OfflineMigrationHistoricalRollbackMode.ResumeFromCheckpoint
                    : OfflineMigrationHistoricalRollbackMode.CompatibleCode,
            EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
            BatchSize: phase == OfflineMigrationPhase.Backfill ? 100 : null,
            ResumeTokenName: phase == OfflineMigrationPhase.Backfill ? "last_id" : null,
            IntroducedAtFence: Coordinate("20260701-release"),
            ContractAfterFence: phase == OfflineMigrationPhase.Contract ? Coordinate("20260710-contract-fence") : null,
            MinimumRetentionWindow: phase == OfflineMigrationPhase.Contract ? TimeSpan.FromDays(7) : TimeSpan.Zero,
            Validators: ["test-validator"]);
}
