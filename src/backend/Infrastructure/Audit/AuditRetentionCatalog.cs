using System.Reflection;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed record AuditRetentionPolicy(
    string Action,
    TimeSpan MaxFullRecordAge,
    TimeSpan MaxPseudonymAge,
    TimeSpan AggregateAfter,
    bool AnchorForever,
    bool LegalHoldAllowed,
    string CryptographicEraseKeyDomain);

public static class AuditRetentionCatalog
{
    private static readonly TimeSpan s_defaultFullAge = TimeSpan.FromDays(90);
    private static readonly TimeSpan s_defaultPseudonymAge = TimeSpan.FromDays(90);
    private static readonly TimeSpan s_defaultAggregateAfter = TimeSpan.FromDays(90);

    private static readonly string[] s_runtimeActions =
    [
        AuditActionCatalog.LogRecorded,
        AuditActionCatalog.UserStatusChanged,
        AuditActionCatalog.AnonymousAccountStatusChanged,
        AuditActionCatalog.CommentModerated,
        AuditActionCatalog.CommentBulkModerated,
        AuditActionCatalog.AnonymousCommentPolicyUpdated,
        AuditActionCatalog.AnonymousGovernanceStatusRead,
        AuditActionCatalog.AnonymousGovernanceNullifiersRead,
        AuditActionCatalog.AnonymousNullifierBlocked,
        AuditActionCatalog.AnonymousCredentialRevoked,
        AuditActionCatalog.AnonymousCredentialIssued,
        AuditActionCatalog.AnonymousCredentialRootRotated,
        AuditActionCatalog.SecurityPolicyActivated,
        AuditActionCatalog.SecurityPolicyRolledBack,
        AuditActionCatalog.ContentExported,
        AuditActionCatalog.ArticleExported,
        AuditActionCatalog.ArticleImported,
        AuditActionCatalog.ArticleTrashCleared,
        AuditActionCatalog.AuditQueried,
        AuditActionCatalog.AuthSelfServicePrincipalRejected,
        AuditActionCatalog.PasskeyCounterRollback,
        AuditActionCatalog.MfaChallengeFailed,
        AuditActionCatalog.MfaChallengeLocked,
        AuditActionCatalog.ModerationDictionaryLoaded,
        AuditActionCatalog.ModerationRegionPolicyLoaded,
        AuditActionCatalog.PublicAotCache,
        "account.delete",
        "admin.bootstrap.completed",
        "admin.bootstrap.passkey_failed",
        "admin.cache.action_executed",
        "admin.cache.diagnostics_viewed",
        "admin.comment.batch",
        "admin.integrity.checked",
        "admin.integrity.safe_fix_applied",
        "admin.login.completed",
        "admin.login.passkey_failed",
        "admin.moderation.dictionary_disabled",
        "admin.moderation.dictionary_enabled",
        "admin.moderation.dictionary_reloaded",
        "admin.moderation.dictionary_rolled_back",
        "admin.moderation.effective_policy_previewed",
        "admin.moderation.model_reloaded",
        "admin.moderation.model_rolled_back",
        "admin.moderation.model_runtime_changed",
        "admin.moderation.replay_previewed",
        "admin.moderation.runtime_global_state_changed",
        "admin.moderation.runtime_region_state_changed",
        "admin.ops.health_viewed",
        "admin.security.anti_crawler.crawler_ranges_synced",
        "admin.security.anti_crawler.options_rolled_back",
        "admin.security.anti_crawler.options_updated",
        "admin.security.anti_crawler.rule_created",
        "admin.security.anti_crawler.rule_deleted",
        "admin.security.anti_crawler.rule_updated",
        "admin.security.perception_v2.options_rolled_back",
        "admin.security.perception_v2.options_updated",
        "admin.security.pow.options_rolled_back",
        "admin.security.pow.options_updated",
        "admin.security.risk.reset",
        "admin.security.risk_control.options_rolled_back",
        "admin.security.risk_control.options_updated",
        "admin.security.risk_control.simulated",
        "admin.security.risk_control.simulation_rejected",
        "admin.session.revoked",
        "admin.step_up.challenge_mismatch",
        "admin.step_up.completed",
        "admin.step_up.credential_mismatch",
        "admin.step_up.passkey_failed",
        "admin.step_up.risk_control_passkey_failed",
        "admin.step_up.risk_control_verified",
        "anonymous.identity.rejected",
        "article.publish",
        "article.write",
        "article-property-values-snapshot",
        "article-property-values-write",
        "auth.login",
        "auth.passkey.begin",
        "auth.passkey.complete",
        "auth.refresh_token",
        "auth.self_service",
        "background.scheduled_publish",
        "category.create",
        "category.delete",
        "category.update",
        "comment.create",
        "comment.moderate",
        "dictionary_checksum_changed",
        "dictionary_reload_failed",
        "dictionary_rollback",
        "model_moderation_auto_disposition",
        "model_moderation_contract_invalid",
        "model_moderation_error",
        "model_moderation_scored",
        "model_moderation_timeout",
        "model_moderation_unavailable",
        "notification.subscribe",
        "passkey.credential-name.update",
        "passkey.delete",
        "passkey.register",
        "recovery-key.create",
        "recovery-key.rotate",
        "recovery-key.verify",
        "refresh.failed",
        "region_policy_reload_failed",
        "runtime.exception",
        "search.incremental",
        "search.query",
        "search.rebuild",
        "security.event",
        "tag.create",
        "tag.delete",
        "tag.update"
    ];

