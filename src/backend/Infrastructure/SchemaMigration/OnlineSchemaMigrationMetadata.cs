using System.Collections.ObjectModel;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public enum OnlineSchemaMigrationPhase
{
    Expand = 0,
    Backfill = 1,
    Contract = 2
}

public enum OnlineSchemaMigrationRollbackMode
{
    CompatibleCode = 0,
    ResumeFromCheckpoint = 1,
    BackupRestore = 2
}

public enum OnlineSchemaMigrationLockRisk
{
    Low = 0,
    Medium = 1,
    High = 2,
    FullTableRewrite = 3
}

public sealed record OnlineSchemaCompatibilityWindow(
    SchemaCompatibilityCoordinate MinimumCoordinate,
    SchemaCompatibilityCoordinate MaximumCoordinate)
{
    public bool Contains(SchemaCompatibilityCoordinate coordinate)
        => coordinate.CompareTo(MinimumCoordinate) >= 0
            && coordinate.CompareTo(MaximumCoordinate) <= 0;

    public bool ContainsReleaseId(ReleaseId releaseId)
        => Contains(SchemaCompatibilityCoordinate.FromReleaseId(releaseId));
}

public sealed record OnlineSchemaMigrationMetadata(
    string MigrationId,
    OnlineSchemaMigrationPhase Phase,
    OnlineSchemaCompatibilityWindow Compatibility,
    bool RequiresExclusiveMode,
    bool Destructive,
    OnlineSchemaMigrationRollbackMode RollbackMode,
    OnlineSchemaMigrationLockRisk EstimatedLockRisk,
    int? BatchSize,
    string? ResumeTokenName,
    SchemaCompatibilityCoordinate IntroducedAtCoordinate,
    SchemaCompatibilityCoordinate? ContractAfterCoordinate,
    TimeSpan MinimumRetentionWindow,
    IReadOnlyList<string> Validators,
    bool LegacyBootstrapOnly = false);

public interface IOnlineSchemaMigrationCatalog
{
    IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> GetMetadata();
}

/// <summary>
/// Explicit online-safety classification for every descriptor that predates the
/// Expand/Backfill/Contract protocol. No phase or safety property is inferred
/// from a migration id or from SQL text.
/// </summary>
public sealed class OnlineSchemaMigrationCatalog : IOnlineSchemaMigrationCatalog
{
    private static readonly SchemaCompatibilityCoordinate s_legacyMinimumCoordinate =
        SchemaCompatibilityCoordinate.Minimum;
    private static readonly SchemaCompatibilityCoordinate s_protocolMaximumCoordinate =
        SchemaCompatibilityCoordinate.Maximum;
    private static readonly SchemaCompatibilityCoordinate s_onlineProtocolCoordinate =
        LegacyCoordinate("20260711-online-migration-gate");

    private static readonly IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> s_metadata =
        BuildMetadata();

    public IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> GetMetadata() => s_metadata;

    private static SchemaCompatibilityCoordinate LegacyCoordinate(string value)
        => SchemaCompatibilityCoordinate.FromLegacyMetadata(value);

