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
    int MaximumMessageBytes);

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
        CancellationToken cancellationToken = default)
    {
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

        var launch = new AuthoringWorkerLaunchDescriptor(
            target.RuntimeIdentity,
            target.ExtensionId,
            target.ExtensionVersion,
            target.PackageSha256,
            package.Contract.Manifest.ContentSha256,
            target.ContributionId,
            module.ContentSha256,
            DigestIdentity(string.Join(':',
                "authoring-host-api",
                package.Contract.Manifest.HostApi.Minimum,
                package.Contract.Manifest.HostApi.Maximum)),
            DigestIdentity(string.Join('\n', request.RequestSchemaReference, request.ResultSchemaReference)),
            request.PolicyDigest,
            [.. module.Content],
            package.Contract.Manifest.Limits.MemoryBytes,
            package.Contract.Manifest.Limits.MaximumRequestBytes);
        await using IAuthoringWorkerSandboxInstance instance = await runtime.StartAsync(launch, cancellationToken);
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
            return Rejected(AuthoringWorkerResultStatus.TimedOut, "deadline-expired", request.Payload.Length);
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
            return Rejected(status, "cancelled-or-timeout", request.Payload.Length);
        }
        catch
        {
            await instance.TerminateAsync("worker-crashed", CancellationToken.None);
            return Rejected(AuthoringWorkerResultStatus.Crashed, "worker-crashed", request.Payload.Length);
        }

        if (!IsResponseBound(response, request) ||
            response.Payload.IsDefault ||
            response.Payload.Length > package.Contract.Manifest.Limits.MaximumResponseBytes)
        {
            await instance.TerminateAsync("response-contract-rejected", CancellationToken.None);
            return Rejected(AuthoringWorkerResultStatus.Rejected, "response-contract-rejected", request.Payload.Length);
        }

        if (!await revisionGate.IsCurrentAsync(
                request.DocumentId,
                request.DocumentEpoch,
                request.SourceRevision,
                cancellationToken))
        {
            await instance.TerminateAsync("stale-document", CancellationToken.None);
            return Rejected(AuthoringWorkerResultStatus.Stale, "stale-document", request.Payload.Length);
        }

        return new AuthoringWorkerExecutionResult(
            AuthoringWorkerResultStatus.Completed,
            response with
            {
                Payload = [.. response.Payload]
            },
            "completed",
            request.Payload.Length,
            response.Payload.Length);
    }

    private static void ValidateRequest(
        VerifiedAuthoringPackage package,
        AuthoringExecutionTarget target,
        AuthoringWorkerRequest request)
    {
        if (target.Status != AuthoringExecutionResolutionStatus.Ready ||
            target.ExecutionClass != AuthoringExecutionClass.IsolatedWorkerWasm ||
            request.SchemaVersion != 1 ||
            request.Payload.IsDefault ||
            request.Payload.Length > package.Contract.Manifest.Limits.MaximumRequestBytes ||
            request.DocumentEpoch < 1 || request.SourceRevision < 0 ||
            string.IsNullOrWhiteSpace(request.DocumentId) ||
            string.IsNullOrWhiteSpace(request.RequestId) ||
            string.IsNullOrWhiteSpace(request.RequestSchemaReference) ||
            string.IsNullOrWhiteSpace(request.ResultSchemaReference) ||
            request.PolicyDigest.Length != 64 ||
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
        AuthoringWorkerResultStatus status,
        string reason,
        int requestBytes) => new(status, null, reason, requestBytes, 0);

    private static string DigestIdentity(string material) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
}
