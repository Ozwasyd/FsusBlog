using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringExecutionResolutionStatus
{
    Ready = 0,
    BlockedUnsupportedPlatform = 1,
    BlockedUnregisteredAdapter = 2,
    BlockedIdentityDrift = 3
}

public sealed record TrustedAuthoringAdapterDescriptor(
    string AdapterId,
    string ContributionId,
    AuthoringContributionKind ContributionKind,
    int HostApiVersion,
    string SourcePath,
    string SourceSha256,
    string ModuleName,
    string ModuleSha256,
    string ReviewOwner);

public sealed record AuthoringExecutionTarget(
    AuthoringExecutionResolutionStatus Status,
    AuthoringExecutionClass ExecutionClass,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContributionId,
    AuthoringContributionKind ContributionKind,
    string EntrypointIdentity,
    string? TrustedAdapterId,
    string RuntimeIdentity,
    string? BlockedReason);

public interface ITrustedAuthoringAdapterRegistry
{
    TrustedAuthoringAdapterDescriptor? Find(string adapterId);
}

public interface ITrustedAuthoringAdapterModuleVerifier
{
    ValueTask<bool> IsLoadedModuleExactAsync(
        TrustedAuthoringAdapterDescriptor descriptor,
        CancellationToken cancellationToken);
}

