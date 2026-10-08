using System.Collections.Immutable;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultGitFacts")]
public sealed class ArticleVaultGitFactsTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void Status_SeparatesStagedUnstagedUntrackedUnmergedAndRenameHints()
    {
        VaultGitStatusFacts facts = ArticleVaultGitFactDecoder.DecodeStatus(
            "M  articles/staged.md\0 M articles/unstaged.md\0?? articles/new.md\0UU articles/conflict.md\0R  articles/moved.md\0articles/old.md\0"u8);
        Assert.Equal(3, facts.Staged);
        Assert.Equal(2, facts.Unstaged);
        Assert.Equal(1, facts.Untracked);
        Assert.Equal(1, facts.Unmerged);
        Assert.Single(facts.RenameHints);
        Assert.Equal(ArticleVaultManifestCodec.ComputeProjectionSha256("articles/old.md"), facts.RenameHints[0].OldProjectionSha256);
        Assert.Equal(ArticleVaultManifestCodec.ComputeProjectionSha256("articles/moved.md"), facts.RenameHints[0].NewProjectionSha256);
        string json = Encoding.UTF8.GetString(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(facts));
        Assert.DoesNotContain("articles/", json, StringComparison.Ordinal);
        Assert.DoesNotContain("PortableArticleIdentity", json, StringComparison.Ordinal);
    }

    [Fact]
    public void Index_BindsModesObjectHashesAndUnmergedStages()
    {
        string oid = new('a', 40);
        VaultGitIndexFacts facts = ArticleVaultGitFactDecoder.DecodeIndex(Encoding.UTF8.GetBytes(
            $"100644 {oid} 0\tarticles/clean.md\0" + $"100644 {oid} 1\tarticles/conflict.md\0"
            + $"100644 {oid} 2\tarticles/conflict.md\0" + $"100644 {oid} 3\tarticles/conflict.md\0"));
        Assert.Equal(4, facts.Entries);
        Assert.Equal(3, facts.UnmergedEntries);
        Assert.NotEqual(Digest, facts.ContentSha256);
    }

    [Theory]
    [InlineData("filter.private.clean")]
    [InlineData("filter.private.process")]
    [InlineData("diff.private.command")]
    [InlineData("diff.private.textconv")]
    [InlineData("merge.private.driver")]
    public void Configuration_RejectsExternalFiltersAndDriversBeforeStatus(string key)
        => Assert.Throws<InvalidDataException>(() => ArticleVaultGitFactDecoder.DecodeConfiguration(
            Encoding.UTF8.GetBytes(key + "\0"), []));

    [Fact]
    public void Configuration_BindsFiniteRelevanceWithoutReadingRemoteOrCredentialValues()
    {
        string digest = ArticleVaultGitFactDecoder.DecodeConfiguration(
            "core.filemode\0remote.origin.url\0credential.helper\0alias.sync\0"u8, "core.filemode\ntrue\0"u8);
        Assert.NotEqual(digest, ArticleVaultGitFactDecoder.DecodeConfiguration("core.filemode\0"u8, "core.filemode\nfalse\0"u8));
        Assert.Throws<InvalidDataException>(() => ArticleVaultGitFactDecoder.DecodeConfiguration(
            "core.filemode\0"u8, "core.filemode\nsecret-value\0"u8));
    }

    [Theory]
    [InlineData("?? missing-terminator")]
    [InlineData("XX unknown\0")]
    [InlineData("?? ../escape\0")]
    [InlineData("?? /absolute\0")]
    [InlineData("R  new.md\0")]
    [InlineData("?? valid.md\0\0")]
    public void Status_RejectsMalformedUnsafeUnknownAndTruncatedOutput(string text)
        => Assert.Throws<InvalidDataException>(() => ArticleVaultGitFactDecoder.DecodeStatus(Encoding.UTF8.GetBytes(text)));

    [Fact]
    public void Decoder_RejectsLargeOutputAndInvalidUtf8()
    {
        Assert.Throws<InvalidDataException>(() => ArticleVaultGitFactDecoder.DecodeStatus(
            new byte[ArticleVaultGitFactDecoder.MaxOutputBytes + 1]));
        Assert.Throws<InvalidDataException>(() => ArticleVaultGitFactDecoder.DecodeStatus([0xff, 0]));
        Assert.Throws<InvalidDataException>(() => ArticleVaultGitFactDecoder.DecodeIndex("100644 bad 9\tfile.md\0"u8));
    }

    [Fact]
    public void MarkerRanges_PreserveBomCrLfAndRawByteOffsetsWithoutSourceText()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("\ufeff<<<<<<< local\r\nprivate body\r\n=======\r\n>>>>>>> server\r\n");
        ImmutableArray<VaultConflictSourceChange> ranges = ArticleVaultGitFactDecoder.FindMarkers(bytes);
        Assert.Equal(3, ranges.Length);
        Assert.Equal(3, ranges[0].Start);
        Assert.Equal(18, ranges[0].End);
        Assert.All(ranges, range => Assert.Equal("git-marker", range.SemanticNodeIdentity));
        Assert.Empty(ArticleVaultGitFactDecoder.FindMarkers("ordinary paragraph\n"u8));
        Assert.Single(ArticleVaultGitFactDecoder.FindMarkers("||||||| ancestor"u8));
    }

    [Fact]
    public void NoGit_IsOptionalButCannotHideMarkerOrSourceBindingDrift()
    {
        ArticleVaultGitFacts noGit = Facts("source\n"u8);
        Assert.True(ArticleVaultGitFactDecoder.Validate(noGit).IsValid);
        Assert.True(ArticleVaultGitFactDecoder.AdmitSource(noGit, "article-one", noGit.Sources[0].SourceSha256).IsValid);
        ArticleVaultGitFacts markers = Facts("<<<<<<< local\n"u8);
        Assert.False(ArticleVaultGitFactDecoder.AdmitSource(markers, "article-one", markers.Sources[0].SourceSha256).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.AdmitSource(noGit, "article-other", noGit.Sources[0].SourceSha256).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.AdmitSource(noGit, "article-one", Digest).IsValid);
    }

    [Theory]
    [InlineData(VaultGitOperation.Merge)]
    [InlineData(VaultGitOperation.Rebase)]
    [InlineData(VaultGitOperation.CherryPick)]
    [InlineData(VaultGitOperation.Revert)]
    [InlineData(VaultGitOperation.Bisect)]
    [InlineData(VaultGitOperation.Sequencer)]
    public void UnfinishedOperation_BlocksAutomaticSyncAndPublication(VaultGitOperation operation)
    {
        ArticleVaultGitFacts facts = Facts("source\n"u8);
        facts = Seal(facts with
        {
            Availability = VaultGitAvailability.Observed,
            ReasonCode = null,
            RepositoryRootSha256 = Digest,
            WorktreeIdentitySha256 = Digest,
            HeadFactsSha256 = Digest,
            GitVersionSha256 = Digest,
            ConfigPolicySha256 = Digest,
            Index = new(Digest, 0, 0),
            Status = new(Digest, 0, 0, 0, 0, []),
            Operations = [operation],
            OperationSha256 = ArticleVaultGitFactDecoder.ComputeOperationSha256([operation])
        });
        Assert.True(ArticleVaultGitFactDecoder.Validate(facts).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.AdmitSource(facts, "article-one", facts.Sources[0].SourceSha256).IsValid);
    }

    [Fact]
    public void Facts_RejectDigestInventoryOperationAndCrossScopeTamper()
    {
        ArticleVaultGitFacts facts = Facts("private source\n"u8);
        Assert.False(ArticleVaultGitFactDecoder.Validate(facts with
        {
            HeadFactsSha256 = Digest
        }).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.Validate(Seal(facts with
        {
            WorktreeSha256 = Digest
        })).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.Validate(facts with
        {
            Operations = [(VaultGitOperation)99]
        }).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.Validate(Seal(facts with
        {
            Sources = [facts.Sources[0], facts.Sources[0]]
        })).IsValid);
        Assert.False(ArticleVaultGitFactDecoder.Validate(Seal(facts with
        {
            Scope = facts.Scope with
            {
                RootIdentitySha256 = "unknown"
            }
        })).IsValid);
        string json = System.Text.Json.JsonSerializer.Serialize(facts);
        Assert.DoesNotContain("private source", json, StringComparison.Ordinal);
        Assert.DoesNotContain("https://", json, StringComparison.Ordinal);
    }

    internal static ArticleVaultGitFacts Facts(ReadOnlySpan<byte> bytes)
    {
        ImmutableArray<VaultGitSourceFacts> sources =
        [new("article-one", ArticleVaultManifestCodec.ComputeSha256(bytes), ArticleVaultGitFactDecoder.FindMarkers(bytes))];
        return Seal(new(ArticleVaultGitFactDecoder.Schema, 1,
            new("site-one", "vault-one", "device-one", "agent-one", Digest, Digest, VaultPathComparisonPolicy.Ordinal),
            VaultGitAvailability.NotPresent, "git-not-present", null, null, null, null, null, null, null, [], sources,
            ArticleVaultGitFactDecoder.ComputeWorktreeSha256(sources), ArticleVaultGitFactDecoder.ComputeOperationSha256([]), string.Empty));
    }

    private static ArticleVaultGitFacts Seal(ArticleVaultGitFacts facts)
        => facts with
        {
            ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(facts)
        };
}
