using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionPackageTests
{
    [Fact]
    public async Task VerifyAndActivate_TrustedArchive_CommitsContentAddressedVersion()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "package-v1");
        VerifiedAuthoringPackage verified = await fixture.Verifier.VerifyAsync(
            fixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore();
        var receipts = new TestReceiptStore();
        var coordinator = CreateCoordinator(store, new TestHealthProbe(true), receipts);

        AuthoringPackageReceipt receipt = await coordinator.InstallOrUpdateAsync(verified);

        Assert.Equal(AuthoringPackageOutcome.Committed, receipt.Outcome);
        Assert.Equal(verified, await store.GetActiveAsync(verified.Contract.Manifest.Id, default));
        Assert.Equal(new string('0', 64), receipt.PreviousReceiptSha256);
    }

    [Theory]
    [InlineData(AuthoringPackageTrustStatus.Unsigned)]
    [InlineData(AuthoringPackageTrustStatus.Untrusted)]
    [InlineData(AuthoringPackageTrustStatus.Revoked)]
    [InlineData(AuthoringPackageTrustStatus.Expired)]
    [InlineData(AuthoringPackageTrustStatus.UnknownPublisher)]
    public async Task VerifyAsync_NonTrustedDecision_FailsClosed(AuthoringPackageTrustStatus status)
    {
        PackageFixture fixture = CreatePackage("1.0.0", "package", status);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task VerifyAsync_ExpiredTrustDecision_FailsAfterVerification()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "package", trustExpired: true);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Theory]
    [InlineData(-1, true)]
    [InlineData(0, false)]
    [InlineData(1, false)]
    public async Task VerifyAsync_TrustExpiresDuringArchiveRead_RechecksReturnBoundary(
        int completionOffsetTicks,
        bool accepted)
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2026, 10, 3, 0, 0, 0, TimeSpan.Zero));
        DateTimeOffset validUntil = clock.UtcNow.AddMinutes(5);
        PackageFixture fixture = CreatePackage("1.0.0", "package", timeProvider: clock);
        fixture.Reader.AfterRead = () => clock.UtcNow = validUntil.AddTicks(completionOffsetTicks);

        if (accepted)
        {
            VerifiedAuthoringPackage verified = await fixture.Verifier.VerifyAsync(
                fixture.Artifact,
                AuthoringHostPlatform.ServerLinux);
            Assert.Equal(AuthoringPackageTrustStatus.Trusted, verified.Trust.Status);
            Assert.Equal(validUntil, verified.Trust.ValidUntil);
            Assert.Equal(fixture.Artifact.ArchiveSha256, verified.Artifact.ArchiveSha256);
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
        }

        Assert.Equal(1, fixture.Reader.ReadCount);
        Assert.Equal(validUntil.AddTicks(completionOffsetTicks), clock.UtcNow);
    }

    [Fact]
    public async Task VerifyAsync_ClockMovesBeforeTrustEvaluationDuringArchiveRead_FailsClosed()
    {
        var clock = new MutableTimeProvider(new DateTimeOffset(2026, 10, 3, 0, 0, 0, TimeSpan.Zero));
        DateTimeOffset evaluatedAt = clock.UtcNow;
        PackageFixture fixture = CreatePackage("1.0.0", "package", timeProvider: clock);
        fixture.Reader.AfterRead = () => clock.UtcNow = evaluatedAt.AddTicks(-1);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));

        Assert.Equal(1, fixture.Reader.ReadCount);
    }

    [Fact]
    public async Task VerifyAsync_CancelledAtCompletionClockRead_DoesNotReturnVerifiedPackage()
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(new DateTimeOffset(2026, 10, 3, 0, 0, 0, TimeSpan.Zero));
        PackageFixture fixture = CreatePackage("1.0.0", "package", timeProvider: clock);
        fixture.Reader.AfterRead = () => clock.OnRead = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Verifier.VerifyAsync(
                fixture.Artifact,
                AuthoringHostPlatform.ServerLinux,
                cancellation.Token));

        Assert.True(cancellation.IsCancellationRequested);
        Assert.Equal(1, fixture.Reader.ReadCount);
    }

    [Fact]
    public async Task VerifyAsync_CancelledAfterTrust_DoesNotParseOrStage()
    {
        using var cancellation = new CancellationTokenSource();
        PackageFixture fixture = CreatePackage("1.0.0", "package", cancelAfterTrust: cancellation);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Verifier.VerifyAsync(
                fixture.Artifact,
                AuthoringHostPlatform.ServerLinux,
                cancellation.Token));
        Assert.Equal(0, fixture.Reader.ReadCount);
    }

    [Fact]
    public async Task VerifyAsync_TraversalSymlinkScriptOrRemoteImport_FailsClosed()
    {
        foreach (AuthoringPackageEntry entry in new[]
        {
            CreateEntry("../worker/main.wasm", "wasm"),
            CreateEntry("worker\\main.wasm", "wasm"),
            CreateEntry("worker/./main.wasm", "wasm"),
            CreateEntry("worker/main.wasm", "wasm") with { IsSymbolicLink = true },
            CreateEntry("postinstall", "script") with { IsPostInstallScript = true },
            CreateEntry("https://host/main.wasm", "wasm")
        })
        {
            PackageFixture fixture = CreatePackage("1.0.0", "package", entries: [entry]);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
        }
    }

    [Fact]
    public async Task VerifyAsync_ArchiveManifestOrEntryTamper_FailsClosed()
    {
        PackageFixture archiveTamper = CreatePackage("1.0.0", "package");
        archiveTamper = archiveTamper with
        {
            Artifact = archiveTamper.Artifact with
            {
                CanonicalArchive = [9, 9, 9]
            }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await archiveTamper.Verifier.VerifyAsync(archiveTamper.Artifact, AuthoringHostPlatform.ServerLinux));

        PackageFixture manifestTamper = CreatePackage("1.0.0", "package");
        manifestTamper.Reader.Contents = manifestTamper.Reader.Contents with
        {
            CanonicalManifest = [1, 2, 3]
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await manifestTamper.Verifier.VerifyAsync(manifestTamper.Artifact, AuthoringHostPlatform.ServerLinux));

        AuthoringPackageEntry entry = CreateEntry("worker/main.wasm", "wasm") with
        {
            Content = [7, 7, 7]
        };
        PackageFixture entryTamper = CreatePackage("1.0.0", "package", entries: [entry]);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await entryTamper.Verifier.VerifyAsync(entryTamper.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task VerifyAsync_SignatureAndProvenance_AreBoundIntoPackageIdentity()
    {
        PackageFixture original = CreatePackage("1.0.0", "package", signature: [1, 2, 3]);
        PackageFixture resigned = CreatePackage("1.0.0", "package", signature: [4, 5, 6]);
        PackageFixture rebuilt = CreatePackage(
            "1.0.0",
            "package",
            signature: [1, 2, 3],
            provenanceReference: "provenance/build-2");

        VerifiedAuthoringPackage first = await original.Verifier.VerifyAsync(
            original.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage second = await resigned.Verifier.VerifyAsync(
            resigned.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage third = await rebuilt.Verifier.VerifyAsync(
            rebuilt.Artifact,
            AuthoringHostPlatform.ServerLinux);

        Assert.NotEqual(first.PackageIdentity, second.PackageIdentity);
        Assert.NotEqual(first.PackageIdentity, third.PackageIdentity);
    }

    [Theory]
    [InlineData("https://packages.example/acme")]
    [InlineData("approved-source/../other")]
    [InlineData("approved-source/catalog?token=secret")]
    [InlineData("approved-source/github_pat_secret")]
    [InlineData("approved-source/ghp_secret")]
    [InlineData("catalog-1")]
    public async Task VerifyAsync_UnapprovedSourceReference_FailsClosed(string sourceReference)
    {
        PackageFixture fixture = CreatePackage("1.0.0", "package", sourceReference: sourceReference);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task VerifyAsync_EntryOrTotalByteBound_FailsClosed()
    {
        byte[] tooLarge = new byte[16 * 1024 * 1024 + 1];
        AuthoringPackageEntry entry = new(
            "worker/main.wasm",
            ImmutableArray.Create(tooLarge),
            Convert.ToHexStringLower(SHA256.HashData(tooLarge)));
        PackageFixture fixture = CreatePackage("1.0.0", "package", entries: [entry]);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task Update_HealthFailure_RestoresExactOldVersion()
    {
        PackageFixture oldFixture = CreatePackage("1.0.0", "old-package");
        PackageFixture nextFixture = CreatePackage("2.0.0", "new-package");
        VerifiedAuthoringPackage old = await oldFixture.Verifier.VerifyAsync(oldFixture.Artifact, AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage next = await nextFixture.Verifier.VerifyAsync(nextFixture.Artifact, AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore();
        await store.StageAsync(old, default);
        await store.ActivateAsync(old.Contract.Manifest.Id, old.PackageIdentity, default);
        var receipts = new TestReceiptStore();
        var coordinator = CreateCoordinator(store, new TestHealthProbe(false), receipts);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await coordinator.InstallOrUpdateAsync(next));

        Assert.Equal(old, await store.GetActiveAsync(old.Contract.Manifest.Id, default));
        Assert.Equal(AuthoringPackageOutcome.RolledBack, (await receipts.GetLastAsync(default))?.Outcome);
    }

    [Fact]
    public async Task Update_SameVersionDifferentDigest_IsRejectedWithoutSwitch()
    {
        PackageFixture oldFixture = CreatePackage("1.0.0", "old-package");
        PackageFixture collisionFixture = CreatePackage("1.0.0", "different-package");
        VerifiedAuthoringPackage old = await oldFixture.Verifier.VerifyAsync(oldFixture.Artifact, AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage collision = await collisionFixture.Verifier.VerifyAsync(
            collisionFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore();
        await store.StageAsync(old, default);
        await store.ActivateAsync(old.Contract.Manifest.Id, old.PackageIdentity, default);
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            new TestHealthProbe(true),
            new TestReceiptStore(),
            TimeProvider.System,
            new SchemaStableAuthoringPackageCompatibilityPrecheck());

        AuthoringPackageReceipt receipt = await coordinator.InstallOrUpdateAsync(collision);

        Assert.Equal(AuthoringPackageOutcome.Rejected, receipt.Outcome);
        Assert.Equal(old, await store.GetActiveAsync(old.Contract.Manifest.Id, default));
    }

    [Fact]
    public async Task Update_DifferentPublisher_IsRejectedButTrustedKeyRotationIsAccepted()
    {
        PackageFixture oldFixture = CreatePackage("1.0.0", "old-package", keyId: "key-1");
        PackageFixture takeoverFixture = CreatePackage("2.0.0", "takeover", publisher: "mallory", keyId: "key-9");
        PackageFixture rotationFixture = CreatePackage("2.0.0", "rotated", keyId: "key-2");
        VerifiedAuthoringPackage old = await oldFixture.Verifier.VerifyAsync(
            oldFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage takeover = await takeoverFixture.Verifier.VerifyAsync(
            takeoverFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage rotation = await rotationFixture.Verifier.VerifyAsync(
            rotationFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore();
        await store.StageAsync(old, default);
        await store.ActivateAsync(old.Contract.Manifest.Id, old.PackageIdentity, default);
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            new TestHealthProbe(true),
            new TestReceiptStore(),
            TimeProvider.System,
            new SchemaStableAuthoringPackageCompatibilityPrecheck());

        AuthoringPackageReceipt takeoverReceipt = await coordinator.InstallOrUpdateAsync(takeover);
        AuthoringPackageReceipt rotationReceipt = await coordinator.InstallOrUpdateAsync(rotation);

        Assert.Equal(AuthoringPackageOutcome.Rejected, takeoverReceipt.Outcome);
        Assert.Equal("publisher-change", takeoverReceipt.FailureCode);
        Assert.Equal(AuthoringPackageOutcome.Committed, rotationReceipt.Outcome);
        Assert.Equal("key-2", (await store.GetActiveAsync(old.Contract.Manifest.Id, default))?.Artifact.KeyId);
    }

    [Fact]
    public async Task Update_DowngradeAndExactReplay_AreRejectedWithoutSwitch()
    {
        PackageFixture oldFixture = CreatePackage("2.0.0", "old-package");
        PackageFixture downgradeFixture = CreatePackage("1.0.0", "downgrade");
        VerifiedAuthoringPackage old = await oldFixture.Verifier.VerifyAsync(
            oldFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage downgrade = await downgradeFixture.Verifier.VerifyAsync(
            downgradeFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore();
        await store.StageAsync(old, default);
        await store.ActivateAsync(old.Contract.Manifest.Id, old.PackageIdentity, default);
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            new TestHealthProbe(true),
            new TestReceiptStore(),
            TimeProvider.System,
            new SchemaStableAuthoringPackageCompatibilityPrecheck());

        AuthoringPackageReceipt downgradeReceipt = await coordinator.InstallOrUpdateAsync(downgrade);
        AuthoringPackageReceipt replayReceipt = await coordinator.InstallOrUpdateAsync(old);

        Assert.Equal("downgrade-or-replay", downgradeReceipt.FailureCode);
        Assert.Equal("downgrade-or-replay", replayReceipt.FailureCode);
        Assert.Equal(old, await store.GetActiveAsync(old.Contract.Manifest.Id, default));
    }

    [Fact]
    public async Task Update_SchemaChangeWithoutMigrationAuthority_IsRejectedBeforeStaging()
    {
        PackageFixture oldFixture = CreatePackage("1.0.0", "old-package");
        PackageFixture nextFixture = CreatePackage("2.0.0", "next-package", stateSchemaVersion: 2);
        VerifiedAuthoringPackage old = await oldFixture.Verifier.VerifyAsync(
            oldFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage next = await nextFixture.Verifier.VerifyAsync(
            nextFixture.Artifact,
            AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore();
        await store.StageAsync(old, default);
        await store.ActivateAsync(old.Contract.Manifest.Id, old.PackageIdentity, default);
        var receipts = new TestReceiptStore();
        AuthoringPackageActivationCoordinator coordinator = CreateCoordinator(
            store,
            new TestHealthProbe(true),
            receipts);

        AuthoringPackageReceipt rejected = await coordinator.InstallOrUpdateAsync(next);

        Assert.Equal(AuthoringPackageOutcome.Rejected, rejected.Outcome);
        Assert.Equal("schema-migration-required", rejected.FailureCode);
        Assert.Equal(1, store.StageCount);
        Assert.Equal(old, await store.GetActiveAsync(old.Contract.Manifest.Id, default));
    }

    [Fact]
    public async Task VerifyAsync_HostApiIncompatibility_FailsBeforeStaging()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "package", minimumHostApi: 2);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task Activate_RuntimeSelfModification_IsDetectedAndRolledBack()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "package");
        VerifiedAuthoringPackage package = await fixture.Verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux);
        var store = new TestPackageStore { TamperAfterActivate = true };
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            new TestHealthProbe(true),
            new TestReceiptStore(),
            TimeProvider.System,
            new SchemaStableAuthoringPackageCompatibilityPrecheck());

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await coordinator.InstallOrUpdateAsync(package));
        Assert.Null(await store.GetActiveAsync(package.Contract.Manifest.Id, default));
    }

    private static PackageFixture CreatePackage(
        string version,
        string archiveText,
        AuthoringPackageTrustStatus trustStatus = AuthoringPackageTrustStatus.Trusted,
        bool trustExpired = false,
        CancellationTokenSource? cancelAfterTrust = null,
        ImmutableArray<AuthoringPackageEntry> entries = default,
        string publisher = "acme",
        string keyId = "key-1",
        ImmutableArray<byte> signature = default,
        string sourceReference = "approved-source/catalog-1",
        string provenanceReference = "provenance/build-1",
        int minimumHostApi = 1,
        int stateSchemaVersion = 1,
        int dataSchemaVersion = 1,
        TimeProvider? timeProvider = null)
    {
        byte[] archive = System.Text.Encoding.UTF8.GetBytes(archiveText);
        entries = entries.IsDefault ? [CreateEntry("worker/main.wasm", "wasm")] : entries;
        AuthoringPackageEntry firstEntry = entries[0];
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Version = version,
            Publisher = publisher,
            HostApi = new AuthoringHostApiRange(minimumHostApi, minimumHostApi),
            StateSchemaVersion = stateSchemaVersion,
            DataSchemaVersion = dataSchemaVersion,
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions =
            [
                AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
                {
                    Entrypoint = AuthoringExtensionContractsTests.CreateManifest().Contributions[0].Entrypoint with
                    {
                        PathOrAdapterId = firstEntry.Path,
                        ContentSha256 = firstEntry.ContentSha256
                    }
                }
            ]
        };
        var contents = new AuthoringPackageArchiveContents(
            ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest)),
            entries);
        var reader = new TestArchiveReader(contents);
        DateTimeOffset now = timeProvider?.GetUtcNow() ?? DateTimeOffset.UtcNow;
        var verifier = new AuthoringPackageVerifier(
            new TestTrustVerifier(
                trustStatus,
                now,
                trustExpired ? now.AddMinutes(-1) : now.AddMinutes(5),
                cancelAfterTrust),
            reader,
            timeProvider ?? new FixedTimeProvider(now));
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            signature.IsDefault ? [1, 2, 3] : signature,
            publisher,
            keyId,
            sourceReference,
            provenanceReference,
            Convert.ToHexStringLower(SHA256.HashData(archive)));
        return new PackageFixture(artifact, verifier, reader);
    }

    private static AuthoringPackageEntry CreateEntry(string path, string content)
    {
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(content);
        return new AuthoringPackageEntry(
            path,
            ImmutableArray.Create(bytes),
            Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }

    private static AuthoringPackageActivationCoordinator CreateCoordinator(
        IAuthoringPackageStore store,
        IAuthoringPackageHealthProbe health,
        IAuthoringPackageReceiptStore receipts) => new(
        store,
        health,
        receipts,
        TimeProvider.System,
        new SchemaStableAuthoringPackageCompatibilityPrecheck());

    private sealed record PackageFixture(
        AuthoringPackageArtifact Artifact,
        AuthoringPackageVerifier Verifier,
        TestArchiveReader Reader);

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = now;

        public Action? OnRead
        {
            get; set;
        }

        public override DateTimeOffset GetUtcNow()
        {
            OnRead?.Invoke();
            return UtcNow;
        }
    }

    private sealed class TestArchiveReader(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public AuthoringPackageArchiveContents Contents { get; set; } = contents;

        public Action? AfterRead
        {
            get; set;
        }

        public int ReadCount
        {
            get; private set;
        }

        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(
            ReadOnlyMemory<byte> canonicalArchive,
            CancellationToken cancellationToken)
        {
            ReadCount++;
            AfterRead?.Invoke();
            return ValueTask.FromResult(Contents);
        }
    }

    private sealed class TestTrustVerifier(
        AuthoringPackageTrustStatus status,
        DateTimeOffset evaluatedAt,
        DateTimeOffset validUntil,
        CancellationTokenSource? cancelAfterTrust) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken)
        {
            cancelAfterTrust?.Cancel();
            return ValueTask.FromResult(new AuthoringPackageTrustDecision(
                status,
                publisher,
                keyId,
                evaluatedAt,
                validUntil,
                new string('d', 64)));
        }
    }

    private sealed class TestHealthProbe(bool healthy) : IAuthoringPackageHealthProbe
    {
        public ValueTask<bool> ProbeAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken) =>
            ValueTask.FromResult(healthy);
    }

    private sealed class TestReceiptStore : IAuthoringPackageReceiptStore
    {
        private AuthoringPackageReceipt? _last;

        public ValueTask<AuthoringPackageReceipt?> GetLastAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(_last);

        public ValueTask<AuthoringPackageReceipt?> GetLastForExtensionAsync(
            string extensionId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(
                string.Equals(_last?.ExtensionId, extensionId, StringComparison.Ordinal) ? _last : null);

        public ValueTask AppendAsync(AuthoringPackageReceipt receipt, CancellationToken cancellationToken)
        {
            if (_last is not null &&
                (receipt.Sequence != _last.Sequence + 1 || receipt.PreviousReceiptSha256 != _last.ReceiptSha256))
            {
                throw new AuthoringExtensionContractException("Receipt chain is not append-only.");
            }

            _last = receipt;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TestPackageStore : IAuthoringPackageStore
    {
        private readonly Dictionary<string, VerifiedAuthoringPackage> _packages = new(StringComparer.Ordinal);
        private VerifiedAuthoringPackage? _active;

        public bool TamperAfterActivate
        {
            get; init;
        }

        public int StageCount
        {
            get; private set;
        }

        public ValueTask<VerifiedAuthoringPackage?> GetActiveAsync(string extensionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_active);

        public ValueTask<bool> ContainsAsync(string packageIdentity, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_packages.ContainsKey(packageIdentity));

        public ValueTask StageAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken)
        {
            StageCount++;
            _packages.Add(package.PackageIdentity, package);
            return ValueTask.CompletedTask;
        }

        public ValueTask ActivateAsync(string extensionId, string packageIdentity, CancellationToken cancellationToken)
        {
            _active = _packages[packageIdentity];
            return ValueTask.CompletedTask;
        }

        public ValueTask DeactivateAsync(
            string extensionId,
            string expectedPackageIdentity,
            CancellationToken cancellationToken)
        {
            if (_active?.PackageIdentity == expectedPackageIdentity)
            {
                _active = null;
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask RemoveStagedAsync(string packageIdentity, CancellationToken cancellationToken)
        {
            _packages.Remove(packageIdentity);
            if (_active?.PackageIdentity == packageIdentity)
            {
                _active = null;
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask AssertContentUnchangedAsync(string packageIdentity, CancellationToken cancellationToken)
        {
            if (TamperAfterActivate)
            {
                throw new AuthoringExtensionContractException("Installed content digest changed after activation.");
            }

            return ValueTask.CompletedTask;
        }
    }
}
