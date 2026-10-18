using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Registry validation observations, never an enable approval.</summary>
public sealed record AuthoringProductionRegistryObservation(int Commands, int Filters);

/// <summary>
/// Owns the original signed command and filter registries. Read-only preparation
/// uses the real package exclusion lifetime. Activation remains closed until the
/// original Starting stage and common generation publication ports are available.
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
        _commands = new(_commandSource, _coreCommandIds, _coreOrUserShortcuts);
        _filters = new(_filterSource, coreAuthorities, queryValidator);
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