    private static IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> BuildMetadata()
    {
        // These descriptors were authored for the historical cold-start runner,
        // whose runbook explicitly classifies rollback as non-compensable. They
        // therefore enter the new protocol as guarded Contract work and cannot
        // be selected by an online command until rewritten as a dedicated,
        // resumable descriptor with its own metadata entry.
        string[] explicitlyClassifiedLegacyContracts =
        [
            "20260418-pre-user-session-compat",
            "20260418-pre-comment-threading-compat",
            "20260517-pre-legacy-profile-compat",
            "20260418-post-comment-threading-indexes",
            "20260418-pre-content-compat",
            "20260418-post-content-cleanup",
            "20260418-post-messaging-split",
            "20260620-post-message-account-principal",
            "20260621-post-message-legacy-identity-columns-finalize",
            "20260418-post-user-soft-delete",
            "20260418-post-user-session-finalize",
            "20260625-post-user-session-active-unique",
            "20260602-post-user-auth-security-hardening",
            "20260621-pre-sys-user-security-profile-split",
            "20260621-post-sys-user-security-profile-split-finalize",
            "20260616-pre-admin-principal-plane",
            "20260616-pre-anonymous-identity-account-schema",
            "20260629-pre-admin-account-list-keyset-indexes",
            "20260621-pre-passkey-user-handle",
            "20260621-pre-passkey-recovery-key-account-id",
            "20260615-post-passkey-recovery-key-account-id-compat",
            "20260621-post-user-legacy-identity-columns-finalize",
            "20260621-post-sys-user-username-finalize",
            "20260616-post-account-recovery-key",
            "20260621-post-passkey-recovery-key-account-id-finalize",
            "20260621-pre-anonymous-credential-account-binding",
            "20260615-post-anonymous-credential-account-binding-legacy-compat",
            "20260616-post-anonymous-comment-governance",
            "20260621-post-anonymous-credential-account-binding-finalize",
            "20260618-post-anonymous-credential-issuance-audit",
            "20260618-post-security-risk-event-persistence",
            "20260715-post-security-risk-pseudonym-epoch",
            "20260715-post-blind-credential-issuance-privacy",
            "20260716-post-comment-author-mode-retirement",
            "20260716-post-anonymous-eligibility-predicate",
            "20260619-post-security-policy-snapshot",
            "20260625-post-security-policy-version-counter",
            "20260618-post-anonymous-credential-root-metadata",
            "20260619-post-anonymous-credential-root-lifecycle",
            "20260618-post-security-challenge-persistence",
            "20260617-post-comment-actor-anonymous-default",
            "20260620-pre-comment-actor-codefirst-compat",
            "20260621-post-comment-attribution-index-finalize",
            "20260418-post-audit-log",
            "20260603-post-audit-structured-fields",
            "20260603-pre-audit-structured-fields-codefirst-compat",
            "20260629-post-audit-chain-tail-index",
            "20260603-post-frontend-rum-metric",
            "20260508-pre-cover-image",
            "20260513-post-human-read-events",
            "20260629-post-visit-log-stats-rollup",
            "20260629-post-article-view-projection-watermark",
            "20260629-post-taxonomy-count-projection",
            "20260629-post-author-analytics-rollups",
            "20260621-post-visit-log-anonymous-attribution-finalize",
            "20260621-post-visit-log-ip-anonymization",
            "20260715-pre-visit-log-ip-pseudonym-epoch",
            "20260621-pre-authoring-admin-principal-attribution",
            "20260518-pre-single-author-article-lifecycle",
            "20260518-post-single-author-article-lifecycle-indexes",
            "20260628-post-public-article-list-keyset-indexes",
            "20260618-post-article-mutation-outbox-edge",
            "20260629-post-asset-library-article-ref",
            "20260518-post-authoring-workspace-tables",
            "20260709-post-site-subscription-hmac-finalize",
            "20260709-post-clear-legacy-public-artifacts",
            "20260518-pre-comment-moderation",
            "20260621-pre-comment-moderation-admin-principal-attribution",
            "20260625-post-article-revision-atomic-revision-no",
            "20260704-post-article-publish-proof",
            "20260704-post-article-rights-v3-schema",
            "20260704-post-integrity-transparency-log",
            "20260704-post-integrity-merkle-checkpoint",
            "20260518-post-authoring-draft-lifecycle",
            "20260621-post-authoring-admin-principal-attribution-indexes",
            "20260518-post-comment-moderation-indexes",
            "20260610-post-comment-region-compliance",
            "20260628-post-comment-blocked-region-lookup",
            "20260610-post-comment-moderation-signal",
            "20260629-post-comment-moderation-signal-latest-index",
            "20260603-post-comment-public-hot-path-indexes"
        ];

        var result = new Dictionary<string, OnlineSchemaMigrationMetadata>(StringComparer.Ordinal);
        foreach (string migrationId in explicitlyClassifiedLegacyContracts)
        {
            result.Add(migrationId, CreateLegacyContract(migrationId));
        }

        result.Add(
            "20260716-pre-anonymous-eligibility-predicate",
            new OnlineSchemaMigrationMetadata(
                "20260716-pre-anonymous-eligibility-predicate",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260716-anonymous-eligibility-predicate"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "anonymous_predicate_shadow_read"
                ]));

