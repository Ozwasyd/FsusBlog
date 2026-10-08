using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux.Tests;

internal static class ArticleVaultGitFactsTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
