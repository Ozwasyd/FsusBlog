using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionExecutionResolverTests
{
    [Fact]
    public async Task ResolveAsync_ThirdPartyTrustedAdapter_FailsClosed()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.TrustedHostAdapter,
            AuthoringEntrypointFormat.HostAdapterIdentity,
            "fsusblog.authoring.adapter.command");
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resolver.ResolveAsync(package, "acme.command.format", AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task ResolveAsync_UnsupportedClass_ReturnsBlockedWithoutFallback()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.OutOfProcessService,
            AuthoringEntrypointFormat.ServiceExecutable,
            "service/main");
        AuthoringExtensionManifest browserManifest = package.Contract.Manifest with
        {
            SupportedPlatforms = [AuthoringHostPlatform.Browser]
        };
        package = package with
        {
            Contract = AuthoringExtensionContractValidator.Verify(browserManifest, AuthoringHostPlatform.Browser)
        };
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.Browser);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform, result.Status);
        Assert.Equal(AuthoringExecutionClass.OutOfProcessService, result.ExecutionClass);
        Assert.Null(result.TrustedAdapterId);
    }

    [Fact]
    public async Task ResolveAsync_WorkerIdentityDrift_ReturnsStableBlockedResult()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.IsolatedWorkerWasm,
            AuthoringEntrypointFormat.WasmModule,
            "worker/main.wasm");
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux,
            new string('0', 64));

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedIdentityDrift, result.Status);
        Assert.Equal("runtime-identity-drift", result.BlockedReason);
    }

    [Fact]
    public async Task ResolveAsync_PackageNotActive_ReturnsStableBlockedResult()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.IsolatedWorkerWasm,
            AuthoringEntrypointFormat.WasmModule,
            "worker/main.wasm");
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(false));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedPackageNotActive, result.Status);
        Assert.Equal("package-not-active", result.BlockedReason);
        Assert.Empty(result.RuntimeIdentity);
    }

    [Fact]
    public async Task ResolveAsync_OwnedAdapter_RequiresExactLoadedModule()
    {
        string digest = new string('c', 64);
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.TrustedHostAdapter,
            AuthoringEntrypointFormat.HostAdapterIdentity,
            "fsusblog.authoring.adapter.command",
            publisher: "fsusblog",
            entrypointDigest: digest);
        var descriptor = new TrustedAuthoringAdapterDescriptor(
            "fsusblog.authoring.adapter.command",
            "acme.command.format",
            AuthoringContributionKind.Command,
            1,
            "src/backend/Infrastructure/AuthoringExtensions/CommandAdapter.cs",
            digest,
            "FsusBlog.Server",
            new string('d', 64),
            "authoring-maintainers",
            [AuthoringHostPlatform.ServerLinux]);
        var registry = new ClosedTrustedAuthoringAdapterRegistry([descriptor]);

        AuthoringExecutionTarget mismatch = await new AuthoringExecutionResolver(
            registry,
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(false),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.ServerLinux);
        AuthoringExecutionTarget ready = await new AuthoringExecutionResolver(
            registry,
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.ServerLinux);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnregisteredAdapter, mismatch.Status);
        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, ready.Status);
        Assert.Equal(descriptor.AdapterId, ready.TrustedAdapterId);
        Assert.Matches("^[0-9a-f]{64}$", ready.TrustedAdapterIdentity);
    }

    [Fact]
    public async Task ResolveAsync_TrustedAdapterPlatformAndDescriptorDrift_FailClosed()
    {
        string digest = new string('c', 64);
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.TrustedHostAdapter,
            AuthoringEntrypointFormat.HostAdapterIdentity,
            "fsusblog.authoring.adapter.command",
            publisher: "fsusblog",
            entrypointDigest: digest,
            targetPlatform: AuthoringHostPlatform.Browser);
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor() with
        {
            SourceSha256 = digest,
            SupportedPlatforms = [AuthoringHostPlatform.ServerLinux]
        };
        var unsupported = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([descriptor]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        AuthoringExecutionTarget blocked = await unsupported.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.Browser);
        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform, blocked.Status);
        Assert.Equal("trusted-adapter-platform-unsupported", blocked.BlockedReason);

        TrustedAuthoringAdapterDescriptor browserDescriptor = descriptor with
        {
            SupportedPlatforms = [AuthoringHostPlatform.Browser]
        };
        AuthoringExecutionTarget original = await new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([browserDescriptor]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.Browser);
        AuthoringExecutionTarget changed = await new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry(
                [browserDescriptor with { ReviewOwner = "security-reviewers" }]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.Browser);

        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, original.Status);
        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, changed.Status);
        Assert.NotEqual(original.TrustedAdapterIdentity, changed.TrustedAdapterIdentity);
        Assert.NotEqual(original.RuntimeIdentity, changed.RuntimeIdentity);
    }

    [Fact]
    public async Task LoadedModuleVerifier_HashesActualLoadedAssemblyWithoutLoadingCode()
    {
        var assembly = typeof(AuthoringExecutionResolver).Assembly;
        string location = assembly.Location;
        Assert.False(string.IsNullOrWhiteSpace(location));
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(location)));
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor() with
        {
            ModuleName = assembly.GetName().Name!,
            ModuleSha256 = digest
        };
        var verifier = new LoadedAssemblyTrustedAuthoringAdapterModuleVerifier();

        Assert.True(await verifier.IsLoadedModuleExactAsync(descriptor, default));
        Assert.False(await verifier.IsLoadedModuleExactAsync(
            descriptor with { ModuleSha256 = new string('0', 64) },
            default));
    }

    [Fact]
    public async Task CheckedInSourceVerifier_HashesActualOwnedSourceAndRejectsDrift()
    {
        const string relativePath =
            "src/backend/Infrastructure/AuthoringExtensions/AuthoringExtensionExecutionResolver.cs";
        string sourcePath = Path.Combine(BackendTestPaths.RepositoryRoot, relativePath);
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(sourcePath)));
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor() with
        {
            SourcePath = relativePath,
            SourceSha256 = digest
        };
        var verifier = new CheckedInAuthoringAdapterSourceVerifier(BackendTestPaths.RepositoryRoot);

        Assert.True(await verifier.IsCheckedInSourceExactAsync(descriptor, default));
        Assert.False(await verifier.IsCheckedInSourceExactAsync(
            descriptor with { SourceSha256 = new string('0', 64) },
            default));
    }

    [Fact]
    public async Task InstalledPackageAuthority_BindsExactActivePackageIdentity()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.IsolatedWorkerWasm,
            AuthoringEntrypointFormat.WasmModule,
            "worker/main.wasm");
        var authority = new ActiveAuthoringInstalledPackageAuthority(new InstalledPackageStore(package));

        Assert.True(await authority.IsActiveExactAsync(package, default));
        Assert.False(await authority.IsActiveExactAsync(
            package with { PackageIdentity = new string('0', 64) },
            default));
    }

    [Fact]
    public void Registry_UnownedSourceOrDuplicateAdapter_FailsClosed()
    {
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor();

        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { SourcePath = "plugins/adapter.cs" }]));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { SupportedPlatforms = [] }]));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor, descriptor]));
    }

    [Fact]
    public void ResolverSource_HasNoDynamicOrPrivateHostLoadingSurface()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions/AuthoringExtensionExecutionResolver.cs"));

        Assert.DoesNotContain("Assembly.Load", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Activator.CreateInstance", source, StringComparison.Ordinal);
        Assert.DoesNotContain("editorRef", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Pinia", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IServiceProvider", source, StringComparison.Ordinal);
        Assert.DoesNotContain("WebView", source, StringComparison.Ordinal);
        Assert.DoesNotContain("iframe", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("object Payload", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Func<", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Action<", source, StringComparison.Ordinal);
        Assert.DoesNotContain("dynamic ", source, StringComparison.Ordinal);
    }

    private static TrustedAuthoringAdapterDescriptor CreateDescriptor() => new(
        "fsusblog.authoring.adapter.command",
        "acme.command.format",
        AuthoringContributionKind.Command,
        1,
        "src/backend/Infrastructure/AuthoringExtensions/CommandAdapter.cs",
        new string('c', 64),
        "FsusBlog.Server",
        new string('d', 64),
        "authoring-maintainers",
        [AuthoringHostPlatform.ServerLinux]);

    private static async ValueTask<VerifiedAuthoringPackage> CreateVerifiedPackageAsync(
        AuthoringExecutionClass executionClass,
        AuthoringEntrypointFormat format,
        string path,
        string publisher = "acme",
        string? entrypointDigest = null,
        AuthoringHostPlatform targetPlatform = AuthoringHostPlatform.ServerLinux)
    {
        byte[] archive = "archive"u8.ToArray();
        byte[] entryBytes = "entry"u8.ToArray();
        string entryDigest = entrypointDigest ?? Convert.ToHexStringLower(SHA256.HashData(entryBytes));
        ImmutableArray<AuthoringPackageEntry> entries = executionClass == AuthoringExecutionClass.TrustedHostAdapter
            ? [new AuthoringPackageEntry("content/data", ImmutableArray.Create(entryBytes), Convert.ToHexStringLower(SHA256.HashData(entryBytes)))]
            : [new AuthoringPackageEntry(path, ImmutableArray.Create(entryBytes), entryDigest)];
        AuthoringContributionDeclaration contribution = AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
        {
            ExecutionClass = executionClass,
            Entrypoint = new AuthoringEntrypointIdentity(format, path, entryDigest)
        };
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Publisher = publisher,
            SupportedPlatforms = [targetPlatform],
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [contribution]
        };
        ImmutableArray<byte> manifestBytes = ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest));
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            [1],
            publisher,
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive)));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var verifier = new AuthoringPackageVerifier(
            new TrustedVerifier(now),
            new ArchiveReader(new AuthoringPackageArchiveContents(manifestBytes, entries)),
            new FixedTimeProvider(now));
        return await verifier.VerifyAsync(artifact, targetPlatform);
    }

    private sealed class ExactModuleVerifier(bool exact) : ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsLoadedModuleExactAsync(
            TrustedAuthoringAdapterDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult(exact);
    }

    private sealed class ExactSourceVerifier(bool exact) : ITrustedAuthoringAdapterSourceVerifier
    {
        public ValueTask<bool> IsCheckedInSourceExactAsync(
            TrustedAuthoringAdapterDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult(exact);
    }

    private sealed class ExactInstalledPackageAuthority(bool active) : IAuthoringInstalledPackageAuthority
    {
        public ValueTask<bool> IsActiveExactAsync(
            VerifiedAuthoringPackage package,
            CancellationToken cancellationToken) => ValueTask.FromResult(active);
    }

    private sealed class InstalledPackageStore(VerifiedAuthoringPackage active) : IAuthoringPackageStore
    {
        public ValueTask<VerifiedAuthoringPackage?> GetActiveAsync(
            string extensionId,
            CancellationToken cancellationToken) => ValueTask.FromResult<VerifiedAuthoringPackage?>(active);

        public ValueTask<bool> ContainsAsync(string packageIdentity, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask StageAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask ActivateAsync(
            string extensionId,
            string packageIdentity,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask DeactivateAsync(
            string extensionId,
            string expectedPackageIdentity,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask RemoveStagedAsync(string packageIdentity, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask AssertContentUnchangedAsync(
            string packageIdentity,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class TrustedVerifier(DateTimeOffset now) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                publisher,
                keyId,
                now,
                now.AddMinutes(5),
                new string('d', 64)));
    }

    private sealed class ArchiveReader(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(
            ReadOnlyMemory<byte> canonicalArchive,
            CancellationToken cancellationToken) => ValueTask.FromResult(contents);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