        result.Add(
            "20260714-post-public-article-projection",
            new OnlineSchemaMigrationMetadata(
                "20260714-post-public-article-projection",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260714-public-article-projection"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "projection_shadow_compare"
                ]));

        result.Add(
            "20260719-pre-article-publication-coordinates",
            new OnlineSchemaMigrationMetadata(
                "20260719-pre-article-publication-coordinates",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-article-publication-coordinates"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_publication_consistency"
                ]));

        result.Add(
            "20260719-post-article-publication-consistency",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-article-publication-consistency",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-article-publication-coordinates"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "article_publication_consistency"
                ]));

        result.Add(
            "20260715-post-article-mutation-outbox-claim-lease",
            new OnlineSchemaMigrationMetadata(
                "20260715-post-article-mutation-outbox-claim-lease",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260715-article-outbox-claim-lease"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_outbox_claim_cas"
                ]));

        result.Add(
            "20260715-post-active-release-fence-durable-witness",
            new OnlineSchemaMigrationMetadata(
                "20260715-post-active-release-fence-durable-witness",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260715-active-release-fence-durable-witness"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "active_release_fence_witness_reconcile"
                ]));

        result.Add(
            "20260715-post-active-release-fenced-commit-ledger",
            new OnlineSchemaMigrationMetadata(
                "20260715-post-active-release-fenced-commit-ledger",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260715-active-release-fenced-commit"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "active_release_fenced_commit_atomicity"
                ]));

        result.Add(
            "20260715-pre-read-event-retirement-compat",
            new OnlineSchemaMigrationMetadata(
                "20260715-pre-read-event-retirement-compat",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260715-read-event-retirement"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "empty_compatibility_table"
                ]));

        result.Add(
            "20260715-post-read-event-retirement",
            new OnlineSchemaMigrationMetadata(
                "20260715-post-read-event-retirement",
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260715-read-event-retirement"),
                ContractAfterCoordinate: LegacyCoordinate("20260715-read-event-retirement-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "destructive_rollback_window_proof",
                    "n_minus_one_read_write",
                    "fresh_backup_restore",
                    "aggregate_only_persistence"
                ]));

        result.Add(
            AccountSubjectHashOnlineBackfillHandler.ExpandMigrationId,
            new OnlineSchemaMigrationMetadata(
                AccountSubjectHashOnlineBackfillHandler.ExpandMigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: s_onlineProtocolCoordinate,
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "nullable_expand_column"
                ]));

        result.Add(
            AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId,
            new OnlineSchemaMigrationMetadata(
                AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId,
                OnlineSchemaMigrationPhase.Backfill,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: AccountSubjectHashBackfillStep.BatchSize,
                ResumeTokenName: "last_account_id",
                IntroducedAtCoordinate: s_onlineProtocolCoordinate,
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "account_subject_hash_consistency",
                    "backfill_resume_progress",
                    "format_constraint_validated"
                ]));

        result.Add(
            "20260711-post-recovery-passkey-completion-idempotency",
            new OnlineSchemaMigrationMetadata(
                "20260711-post-recovery-passkey-completion-idempotency",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: s_onlineProtocolCoordinate,
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            ArticleAssetReferenceMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleAssetReferenceMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-article-asset-reference-ledger"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_asset_reference_recheck"
                ]));

        result.Add(
            "20260719-post-comment-moderation-event",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-comment-moderation-event",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-comment-moderation-event"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260719-post-message-admin-queue-state",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-message-admin-queue-state",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-message-admin-queue-state"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            MessageMutationOutboxMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                MessageMutationOutboxMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-message-mutation-outbox"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "message_outbox_claim_lease"
                ]));

        result.Add(
            MessageMutationIdempotencyMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                MessageMutationIdempotencyMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-message-mutation-idempotency"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "message_mutation_idempotency"
                ]));

        result.Add(
            ConversationStatusAuditMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ConversationStatusAuditMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-conversation-status-audit"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "conversation_status_append_only_audit"
                ]));

        result.Add(
            MessageUnreadAuthorityMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                MessageUnreadAuthorityMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-message-unread-authority"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "message_unread_projection_repair"
                ]));

        result.Add(
            MessagePrivacyRetentionMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                MessagePrivacyRetentionMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-message-privacy-retention"),
                ContractAfterCoordinate: LegacyCoordinate("20260719-message-privacy-retention-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "destructive_rollback_window_proof",
                    "n_minus_one_read_write",
                    "fresh_backup_restore",
                    "message_admin_session_reference_integrity"
                ]));

        result.Add(
            PasskeySignalMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                PasskeySignalMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-passkey-signal-version"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "passkey_signal_snapshot_version"
                ]));

        result.Add(
            ArticleMutationIdempotencyMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleMutationIdempotencyMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-mutation-idempotency"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_mutation_idempotency"
                ]));

        result.Add(
            CommentMutationIdempotencyMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentMutationIdempotencyMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-comment-mutation-idempotency"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_mutation_idempotency"
                ]));

        result.Add(
            ArticleCommentPolicyMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleCommentPolicyMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-thread-comment-policy"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_comment_policy_inheritance",
                    "thread_policy_scope",
                    "privacy_safe_slow_mode"
                ]));

        result.Add(
            CommentRevisionManagementMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentRevisionManagementMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-comment-revision-management"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_revision_initial_backfill",
                    "anonymous_management_capability"
                ]));

        result.Add(
            CommentGovernanceMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentGovernanceMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-comment-report-appeal-timeline"),
                ContractAfterCoordinate: LegacyCoordinate("20260720-comment-report-appeal-timeline-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "destructive_rollback_window_proof",
                    "fresh_backup_restore",
                    "comment_governance_timeline_backfill"
                ]));

        result.Add(
            ScheduledPublishIndexMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ScheduledPublishIndexMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-scheduled-publish-due-index"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "scheduled_publish_query_plan"
                ]));

        result.Add(
            CommentModerationQueueMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentModerationQueueMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-comment-moderation-queue-lease"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_moderation_queue_query_plan",
                    "comment_moderation_claim_cas"
                ]));

        result.Add(
            ArticleDraftBaseRevisionMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleDraftBaseRevisionMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-revision-concurrency"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_draft_base_revision"
                ]));

        result.Add(
            ArticleDraftServerRevisionMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleDraftServerRevisionMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-draft-server-revision"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "mixed_release_draft_write_fence",
                    "article_draft_server_revision_backfill",
                    "article_draft_cas"
                ]));

        result.Add(
            ArticleResponsibilityVersionMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleResponsibilityVersionMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-responsibility-version"),
                ContractAfterCoordinate: LegacyCoordinate("20260720-article-responsibility-version-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "destructive_rollback_window_proof",
                    "fresh_backup_restore",
                    "responsibility_version_backfill",
                    "publication_responsibility_coordinate"
                ]));

        result.Add(
            ArticleMutationOutboxVersionMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleMutationOutboxVersionMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-mutation-outbox-version"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_mutation_outbox_coordinate_backfill",
                    "article_mutation_replay_edges"
                ]));

        result.Add(
            ArticleRevisionContentBlockMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleRevisionContentBlockMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-revision-content-blocks"),
                ContractAfterCoordinate: LegacyCoordinate("20260720-article-revision-content-blocks-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "destructive_rollback_window_proof",
                    "fresh_backup_restore",
                    "article_revision_content_block_backfill",
                    "article_revision_content_reachability",
                    "article_revision_content_orphan_cleanup"
                ]));

        result.Add(
            ArticleRevisionRollbackMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleRevisionRollbackMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-revision-rollback-package"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_revision_rollback_package"
                ]));

        result.Add(
            ArticleTimeSemanticsMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ArticleTimeSemanticsMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-article-time-semantics"),
                ContractAfterCoordinate: LegacyCoordinate("20260720-article-time-semantics-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "destructive_rollback_window_proof",
                    "fresh_backup_restore",
                    "article_time_semantics"
                ]));

        result.Add(
            AccountEnrollmentMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                AccountEnrollmentMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-atomic-account-enrollment"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "account_enrollment_state_machine"
                ]));

        result.Add(
            UserSessionAuthenticationContextMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                UserSessionAuthenticationContextMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-user-session-authentication-context"),
                ContractAfterCoordinate: LegacyCoordinate("20260720-user-session-authentication-context-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "user_session_authentication_context_backfill",
                    "fresh_backup_restore"
                ]));

        result.Add(
            CommentMutationOutboxMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentMutationOutboxMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-comment-mutation-outbox"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_outbox_delivery_checkpoint"
                ]));

        result.Add(
            CommentMutationOutboxClaimLeaseMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentMutationOutboxClaimLeaseMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260726-comment-mutation-outbox-claim-lease"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_outbox_claim_ownership"
                ]));

        result.Add(
            CommentMutationOutboxDeliveryReservationMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CommentMutationOutboxDeliveryReservationMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260727-comment-mutation-outbox-delivery-reservation"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_outbox_delivery_reservation"
                ]));

        result.Add(
            DistributedInvalidationDeliveryLedgerMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                DistributedInvalidationDeliveryLedgerMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260727-distributed-invalidation-delivery-ledger"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "distributed_invalidation_delivery_recovery"
                ]));

        result.Add(
            DistributedInvalidationFullReconcileMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                DistributedInvalidationFullReconcileMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260809-distributed-invalidation-full-reconcile"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "distributed_invalidation_delivery_recovery"
                ]));

        result.Add(
            UserLocalePreferenceMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                UserLocalePreferenceMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260728-user-locale-preference"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "user_locale_preference_constraints"
                ]));

        result.Add(
            DistributedInvalidationConvergenceObligationMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                DistributedInvalidationConvergenceObligationMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260726-distributed-invalidation-convergence-obligation"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "distributed_invalidation_convergence_health"
                ]));

        result.Add(
            UserSessionModeMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                UserSessionModeMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-user-session-mode-authority"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "user_session_mode_authority_backfill"
                ]));

        result.Add(
            UserSessionMetadataMinimizationMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                UserSessionMetadataMinimizationMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-user-session-metadata-minimization"),
                ContractAfterCoordinate: LegacyCoordinate("20260720-user-session-metadata-minimization-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "user_session_raw_metadata_scrubbed",
                    "fresh_backup_restore"
                ]));

        result.Add(
            RefreshTokenLineageMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                RefreshTokenLineageMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260720-user-session-refresh-lineage"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "refresh_lineage_backfill",
                    "refresh_tombstone_retention"
                ]));

        result.Add(
            UserSessionMultiDeviceMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                UserSessionMultiDeviceMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260719-user-session-multi-device"),
                ContractAfterCoordinate: LegacyCoordinate("20260719-user-session-multi-device-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "destructive_rollback_window_proof",
                    "n_minus_one_read_write",
                    "fresh_backup_restore",
                    "multi_device_session_limit"
                ]));

        result.Add(
            PluginRegistryMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                PluginRegistryMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260724-plugin-registry"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            ThemeRegistryMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ThemeRegistryMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260724-theme-registry"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            ThemeActivationRuntimeMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ThemeActivationRuntimeMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260724-theme-runtime"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            CustomizationMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                CustomizationMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260725-customization"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            ContentAssetCutoverMigrationDefinitions.PrototypeShapeMigrationId,
            new OnlineSchemaMigrationMetadata(
                ContentAssetCutoverMigrationDefinitions.PrototypeShapeMigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260826-content-asset-uuid-shape"),
                ContractAfterCoordinate: LegacyCoordinate("20260826-content-asset-id-backfill"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "content_asset_prototype_uuid_conversion",
                    "fresh_backup_restore"
                ]));

        result.Add(
            ContentAssetCutoverMigrationDefinitions.MigrationId,
            new OnlineSchemaMigrationMetadata(
                ContentAssetCutoverMigrationDefinitions.MigrationId,
                OnlineSchemaMigrationPhase.Contract,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260826-content-asset-id-cutover"),
                ContractAfterCoordinate: LegacyCoordinate("20260826-content-asset-id-backfill"),
                MinimumRetentionWindow: TimeSpan.FromDays(DestructiveMigrationProofs.MinimumRollbackWindowDays),
                Validators:
                [
                    "descriptor_policy",
                    "content_asset_files_verified",
                    "content_asset_reference_rebuilt",
                    "fresh_backup_restore"
                ]));

        return new ReadOnlyDictionary<string, OnlineSchemaMigrationMetadata>(result);
    }

    private static OnlineSchemaMigrationMetadata CreateLegacyContract(string migrationId)
        => new(
            migrationId,
            OnlineSchemaMigrationPhase.Contract,
            new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
            RequiresExclusiveMode: true,
            Destructive: true,
            RollbackMode: OnlineSchemaMigrationRollbackMode.BackupRestore,
            EstimatedLockRisk: OnlineSchemaMigrationLockRisk.High,
            BatchSize: null,
            ResumeTokenName: null,
            IntroducedAtCoordinate: s_legacyMinimumCoordinate,
            ContractAfterCoordinate: s_onlineProtocolCoordinate,
            MinimumRetentionWindow: TimeSpan.FromDays(30),
            Validators:
            [
                "legacy_descriptor_checksum",
                "fresh_backup_restore",
                "current_and_previous_release_compatibility",
                "no_slot_switch_in_progress"
            ],
            LegacyBootstrapOnly: true);
}

