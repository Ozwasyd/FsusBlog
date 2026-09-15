using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

internal sealed class AuthoringCapabilityGrantCatalogStub(
    ImmutableArray<AuthoringCapabilityGrant> grants = default) : IAuthoringCapabilityGrantCatalog
{
    private ImmutableArray<AuthoringCapabilityGrant> _grants = grants.IsDefault ? [] : grants;

    public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveAsync(
        string extensionId,
        string contributionId,
        string runtimeIdentity,
        CancellationToken cancellationToken) =>
        ValueTask.FromResult(_grants.Where(grant =>
            string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) &&
            string.Equals(grant.ContributionId, contributionId, StringComparison.Ordinal) &&
            string.Equals(grant.RuntimeIdentity, runtimeIdentity, StringComparison.Ordinal)).ToImmutableArray());

    public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveExactAsync(
        string extensionId,
        string extensionVersion,
        string contributionId,
        string runtimeIdentity,
        AuthoringExecutionClass executionClass,
        string documentId,
        CancellationToken cancellationToken) =>
        ValueTask.FromResult(_grants.Where(grant =>
            string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) &&
            string.Equals(grant.ExtensionVersion, extensionVersion, StringComparison.Ordinal) &&
            string.Equals(grant.ContributionId, contributionId, StringComparison.Ordinal) &&
            string.Equals(grant.RuntimeIdentity, runtimeIdentity, StringComparison.Ordinal) &&
            grant.ExecutionClass == executionClass &&
            string.Equals(grant.DocumentId, documentId, StringComparison.Ordinal)).ToImmutableArray());

    public ValueTask<int> RevokeExtensionAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        int removed = _grants.Count(grant =>
            string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal));
        _grants =
        [
            .. _grants.Where(grant =>
                !string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal))
        ];
        return ValueTask.FromResult(removed);
    }

    public ValueTask<int> RevokeRuntimesAsync(
        string extensionId,
        ImmutableHashSet<string> runtimeIdentities,
        CancellationToken cancellationToken)
    {
        int removed = _grants.Count(grant =>
            string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) &&
            runtimeIdentities.Contains(grant.RuntimeIdentity));
        _grants =
        [
            .. _grants.Where(grant =>
                !string.Equals(grant.ExtensionId, extensionId, StringComparison.Ordinal) ||
                !runtimeIdentities.Contains(grant.RuntimeIdentity))
        ];
        return ValueTask.FromResult(removed);
    }
}
