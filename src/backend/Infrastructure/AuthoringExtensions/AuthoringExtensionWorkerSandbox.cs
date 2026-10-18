using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringWorkerResultStatus
{
    Completed = 0,
    TimedOut = 1,
    Cancelled = 2,
    Crashed = 3,
    Stale = 4,
    Rejected = 5
}

public sealed record AuthoringWorkerCapabilityReport(
    bool Dom,
    bool HostPrivateObjects,
    bool Network,
    bool FileSystem,
    bool Process,
    bool Database,
    bool SharedMemory,
    bool RecursiveWorkerSpawn,
    ImmutableArray<string> Imports,
    ImmutableArray<string> Globals,
    bool ProcessNamespacesObserved = false,
    string RuntimeProfileSha256 = "");

public sealed record AuthoringWorkerLaunchDescriptor(
    string RuntimeIdentity,
    string InstanceIdentity,
    string ExtensionId,
    string Version,
    string PackageSha256,
    string ContentSha256,
    string ContributionId,
    string ModuleSha256,
    string HostApiDigest,
    string SchemaDigest,
    string PolicyDigest,
    ImmutableArray<byte> ModuleBytes,
    long MaximumMemoryBytes,
    int MaximumRequestBytes,
    int MaximumResponseBytes);

public sealed record AuthoringWorkerRequest(
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
    string RequestSchemaReference,
    string ResultSchemaReference,
    string PolicyDigest,
    DateTimeOffset Deadline,
    ImmutableArray<byte> Payload);

public sealed record AuthoringWorkerResponse(
    int SchemaVersion,
    string RuntimeIdentity,
    string RequestId,
    string ResultSchemaReference,
    ImmutableArray<byte> Payload);

public sealed record AuthoringWorkerExecutionResult(
    AuthoringWorkerResultStatus Status,
    AuthoringWorkerResponse? Response,
    string StableReason,
    int RequestBytes,
    int ResponseBytes)
{
    public AuthoringWorkerExecutionReceipt? Receipt
    {
        get; init;
    }
}

public sealed record AuthoringWorkerExecutionReceipt(
    string InstanceIdentity,
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContentSha256,
    string ContributionId,
    string ModuleSha256,
    string DocumentIdentitySha256,
    long DocumentEpoch,
    long SourceRevision,
    string RequestIdentitySha256,
    string HostApiDigest,
    string SchemaDigest,
    string PolicyDigest,
    long MaximumMemoryBytes,
    int MaximumRequestBytes,
    int MaximumResponseBytes,
    AuthoringWorkerResultStatus Status,
    string StableReason,
    int RequestBytes,
    int ResponseBytes);

public interface IAuthoringWorkerSandboxInstance : IAsyncDisposable
{
    AuthoringWorkerCapabilityReport CapabilityReport
    {
        get;
    }

    ValueTask<AuthoringWorkerResponse> ExecuteAsync(
        AuthoringWorkerRequest request,
        CancellationToken cancellationToken);

    /// <summary>Load the original applied snapshot into native storage and retain same-owner readback custody.
    /// This confers no approval; unsupported runtimes fail closed.</summary>
    [System.Runtime.Versioning.SupportedOSPlatform("linux")]
    ValueTask<AuthoringNativeStateSnapshotAcceptance> AcceptStateSnapshotAsync(
        VerifiedAuthoringPackage package,
        AuthoringExecutionTarget target,
        AuthoringStateSnapshot appliedSnapshot,
        long runningGeneration,
        string operationSha256,
        CancellationToken cancellationToken) =>
        ValueTask.FromException<AuthoringNativeStateSnapshotAcceptance>(
            new AuthoringExtensionContractException("Runtime cannot accept the actual applied state snapshot."));

    ValueTask TerminateAsync(string reason, CancellationToken cancellationToken);
}

public interface IAuthoringWorkerSandboxRuntime
{
    ValueTask<IAuthoringWorkerSandboxInstance> StartAsync(
        AuthoringWorkerLaunchDescriptor descriptor,
        CancellationToken cancellationToken);
}

public interface IAuthoringDocumentRevisionGate
{
    ValueTask<bool> IsCurrentAsync(
        string documentId,
        long documentEpoch,
        long sourceRevision,
        CancellationToken cancellationToken);
}

