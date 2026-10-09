using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.RegularExpressions;

namespace FsusBlog.Migration;

/// <summary>Historical rollback classification, never a current release recovery selector.</summary>
public enum OfflineMigrationHistoricalRollbackMode
{
    CompatibleCode = 0,
    ResumeFromCheckpoint = 1,
    BackupRestore = 2
}

/// <summary>Recorded descriptor lock risk, not an admission or resource grant.</summary>
public enum OfflineMigrationHistoricalLockRisk
{
    Low = 0,
    Medium = 1,
    High = 2,
    FullTableRewrite = 3
}

/// <summary>Historical scalar and recorded sort key; no deployment identity parser or window admission.</summary>
public readonly record struct HistoricalMigrationFence : IComparable<HistoricalMigrationFence>
{
    public const string MinimumValue = "00000000000000-000000000000";
    public const string MaximumValue = "99999999999999-ffffffffffff";
    public const string LegacyMinimumValue = "00000000-legacy-bootstrap";
    public const string LegacyMaximumValue = "99999999-online-schema-v1";

    private static readonly Regex s_legacyPattern = new(
        "^[0-9]{8}-[a-z0-9][a-z0-9-]{2,119}\\z",
        RegexOptions.CultureInvariant);

    private HistoricalMigrationFence(string value, string sortKey, bool legacy, bool classificationValue)
    {
        Value = value;
        SortKey = sortKey;
        IsLegacy = legacy;
        IsClassificationValue = classificationValue;
    }

    public string Value { get; }

    public string SortKey { get; }

    public bool IsLegacy { get; }

    internal bool IsClassificationValue { get; }

    public static HistoricalMigrationFence Minimum { get; } =
        new(MinimumValue, MinimumValue, legacy: false, classificationValue: true);

    public static HistoricalMigrationFence Maximum { get; } =
        new(MaximumValue, MaximumValue, legacy: false, classificationValue: true);

    /// <summary>Retains the original historical date/suffix normalization only.</summary>
    public static HistoricalMigrationFence FromLegacyMetadata(string value)
    {
        if (string.Equals(value, LegacyMinimumValue, StringComparison.Ordinal))
        {
            return Minimum;
        }
        if (string.Equals(value, LegacyMaximumValue, StringComparison.Ordinal))
        {
            return Maximum;
        }
        if (value is null || !s_legacyPattern.IsMatch(value) || !TryParseLegacyDate(value.AsSpan(0, 8)))
        {
            throw new ArgumentException("Legacy schema compatibility coordinate is invalid.", nameof(value));
        }

        string sortKey = $"{value[..8]}000000-000000000000~legacy~{value[9..]}";
        return new HistoricalMigrationFence(value, sortKey, legacy: true, classificationValue: true);
    }

    /// <summary>
    /// Stores an explicitly recorded release value/key for historical comparisons.
    /// The caller validates deployment identity with its existing owner. This
    /// method does not parse that grammar and its result cannot validate a classification.
    /// </summary>
    public static HistoricalMigrationFence FromRecordedValue(string value, string sortKey)
    {
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim()
            || value.Any(char.IsControl) || !string.Equals(value, sortKey, StringComparison.Ordinal))
        {
            throw new ArgumentException("Recorded historical scalar and sort key must agree.", nameof(value));
        }
        return new HistoricalMigrationFence(value, sortKey, legacy: false, classificationValue: false);
    }

    public int CompareTo(HistoricalMigrationFence other)
        => string.CompareOrdinal(SortKey, other.SortKey);

    public override string ToString() => Value;

    private static bool TryParseLegacyDate(ReadOnlySpan<char> value)
        => DateOnly.TryParseExact(
            value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
}

/// <summary>
/// Complete recorded descriptor classification. The two historical fence scalars
/// are data only, not a ServeCompatibilityWindow or authorization to replay a descriptor.
/// </summary>
public sealed record OfflineMigrationClassificationFact(
    string MigrationId,
    OfflineMigrationPhase Phase,
    HistoricalMigrationFence MinimumHistoricalFence,
    HistoricalMigrationFence MaximumHistoricalFence,
    bool RequiresExclusiveMode,
    bool Destructive,
    OfflineMigrationHistoricalRollbackMode RollbackMode,
    OfflineMigrationHistoricalLockRisk EstimatedLockRisk,
    int? BatchSize,
    string? ResumeTokenName,
    HistoricalMigrationFence IntroducedAtFence,
    HistoricalMigrationFence? ContractAfterFence,
    TimeSpan MinimumRetentionWindow,
    IReadOnlyList<string> Validators,
    bool LegacyBootstrapOnly = false);

