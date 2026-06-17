using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class SchemaMigrationRegistryTests
{
    [Fact]
    public void GetDescriptors_ContainsUniqueStableMigrationIds()
    {
        var registry = new SchemaMigrationRegistry();

        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = registry.GetDescriptors();

        Assert.NotEmpty(descriptors);
        Assert.Equal(descriptors.Count, descriptors.Select(static descriptor => descriptor.MigrationId).Distinct(StringComparer.Ordinal).Count());
        Assert.All(descriptors, static descriptor => Assert.False(string.IsNullOrWhiteSpace(descriptor.Checksum)));
    }

    [Fact]
    public void GetDescriptors_ContainsExpectedLegacyMigrations()
    {
        var registry = new SchemaMigrationRegistry();

        string[] migrationIds = registry.GetDescriptors()
            .Select(static descriptor => descriptor.MigrationId)
            .OrderBy(static id => id, StringComparer.Ordinal)
            .ToArray();

        Assert.Contains("20260418-pre-user-session-compat", migrationIds);
        Assert.Contains("20260418-pre-comment-threading-compat", migrationIds);
        Assert.Contains("20260517-pre-legacy-profile-compat", migrationIds);
        Assert.Contains("20260418-post-comment-threading-indexes", migrationIds);
        Assert.Contains("20260418-pre-content-compat", migrationIds);
        Assert.Contains("20260418-post-content-cleanup", migrationIds);
        Assert.Contains("20260418-post-messaging-split", migrationIds);
        Assert.Contains("20260418-post-user-soft-delete", migrationIds);
        Assert.Contains("20260418-post-user-session-finalize", migrationIds);
        Assert.Contains("20260602-post-user-auth-security-hardening", migrationIds);
        Assert.Contains("20260418-post-audit-log", migrationIds);
        Assert.Contains("20260603-pre-audit-structured-fields-codefirst-compat", migrationIds);
        Assert.Contains("20260518-pre-single-author-article-lifecycle", migrationIds);
        Assert.Contains("20260518-post-authoring-workspace-tables", migrationIds);
        Assert.Contains("20260518-post-authoring-draft-lifecycle", migrationIds);
        Assert.Contains("20260518-pre-comment-moderation", migrationIds);
        Assert.Contains("20260610-post-comment-region-compliance", migrationIds);
        Assert.Contains("20260603-post-comment-public-hot-path-indexes", migrationIds);
        Assert.Contains("20260616-pre-anonymous-identity-account-schema", migrationIds);
        Assert.Contains("20260616-post-account-recovery-key", migrationIds);
    }

    [Fact]
    public void GetDescriptors_AnonymousIdentityAccountSchema_AddsExpectedColumns()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260616-pre-anonymous-identity-account-schema");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("sys_user.public_handle", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ALTER TABLE sys_user ALTER COLUMN username DROP NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ALTER TABLE sys_user ALTER COLUMN password DROP NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.identity_kind", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_account", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.passkey_enabled", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.recovery_enabled", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.privacy_initialized_at", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.anonymous_credential_level", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.anonymous_credential_status", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_AccountRecoveryKey_CreatesIndependentRecoveryKeyTable()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260616-post-account-recovery-key");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("account_recovery_key", fingerprint, StringComparison.Ordinal);
        Assert.Contains("key_hash text NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("key_version integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("used_at timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("revoked_at timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_account_recovery_key_active_unique", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("mfa_recovery", fingerprint, StringComparison.OrdinalIgnoreCase);
    }
}