public sealed class AuthoringExtensionWorkerSandbox(
    IAuthoringWorkerSandboxRuntime runtime,
    IAuthoringDocumentRevisionGate revisionGate,
    AuthoringExtensionLifecycleResources lifecycleResources,
    TimeProvider timeProvider)
{
    private static readonly ImmutableHashSet<string> s_allowedImports =
        ImmutableHashSet.Create(StringComparer.Ordinal, "fsus:log", "fsus:clock", "fsus:abort");
    private static readonly ImmutableHashSet<string> s_allowedGlobals =
        ImmutableHashSet.Create(StringComparer.Ordinal, "WebAssembly", "TextEncoder", "TextDecoder");

    public async ValueTask<AuthoringWorkerExecutionResult> ExecuteAsync(
        VerifiedAuthoringPackage package,
        AuthoringExecutionTarget target,
        AuthoringWorkerRequest request,
        long lifecycleGeneration,
        CancellationToken cancellationToken = default)
    {
        if (lifecycleGeneration < 1)
        {
            throw new AuthoringExtensionContractException("Worker lifecycle generation is missing.");
        }

        ValidateRequest(package, target, request);
        AuthoringPackageEntry module = package.Contents.Entries.Single(entry =>
            string.Equals(entry.Path, target.EntrypointIdentity, StringComparison.Ordinal));
        if (!CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(module.Content.AsSpan()),
                Convert.FromHexString(target.ExecutionClass == AuthoringExecutionClass.IsolatedWorkerWasm
                    ? package.Contract.Manifest.Contributions.Single(item => item.Id == target.ContributionId).Entrypoint.ContentSha256
                    : new string('0', 64))))
        {
            throw new AuthoringExtensionContractException("Worker module bytes do not match the resolved entrypoint identity.");
        }

        string hostApiDigest = DigestIdentity(string.Join(':',
            "authoring-host-api",
            package.Contract.Manifest.HostApi.Minimum,
            package.Contract.Manifest.HostApi.Maximum));
        string schemaDigest = DigestIdentity(string.Join('\n',
            request.RequestSchemaReference,
            request.ResultSchemaReference));
        var launch = new AuthoringWorkerLaunchDescriptor(
            target.RuntimeIdentity,
            ComputeInstanceIdentity(target, request, hostApiDigest, schemaDigest),
            target.ExtensionId,
            target.ExtensionVersion,
            target.PackageSha256,
            package.Contract.Manifest.ContentSha256,
            target.ContributionId,
            module.ContentSha256,
            hostApiDigest,
            schemaDigest,
            request.PolicyDigest,
            [.. module.Content],
            package.Contract.Manifest.Limits.MemoryBytes,
            package.Contract.Manifest.Limits.MaximumRequestBytes,
            package.Contract.Manifest.Limits.MaximumResponseBytes);
        IAuthoringWorkerSandboxInstance instance = await runtime.StartAsync(launch, cancellationToken);
        await lifecycleResources.TrackWorkerAsync(
            target.ExtensionId,
            lifecycleGeneration,
            instance,
            cancellationToken);
        try
        {
            try
            {
                ValidateCapabilities(instance.CapabilityReport);
            }
            catch
            {
                await instance.TerminateAsync("capability-probe-failed", CancellationToken.None);
                throw;
            }

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            TimeSpan remaining = request.Deadline - timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero)
            {
                await instance.TerminateAsync("deadline-expired", CancellationToken.None);
                return Rejected(
                    launch,
                    request,
                    AuthoringWorkerResultStatus.TimedOut,
                    "deadline-expired",
                    request.Payload.Length);
            }

            deadline.CancelAfter(remaining);
            AuthoringWorkerResponse response;
            try
            {
                response = await instance.ExecuteAsync(request with
                {
                    Payload = [.. request.Payload]
                }, deadline.Token);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested)
            {
                await instance.TerminateAsync("cancelled-or-timeout", CancellationToken.None);
                AuthoringWorkerResultStatus status = cancellationToken.IsCancellationRequested
                    ? AuthoringWorkerResultStatus.Cancelled
                    : AuthoringWorkerResultStatus.TimedOut;
                return Rejected(launch, request, status, "cancelled-or-timeout", request.Payload.Length);
            }
            catch
            {
                await instance.TerminateAsync("worker-crashed", CancellationToken.None);
                return Rejected(
                    launch,
                    request,
                    AuthoringWorkerResultStatus.Crashed,
                    "worker-crashed",
                    request.Payload.Length);
            }

            if (cancellationToken.IsCancellationRequested || deadline.IsCancellationRequested ||
                timeProvider.GetUtcNow() >= request.Deadline)
            {
                await instance.TerminateAsync("cancelled-or-timeout", CancellationToken.None);
                AuthoringWorkerResultStatus status = cancellationToken.IsCancellationRequested
                    ? AuthoringWorkerResultStatus.Cancelled
                    : AuthoringWorkerResultStatus.TimedOut;
                return Rejected(launch, request, status, "cancelled-or-timeout", request.Payload.Length);
            }

            if (response is null || !IsResponseBound(response, request) ||
                response.Payload.IsDefault ||
                response.Payload.Length > package.Contract.Manifest.Limits.MaximumResponseBytes)
            {
                await instance.TerminateAsync("response-contract-rejected", CancellationToken.None);
                return Rejected(
                    launch,
                    request,
                    AuthoringWorkerResultStatus.Rejected,
                    "response-contract-rejected",
                    request.Payload.Length);
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
                await instance.TerminateAsync("cancelled-or-timeout", CancellationToken.None);
                AuthoringWorkerResultStatus status = cancellationToken.IsCancellationRequested
                    ? AuthoringWorkerResultStatus.Cancelled
                    : AuthoringWorkerResultStatus.TimedOut;
                return Rejected(launch, request, status, "cancelled-or-timeout", request.Payload.Length);
            }

            if (cancellationToken.IsCancellationRequested || deadline.IsCancellationRequested ||
                timeProvider.GetUtcNow() >= request.Deadline)
            {
                await instance.TerminateAsync("cancelled-or-timeout", CancellationToken.None);
                AuthoringWorkerResultStatus status = cancellationToken.IsCancellationRequested
                    ? AuthoringWorkerResultStatus.Cancelled
                    : AuthoringWorkerResultStatus.TimedOut;
                return Rejected(launch, request, status, "cancelled-or-timeout", request.Payload.Length);
            }

            if (!currentRevision)
            {
                await instance.TerminateAsync("stale-document", CancellationToken.None);
                return Rejected(
                    launch,
                    request,
                    AuthoringWorkerResultStatus.Stale,
                    "stale-document",
                    request.Payload.Length);
            }

            return new AuthoringWorkerExecutionResult(
                AuthoringWorkerResultStatus.Completed,
                response with
                {
                    Payload = [.. response.Payload]
                },
                "completed",
                request.Payload.Length,
                response.Payload.Length)
            {
                Receipt = CreateReceipt(
                    launch,
                    request,
                    AuthoringWorkerResultStatus.Completed,
                    "completed",
                    request.Payload.Length,
                    response.Payload.Length)
            };
        }
        finally
        {
            await lifecycleResources.ReleaseWorkerAsync(target.ExtensionId, lifecycleGeneration, instance);
        }
    }

    private static void ValidateRequest(
        VerifiedAuthoringPackage package,
        AuthoringExecutionTarget target,
        AuthoringWorkerRequest request)
    {
        AuthoringContributionDeclaration? contribution = package.Contract.Manifest.Contributions.SingleOrDefault(
            item => string.Equals(item.Id, target.ContributionId, StringComparison.Ordinal));
        if (target.Status != AuthoringExecutionResolutionStatus.Ready ||
            target.ExecutionClass != AuthoringExecutionClass.IsolatedWorkerWasm ||
            contribution is null ||
            contribution.ExecutionClass != target.ExecutionClass ||
            contribution.Kind != target.ContributionKind ||
            !string.Equals(contribution.Entrypoint.PathOrAdapterId, target.EntrypointIdentity, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.Id, target.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.Version, target.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.PackageSha256, target.PackageSha256, StringComparison.Ordinal) ||
            request.SchemaVersion != 1 ||
            request.Payload.IsDefault ||
            request.Payload.Length > package.Contract.Manifest.Limits.MaximumRequestBytes ||
            request.DocumentEpoch < 1 || request.SourceRevision < 0 ||
            !IsClosedValue(request.DocumentId, 256) ||
            !IsClosedValue(request.RequestId, 128) ||
            !IsClosedValue(request.RequestSchemaReference, 256) ||
            !IsClosedValue(request.ResultSchemaReference, 256) ||
            !IsDigest(request.PolicyDigest) ||
            !string.Equals(request.RuntimeIdentity, target.RuntimeIdentity, StringComparison.Ordinal) ||
            !string.Equals(request.ExtensionId, target.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(request.Version, target.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(request.PackageSha256, target.PackageSha256, StringComparison.Ordinal) ||
            !string.Equals(request.ContributionId, target.ContributionId, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Worker request is unbounded, stale, or not identity-bound.");
        }
    }

    private static void ValidateCapabilities(AuthoringWorkerCapabilityReport report)
    {
        if (report.Dom || report.HostPrivateObjects || report.Network || report.FileSystem ||
            report.Process || report.Database || report.SharedMemory || report.RecursiveWorkerSpawn ||
            report.Imports.IsDefault || report.Globals.IsDefault ||
            !report.ProcessNamespacesObserved || report.RuntimeProfileSha256.Length != 64 ||
            report.Imports.Any(import => !s_allowedImports.Contains(import)) ||
            report.Globals.Any(global => !s_allowedGlobals.Contains(global)))
        {
            throw new AuthoringExtensionContractException("Worker runtime capability probe exposed a forbidden authority.");
        }
    }

    private static bool IsResponseBound(AuthoringWorkerResponse response, AuthoringWorkerRequest request) =>
        response.SchemaVersion == request.SchemaVersion &&
        string.Equals(response.RuntimeIdentity, request.RuntimeIdentity, StringComparison.Ordinal) &&
        string.Equals(response.RequestId, request.RequestId, StringComparison.Ordinal) &&
        string.Equals(response.ResultSchemaReference, request.ResultSchemaReference, StringComparison.Ordinal);

    private static AuthoringWorkerExecutionResult Rejected(
        AuthoringWorkerLaunchDescriptor launch,
        AuthoringWorkerRequest request,
        AuthoringWorkerResultStatus status,
        string reason,
        int requestBytes) => new(status, null, reason, requestBytes, 0)
        {
            Receipt = CreateReceipt(launch, request, status, reason, requestBytes, 0)
        };

    private static AuthoringWorkerExecutionReceipt CreateReceipt(
        AuthoringWorkerLaunchDescriptor launch,
        AuthoringWorkerRequest request,
        AuthoringWorkerResultStatus status,
        string reason,
        int requestBytes,
        int responseBytes) => new(
            launch.InstanceIdentity,
            launch.RuntimeIdentity,
            launch.ExtensionId,
            launch.Version,
            launch.PackageSha256,
            launch.ContentSha256,
            launch.ContributionId,
            launch.ModuleSha256,
            DigestIdentity(request.DocumentId),
            request.DocumentEpoch,
            request.SourceRevision,
            DigestIdentity(request.RequestId),
            launch.HostApiDigest,
            launch.SchemaDigest,
            launch.PolicyDigest,
            launch.MaximumMemoryBytes,
            launch.MaximumRequestBytes,
            launch.MaximumResponseBytes,
            status,
            reason,
            requestBytes,
            responseBytes);

    private static string ComputeInstanceIdentity(
        AuthoringExecutionTarget target,
        AuthoringWorkerRequest request,
        string hostApiDigest,
        string schemaDigest) => DigestIdentity(string.Join('\n',
            "fsusblog.authoring.worker-instance.v1",
            target.RuntimeIdentity,
            target.ExtensionId,
            target.ExtensionVersion,
            target.PackageSha256,
            target.ContributionId,
            target.ContributionKind,
            request.DocumentId,
            request.DocumentEpoch,
            request.SourceRevision,
            request.RequestId,
            hostApiDigest,
            schemaDigest,
            request.PolicyDigest));

    private static bool IsClosedValue(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= maximumLength &&
        !value.Any(char.IsControl);

    private static bool IsDigest(string? value) =>
        value is not null && value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string DigestIdentity(string material) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
}
