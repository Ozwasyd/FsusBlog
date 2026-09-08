namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed class AuthoringPackageIntegrityHealthProbe(
    AuthoringPackageVerifier verifier,
    AuthoringHostPlatform platform) : IAuthoringPackageHealthProbe
{
    public async ValueTask<bool> ProbeAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        try
        {
            VerifiedAuthoringPackage current = await verifier.VerifyAsync(
                package.Artifact,
                platform,
                cancellationToken);
            return string.Equals(current.PackageIdentity, package.PackageIdentity, StringComparison.Ordinal)
                && string.Equals(current.Artifact.ArchiveSha256, package.Artifact.ArchiveSha256, StringComparison.Ordinal)
                && string.Equals(current.Contract.ContractIdentity, package.Contract.ContractIdentity, StringComparison.Ordinal)
                && string.Equals(
                    current.Contract.Manifest.PackageSha256,
                    package.Contract.Manifest.PackageSha256,
                    StringComparison.Ordinal)
                && string.Equals(
                    current.Contract.Manifest.ContentSha256,
                    package.Contract.Manifest.ContentSha256,
                    StringComparison.Ordinal);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            return false;
        }
    }
}

public sealed class AuthoringPackageProductionActivation
{
    private readonly AuthoringPackageVerifier _verifier;
    private readonly AuthoringPackageActivationCoordinator _coordinator;
    private readonly IAuthoringPackageStore _store;
    private readonly IAuthoringPackageRecoveryStore _recoveryStore;
    private readonly IAuthoringPackageReceiptStore _receipts;
    private readonly IAuthoringPackageHealthProbe _health;
    private readonly TimeProvider _timeProvider;
    private readonly AuthoringHostPlatform _platform;
    private readonly IAuthoringPackageSourceFetcher? _sourceFetcher;

    public AuthoringPackageProductionActivation(
        AuthoringPackageVerifier verifier,
        AuthoringPackageActivationCoordinator coordinator,
        IAuthoringPackageStore store,
        IAuthoringPackageRecoveryStore recoveryStore,
        IAuthoringPackageReceiptStore receipts,
        IAuthoringPackageHealthProbe health,
        TimeProvider timeProvider,
        AuthoringHostPlatform platform,
        IAuthoringPackageSourceFetcher? sourceFetcher = null)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        ArgumentNullException.ThrowIfNull(coordinator);
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(recoveryStore);
        ArgumentNullException.ThrowIfNull(receipts);
        ArgumentNullException.ThrowIfNull(health);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (!ReferenceEquals(store, recoveryStore))
        {
            throw new AuthoringExtensionContractException("Package activation and recovery must use one store authority.");
        }

