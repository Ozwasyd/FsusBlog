using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TransparencyLogTests
{
    [Fact]
    public void ChainVerification_AcceptsAppendOnlyEntries()
    {
        TransparencyLogEntryRecord first = BuildEntry(1, 1001, null, "payload-a");
        TransparencyLogEntryRecord second = BuildEntry(2, 1002, first.EntryHash, "payload-b");

        TransparencyLogVerificationResult result = TransparencyLogChainVerifier.Verify([first, second]);

        Assert.True(result.IsValid);
        Assert.Equal(second.EntryHash, result.LatestHeadHash);
    }

    [Fact]
    public void ChainVerification_DetectsDeletedMutatedAndReorderedEntries()
    {
        TransparencyLogEntryRecord first = BuildEntry(1, 1001, null, "payload-a");
        TransparencyLogEntryRecord second = BuildEntry(2, 1002, first.EntryHash, "payload-b");
        TransparencyLogEntryRecord third = BuildEntry(3, 1003, second.EntryHash, "payload-c");
        TransparencyLogEntryRecord mutatedSecond = second with { EntryPayloadHash = HashPayload("payload-b-mutated") };

        Assert.Equal("seq-gap", TransparencyLogChainVerifier.Verify([first, third]).ErrorCode);
        Assert.Equal("entry-hash-mismatch", TransparencyLogChainVerifier.Verify([first, mutatedSecond, third]).ErrorCode);
        Assert.Equal("seq-order", TransparencyLogChainVerifier.Verify([second, first, third]).ErrorCode);
    }

    [Fact]
    public void EntityAndMigrationDefineAppendOnlyTransparencyLog()
    {
        string entitySource = ReadRepoFile("src/backend/Entities/Article.cs");
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260704-post-integrity-transparency-log");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("[SugarTable(\"integrity_transparency_log\")]", entitySource, StringComparison.Ordinal);
        Assert.Contains(nameof(IntegrityTransparencyLogEntry.Seq), entitySource, StringComparison.Ordinal);
        Assert.Contains(nameof(IntegrityTransparencyLogEntry.EntryHash), entitySource, StringComparison.Ordinal);
        Assert.Contains(nameof(ArticlePublishProof.TransparencyLogEntryId), entitySource, StringComparison.Ordinal);
        Assert.Contains(nameof(ArticlePublishProof.TransparencyLogEntryHash), entitySource, StringComparison.Ordinal);

        Assert.Contains("CREATE TABLE IF NOT EXISTS integrity_transparency_log", fingerprint, StringComparison.Ordinal);
        Assert.Contains("seq bigint NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("prev_entry_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("entry_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_transparency_log_seq", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_transparency_log_entry_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_transparency_log_proof_entry", fingerprint, StringComparison.Ordinal);
        Assert.Contains("transparency_log_entry_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("transparency_log_entry_hash", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("admin_principal", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("audit_log", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("security_risk", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EntryTypes_DefinesArticleRightsProofAsDistinctPublicIntegrityEntry()
    {
        Assert.Equal("article-rights-proof", TransparencyLogEntryTypes.ArticleRightsProof);
        Assert.NotEqual(TransparencyLogEntryTypes.PublishProof, TransparencyLogEntryTypes.ArticleRightsProof);
    }

    [Fact]
    public void AppendService_UsesTransactionLockIdempotencyAndProofBackReference()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Integrity/TransparencyLog.cs");

        Assert.Contains("UseTranAsync", source, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock(hashtext('integrity_transparency_log'))", source, StringComparison.Ordinal);
        Assert.Contains("EntryType == TransparencyLogEntryTypes.PublishProof", source, StringComparison.Ordinal);
        Assert.Contains("ProofId == proofId", source, StringComparison.Ordinal);
        Assert.Contains("OrderByDescending(entry => entry.Seq)", source, StringComparison.Ordinal);
        Assert.Contains("TransparencyLogEntryCanonicalizer.ComputeEntryHashHex", source, StringComparison.Ordinal);
        Assert.Contains("TransparencyLogChainVerifier.Verify", source, StringComparison.Ordinal);
        Assert.Contains("TransparencyLogEntryId", source, StringComparison.Ordinal);
        Assert.Contains("TransparencyLogEntryHash", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IPFS", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Arweave", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Nethereum", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HttpClient", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AppendService_HandlesArticleRightsProofRowsAndBackReference()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Integrity/TransparencyLog.cs");

        Assert.Contains("AppendArticleRightsProofAsync", source, StringComparison.Ordinal);
        Assert.Contains("EntryType == TransparencyLogEntryTypes.ArticleRightsProof", source, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsProof proof = await LoadRightsProofAsync", source, StringComparison.Ordinal);
        Assert.Contains("ComputeArticleRightsProofPayloadHash", source, StringComparison.Ordinal);
        Assert.Contains("Updateable<ArticleRightsProof>()", source, StringComparison.Ordinal);
        Assert.Contains("article-rights-proof-log-payload.v1", source, StringComparison.Ordinal);
    }

    private static TransparencyLogEntryRecord BuildEntry(long seq, long proofId, string? prevHash, string payload)
    {
        var input = new TransparencyLogEntryInput(
            Seq: seq,
            EntryType: TransparencyLogEntryTypes.PublishProof,
            ProofId: proofId,
            ArticleId: 910002,
            ArticleRevisionId: 920002,
            RevisionNo: (int)seq,
            EntryPayloadHash: HashPayload(payload),
            PrevEntryHash: prevHash ?? TransparencyLogEntryCanonicalizer.GenesisPreviousHash,
            CreatedAtUtc: DateTimeOffset.Parse("2026-07-04T00:00:00Z").AddMinutes(seq),
            SigningKeyId: "site-key-v1",
            SignatureBase64Url: $"signature-{seq}");
        return input.ToRecord(TransparencyLogEntryCanonicalizer.ComputeEntryHashHex(input));
    }

    private static string HashPayload(string payload)
        => TransparencyLogPayloadHasher.ComputeUtf8HashHex(TransparencyLogEntryTypes.PublishProof, payload);

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
