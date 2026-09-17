using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class ArticlePublicationMigrationTests
{
    [Fact]
    public void Descriptors_ExpandBackfillAndInstallConsistencyCheckerAfterCodeFirst()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            descriptors,
            static migration => migration.MigrationId == "20260719-pre-article-publication-coordinates");
        ISchemaMigrationDescriptor consistency = Assert.Single(
            descriptors,
            static migration => migration.MigrationId == "20260719-post-article-publication-consistency");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        string consistencyFingerprint = string.Join('\n', consistency.Steps.Select(static step => step.Fingerprint));
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadataCatalog = new OnlineSchemaMigrationCatalog().GetMetadata();
        OnlineSchemaMigrationMetadata metadata = metadataCatalog[descriptor.MigrationId];

        Assert.Equal("20260719-pre-article-publication-coordinates", descriptor.MigrationId);
        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("article_publication", fingerprint, StringComparison.Ordinal);
        Assert.Contains("current_revision_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("current_publication_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_revision_id", fingerprint, StringComparison.Ordinal);
        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, consistency.Phase);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadataCatalog[consistency.MigrationId].Phase);
        Assert.Contains("article_publication_consistency_v1", consistencyFingerprint, StringComparison.Ordinal);
        Assert.Contains("pending_outbox_coordinate_missing", consistencyFingerprint, StringComparison.Ordinal);
        Assert.Contains("event.article_publication_id IS NULL", consistencyFingerprint, StringComparison.Ordinal);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
    }
}
