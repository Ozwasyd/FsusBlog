using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentModerationPipelineTests
{
    [Fact]
    public void AntiSpamContext_CarriesAnonymousSafeActorAndPolicyMetadata()
    {
        string models = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Moderation/AntiSpamModerationModels.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Moderation/AntiSpamModerationService.cs");

        Assert.Contains("AntiSpamCommentModerationContext", models, StringComparison.Ordinal);
        foreach (string requiredField in new[]
        {
            "AuthorMode",
            "AnonymousDisplayLanguage",
            "ModerationSubjectHash",
            "AnonymousNullifierHash",
            "AnonymousScope",
            "CredentialLevel",
            "ReputationBucket",
            "AccountAgeBucket",
            "AnonymousCommentsEnabled",
            "ZkAnonymousEnabled"
        })
        {
            Assert.Contains(requiredField, models, StringComparison.Ordinal);
        }

        foreach (string metadataKey in new[]
        {
            "author_mode",
            "anonymous_display_language",
            "moderation_subject_hash",
            "anonymous_nullifier_hash",
            "anonymous_scope",
            "credential_level",
            "reputation_bucket",
            "account_age_bucket",
            "anonymous_comments_enabled",
            "zk_anonymous_enabled"
        })
        {
            Assert.Contains(metadataKey, service, StringComparison.Ordinal);
        }

        string requestRecord = models[models.IndexOf("public sealed record AntiSpamModerationRequest", StringComparison.Ordinal)..models.IndexOf("public sealed record AntiSpamModerationCategorySignal", StringComparison.Ordinal)];
        Assert.DoesNotContain("context.UserId", service, StringComparison.Ordinal);
        Assert.Contains("AddMetadata(metadata, \"anonymous_nullifier_hash\"", service, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("IpHash", requestRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("AddMetadata(metadata, \"user_name\"", service, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("AddMetadata(metadata, \"public_handle\"", service, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AntiSpamModelRequest_UsesPrivacyAllowListAndSanitizesRuntimeMetadata()
    {
        string models = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Moderation/AntiSpamModerationModels.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Moderation/AntiSpamModerationService.cs");
        string requestRecord = models[models.IndexOf("public sealed record AntiSpamModerationRequest", StringComparison.Ordinal)..models.IndexOf("public sealed record AntiSpamModerationCategorySignal", StringComparison.Ordinal)];

        Assert.DoesNotContain("UserId", requestRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("UserName", requestRecord, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PublicHandle", requestRecord, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CredentialCommitment", requestRecord, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Proof", requestRecord, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Nullifier", requestRecord, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("IpHash", requestRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("DeviceFingerprint", requestRecord, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("ValidateModelRequestDocument", service, StringComparison.Ordinal);
        Assert.Contains("AllowedRequestMetadataFields", service, StringComparison.Ordinal);
        Assert.Contains("ForbiddenIdentityFields", service, StringComparison.Ordinal);
        Assert.Contains("moderation_subject_hash", service, StringComparison.Ordinal);
        Assert.Contains("anonymous_nullifier_hash", service, StringComparison.Ordinal);
        Assert.Contains("anonymous_scope", service, StringComparison.Ordinal);
        Assert.Contains("credential_level", service, StringComparison.Ordinal);
        Assert.Contains("reputation_bucket", service, StringComparison.Ordinal);
        Assert.Contains("account_age_bucket", service, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentService_PassesCommentActorAndPolicySnapshotToAntiSpamContext()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");

        Assert.Contains("IAnonymousCommentPolicyService", source, StringComparison.Ordinal);
        Assert.Contains("AnonymousCommentPolicySnapshot", source, StringComparison.Ordinal);
        Assert.Contains("actor.UserId", source, StringComparison.Ordinal);
        Assert.Contains("actor.AuthorMode", source, StringComparison.Ordinal);
        Assert.Contains("actor.DisplayLanguage", source, StringComparison.Ordinal);
        Assert.Contains("actor.ModerationSubjectHash", source, StringComparison.Ordinal);
        Assert.Contains("actor.AnonymousNullifierHash", source, StringComparison.Ordinal);
        Assert.Contains("actor.AnonymousScope", source, StringComparison.Ordinal);
        Assert.Contains("actor.CredentialLevel", source, StringComparison.Ordinal);
        Assert.Contains("policySnapshot?.AnonymousCommentsEnabled", source, StringComparison.Ordinal);
        Assert.Contains("policySnapshot?.ZkAnonymousEnabled", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentService_AppliesModelDispositionPolicyAndAuditsAutomaticActions()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string services = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs");
        string dto = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Dtos/AuthoringDtos.cs");

        Assert.Contains("ICommentModerationDispositionPolicy", source, StringComparison.Ordinal);
        Assert.Contains("CommentModerationDisposition disposition = commentModerationDispositionPolicy.Decide", source, StringComparison.Ordinal);
        Assert.Contains("ApplyAutomaticModerationDispositionAsync", source, StringComparison.Ordinal);
        Assert.Contains("model_moderation_auto_disposition", source, StringComparison.Ordinal);
        Assert.Contains("PublicArticleChanged: comment.ModerationStatus == CommentModerationStatus.Approved", source, StringComparison.Ordinal);
        Assert.Contains("AddScoped<ICommentModerationDispositionPolicy, CommentModerationDispositionPolicy>", services, StringComparison.Ordinal);
        Assert.Contains("AutoModerated", dto, StringComparison.Ordinal);
        Assert.Contains("ModerationActor", dto, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentService_AutomaticDispositionUsesRowVersionGuardAndRetry()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/Comment.cs");
        string applyMethod = source[
            source.IndexOf("private async Task ApplyAutomaticModerationDispositionAsync", StringComparison.Ordinal)..
            source.IndexOf("private async Task<AutomaticModerationTarget?> LoadAutomaticModerationTargetAsync", StringComparison.Ordinal)];
        string loadMethod = source[
            source.IndexOf("private async Task<AutomaticModerationTarget?> LoadAutomaticModerationTargetAsync", StringComparison.Ordinal)..
            source.IndexOf("private async Task<bool> TryApplyAutomaticModerationDispositionAsync", StringComparison.Ordinal)];
        string updateMethod = source[
            source.IndexOf("private async Task<bool> TryApplyAutomaticModerationDispositionAsync", StringComparison.Ordinal)..
            source.IndexOf("private void WriteAutomaticDispositionAudit", StringComparison.Ordinal)];

        Assert.Contains("public string? RowVersion", entity, StringComparison.Ordinal);
        Assert.Contains("LoadAutomaticModerationTargetAsync(comment.Id", applyMethod, StringComparison.Ordinal);
        Assert.Contains("TryApplyAutomaticModerationDispositionAsync(", applyMethod, StringComparison.Ordinal);
        Assert.Contains("LoadAutomaticModerationTargetAsync(comment.Id", applyMethod, StringComparison.Ordinal);
        Assert.Contains("target is null || target.ModerationStatus != previousStatus", applyMethod, StringComparison.Ordinal);
        Assert.Contains("latest is null || latest.ModerationStatus != previousStatus", applyMethod, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", loadMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", updateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND is_deleted = false", updateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Updateable<Comment>()", applyMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerationStatus == previousStatus", updateMethod, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentService_EnforcesAnonymousNullifierWithAtomicConsumeBeforeCommit()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string create = source[
            source.IndexOf("private async Task<bool> CreateResolvedCommentAsync", StringComparison.Ordinal)..
            source.IndexOf("private async Task<ReplyTargetRow?> LoadVisibleReplyTargetAsync", StringComparison.Ordinal)];

        Assert.Contains("ICommentAnonymousNullifierService", source, StringComparison.Ordinal);
        Assert.Contains("RequiresAnonymousNullifierEnforcement(actor)", source, StringComparison.Ordinal);
        Assert.Contains("db.Ado.UseTranAsync(async () =>", create, StringComparison.Ordinal);
        Assert.Contains("TryConsumeAsync", create, StringComparison.Ordinal);
        Assert.DoesNotContain("CheckAndReserveAsync", create, StringComparison.Ordinal);
        Assert.DoesNotContain("IncrementUsageAsync", create, StringComparison.Ordinal);
        Assert.Contains("AnonymousNullifierRejectedException", create, StringComparison.Ordinal);
        Assert.Contains("CommentAuthorModes.ZkAnonymous", source, StringComparison.Ordinal);
    }

    [Fact]
    public void NullifierService_UsesPrecheckAndAtomicConsume()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentAnonymousNullifierService.cs");

        Assert.Contains("PrecheckAsync", source, StringComparison.Ordinal);
        Assert.Contains("TryConsumeAsync", source, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (nullifier_hash, scope) DO NOTHING", source, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (nullifier_hash, scope) DO UPDATE", source, StringComparison.Ordinal);
        Assert.Contains("UPDATE comment_anonymous_nullifier", source, StringComparison.Ordinal);
        Assert.Contains("use_count = comment_anonymous_nullifier.use_count + 1", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("first_comment_id = COALESCE(comment_anonymous_nullifier.first_comment_id, @CommentId)", source, StringComparison.Ordinal);
        Assert.Contains("use_count < @MaxUseCount", source, StringComparison.Ordinal);
        Assert.Contains("RETURNING true AS allowed, 'reserved'::text AS status, use_count", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("RecordAnonymousNullifierPrecheck", source, StringComparison.Ordinal);
        Assert.Contains("RecordAnonymousNullifierAtomicIncrement", source, StringComparison.Ordinal);
        Assert.DoesNotContain("FOR UPDATE", source, StringComparison.Ordinal);
        Assert.DoesNotContain("n.UseCount < maxUseCount", source, StringComparison.Ordinal);
        Assert.Contains("\"scope_limit_exceeded\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccount", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentService_AnonymousFailureLogsDoNotWriteRawAnonymousScope()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");

        Assert.Contains("HashAnonymousScopeForLog(actor.AnonymousScope)", source, StringComparison.Ordinal);
        Assert.Contains("HashAnonymousScopeForLog(NormalizeAnonymousScope(request.AnonymousScope, request.ArticleId))", source, StringComparison.Ordinal);
        Assert.Contains("ScopeHash", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Scope: {Scope}", source, StringComparison.Ordinal);
        Assert.DoesNotContain("actor.AnonymousScope,\n                    rejected.Status", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminModerationEndpoints_ExposeAnonymousGovernanceActionsWithSpecificPermissions()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string dto = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Dtos/AuthoringDtos.cs");

        Assert.Contains("/moderation/anonymous-comment-policy", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AnonymousCommentConfigure", endpoints, StringComparison.Ordinal);
        Assert.Contains("AnonymousCommentPolicyUpdateRequest", endpoints, StringComparison.Ordinal);

        Assert.Contains("/comments/moderation/nullifiers/block", endpoints, StringComparison.Ordinal);
        Assert.Contains("ICommentAnonymousNullifierService", endpoints, StringComparison.Ordinal);
        Assert.Contains("BlockAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AnonymousNullifierBlock", endpoints, StringComparison.Ordinal);

        Assert.Contains("/comments/moderation/anonymous-credentials/{credentialId:long}/revoke", endpoints, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCredentialService", endpoints, StringComparison.Ordinal);
        Assert.Contains("RevokeAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AnonymousCredentialRevoke", endpoints, StringComparison.Ordinal);

        foreach (string responseField in new[]
        {
            "AuthorMode",
            "AuthorDisplayName",
            "AnonymousDisplayLanguage",
            "ModerationSubjectHash",
            "NullifierHash",
            "NullifierStatusLabel",
            "AnonymousScope",
            "CredentialLevel",
            "ReputationBucket",
            "AccountAgeBucket",
            "CanBlockAnonymousNullifier",
            "CanRevokeAnonymousCredential"
        })
        {
            Assert.Contains(responseField, dto, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ModerationQueue_DoesNotExposeRealUserIdForAnonymousRowsAndBatchesNullifierState()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string dto = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Dtos/AuthoringDtos.cs");
        string frontendQueue = BackendTestPaths.ReadAllTextFromRoot("src/frontend/src/composables/useCommentModerationQueue.ts");
        string queueView = BackendTestPaths.ReadAllTextFromRoot("src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue");

        Assert.DoesNotContain("int? UserId", dto, StringComparison.Ordinal);
        Assert.DoesNotContain("isAnonymousActor ? null : row.UserId", source, StringComparison.Ordinal);
        Assert.Contains("AnonymousDisplayName = c.AnonymousDisplayName", source, StringComparison.Ordinal);
        Assert.Contains("row.AnonymousDisplayName", source, StringComparison.Ordinal);
        Assert.Contains("LoadAnonymousNullifierSummariesAsync", source, StringComparison.Ordinal);
        Assert.Contains("CommentAnonymousNullifier", source, StringComparison.Ordinal);
        Assert.Contains("NullifierStatusLabel", source, StringComparison.Ordinal);
        Assert.Contains("userLabel", frontendQueue, StringComparison.Ordinal);
        Assert.Contains("安全作者快照", frontendQueue, StringComparison.Ordinal);
        Assert.DoesNotContain("item.userId", frontendQueue, StringComparison.Ordinal);
        Assert.DoesNotContain("row.nullifierHash", queueView, StringComparison.Ordinal);
        Assert.DoesNotContain("row.anonymousCredentialId", queueView, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousGovernanceAudit_RecordsOnlyIrreversibleTargets()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string securityDocs = BackendTestPaths.ReadAllTextFromRoot("docs/security.md");

        Assert.Contains("HashAuditTargetId", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("TargetId: request.NullifierHash", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("TargetId: credentialId.ToString", endpoints, StringComparison.Ordinal);
        Assert.Contains("无 deanonymization 后门", securityDocs, StringComparison.Ordinal);
        Assert.Contains("外部 anti-spam provider", securityDocs, StringComparison.Ordinal);
    }
}
