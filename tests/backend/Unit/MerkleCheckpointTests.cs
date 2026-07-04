using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MerkleCheckpointTests
{
    [Fact]
    public void BuildRoot_IsDeterministicAndOrderSensitive()
    {
        MerkleCheckpointBuildResult first = MerkleCheckpointBuilder.Build(Leaves(1, 2, 3));
        MerkleCheckpointBuildResult repeat = MerkleCheckpointBuilder.Build(Leaves(1, 2, 3));
        MerkleCheckpointBuildResult reordered = MerkleCheckpointBuilder.Build(Leaves(2, 1, 3), preserveInputOrder: true);

        Assert.Equal(first.RootHash, repeat.RootHash);
        Assert.NotEqual(first.RootHash, reordered.RootHash);
        Assert.Equal([1L, 2L, 3L], first.Leaves.Select(static leaf => leaf.Seq).ToArray());
    }

    [Fact]
    public void InclusionProof_VerifiesAndTamperFails()
    {
        MerkleCheckpointBuildResult checkpoint = MerkleCheckpointBuilder.Build(Leaves(1, 2, 3, 4));
        MerkleInclusionProof proof = MerkleCheckpointBuilder.BuildInclusionProof(checkpoint, seq: 3);

        Assert.True(MerkleCheckpointVerifier.VerifyInclusion(checkpoint.RootHash, proof));
        Assert.False(MerkleCheckpointVerifier.VerifyInclusion(checkpoint.RootHash, proof with { LeafHash = Hash("tampered-leaf") }));
        Assert.False(MerkleCheckpointVerifier.VerifyInclusion(Hash("tampered-root"), proof));
        Assert.False(MerkleCheckpointVerifier.VerifyInclusion(checkpoint.RootHash, proof with
        {
            Siblings = proof.Siblings.Select((sibling, index) => index == 0 ? sibling with { Hash = Hash("tampered-proof") } : sibling).ToArray()
        }));
    }

    [Fact]
    public void EmptyCheckpoint_HasStableRootAndNoInclusionProof()
    {
        MerkleCheckpointBuildResult first = MerkleCheckpointBuilder.Build([]);
        MerkleCheckpointBuildResult second = MerkleCheckpointBuilder.Build([]);

        Assert.True(first.IsEmpty);
        Assert.Equal(first.RootHash, second.RootHash);
        Assert.Empty(first.Leaves);
        Assert.Throws<InvalidOperationException>(() => MerkleCheckpointBuilder.BuildInclusionProof(first, seq: 1));
    }

    [Fact]
    public void CheckpointSignaturePayload_TamperRejects()
    {
        DateTimeOffset issuedAt = DateTimeOffset.Parse("2026-07-04T00:00:00Z");
        MerkleCheckpointBuildResult checkpoint = MerkleCheckpointBuilder.Build(Leaves(1, 2));
        MerkleCheckpointManifest manifest = MerkleCheckpointManifest.Create(
            checkpointKind: MerkleCheckpointKinds.Daily,
            scopeKey: "2026-07-04",
            checkpoint,
            logHeadSeq: 2,
            logHeadHash: checkpoint.Leaves[^1].LogEntryHash,
            issuedAt);
        SiteSigningKeyRecord key = SiteSigningKeyRecord.CreateEcdsaP256(
            "checkpoint-test-key",
            version: 1,
            notBeforeUtc: issuedAt.AddDays(-1),
            notAfterUtc: issuedAt.AddDays(1));
        var signer = new SiteIntegritySigningService(SiteSigningKeyRegistry.Create([key], key.KeyId));
        SiteIntegritySignature signature = signer.Sign(MerkleCheckpointSigning.BuildSigningPayload(manifest));

        Assert.True(signer.Verify(MerkleCheckpointSigning.BuildSigningPayload(manifest), signature).Accepted);
        Assert.False(signer.Verify(MerkleCheckpointSigning.BuildSigningPayload(manifest with { RootHash = Hash("tampered-root") }), signature).Accepted);
    }

    [Fact]
    public void Manifest_SupportsDailyAndReleaseScopesAndBindsLogHead()
    {
        DateTimeOffset issuedAt = DateTimeOffset.Parse("2026-07-04T00:00:00Z");
        MerkleCheckpointBuildResult checkpoint = MerkleCheckpointBuilder.Build(Leaves(7, 8));

        MerkleCheckpointManifest daily = MerkleCheckpointManifest.Create(
            MerkleCheckpointKinds.Daily,
            "2026-07-04",
            checkpoint,
            logHeadSeq: 8,
            logHeadHash: checkpoint.Leaves[^1].LogEntryHash,
            issuedAt);
        MerkleCheckpointManifest release = MerkleCheckpointManifest.Create(
            MerkleCheckpointKinds.Release,
            "release-2026.07.04",
            checkpoint,
            logHeadSeq: 9,
            logHeadHash: Hash("later-log-head"),
            issuedAt);

        Assert.Equal("daily", daily.CheckpointKind);
        Assert.Equal("release", release.CheckpointKind);
        Assert.Equal(7, daily.FromSeq);
        Assert.Equal(8, daily.ToSeq);
        Assert.Equal(2, daily.EntryCount);
        Assert.Throws<ArgumentOutOfRangeException>(() => MerkleCheckpointManifest.Create(
            MerkleCheckpointKinds.Release,
            "bad-head",
            checkpoint,
            logHeadSeq: 7,
            logHeadHash: checkpoint.Leaves[0].LogEntryHash,
            issuedAt));
    }

    [Fact]
    public void EntityAndMigrationDefineMerkleCheckpointStorage()
    {
        string entitySource = ReadRepoFile("src/backend/Entities/Article.cs");
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260704-post-integrity-merkle-checkpoint");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("[SugarTable(\"integrity_merkle_checkpoint\")]", entitySource, StringComparison.Ordinal);
        Assert.Contains(nameof(IntegrityMerkleCheckpoint.RootHash), entitySource, StringComparison.Ordinal);
        Assert.Contains(nameof(IntegrityMerkleCheckpoint.ManifestJson), entitySource, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS integrity_merkle_checkpoint", fingerprint, StringComparison.Ordinal);
        Assert.Contains("checkpoint_kind varchar(24) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("root_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("log_head_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_merkle_checkpoint_kind_scope", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_integrity_merkle_checkpoint_log_head", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("audit_log", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("security_risk", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Source_DoesNotUseExternalNetworkChainsOrUnsafe()
    {
        string core = ReadRepoFile("src/core/Integrity/MerkleCheckpoint.cs");
        string server = ReadRepoFile("src/backend/Infrastructure/Integrity/MerkleCheckpoint.cs");

        foreach (string source in new[] { core, server })
        {
            Assert.DoesNotContain("IPFS", source, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Arweave", source, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("Nethereum", source, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("HttpClient", source, StringComparison.Ordinal);
            Assert.DoesNotContain("unsafe", source, StringComparison.Ordinal);
        }
    }

    private static IReadOnlyList<MerkleLeafInput> Leaves(params long[] seqs)
        => seqs.Select(seq => new MerkleLeafInput(
            Seq: seq,
            LogEntryHash: Hash($"log-{seq}"),
            ProofId: 1000 + seq,
            ArticleId: 910000 + (int)seq,
            ArticleRevisionId: 920000 + seq,
            RevisionNo: (int)seq)).ToArray();

    private static string Hash(string value)
        => TransparencyLogPayloadHasher.ComputeUtf8HashHex("test", value);

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
