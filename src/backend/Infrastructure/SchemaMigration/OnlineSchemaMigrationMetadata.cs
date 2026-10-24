using System.Collections.ObjectModel;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Operations;

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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "destructive_rollback_window_proof",
                    "n_minus_one_read_write",
                    "fresh_backup_restore",
                    "aggregate_only_persistence"
                ]));

        result.Add(
            "20260711-pre-account-subject-hash-expand",
            new OnlineSchemaMigrationMetadata(
                "20260711-pre-account-subject-hash-expand",
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
            "20260711-post-account-subject-hash-backfill",
            new OnlineSchemaMigrationMetadata(
                "20260711-post-account-subject-hash-backfill",
                OnlineSchemaMigrationPhase.Backfill,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: 256,
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
            "20260719-post-article-asset-reference-ledger",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-article-asset-reference-ledger",
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
            "20260719-post-message-mutation-outbox",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-message-mutation-outbox",
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
            "20260719-post-message-mutation-idempotency",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-message-mutation-idempotency",
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
            "20260719-post-message-status-audit",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-message-status-audit",
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
            "20260719-post-message-unread-authority",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-message-unread-authority",
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
            "20260719-post-message-unread-privacy-retention",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-message-unread-privacy-retention",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "destructive_rollback_window_proof",
                    "n_minus_one_read_write",
                    "fresh_backup_restore",
                    "message_admin_session_reference_integrity"
                ]));

        result.Add(
            "20260720-pre-passkey-signal-version",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-passkey-signal-version",
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
            "20260720-post-article-mutation-idempotency",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-article-mutation-idempotency",
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
            "20260720-post-comment-mutation-idempotency",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-comment-mutation-idempotency",
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
            "20260720-post-article-thread-comment-policy",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-article-thread-comment-policy",
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
            "20260720-pre-comment-revision-management",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-comment-revision-management",
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
            "20260720-post-comment-report-appeal-timeline",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-comment-report-appeal-timeline",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "destructive_rollback_window_proof",
                    "fresh_backup_restore",
                    "comment_governance_timeline_backfill"
                ]));

        result.Add(
            "20260720-post-scheduled-publish-due-index",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-scheduled-publish-due-index",
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
            "20260720-post-comment-moderation-queue-lease",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-comment-moderation-queue-lease",
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
            "20260720-pre-article-draft-base-revision",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-draft-base-revision",
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
            "20260720-pre-article-draft-server-revision",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-draft-server-revision",
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
            "20260720-pre-article-responsibility-version",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-responsibility-version",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
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
            "20260720-pre-article-mutation-outbox-version",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-mutation-outbox-version",
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
            "20260720-pre-article-revision-content-blocks",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-revision-content-blocks",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
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
            "20260720-pre-article-revision-rollback-package",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-revision-rollback-package",
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
            "20260720-pre-article-time-semantics",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-article-time-semantics",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "destructive_rollback_window_proof",
                    "fresh_backup_restore",
                    "article_time_semantics"
                ]));

        result.Add(
            "20260720-pre-atomic-account-enrollment",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-atomic-account-enrollment",
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
            "20260720-pre-user-session-authentication-context",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-user-session-authentication-context",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "user_session_authentication_context_backfill",
                    "fresh_backup_restore"
                ]));

        result.Add(
            "20260720-post-comment-mutation-outbox",
            new OnlineSchemaMigrationMetadata(
                "20260720-post-comment-mutation-outbox",
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
            "20260726-post-comment-mutation-outbox-claim-lease",
            new OnlineSchemaMigrationMetadata(
                "20260726-post-comment-mutation-outbox-claim-lease",
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
            "20260727-post-comment-mutation-outbox-delivery-reservation",
            new OnlineSchemaMigrationMetadata(
                "20260727-post-comment-mutation-outbox-delivery-reservation",
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
            "20260727-post-distributed-invalidation-delivery-ledger",
            new OnlineSchemaMigrationMetadata(
                "20260727-post-distributed-invalidation-delivery-ledger",
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
            "20260809-post-distributed-invalidation-full-reconcile",
            new OnlineSchemaMigrationMetadata(
                "20260809-post-distributed-invalidation-full-reconcile",
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
            "20260728-post-user-locale-preference",
            new OnlineSchemaMigrationMetadata(
                "20260728-post-user-locale-preference",
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
            "20260726-post-distributed-invalidation-convergence-obligation",
            new OnlineSchemaMigrationMetadata(
                "20260726-post-distributed-invalidation-convergence-obligation",
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
            "20260720-pre-user-session-mode-authority",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-user-session-mode-authority",
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
            "20260720-pre-user-session-metadata-minimization",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-user-session-metadata-minimization",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "user_session_raw_metadata_scrubbed",
                    "fresh_backup_restore"
                ]));

        result.Add(
            "20260720-pre-user-session-refresh-lineage",
            new OnlineSchemaMigrationMetadata(
                "20260720-pre-user-session-refresh-lineage",
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
            "20260719-post-user-session-multi-device",
            new OnlineSchemaMigrationMetadata(
                "20260719-post-user-session-multi-device",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "destructive_rollback_window_proof",
                    "n_minus_one_read_write",
                    "fresh_backup_restore",
                    "multi_device_session_limit"
                ]));

        result.Add(
            "20260724-post-plugin-registry",
            new OnlineSchemaMigrationMetadata(
                "20260724-post-plugin-registry",
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
            "20260724-post-theme-registry",
            new OnlineSchemaMigrationMetadata(
                "20260724-post-theme-registry",
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
            "20260724-post-theme-runtime",
            new OnlineSchemaMigrationMetadata(
                "20260724-post-theme-runtime",
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
            "20260725-post-customization",
            new OnlineSchemaMigrationMetadata(
                "20260725-post-customization",
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
            "20260826-pre-content-asset-uuid-shape",
            new OnlineSchemaMigrationMetadata(
                "20260826-pre-content-asset-uuid-shape",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "content_asset_prototype_uuid_conversion",
                    "fresh_backup_restore"
                ]));

        result.Add(
            "20260826-post-content-asset-id-cutover",
            new OnlineSchemaMigrationMetadata(
                "20260826-post-content-asset-id-cutover",
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
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "content_asset_files_verified",
                    "content_asset_reference_rebuilt",
                    "fresh_backup_restore"
                ]));

        result.Add(
            "20260828-post-authoring-canvas-document",
            new OnlineSchemaMigrationMetadata(
                "20260828-post-authoring-canvas-document",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260828-authoring-canvas-document"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "authoring_canvas_closed_schema",
                    "authoring_canvas_owner_scope"
                ]));

        result.Add(
            "20260829-post-taxonomy-descriptions",
            new OnlineSchemaMigrationMetadata(
                "20260829-post-taxonomy-descriptions",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260829-taxonomy-descriptions"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "taxonomy_description_persistence",
                    "taxonomy_list_wire_compatibility"
                ]));

        result.Add(
            "20260904-post-author-saved-view",
            new OnlineSchemaMigrationMetadata(
                "20260904-post-author-saved-view",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260904-author-saved-view"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "author_saved_view_closed_schema",
                    "author_saved_view_owner_scope",
                    "author_saved_view_cas_idempotency"
                ]));

        result.Add(
            "20260904-post-author-article-pins",
            new OnlineSchemaMigrationMetadata(
                "20260904-post-author-article-pins",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260904-author-article-pins"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "author_article_pin_closed_schema",
                    "author_article_pin_owner_scope"
                ]));

        result.Add(
            "20260905-post-article-template-authority",
            new OnlineSchemaMigrationMetadata(
                "20260905-post-article-template-authority",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260905-article-template-authority"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_template_closed_schema",
                    "article_template_immutable_versions",
                    "article_template_audit_link_atomicity"
                ]));

        result.Add(
            "20260906-post-authoring-canvas-operation-journal",
            new OnlineSchemaMigrationMetadata(
                "20260906-post-authoring-canvas-operation-journal",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260906-authoring-canvas-operation-journal"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "authoring_canvas_operation_closed_schema",
                    "authoring_canvas_document_receipt_integrity",
                    "authoring_canvas_owner_scope"
                ]));

        result.Add(
            "20260907-post-article-vault-execution",
            new OnlineSchemaMigrationMetadata(
                "20260907-post-article-vault-execution",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260907-article-vault-execution"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_vault_sealed_bundle",
                    "article_vault_group_idempotency",
                    "article_vault_result_receipt"
                ]));

        result.Add(
            "20260908-post-article-create-authority",
            new OnlineSchemaMigrationMetadata(
                "20260908-post-article-create-authority",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260908-article-create-authority"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_create_exact_once",
                    "article_create_draft_only",
                    "article_create_receipt_audit_closure"
                ]));

        result.Add(
            "20260913-pre-ban-state-generation",
            new OnlineSchemaMigrationMetadata(
                "20260913-pre-ban-state-generation",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260913-ban-state-projection"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "ban_state_generation_monotonic",
                    "ban_state_projection_convergence"
                ]));

        result.Add(
            "20260913-post-admin-session-validation-projection",
            new OnlineSchemaMigrationMetadata(
                "20260913-post-admin-session-validation-projection",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260913-admin-session-projection"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "admin_session_validation_version_monotonic",
                    "admin_session_projection_convergence"
                ]));

        result.Add(
            "20260915-post-author-recent-history",
            new OnlineSchemaMigrationMetadata(
                "20260915-post-author-recent-history",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260915-author-recent-history"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "author_recent_history_closed_schema",
                    "author_recent_history_owner_site_scope",
                    "author_recent_history_cas_idempotency",
                    "author_recent_history_receipt_outbox_audit"
                ]));

        result.Add(
            "20260915-post-article-property-definition-authority",
            new OnlineSchemaMigrationMetadata(
                "20260915-post-article-property-definition-authority",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20260915-article-property-definition-authority"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_property_definition_closed_schema",
                    "article_property_definition_owner_scope",
                    "article_property_definition_cas_idempotency",
                    "article_property_definition_receipt_audit_integrity"
                ]));

        // CompatibleCode describes additive DDL only; old writers must remain isolated from history writes.
        result.Add(
            "20261002-post-article-property-definition-command-history",
            new OnlineSchemaMigrationMetadata(
                "20261002-post-article-property-definition-command-history",
                OnlineSchemaMigrationPhase.Expand,
                new OnlineSchemaCompatibilityWindow(s_legacyMinimumCoordinate, s_protocolMaximumCoordinate),
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
                EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtCoordinate: LegacyCoordinate("20261002-article-property-definition-command-history"),
                ContractAfterCoordinate: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_property_definition_command_history_closed_schema",
                    "article_property_definition_history_genesis_fail_closed",
                    "article_property_definition_history_signed_audit_binding",
                    "article_property_definition_authenticated_forward_replay",
                    "article_property_definition_history_write_isolation"
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

public static class OnlineSchemaMigrationPolicy
{
    public static OnlineSchemaMigrationPolicyReport Validate(
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadata)
    {
        var violations = new List<OnlineSchemaMigrationPolicyViolation>();
        foreach (OnlineSchemaMigrationMetadata classification in metadata.Values)
        {
            ValidateMetadata(classification, violations);
        }

        return new OnlineSchemaMigrationPolicyReport(violations.Count == 0, violations);
    }

    private static void ValidateMetadata(
        OnlineSchemaMigrationMetadata metadata,
        List<OnlineSchemaMigrationPolicyViolation> violations)
    {
        if (metadata.Compatibility.MinimumCoordinate.CompareTo(metadata.Compatibility.MaximumCoordinate) > 0)
        {
            violations.Add(new(
                "schema_compatibility_range_invalid",
                metadata.MigrationId,
                "Compatibility release range is missing or reversed."));
        }

        if (metadata.Phase == OnlineSchemaMigrationPhase.Expand
            && (metadata.Destructive
                || metadata.RequiresExclusiveMode
                || metadata.EstimatedLockRisk > OnlineSchemaMigrationLockRisk.Medium
                || metadata.RollbackMode == OnlineSchemaMigrationRollbackMode.BackupRestore))
        {
            violations.Add(new(
                "schema_expand_not_additive",
                metadata.MigrationId,
                "Expand must remain additive, online, and code-compatible."));
        }

        if (metadata.Phase == OnlineSchemaMigrationPhase.Backfill
            && (metadata.BatchSize is null or <= 0 or > 1000
                || string.IsNullOrWhiteSpace(metadata.ResumeTokenName)
                || metadata.Destructive))
        {
            violations.Add(new(
                "schema_backfill_not_resumable",
                metadata.MigrationId,
                "Backfill requires a bounded batch size, durable resume token, and non-destructive semantics."));
        }

        if (metadata.Phase == OnlineSchemaMigrationPhase.Contract
            && (metadata.ContractAfterCoordinate is null
                || metadata.MinimumRetentionWindow <= TimeSpan.Zero
                || (metadata.Destructive && metadata.RollbackMode != OnlineSchemaMigrationRollbackMode.BackupRestore)))
        {
            violations.Add(new(
                "schema_contract_gate_incomplete",
                metadata.MigrationId,
                "Contract requires a release fence, retention window, and backup/restore rollback for destructive work."));
        }

        if (metadata.Validators.Count == 0 || metadata.Validators.Any(string.IsNullOrWhiteSpace))
        {
            violations.Add(new(
                "schema_validator_missing",
                metadata.MigrationId,
                "At least one named validator/evidence producer is required."));
        }
    }
}
