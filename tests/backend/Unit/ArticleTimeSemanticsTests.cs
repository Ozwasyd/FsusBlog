using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleTimeSemanticsTests
{
    [Fact]
    public void Migration_BackfillsDeterministicUtcSourcesAndKeepsFirstPublicationImmutable()
    {
        ISchemaMigrationDescriptor descriptor = ArticleTimeSemanticsMigrationDefinitions.BuildMigration();
        string fingerprint = string.Join('\n', descriptor.Steps.Select(step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("metadata_updated_at", fingerprint, StringComparison.Ordinal);
        Assert.Contains("last_published_at", fingerprint, StringComparison.Ordinal);
        Assert.Contains("public_updated_at", fingerprint, StringComparison.Ordinal);
        Assert.Contains("MIN(publication.published_at)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("MAX(publication.published_at)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("publication.created_at", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("SET public_updated_at = now()", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SET published_at = now()", fingerprint, StringComparison.OrdinalIgnoreCase);
    }
}
