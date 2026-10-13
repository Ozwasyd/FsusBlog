using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "ArticleVaultSnapshotAssessment")]
public sealed class ArticleVaultSnapshotAssessmentTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Theory]
    [InlineData("", "complete", true)]
    [InlineData("first chunk", "first chunk", false)]
    [InlineData("part1", "part2", true)]
    [InlineData("", "", true)]
    public void TruncatePausedChunksAndSameSizeContentChanges_DoNotBecomeStable(
        string first, string second, bool completion)
    {
        VaultSnapshotAssessment result = Assess(first, second, completion);
        Assert.Equal(VaultSnapshotAssessmentState.IncompleteWrite, result.State);
        Assert.Null(result.Source);
        Assert.False(result.CanAdmitSynchronization);
    }

    [Fact]
    public void CompletedSamples_PreserveExactBytesAndStillRequireNativeAdmission()
    {
        byte[] bytes = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("first  \r\nsecond\t\r\n")];
        ArticleVaultRootManifest root = CreateRoot();
        VaultSnapshotAssessment result = ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
            "articles/first.md", ["articles/first.md"], Metadata(bytes.Length), bytes,
            Metadata(bytes.Length), bytes, true);

        Assert.Equal(VaultSnapshotAssessmentState.StableCandidate, result.State);
        Assert.Equal(ArticleVaultManifestCodec.CaptureSourceBytes(bytes), result.Source);
        Assert.True(result.Source!.HasUtf8Bom);
        Assert.Equal(VaultNewlineStyle.CrLf, result.Source.NewlineStyle);
        Assert.Equal(2, result.Source.TrailingWhitespaceLineCount);
        Assert.True(result.Source.HasFinalNewline);
        Assert.True(result.RequiresNativeAdmission);
        Assert.False(result.CanAdmitSynchronization);
        Assert.Equal("portable-a", result.PortableArticleIdentityCandidate);
        Assert.DoesNotContain("first  ", JsonSerializer.Serialize(result), StringComparison.Ordinal);
    }

    [Fact]
    public void InodeReplacementAndPermissionDrift_InvalidateMatchingBytes()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        ArticleVaultRootManifest root = CreateRoot();
        foreach (VaultFileMetadataObservation changed in new[]
        {
            Metadata(bytes.Length) with { FileIdentityDiagnostic = "inode-new" },
            Metadata(bytes.Length) with { PermissionSha256 = new string('b', 64) },
            Metadata(bytes.Length) with { ByteLength = bytes.Length + 1 }
        })
        {
            VaultSnapshotAssessment result = ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
                "articles/first.md", [], Metadata(bytes.Length), bytes, changed, bytes, true);
            Assert.Equal(VaultSnapshotAssessmentState.IncompleteWrite, result.State);
            Assert.Null(result.Source);
        }
    }

    [Theory]
    [InlineData(false, true, VaultSnapshotAssessmentState.PermissionBlocked)]
    [InlineData(true, false, VaultSnapshotAssessmentState.PathBlocked)]
    public void UnreadableAndNonRegularFiles_AreBlocked(
        bool readable, bool regular, VaultSnapshotAssessmentState expected)
    {
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        ArticleVaultRootManifest root = CreateRoot();
        VaultFileMetadataObservation metadata = Metadata(bytes.Length) with
        {
            IsReadable = readable,
            IsRegularFile = regular
        };
        VaultSnapshotAssessment result = ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
            "articles/first.md", [], metadata, bytes, metadata, bytes, true);
        Assert.Equal(expected, result.State);
        Assert.Null(result.Source);
    }

    [Fact]
    public void IncompleteUtf8AndMissingSample_ReturnRetryObservation()
    {
        ArticleVaultRootManifest root = CreateRoot();
        byte[] bytes = [0xe2, 0x82];
        VaultSnapshotAssessment incomplete = ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
            "articles/first.md", [], Metadata(2), bytes, Metadata(2), bytes, true);
        Assert.Equal("vault_snapshot_utf8_incomplete", incomplete.ReasonCode);
        Assert.Null(incomplete.Source);
        VaultSnapshotAssessment missing = ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
            "articles/first.md", [], null, [], null, [], false);
        Assert.Equal("vault_snapshot_sample_missing", missing.ReasonCode);
        Assert.False(missing.CanAdmitSynchronization);
    }

    [Theory]
    [InlineData("articles/first.md.tmp", VaultSnapshotAssessmentState.UnknownFile)]
    [InlineData(".fsus/vault.json", VaultSnapshotAssessmentState.PathBlocked)]
    public void TempAndControlArtifacts_AreNeverAcceptedSource(
        string path, VaultSnapshotAssessmentState expected)
    {
        ArticleVaultRootManifest root = CreateRoot();
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        VaultSnapshotAssessment result = ArticleVaultSnapshotAssessor.Assess(root, Scope(root), path,
            [], Metadata(bytes.Length), bytes, Metadata(bytes.Length), bytes, true);
        Assert.Equal(expected, result.State);
        Assert.Null(result.Source);
    }

    [Theory]
    [InlineData("/outside.md")]
    [InlineData("articles/../outside.md")]
    [InlineData("C:/outside.md")]
    public void ArbitraryAbsoluteAndTraversalPaths_AreRefused(string path)
    {
        ArticleVaultRootManifest root = CreateRoot();
        Assert.Throws<InvalidDataException>(() => ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
            path, [], null, [], null, [], false));
    }

    [Fact]
    public void IndependentVerifier_RejectsResealedSourceScopeAndCompletionTamper()
    {
        ArticleVaultRootManifest root = CreateRoot();
        byte[] bytes = Encoding.UTF8.GetBytes("complete");
        VaultSnapshotAssessment result = Assess("complete", "complete", true);
        Assert.True(Verify(result));
        foreach (VaultSnapshotAssessment changed in new[]
        {
            result with { CompletionBoundaryObserved = false },
            result with { Source = result.Source! with { HasUtf8Bom = true } },
            result with { State = VaultSnapshotAssessmentState.IncompleteWrite },
            result with { PortableArticleIdentityCandidate = "other" },
            result with { Scope = Scope(root) with { AgentIdentity = "other" } },
            result with { PathProjection = result.PathProjection with { RelativePath = "outside.md" } }
        })
        {
            VaultSnapshotAssessment resealed = changed with
            {
                ContentSha256 = ArticleVaultSnapshotAssessor.ComputeContentSha256(changed)
            };
            Assert.False(Verify(resealed));
        }

        bool Verify(VaultSnapshotAssessment assessment)
            => ArticleVaultSnapshotAssessor.Verify(root, Scope(root), "articles/first.md", [],
                Metadata(bytes.Length), bytes, Metadata(bytes.Length), bytes, true, assessment).IsValid;
    }

    [Fact]
    public void SourceBound_IsEnforcedBeforeComparisons()
    {
        ArticleVaultRootManifest root = CreateRoot();
        byte[] bytes = new byte[ArticleVaultSnapshotAssessor.MaxSourceBytes + 1];
        Assert.Throws<InvalidDataException>(() => ArticleVaultSnapshotAssessor.Assess(root, Scope(root),
            "articles/first.md", [], Metadata(bytes.Length), bytes, Metadata(bytes.Length), bytes, true));
    }

    internal static ArticleVaultRootManifest CreateRoot(params string[] paths)
    {
        if (paths.Length == 0)
        {
            paths = ["articles/first.md"];
        }

        var root = new ArticleVaultRootManifest(
            ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "site", "vault", "device", paths.Select((path, index) => new VaultArticleReference(
                index == 0 ? "portable-a" : $"portable-{index}",
                $".fsus/articles/{(index == 0 ? "portable-a" : $"portable-{index}")}.json", Digest, path)).ToArray(), [], string.Empty);
        return root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
    }

    internal static VaultPathStructuralScope Scope(ArticleVaultRootManifest root)
        => new(root.SiteIdentity, root.VaultIdentity, root.DeviceIdentity,
            "agent", Digest, root.ContentSha256, VaultPathComparisonPolicy.Ordinal);

    internal static VaultFileMetadataObservation Metadata(long length)
        => new("inode-a", length, Digest, true, true);

    private static VaultSnapshotAssessment Assess(string first, string second, bool completion)
    {
        ArticleVaultRootManifest root = CreateRoot();
        byte[] firstBytes = Encoding.UTF8.GetBytes(first);
        byte[] secondBytes = Encoding.UTF8.GetBytes(second);
        return ArticleVaultSnapshotAssessor.Assess(root, Scope(root), "articles/first.md", [],
            Metadata(firstBytes.Length), firstBytes, Metadata(secondBytes.Length), secondBytes, completion);
    }
}
