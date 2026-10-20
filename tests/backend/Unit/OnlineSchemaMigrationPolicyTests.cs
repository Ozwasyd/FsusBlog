using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationPolicyTests
{
    private static SchemaCompatibilityCoordinate Coordinate(string value)
        => SchemaCompatibilityCoordinate.ParsePersisted(value);

    private static ReleaseId Release(string value)
        => ReleaseId.Parse(value);

    [Fact]
    public void DistributedInvalidationLedgers_AreExplicitAdditiveExpands()
    {
        ISchemaMigrationDescriptor convergence =
            DistributedInvalidationConvergenceObligationMigrationDefinitions.BuildMigration();
        ISchemaMigrationDescriptor delivery =
            DistributedInvalidationDeliveryLedgerMigrationDefinitions.BuildMigration();
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> catalog =
            new OnlineSchemaMigrationCatalog().GetMetadata();
        var metadata = new Dictionary<string, OnlineSchemaMigrationMetadata>
        {
            [convergence.MigrationId] = catalog[convergence.MigrationId],
            [delivery.MigrationId] = catalog[delivery.MigrationId]
        };

        OnlineSchemaMigrationPolicyReport report =
            OnlineSchemaMigrationPolicy.Validate(metadata);

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.All(metadata.Values, item =>
        {
            Assert.Equal(OnlineSchemaMigrationPhase.Expand, item.Phase);
            Assert.False(item.Destructive);
            Assert.False(item.RequiresExclusiveMode);
            Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, item.RollbackMode);
        });
    }

    [Fact]
    public void RefreshTokenLineage_IsExplicitAdditiveExpand()
    {
        ISchemaMigrationDescriptor descriptor = RefreshTokenLineageMigrationDefinitions.BuildMigration();
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog()
            .GetMetadata()[descriptor.MigrationId];

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(new Dictionary<string, OnlineSchemaMigrationMetadata> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
    }

    [Fact]
    public void UserSessionModeAuthority_IsExplicitAdditiveExpand()
    {
        ISchemaMigrationDescriptor descriptor = UserSessionModeMigrationDefinitions.BuildMigration();
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog()
            .GetMetadata()[descriptor.MigrationId];

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(new Dictionary<string, OnlineSchemaMigrationMetadata> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
    }

    [Fact]
    public void CommentGovernanceMigrations_AreExplicitlyClassified()
    {
        ISchemaMigrationDescriptor revisionDescriptor = CommentRevisionManagementMigrationDefinitions.BuildMigration();
        ISchemaMigrationDescriptor governanceDescriptor = CommentGovernanceMigrationDefinitions.BuildMigration();
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadata =
            new OnlineSchemaMigrationCatalog().GetMetadata();

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [revisionDescriptor.MigrationId] = metadata[revisionDescriptor.MigrationId],
                [governanceDescriptor.MigrationId] = metadata[governanceDescriptor.MigrationId]
            });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));

        OnlineSchemaMigrationMetadata revision = metadata[revisionDescriptor.MigrationId];
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, revision.Phase);
        Assert.False(revision.Destructive);
        Assert.False(revision.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, revision.RollbackMode);

        OnlineSchemaMigrationMetadata governance = metadata[governanceDescriptor.MigrationId];
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, governance.Phase);
        Assert.True(governance.Destructive);
        Assert.True(governance.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.BackupRestore, governance.RollbackMode);
        Assert.NotNull(governance.ContractAfterCoordinate);
        Assert.True(governance.MinimumRetentionWindow > TimeSpan.Zero);
    }

    [Fact]
    public void ArticleCommentPolicy_IsExplicitAdditiveExpand()
    {
        ISchemaMigrationDescriptor descriptor = ArticleCommentPolicyMigrationDefinitions.BuildMigration();
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog()
            .GetMetadata()[descriptor.MigrationId];

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(new Dictionary<string, OnlineSchemaMigrationMetadata> { [descriptor.MigrationId] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Contains("article_comment_policy_inheritance", metadata.Validators);
        Assert.Contains("thread_policy_scope", metadata.Validators);
        Assert.Contains("privacy_safe_slow_mode", metadata.Validators);
    }

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

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(metadata);

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(descriptors.Count, metadata.Count);
        OnlineSchemaMigrationMetadata articleSource =
            metadata[ArticleSourceGenerationMigrationDefinitions.MigrationId];
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articleSource.Phase);
        Assert.False(articleSource.Destructive);
        Assert.False(articleSource.RequiresExclusiveMode);
        Assert.False(articleSource.LegacyBootstrapOnly);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, articleSource.RollbackMode);
        Assert.Equal(new[] { "descriptor_policy", "n_minus_one_read_write" }, articleSource.Validators);
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
        OnlineSchemaMigrationMetadata articleMutationIdempotency =
            metadata[ArticleMutationIdempotencyMigrationDefinitions.MigrationId];
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
        OnlineSchemaMigrationMetadata passkeySignalVersion =
            metadata[PasskeySignalMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata commentMutationIdempotency =
            metadata[CommentMutationIdempotencyMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata scheduledPublishDueIndex =
            metadata[ScheduledPublishIndexMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata articleDraftBaseRevision =
            metadata[ArticleDraftBaseRevisionMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata accountEnrollment =
            metadata[AccountEnrollmentMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata refreshTokenLineage =
            metadata[RefreshTokenLineageMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata userSessionModeAuthority =
            metadata[UserSessionModeMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata userSessionAuthenticationContext =
            metadata[UserSessionAuthenticationContextMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata userSessionMetadataMinimization =
            metadata[UserSessionMetadataMinimizationMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata commentMutationOutbox =
            metadata[CommentMutationOutboxMigrationDefinitions.MigrationId];
        OnlineSchemaMigrationMetadata userSessionMultiDevice =
            metadata[UserSessionMultiDeviceMigrationDefinitions.MigrationId];
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, passkeyExpand.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articleDraftBaseRevision.Phase);
        Assert.False(articleDraftBaseRevision.Destructive);
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
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, articleMutationIdempotency.Phase);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, articleMutationIdempotency.RollbackMode);
        Assert.Equal(OnlineSchemaMigrationLockRisk.Low, articleMutationIdempotency.EstimatedLockRisk);
        Assert.Contains("article_mutation_idempotency", articleMutationIdempotency.Validators);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, commentModerationEvent.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageAdminQueue.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageMutationOutbox.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageMutationIdempotency.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, conversationStatusAudit.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, messageUnreadAuthority.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, passkeySignalVersion.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, commentMutationIdempotency.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, scheduledPublishDueIndex.Phase);
        Assert.Equal(OnlineSchemaMigrationLockRisk.Low, scheduledPublishDueIndex.EstimatedLockRisk);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, scheduledPublishDueIndex.RollbackMode);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, accountEnrollment.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, refreshTokenLineage.Phase);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, refreshTokenLineage.RollbackMode);
        Assert.Contains("refresh_tombstone_retention", refreshTokenLineage.Validators);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, userSessionModeAuthority.Phase);
        Assert.False(userSessionModeAuthority.Destructive);
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, userSessionAuthenticationContext.Phase);
        Assert.True(userSessionAuthenticationContext.Destructive);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.BackupRestore, userSessionAuthenticationContext.RollbackMode);
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, userSessionMetadataMinimization.Phase);
        Assert.True(userSessionMetadataMinimization.Destructive);
        Assert.True(userSessionMetadataMinimization.RequiresExclusiveMode);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.BackupRestore, userSessionMetadataMinimization.RollbackMode);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, commentMutationOutbox.Phase);
        Assert.False(commentMutationOutbox.Destructive);
        Assert.Equal(OnlineSchemaMigrationPhase.Contract, userSessionMultiDevice.Phase);
        Assert.True(userSessionMultiDevice.Destructive);
        Assert.False(userSessionMultiDevice.LegacyBootstrapOnly);
        Assert.Equal(AccountSubjectHashBackfillStep.BatchSize, subjectBackfill.BatchSize);
        Assert.Equal("last_account_id", subjectBackfill.ResumeTokenName);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint, subjectBackfill.RollbackMode);
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
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId,
            ArticleSourceGenerationMigrationDefinitions.MigrationId,
            TaxonomyMutationReceiptMigrationDefinitions.MigrationId,
            UserLocaleMutationReceiptMigrationDefinitions.MigrationId,
            ArticleSourceReceiptOriginsMigrationDefinitions.MigrationId
        };
        Assert.All(metadata.Values.Where(classification =>
            !onlineIds.Contains(classification.MigrationId)), classification =>
        {
            Assert.Equal(OnlineSchemaMigrationPhase.Contract, classification.Phase);
            Assert.True(classification.LegacyBootstrapOnly);
            Assert.True(classification.Destructive);
            Assert.True(classification.RequiresExclusiveMode);
            Assert.Equal(OnlineSchemaMigrationRollbackMode.BackupRestore, classification.RollbackMode);
            Assert.NotNull(classification.ContractAfterCoordinate);
            Assert.True(classification.MinimumRetentionWindow > TimeSpan.Zero);
        });
    }

    [Fact]
    public void ExistingSeptemberAuthorityMigrations_RetainExplicitAdditiveClassifications()
    {
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> catalog = new OnlineSchemaMigrationCatalog().GetMetadata();
        string[] ids =
        [
            BanStateProjectionMigrationDefinitions.MigrationId,
            AdminSessionProjectionMigrationDefinitions.MigrationId,
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId
        ];
        Assert.All(ids, id =>
        {
            OnlineSchemaMigrationMetadata metadata = catalog[id];
            Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
            Assert.False(metadata.Destructive);
            Assert.False(metadata.RequiresExclusiveMode);
            Assert.False(metadata.LegacyBootstrapOnly);
            Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
            Assert.Null(metadata.BatchSize);
            Assert.Null(metadata.ResumeTokenName);
            Assert.Null(metadata.ContractAfterCoordinate);
            Assert.Equal(TimeSpan.Zero, metadata.MinimumRetentionWindow);
            Assert.Contains("descriptor_policy", metadata.Validators);
            Assert.Contains("n_minus_one_read_write", metadata.Validators);
        });
        Assert.Equal(OnlineSchemaMigrationLockRisk.Medium, catalog[ids[0]].EstimatedLockRisk);
        Assert.Equal(OnlineSchemaMigrationLockRisk.Medium, catalog[ids[1]].EstimatedLockRisk);
        Assert.Equal(OnlineSchemaMigrationLockRisk.Medium, catalog[ids[2]].EstimatedLockRisk);
    }

    [Fact]
    public void PropertyCommandHistory_IsExplicitExpandThatDeclaresRequiredWriterIsolation()
    {
        string id = ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId;
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[id];
        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(
            new Dictionary<string, OnlineSchemaMigrationMetadata> { [id] = metadata });

        Assert.True(report.Valid, string.Join(Environment.NewLine, report.Violations));
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
        Assert.False(metadata.LegacyBootstrapOnly);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.Equal(OnlineSchemaMigrationLockRisk.Low, metadata.EstimatedLockRisk);
        Assert.Null(metadata.BatchSize);
        Assert.Null(metadata.ResumeTokenName);
        Assert.Null(metadata.ContractAfterCoordinate);
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
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            destructive: false);

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(new Dictionary<string, OnlineSchemaMigrationMetadata> { [descriptor.MigrationId] = metadata });

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
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Backfill,
            destructive: false) with
        {
            BatchSize = null,
            ResumeTokenName = null
        };

        OnlineSchemaMigrationPolicyReport report = OnlineSchemaMigrationPolicy.Validate(new Dictionary<string, OnlineSchemaMigrationMetadata> { [descriptor.MigrationId] = metadata });

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
            ContractAfterCoordinate = Coordinate("20260710-contract-fence"),
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
            Release("20260709000000-111111111111"),
            Release("20260708000000-222222222222"),
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
                + "FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE=20260719000000-bbbbbbbbbbbb\n");

            IReadOnlyDictionary<string, string?> values = OnlineSchemaMigrationEnvironmentFile.Read(path);

            Assert.Equal(
                "Host=db;Password=$(not-executed)",
                values["ConnectionStrings:DefaultConnection"]);
            Assert.Equal(
                "20260719000000-bbbbbbbbbbbb",
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
                  "schema": "fsusblog.release-manifest.v2",
                  "releaseId": "20260720000000-aaaaaaaaaaaa",
                  "schemaCompatibility": {
                    "minimumCoordinate": "20260719000000-bbbbbbbbbbbb",
                    "maximumCoordinate": "20260720000000-aaaaaaaaaaaa"
                  }
                }
                """);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FSUSBLOG_RELEASE_MANIFEST_PATH"] = path,
                    ["FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE"] = "20260719000000-bbbbbbbbbbbb"
                })
                .Build();
            var provider = new OnlineSchemaReleaseManifestProvider(configuration);

            OnlineSchemaReleaseManifest manifest = provider.Load("20260720000000-aaaaaaaaaaaa");

            Assert.Equal("20260719000000-bbbbbbbbbbbb", manifest.PreviousRollbackReleaseId.Value);
            Assert.Throws<InvalidOperationException>(() => provider.Load("20260721000000-cccccccccccc"));
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
            new OnlineSchemaCompatibilityWindow(Coordinate("20260701-release"), Coordinate("20260731-release")),
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
            IntroducedAtCoordinate: Coordinate("20260701-release"),
            ContractAfterCoordinate: phase == OnlineSchemaMigrationPhase.Contract ? Coordinate("20260710-contract-fence") : null,
            MinimumRetentionWindow: phase == OnlineSchemaMigrationPhase.Contract ? TimeSpan.FromDays(7) : TimeSpan.Zero,
            Validators: ["test-validator"]);
}
