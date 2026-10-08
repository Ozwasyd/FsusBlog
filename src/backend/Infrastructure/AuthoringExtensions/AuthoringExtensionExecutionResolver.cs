using System.Collections.Immutable;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringExecutionResolutionStatus
{
    Ready = 0,
    BlockedUnsupportedPlatform = 1,
    BlockedUnregisteredAdapter = 2,
    BlockedIdentityDrift = 3,
    BlockedPackageNotActive = 4
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
    string ReviewOwner,
    ImmutableArray<AuthoringHostPlatform> SupportedPlatforms);

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
    string? BlockedReason)
{
    public string? TrustedAdapterIdentity
    {
        get; init;
    }
}

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

public interface ITrustedAuthoringAdapterSourceVerifier
{
    ValueTask<bool> IsCheckedInSourceExactAsync(
        TrustedAuthoringAdapterDescriptor descriptor,
        CancellationToken cancellationToken);
}

public sealed class CheckedInAuthoringAdapterSourceVerifier
    : ITrustedAuthoringAdapterSourceVerifier
{
    private readonly string _repositoryRoot;

    public CheckedInAuthoringAdapterSourceVerifier(string repositoryRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(repositoryRoot);
        _repositoryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(repositoryRoot));
    }

    public async ValueTask<bool> IsCheckedInSourceExactAsync(
        TrustedAuthoringAdapterDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            string sourcePath = Path.GetFullPath(
                descriptor.SourcePath.Replace('/', Path.DirectorySeparatorChar),
                _repositoryRoot);
            if (!sourcePath.StartsWith(_repositoryRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                return false;
            }

            var source = new FileInfo(sourcePath);
            if (!source.Exists || source.Length is < 1 or > 1_048_576 || HasReparsePoint(source))
            {
                return false;
            }

            await using var stream = new FileStream(
                source.FullName,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                81920,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            byte[] actual = await SHA256.HashDataAsync(stream, cancellationToken);
            return CryptographicOperations.FixedTimeEquals(
                actual,
                Convert.FromHexString(descriptor.SourceSha256));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or FormatException or NotSupportedException)
        {
            return false;
        }
    }

    private bool HasReparsePoint(FileInfo source)
    {
        if ((source.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            return true;
        }

        DirectoryInfo? current = source.Directory;
        while (current is not null &&
            !string.Equals(current.FullName, _repositoryRoot, StringComparison.Ordinal))
        {
            if ((current.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                return true;
            }

            current = current.Parent;
        }

        return current is null;
    }
}

public interface IAuthoringInstalledPackageAuthority
{
    ValueTask<bool> IsActiveExactAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken);
}

/// <summary>
/// A short-lived exclusion scope of the original active package store. The
/// store must hold activation, deactivation, removal and trust changes until
/// Dispose; a cached record or a caller-provided boolean is not such a scope.
/// Acquisition must refuse a busy owner rather than wait without a bound.
/// Dispose only releases ownership and must not throw. No await is permitted
/// by the consumer while holding this scope unless the same owner's returned
/// object also implements the explicit non-thread-bound lifetime below.
/// </summary>
public interface IAuthoringInstalledPackageReadScope : IDisposable
{
    VerifiedAuthoringPackage ActivePackage
    {
        get;
    }
}

/// <summary>
/// The trusted host's original store-owned exclusion lifetime may cross an
/// asynchronous continuation. Acquisition and Dispose are not thread-affine;
/// activation, removal and trust exclusion remain held until Dispose. This is
/// an implementation contract, not a permission, receipt or caller proposal.
/// A synchronous read scope must not be wrapped to claim this capability.
/// </summary>
public interface IAuthoringInstalledPackageAsyncReadScope : IAuthoringInstalledPackageReadScope
{
}

public interface IAuthoringPackageReadScopeStore : IAuthoringPackageStore
{
    IAuthoringInstalledPackageReadScope AcquireActiveReadScope(string extensionId);

    // A production owner may prepare while holding a non-thread-bound lifetime.
    // A synchronous scope implementation must complete this value immediately;
    // it cannot carry a thread-bound lock across an asynchronous continuation.
    ValueTask<IAuthoringInstalledPackageReadScope> AcquireActiveReadScopeAsync(
        string extensionId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(AcquireActiveReadScope(extensionId));
    }
}

public interface IAuthoringInstalledPackageReadScopeAuthority : IAuthoringInstalledPackageAuthority
{
    IAuthoringInstalledPackageReadScope AcquireActiveReadScope(VerifiedAuthoringPackage package);

    ValueTask<IAuthoringInstalledPackageReadScope> AcquireActiveReadScopeAsync(
        VerifiedAuthoringPackage package, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(AcquireActiveReadScope(package));
    }
}

public sealed class ActiveAuthoringInstalledPackageAuthority(
    IAuthoringPackageStore packageStore) : IAuthoringInstalledPackageReadScopeAuthority
{
    public async ValueTask<bool> IsActiveExactAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        VerifiedAuthoringPackage? active = await packageStore.GetActiveAsync(
            package.Contract.Manifest.Id,
            cancellationToken);
        return IsExactActivePackage(active, package);
    }

    public IAuthoringInstalledPackageReadScope AcquireActiveReadScope(VerifiedAuthoringPackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        if (packageStore is not IAuthoringPackageReadScopeStore scopeStore)
        {
            throw new AuthoringExtensionContractException("Active package store has no terminal read exclusion scope.");
        }
        IAuthoringInstalledPackageReadScope scope = scopeStore.AcquireActiveReadScope(package.Contract.Manifest.Id);
        try
        {
            RequireExactActivePackage(scope.ActivePackage, package);
            return scope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

    internal static void RequireExactActivePackage(VerifiedAuthoringPackage? active, VerifiedAuthoringPackage package)
    {
        if (!IsExactActivePackage(active, package))
        {
            throw new AuthoringExtensionContractException("Terminal package read scope is not the exact active package.");
        }
    }

    public async ValueTask<IAuthoringInstalledPackageReadScope> AcquireActiveReadScopeAsync(
        VerifiedAuthoringPackage package, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        cancellationToken.ThrowIfCancellationRequested();
        if (packageStore is not IAuthoringPackageReadScopeStore scopeStore)
        {
            throw new AuthoringExtensionContractException("Active package store has no terminal read exclusion scope.");
        }
        IAuthoringInstalledPackageReadScope scope = await scopeStore.AcquireActiveReadScopeAsync(
            package.Contract.Manifest.Id, cancellationToken);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            RequireExactActivePackage(scope.ActivePackage, package);
            return scope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

    private static bool IsExactActivePackage(VerifiedAuthoringPackage? active, VerifiedAuthoringPackage package) =>
        active is not null &&
            string.Equals(active.PackageIdentity, package.PackageIdentity, StringComparison.Ordinal) &&
            string.Equals(active.Contract.ContractIdentity, package.Contract.ContractIdentity, StringComparison.Ordinal) &&
            string.Equals(active.Artifact.ArchiveSha256, package.Artifact.ArchiveSha256, StringComparison.Ordinal) &&
            string.Equals(
                active.Contract.Manifest.PackageSha256,
                package.Contract.Manifest.PackageSha256,
                StringComparison.Ordinal) &&
            string.Equals(
                active.Contract.Manifest.ContentSha256,
                package.Contract.Manifest.ContentSha256,
                StringComparison.Ordinal) &&
            active.Trust.Status == AuthoringPackageTrustStatus.Trusted;
}

public sealed class LoadedAssemblyTrustedAuthoringAdapterModuleVerifier : ITrustedAuthoringAdapterModuleVerifier
{
    public async ValueTask<bool> IsLoadedModuleExactAsync(
        TrustedAuthoringAdapterDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Assembly[] matches = [.. AppDomain.CurrentDomain.GetAssemblies()
            .Where(assembly => string.Equals(
                assembly.GetName().Name,
                descriptor.ModuleName,
                StringComparison.Ordinal))];
        if (matches.Length != 1)
        {
            return false;
        }

        try
        {
            string location = matches[0].Location;
            if (string.IsNullOrWhiteSpace(location))
            {
                return false;
            }

            var module = new FileInfo(location);
            if (!module.Exists || module.Length is < 1 or > 268_435_456 ||
                (module.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                return false;
            }

            await using var stream = new FileStream(
                module.FullName,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                81920,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            byte[] actual = await SHA256.HashDataAsync(stream, cancellationToken);
            return CryptographicOperations.FixedTimeEquals(
                actual,
                Convert.FromHexString(descriptor.ModuleSha256));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or FormatException or NotSupportedException)
        {
            return false;
        }
    }
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
        if (descriptors.IsDefault || descriptors.Length > AuthoringExtensionContractValidator.MaximumExtensions)
        {
            throw new AuthoringExtensionContractException("Trusted adapter registry count is outside the closed bound.");
        }

        var builder = ImmutableDictionary.CreateBuilder<string, TrustedAuthoringAdapterDescriptor>(StringComparer.Ordinal);
        foreach (TrustedAuthoringAdapterDescriptor descriptor in descriptors)
        {
            ArgumentNullException.ThrowIfNull(descriptor);
            if (string.IsNullOrWhiteSpace(descriptor.AdapterId) || descriptor.AdapterId.Length > 128 ||
                !descriptor.AdapterId.StartsWith("fsusblog.authoring.adapter.", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(descriptor.ContributionId) || descriptor.ContributionId.Length > 128 ||
                !Enum.IsDefined(descriptor.ContributionKind) ||
                descriptor.HostApiVersion != AuthoringExtensionContractValidator.CurrentHostApiVersion ||
                string.IsNullOrWhiteSpace(descriptor.SourcePath) || descriptor.SourcePath.Length > 256 ||
                !descriptor.SourcePath.StartsWith("src/backend/", StringComparison.Ordinal) ||
                descriptor.SourcePath.Contains("..", StringComparison.Ordinal) || descriptor.SourcePath.Contains('\\') ||
                descriptor.SourcePath.Any(char.IsControl) ||
                string.IsNullOrWhiteSpace(descriptor.ModuleName) || descriptor.ModuleName.Length > 128 ||
                descriptor.ModuleName.Any(static character =>
                    character is not (>= 'A' and <= 'Z') and not (>= 'a' and <= 'z') and
                    not (>= '0' and <= '9') and not '.' and not '-') ||
                string.IsNullOrWhiteSpace(descriptor.ReviewOwner) || descriptor.ReviewOwner.Length > 128 ||
                descriptor.ReviewOwner.Any(char.IsControl) ||
                descriptor.SupportedPlatforms.IsDefaultOrEmpty ||
                descriptor.SupportedPlatforms.Length > Enum.GetValues<AuthoringHostPlatform>().Length ||
                descriptor.SupportedPlatforms.Distinct().Count() != descriptor.SupportedPlatforms.Length ||
                descriptor.SupportedPlatforms.Any(static platform => !Enum.IsDefined(platform)) ||
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
    ITrustedAuthoringAdapterSourceVerifier sourceVerifier,
    ITrustedAuthoringAdapterModuleVerifier moduleVerifier,
    IAuthoringInstalledPackageAuthority installedPackageAuthority)
{
    internal async ValueTask<IAuthoringInstalledPackageAsyncReadScope> AcquireBrokerReadScopeAsync(
        VerifiedAuthoringPackage package, CancellationToken cancellationToken)
    {
        // Obtain the actual scope through this resolver's installed authority
        // and its original store. There is no scope supplied by an RPC caller.
        IAuthoringInstalledPackageReadScope scope = await AcquireReadScopeAsync(package, cancellationToken);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (scope is not IAuthoringInstalledPackageAsyncReadScope asyncScope)
            {
                throw new AuthoringExtensionContractException("Broker IO requires a non-thread-bound original package lifetime.");
            }
            return asyncScope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

    public async ValueTask<IAuthoringInstalledPackageReadScope> AcquireReadScopeAsync(
        VerifiedAuthoringPackage package, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        cancellationToken.ThrowIfCancellationRequested();
        if (installedPackageAuthority is not IAuthoringInstalledPackageReadScopeAuthority authority)
        {
            throw new AuthoringExtensionContractException("Installed package authority has no terminal read exclusion scope.");
        }
        IAuthoringInstalledPackageReadScope scope = await authority.AcquireActiveReadScopeAsync(package, cancellationToken);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            ActiveAuthoringInstalledPackageAuthority.RequireExactActivePackage(scope.ActivePackage, package);
            return scope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

    // This is deliberately synchronous: the final grant and canonical document
    // check must share the original store's held lifetime, not another async
    // active-package observation that merely moves the race.
    public IAuthoringInstalledPackageReadScope AcquireReadScope(VerifiedAuthoringPackage package)
    {
        if (installedPackageAuthority is not IAuthoringInstalledPackageReadScopeAuthority authority)
        {
            throw new AuthoringExtensionContractException("Installed package authority has no terminal read exclusion scope.");
        }
        IAuthoringInstalledPackageReadScope scope = authority.AcquireActiveReadScope(package);
        try
        {
            ActiveAuthoringInstalledPackageAuthority.RequireExactActivePackage(scope.ActivePackage, package);
            return scope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

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

        if (!await installedPackageAuthority.IsActiveExactAsync(package, cancellationToken))
        {
            return Blocked(
                package,
                contribution,
                AuthoringExecutionResolutionStatus.BlockedPackageNotActive,
                "package-not-active");
        }

        if (!package.Contract.Manifest.SupportedPlatforms.Contains(platform))
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
                !await sourceVerifier.IsCheckedInSourceExactAsync(adapter, cancellationToken) ||
                !await moduleVerifier.IsLoadedModuleExactAsync(adapter, cancellationToken))
            {
                return Blocked(
                    package,
                    contribution,
                    AuthoringExecutionResolutionStatus.BlockedUnregisteredAdapter,
                    "trusted-adapter-identity-mismatch");
            }

            if (!adapter.SupportedPlatforms.Contains(platform))
            {
                return Blocked(
                    package,
                    contribution,
                    AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform,
                    "trusted-adapter-platform-unsupported");
            }
        }
        else if (!IsSupported(contribution.ExecutionClass, platform))
        {
            return Blocked(
                package,
                contribution,
                AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform,
                "execution-class-unsupported");
        }

        string? trustedAdapterIdentity = adapter is null ? null : ComputeTrustedAdapterIdentity(adapter);
        string runtimeIdentity = ComputeRuntimeIdentity(package, contribution, trustedAdapterIdentity);
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
            null)
        {
            TrustedAdapterIdentity = trustedAdapterIdentity
        };
    }

    private static bool IsSupported(AuthoringExecutionClass executionClass, AuthoringHostPlatform platform) =>
        (executionClass, platform) switch
        {
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
        string? trustedAdapterIdentity)
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
            trustedAdapterIdentity ?? string.Empty,
            AuthoringExtensionContractValidator.CurrentHostApiVersion);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }

    private static string ComputeTrustedAdapterIdentity(TrustedAuthoringAdapterDescriptor adapter)
    {
        string material = string.Join('\n',
            "fsusblog.authoring.trusted-adapter.v1",
            adapter.AdapterId,
            adapter.ContributionId,
            adapter.ContributionKind,
            adapter.HostApiVersion,
            adapter.SourcePath,
            adapter.SourceSha256,
            adapter.ModuleName,
            adapter.ModuleSha256,
            adapter.ReviewOwner,
            string.Join(",", adapter.SupportedPlatforms.Order()));
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

// Ordinary, non-wire cleanup diagnostics; no grant, package or physical proof
// is derived from these exceptions. Release every acquired scope even if a
// nonconforming owner throws, without replacing the original failure.
internal static class AuthoringTerminalReadScopes
{
    internal static void Release(Exception? failure, params IDisposable?[] scopes)
    {
        var cleanupFailures = new List<Exception>();
        foreach (IDisposable? scope in scopes)
        {
            try
            {
                scope?.Dispose();
            }
            catch (Exception cleanupFailure)
            {
                cleanupFailures.Add(cleanupFailure);
            }
        }
        if (cleanupFailures.Count == 0)
        {
            return;
        }
        Exception primary = failure ?? cleanupFailures[0];
        try
        {
            primary.Data["AuthoringTerminalReadScopeCleanupFailures"] = cleanupFailures.ToArray();
        }
        catch
        {
            // Diagnostics must not displace the original failure.
        }
        if (failure is null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(primary).Throw();
        }
    }
}
