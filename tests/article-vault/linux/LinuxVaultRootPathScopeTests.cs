using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultRootPath")]
[Trait("Category", "LinuxArticleVaultWatcher")]
public sealed class LinuxVaultRootPathScopeTests
{
    [Fact]
    public void InitialRootSymlink_IsRejectedByExistingNativeAuthority()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string link = root.Path + "-path-scope-link";
        Directory.CreateSymbolicLink(link, root.Path);
        try
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(
                () => LinuxVaultRootPathScope.Open(link, root.Manifest, "root-path-test-agent"));
            Assert.Equal("linux_vault_root_symlink_rejected", error.ReasonCode);
        }
        finally
        {
            Directory.Delete(link);
        }
    }

    [Fact]
    public void AdmittedScope_UsesRelativeControlPathAndRechecksRootManifestDrift()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "root-path-test-agent");
        VaultPathStructuralAnalysis result = scope.AnalyzeProjection(ArticleVaultSchemas.RootManifestPath, []);
        Assert.Equal(VaultPathStructuralClass.RegisteredControlPath, result.Classification);
        Assert.True(result.RequiresNativeAdmission);
        Assert.Equal(root.Manifest.ContentSha256, scope.Scope.RootManifestSha256);

        ArticleVaultRootManifest changed = root.Manifest with
        {
            DeviceIdentity = "other-device",
            ContentSha256 = string.Empty
        };
        changed = changed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(changed)
        };
        File.WriteAllBytes(Path.Combine(root.Path, ArticleVaultSchemas.RootManifestPath),
            ArticleVaultManifestCodec.Serialize(changed));

        LinuxVaultWatcherException failure = Assert.Throws<LinuxVaultWatcherException>(
            () => scope.AnalyzeProjection(ArticleVaultSchemas.RootManifestPath, []));
        Assert.Equal("linux_vault_root_manifest_binding_mismatch", failure.ReasonCode);
    }

    [Fact]
    public void AdmittedScope_RejectsAbsolutePathAndNativeSymlinkDescendant()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "root-path-test-agent");
        Assert.Throws<InvalidDataException>(() => scope.AnalyzeProjection(root.Path, []));
        Directory.CreateSymbolicLink(Path.Combine(root.Path, "escape"), Path.GetDirectoryName(root.Path)!);

        LinuxVaultWatcherException failure = Assert.Throws<LinuxVaultWatcherException>(
            () => scope.AnalyzeProjection(ArticleVaultSchemas.RootManifestPath, ["escape/outside.md"]));
        Assert.Equal("linux_vault_symlink_rejected", failure.ReasonCode);
    }
}