public sealed class ClosedTrustedAuthoringAdapterRegistry(
    ImmutableArray<TrustedAuthoringAdapterDescriptor> descriptors) : ITrustedAuthoringAdapterRegistry
{
    private readonly ImmutableDictionary<string, TrustedAuthoringAdapterDescriptor> _descriptors =
        Validate(descriptors);

    public TrustedAuthoringAdapterDescriptor? Find(string adapterId) =>
        _descriptors.GetValueOrDefault(adapterId);

    private static ImmutableDictionary<string, TrustedAuthoringAdapterDescriptor> Validate(
        ImmutableArray<TrustedAuthoringAdapterDescriptor> descriptors)
    {
        var builder = ImmutableDictionary.CreateBuilder<string, TrustedAuthoringAdapterDescriptor>(StringComparer.Ordinal);
        foreach (TrustedAuthoringAdapterDescriptor descriptor in descriptors)
        {
            if (string.IsNullOrWhiteSpace(descriptor.AdapterId) ||
                !descriptor.AdapterId.StartsWith("fsusblog.authoring.adapter.", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(descriptor.ContributionId) ||
                descriptor.HostApiVersion != AuthoringExtensionContractValidator.CurrentHostApiVersion ||
                !descriptor.SourcePath.StartsWith("src/backend/", StringComparison.Ordinal) ||
                descriptor.SourcePath.Contains("..", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(descriptor.ReviewOwner) ||
                !IsSha256(descriptor.SourceSha256) ||
                !IsSha256(descriptor.ModuleSha256) ||
                !builder.TryAdd(descriptor.AdapterId, descriptor))
            {
                throw new AuthoringExtensionContractException("Trusted adapter registry contains an unowned, duplicate, or unverified descriptor.");
            }
        }

        return builder.ToImmutable();
    }

    private static bool IsSha256(string value) =>
        value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}

public sealed class AuthoringExecutionResolver(
    ITrustedAuthoringAdapterRegistry adapterRegistry,
    ITrustedAuthoringAdapterModuleVerifier moduleVerifier)
{
    public async ValueTask<AuthoringExecutionTarget> ResolveAsync(
        VerifiedAuthoringPackage package,
        string contributionId,
        AuthoringHostPlatform platform,
        string? expectedRuntimeIdentity = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions.SingleOrDefault(candidate =>
            string.Equals(candidate.Id, contributionId, StringComparison.Ordinal)) ??
            throw new AuthoringExtensionContractException("Contribution is not declared by the verified package.");

        if (!package.Contract.Manifest.SupportedPlatforms.Contains(platform) ||
            !IsSupported(contribution.ExecutionClass, platform))
        {
            return Blocked(
                package,
                contribution,
                AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform,
                "execution-class-unsupported");
        }

        TrustedAuthoringAdapterDescriptor? adapter = null;
        if (contribution.ExecutionClass == AuthoringExecutionClass.TrustedHostAdapter)
        {
            if (!string.Equals(package.Contract.Manifest.Publisher, "fsusblog", StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Third-party packages cannot execute inside the host process.");
            }

            adapter = adapterRegistry.Find(contribution.Entrypoint.PathOrAdapterId);
            if (adapter is null ||
                !string.Equals(adapter.ContributionId, contribution.Id, StringComparison.Ordinal) ||
                adapter.ContributionKind != contribution.Kind ||
                !string.Equals(adapter.SourceSha256, contribution.Entrypoint.ContentSha256, StringComparison.Ordinal) ||
                !await moduleVerifier.IsLoadedModuleExactAsync(adapter, cancellationToken))
            {
                return Blocked(
                    package,
                    contribution,
                    AuthoringExecutionResolutionStatus.BlockedUnregisteredAdapter,
                    "trusted-adapter-identity-mismatch");
            }
        }

        string runtimeIdentity = ComputeRuntimeIdentity(package, contribution, adapter);
        if (expectedRuntimeIdentity is not null &&
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expectedRuntimeIdentity),
                Encoding.ASCII.GetBytes(runtimeIdentity)))
        {
            return Blocked(
                package,
                contribution,
                AuthoringExecutionResolutionStatus.BlockedIdentityDrift,
                "runtime-identity-drift");
        }

        return new AuthoringExecutionTarget(
            AuthoringExecutionResolutionStatus.Ready,
            contribution.ExecutionClass,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.Version,
            package.Contract.Manifest.PackageSha256,
            contribution.Id,
            contribution.Kind,
            contribution.Entrypoint.PathOrAdapterId,
            adapter?.AdapterId,
            runtimeIdentity,
            null);
    }

    private static bool IsSupported(AuthoringExecutionClass executionClass, AuthoringHostPlatform platform) =>
        (executionClass, platform) switch
        {
            (AuthoringExecutionClass.TrustedHostAdapter, _) => true,
            (AuthoringExecutionClass.IsolatedWorkerWasm, AuthoringHostPlatform.Browser) => true,
            (AuthoringExecutionClass.IsolatedWorkerWasm, AuthoringHostPlatform.AvaloniaDesktop) => true,
            (AuthoringExecutionClass.IsolatedWorkerWasm, AuthoringHostPlatform.ServerLinux) => true,
            (AuthoringExecutionClass.OutOfProcessService, AuthoringHostPlatform.AvaloniaDesktop) => true,
            (AuthoringExecutionClass.OutOfProcessService, AuthoringHostPlatform.ServerLinux) => true,
            _ => false
        };

    private static string ComputeRuntimeIdentity(
        VerifiedAuthoringPackage package,
        AuthoringContributionDeclaration contribution,
        TrustedAuthoringAdapterDescriptor? adapter)
    {
        string material = string.Join('\n',
            package.PackageIdentity,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.Version,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.ContentSha256,
            contribution.Id,
            contribution.Kind,
            contribution.ExecutionClass,
            contribution.Entrypoint.ContentSha256,
            adapter?.AdapterId ?? string.Empty,
            adapter?.SourceSha256 ?? string.Empty,
            adapter?.ModuleSha256 ?? string.Empty,
            AuthoringExtensionContractValidator.CurrentHostApiVersion);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }

    private static AuthoringExecutionTarget Blocked(
        VerifiedAuthoringPackage package,
        AuthoringContributionDeclaration contribution,
        AuthoringExecutionResolutionStatus status,
        string reason) => new(
            status,
            contribution.ExecutionClass,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.Version,
            package.Contract.Manifest.PackageSha256,
            contribution.Id,
            contribution.Kind,
            contribution.Entrypoint.PathOrAdapterId,
            null,
            string.Empty,
            reason);
}
