using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultRootDescriptor")]
[Trait("Category", "LinuxArticleVaultWatcher")]
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultRootDescriptorTests
{
    [Fact]
    public void MissingRoot_RepeatedFailedAdmissionNeverIssuesScope()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        for (int index = 0; index < 3; index++)
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
                LinuxVaultRootPathScope.Open(root.Path + "-missing", root.Manifest, "descriptor-test-agent"));
            Assert.Equal("linux_vault_root_missing", error.ReasonCode);
        }
    }

    [Fact]
    public void SourceAndDerivedParent_AreNativeIssuedAndRevalidatedWithoutBodyRead()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        using SafeFileHandle source = scope.OpenSourceFile("articles/source.md");
        using SafeFileHandle parent = scope.OpenOwnedParent("articles/source.md");
        Assert.False(source.IsInvalid);
        Assert.False(parent.IsInvalid);
        scope.RevalidateForUse(source);
        scope.RevalidateForUse(parent);
        Assert.True(scope.AnalyzeProjection("articles/source.md", []).RequiresNativeAdmission);
        Assert.Equal("portable-descriptor-source", scope.AnalyzeProjection("articles/source.md", []).PortableArticleIdentity);
    }

    [Fact]
    public void EnumerationDirectory_UnknownSourcesStayDiscoverableAndControlTreeIsRejected()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        Directory.CreateDirectory(Path.Combine(root.Path, "new-source-directory"));
        File.WriteAllText(Path.Combine(root.Path, "new-source-directory", "unregistered.md"), "unknown fixture\n");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        using SafeFileHandle directory = scope.OpenDirectoryForEnumeration("new-source-directory");
        Assert.False(directory.IsInvalid);
        scope.RevalidateForUse(directory);
        Assert.Equal(VaultPathStructuralClass.Blocked,
            scope.AnalyzeProjection("new-source-directory/unregistered.md", []).Classification);
        Assert.Equal("linux_vault_enumeration_directory_invalid", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenDirectoryForEnumeration(".fsus")).ReasonCode);
        Assert.Equal("linux_vault_enumeration_directory_invalid", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenDirectoryForEnumeration(root.Path)).ReasonCode);
        directory.Dispose();
        Assert.Equal("linux_vault_descriptor_not_issued_or_closed", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.RevalidateForUse(directory)).ReasonCode);
    }

    [Fact]
    public void ParentMetadataDescriptor_ServicesDirectoryFlushAndRetainsPathIdentityChecks()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        using SafeFileHandle pathOnly = scope.OpenOwnedParent("articles/source.md");
        Assert.Equal(-1, FlushDirectory(pathOnly));
        Assert.Equal(9, Marshal.GetLastPInvokeError());
        using SafeFileHandle metadata = scope.OpenOwnedParentMetadata("articles/source.md");
        scope.RevalidateForUse(metadata);
        Assert.Equal(0, FlushDirectory(metadata));
        scope.RevalidateForUse(metadata);
    }

    [Fact]
    public void OperationBoundary_CreateTemporaryPreservesAbsentSourceAndDoesNotGrantReplacement()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        File.Delete(Path.Combine(root.Path, "articles", "source.md"));
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        var instruction = new ArticleVaultMaterializationInstruction(
            ArticleVaultMaterializationInstructionCodec.Schema, ArticleVaultMaterializationInstructionCodec.Version,
            scope.Scope.SiteIdentity, scope.Scope.VaultIdentity, scope.Scope.DeviceIdentity, scope.Scope.AgentIdentity,
            "sealed-plan", LinuxVaultTestRoot.DigestA, manifest.ContentSha256, "accepted-result", LinuxVaultTestRoot.DigestA,
            "group-one", "operation-one", "portable-descriptor-source",
            new("articles/source.md", ArticleVaultManifestCodec.ComputeProjectionSha256("articles/source.md")),
            VaultMaterializationSourceAction.Create, null, ArticleVaultManifestCodec.CaptureSourceBytes("new source\n"u8),
            null, LinuxVaultTestRoot.DigestA, "journal-one", string.Empty);
        instruction = instruction with
        {
            ContentSha256 = ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction)
        };
        Assert.Equal("linux_vault_mutation_instruction_binding_invalid", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenMutationBoundary(instruction with { AgentIdentity = "foreign-agent" }, null)).ReasonCode);
        using LinuxVaultMutationBoundary boundary = scope.OpenMutationBoundary(instruction, null);
        using SafeFileHandle temporary = boundary.CreateTemporarySource();
        RandomAccess.Write(temporary, "new source\n"u8, 0);
        RandomAccess.FlushToDisk(temporary);
        scope.RevalidateForUse(temporary);
        Assert.False(File.Exists(Path.Combine(root.Path, "articles", "source.md")));
        Assert.Equal("linux_vault_mutation_temporary_already_created", Assert.Throws<LinuxVaultWatcherException>(
            () => boundary.CreateTemporarySource()).ReasonCode);
        Assert.False(boundary.CanExecuteConditionalReplacement);
        Assert.False(boundary.CanCommitBase);
        Assert.True(boundary.RequiresExternalWriterExclusion);
        boundary.UseParentMetadata(handle => Assert.Equal(0, FlushDirectory(handle)));
        boundary.Dispose();
        Assert.True(temporary.IsClosed);
        Assert.True(File.Exists(Path.Combine(root.Path, boundary.TemporaryRelativePath)));
    }

    [DllImport("libc", EntryPoint = "fsync", SetLastError = true)]
    private static extern int FlushDirectory(SafeFileHandle descriptor);

    [Theory]
    [InlineData("/outside.md")]
    [InlineData("C:/outside.md")]
    [InlineData("articles/../outside.md")]
    [InlineData("articles/%2foutside.md")]
    public void AdmittedScope_RejectsNonRelativeSourceAndParentRequests(string path)
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        Assert.Throws<InvalidDataException>(() => scope.OpenSourceFile(path));
        Assert.Throws<InvalidDataException>(() => scope.OpenOwnedParent(path));
    }

    [Theory]
    [InlineData(".fsus/vault.json")]
    [InlineData("articles")]
    [InlineData("articles/unknown.md")]
    public void AdmittedScope_RejectsControlArbitraryParentAndUnknownSource(string path)
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        LinuxVaultWatcherException source = Assert.Throws<LinuxVaultWatcherException>(() => scope.OpenSourceFile(path));
        LinuxVaultWatcherException parent = Assert.Throws<LinuxVaultWatcherException>(() => scope.OpenOwnedParent(path));
        Assert.Equal("linux_vault_descriptor_source_not_registered", source.ReasonCode);
        Assert.Equal(source.ReasonCode, parent.ReasonCode);
    }

    [Fact]
    public void ClosedAndForeignHandles_CannotReuseAdmission_AndDisposeClosesAllIssuedHandles()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        SafeFileHandle source = scope.OpenSourceFile("articles/source.md");
        source.Dispose();
        Assert.Equal("linux_vault_descriptor_not_issued_or_closed", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.RevalidateForUse(source)).ReasonCode);
        using SafeFileHandle replacement = scope.OpenSourceFile("articles/source.md");
        using SafeFileHandle parent = scope.OpenOwnedParent("articles/source.md");
        using SafeFileHandle callerWrapper = new(replacement.DangerousGetHandle(), ownsHandle: false);
        Assert.Equal("linux_vault_descriptor_not_issued_or_closed", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.RevalidateForUse(callerWrapper)).ReasonCode);
        using LinuxVaultRootPathScope otherScope = LinuxVaultRootPathScope.Open(root.Path, manifest, "other-descriptor-agent");
        Assert.Equal("linux_vault_descriptor_not_issued_or_closed", Assert.Throws<LinuxVaultWatcherException>(
            () => otherScope.RevalidateForUse(replacement)).ReasonCode);

        scope.Dispose();
        scope.Dispose();
        Assert.True(replacement.IsClosed);
        Assert.True(parent.IsClosed);
        Assert.Throws<ObjectDisposedException>(() => scope.RevalidateForUse(replacement));
        Assert.Throws<ObjectDisposedException>(() => scope.OpenSourceFile("articles/source.md"));
        Assert.Throws<ObjectDisposedException>(() => scope.AnalyzeProjection("articles/source.md", []));
    }

    [Fact]
    public void HeldSource_ReplacementAndSymlinkEscapeInvalidateCurrentPath()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        using SafeFileHandle source = scope.OpenSourceFile("articles/source.md");
        string path = Path.Combine(root.Path, "articles", "source.md");
        File.Move(path, path + ".old");
        File.WriteAllText(path, "replacement fixture\n");
        Assert.Equal("linux_vault_descriptor_path_identity_changed", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.RevalidateForUse(source)).ReasonCode);
        File.Delete(path);
        File.CreateSymbolicLink(path, path + ".old");
        Assert.Equal("linux_vault_symlink_rejected", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.RevalidateForUse(source)).ReasonCode);
        Assert.Equal("linux_vault_symlink_rejected", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenSourceFile("articles/source.md")).ReasonCode);
    }

    [Fact]
    public void HeldParent_MovedOutsideRootAndReplacedCannotPassRevalidation()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        using SafeFileHandle parent = scope.OpenOwnedParent("articles/source.md");
        string outside = root.Path + "-moved-parent";
        Directory.Move(Path.Combine(root.Path, "articles"), outside);
        try
        {
            Directory.CreateDirectory(Path.Combine(root.Path, "articles"));
            Assert.Equal("linux_vault_descriptor_path_identity_changed", Assert.Throws<LinuxVaultWatcherException>(
                () => scope.RevalidateForUse(parent)).ReasonCode);
        }
        finally
        {
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public void HeldRoot_ReplacedBySameManifestCannotReuseScope()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        using SafeFileHandle parent = scope.OpenOwnedParent("articles/source.md");
        string moved = root.Path + "-moved-root";
        Directory.Move(root.Path, moved);
        try
        {
            Directory.CreateDirectory(Path.Combine(root.Path, ".fsus"));
            File.WriteAllBytes(Path.Combine(root.Path, ArticleVaultSchemas.RootManifestPath),
                ArticleVaultManifestCodec.Serialize(manifest));
            Assert.Equal("linux_vault_root_descriptor_identity_changed", Assert.Throws<LinuxVaultWatcherException>(
                () => scope.RevalidateForUse(parent)).ReasonCode);
        }
        finally
        {
            Directory.Delete(moved, recursive: true);
        }
    }

    [Fact]
    public void LiveDescriptorLimit_IsFailClosedAndClosedSlotCanBeReused()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        SafeFileHandle[] issued = Enumerable.Range(0, 64).Select(_ => scope.OpenOwnedParent("articles/source.md")).ToArray();
        Assert.Equal("linux_vault_descriptor_limit_exceeded", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenOwnedParent("articles/source.md")).ReasonCode);
        issued[0].Dispose();
        using SafeFileHandle reused = scope.OpenOwnedParent("articles/source.md");
        Assert.Equal("linux_vault_descriptor_not_issued_or_closed", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.RevalidateForUse(issued[0])).ReasonCode);
        scope.RevalidateForUse(reused);
        scope.Dispose();
        Assert.All(issued, static descriptor => Assert.True(descriptor.IsClosed));
    }

    [Fact]
    public void RealCasefoldSourceParent_IsRejectedByDirectoryMetadataProbe()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest manifest = RegisterSource(root, "articles/source.md");
        File.Delete(Path.Combine(root.Path, "articles", "source.md"));
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, manifest, "descriptor-test-agent");
        var start = new ProcessStartInfo("chattr")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add("+F");
        start.ArgumentList.Add(Path.Combine(root.Path, "articles"));
        using Process process = Process.Start(start) ?? throw new InvalidOperationException("casefold fixture could not start");
        if (!process.WaitForExit(5000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            Assert.Fail("casefold fixture setup did not terminate");
        }
        Assert.True(process.ExitCode == 0, "casefold fixture requires chattr and a filesystem with casefold enabled");
        File.WriteAllText(Path.Combine(root.Path, "articles", "source.md"), "casefold fixture only\n");

        Assert.Equal("linux_vault_directory_casefold_unsupported", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenSourceFile("articles/source.md")).ReasonCode);
        Assert.Equal("linux_vault_directory_casefold_unsupported", Assert.Throws<LinuxVaultWatcherException>(
            () => scope.OpenOwnedParent("articles/source.md")).ReasonCode);
    }

    private static ArticleVaultRootManifest RegisterSource(LinuxVaultTestRoot root, string sourceRelativePath)
    {
        string source = Path.Combine(root.Path, sourceRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllText(source, "descriptor fixture only\n");
        ArticleVaultRootManifest unsealed = root.Manifest with
        {
            Articles = [new VaultArticleReference("portable-descriptor-source",
                ".fsus/articles/portable-descriptor-source.json", LinuxVaultTestRoot.DigestA, sourceRelativePath)],
            ContentSha256 = string.Empty
        };
        ArticleVaultRootManifest manifest = unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
        File.WriteAllBytes(Path.Combine(root.Path, ArticleVaultSchemas.RootManifestPath),
            ArticleVaultManifestCodec.Serialize(manifest));
        return manifest;
    }
}

