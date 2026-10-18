using System.Collections.Immutable;
using System.Net;
using System.Security.Cryptography;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringProcessOwnershipMechanism
{
    None = 0,
    LinuxCgroup = 1,
    WindowsJobObject = 2,
    PosixProcessGroup = 3
}

public enum AuthoringServiceResultStatus
{
    Completed = 0,
    TimedOut = 1,
    Cancelled = 2,
    Crashed = 3,
    Stale = 4,
    Rejected = 5
}

public enum AuthoringFileGrantOperation
{
    Read = 0,
    ProposeWrite = 1
}

public sealed record AuthoringProcessOwnershipReport(
    AuthoringProcessOwnershipMechanism Mechanism,
    bool DescendantsContained,
    bool DetachedChildrenPrevented,
    string IsolationIdentity);

public sealed record AuthoringServiceHealthReport(
    bool ProtocolHandshakeComplete,
    string RuntimeIdentity,
    string ExecutableSha256,
    string TransportSchemaReference);

public sealed record AuthoringNetworkGrant(
    string GrantId,
    string RuntimeIdentity,
    string Host,
    int Port,
    string Purpose,
    bool RequireTls,
    long MaximumBytes,
    DateTimeOffset ExpiresAt);

public sealed record AuthoringFileGrant(
    string GrantId,
    string RuntimeIdentity,
    string CanonicalRoot,
    string RelativePath,
    AuthoringFileGrantOperation Operation,
    string Purpose,
    long MaximumBytes,
    DateTimeOffset ExpiresAt);

public sealed record AuthoringServiceLaunchDescriptor(
    string RuntimeIdentity,
    string ExtensionId,
    string Version,
    string PackageSha256,
    string ContentSha256,
    string ContributionId,
    string ExecutableSha256,
    ImmutableArray<byte> ExecutableBytes,
    ImmutableArray<string> OpaqueGrantIds,
    string GrantSetDigest,
    string TransportSchemaReference,
    long MaximumMemoryBytes,
    int MaximumRequestBytes,
    int MaximumResponseBytes,
    TimeSpan MaximumWallClock);

public sealed record AuthoringServiceRequest(
    int SchemaVersion,
    string RuntimeIdentity,
    string ExtensionId,
    string Version,
    string PackageSha256,
    string ContributionId,
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    string RequestId,
    DateTimeOffset Deadline,
    ImmutableArray<string> OpaqueGrantIds,
    ImmutableArray<byte> Payload);

public sealed record AuthoringServiceResponse(
    int SchemaVersion,
    string RuntimeIdentity,
    string RequestId,
    ImmutableArray<byte> Payload);

public sealed record AuthoringServiceExecutionResult(
    AuthoringServiceResultStatus Status,
    AuthoringServiceResponse? Response,
    string StableReason);

public interface IAuthoringServiceProcess : IAsyncDisposable
{
    AuthoringProcessOwnershipReport Ownership
    {
        get;
    }

    ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken);

    ValueTask<AuthoringServiceResponse> ExecuteAsync(
        AuthoringServiceRequest request,
        CancellationToken cancellationToken);

    ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken);
}

internal interface IAuthoringOwnedServiceProcessObservation
{
    int ProcessId
    {
        get;
    }
}

public interface IAuthoringServiceProcessRuntime
{
    ValueTask<IAuthoringServiceProcess> StartAsync(
        AuthoringServiceLaunchDescriptor descriptor,
        CancellationToken cancellationToken);
}

public interface IAuthoringNetworkAddressResolver
{
    ValueTask<ImmutableArray<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken);
}

public interface IAuthoringFilePathVerifier
{
    ValueTask<(string CanonicalPath, bool HasReparseBoundary)> ResolveAsync(
        string canonicalRoot,
        string relativePath,
        CancellationToken cancellationToken);
}

