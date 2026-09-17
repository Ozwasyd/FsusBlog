using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentRevisionManagementMigrationTests
{
    [Fact]
    public void Registry_ContainsAdditiveCommentRevisionManagementMigration()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == CommentRevisionManagementMigrationDefinitions.MigrationId);

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains(descriptor.Steps, step => step is EnsureColumnStep { TableName: "comment", ColumnName: "current_version" });
        Assert.Contains(descriptor.Steps, step => step is EnsureColumnStep { TableName: "comment", ColumnName: "edited_at_utc" });
        Assert.Contains(descriptor.Steps, step => step is EnsureColumnStep { TableName: "comment", ColumnName: "management_capability_hash" });
        Assert.Contains(descriptor.Steps, step => step is EnsureTableStep { TableName: "comment_revision" });
        Assert.Contains(descriptor.Steps, step => step is EnsureTableStep { TableName: "comment_management_challenge" });
        Assert.Contains(descriptor.Steps, step => step is EnsureTableStep { TableName: "comment_author_appeal" });
    }

    [Fact]
    public void Migration_DoesNotIntroduceAccountMappingForAnonymousCapability()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == CommentRevisionManagementMigrationDefinitions.MigrationId);
        string shape = string.Join('\n', descriptor.Steps.Select(static step => step.ToString()));

        Assert.DoesNotContain("management_capability_account", shape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("device_fingerprint", shape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("browser_fingerprint", shape, StringComparison.OrdinalIgnoreCase);
    }
}
