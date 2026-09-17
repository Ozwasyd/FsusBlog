using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DestructiveMigrationProofTests
{
    [Fact]
    public void Registry_AllCurrentDestructiveDropsCarryDescriptorMatchedProofs()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        var destructiveSteps = descriptors
            .SelectMany(descriptor => descriptor.Steps
                .Where(static step => step is DropColumnStep or DropTableStep)
                .Select(step => (descriptor, step: Assert.IsAssignableFrom<IDestructiveSchemaMigrationStep>(step))))
            .ToArray();

        Assert.Equal(46, destructiveSteps.Length);
        Assert.Equal(18, destructiveSteps.Select(static pair => pair.descriptor.MigrationId).Distinct().Count());
        Assert.All(destructiveSteps, pair =>
        {
            DestructiveMigrationProof proof = pair.step.Proof;
            Assert.Equal(pair.descriptor.MigrationId, proof.MigrationId);
            Assert.Matches("^[0-9a-f]{40}$", proof.IntroducedByCommit);
            Assert.False(string.IsNullOrWhiteSpace(proof.EarliestContractRelease));
            Assert.Equal(TimeSpan.FromDays(30), proof.RollbackWindowEndUtc - proof.IntroducedAtUtc);
            Assert.StartsWith(
                "docs/schema-migrations/destructive-rollback-window-proofs.json#",
                proof.RollbackWindowProofArtifact,
                StringComparison.Ordinal);
            Assert.Equal(5, proof.RequiredEvidence.Count);
        });
    }

    [Fact]
    public void ValidateDescriptor_FailsClosedBeforeRollbackWindowEnds()
    {
        DestructiveMigrationProof proof = DestructiveMigrationProofs.For("20260715-post-read-event-retirement");
        ISchemaMigrationDescriptor descriptor = Descriptor(proof.MigrationId, proof);

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            DestructiveMigrationProofs.ValidateDescriptor(
                descriptor,
                proof.RollbackWindowEndUtc.AddTicks(-1),
                freshBootstrap: false));

        Assert.StartsWith("schema_destructive_rollback_window_open:", error.Message, StringComparison.Ordinal);
        Assert.Contains(proof.RollbackWindowEndUtc.ToString("O"), error.Message, StringComparison.Ordinal);
        Assert.Contains(proof.RollbackWindowProofArtifact, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateDescriptor_AllowsGenuinelyEmptyBootstrap()
    {
        DestructiveMigrationProof proof = DestructiveMigrationProofs.For("20260715-post-read-event-retirement");
        ISchemaMigrationDescriptor descriptor = Descriptor(proof.MigrationId, proof);

        Exception? error = Record.Exception(() => DestructiveMigrationProofs.ValidateDescriptor(
            descriptor,
            proof.IntroducedAtUtc,
            freshBootstrap: true));

        Assert.Null(error);
    }

    [Fact]
    public void ValidateDescriptor_RejectsProofBorrowedFromAnotherMigration()
    {
        ISchemaMigrationDescriptor descriptor = Descriptor(
            "20260418-post-content-cleanup",
            DestructiveMigrationProofs.For("20260418-post-messaging-split"));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            DestructiveMigrationProofs.ValidateDescriptor(
                descriptor,
                DateTimeOffset.MaxValue,
                freshBootstrap: false));

        Assert.StartsWith("schema_destructive_proof_descriptor_mismatch:", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateDescriptor_AllowsExecutionAtWindowBoundary()
    {
        DestructiveMigrationProof proof = DestructiveMigrationProofs.For("20260418-post-content-cleanup");
        ISchemaMigrationDescriptor descriptor = Descriptor(proof.MigrationId, proof);

        Exception? error = Record.Exception(() => DestructiveMigrationProofs.ValidateDescriptor(
            descriptor,
            proof.RollbackWindowEndUtc,
            freshBootstrap: false));

        Assert.Null(error);
    }

    private static ISchemaMigrationDescriptor Descriptor(
        string migrationId,
        DestructiveMigrationProof proof)
        => new SchemaMigrationDescriptor(
            migrationId,
            "proof test",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            [new DropColumnStep("article", "legacy_column", proof)]);
}
