using FsusBlog.Server.Infrastructure.SchemaMigration;
using NSubstitute;
using SqlSugar;

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
        Assert.Contains("20260621-pre-passkey-user-handle", migrationIds);
        Assert.Contains("20260621-post-comment-attribution-index-finalize", migrationIds);
        Assert.Contains("20260621-post-message-legacy-identity-columns-finalize", migrationIds);
        Assert.Contains("20260621-pre-sys-user-security-profile-split", migrationIds);
        Assert.Contains("20260621-post-sys-user-security-profile-split-finalize", migrationIds);
    }

    [Fact]
    public void GetDescriptors_SysUserSecurityProfileSplit_MovesMfaMaterialAndDropsLoginObservations()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-pre-sys-user-security-profile-split");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("user_mfa_profile", fingerprint, StringComparison.Ordinal);
        Assert.Contains("mfa_secret_encrypted text", fingerprint, StringComparison.Ordinal);
        Assert.Contains("mfa_recovery_codes_hash text", fingerprint, StringComparison.Ordinal);
        Assert.Contains("INSERT INTO user_mfa_profile", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.lastloginip", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.lastlogintime", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.mfasecretencrypted", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.mfarecoverycodeshash", fingerprint, StringComparison.Ordinal);

        ISchemaMigrationDescriptor finalizeDescriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-post-sys-user-security-profile-split-finalize");
        string finalizeFingerprint = string.Join('\n', finalizeDescriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("sys_user.mfapendingsecretencrypted", finalizeFingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.mfapendingcreatedat", finalizeFingerprint, StringComparison.Ordinal);
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
        Assert.Contains("lookup_id_hash text", fingerprint, StringComparison.Ordinal);
        Assert.Contains("key_hash text NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("key_version integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("used_at timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("revoked_at timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_account_recovery_key_active_unique", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_account_recovery_key_lookup_active_unique", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("mfa_recovery", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GetDescriptors_PasskeyUserHandle_AddsRandomStableAccountHandleColumn()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-pre-passkey-user-handle");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("sys_user.passkey_user_handle", fingerprint, StringComparison.Ordinal);
        Assert.Contains("varchar(128) NULL", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("BitConverter", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_AuthoringAdminPrincipalAttribution_RenamesLegacyAuthoringColumns()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-pre-authoring-admin-principal-attribution");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("article_draft.owner_user_id->owner_admin_principal_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_revision.created_by_user_id->created_by_admin_principal_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_article_draft_admin_principal_key", fingerprint, StringComparison.Ordinal);
        Assert.Contains("owner_admin_principal_id, draft_key", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_VisitLogIpAnonymization_DropsRawIpColumn()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-post-visit-log-ip-anonymization");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("sys_visit_log.ip_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_visit_log.ip", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("userid", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GetDescriptors_AnonymousCommentGovernance_SeedsRequiredPolicyDefaults()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260616-post-anonymous-comment-governance");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Matches(
            "INSERT INTO anonymous_comment_policy \\([\\s\\S]*snapshot_hash,\\s*changed_by,[\\s\\S]*VALUES \\(1, true, true, false, 'anonymous', 'zh-CN,en', '', 'system', now\\(\\)\\)",
            fingerprint);
    }

    [Fact]
    public void GetDescriptors_CommentAttributionIndexFinalizer_RetiresGenericUserIdIndex()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-post-comment-attribution-index-finalize");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("idx_comment_user_id_desc", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_comment_attributable_public_user_id_desc", fingerprint, StringComparison.Ordinal);
        Assert.Contains("WHERE author_mode = 'public' AND user_id IS NOT NULL", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_MessageLegacyIdentityColumnsFinalize_DropsLegacyColumnsAndSyncObjects()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-post-message-legacy-identity-columns-finalize");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("msg_conversation.initiatoruserid", fingerprint, StringComparison.Ordinal);
        Assert.Contains("msg_message.senderid", fingerprint, StringComparison.Ordinal);
        Assert.Contains("msg_participant_state.userid", fingerprint, StringComparison.Ordinal);
        Assert.Contains("trg_msg_conversation_identity_sync", fingerprint, StringComparison.Ordinal);
        Assert.Contains("trg_msg_message_identity_sync", fingerprint, StringComparison.Ordinal);
        Assert.Contains("trg_msg_participant_identity_sync", fingerprint, StringComparison.Ordinal);
        Assert.Contains("fsusblog_msg_conversation_identity_sync", fingerprint, StringComparison.Ordinal);
        Assert.Contains("fsusblog_msg_message_identity_sync", fingerprint, StringComparison.Ordinal);
        Assert.Contains("fsusblog_msg_participant_identity_sync", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EnsureColumnStep_EscapesColumnDefinitionsInsideDynamicSql()
    {
        var step = new EnsureColumnStep("comment", "author_mode", "varchar(32) NOT NULL DEFAULT 'anonymous'");

        string capturedSql = await CaptureEnsureColumnSqlAsync(step);

        Assert.Contains("DEFAULT ''anonymous''", capturedSql, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EnsureColumnStep_PreservesEmptyStringDefaultsInsideDynamicSql()
    {
        var step = new EnsureColumnStep("anonymous_comment_policy", "snapshot_hash", "varchar(64) NOT NULL DEFAULT ''");

        string capturedSql = await CaptureEnsureColumnSqlAsync(step);

        Assert.Contains("DEFAULT ''''", capturedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("DEFAULT ''';", capturedSql, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EnsureColumnStep_NormalizesLegacyPreEscapedColumnDefinitions()
    {
        var step = new EnsureColumnStep("sys_user", "identity_kind", "varchar(32) NOT NULL DEFAULT ''anonymous_account''");

        string capturedSql = await CaptureEnsureColumnSqlAsync(step);

        Assert.Contains("DEFAULT ''anonymous_account''", capturedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("DEFAULT ''''anonymous_account''''", capturedSql, StringComparison.Ordinal);
    }

    private static async Task<string> CaptureEnsureColumnSqlAsync(EnsureColumnStep step)
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        string? capturedSql = null;
        db.Ado.Returns(ado);
        ado.ExecuteCommandAsync(Arg.Do<string>(sql => capturedSql = sql))
            .Returns(Task.FromResult(1));

        await step.ExecuteAsync(db, CancellationToken.None);

        Assert.NotNull(capturedSql);
        return capturedSql;
    }
}