    private static readonly IReadOnlyDictionary<string, AuditRetentionPolicy> s_policies = BuildPolicies();

    public static IReadOnlyCollection<AuditRetentionPolicy> All
    {
        get;
    } = s_policies.Values
        .OrderBy(static policy => policy.Action, StringComparer.Ordinal)
        .ToArray();

    public static AuditRetentionPolicy GetRequired(string? action)
    {
        string normalized = string.IsNullOrWhiteSpace(action) ? AuditActionCatalog.LogRecorded : action.Trim();
        return s_policies.TryGetValue(normalized, out AuditRetentionPolicy? policy)
            ? policy
            : throw new InvalidOperationException($"audit_retention_policy_missing:{normalized}");
    }

    public static IReadOnlyList<string> ValidateCatalogCoverage()
    {
        string[] declared = typeof(AuditActionCatalog)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(static field => field.IsLiteral && field.FieldType == typeof(string))
            .Select(static field => (string)field.GetRawConstantValue()!)
            .ToArray();
        return declared.Where(action => !s_policies.ContainsKey(action)).Order(StringComparer.Ordinal).ToArray();
    }

    private static IReadOnlyDictionary<string, AuditRetentionPolicy> BuildPolicies()
    {
        var result = s_runtimeActions.Distinct(StringComparer.Ordinal).ToDictionary(
            static action => action,
            action => new AuditRetentionPolicy(
                action,
                s_defaultFullAge,
                s_defaultPseudonymAge,
                s_defaultAggregateAfter,
                AnchorForever: true,
                LegalHoldAllowed: action.StartsWith("admin.", StringComparison.Ordinal)
                    || action.StartsWith("security.", StringComparison.Ordinal),
                CryptographicEraseKeyDomain: action.StartsWith("security.anonymous_credential.", StringComparison.Ordinal)
                    ? "audit-retention/anonymous-credential"
                    : "audit-retention/general"),
            StringComparer.Ordinal);

        result[AuditActionCatalog.AnonymousCredentialIssued] = new AuditRetentionPolicy(
            AuditActionCatalog.AnonymousCredentialIssued,
            TimeSpan.FromDays(30),
            TimeSpan.FromDays(30),
            TimeSpan.FromDays(7),
            AnchorForever: true,
            LegalHoldAllowed: false,
            CryptographicEraseKeyDomain: "audit-retention/anonymous-credential");
        return result;
    }
}

public static class AuditInvestigationAccessPolicy
{
    public const int MaximumRowLimit = 200;

    public static bool IsValidPurpose(string? purpose)
    {
        string normalized = purpose?.Trim() ?? string.Empty;
        return normalized.Length is >= 8 and <= 128
            && !string.Equals(normalized, "none", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(normalized, "test", StringComparison.OrdinalIgnoreCase);
    }

    public static int EnforceRowLimit(int requested)
        => Math.Clamp(requested, 1, MaximumRowLimit);
}

public sealed record AuditRetentionStoragePolicy(
    string Surface,
    TimeSpan MaximumCiphertextAge,
    bool ControlledByApplication,
    bool RequiresOperatorAttestation);

public static class AuditRetentionStorageContract
{
    private static readonly TimeSpan s_maximumAge = AuditRetentionCatalog.All
        .Max(static policy => policy.MaxFullRecordAge);

    public static IReadOnlyList<AuditRetentionStoragePolicy> All
    {
        get;
    } =
    [
        new("database", s_maximumAge, ControlledByApplication: true, RequiresOperatorAttestation: false),
        new("local-fallback", s_maximumAge, ControlledByApplication: true, RequiresOperatorAttestation: false),
        new("backup", s_maximumAge, ControlledByApplication: false, RequiresOperatorAttestation: true),
        new("wal", s_maximumAge, ControlledByApplication: false, RequiresOperatorAttestation: true),
        new("replica", s_maximumAge, ControlledByApplication: false, RequiresOperatorAttestation: true)
    ];
}
