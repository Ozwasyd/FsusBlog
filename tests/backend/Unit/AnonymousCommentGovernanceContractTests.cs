using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentGovernanceContractTests
{
    [Fact]
    public void AnonymousCommentGovernance_DefinesStorageAndMigration()
    {
        string entities = string.Join(
            "\n",
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AnonymousCommentPolicy.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AnonymousCredential.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/CommentAnonymousNullifier.cs"));
        string migrations = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("[SugarTable(\"anonymous_comment_policy\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"anonymous_credential\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"comment_anonymous_nullifier\")]", entities, StringComparison.Ordinal);
        Assert.Contains("BuildAnonymousCommentGovernanceMigration()", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_comment_policy", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_credential", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS comment_anonymous_nullifier", migrations, StringComparison.Ordinal);

        foreach (string requiredColumn in new[]
        {
            "anonymous_comments_enabled",
            "public_comments_enabled",
            "zk_anonymous_enabled",
            "default_author_mode",
            "supported_display_languages",
            "commitment_hash",
            "credential_level",
            "revoked_at_utc",
            "nullifier_hash",
            "use_count",
            "blocked"
        })
        {
            Assert.Contains(requiredColumn, migrations, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AnonymousCommentGovernance_RegistersPolicyCredentialAndNullifierServices()
    {
        string services = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("IAnonymousCommentPolicyService", services, StringComparison.Ordinal);
        Assert.Contains("AnonymousCommentPolicyService", services, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCredentialService", services, StringComparison.Ordinal);
        Assert.Contains("AnonymousCredentialService", services, StringComparison.Ordinal);
        Assert.Contains("ICommentAnonymousNullifierService", services, StringComparison.Ordinal);
        Assert.Contains("CommentAnonymousNullifierService", services, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentPolicy_DefaultsToAnonymousAndRejectsImplicitPublicMode()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        CommentAuthorModeDecision anonymous = service.EvaluateAuthorMode(null, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision implicitPublic = service.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision explicitPublic = service.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true);

        Assert.True(anonymous.Allowed);
        Assert.Equal(CommentAuthorModes.Anonymous, anonymous.EffectiveAuthorMode);
        Assert.False(implicitPublic.Allowed);
        Assert.Equal("public_opt_in_required", implicitPublic.Status);
        Assert.True(explicitPublic.Allowed);
    }

    [Fact]
    public void AnonymousCommentPolicy_DisabledAnonymousRejectsAnonymousAndZkModes()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:AnonymousCommentsEnabled"] = "false",
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
        }));

        CommentAuthorModeDecision anonymous = service.EvaluateAuthorMode(CommentAuthorModes.Anonymous, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision pseudonymous = service.EvaluateAuthorMode(CommentAuthorModes.Pseudonymous, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision zk = service.EvaluateAuthorMode(CommentAuthorModes.ZkAnonymous, publicSendExplicitlySelected: false);

        Assert.False(anonymous.Allowed);
        Assert.False(pseudonymous.Allowed);
        Assert.False(zk.Allowed);
        Assert.Equal("anonymous_comments_disabled", zk.Status);
    }

    [Fact]
    public void AnonymousCommentPolicy_UpdateCanExposeZkAndCuratedLanguages()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        AnonymousCommentPolicySnapshot updated = service.UpdatePolicy(new AnonymousCommentPolicyUpdateRequest(
            AnonymousCommentsEnabled: true,
            PublicCommentsEnabled: true,
            ZkAnonymousEnabled: true,
            DefaultAuthorMode: CommentAuthorModes.Pseudonymous,
            SupportedDisplayLanguages: ["zh-CN", "en", "fr"]));

        Assert.True(updated.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.Pseudonymous, updated.DefaultAuthorMode);
        Assert.Equal(["zh-CN", "en"], updated.SupportedDisplayLanguages);
    }

    [Fact]
    public void CredentialAndNullifierServices_DoNotExposeReverseLookupFromNullifierToAccount()
    {
        string credentialService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousCredentialService.cs");
        string nullifierService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentAnonymousNullifierService.cs");

        Assert.Contains("IssueAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("GetActiveCredentialAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("RevokeAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("GetCredentialLevelAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("CheckAndReserveAsync", nullifierService, StringComparison.Ordinal);
        Assert.Contains("IncrementUsageAsync", nullifierService, StringComparison.Ordinal);
        Assert.Contains("BlockAsync", nullifierService, StringComparison.Ordinal);

        Assert.DoesNotContain("GetAccount", nullifierService, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", nullifierService, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousCredential", nullifierService, StringComparison.Ordinal);
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
}
