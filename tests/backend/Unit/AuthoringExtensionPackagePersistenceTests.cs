using System.Collections.Immutable;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionPackagePersistenceTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 4, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Install_RealArchiveAndStores_RecoversFromFreshInstances()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime first = CreateRuntime(directory.Path, fixture.Trust);

        AuthoringPackageReceipt receipt = await first.Activation.InstallOrUpdateAsync(fixture.Artifact);

        Assert.Equal(AuthoringPackageOutcome.Committed, receipt.Outcome);
        Assert.Equal(fixture.Artifact.ArchiveSha256, receipt.ArchiveSha256);
        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");
        Assert.NotNull(recovered);
        Assert.Equal(receipt.PackageIdentity, recovered.PackageIdentity);
        Assert.Equal("1.0.0", recovered.Contract.Manifest.Version);
        Assert.True(await fresh.Store.ContainsAsync(recovered.PackageIdentity, default));
    }

    [Fact]
    public async Task LocalComposition_EcdsaApprovedSourceInstallAndUninstall_AreReceiptBound()
    {
        using var directory = new TemporaryDirectory();
        using ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        PackageFixture fixture = CreatePackage("1.0.0", "signed payload");
        byte[] signature = signer.SignData(
            fixture.Artifact.CanonicalArchive.AsSpan(),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        AuthoringPackageArtifact artifact = fixture.Artifact with
        {
            Signature = ImmutableArray.Create(signature)
        };
        var key = new AuthoringPackagePublisherKey(
            "acme",
            "key-1",
            ImmutableArray.Create(signer.ExportSubjectPublicKeyInfo()),
            s_now.AddHours(-1),
            s_now.AddHours(1));
        LocalAuthoringPackageRuntime runtime = LocalAuthoringPackageComposition.Create(
            directory.Path,
            AuthoringHostPlatform.ServerLinux,
            [key],
            [artifact],
            new FixedTimeProvider(s_now));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await runtime.Activation.InstallOrUpdateAsync(artifact));
        AuthoringPackageReceipt installed = await runtime.Activation.InstallOrUpdateFromSourceAsync(
            artifact.SourceReference);
        AuthoringPackageReceipt uninstalled = await runtime.Activation.UninstallPackageAsync(
            "acme.author-tools");

        Assert.Equal(AuthoringPackageTrustStatus.Trusted, installed.TrustStatus);
        Assert.Matches("^[0-9a-f]{64}$", installed.KeysetIdentity);
        Assert.Equal(AuthoringPackageOperation.Uninstall, uninstalled.Operation);
        Assert.Equal(AuthoringPackageOutcome.Committed, uninstalled.Outcome);
        Assert.Equal(installed.PackageIdentity, uninstalled.PreviousPackageIdentity);
        Assert.Null(await runtime.Store.GetActiveAsync("acme.author-tools", default));
        Assert.True(await runtime.Store.ContainsAsync(installed.PackageIdentity, default));

        await runtime.Store.ActivateAsync("acme.author-tools", installed.PackageIdentity, default);
        LocalAuthoringPackageRuntime fresh = LocalAuthoringPackageComposition.Create(
            directory.Path,
            AuthoringHostPlatform.ServerLinux,
            [key],
            [artifact],
            new FixedTimeProvider(s_now));
        Assert.Null(await fresh.Activation.RecoverActiveAsync("acme.author-tools"));
        Assert.Null(await fresh.Store.GetActiveAsync("acme.author-tools", default));
    }

    [Fact]
    public async Task EcdsaTrustVerifier_UnknownRevokedExpiredAndBadSignature_FailClosed()
    {
        using ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        byte[] publicKey = signer.ExportSubjectPublicKeyInfo();
        byte[] archive = Encoding.UTF8.GetBytes("archive");
        byte[] signature = signer.SignData(
            archive,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var unknown = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset([]),
            new FixedTimeProvider(s_now));
        var revoked = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset(
            [
                new AuthoringPackagePublisherKey(
                    "acme",
                    "key-1",
                    ImmutableArray.Create(publicKey),
                    s_now.AddHours(-2),
                    s_now.AddHours(1),
                    s_now.AddMinutes(-1))
            ]),
            new FixedTimeProvider(s_now));
        var expired = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset(
            [
                new AuthoringPackagePublisherKey(
                    "acme",
                    "key-1",
                    ImmutableArray.Create(publicKey),
                    s_now.AddHours(-2),
                    s_now.AddHours(-1))
            ]),
            new FixedTimeProvider(s_now));
        var valid = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset(
            [
                new AuthoringPackagePublisherKey(
                    "acme",
                    "key-1",
                    ImmutableArray.Create(publicKey),
                    s_now.AddHours(-1),
                    s_now.AddHours(1))
            ]),
            new FixedTimeProvider(s_now));

        Assert.Equal(
            AuthoringPackageTrustStatus.UnknownPublisher,
            (await unknown.VerifyAsync("acme", "key-1", archive, signature, default)).Status);
        Assert.Equal(
            AuthoringPackageTrustStatus.Revoked,
            (await revoked.VerifyAsync("acme", "key-1", archive, signature, default)).Status);
        Assert.Equal(
            AuthoringPackageTrustStatus.Expired,
            (await expired.VerifyAsync("acme", "key-1", archive, signature, default)).Status);
        Assert.Equal(
            AuthoringPackageTrustStatus.Untrusted,
            (await valid.VerifyAsync("acme", "key-1", archive, new byte[64], default)).Status);
    }

    [Fact]
    public void PackageStaticGovernance_HasNoRemoteSelfUpdateOrSecondStoreComposition()
    {
        string root = Path.Combine(
            TestInfrastructure.BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions");
        string packages = File.ReadAllText(Path.Combine(root, "AuthoringExtensionPackages.cs"));
        string activation = File.ReadAllText(Path.Combine(root, "AuthoringPackageProductionActivation.cs"));
        string source = string.Concat(packages, "\n", activation);

        Assert.DoesNotContain("new HttpClient", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Assembly.Load", source, StringComparison.Ordinal);
        Assert.Contains("\"github_pat_\"", packages, StringComparison.Ordinal);
        Assert.Equal(1, activation.Split("new LocalAuthoringPackageStore(", StringSplitOptions.None).Length - 1);
    }

    [Fact]
    public async Task Recover_UncommittedSwitch_RestoresExactPreviousPackageAndRecordsRollback()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture firstPackage = CreatePackage("1.0.0", "first payload");
        PackageFixture nextPackage = CreatePackage("2.0.0", "next payload");
        ProductionRuntime first = CreateRuntime(directory.Path, firstPackage.Trust);
        AuthoringPackageReceipt committed = await first.Activation.InstallOrUpdateAsync(firstPackage.Artifact);
        VerifiedAuthoringPackage next = await first.Verifier.VerifyAsync(
            nextPackage.Artifact,
            AuthoringHostPlatform.ServerLinux);
        await first.Store.StageAsync(next, default);
        await first.Store.ActivateAsync(next.Contract.Manifest.Id, next.PackageIdentity, default);

        ProductionRuntime fresh = CreateRuntime(directory.Path, firstPackage.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.NotNull(recovered);
        Assert.Equal(committed.PackageIdentity, recovered.PackageIdentity);
        AuthoringPackageReceipt? rollback = await fresh.Receipts.GetLastAsync(default);
        Assert.NotNull(rollback);
        Assert.Equal(AuthoringPackageOperation.Rollback, rollback.Operation);
        Assert.Equal(AuthoringPackageOutcome.RolledBack, rollback.Outcome);
        Assert.Equal(next.PackageIdentity, rollback.PackageIdentity);
        Assert.Equal(committed.PackageIdentity, rollback.PreviousPackageIdentity);
    }

    [Fact]
    public async Task Recover_EarlierExtensionAfterAnotherCommit_UsesItsOwnLatestReceipt()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture firstPackage = CreatePackage(
            "1.0.0",
            "first payload",
            extensionId: "acme.author-tools");
        PackageFixture secondPackage = CreatePackage(
            "1.0.0",
            "second payload",
            extensionId: "acme.review-tools");
        ProductionRuntime first = CreateRuntime(directory.Path, firstPackage.Trust);
        AuthoringPackageReceipt firstReceipt = await first.Activation.InstallOrUpdateAsync(firstPackage.Artifact);
        AuthoringPackageReceipt secondReceipt = await first.Activation.InstallOrUpdateAsync(secondPackage.Artifact);
        Assert.NotEqual(firstReceipt.ExtensionId, secondReceipt.ExtensionId);

        ProductionRuntime fresh = CreateRuntime(directory.Path, firstPackage.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.NotNull(recovered);
        Assert.Equal(firstReceipt.PackageIdentity, recovered.PackageIdentity);
        Assert.Equal(secondReceipt.ReceiptSha256, (await fresh.Receipts.GetLastAsync(default))?.ReceiptSha256);
    }

    [Fact]
    public async Task Recover_TamperedStoredArchive_FailsClosedAndDeactivatesInitialInstall()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime first = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt committed = await first.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string archivePath = Path.Combine(
            directory.Path,
            "store",
            "packages",
            committed.PackageIdentity,
            "archive.fspkg");
        MakeWritable(archivePath);
        byte[] tampered = await File.ReadAllBytesAsync(archivePath);
        tampered[^1] ^= 0x01;
        await File.WriteAllBytesAsync(archivePath, tampered);

        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.Null(recovered);
        Assert.Null(await fresh.Store.GetActivationStateAsync("acme.author-tools", default));
        AuthoringPackageReceipt? rollback = await fresh.Receipts.GetLastAsync(default);
        Assert.Equal(AuthoringPackageOutcome.RolledBack, rollback?.Outcome);
        Assert.Equal(committed.PackageIdentity, rollback?.PackageIdentity);
    }

    [Fact]
    public async Task Recover_TamperedExtractedContent_FailsClosedAndDeactivatesInitialInstall()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime first = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt committed = await first.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string contentPath = Path.Combine(
            directory.Path,
            "store",
            "packages",
            committed.PackageIdentity,
            "content",
            "worker",
            "main.wasm");
        MakeWritable(contentPath);
        await File.WriteAllTextAsync(contentPath, "tampered payload");

        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.Null(recovered);
        Assert.Null(await fresh.Store.GetActivationStateAsync("acme.author-tools", default));
        Assert.Equal(
            AuthoringPackageOutcome.RolledBack,
            (await fresh.Receipts.GetLastAsync(default))?.Outcome);
    }

    [Fact]
    public async Task Verifier_TamperedSignature_FailsClosed()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        var verifier = new AuthoringPackageVerifier(
            fixture.Trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));
        AuthoringPackageArtifact tampered = fixture.Artifact with
        {
            Signature = [1, 2, 3]
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await verifier.VerifyAsync(tampered, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task ReceiptStore_FreshInstanceDetectsTamperedAppend()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        _ = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string receiptPath = Assert.Single(Directory.EnumerateFiles(
            Path.Combine(directory.Path, "receipts"),
            "receipt-*.json"));
        MakeWritable(receiptPath);
        byte[] content = await File.ReadAllBytesAsync(receiptPath);
        content[^2] ^= 0x01;
        await File.WriteAllBytesAsync(receiptPath, content);

        var fresh = new LocalAuthoringPackageReceiptStore(Path.Combine(directory.Path, "receipts"));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fresh.GetLastAsync(default));
    }

    [Theory]
    [InlineData("../worker/main.wasm")]
    [InlineData("worker\\main.wasm")]
    [InlineData("/worker/main.wasm")]
    [InlineData("worker//main.wasm")]
    public async Task ArchiveReader_NonCanonicalPaths_AreRejected(string path)
    {
        byte[] archive = CreateRawArchive(("manifest.json", "{}", 0), (path, "payload", 0));
        var reader = new ZipAuthoringPackageArchiveReader();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(archive, default));
    }

    [Fact]
    public async Task ArchiveReader_DuplicateLinkPostInstallAndMalformedArchives_AreRejected()
    {
        var reader = new ZipAuthoringPackageArchiveReader();
        byte[] duplicate = CreateRawArchive(
            ("manifest.json", "{}", 0),
            ("worker/main.wasm", "one", 0),
            ("worker/main.wasm", "two", 0));
        byte[] link = CreateRawArchive(
            ("manifest.json", "{}", 0),
            ("worker/main.wasm", "target", unchecked((int)0xA0000000)));
        byte[] postInstall = CreateRawArchive(
            ("manifest.json", "{}", 0),
            ("tools/postinstall", "echo", 0));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(duplicate, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(link, default));
        AuthoringPackageArchiveContents parsed = await reader.ReadAsync(postInstall, default);
        Assert.True(Assert.Single(parsed.Entries).IsPostInstallScript);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(new byte[] { 1, 2, 3, 4 }, default));
    }

    [Fact]
    public async Task Verifier_PostInstallArchiveEntry_IsRejectedBeforePersistence()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "echo", path: "tools/postinstall");
        var verifier = new AuthoringPackageVerifier(
            fixture.Trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task ArchiveEncodingChanges_ProduceDistinctArchiveBoundPackageIdentities()
    {
        PackageFixture firstPackage = CreatePackage(
            "1.0.0",
            "same payload",
            new DateTimeOffset(2026, 9, 4, 12, 0, 0, TimeSpan.Zero));
        PackageFixture secondPackage = CreatePackage(
            "1.0.0",
            "same payload",
            new DateTimeOffset(2026, 9, 4, 12, 2, 0, TimeSpan.Zero));
        using var directory = new TemporaryDirectory();
        ProductionRuntime runtime = CreateRuntime(directory.Path, firstPackage.Trust);

        VerifiedAuthoringPackage first = await runtime.Verifier.VerifyAsync(
            firstPackage.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage second = await runtime.Verifier.VerifyAsync(
            secondPackage.Artifact,
            AuthoringHostPlatform.ServerLinux);

        Assert.Equal(first.Contract.Manifest.PackageSha256, second.Contract.Manifest.PackageSha256);
        Assert.NotEqual(first.Artifact.ArchiveSha256, second.Artifact.ArchiveSha256);
        Assert.NotEqual(first.PackageIdentity, second.PackageIdentity);
    }

    [Fact]
    public async Task Store_CreatesUserOwnedDirectoriesAndReadOnlyContent_OnUnix()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt receipt = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string packagePath = Path.Combine(directory.Path, "store", "packages", receipt.PackageIdentity);

        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.Combine(directory.Path, "store", "packages")));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserExecute,
            File.GetUnixFileMode(packagePath));
        Assert.Equal(
            UnixFileMode.UserRead,
            File.GetUnixFileMode(Path.Combine(packagePath, "archive.fspkg")));
        Assert.Equal(
            UnixFileMode.UserRead,
            File.GetUnixFileMode(Path.Combine(packagePath, "content", "worker", "main.wasm")));
    }

    [Fact]
    public async Task Store_FreshInstanceRejectsUnknownPackageArtifact()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt receipt = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string packagePath = Path.Combine(directory.Path, "store", "packages", receipt.PackageIdentity);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                packagePath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        await File.WriteAllTextAsync(Path.Combine(packagePath, "unexpected.dll"), "not owned");
        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fresh.Store.ContainsAsync(receipt.PackageIdentity, default));
    }

    [Fact]
    public void ProductionActivation_SeparateRecoveryStoreAuthority_IsRejected()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        var verifier = new AuthoringPackageVerifier(
            fixture.Trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));
        var store = new LocalAuthoringPackageStore(
            Path.Combine(directory.Path, "store"),
            verifier,
            AuthoringHostPlatform.ServerLinux);
        var differentStoreInstance = new LocalAuthoringPackageStore(
            Path.Combine(directory.Path, "store"),
            verifier,
            AuthoringHostPlatform.ServerLinux);
        var receipts = new LocalAuthoringPackageReceiptStore(Path.Combine(directory.Path, "receipts"));
        var health = new AuthoringPackageIntegrityHealthProbe(verifier, AuthoringHostPlatform.ServerLinux);
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            health,
            receipts,
            new FixedTimeProvider(s_now));

        Assert.Throws<AuthoringExtensionContractException>(() =>
            new AuthoringPackageProductionActivation(
                verifier,
                coordinator,
                store,
                differentStoreInstance,
                receipts,
                health,
                new FixedTimeProvider(s_now),
                AuthoringHostPlatform.ServerLinux));
    }

    private static ProductionRuntime CreateRuntime(string root, LocalTrustVerifier trust)
    {
        var verifier = new AuthoringPackageVerifier(
            trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));
        var store = new LocalAuthoringPackageStore(
            Path.Combine(root, "store"),
            verifier,
            AuthoringHostPlatform.ServerLinux);
        var receipts = new LocalAuthoringPackageReceiptStore(Path.Combine(root, "receipts"));
        var health = new AuthoringPackageIntegrityHealthProbe(verifier, AuthoringHostPlatform.ServerLinux);
        var coordinator = new AuthoringPackageActivationCoordinator(store, health, receipts, new FixedTimeProvider(s_now));
        var activation = new AuthoringPackageProductionActivation(
            verifier,
            coordinator,
            store,
            store,
            receipts,
            health,
            new FixedTimeProvider(s_now),
            AuthoringHostPlatform.ServerLinux);
        return new ProductionRuntime(root, verifier, store, receipts, activation);
    }

    private static PackageFixture CreatePackage(
        string version,
        string payload,
        DateTimeOffset? entryTimestamp = null,
        string path = "worker/main.wasm",
        string extensionId = "acme.author-tools")
    {
        byte[] key = Encoding.UTF8.GetBytes("local-deterministic-publisher-key");
        var trust = new LocalTrustVerifier(key, s_now);
        byte[] payloadBytes = Encoding.UTF8.GetBytes(payload);
        var entry = new AuthoringPackageEntry(
            path,
            ImmutableArray.Create(payloadBytes),
            Digest(payloadBytes));
        ImmutableArray<AuthoringPackageEntry> entries = [entry];
        AuthoringExtensionManifest template = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = template with
        {
            Id = extensionId,
            Version = version,
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions =
            [
                template.Contributions[0] with
                {
                    Entrypoint = template.Contributions[0].Entrypoint with
                    {
                        PathOrAdapterId = entry.Path,
                        ContentSha256 = entry.ContentSha256
                    }
                }
            ]
        };
        byte[] archive = CreateRawArchive(
            ("manifest.json", JsonSerializer.Serialize(manifest), 0),
            (entry.Path, payload, 0),
            entryTimestamp);
        byte[] signature = HMACSHA256.HashData(key, archive);
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            ImmutableArray.Create(signature),
            "acme",
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Digest(archive));
        return new PackageFixture(artifact, trust);
    }

    private static byte[] CreateRawArchive(params (string Path, string Content, int ExternalAttributes)[] entries) =>
        CreateRawArchive(entries, null);

    private static byte[] CreateRawArchive(
        (string Path, string Content, int ExternalAttributes) first,
        (string Path, string Content, int ExternalAttributes) second,
        DateTimeOffset? timestamp) =>
        CreateRawArchive(new[] { first, second }, timestamp);

    private static byte[] CreateRawArchive(
        (string Path, string Content, int ExternalAttributes)[] entries,
        DateTimeOffset? timestamp)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string path, string content, int attributes) in entries)
            {
                ZipArchiveEntry entry = archive.CreateEntry(path, CompressionLevel.NoCompression);
                entry.ExternalAttributes = attributes;
                if (timestamp.HasValue)
                {
                    entry.LastWriteTime = timestamp.Value;
                }

                using Stream destination = entry.Open();
                byte[] bytes = Encoding.UTF8.GetBytes(content);
                destination.Write(bytes);
            }
        }

        return stream.ToArray();
    }

    private static string Digest(ReadOnlySpan<byte> content) =>
        Convert.ToHexStringLower(SHA256.HashData(content));

    private static void MakeWritable(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private sealed record PackageFixture(
        AuthoringPackageArtifact Artifact,
        LocalTrustVerifier Trust);

    private sealed record ProductionRuntime(
        string RootPath,
        AuthoringPackageVerifier Verifier,
        LocalAuthoringPackageStore Store,
        LocalAuthoringPackageReceiptStore Receipts,
        AuthoringPackageProductionActivation Activation);

    private sealed class LocalTrustVerifier(byte[] key, DateTimeOffset now) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] expected = HMACSHA256.HashData(key, archive.Span);
            AuthoringPackageTrustStatus status =
                string.Equals(publisher, "acme", StringComparison.Ordinal) &&
                string.Equals(keyId, "key-1", StringComparison.Ordinal) &&
                signature.Length == expected.Length &&
                CryptographicOperations.FixedTimeEquals(signature.Span, expected)
                    ? AuthoringPackageTrustStatus.Trusted
                    : AuthoringPackageTrustStatus.Untrusted;
            return ValueTask.FromResult(new AuthoringPackageTrustDecision(
                status,
                publisher,
                keyId,
                now,
                now.AddHours(1),
                new string('d', 64)));
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
            : this(System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"fsus-authoring-package-{Guid.NewGuid():N}"))
        {
        }

        public TemporaryDirectory(string path)
        {
            Path = path;
            Directory.CreateDirectory(Path);
        }

        public string Path
        {
            get;
        }

        public void Dispose()
        {
            if (!Directory.Exists(Path))
            {
                return;
            }

            if (!OperatingSystem.IsWindows())
            {
                foreach (string directory in Directory.EnumerateDirectories(Path, "*", SearchOption.AllDirectories))
                {
                    File.SetUnixFileMode(
                        directory,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                }
            }

            Directory.Delete(Path, recursive: true);
        }
    }
}