/// <summary>The sole hand-maintained historical facts source; the four-field host catalogue is derived.</summary>
public static class OfflineMigrationClassificationFacts
{
    private static readonly HistoricalMigrationFence s_legacyMinimumCoordinate =
        HistoricalMigrationFence.Minimum;
    private static readonly HistoricalMigrationFence s_protocolMaximumCoordinate =
        HistoricalMigrationFence.Maximum;
    private static readonly HistoricalMigrationFence s_onlineProtocolCoordinate =
        LegacyCoordinate("20260711-online-migration-gate");

    private static readonly IReadOnlyDictionary<string, OfflineMigrationClassificationFact> s_metadata =
        BuildMetadata();

    /// <summary>Returns the detached, read-only recorded classifications, not execution permission.</summary>
    public static IReadOnlyDictionary<string, OfflineMigrationClassificationFact> All => s_metadata;

    private static HistoricalMigrationFence LegacyCoordinate(string value)
        => HistoricalMigrationFence.FromLegacyMetadata(value);

    private static IReadOnlyDictionary<string, OfflineMigrationClassificationFact> BuildMetadata()
    {
        // These descriptors were authored for the historical cold-start runner,
        // whose runbook explicitly classifies rollback as non-compensable. They
        // were recorded as guarded Contract work. This catalogue preserves those
        // facts only; it provides neither an online selector nor admission to
        // the current offline plan/apply/verify protocol.
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

        var result = new Dictionary<string, OfflineMigrationClassificationFact>(StringComparer.Ordinal);
        foreach (string migrationId in explicitlyClassifiedLegacyContracts)
        {
            result.Add(migrationId, CreateLegacyContract(migrationId));
        }

        result.Add(
            "20260716-pre-anonymous-eligibility-predicate",
            new OfflineMigrationClassificationFact(
                "20260716-pre-anonymous-eligibility-predicate",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260716-anonymous-eligibility-predicate"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "anonymous_predicate_shadow_read"
                ]));

