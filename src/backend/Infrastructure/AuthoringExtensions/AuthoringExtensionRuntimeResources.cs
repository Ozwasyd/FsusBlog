using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed class LocalAuthoringLifecyclePreflight(
    IAuthoringCapabilityGrantCatalog grants,
    TimeProvider timeProvider) :
    IAuthoringLifecyclePreflight,
    IAuthoringLifecyclePermissionPreflight
{
    public async ValueTask<bool> VerifyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken) =>
        ValidateTargets(package, targets) &&
        await HasRequiredPermissionsAsync(package, targets, cancellationToken);

    public async ValueTask<bool> HasRequiredPermissionsAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        if (!ValidateTargets(package, targets))
        {
            return false;
        }

        foreach (AuthoringExecutionTarget target in targets)
        {
            AuthoringContributionDeclaration declaration = package.Contract.Manifest.Contributions.Single(
                contribution => string.Equals(contribution.Id, target.ContributionId, StringComparison.Ordinal));
            ImmutableArray<AuthoringCapabilityGrant> active = await grants.FindActiveAsync(
                target.ExtensionId,
                target.ContributionId,
                target.RuntimeIdentity,
                cancellationToken);
            if (declaration.Capabilities.Any(capability => !active.Any(grant =>
                    grant.Capability == capability &&
                    grant.ExpiresAt > timeProvider.GetUtcNow() &&
                    string.Equals(grant.ExtensionVersion, target.ExtensionVersion, StringComparison.Ordinal))))
            {
                return false;
            }
        }

        return true;
    }

    private static bool ValidateTargets(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets) =>
        !targets.IsDefault &&
        targets.Length == package.Contract.Manifest.Contributions.Length &&
        targets.All(target =>
            target.Status == AuthoringExecutionResolutionStatus.Ready &&
            string.Equals(target.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) &&
            string.Equals(target.ExtensionVersion, package.Contract.Manifest.Version, StringComparison.Ordinal) &&
            string.Equals(target.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal) &&
            package.Contract.Manifest.Contributions.Any(contribution =>
                string.Equals(contribution.Id, target.ContributionId, StringComparison.Ordinal) &&
                contribution.ExecutionClass == target.ExecutionClass));
}

public sealed record ActiveAuthoringRuntime(
    VerifiedAuthoringPackage Package,
    AuthoringExecutionTarget Target);

public interface IAuthoringActiveRuntimeCatalog
{
    ActiveAuthoringRuntime Require(string runtimeIdentity);
}

public sealed class LocalAuthoringLifecycleHostResourceAuthority(
    IAuthoringCapabilityGrantCatalog grants,
    AuthoringCommandRegistryAuthority commands) :
    IAuthoringLifecycleHostResourceAuthority,
    IAuthoringActiveRuntimeCatalog
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, ImmutableArray<AuthoringExecutionTarget>> _active = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ActiveAuthoringRuntime> _runtimes = new(StringComparer.Ordinal);

    public ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_lock)
        {
            if (_active.ContainsKey(package.Contract.Manifest.Id))
            {
                throw new AuthoringExtensionContractException("Authoring host resources are already active.");
            }

            var runtimeIdentities = new HashSet<string>(StringComparer.Ordinal);
            foreach (AuthoringExecutionTarget target in targets)
            {
                if (!runtimeIdentities.Add(target.RuntimeIdentity) || _runtimes.ContainsKey(target.RuntimeIdentity))
                {
                    throw new AuthoringExtensionContractException("Authoring runtime identity is already active.");
                }
            }

            commands.Activate(package, targets);
            _active.Add(package.Contract.Manifest.Id, [.. targets]);
            foreach (AuthoringExecutionTarget target in targets)
            {
                _runtimes.Add(target.RuntimeIdentity, new ActiveAuthoringRuntime(package, target));
            }
        }
        return ValueTask.CompletedTask;
    }

    public async ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        ImmutableArray<AuthoringExecutionTarget> activeTargets;
        lock (_lock)
        {
            activeTargets = _active.GetValueOrDefault(extensionId, []);
        }

        if (!activeTargets.IsEmpty)
        {
            await grants.RevokeRuntimesAsync(
                extensionId,
                activeTargets.Select(static target => target.RuntimeIdentity)
                    .ToImmutableHashSet(StringComparer.Ordinal),
                cancellationToken);
        }

        lock (_lock)
        {
            commands.Revoke(extensionId);
            if (_active.Remove(extensionId, out ImmutableArray<AuthoringExecutionTarget> removedTargets))
            {
                foreach (AuthoringExecutionTarget target in removedTargets)
                {
                    _runtimes.Remove(target.RuntimeIdentity);
                }
            }
        }

        return new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0);
    }

    public ActiveAuthoringRuntime Require(string runtimeIdentity)
    {
        lock (_lock)
        {
            return _runtimes.GetValueOrDefault(runtimeIdentity) ??
                throw new AuthoringExtensionContractException(
                    "Authoring runtime is disabled, removed, or not registered.");
        }
    }
}
