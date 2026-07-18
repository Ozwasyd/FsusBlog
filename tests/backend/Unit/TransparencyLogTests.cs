using System.Reflection;

using NSubstitute;
using SqlSugar;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.SchemaMigration;
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
        TransparencyLogEntryRecord mutatedSecond = second with
        {
            EntryPayloadHash = HashPayload("payload-b-mutated")
        };

        Assert.Equal("seq-gap", TransparencyLogChainVerifier.Verify([first, third]).ErrorCode);
        Assert.Equal("entry-hash-mismatch", TransparencyLogChainVerifier.Verify([first, mutatedSecond, third]).ErrorCode);
        Assert.Equal("seq-order", TransparencyLogChainVerifier.Verify([second, first, third]).ErrorCode);
    }

    [Fact]
    public void EntityAndMigrationDefineAppendOnlyTransparencyLog()
    {
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260704-post-integrity-transparency-log");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(
            "integrity_transparency_log",
            typeof(IntegrityTransparencyLogEntry).GetCustomAttribute<SugarTable>()?.TableName);
        Assert.NotNull(typeof(IntegrityTransparencyLogEntry).GetProperty(nameof(IntegrityTransparencyLogEntry.Seq)));
        Assert.NotNull(typeof(IntegrityTransparencyLogEntry).GetProperty(nameof(IntegrityTransparencyLogEntry.EntryHash)));
        Assert.NotNull(typeof(ArticlePublishProof).GetProperty(nameof(ArticlePublishProof.TransparencyLogEntryId)));
        Assert.NotNull(typeof(ArticlePublishProof).GetProperty(nameof(ArticlePublishProof.TransparencyLogEntryHash)));

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
    public async Task AppendService_UsesTransactionLockIdempotencyAndProofBackReference()
    {
        ConstructorInfo constructor = Assert.Single(typeof(PublishProofTransparencyLog).GetConstructors());
        Assert.Equal(
            new[] { typeof(ISqlSugarClient) },
            constructor.GetParameters().Select(static parameter => parameter.ParameterType).ToArray());
        var service = new PublishProofTransparencyLog(Substitute.For<ISqlSugarClient>());

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => service.AppendPublishProofAsync(0));
        Assert.Equal(
            typeof(Task<IntegrityTransparencyLogEntry>),
            typeof(PublishProofTransparencyLog).GetMethod(nameof(PublishProofTransparencyLog.AppendPublishProofAsync))!.ReturnType);
        Assert.Equal(
            typeof(Task<TransparencyLogVerificationResult>),
            typeof(PublishProofTransparencyLog).GetMethod(nameof(PublishProofTransparencyLog.VerifyAsync))!.ReturnType);
        Assert.NotNull(typeof(ArticlePublishProof).GetProperty(nameof(ArticlePublishProof.TransparencyLogEntryId)));
        Assert.NotNull(typeof(ArticlePublishProof).GetProperty(nameof(ArticlePublishProof.TransparencyLogEntryHash)));
    }

    [Fact]
    public async Task AppendService_HandlesArticleRightsProofRowsAndBackReference()
    {
        var service = new PublishProofTransparencyLog(Substitute.For<ISqlSugarClient>());
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => service.AppendArticleRightsProofAsync(0));

        MethodInfo payloadHash = typeof(PublishProofTransparencyLog).GetMethod(
            "ComputeArticleRightsProofPayloadHash",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        var proof = new ArticleRightsProof
        {
            Id = 41,
            ProofVersion = 1,
            SignaturePayloadVersion = 1,
            ArticleId = 42,
            ArticleRevisionId = 43,
            RevisionNo = 4,
            ArticleRightsSnapshotId = 44,
            PublishProofId = 45,
            IdempotencyKey = "rights:42:43:1",
            RightsPolicyHash = new string('a', 64),
            ContentCanonicalHash = new string('b', 64),
            ProofStatus = "ready",
            SigningKeyId = "site-key-v1",
            SigningAlgorithm = "ed25519",
            SignatureBase64Url = "signature"
        };
        string first = Assert.IsType<string>(payloadHash.Invoke(null, [proof]));
        proof.RevisionNo = 5;
        string second = Assert.IsType<string>(payloadHash.Invoke(null, [proof]));

        Assert.Matches("^[0-9a-f]{64}$", first);
        Assert.NotEqual(first, second);
        Assert.NotNull(typeof(ArticleRightsProof).GetProperty(nameof(ArticleRightsProof.TransparencyLogEntryId)));
        Assert.NotNull(typeof(ArticleRightsProof).GetProperty(nameof(ArticleRightsProof.TransparencyLogEntryHash)));
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

}