[Trait("Category", "LinuxArticleVaultRootPath")]
public sealed class LinuxVaultRootOperationApiBoundaryTests
{
    [Fact]
    public void NativeScopeAndOperationCannotBeConstructedFromSerializedBindingsOrAbsolutePerCommandRoots()
    {
        Assert.Empty(typeof(LinuxVaultMutationBoundary).GetConstructors());
        Assert.Empty(typeof(LinuxVaultRootPathScope).GetConstructors());
        MethodInfo factory = typeof(LinuxVaultRootPathScope).GetMethod(nameof(LinuxVaultRootPathScope.OpenMutationBoundary))!;
        Assert.Equal([typeof(ArticleVaultMaterializationInstruction), typeof(VaultFileMetadataObservation)],
            factory.GetParameters().Select(static parameter => parameter.ParameterType));
        Assert.Equal(typeof(SafeFileHandle), typeof(LinuxVaultRootPathScope)
            .GetMethod(nameof(LinuxVaultRootPathScope.OpenDirectoryForEnumeration))!.ReturnType);
        Assert.DoesNotContain(typeof(LinuxVaultMutationBoundary).GetMethods(BindingFlags.Public | BindingFlags.Instance),
            static method => method.Name is "ReplaceSource" or "CommitBase" or "DeleteSource" or "AuthorizeWriter");
    }
}