        result.Add(
            "20260714-post-public-article-projection",
            new OfflineMigrationClassificationFact(
                "20260714-post-public-article-projection",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260714-public-article-projection"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "projection_shadow_compare"
                ]));

        result.Add(
            "20260719-pre-article-publication-coordinates",
            new OfflineMigrationClassificationFact(
                "20260719-pre-article-publication-coordinates",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-article-publication-coordinates"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_publication_consistency"
                ]));

        result.Add(
            "20260719-post-article-publication-consistency",
            new OfflineMigrationClassificationFact(
                "20260719-post-article-publication-consistency",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-article-publication-coordinates"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "article_publication_consistency"
                ]));

        result.Add(
            "20260715-post-article-mutation-outbox-claim-lease",
            new OfflineMigrationClassificationFact(
                "20260715-post-article-mutation-outbox-claim-lease",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260715-article-outbox-claim-lease"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_outbox_claim_cas"
                ]));

        result.Add(
            "20260715-post-active-release-fence-durable-witness",
            new OfflineMigrationClassificationFact(
                "20260715-post-active-release-fence-durable-witness",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260715-active-release-fence-durable-witness"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "active_release_fence_witness_reconcile"
                ]));

        result.Add(
            "20260715-post-active-release-fenced-commit-ledger",
            new OfflineMigrationClassificationFact(
                "20260715-post-active-release-fenced-commit-ledger",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260715-active-release-fenced-commit"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "active_release_fenced_commit_atomicity"
                ]));

        result.Add(
            "20260715-pre-read-event-retirement-compat",
            new OfflineMigrationClassificationFact(
                "20260715-pre-read-event-retirement-compat",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260715-read-event-retirement"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "empty_compatibility_table"
                ]));

        result.Add(
            "20260715-post-read-event-retirement",
            new OfflineMigrationClassificationFact(
                "20260715-post-read-event-retirement",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260715-read-event-retirement"),
                ContractAfterFence: LegacyCoordinate("20260715-read-event-retirement-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260711-pre-account-subject-hash-expand",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: s_onlineProtocolCoordinate,
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "nullable_expand_column"
                ]));

        result.Add(
            "20260711-post-account-subject-hash-backfill",
            new OfflineMigrationClassificationFact(
                "20260711-post-account-subject-hash-backfill",
                OfflineMigrationPhase.Backfill,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.ResumeFromCheckpoint,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: 256,
                ResumeTokenName: "last_account_id",
                IntroducedAtFence: s_onlineProtocolCoordinate,
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "account_subject_hash_consistency",
                    "backfill_resume_progress",
                    "format_constraint_validated"
                ]));

        result.Add(
            "20260711-post-recovery-passkey-completion-idempotency",
            new OfflineMigrationClassificationFact(
                "20260711-post-recovery-passkey-completion-idempotency",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: s_onlineProtocolCoordinate,
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260719-post-article-asset-reference-ledger",
            new OfflineMigrationClassificationFact(
                "20260719-post-article-asset-reference-ledger",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-article-asset-reference-ledger"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_asset_reference_recheck"
                ]));

        result.Add(
            "20260719-post-comment-moderation-event",
            new OfflineMigrationClassificationFact(
                "20260719-post-comment-moderation-event",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-comment-moderation-event"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260719-post-message-admin-queue-state",
            new OfflineMigrationClassificationFact(
                "20260719-post-message-admin-queue-state",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-message-admin-queue-state"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260719-post-message-mutation-outbox",
            new OfflineMigrationClassificationFact(
                "20260719-post-message-mutation-outbox",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-message-mutation-outbox"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "message_outbox_claim_lease"
                ]));

        result.Add(
            "20260719-post-message-mutation-idempotency",
            new OfflineMigrationClassificationFact(
                "20260719-post-message-mutation-idempotency",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-message-mutation-idempotency"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "message_mutation_idempotency"
                ]));

        result.Add(
            "20260719-post-message-status-audit",
            new OfflineMigrationClassificationFact(
                "20260719-post-message-status-audit",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-conversation-status-audit"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "conversation_status_append_only_audit"
                ]));

        result.Add(
            "20260719-post-message-unread-authority",
            new OfflineMigrationClassificationFact(
                "20260719-post-message-unread-authority",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-message-unread-authority"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "message_unread_projection_repair"
                ]));

        result.Add(
            "20260719-post-message-unread-privacy-retention",
            new OfflineMigrationClassificationFact(
                "20260719-post-message-unread-privacy-retention",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-message-privacy-retention"),
                ContractAfterFence: LegacyCoordinate("20260719-message-privacy-retention-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-passkey-signal-version",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-passkey-signal-version"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "passkey_signal_snapshot_version"
                ]));

        result.Add(
            "20260720-post-article-mutation-idempotency",
            new OfflineMigrationClassificationFact(
                "20260720-post-article-mutation-idempotency",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-mutation-idempotency"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_mutation_idempotency"
                ]));

        result.Add(
            "20260720-post-comment-mutation-idempotency",
            new OfflineMigrationClassificationFact(
                "20260720-post-comment-mutation-idempotency",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-comment-mutation-idempotency"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_mutation_idempotency"
                ]));

        result.Add(
            "20260720-post-article-thread-comment-policy",
            new OfflineMigrationClassificationFact(
                "20260720-post-article-thread-comment-policy",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-thread-comment-policy"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-comment-revision-management",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-comment-revision-management"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260720-post-comment-report-appeal-timeline",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-comment-report-appeal-timeline"),
                ContractAfterFence: LegacyCoordinate("20260720-comment-report-appeal-timeline-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260720-post-scheduled-publish-due-index",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-scheduled-publish-due-index"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "scheduled_publish_query_plan"
                ]));

        result.Add(
            "20260720-post-comment-moderation-queue-lease",
            new OfflineMigrationClassificationFact(
                "20260720-post-comment-moderation-queue-lease",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-comment-moderation-queue-lease"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-draft-base-revision",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-revision-concurrency"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_draft_base_revision"
                ]));

        result.Add(
            "20260720-pre-article-draft-server-revision",
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-draft-server-revision",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-draft-server-revision"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-responsibility-version",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-responsibility-version"),
                ContractAfterFence: LegacyCoordinate("20260720-article-responsibility-version-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-mutation-outbox-version",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-mutation-outbox-version"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-revision-content-blocks",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-revision-content-blocks"),
                ContractAfterFence: LegacyCoordinate("20260720-article-revision-content-blocks-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-revision-rollback-package",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-revision-rollback-package"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "article_revision_rollback_package"
                ]));

        result.Add(
            "20260720-pre-article-time-semantics",
            new OfflineMigrationClassificationFact(
                "20260720-pre-article-time-semantics",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-article-time-semantics"),
                ContractAfterFence: LegacyCoordinate("20260720-article-time-semantics-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260720-pre-atomic-account-enrollment",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-atomic-account-enrollment"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "account_enrollment_state_machine"
                ]));

        result.Add(
            "20260720-pre-user-session-authentication-context",
            new OfflineMigrationClassificationFact(
                "20260720-pre-user-session-authentication-context",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-user-session-authentication-context"),
                ContractAfterFence: LegacyCoordinate("20260720-user-session-authentication-context-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260720-post-comment-mutation-outbox",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-comment-mutation-outbox"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_outbox_delivery_checkpoint"
                ]));

        result.Add(
            "20260726-post-comment-mutation-outbox-claim-lease",
            new OfflineMigrationClassificationFact(
                "20260726-post-comment-mutation-outbox-claim-lease",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260726-comment-mutation-outbox-claim-lease"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_outbox_claim_ownership"
                ]));

        result.Add(
            "20260727-post-comment-mutation-outbox-delivery-reservation",
            new OfflineMigrationClassificationFact(
                "20260727-post-comment-mutation-outbox-delivery-reservation",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260727-comment-mutation-outbox-delivery-reservation"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "comment_outbox_delivery_reservation"
                ]));

        result.Add(
            "20260727-post-distributed-invalidation-delivery-ledger",
            new OfflineMigrationClassificationFact(
                "20260727-post-distributed-invalidation-delivery-ledger",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260727-distributed-invalidation-delivery-ledger"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "distributed_invalidation_delivery_recovery"
                ]));

        result.Add(
            "20260809-post-distributed-invalidation-full-reconcile",
            new OfflineMigrationClassificationFact(
                "20260809-post-distributed-invalidation-full-reconcile",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260809-distributed-invalidation-full-reconcile"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "distributed_invalidation_delivery_recovery"
                ]));

        result.Add(
            "20260728-post-user-locale-preference",
            new OfflineMigrationClassificationFact(
                "20260728-post-user-locale-preference",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260728-user-locale-preference"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "user_locale_preference_constraints"
                ]));

        result.Add(
            "20260726-post-distributed-invalidation-convergence-obligation",
            new OfflineMigrationClassificationFact(
                "20260726-post-distributed-invalidation-convergence-obligation",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260726-distributed-invalidation-convergence-obligation"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "distributed_invalidation_convergence_health"
                ]));

        result.Add(
            "20260720-pre-user-session-mode-authority",
            new OfflineMigrationClassificationFact(
                "20260720-pre-user-session-mode-authority",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-user-session-mode-authority"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "user_session_mode_authority_backfill"
                ]));

        result.Add(
            "20260720-pre-user-session-metadata-minimization",
            new OfflineMigrationClassificationFact(
                "20260720-pre-user-session-metadata-minimization",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-user-session-metadata-minimization"),
                ContractAfterFence: LegacyCoordinate("20260720-user-session-metadata-minimization-expand"),
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "user_session_raw_metadata_scrubbed",
                    "fresh_backup_restore"
                ]));

        result.Add(
            "20260720-pre-user-session-refresh-lineage",
            new OfflineMigrationClassificationFact(
                "20260720-pre-user-session-refresh-lineage",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260720-user-session-refresh-lineage"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260719-post-user-session-multi-device",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260719-user-session-multi-device"),
                ContractAfterFence: LegacyCoordinate("20260719-user-session-multi-device-expand"),
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
            new OfflineMigrationClassificationFact(
                "20260724-post-plugin-registry",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260724-plugin-registry"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260724-post-theme-registry",
            new OfflineMigrationClassificationFact(
                "20260724-post-theme-registry",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260724-theme-registry"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260724-post-theme-runtime",
            new OfflineMigrationClassificationFact(
                "20260724-post-theme-runtime",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260724-theme-runtime"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260725-post-customization",
            new OfflineMigrationClassificationFact(
                "20260725-post-customization",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260725-customization"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write"
                ]));

        result.Add(
            "20260826-pre-content-asset-uuid-shape",
            new OfflineMigrationClassificationFact(
                "20260826-pre-content-asset-uuid-shape",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260826-content-asset-uuid-shape"),
                ContractAfterFence: LegacyCoordinate("20260826-content-asset-id-backfill"),
                MinimumRetentionWindow: TimeSpan.FromDays(30),
                Validators:
                [
                    "descriptor_policy",
                    "content_asset_prototype_uuid_conversion",
                    "fresh_backup_restore"
                ]));

        result.Add(
            "20260826-post-content-asset-id-cutover",
            new OfflineMigrationClassificationFact(
                "20260826-post-content-asset-id-cutover",
                OfflineMigrationPhase.Contract,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: true,
                Destructive: true,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.High,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260826-content-asset-id-cutover"),
                ContractAfterFence: LegacyCoordinate("20260826-content-asset-id-backfill"),
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
            new OfflineMigrationClassificationFact(
                "20260828-post-authoring-canvas-document",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260828-authoring-canvas-document"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260829-post-taxonomy-descriptions",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260829-taxonomy-descriptions"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260904-post-author-saved-view",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260904-author-saved-view"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260904-post-author-article-pins",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260904-author-article-pins"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260905-post-article-template-authority",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260905-article-template-authority"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260906-post-authoring-canvas-operation-journal",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260906-authoring-canvas-operation-journal"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260907-post-article-vault-execution",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260907-article-vault-execution"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260908-post-article-create-authority",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260908-article-create-authority"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260913-pre-ban-state-generation",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260913-ban-state-projection"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260913-post-admin-session-validation-projection",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260913-admin-session-projection"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260915-post-author-recent-history",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260915-author-recent-history"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20260915-post-article-property-definition-authority",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Medium,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20260915-article-property-definition-authority"),
                ContractAfterFence: null,
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
            new OfflineMigrationClassificationFact(
                "20261002-post-article-property-definition-command-history",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20261002-article-property-definition-command-history"),
                ContractAfterFence: null,
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

        result.Add(
            "20261006-post-article-canvas-link-history",
            new OfflineMigrationClassificationFact(
                "20261006-post-article-canvas-link-history",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20261006-article-canvas-links"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators: ["descriptor_policy", "n_minus_one_read_write", "article_canvas_link_owner_site_scope",
                    "article_canvas_link_canonical_cas", "article_canvas_link_revision_history", "article_canvas_link_receipt_integrity"]));

        result.Add(
            "20261008-post-article-property-value-snapshots",
            new OfflineMigrationClassificationFact(
                "20261008-post-article-property-value-snapshots",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20261008-article-property-values"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators: ["descriptor_policy", "n_minus_one_read_write", "article_property_value_closed_storage",
                    "article_property_value_canonical_cas", "article_property_value_immutable_snapshots",
                    "article_property_value_signed_audit_binding"]));

        result.Add(
            "20261008-post-authoring-workspace-snapshot",
            new OfflineMigrationClassificationFact(
                "20261008-post-authoring-workspace-snapshot",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20261008-authoring-workspace-snapshot"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators: ["descriptor_policy", "n_minus_one_read_write", "authoring_workspace_snapshot_closed_storage",
                    "authoring_workspace_snapshot_owner_site_default", "authoring_workspace_snapshot_canonical_cas",
                    "authoring_workspace_snapshot_bounded_bytes"]));

        result.Add(
            "20261008-post-writing-aid-preferences",
            new OfflineMigrationClassificationFact(
                "20261008-post-writing-aid-preferences",
                OfflineMigrationPhase.Expand,
                s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
                RequiresExclusiveMode: false,
                Destructive: false,
                RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
                EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
                BatchSize: null,
                ResumeTokenName: null,
                IntroducedAtFence: LegacyCoordinate("20261008-writing-aid-preferences"),
                ContractAfterFence: null,
                MinimumRetentionWindow: TimeSpan.Zero,
                Validators:
                [
                    "descriptor_policy",
                    "n_minus_one_read_write",
                    "authoring_preference_owner_site_isolation",
                    "authoring_preference_shared_revision_cas",
                    "authoring_preference_operation_replay",
                    "writing_aid_independent_boolean_schema"
                ]));

        foreach (string id in result.Keys.ToArray())
        {
            result[id] = result[id] with
            {
                Validators = Array.AsReadOnly(result[id].Validators.ToArray())
            };
        }
        return new ReadOnlyDictionary<string, OfflineMigrationClassificationFact>(result);
    }

    private static OfflineMigrationClassificationFact CreateLegacyContract(string migrationId)
        => new(
            migrationId,
            OfflineMigrationPhase.Contract,
            s_legacyMinimumCoordinate, s_protocolMaximumCoordinate,
            RequiresExclusiveMode: true,
            Destructive: true,
            RollbackMode: OfflineMigrationHistoricalRollbackMode.BackupRestore,
            EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.High,
            BatchSize: null,
            ResumeTokenName: null,
            IntroducedAtFence: s_legacyMinimumCoordinate,
            ContractAfterFence: s_onlineProtocolCoordinate,
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

/// <summary>A corrupt or incomplete recorded classification field.</summary>
public sealed record OfflineMigrationClassificationFactValidatorViolation(
    string Code,
    string? MigrationId,
    string Detail);

/// <summary>Data validation only; no database observation or current admission.</summary>
public sealed record OfflineMigrationClassificationFactValidatorReport(
    bool Valid,
    IReadOnlyList<OfflineMigrationClassificationFactValidatorViolation> Violations);

/// <summary>Checks the historical fact shape without selecting or executing migration work.</summary>
public static class OfflineMigrationClassificationFactValidator
{
    /// <summary>Rejects unknown recorded identities, fields and incomplete classifications.</summary>
    public static OfflineMigrationClassificationFactValidatorReport Validate(
        IReadOnlyDictionary<string, OfflineMigrationClassificationFact> metadata)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        var violations = new List<OfflineMigrationClassificationFactValidatorViolation>();
        foreach ((string id, OfflineMigrationClassificationFact classification) in metadata)
        {
            if (classification is null || string.IsNullOrWhiteSpace(id)
                || id != id.Trim() || id.Any(char.IsControl) || id != classification.MigrationId)
            {
                violations.Add(new("schema_classification_identity_invalid", id, "Recorded classification identity does not match its key."));
                continue;
            }
            ValidateMetadata(classification, violations);
        }

        return new OfflineMigrationClassificationFactValidatorReport(violations.Count == 0, violations);
    }

    private static void ValidateMetadata(
        OfflineMigrationClassificationFact metadata,
        List<OfflineMigrationClassificationFactValidatorViolation> violations)
    {
        if (!Enum.IsDefined(metadata.Phase) || !Enum.IsDefined(metadata.RollbackMode)
            || !Enum.IsDefined(metadata.EstimatedLockRisk)
            || !metadata.MinimumHistoricalFence.IsClassificationValue
            || !metadata.MaximumHistoricalFence.IsClassificationValue
            || !metadata.IntroducedAtFence.IsClassificationValue
            || (metadata.ContractAfterFence is { } after && !after.IsClassificationValue))
        {
            violations.Add(new("schema_classification_shape_invalid", metadata.MigrationId, "Historical classification fields are unknown or incomplete."));
        }

        if (metadata.MinimumHistoricalFence.CompareTo(metadata.MaximumHistoricalFence) > 0)
        {
            violations.Add(new(
                "schema_compatibility_range_invalid",
                metadata.MigrationId,
                "Compatibility release range is missing or reversed."));
        }

        if (metadata.Phase == OfflineMigrationPhase.Expand
            && (metadata.Destructive
                || metadata.RequiresExclusiveMode
                || metadata.EstimatedLockRisk > OfflineMigrationHistoricalLockRisk.Medium
                || metadata.RollbackMode == OfflineMigrationHistoricalRollbackMode.BackupRestore))
        {
            violations.Add(new(
                "schema_expand_not_additive",
                metadata.MigrationId,
                "Expand must remain additive, online, and code-compatible."));
        }

        if (metadata.Phase == OfflineMigrationPhase.Backfill
            && (metadata.BatchSize is null or <= 0 or > 1000
                || string.IsNullOrWhiteSpace(metadata.ResumeTokenName)
                || metadata.Destructive))
        {
            violations.Add(new(
                "schema_backfill_not_resumable",
                metadata.MigrationId,
                "Backfill requires a bounded batch size, durable resume token, and non-destructive semantics."));
        }

        if (metadata.Phase == OfflineMigrationPhase.Contract
            && (metadata.ContractAfterFence is null
                || metadata.MinimumRetentionWindow <= TimeSpan.Zero
                || (metadata.Destructive && metadata.RollbackMode != OfflineMigrationHistoricalRollbackMode.BackupRestore)))
        {
            violations.Add(new(
                "schema_contract_gate_incomplete",
                metadata.MigrationId,
                "Contract requires a release fence, retention window, and backup/restore rollback for destructive work."));
        }

        if (metadata.Validators is null || metadata.Validators.Count == 0 || metadata.Validators.Any(string.IsNullOrWhiteSpace))
        {
            violations.Add(new(
                "schema_validator_missing",
                metadata.MigrationId,
                "At least one named validator/evidence producer is required."));
        }
    }
}
