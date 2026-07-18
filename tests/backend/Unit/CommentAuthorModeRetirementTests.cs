using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentAuthorModeRetirementTests
{
    [Fact]
    public void ProductionPolicy_AllowsOnlyExplicitPublicOrEnabledZkAnonymous()
    {
        var disabledZk = new AnonymousCommentPolicyService(BuildConfiguration(zkEnabled: false));

        CommentAuthorModeDecision retired = disabledZk.EvaluateAuthorMode(
            CommentAuthorModes.RetiredAnonymous,
            publicSendExplicitlySelected: false);
        CommentAuthorModeDecision implicitPublic = disabledZk.EvaluateAuthorMode(
            CommentAuthorModes.Public,
            publicSendExplicitlySelected: false);
        CommentAuthorModeDecision unavailableZk = disabledZk.EvaluateAuthorMode(
            CommentAuthorModes.ZkAnonymous,
            publicSendExplicitlySelected: false);

        Assert.False(retired.Allowed);
        Assert.Equal("anonymous_author_mode_retired", retired.Status);
        Assert.False(implicitPublic.Allowed);
        Assert.Equal("public_opt_in_required", implicitPublic.Status);
        Assert.False(unavailableZk.Allowed);
        Assert.Equal("zk_anonymous_disabled", unavailableZk.Status);

        var enabledZk = new AnonymousCommentPolicyService(BuildConfiguration(zkEnabled: true));
        Assert.True(enabledZk.EvaluateAuthorMode(CommentAuthorModes.Public, true).Allowed);
        Assert.True(enabledZk.EvaluateAuthorMode(CommentAuthorModes.ZkAnonymous, false).Allowed);
    }

    [Fact]
    public void RetirementMigration_PreservesDisplayStructureAndVisibilityWhileIsolatingIdentityState()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == "20260716-post-comment-author-mode-retirement");
        string source = Assert.IsType<RawSqlStep>(Assert.Single(descriptor.Steps)).Sql;

        Assert.Contains("author_mode = 'legacy_server_visible_pseudonymous'", source, StringComparison.Ordinal);
        Assert.Contains("DELETE FROM comment_anonymous_nullifier", source, StringComparison.Ordinal);
        Assert.Contains("anonymous_nullifier_hash = NULL", source, StringComparison.Ordinal);
        Assert.Contains("moderation_subject_hash = NULL", source, StringComparison.Ordinal);
        Assert.Contains("reputation_bucket = NULL", source, StringComparison.Ordinal);
        Assert.DoesNotContain("content =", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("parent_id =", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("root_id =", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("moderation_status =", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("is_deleted =", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("anonymous_display_name =", source, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProductionSources_ContainNoEngineeringAnonymousIdentityFallback()
    {
        string resolver = RuntimeMetadataInspection.DescribeType(typeof(CommentActorResolver));

        Assert.DoesNotContain("DeriveEngineeringNullifierHash", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("fsus.anonymous.nullifier.v2", resolver, StringComparison.Ordinal);
    }

    private static IConfiguration BuildConfiguration(bool zkEnabled)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:AnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:PublicCommentsEnabled"] = "true",
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = zkEnabled.ToString()
            })
            .Build();
}
