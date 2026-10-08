using System.Text;

using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultDependencyAuthorityBoundaryTests
{
    [Fact]
    public void CurrentCandidateModulesHaveNoNetworkFilesystemProcessOrWriterAuthority()
    {
        Type[] owners =
        [
            typeof(ArticleVaultBlockLinkRefactor),
            typeof(ArticleVaultFrozenEmbedAdmission),
            typeof(ArticleVaultDependencyExecutionPreflight)
        ];
        foreach (Type owner in owners)
        {
            string compiled = RuntimeMetadataInspection.DescribeType(owner)
                + RuntimeMetadataInspection.DescribeConstructors(owner);
            Assert.False(HasForbiddenAuthority(compiled), compiled);
        }
    }

    [Fact]
    public void CompiledCallsUseExistingCodecVerifierAndSealedBundleAdmission()
    {
        string link = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleVaultBlockLinkRefactor), nameof(ArticleVaultBlockLinkRefactor.Propose));
        Assert.Contains(typeof(BlockAnchorMarkdownParser).FullName!, link, StringComparison.Ordinal);
        Assert.Contains(typeof(BlockAnchorMarkdownBuilder).FullName!, link, StringComparison.Ordinal);
        string embed = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleVaultFrozenEmbedAdmission), nameof(ArticleVaultFrozenEmbedAdmission.Compare));
        Assert.Contains(typeof(ArticleEmbedAuthoringVerifier).FullName!, embed, StringComparison.Ordinal);
        Assert.DoesNotContain(typeof(ArticleEmbedAuthoringResolver).FullName!, embed, StringComparison.Ordinal);
        string preflight = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleVaultDependencyExecutionPreflight), nameof(ArticleVaultDependencyExecutionPreflight.Verify));
        Assert.Contains(typeof(ArticleVaultDependencyPlanner).FullName!, preflight, StringComparison.Ordinal);
        Assert.Contains(typeof(ArticleVaultExecutionIntegrity).FullName!, preflight, StringComparison.Ordinal);
    }

    [Fact]
    public void CompiledNetworkAndFilesystemMutationsAreDetectedWithoutExecutingThem()
    {
        string forbidden = RuntimeMetadataInspection.DescribeType(typeof(ForbiddenAuthorityMutation));
        Assert.True(HasForbiddenAuthority(forbidden));
        string benign = RuntimeMetadataInspection.DescribeType(typeof(PureCoordinateMutation));
        Assert.False(HasForbiddenAuthority(benign));
    }

    private static bool HasForbiddenAuthority(string compiled)
        => new[]
        {
            "System.Net.Http.HttpClient",
            "System.IO.File.Read",
            "System.IO.File.Write",
            "System.IO.Directory.",
            "System.Diagnostics.Process",
            "SqlSugar",
            "IArticleVaultCanonicalGroupWriter",
            "ArticleVaultSyncPlanExecutor.ExecuteAsync"
        }.Any(forbidden => compiled.Contains(forbidden, StringComparison.Ordinal));

    private static class ForbiddenAuthorityMutation
    {
        public static byte[] ReadUnplannedFile(string path) => File.ReadAllBytes(path);

        public static HttpClient CreateRemoteFetcher() => new();
    }

    private static class PureCoordinateMutation
    {
        public static byte[] EncodeCoordinate(string value) => Encoding.UTF8.GetBytes(value);
    }
}