        _verifier = verifier;
        _coordinator = coordinator;
        _store = store;
        _recoveryStore = recoveryStore;
        _receipts = receipts;
        _health = health;
        _timeProvider = timeProvider;
        _platform = platform;
        _sourceFetcher = sourceFetcher;
    }

    public async ValueTask<AuthoringPackageReceipt> InstallOrUpdateAsync(
        AuthoringPackageArtifact artifact,
        CancellationToken cancellationToken = default)
    {
        if (_sourceFetcher is not null)
        {
            throw new AuthoringExtensionContractException(
                "Composed package activation requires the approved source entry point.");
        }

        return await InstallVerifiedArtifactAsync(artifact, cancellationToken);
    }

    private async ValueTask<AuthoringPackageReceipt> InstallVerifiedArtifactAsync(
        AuthoringPackageArtifact artifact,
        CancellationToken cancellationToken)
    {
        VerifiedAuthoringPackage package = await _verifier.VerifyAsync(
            artifact,
            _platform,
            cancellationToken);
        return await _coordinator.InstallOrUpdateAsync(package, cancellationToken);
    }

    public async ValueTask<AuthoringPackageReceipt> InstallOrUpdateFromSourceAsync(
        string approvedSourceReference,
        CancellationToken cancellationToken = default)
    {
        if (_sourceFetcher is null)
        {
            throw new AuthoringExtensionContractException("Package activation has no approved source authority.");
        }

        AuthoringPackageArtifact artifact = await _sourceFetcher.FetchAsync(
            approvedSourceReference,
            cancellationToken);
        if (!string.Equals(artifact.SourceReference, approvedSourceReference, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Approved package source returned a different source identity.");
        }

        return await InstallVerifiedArtifactAsync(artifact, cancellationToken);
    }

    public ValueTask<AuthoringPackageReceipt> UninstallPackageAsync(
        string extensionId,
        CancellationToken cancellationToken = default) =>
        _coordinator.UninstallAsync(extensionId, cancellationToken);

    public async ValueTask<VerifiedAuthoringPackage?> RecoverActiveAsync(
        string extensionId,
        CancellationToken cancellationToken = default)
    {
        AuthoringPackageActivationState? activation = await _recoveryStore.GetActivationStateAsync(
            extensionId,
            cancellationToken);
        if (activation is null)
        {
            return null;
        }

        AuthoringPackageReceipt? extensionLast = await _receipts.GetLastForExtensionAsync(
            extensionId,
            cancellationToken);
        VerifiedAuthoringPackage? current = await TryLoadHealthyAsync(
            activation.CurrentPackageIdentity,
            cancellationToken);
        if (current is not null && ReceiptAcceptsActive(extensionLast, current))
        {
            await _store.AssertContentUnchangedAsync(current.PackageIdentity, cancellationToken);
            return current;
        }

        await _recoveryStore.RollbackUncommittedAsync(
            extensionId,
            activation.CurrentPackageIdentity,
            CancellationToken.None);
        VerifiedAuthoringPackage? restored = activation.PreviousPackageIdentity is null
            ? null
            : await TryLoadHealthyAsync(activation.PreviousPackageIdentity, CancellationToken.None);
        if (activation.PreviousPackageIdentity is not null && restored is null)
        {
            throw new AuthoringExtensionContractException("Package recovery could not restore a verified healthy previous version.");
        }

        AuthoringPackageReceipt? globalLast = await _receipts.GetLastAsync(CancellationToken.None);
        await AppendRecoveryReceiptAsync(activation, restored, globalLast, CancellationToken.None);
        return restored;
    }

    private async ValueTask<VerifiedAuthoringPackage?> TryLoadHealthyAsync(
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        try
        {
            VerifiedAuthoringPackage package = await _recoveryStore.GetByIdentityAsync(
                packageIdentity,
                cancellationToken);
            return await _health.ProbeAsync(package, cancellationToken) ? package : null;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            return null;
        }
    }

    private async ValueTask AppendRecoveryReceiptAsync(
        AuthoringPackageActivationState failed,
        VerifiedAuthoringPackage? restored,
        AuthoringPackageReceipt? last,
        CancellationToken cancellationToken)
    {
        var receipt = new AuthoringPackageReceipt(
            (last?.Sequence ?? 0) + 1,
            _timeProvider.GetUtcNow().ToUniversalTime(),
            AuthoringPackageOperation.Rollback,
            AuthoringPackageOutcome.RolledBack,
            failed.ExtensionId,
            failed.CurrentVersion,
            failed.CurrentPackageIdentity,
            failed.CurrentArchiveSha256,
            failed.CurrentPackageSha256,
            failed.CurrentContentSha256,
            failed.CurrentContractIdentity,
            failed.CurrentPublisher,
            failed.CurrentKeyId,
            failed.CurrentTrustStatus,
            failed.CurrentKeysetIdentity,
            restored?.PackageIdentity,
            restored?.Contract.Manifest.PackageSha256,
            "fresh-instance-uncommitted-or-unhealthy",
            last?.ReceiptSha256 ?? new string('0', 64),
            string.Empty);
        receipt = receipt with
        {
            ReceiptSha256 = AuthoringPackageActivationCoordinator.ComputeReceiptSha256(receipt)
        };
        await _receipts.AppendAsync(receipt, cancellationToken);
    }

    private static bool ReceiptAcceptsActive(
        AuthoringPackageReceipt? receipt,
        VerifiedAuthoringPackage package) =>
        receipt is not null &&
        ((receipt.Outcome == AuthoringPackageOutcome.Committed &&
            receipt.Operation is AuthoringPackageOperation.Install or AuthoringPackageOperation.Update &&
            string.Equals(receipt.PackageIdentity, package.PackageIdentity, StringComparison.Ordinal) ||
          receipt.Outcome is AuthoringPackageOutcome.Rejected or AuthoringPackageOutcome.RolledBack &&
            string.Equals(receipt.PreviousPackageIdentity, package.PackageIdentity, StringComparison.Ordinal)));
}

public sealed record LocalAuthoringPackageRuntime(
    AuthoringPackageProductionActivation Activation,
    LocalAuthoringPackageStore Store,
    LocalAuthoringPackageReceiptStore Receipts,
    LocalAuthoringPackageKeyset Keyset,
    LocalApprovedAuthoringPackageSourceFetcher Sources);

public static class LocalAuthoringPackageComposition
{
    public static LocalAuthoringPackageRuntime Create(
        string rootPath,
        AuthoringHostPlatform platform,
        IEnumerable<AuthoringPackagePublisherKey> publisherKeys,
        IEnumerable<AuthoringPackageArtifact> approvedPackages,
        TimeProvider? timeProvider = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        timeProvider ??= TimeProvider.System;
        var keyset = new LocalAuthoringPackageKeyset(publisherKeys);
        var sources = new LocalApprovedAuthoringPackageSourceFetcher(approvedPackages);
        var trust = new EcdsaAuthoringPackageTrustVerifier(keyset, timeProvider);
        var verifier = new AuthoringPackageVerifier(
            trust,
            new ZipAuthoringPackageArchiveReader(),
            timeProvider);
        var store = new LocalAuthoringPackageStore(
            Path.Combine(rootPath, "store"),
            verifier,
            platform);
        var receipts = new LocalAuthoringPackageReceiptStore(Path.Combine(rootPath, "receipts"));
        var health = new AuthoringPackageIntegrityHealthProbe(verifier, platform);
        var coordinator = new AuthoringPackageActivationCoordinator(store, health, receipts, timeProvider);
        var activation = new AuthoringPackageProductionActivation(
            verifier,
            coordinator,
            store,
            store,
            receipts,
            health,
            timeProvider,
            platform,
            sources);
        return new LocalAuthoringPackageRuntime(activation, store, receipts, keyset, sources);
    }
}