public sealed record OnlineSchemaMigrationPolicyViolation(
    string Code,
    string? MigrationId,
    string Detail);

public sealed record OnlineSchemaMigrationPolicyReport(
    bool Valid,
    IReadOnlyList<OnlineSchemaMigrationPolicyViolation> Violations);

public static partial class OnlineSchemaMigrationPolicy
{
    private static readonly string[] s_destructiveSqlTokens =
    [
        " DROP COLUMN ",
        " DROP TABLE ",
        " DROP INDEX ",
        " RENAME COLUMN ",
        " RENAME TO ",
        " SET NOT NULL",
        " ALTER COLUMN ",
        " TRUNCATE ",
        " DELETE FROM "
    ];

    public static OnlineSchemaMigrationPolicyReport Validate(
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadata)
    {
        var violations = new List<OnlineSchemaMigrationPolicyViolation>();
        var descriptorIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (ISchemaMigrationDescriptor descriptor in descriptors)
        {
            if (!descriptorIds.Add(descriptor.MigrationId))
            {
                violations.Add(new(
                    "schema_descriptor_duplicate",
                    descriptor.MigrationId,
                    "Migration ids must be unique."));
                continue;
            }

            if (!metadata.TryGetValue(descriptor.MigrationId, out OnlineSchemaMigrationMetadata? classification))
            {
                violations.Add(new(
                    "schema_metadata_missing",
                    descriptor.MigrationId,
                    "Every schema descriptor requires explicit online migration metadata."));
                continue;
            }

            ValidateMetadata(descriptor, classification, violations);
        }

        foreach (string metadataId in metadata.Keys)
        {
            if (!descriptorIds.Contains(metadataId))
            {
                violations.Add(new(
                    "schema_metadata_orphaned",
                    metadataId,
                    "Metadata references a descriptor that is not registered."));
            }
        }

        return new OnlineSchemaMigrationPolicyReport(violations.Count == 0, violations);
    }

