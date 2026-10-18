using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Registry validation observations, never an enable approval.</summary>
public sealed record AuthoringProductionRegistryObservation(int Commands, int Filters);

/// <summary>
/// Owns the original signed command and filter registries. Read-only preparation
/// uses the real package exclusion lifetime. Private generations share one
/// publication gate; production admission remains closed pending owner evidence.
/// </summary>
public sealed class AuthoringExtensionHostResourceAuthority : IAuthoringLifecycleHostResourceAuthority
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly AuthoringExtensionProductionPreflight _preflight;
    private readonly IAuthoringCapabilityGrantCatalog _grants;
    private readonly VerifiedPackageAuthoringCommandSource _commandSource = new();
    private readonly AuthoringCommandRegistryAuthority _commands;
    private readonly VerifiedPackageAuthoringFilterSource _filterSource = new();
    private readonly AuthoringFilterRegistryAuthority _filters;
    private readonly ImmutableHashSet<string> _coreCommandIds;
    private readonly ImmutableHashSet<string> _coreOrUserShortcuts;
    private readonly AuthoringCoreAuthorityRegistry _coreAuthorities;
    private readonly IAuthorSavedViewQueryValidator _queryValidator;
    private readonly Dictionary<string, StagedRegistrations> _published = new(StringComparer.Ordinal);

    public AuthoringExtensionHostResourceAuthority(
        AuthoringExtensionProductionPreflight preflight,
        IAuthoringCapabilityGrantCatalog grants,
        AuthoringCoreAuthorityRegistry coreAuthorities,
        ImmutableHashSet<string> coreOrUserShortcuts,
        IAuthorSavedViewQueryValidator queryValidator)
    {
        _preflight = preflight ?? throw new ArgumentNullException(nameof(preflight));
        _grants = grants ?? throw new ArgumentNullException(nameof(grants));
        _coreCommandIds = coreAuthorities.CommandIds.ToImmutableHashSet(StringComparer.Ordinal);
        _coreOrUserShortcuts = coreOrUserShortcuts;
        _coreAuthorities = coreAuthorities;
        _queryValidator = queryValidator;
        _commands = new(_commandSource, _coreCommandIds, _coreOrUserShortcuts);
        _filters = new(_filterSource, coreAuthorities, queryValidator);
    }

    internal StagedRegistrations StageHeldPackage(
        IAuthoringInstalledPackageReadScope packageScope,
        ImmutableArray<AuthoringExecutionTarget> orderedTargets)
    {
        VerifiedAuthoringPackage package = packageScope.ActivePackage;
        AuthoringExtensionProductionPreflight.Require(package.Contract.Manifest.Contributions.All(static declaration =>
            declaration.Kind is AuthoringContributionKind.Command or AuthoringContributionKind.CommandPaletteMetadata
                or AuthoringContributionKind.ArticleLibraryFilter), "production_host_contribution_unsupported");
        ImmutableArray<AuthoringCommandContribution> commands = _commandSource.Read(package, orderedTargets);
        ImmutableArray<AuthoringRegisteredFilter> filters = _filterSource.Read(package, orderedTargets);
        _ = new AuthoringCommandRegistry(commands, _coreCommandIds, _coreOrUserShortcuts);
        _ = new AuthoringFilterContributionQueryMapper(filters.Select(static item => item.Contribution),
            _coreAuthorities, _queryValidator);
        return new(packageScope, orderedTargets, commands,
            new(_commandSource, _coreCommandIds, _coreOrUserShortcuts),
            new(_filterSource, _coreAuthorities, _queryValidator));
    }

    internal async ValueTask PublishStagedAsync(
        StagedRegistrations stage,
        long generation,
        Func<CancellationToken, ValueTask> verifyCurrent,
        Action verifyNativeOwners,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await verifyCurrent(cancellationToken).ConfigureAwait(false);
            if (stage.Published)
            {
                AuthoringExtensionProductionPreflight.Require(stage.Generation == generation
                    && _published.TryGetValue(stage.Package.Contract.Manifest.Id, out StagedRegistrations? current)
                    && ReferenceEquals(current, stage), "production_registry_generation_drift");
                verifyNativeOwners();
                return;
            }
            AuthoringExtensionProductionPreflight.Require(stage.Active
                && !_published.ContainsKey(stage.Package.Contract.Manifest.Id), "production_registry_stage_not_publishable");
            // Both original registries are private until this one publication gate.
            // Their individual Activate calls never make a partial generation visible.
            _ = new AuthoringCommandRegistry(
                [.. _published.Values.SelectMany(static item => item.Commands), .. stage.Commands],
                _coreCommandIds, _coreOrUserShortcuts);
            _ = new AuthoringFilterContributionQueryMapper(
                _published.Values.SelectMany(static item => item.Filters.Snapshot())
                    .Concat(stage.Filters.Snapshot()).Select(static item => item.Contribution),
                _coreAuthorities, _queryValidator);
            verifyNativeOwners();
            cancellationToken.ThrowIfCancellationRequested();
            stage.Generation = generation;
            stage.Published = true;
            _published.Add(stage.Package.Contract.Manifest.Id, stage);
            try
            {
                verifyNativeOwners();
            }
            catch
            {
                _published.Remove(stage.Package.Contract.Manifest.Id);
                stage.Published = false;
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async ValueTask UnpublishAsync(StagedRegistrations stage, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_published.TryGetValue(stage.Package.Contract.Manifest.Id, out StagedRegistrations? current))
            {
                AuthoringExtensionProductionPreflight.Require(ReferenceEquals(current, stage),
                    "production_registry_generation_drift");
                _published.Remove(stage.Package.Contract.Manifest.Id);
            }
            stage.Published = false;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal int PublishedGenerations
    {
        get
        {
            _gate.Wait();
            try
            {
                return _published.Count;
            }
            finally
            {
                _gate.Release();
            }
        }
    }

    // The original Resources owner activates this hidden, single-generation host
    // stage. It then owns real Track and cleanup; no supplied count attests custody.
    internal sealed class StagedRegistrations(
        IAuthoringInstalledPackageReadScope packageScope,
        ImmutableArray<AuthoringExecutionTarget> targets,
        ImmutableArray<AuthoringCommandContribution> commands,
        AuthoringCommandRegistryAuthority commandRegistry,
        AuthoringFilterRegistryAuthority filters) : IAuthoringLifecycleHostResourceAuthority
    {
        private IAuthoringInstalledPackageReadScope? _packageScope = packageScope;
        internal VerifiedAuthoringPackage Package { get; } = packageScope.ActivePackage;
        internal ImmutableArray<AuthoringCommandContribution> Commands => commands;
        internal AuthoringFilterRegistryAuthority Filters => filters;
        internal bool Active
        {
            get; private set;
        }
        internal bool Published
        {
            get; set;
        }
        internal long Generation
        {
            get; set;
        }
        internal bool PackageScopeRetained => Volatile.Read(ref _packageScope) is not null;

        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> proposedTargets, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringExtensionProductionPreflight.Require(ReferenceEquals(package, Package)
                && targets.SequenceEqual(proposedTargets) && !Active, "production_registry_stage_identity_drift");
            _ = commandRegistry.Activate(Package, targets);
            Active = true;
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
            string extensionId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringExtensionProductionPreflight.Require(extensionId == Package.Contract.Manifest.Id,
                "production_registry_revoke_identity_drift");
            _ = commandRegistry.Revoke(extensionId);
            filters.Remove(extensionId);
            Active = false;
            int remainingCommands = commandRegistry.Snapshot().GroupByCategory().Values.Sum(static values => values.Length);
            int remainingFilters = filters.Snapshot().Length;
            // This private stage creates metadata only. No RPC, job, UI or grant
            // issuer is installed in it; those cannot be inferred for a published host.
            return ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(
                remainingCommands + remainingFilters, 0, 0, 0, 0));
        }

        internal void ReleasePackageScope()
        {
            Interlocked.Exchange(ref _packageScope, null)?.Dispose();
        }
    }

    public async ValueTask<AuthoringProductionRegistryObservation> InspectRegistrationsAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken = default)
    {
        using var operation = AuthoringExtensionProductionPreflight.BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            using IAuthoringInstalledPackageReadScope held = await _preflight.AcquirePackageScopeAsync(
                package, targets, cancellationToken).ConfigureAwait(false);
            VerifiedAuthoringPackage active = held.ActivePackage;
            AuthoringExtensionProductionPreflight.Require(active.Contract.Manifest.Contributions.All(static declaration =>
                declaration.Kind is AuthoringContributionKind.Command or AuthoringContributionKind.CommandPaletteMetadata
                    or AuthoringContributionKind.ArticleLibraryFilter), "production_host_contribution_unsupported");
            ImmutableArray<AuthoringCommandContribution> commands = _commandSource.Read(active, targets);
            ImmutableArray<AuthoringRegisteredFilter> filters = _filterSource.Read(active, targets);
            _filters.ValidateActivation(active, targets);
            // This is the same original registry validator used by publication;
            // core collisions and shortcut rules are not reimplemented here.
            _ = new AuthoringCommandRegistry(commands, _coreCommandIds, _coreOrUserShortcuts);
            cancellationToken.ThrowIfCancellationRequested();
            return new(commands.Length, filters.Length);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        _ = await InspectRegistrationsAsync(package, targets, cancellationToken).ConfigureAwait(false);
        _ = await _preflight.InspectAsync(package, targets, cancellationToken).ConfigureAwait(false);
        throw new AuthoringExtensionContractException("production_starting_publication_ports_unavailable");
    }

    public async ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        using var operation = AuthoringExtensionProductionPreflight.BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        AuthoringExtensionProductionPreflight.Require(!string.IsNullOrWhiteSpace(extensionId)
            && extensionId.Length <= 128 && extensionId == extensionId.Trim()
            && !extensionId.Any(char.IsControl), "production_extension_identity_invalid");
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // Removed counts are not remaining counts. Settle the owners we can
            // reach, but refuse a clean report without all original remaining ports.
            _commands.Revoke(extensionId);
            _filters.Remove(extensionId);
            _ = await _grants.RevokeExtensionAsync(extensionId, cancellationToken).ConfigureAwait(false);
            throw new AuthoringExtensionContractException("production_remaining_resource_ports_unavailable");
        }
        finally
        {
            _gate.Release();
        }
    }
}
