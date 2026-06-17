using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentModerationPipelineTests
{
    [Fact]
    public void AntiSpamContext_CarriesAnonymousSafeActorAndPolicyMetadata()
    {
        string models = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Moderation/AntiSpamModerationModels.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Moderation/AntiSpamModerationService.cs");

        Assert.Contains("int? UserId", models, StringComparison.Ordinal);
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

        Assert.Contains("context.UserId", service, StringComparison.Ordinal);
        Assert.DoesNotContain("user_name", service, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("public_handle", service, StringComparison.OrdinalIgnoreCase);
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
    public void CommentService_EnforcesAnonymousNullifierBeforeCommitAndIncrementsAfterInsert()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");

        Assert.Contains("ICommentAnonymousNullifierService", source, StringComparison.Ordinal);
        Assert.Contains("RequiresAnonymousNullifierEnforcement(actor)", source, StringComparison.Ordinal);
        Assert.Contains("CheckAndReserveAsync", source, StringComparison.Ordinal);
        Assert.Contains("IncrementUsageAsync", source, StringComparison.Ordinal);
        Assert.Contains("db.Ado.UseTranAsync(async () =>", source, StringComparison.Ordinal);
        Assert.Contains("AnonymousNullifierRejectedException", source, StringComparison.Ordinal);
        Assert.Contains("CommentAuthorModes.ZkAnonymous", source, StringComparison.Ordinal);
    }

    [Fact]
    public void NullifierService_UsesAtomicReservationAndLimitAwareIncrement()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentAnonymousNullifierService.cs");

        Assert.Contains("ON CONFLICT (nullifier_hash, scope) DO NOTHING", source, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", source, StringComparison.Ordinal);
        Assert.Contains("n.UseCount < maxUseCount", source, StringComparison.Ordinal);
        Assert.Contains("\"scope_limit_exceeded\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccount", source, StringComparison.Ordinal);
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
            "AnonymousDisplayLanguage",
            "ModerationSubjectHash",
            "AnonymousNullifierHash",
            "AnonymousScope",
            "CredentialLevel",
            "ReputationBucket",
            "AccountAgeBucket"
        })
        {
            Assert.Contains(responseField, dto, StringComparison.Ordinal);
        }
    }
}
