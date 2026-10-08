using System.Reflection;
using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

using Xunit;

namespace FsusBlog.ArticleVault.Windows.Tests;

[Trait("Category", "WindowsArticleVaultRootPath")]
[Trait("Category", "WindowsArticleVaultWatcher")]
public sealed class WindowsVaultRootPathScopeTests
{
    [Fact]
    public void ScopeCannotBeConstructedFromCallerFactsOrSerializedReceipt()
    {
        Assert.Empty(typeof(WindowsVaultRootPathScope).GetConstructors());
        MethodInfo[] factories = typeof(WindowsVaultRootPathScope).GetMethods(BindingFlags.Public | BindingFlags.Static);
        Assert.Single(factories, static method => method.Name == "Open");
        Assert.DoesNotContain(factories, static method => method.GetParameters().Any(parameter =>
            parameter.ParameterType == typeof(VaultPathStructuralScope)
                || parameter.ParameterType == typeof(WindowsVaultWatchIdentity)
                || parameter.ParameterType == typeof(SafeFileHandle)));
        Assert.DoesNotContain(typeof(WindowsVaultRootPathScope).GetMethods(BindingFlags.Public | BindingFlags.Instance),
            static method => method.ReturnType == typeof(SafeFileHandle));
    }

    [Fact]
    public void OtherHostCannotMintWindowsAdmission()
    {
        if (OperatingSystem.IsWindows())
        {
            using RootFixture root = new();
            using WindowsVaultRootPathScope scope = root.Open();
            Assert.True(scope.AnalyzeProjection("articles/first.md", []).RequiresNativeAdmission);
            return;
        }

        Assert.Throws<PlatformNotSupportedException>(() => WindowsVaultRootPathScope.Open(
            "C:\\unverified-root", Manifest(), "agent-test"));
    }

    [Fact]
    public void RealNtfsScopeClassifiesManifestPathsWithoutGrantingSourceBytes()
    {
        using RootFixture root = new();
        using WindowsVaultRootPathScope scope = root.Open();
        VaultPathStructuralAnalysis result = scope.AnalyzeProjection("articles/first.md", []);
        Assert.Equal(VaultPathStructuralClass.ManifestSourceProjection, result.Classification);
        Assert.Equal("portable-a", result.PortableArticleIdentity);
        Assert.True(result.RequiresNativeAdmission);
        Assert.Equal(VaultPathComparisonPolicy.OrdinalIgnoreCase, scope.Scope.ComparisonPolicy);
        Assert.Equal(WindowsVaultPathDisposition.Source, scope.RevalidatePath("articles/first.md").Disposition);
        Assert.False(scope.CreateWatchIdentity("watch-test").CaseSensitive);
    }