    public static bool ContainsDestructiveOperation(ISchemaMigrationDescriptor descriptor)
        => descriptor.Steps.Any(ContainsDestructiveOperation);

    private static void ValidateMetadata(
        ISchemaMigrationDescriptor descriptor,
        OnlineSchemaMigrationMetadata metadata,
        List<OnlineSchemaMigrationPolicyViolation> violations)
    {
        if (!string.Equals(descriptor.MigrationId, metadata.MigrationId, StringComparison.Ordinal))
        {
            violations.Add(new(
                "schema_metadata_id_mismatch",
                descriptor.MigrationId,
                "Descriptor and metadata ids differ."));
        }

        if (metadata.Compatibility.MinimumCoordinate.CompareTo(metadata.Compatibility.MaximumCoordinate) > 0)
        {
            violations.Add(new(
                "schema_compatibility_range_invalid",
                descriptor.MigrationId,
                "Compatibility release range is missing or reversed."));
        }

        bool containsDestructiveOperation = ContainsDestructiveOperation(descriptor);
        if (containsDestructiveOperation
            && (metadata.Phase != OnlineSchemaMigrationPhase.Contract || !metadata.Destructive))
        {
            violations.Add(new(
                "schema_destructive_operation_not_contract",
                descriptor.MigrationId,
                "Drop, rename, tightening, rewrite, truncate, or delete operations must be explicit Contract work."));
        }

        if (metadata.Phase == OnlineSchemaMigrationPhase.Expand
            && (metadata.Destructive
                || metadata.RequiresExclusiveMode
                || metadata.EstimatedLockRisk > OnlineSchemaMigrationLockRisk.Medium
                || metadata.RollbackMode == OnlineSchemaMigrationRollbackMode.BackupRestore))
        {
            violations.Add(new(
                "schema_expand_not_additive",
                descriptor.MigrationId,
                "Expand must remain additive, online, and code-compatible."));
        }

        if (metadata.Phase == OnlineSchemaMigrationPhase.Backfill
            && (metadata.BatchSize is null or <= 0 or > 1000
                || string.IsNullOrWhiteSpace(metadata.ResumeTokenName)
                || metadata.Destructive))
        {
            violations.Add(new(
                "schema_backfill_not_resumable",
                descriptor.MigrationId,
                "Backfill requires a bounded batch size, durable resume token, and non-destructive semantics."));
        }

        if (metadata.Phase == OnlineSchemaMigrationPhase.Contract
            && (metadata.ContractAfterCoordinate is null
                || metadata.MinimumRetentionWindow <= TimeSpan.Zero
                || (metadata.Destructive && metadata.RollbackMode != OnlineSchemaMigrationRollbackMode.BackupRestore)))
        {
            violations.Add(new(
                "schema_contract_gate_incomplete",
                descriptor.MigrationId,
                "Contract requires a release fence, retention window, and backup/restore rollback for destructive work."));
        }

        if (metadata.Validators.Count == 0 || metadata.Validators.Any(string.IsNullOrWhiteSpace))
        {
            violations.Add(new(
                "schema_validator_missing",
                descriptor.MigrationId,
                "At least one named validator/evidence producer is required."));
        }
    }

    private static bool ContainsDestructiveOperation(SchemaMigrationStep step)
    {
        if (step is DropColumnStep or DropTableStep or DropIndexStep or RenameColumnStep or RenameTableStep)
        {
            return true;
        }

        if (step is not RawSqlStep and not BackfillSqlStep and not AssertSqlStep)
        {
            return false;
        }

        string normalized = $" {WhitespaceRegex().Replace(step.Fingerprint, " ").ToUpperInvariant()} ";
        return s_destructiveSqlTokens.Any(normalized.Contains);
    }

    [GeneratedRegex("\\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRegex();
}