public sealed class AuthoringServiceGrantValidator(
    IAuthoringNetworkAddressResolver addressResolver,
    IAuthoringFilePathVerifier pathVerifier,
    TimeProvider timeProvider,
    ImmutableHashSet<string> allowedFileRoots)
{
    internal TimeProvider TimeProvider => timeProvider;

    public async ValueTask ValidateNetworkAsync(
        AuthoringNetworkGrant grant,
        string runtimeIdentity,
        CancellationToken cancellationToken = default) =>
        _ = await ResolveNetworkAsync(grant, runtimeIdentity, cancellationToken);

    public async ValueTask<ImmutableArray<IPAddress>> ResolveNetworkAsync(
        AuthoringNetworkGrant grant,
        string runtimeIdentity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsOpaqueGrantId(grant.GrantId) ||
            !string.Equals(grant.RuntimeIdentity, runtimeIdentity, StringComparison.Ordinal) ||
            !IsClosedValue(grant.Host, 253) ||
            grant.Host.Contains("/", StringComparison.Ordinal) ||
            Uri.CheckHostName(grant.Host) != UriHostNameType.Dns ||
            grant.Port is < 1 or > 65535 ||
            !grant.RequireTls ||
            !IsClosedValue(grant.Purpose, 128) ||
            grant.MaximumBytes is < 1 or > 64 * 1024 * 1024 ||
            grant.ExpiresAt <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Network grant must be exact, opaque, TLS-only, purpose-bound, and unexpired.");
        }

        ImmutableArray<IPAddress> first = SortAddresses(await addressResolver.ResolveAsync(grant.Host, cancellationToken));
        ValidateResolutionLifetime(grant.ExpiresAt, cancellationToken);
        ImmutableArray<IPAddress> second = SortAddresses(await addressResolver.ResolveAsync(grant.Host, cancellationToken));
        ValidateResolutionLifetime(grant.ExpiresAt, cancellationToken);
        if (first.IsDefaultOrEmpty || !first.SequenceEqual(second) || first.Any(IsForbiddenAddress))
        {
            throw new AuthoringExtensionContractException("Network destination is private, metadata, loopback, or changed during validation.");
        }

        return [.. first];
    }

    public async ValueTask ValidateFileAsync(
        AuthoringFileGrant grant,
        string runtimeIdentity,
        CancellationToken cancellationToken = default) =>
        _ = await ResolveFileAsync(grant, runtimeIdentity, cancellationToken);

    public async ValueTask<string> ResolveFileAsync(
        AuthoringFileGrant grant,
        string runtimeIdentity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsOpaqueGrantId(grant.GrantId) ||
            !string.Equals(grant.RuntimeIdentity, runtimeIdentity, StringComparison.Ordinal) ||
            !Path.IsPathFullyQualified(grant.CanonicalRoot) ||
            Path.GetPathRoot(grant.CanonicalRoot) == grant.CanonicalRoot ||
            allowedFileRoots is null ||
            !allowedFileRoots.Contains(Path.TrimEndingDirectorySeparator(Path.GetFullPath(grant.CanonicalRoot))) ||
            IsControlRoot(grant.CanonicalRoot) ||
            Path.IsPathFullyQualified(grant.RelativePath) ||
            grant.RelativePath.Contains("..", StringComparison.Ordinal) ||
            !IsClosedValue(grant.RelativePath, 512) ||
            !IsClosedValue(grant.Purpose, 128) ||
            grant.MaximumBytes is < 1 or > 64 * 1024 * 1024 ||
            grant.ExpiresAt <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Filesystem grant must be exact, relative, purpose-bound, and unexpired.");
        }

        (string canonicalPath, bool hasReparseBoundary) = await pathVerifier.ResolveAsync(
            grant.CanonicalRoot,
            grant.RelativePath,
            cancellationToken);
        ValidateResolutionLifetime(grant.ExpiresAt, cancellationToken);
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(grant.CanonicalRoot));
        string path = Path.GetFullPath(canonicalPath);
        if (hasReparseBoundary ||
            !path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Filesystem grant escaped its canonical root.");
        }

        return path;
    }

    // Resolution must not extend the original grant's lifetime, even if a resolver ignores cancellation.
    private void ValidateResolutionLifetime(DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (expiresAt <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Service grant expired during resolution.");
        }
    }

    private static bool IsOpaqueGrantId(string? value) =>
        value is not null && value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsClosedValue(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && !value.Any(char.IsControl);

    private static bool IsControlRoot(string root)
    {
        string normalized = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        string userProfile = Path.TrimEndingDirectorySeparator(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        return string.Equals(normalized, userProfile, StringComparison.Ordinal) ||
            normalized is "/home" or "/root" or "/etc" or "/proc" or "/sys" or "/dev";
    }

    private static ImmutableArray<IPAddress> SortAddresses(ImmutableArray<IPAddress> addresses) =>
        addresses.IsDefault
            ? addresses
            : [.. addresses.OrderBy(static address => address.ToString(), StringComparer.Ordinal)];

    private static bool IsForbiddenAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            byte[] ipv6 = address.GetAddressBytes();
            if (address.Equals(IPAddress.IPv6Any) || address.Equals(IPAddress.IPv6None) ||
                address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast ||
                (ipv6[0] & 0xfe) == 0xfc)
            {
                return true;
            }

            if (!address.IsIPv4MappedToIPv6)
            {
                return false;
            }
        }

        byte[] bytes = address.MapToIPv4().GetAddressBytes();
        return bytes[0] == 10 ||
            bytes[0] == 127 ||
            bytes[0] == 0 ||
            bytes[0] == 100 && bytes[1] is >= 64 and <= 127 ||
            bytes[0] == 169 && bytes[1] == 254 ||
            bytes[0] == 172 && bytes[1] is >= 16 and <= 31 ||
            bytes[0] == 192 && bytes[1] == 168 ||
            bytes[0] >= 224;
    }
}

