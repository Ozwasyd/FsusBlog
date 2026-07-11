using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;
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
        Assert.Contains("20260621-pre-passkey-recovery-key-account-id", migrationIds);
        Assert.Contains("20260621-pre-passkey-user-handle", migrationIds);
        Assert.Contains("20260621-post-user-legacy-identity-columns-finalize", migrationIds);
        Assert.Contains("20260621-post-sys-user-username-finalize", migrationIds);
        Assert.Contains("20260621-post-comment-attribution-index-finalize", migrationIds);
        Assert.Contains("20260621-post-message-legacy-identity-columns-finalize", migrationIds);
        Assert.Contains("20260621-pre-sys-user-security-profile-split", migrationIds);
        Assert.Contains("20260621-post-sys-user-security-profile-split-finalize", migrationIds);
        Assert.Contains("20260709-post-site-subscription-hmac-finalize", migrationIds);
        Assert.Contains("20260709-post-clear-legacy-public-artifacts", migrationIds);
        Assert.Contains("20260711-post-recovery-passkey-completion-idempotency", migrationIds);
        Assert.Contains("20260711-pre-account-subject-hash-expand", migrationIds);
        Assert.Contains("20260711-post-account-subject-hash-backfill", migrationIds);
    }

    [Fact]
    public void GetDescriptors_AccountSubjectProjection_UsesCompatibleExpandAndCanonicalBackfill()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor expand = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260711-pre-account-subject-hash-expand");
        ISchemaMigrationDescriptor backfill = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260711-post-account-subject-hash-backfill");
        string expandFingerprint = string.Join('\n', expand.Steps.Select(static step => step.Fingerprint));
        string backfillFingerprint = string.Join('\n', backfill.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, expand.Phase);
        Assert.Contains("sys_user.account_subject_hash:varchar(64) NULL", expandFingerprint, StringComparison.Ordinal);
        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, backfill.Phase);
        Assert.False(backfill.Transactional);
        Assert.Contains("csharp-canonical-hasher", backfillFingerprint, StringComparison.Ordinal);
        Assert.Contains("account_subject_hash IS NULL", backfillFingerprint, StringComparison.Ordinal);
        Assert.Contains("ck_sys_user_account_subject_hash_format", backfillFingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_RecoveryPasskeyCompletion_AddsDurableRequestBoundIdempotencyMarker()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260711-post-recovery-passkey-completion-idempotency");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("passkey_credential.recovery_session_hash:varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("passkey_credential.recovery_request_hash:varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_passkey_recovery_session_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("WHERE recovery_session_hash IS NOT NULL", fingerprint, StringComparison.Ordinal);
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
        Assert.Contains("hash_version smallint NOT NULL DEFAULT 1", fingerprint, StringComparison.Ordinal);
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
        Assert.DoesNotContain("ALTER COLUMN username", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("ALTER COLUMN password", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.identity_kind", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_account", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.passkey_enabled", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.recovery_enabled", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.privacy_initialized_at", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.anonymous_credential_level", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.anonymous_credential_status", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_UserLegacyIdentityColumnsFinalize_DropsAllLegacySysUserIdentityColumns()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-post-user-legacy-identity-columns-finalize");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("sys_user.password", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.role", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.lastusernameupdatetime", fingerprint, StringComparison.Ordinal);
        Assert.Contains("sys_user.last_username_update_time", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_SysUserUsernameFinalize_DropsUsernameAfterCodeFirst()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-post-sys-user-username-finalize");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("sys_user.username", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("sys_user.password", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("sys_user.role", fingerprint, StringComparison.Ordinal);
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
    public void GetDescriptors_PasskeyRecoveryKeyAccountId_RenamesLegacyUserIdColumnsAndIndexes()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-pre-passkey-recovery-key-account-id");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.Contains("passkey_credential.user_id->account_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ALTER TABLE account_recovery_key ADD COLUMN account_id integer", fingerprint, StringComparison.Ordinal);
        Assert.Contains("SET account_id = user_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_passkey_user_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_passkey_account_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_account_recovery_key_user", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_account_recovery_key_account", fingerprint, StringComparison.Ordinal);
        Assert.Contains("account_recovery_key(account_id, key_version DESC)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("account_recovery_key(account_id) WHERE used_at IS NULL AND revoked_at IS NULL", fingerprint, StringComparison.Ordinal);
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
    public void GetDescriptors_FreshCreateStepsUseAdminPrincipalColumns()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor authoringDescriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260518-post-authoring-workspace-tables");
        string authoringFingerprint = string.Join('\n', authoringDescriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("owner_admin_principal_id", authoringFingerprint, StringComparison.Ordinal);
        Assert.Contains("created_by_admin_principal_id", authoringFingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_article_draft_admin_principal_key", authoringFingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("owner_user_id", authoringFingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("created_by_user_id", authoringFingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("idx_article_draft_owner_key", authoringFingerprint, StringComparison.Ordinal);

        ISchemaMigrationDescriptor commentDescriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260518-pre-comment-moderation");
        string commentFingerprint = string.Join('\n', commentDescriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("comment.moderated_by_admin_principal_id", commentFingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("moderated_by_user_id", commentFingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_CommentModerationAdminPrincipalAttribution_PreservesLegacyColumnFallback()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260621-pre-comment-moderation-admin-principal-attribution");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.Contains("comment.moderated_by_user_id->moderated_by_admin_principal_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("comment:moderated_by_user_id->moderated_by_admin_principal_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("moderated_by_admin_principal_id IS NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("comment.moderated_by_user_id", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_StaticGuardsPreventLegacyModerationAndUsernameMigrationResidue()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        EnsureColumnStep[] ensuredColumns = descriptors
            .SelectMany(static descriptor => descriptor.Steps)
            .OfType<EnsureColumnStep>()
            .ToArray();
        string fingerprints = string.Join('\n', descriptors
            .SelectMany(static descriptor => descriptor.Steps)
            .Select(static step => step.Fingerprint));

        Assert.DoesNotContain(ensuredColumns, static step =>
            string.Equals(step.ColumnName, "moderated_by_user_id", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(
            "ALTER TABLE sys_user ALTER COLUMN username",
            fingerprints,
            StringComparison.Ordinal);
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
    public void GetDescriptors_ArticleViewProjectionWatermark_CreatesDurableRepairState()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260629-post-article-view-projection-watermark");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        string runnerRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(SchemaMigrationRunner),
            nameof(SchemaMigrationRunner.RunAsync));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("article_view_projection_watermark", fingerprint, StringComparison.Ordinal);
        Assert.Contains("last_visit_log_id integer NOT NULL DEFAULT 0", fingerprint, StringComparison.Ordinal);
        Assert.Contains("last_full_reconcile_utc timestamp", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_view_projection_watermark", runnerRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_AssetLibraryArticleRef_CreatesArticleScopedAssetProjection()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260629-post-asset-library-article-ref");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        string runnerRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(SchemaMigrationRunner),
            nameof(SchemaMigrationRunner.RunAsync));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("asset_library_article_ref", fingerprint, StringComparison.Ordinal);
        Assert.Contains("PRIMARY KEY (url, article_id)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("reference_count integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_asset_library_article_ref_article", fingerprint, StringComparison.Ordinal);
        Assert.Contains("asset_library_article_ref", runnerRuntime, StringComparison.Ordinal);
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
            "INSERT INTO anonymous_comment_policy \\([\\s\\S]*comment_max_chars,\\s*comment_max_utf8_bytes,\\s*snapshot_hash,\\s*changed_by,[\\s\\S]*VALUES \\(1, true, true, false, 'anonymous', 'zh-CN,en', 1000, 4096, '', 'system', now\\(\\)\\)",
            fingerprint);
        Assert.Contains("comment_max_chars integer NOT NULL DEFAULT 1000", fingerprint, StringComparison.Ordinal);
        Assert.Contains("comment_max_utf8_bytes integer NOT NULL DEFAULT 4096", fingerprint, StringComparison.Ordinal);
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
    public void GetDescriptors_ArticleRightsV3Schema_CreatesPolicySnapshotProofTablesAndBackfillsDefaults()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260704-post-article-rights-v3-schema");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("article_rights_policy", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_rights_snapshot", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_rights_policy_article", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_rights_snapshot_article_revision", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_rights_proof_idempotency", fingerprint, StringComparison.Ordinal);
        Assert.Contains("license_type varchar(48) NOT NULL DEFAULT 'all-rights-reserved'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("copy_policy varchar(48) NOT NULL DEFAULT 'append-attribution'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("max_excerpt_chars integer NOT NULL DEFAULT 300", fingerprint, StringComparison.Ordinal);
        Assert.Contains("allow_code_copy boolean NOT NULL DEFAULT true", fingerprint, StringComparison.Ordinal);
        Assert.Contains("show_public_badge boolean NOT NULL DEFAULT true", fingerprint, StringComparison.Ordinal);
        Assert.Contains("proof_binding_enabled boolean NOT NULL DEFAULT true", fingerprint, StringComparison.Ordinal);
        Assert.Contains("rights-v3:policy-hash:recompute", fingerprint, StringComparison.Ordinal);
        Assert.Contains("rights-v3:content-hash:recompute", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("rights.aeds", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GetDescriptors_SiteSubscriptionHmacFinalize_DisablesLegacySha256Rows()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260709-post-site-subscription-hmac-finalize");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("hash_version = 'sha256-legacy'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("hash_version = 'hmac-v1'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("is_enabled = false", fingerprint, StringComparison.Ordinal);
        Assert.Contains("SELECT COUNT(*)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("FROM site_subscription", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void GetDescriptors_ClearLegacyPublicArtifacts_RunsAsOneTimeMigrationStep()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260709-post-clear-legacy-public-artifacts");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("runtime-cache/public/articles/*.aeds", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article-detail-aeds-v3", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleRightsV3Entities_MapToExpectedDurableTablesAndUniqueKeys()
    {
        Assert.Equal("article_rights_policy", ReadTableName(typeof(ArticleRightsPolicy)));
        Assert.Equal("article_rights_snapshot", ReadTableName(typeof(ArticleRightsSnapshot)));
        Assert.Equal("article_rights_proof", ReadTableName(typeof(ArticleRightsProof)));

        Assert.Contains("ux_article_rights_policy_article", ReadIndexNames(typeof(ArticleRightsPolicy)));
        Assert.Contains("ux_article_rights_snapshot_article_revision", ReadIndexNames(typeof(ArticleRightsSnapshot)));
        Assert.Contains("ux_article_rights_proof_idempotency", ReadIndexNames(typeof(ArticleRightsProof)));

        Assert.Equal("all-rights-reserved", new ArticleRightsPolicy().LicenseType);
        Assert.Equal("append-attribution", new ArticleRightsPolicy().CopyPolicy);
        Assert.Equal(300, new ArticleRightsPolicy().MaxExcerptChars);
        Assert.True(new ArticleRightsPolicy().AllowCodeCopy);
        Assert.True(new ArticleRightsPolicy().ShowPublicBadge);
        Assert.True(new ArticleRightsPolicy().ProofBindingEnabled);
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

    private static string ReadTableName(Type entityType)
        => entityType.GetCustomAttributes(typeof(SugarTable), inherit: false)
            .OfType<SugarTable>()
            .Single()
            .TableName;

    private static string[] ReadIndexNames(Type entityType)
        => entityType.GetCustomAttributes(inherit: false)
            .Where(static attribute => attribute.GetType().Name is "SugarIndex" or "SugarIndexAttribute")
            .Select(static attribute => Convert.ToString(attribute.GetType().GetProperty("IndexName")?.GetValue(attribute)) ?? string.Empty)
            .Where(static name => !string.IsNullOrWhiteSpace(name))
            .ToArray();
}