    [Theory]
    [InlineData("C:\\outside.md")]
    [InlineData("\\\\server\\share\\outside.md")]
    [InlineData("/outside.md")]
    [InlineData("../outside.md")]
    [InlineData("articles%2ffirst.md")]
    [InlineData("articles\\first.md")]
    public void RealNtfsRelativeUseRejectsRootedTraversalAndEncodedAliases(string path)
    {
        using RootFixture root = new();
        using WindowsVaultRootPathScope scope = root.Open();
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath(path).Disposition);
    }

    [Fact]
    public void RealNtfsCaseCollisionIsStructuredAndNoWinnerIsSelected()
    {
        using RootFixture root = new();
        using WindowsVaultRootPathScope scope = root.Open();
        VaultPathStructuralAnalysis result = scope.AnalyzeProjection("articles/first.md",
            ["articles/first.md", "articles/FIRST.md"]);
        Assert.Equal(VaultPathStructuralClass.Blocked, result.Classification);
        Assert.NotEmpty(result.Collisions);
        Assert.Null(result.PortableArticleIdentity);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath("articles/FIRST.md").Disposition);
    }

    [Fact]
    public void RealNtfsControlTreeDoesNotEnterOrdinarySourceDiscovery()
    {
        using RootFixture root = new();
        using WindowsVaultRootPathScope scope = root.Open();
        VaultPathStructuralAnalysis result = scope.AnalyzeProjection(ArticleVaultSchemas.RootManifestPath, []);
        Assert.Equal(VaultPathStructuralClass.RegisteredControlPath, result.Classification);
        Assert.Equal("windows_vault_control_path_reserved", scope.RevalidatePath(ArticleVaultSchemas.RootManifestPath).ReasonCode);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath(".FSUS/vault.json").Disposition);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath(".fsus/unknown.tmp").Disposition);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath("articles/first.md.bak").Disposition);
    }

    [Fact]
    public void RealNtfsActualControlBytesAndManifestIdentityMustStayBound()
    {
        using RootFixture root = new();
        using WindowsVaultRootPathScope scope = root.Open();
        byte[] serialized = ArticleVaultManifestCodec.Serialize(root.Manifest);
        File.WriteAllBytes(root.ControlPath, serialized.Concat(new byte[] { 0x20 }).ToArray());
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidateRoot().Disposition);
        Assert.Throws<IOException>(() => scope.DuplicateRootHandleForWatcher());
    }

    [Fact]
    public void RealNtfsCrossSiteManifestCannotReuseExistingRoot()
    {
        using RootFixture root = new();
        ArticleVaultRootManifest other = Seal(root.Manifest with
        {
            SiteIdentity = "other-site",
            ContentSha256 = string.Empty
        });
        Assert.Throws<InvalidDataException>(() => WindowsVaultRootPathScope.Open(root.Path, other, "agent-test"));
    }

    [Fact]
    public void RealNtfsRootSymlinkAndReparseDescendantAreRejected()
    {
        using RootFixture root = new();
        string link = root.Path + "-link";
        Directory.CreateSymbolicLink(link, root.Path);
        try
        {
            Assert.ThrowsAny<IOException>(() => WindowsVaultRootPathScope.Open(link, root.Manifest, "agent-test"));
        }
        finally
        {
            Directory.Delete(link);
        }

        using WindowsVaultRootPathScope scope = root.Open();
        File.Delete(System.IO.Path.Combine(root.Path, "articles", "first.md"));
        File.CreateSymbolicLink(System.IO.Path.Combine(root.Path, "articles", "first.md"), root.ControlPath);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath("articles/first.md").Disposition);
    }

    [Fact]
    public void RealNtfsUseBoundaryOwnsDuplicateAndFailsAfterScopeDisposal()
    {
        using RootFixture root = new();
        WindowsVaultRootPathScope scope = root.Open();
        using SafeFileHandle duplicate = scope.DuplicateRootHandleForWatcher();
        Assert.False(duplicate.IsInvalid);
        scope.Dispose();
        scope.Dispose();
        Assert.False(duplicate.IsClosed);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidateRoot().Disposition);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath("articles/first.md").Disposition);
        Assert.Throws<ObjectDisposedException>(() => scope.DuplicateRootHandleForWatcher());
    }

    [Fact]
    public void RealNtfsPinnedRootCannotBeReplacedOrRenamedWhileAdmitted()
    {
        using RootFixture root = new();
        using WindowsVaultRootPathScope scope = root.Open();
        Assert.ThrowsAny<IOException>(() => Directory.Move(root.Path, root.Path + "-replaced"));
        Assert.Equal(WindowsVaultPathDisposition.Source, scope.RevalidateRoot().Disposition);
    }

    [Fact]
    public void RealNtfsCaseSensitiveDescendantIsUnsupportedRatherThanGuessed()
    {
        using RootFixture root = new();
        string sourcePath = System.IO.Path.Combine(root.Path, "articles", "first.md");
        File.Delete(sourcePath);
        using (SafeFileHandle directory = OpenCaseDirectory(System.IO.Path.Combine(root.Path, "articles"),
            0x100, 3, 0, 3, 0x02000000 | 0x00200000, 0))
        {
            Assert.False(directory.IsInvalid);
            uint flags = 1;
            Assert.True(SetCaseInformation(directory, 23, ref flags, sizeof(uint)),
                "The real native case-mode negative control could not be installed.");
        }

        File.WriteAllText(sourcePath, "fixture source sentinel");
        using WindowsVaultRootPathScope scope = root.Open();
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidatePath("articles/first.md").Disposition);
    }

    [Fact]
    public async Task RealNtfsConcurrentCallbacksAndDisposalNeverReuseReleasedHandles()
    {
        using RootFixture root = new();
        WindowsVaultRootPathScope scope = root.Open();
        Task[] callbacks = Enumerable.Range(0, 16).Select(_ => Task.Run(() =>
        {
            WindowsVaultPathAdmission result = scope.RevalidateRoot();
            Assert.Contains(result.Disposition, new[] { WindowsVaultPathDisposition.Source, WindowsVaultPathDisposition.Blocked });
        })).ToArray();
        scope.Dispose();
        await Task.WhenAll(callbacks);
        Assert.Equal(WindowsVaultPathDisposition.Blocked, scope.RevalidateRoot().Disposition);
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenCaseDirectory(string path, uint access, uint share,
        nint attributes, uint disposition, uint flags, nint template);

    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCaseInformation(SafeFileHandle handle, int informationClass, ref uint information, uint size);

    private static ArticleVaultRootManifest Manifest()
        => Seal(new(ArticleVaultSchemas.RootManifest, ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "site-alpha", "vault-alpha", "device-alpha",
            [new("portable-a", ".fsus/articles/portable-a.json", new string('a', 64), "articles/first.md")], [], string.Empty));

    private static ArticleVaultRootManifest Seal(ArticleVaultRootManifest manifest)
        => manifest with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(manifest)
        };

    private sealed class RootFixture : IDisposable
    {
        internal RootFixture()
        {
            if (!OperatingSystem.IsWindows())
            {
                throw new PlatformNotSupportedException("windows_vault_requires_real_windows_ntfs");
            }

            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsusblog-root-path-" + Guid.NewGuid().ToString("N"));
            Manifest = WindowsVaultRootPathScopeTests.Manifest();
            try
            {
                Directory.CreateDirectory(System.IO.Path.Combine(Path, ".fsus"));
                Directory.CreateDirectory(System.IO.Path.Combine(Path, "articles"));
                File.WriteAllBytes(ControlPath, ArticleVaultManifestCodec.Serialize(Manifest));
                File.WriteAllText(System.IO.Path.Combine(Path, "articles", "first.md"), "fixture source sentinel");
                using SafeFileHandle nativeRoot = WindowsVaultRootPathNative.OpenDrive("\\\\?\\" + Path);
                Path = WindowsVaultRootPathNative.Inspect(nativeRoot).FinalPath;
            }
            catch
            {
                if (Directory.Exists(Path))
                {
                    Directory.Delete(Path, true);
                }

                throw;
            }
        }

        internal string Path
        {
            get;
        }
        internal ArticleVaultRootManifest Manifest
        {
            get;
        }
        internal string ControlPath => System.IO.Path.Combine(Path, ArticleVaultSchemas.RootManifestPath.Replace('/', '\\'));
        internal WindowsVaultRootPathScope Open() => WindowsVaultRootPathScope.Open(Path, Manifest, "agent-test");

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, true);
            }
        }
    }
}
