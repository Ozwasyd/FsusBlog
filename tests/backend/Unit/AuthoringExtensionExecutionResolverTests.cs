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
            new ExactModuleVerifier(true));

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
            new ExactModuleVerifier(true));

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
            new ExactModuleVerifier(true));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux,
            new string('0', 64));

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedIdentityDrift, result.Status);
        Assert.Equal("runtime-identity-drift", result.BlockedReason);
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
            "authoring-maintainers");
        var registry = new ClosedTrustedAuthoringAdapterRegistry([descriptor]);

        AuthoringExecutionTarget mismatch = await new AuthoringExecutionResolver(
            registry,
            new ExactModuleVerifier(false)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.ServerLinux);
        AuthoringExecutionTarget ready = await new AuthoringExecutionResolver(
            registry,
            new ExactModuleVerifier(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.ServerLinux);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnregisteredAdapter, mismatch.Status);
        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, ready.Status);
        Assert.Equal(descriptor.AdapterId, ready.TrustedAdapterId);
    }

    [Fact]
    public void Registry_UnownedSourceOrDuplicateAdapter_FailsClosed()
    {
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor();

        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { SourcePath = "plugins/adapter.cs" }]));
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
        "authoring-maintainers");

    private static async ValueTask<VerifiedAuthoringPackage> CreateVerifiedPackageAsync(
        AuthoringExecutionClass executionClass,
        AuthoringEntrypointFormat format,
        string path,
        string publisher = "acme",
        string? entrypointDigest = null)
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
        return await verifier.VerifyAsync(artifact, AuthoringHostPlatform.ServerLinux);
    }

    private sealed class ExactModuleVerifier(bool exact) : ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsLoadedModuleExactAsync(
            TrustedAuthoringAdapterDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult(exact);
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