public sealed class AuthoringExtensionServiceBroker(
    IAuthoringServiceProcessRuntime runtime,
    IAuthoringDocumentRevisionGate revisionGate,
    AuthoringExtensionLifecycleResources lifecycleResources,
    TimeProvider timeProvider)
{
    public async ValueTask<AuthoringServiceExecutionResult> ExecuteAsync(
        VerifiedAuthoringPackage package,
        AuthoringExecutionTarget target,
        AuthoringServiceRequest request,
        long lifecycleGeneration,
        CancellationToken cancellationToken = default)
    {
        if (lifecycleGeneration < 1)
        {
            throw new AuthoringExtensionContractException("Service lifecycle generation is missing.");
        }

        ValidateRequest(package, target, request);
        AuthoringPackageEntry executable = package.Contents.Entries.Single(entry =>
            string.Equals(entry.Path, target.EntrypointIdentity, StringComparison.Ordinal));
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions.Single(item =>
            string.Equals(item.Id, target.ContributionId, StringComparison.Ordinal));
        if (!CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(executable.Content.AsSpan()),
                Convert.FromHexString(contribution.Entrypoint.ContentSha256)))
        {
            throw new AuthoringExtensionContractException("Service executable bytes do not match the resolved identity.");
        }

        var launch = new AuthoringServiceLaunchDescriptor(
            target.RuntimeIdentity,
            target.ExtensionId,
            target.ExtensionVersion,
            target.PackageSha256,
            package.Contract.Manifest.ContentSha256,
            target.ContributionId,
            executable.ContentSha256,
            [.. executable.Content],
            [.. request.OpaqueGrantIds],
            DigestIdentity(string.Join('\n', request.OpaqueGrantIds.Order(StringComparer.Ordinal))),
            "authoring-service-transport/v1",
            package.Contract.Manifest.Limits.MemoryBytes,
            package.Contract.Manifest.Limits.MaximumRequestBytes,
            package.Contract.Manifest.Limits.MaximumResponseBytes,
            package.Contract.Manifest.Limits.WallClock);
        IAuthoringServiceProcess process = await runtime.StartAsync(launch, cancellationToken);
        await lifecycleResources.TrackServiceAsync(
            target.ExtensionId,
            lifecycleGeneration,
            process,
            cancellationToken);
        try
        {
            if (process.Ownership.Mechanism == AuthoringProcessOwnershipMechanism.None ||
            !process.Ownership.DescendantsContained ||
            !process.Ownership.DetachedChildrenPrevented ||
            string.IsNullOrWhiteSpace(process.Ownership.IsolationIdentity))
            {
                await process.TerminateTreeAsync("process-ownership-rejected", CancellationToken.None);
                throw new AuthoringExtensionContractException("Service process tree is not host-owned and escape-resistant.");
            }

            AuthoringServiceHealthReport health = await process.GetHealthAsync(cancellationToken);
            if (!health.ProtocolHandshakeComplete ||
                !string.Equals(health.RuntimeIdentity, target.RuntimeIdentity, StringComparison.Ordinal) ||
                !string.Equals(health.ExecutableSha256, executable.ContentSha256, StringComparison.Ordinal) ||
                !string.Equals(health.TransportSchemaReference, "authoring-service-transport/v1", StringComparison.Ordinal))
            {
                await process.TerminateTreeAsync("readiness-rejected", CancellationToken.None);
                return Rejected(AuthoringServiceResultStatus.Rejected, "readiness-rejected");
            }

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            TimeSpan remaining = request.Deadline - timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero)
            {
                await process.TerminateTreeAsync("deadline-expired", CancellationToken.None);
                return Rejected(AuthoringServiceResultStatus.TimedOut, "deadline-expired");
            }

            deadline.CancelAfter(remaining);
            AuthoringServiceResponse response;
            try
            {
                response = await process.ExecuteAsync(request with
                {
                    OpaqueGrantIds = [.. request.OpaqueGrantIds],
                    Payload = [.. request.Payload]
                }, deadline.Token);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested)
            {
                await process.TerminateTreeAsync("cancelled-or-timeout", CancellationToken.None);
                return Rejected(
                    cancellationToken.IsCancellationRequested
                        ? AuthoringServiceResultStatus.Cancelled
                        : AuthoringServiceResultStatus.TimedOut,
                    "cancelled-or-timeout");
            }
            catch
            {
                await process.TerminateTreeAsync("service-crashed", CancellationToken.None);
                return Rejected(AuthoringServiceResultStatus.Crashed, "service-crashed");
            }

            if (cancellationToken.IsCancellationRequested || deadline.IsCancellationRequested ||
                timeProvider.GetUtcNow() >= request.Deadline)
            {
                await process.TerminateTreeAsync("cancelled-or-timeout", CancellationToken.None);
                return Rejected(
                    cancellationToken.IsCancellationRequested
                        ? AuthoringServiceResultStatus.Cancelled
                        : AuthoringServiceResultStatus.TimedOut,
                    "cancelled-or-timeout");
            }

            if (response is null || response.SchemaVersion != request.SchemaVersion ||
                !string.Equals(response.RuntimeIdentity, request.RuntimeIdentity, StringComparison.Ordinal) ||
                !string.Equals(response.RequestId, request.RequestId, StringComparison.Ordinal) ||
                response.Payload.IsDefault ||
                response.Payload.Length > package.Contract.Manifest.Limits.MaximumResponseBytes)
            {
                await process.TerminateTreeAsync("response-rejected", CancellationToken.None);
                return Rejected(AuthoringServiceResultStatus.Rejected, "response-rejected");
            }

            bool currentRevision;
            try
            {
                currentRevision = await revisionGate.IsCurrentAsync(
                    request.DocumentId,
                    request.DocumentEpoch,
                    request.SourceRevision,
                    deadline.Token);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested)
            {
                await process.TerminateTreeAsync("cancelled-or-timeout", CancellationToken.None);
                return Rejected(
                    cancellationToken.IsCancellationRequested
                        ? AuthoringServiceResultStatus.Cancelled
                        : AuthoringServiceResultStatus.TimedOut,
                    "cancelled-or-timeout");
            }

            if (cancellationToken.IsCancellationRequested || deadline.IsCancellationRequested ||
                timeProvider.GetUtcNow() >= request.Deadline)
            {
                await process.TerminateTreeAsync("cancelled-or-timeout", CancellationToken.None);
                return Rejected(
                    cancellationToken.IsCancellationRequested
                        ? AuthoringServiceResultStatus.Cancelled
                        : AuthoringServiceResultStatus.TimedOut,
                    "cancelled-or-timeout");
            }

            if (!currentRevision)
            {
                await process.TerminateTreeAsync("stale-document", CancellationToken.None);
                return Rejected(AuthoringServiceResultStatus.Stale, "stale-document");
            }

            return new AuthoringServiceExecutionResult(
                AuthoringServiceResultStatus.Completed,
                response with
                {
                    Payload = [.. response.Payload]
                },
                "completed");
        }
        finally
        {
            await lifecycleResources.ReleaseServiceAsync(target.ExtensionId, lifecycleGeneration, process);
        }
    }

    private static void ValidateRequest(
        VerifiedAuthoringPackage package,
        AuthoringExecutionTarget target,
        AuthoringServiceRequest request)
    {
        AuthoringContributionDeclaration? contribution = package.Contract.Manifest.Contributions.SingleOrDefault(
            item => string.Equals(item.Id, target.ContributionId, StringComparison.Ordinal));
        if (target.Status != AuthoringExecutionResolutionStatus.Ready ||
            target.ExecutionClass != AuthoringExecutionClass.OutOfProcessService ||
            contribution is null || contribution.ExecutionClass != target.ExecutionClass ||
            contribution.Kind != target.ContributionKind ||
            !string.Equals(contribution.Entrypoint.PathOrAdapterId, target.EntrypointIdentity, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.Id, target.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.Version, target.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.PackageSha256, target.PackageSha256, StringComparison.Ordinal) ||
            request.SchemaVersion != 1 ||
            request.Payload.IsDefault ||
            request.Payload.Length > package.Contract.Manifest.Limits.MaximumRequestBytes ||
            request.OpaqueGrantIds.IsDefault ||
            request.OpaqueGrantIds.Length > 32 ||
            request.OpaqueGrantIds.Distinct(StringComparer.Ordinal).Count() != request.OpaqueGrantIds.Length ||
            request.OpaqueGrantIds.Any(static id => !IsOpaqueGrantId(id)) ||
            request.DocumentEpoch < 1 || request.SourceRevision < 0 ||
            !IsClosedValue(request.DocumentId, 256) ||
            !IsClosedValue(request.RequestId, 128) ||
            !string.Equals(request.RuntimeIdentity, target.RuntimeIdentity, StringComparison.Ordinal) ||
            !string.Equals(request.ExtensionId, target.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(request.Version, target.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(request.PackageSha256, target.PackageSha256, StringComparison.Ordinal) ||
            !string.Equals(request.ContributionId, target.ContributionId, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Service request is unbounded, stale, or not identity-bound.");
        }
    }

    private static AuthoringServiceExecutionResult Rejected(
        AuthoringServiceResultStatus status,
        string reason) => new(status, null, reason);

    private static bool IsOpaqueGrantId(string? value) =>
        value is not null && value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsClosedValue(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && !value.Any(char.IsControl);

    private static string DigestIdentity(string material) =>
        Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(material)));
}
