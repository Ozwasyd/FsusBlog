using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringRpcMethod
{
    DocumentRangeRead = 0,
    DocumentFullRead = 1,
    SelectionRead = 2,
    MutationRequest = 3,
    ArticleQuery = 4,
    NetworkBrokerRequest = 5,
    FileBrokerRequest = 6,
    DiagnosticReport = 7,
    StateRead = 8,
    StateWrite = 9
}

public enum AuthoringMutationOperation
{
    Insert = 0,
    Replace = 1,
    Delete = 2
}

public sealed record AuthoringTextRange(int Start, int End);

public sealed record AuthoringDocumentSnapshot(
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    string SnapshotSha256,
    AuthoringTextRange IncludedRange,
    string Text);

/// <summary>Immutable read observation supplied by the existing canonical document owner, not a plugin.</summary>
public sealed record AuthoringCanonicalDocumentRead(
    AuthoringDocumentSnapshot Snapshot,
    int DocumentLength,
    AuthoringTextRange Selection);

/// <summary>Content-free metadata for a read; its digest is not a permission or an approval issuer.</summary>
public sealed record AuthoringDocumentReadReceipt(
    int SchemaVersion,
    AuthoringRpcMethod Method,
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContentSha256,
    string ContributionId,
    AuthoringExecutionClass ExecutionClass,
    string RequestId,
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    string SnapshotSha256,
    string HostApiDigest,
    string SchemaDigest,
    string PolicyDigest,
    string GrantDigest,
    string SiteIdentity,
    string Purpose,
    DateTimeOffset Deadline,
    AuthoringTextRange IncludedRange,
    int ReturnedUtf8Bytes,
    string ValueDigest,
    string ReceiptDigest);

/// <summary>Only this explicitly authorized value return carries document content; the receipt does not.</summary>
public sealed record AuthoringDocumentReadResult(
    AuthoringDocumentSnapshot Snapshot,
    AuthoringDocumentReadReceipt Receipt);

public sealed record AuthoringMutation(
    AuthoringMutationOperation Operation,
    AuthoringTextRange Range,
    string Text);

public sealed record AuthoringMutationPlan(
    string PlanId,
    string DocumentId,
    long DocumentEpoch,
    long ExpectedSourceRevision,
    string ExpectedSnapshotSha256,
    ImmutableArray<AuthoringMutation> Mutations,
    string SelectionIdentity);

public sealed record AuthoringRpcPayload(
    AuthoringTextRange? DocumentRange = null,
    AuthoringMutationPlan? MutationPlan = null,
    string? QueryReference = null,
    string? BrokerGrantId = null,
    string? DiagnosticSchemaReference = null,
    string? StateKey = null,
    ImmutableArray<byte> StateValue = default)
{
    // Version-2 broker proposals are data, never grants or live host objects.
    public AuthoringNetworkBrokerProposal? NetworkBroker
    {
        get; init;
    }

    public AuthoringFileBrokerProposal? FileBroker
    {
        get; init;
    }
}

public sealed record AuthoringNetworkBrokerProposal(string Host, int Port, string PathAndQuery);

public sealed record AuthoringFileBrokerProposal(
    string RelativePath,
    AuthoringFileGrantOperation Operation,
    ImmutableArray<byte> ProposedBytes = default);

public sealed record AuthoringRpcEnvelope(
    int SchemaVersion,
    AuthoringRpcMethod Method,
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContentSha256,
    string ContributionId,
    AuthoringExecutionClass ExecutionClass,
    string RequestId,
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    string SnapshotSha256,
    string HostApiDigest,
    string SchemaDigest,
    string PolicyDigest,
    string GrantDigest,
    DateTimeOffset Deadline,
    AuthoringRpcPayload Payload)
{
    public string SiteIdentity { get; init; } = string.Empty;

    public string Purpose { get; init; } = string.Empty;
}

public sealed record AuthoringCapabilityGrant(
    string GrantId,
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string ContributionId,
    AuthoringExecutionClass ExecutionClass,
    AuthoringCapability Capability,
    string DocumentId,
    string SiteIdentity,
    string Purpose,
    string? Destination,
    string? CanonicalRoot,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    string ApprovalReceiptId,
    string RequestId,
    string GrantDigest)
{
    public long? DocumentEpoch
    {
        get; init;
    }

    public long? SourceRevision
    {
        get; init;
    }

    public string? SnapshotSha256
    {
        get; init;
    }
}

public sealed record AuthoringGrantRequest(
    string RequestId,
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string ContributionId,
    AuthoringExecutionClass ExecutionClass,
    AuthoringCapability Capability,
    string DocumentId,
    string SiteIdentity,
    string Purpose,
    string? Destination,
    string? CanonicalRoot,
    TimeSpan TimeToLive,
    string ApprovalReceiptId)
{
    public long? DocumentEpoch
    {
        get; init;
    }

    public long? SourceRevision
    {
        get; init;
    }

    public string? SnapshotSha256
    {
        get; init;
    }
}

public sealed record AuthoringMutationApproval(
    string PlanId,
    bool Approved,
    string ApprovalReceiptId,
    string PreviewDigest);

public sealed record AuthoringTransactionReceipt(
    string TransactionId,
    string PlanId,
    string DocumentId,
    long PreviousRevision,
    long NewRevision,
    string HistoryEntryId,
    string SelectionIdentity,
    bool Dirty,
    string ReceiptDigest);

public interface IAuthoringCapabilityGrantStore
{
    ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken);

    ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken);

    ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken);
}

/// <summary>
/// Original grant store exclusion scope: revoke, replacement and scope changes
/// must remain blocked until Dispose. The record is live store-owned, not wire
/// authority. Acquisition refuses a busy owner without waiting. Dispose only
/// releases ownership and must not throw.
/// </summary>
public interface IAuthoringCapabilityGrantReadScope : IDisposable
{
    AuthoringCapabilityGrant Grant
    {
        get;
    }
}

public interface IAuthoringCapabilityGrantReadScopeStore : IAuthoringCapabilityGrantStore
{
    IAuthoringCapabilityGrantReadScope AcquireReadScope(string grantId);
}

/// <summary>
/// Same consent/grant-store exclusion scope, carrying its approved exact I/O
/// scope. Implementations must bind the typed facts to Grant's approved
/// destination/root, purpose and limits; caller DTOs cannot supply these facts.
/// Revocation and replacement remain excluded until the original Dispose.
/// Unlike a thread-affine monitor, this broker exclusion must survive awaits
/// and release from the continuation thread. Missing such an owner refuses IO.
/// </summary>
public interface IAuthoringCapabilityBrokerGrantReadScope : IAuthoringCapabilityGrantReadScope
{
    AuthoringNetworkGrant? NetworkGrant
    {
        get;
    }

    AuthoringFileGrant? FileGrant
    {
        get;
    }
}

public interface IAuthoringCapabilityBrokerGrantReadScopeStore : IAuthoringCapabilityGrantReadScopeStore
{
    IAuthoringCapabilityBrokerGrantReadScope AcquireBrokerReadScope(string grantId);
}

public interface IAuthoringCanonicalDocumentTransaction
{
    ValueTask<AuthoringTransactionReceipt> ApplyAsync(
        AuthoringMutationPlan plan,
        CancellationToken cancellationToken);
}

/// <summary>
/// Optional read operations of the same canonical document transaction owner.
/// Implementations must observe the actual current document and selection, never
/// infer authority from an envelope or a caller-supplied snapshot digest.
/// </summary>
public interface IAuthoringCanonicalDocumentReadTransaction : IAuthoringCanonicalDocumentTransaction
{
    /// <summary>Reads only the requested scope from the canonical document, at the exact supplied revision.</summary>
    ValueTask<AuthoringCanonicalDocumentRead> ReadSnapshotAsync(
        AuthoringRpcEnvelope envelope,
        CancellationToken cancellationToken);

    /// <summary>
    /// Rechecks the retained observation against the actual current canonical
    /// document, selection and host invocation binding without yielding. This is
    /// a live owner check, not a comparison of two editable DTO identities.
    /// </summary>
    bool IsCurrentSnapshot(AuthoringRpcEnvelope envelope, AuthoringCanonicalDocumentRead observation);
}

public sealed class AuthoringCapabilityGrantAuthority(
    IAuthoringCapabilityGrantStore store,
    TimeProvider timeProvider)
{
    public async ValueTask<AuthoringCapabilityGrant> IssueAsync(
        AuthoringGrantRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateGrantRequest(request);
        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        var grant = new AuthoringCapabilityGrant(
            string.Empty,
            request.RuntimeIdentity,
            request.ExtensionId,
            request.ExtensionVersion,
            request.ContributionId,
            request.ExecutionClass,
            request.Capability,
            request.DocumentId,
            request.SiteIdentity,
            request.Purpose,
            request.Destination,
            request.CanonicalRoot,
            issuedAt,
            issuedAt + request.TimeToLive,
            request.ApprovalReceiptId,
            request.RequestId,
            string.Empty)
        {
            DocumentEpoch = request.DocumentEpoch,
            SourceRevision = request.SourceRevision,
            SnapshotSha256 = request.SnapshotSha256
        };
        string grantId = ComputeGrantDigest(grant);
        grant = grant with
        {
            GrantId = grantId,
            GrantDigest = grantId
        };
        await store.StoreAsync(grant, cancellationToken);
        return grant;
    }

    public async ValueTask<AuthoringCapabilityGrant> RequireAsync(
        string grantId,
        AuthoringRpcEnvelope envelope,
        AuthoringCapability capability,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        AuthoringCapabilityGrant? grant = await store.FindAsync(grantId, cancellationToken);
        return RequireExactRecord(grant, grantId, envelope, capability);
    }

    public IAuthoringCapabilityGrantReadScope AcquireReadScope(
        string grantId, AuthoringRpcEnvelope envelope, AuthoringCapability capability)
    {
        if (store is not IAuthoringCapabilityGrantReadScopeStore scopeStore)
        {
            throw new AuthoringExtensionContractException("Grant store has no terminal read exclusion scope.");
        }
        IAuthoringCapabilityGrantReadScope scope = scopeStore.AcquireReadScope(grantId);
        try
        {
            RequireExactRecord(scope.Grant, grantId, envelope, capability);
            return scope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

    public IAuthoringCapabilityBrokerGrantReadScope AcquireBrokerReadScope(
        string grantId, AuthoringRpcEnvelope envelope, AuthoringCapability capability)
    {
        if (store is not IAuthoringCapabilityBrokerGrantReadScopeStore brokerStore)
        {
            throw new AuthoringExtensionContractException("Grant store has no approved broker scope.");
        }
        IAuthoringCapabilityBrokerGrantReadScope scope = brokerStore.AcquireBrokerReadScope(grantId);
        try
        {
            RequireExactRecord(scope.Grant, grantId, envelope, capability);
            return scope;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, scope);
            throw;
        }
    }

    private AuthoringCapabilityGrant RequireExactRecord(
        AuthoringCapabilityGrant? grant, string grantId, AuthoringRpcEnvelope envelope,
        AuthoringCapability capability)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        if (grant is null || grant.ExpiresAt <= timeProvider.GetUtcNow() ||
            grant.Capability != capability ||
            !string.Equals(grant.GrantDigest, grantId, StringComparison.Ordinal) ||
            !string.Equals(grant.GrantDigest, ComputeGrantDigest(grant), StringComparison.Ordinal) ||
            !string.Equals(grant.RuntimeIdentity, envelope.RuntimeIdentity, StringComparison.Ordinal) ||
            !string.Equals(grant.ExtensionId, envelope.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(grant.ExtensionVersion, envelope.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(grant.ContributionId, envelope.ContributionId, StringComparison.Ordinal) ||
            grant.ExecutionClass != envelope.ExecutionClass ||
            !string.Equals(grant.DocumentId, envelope.DocumentId, StringComparison.Ordinal) ||
            grant.DocumentEpoch is not null && grant.DocumentEpoch != envelope.DocumentEpoch ||
            grant.SourceRevision is not null && grant.SourceRevision != envelope.SourceRevision ||
            grant.SnapshotSha256 is not null &&
                !string.Equals(grant.SnapshotSha256, envelope.SnapshotSha256, StringComparison.Ordinal) ||
            !string.Equals(grant.SiteIdentity, envelope.SiteIdentity, StringComparison.Ordinal) ||
            !string.Equals(grant.Purpose, envelope.Purpose, StringComparison.Ordinal) ||
            !string.Equals(envelope.GrantDigest, grant.GrantDigest, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Capability grant is missing, expired, revoked, or outside the exact scope.");
        }

        return grant;
    }

    public ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken = default) =>
        store.RevokeAsync(grantId, cancellationToken);

    public static string ComputeGrantDigest(AuthoringCapabilityGrant grant)
    {
        ArgumentNullException.ThrowIfNull(grant);
        string material = string.Join('\n',
            grant.RequestId,
            grant.RuntimeIdentity,
            grant.ExtensionId,
            grant.ExtensionVersion,
            grant.ContributionId,
            grant.ExecutionClass,
            grant.Capability,
            grant.DocumentId,
            grant.DocumentEpoch?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
            grant.SourceRevision?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
            grant.SnapshotSha256 ?? string.Empty,
            grant.SiteIdentity,
            grant.Purpose,
            grant.Destination ?? string.Empty,
            grant.CanonicalRoot ?? string.Empty,
            grant.IssuedAt.UtcTicks,
            (grant.ExpiresAt - grant.IssuedAt).Ticks,
            grant.ApprovalReceiptId);
        return Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(material)));
    }

    private static void ValidateGrantRequest(AuthoringGrantRequest request)
    {
        if (!Enum.IsDefined(request.ExecutionClass) || !Enum.IsDefined(request.Capability) ||
            !IsBoundedField(request.RequestId, 256) ||
            !IsDigest(request.RuntimeIdentity) ||
            !IsBoundedField(request.ExtensionId, 128) ||
            !IsBoundedField(request.ExtensionVersion, 64) ||
            !IsBoundedField(request.ContributionId, 256) ||
            !IsBoundedField(request.DocumentId, 256) ||
            !IsBoundedField(request.SiteIdentity, 256) ||
            !IsBoundedField(request.Purpose, 256) ||
            request.Purpose.Equals("all", StringComparison.OrdinalIgnoreCase) ||
            request.TimeToLive <= TimeSpan.Zero || request.TimeToLive > TimeSpan.FromHours(24) ||
            !IsBoundedField(request.ApprovalReceiptId, 256))
        {
            throw new AuthoringExtensionContractException("Grant request must be exact, bounded, explicitly approved, and purpose-bound.");
        }

        bool scopeIsExact = request.Capability switch
        {
            AuthoringCapability.NetworkDestination =>
                IsBoundedField(request.Destination, 2048) && request.CanonicalRoot is null,
            AuthoringCapability.FileSystemRootRead or AuthoringCapability.FileSystemRootProposeWrite =>
                request.Destination is null && IsBoundedField(request.CanonicalRoot, 4096),
            _ => request.Destination is null && request.CanonicalRoot is null
        };
        if (!scopeIsExact)
        {
            throw new AuthoringExtensionContractException("I/O grants require an exact destination or canonical root.");
        }

        bool hasExactDocumentRevision = request.DocumentEpoch >= 1 &&
            request.SourceRevision >= 0 && IsDigest(request.SnapshotSha256);
        bool hasNoDocumentRevision = request.DocumentEpoch is null &&
            request.SourceRevision is null && request.SnapshotSha256 is null;
        if (request.Capability == AuthoringCapability.DocumentFullRead
            ? !hasExactDocumentRevision
            : !hasNoDocumentRevision)
        {
            throw new AuthoringExtensionContractException(
                "Full-document grants require one exact document epoch, revision, and snapshot digest.");
        }
    }

    private static bool IsBoundedField(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= maximumLength &&
        value == value.Trim() &&
        !value.ContainsAny(['\0', '\r', '\n']);

    private static bool IsDigest(string? value) =>
        value?.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}

public sealed class AuthoringExtensionRpcAuthority(
    AuthoringCapabilityGrantAuthority grants,
    IAuthoringCanonicalDocumentTransaction transaction,
    IAuthoringDocumentRevisionGate revisionGate,
    TimeProvider timeProvider,
    AuthoringExecutionResolver? executionResolver = null,
    AuthoringExtensionServiceIoBroker? ioBroker = null)
{
    private readonly HashSet<string> _committedRequestIds = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public ValueTask<AuthoringRpcBrokerResult> ExecuteBrokerAsync(
        VerifiedAuthoringPackage package,
        AuthoringHostPlatform platform,
        AuthoringRpcEnvelope envelope,
        CancellationToken cancellationToken = default)
    {
        ValidateEnvelope(envelope);
        return new AuthoringExtensionRpcIoBrokerHandler(
            grants, revisionGate, timeProvider, executionResolver, ioBroker, _committedRequestIds, _gate)
            .ExecuteAsync(package, platform, envelope, cancellationToken);
    }

    /// <summary>Checks broker value/context integrity against the exact request; it does not authenticate IO or grant consent.</summary>
    public static void ValidateBrokerResult(AuthoringRpcEnvelope request, AuthoringRpcBrokerResult result) =>
        AuthoringExtensionRpcIoBrokerHandler.ValidateResultBinding(request, result);

    /// <summary>
    /// Reads one already registered document method through the same canonical
    /// transaction owner and the original package resolver and grant authority.
    /// No production reader, consent UI or public transport is created here.
    /// </summary>
    public async ValueTask<AuthoringDocumentReadResult> ReadDocumentAsync(
        VerifiedAuthoringPackage package,
        AuthoringHostPlatform platform,
        AuthoringRpcEnvelope envelope,
        CancellationToken cancellationToken = default)
    {
        ValidateEnvelope(envelope);
        CheckReadReturnBoundary(envelope, cancellationToken);
        ArgumentNullException.ThrowIfNull(package);
        AuthoringCapability capability = envelope.Method switch
        {
            AuthoringRpcMethod.DocumentRangeRead => AuthoringCapability.DocumentRangeRead,
            AuthoringRpcMethod.DocumentFullRead => AuthoringCapability.DocumentFullRead,
            AuthoringRpcMethod.SelectionRead => AuthoringCapability.SelectionRead,
            _ => throw new AuthoringExtensionContractException("RPC method is not one registered document read.")
        };
        if (executionResolver is null || transaction is not IAuthoringCanonicalDocumentReadTransaction reader ||
            envelope.Payload.DocumentRange is not { } range || range.Start < 0 || range.End < range.Start)
        {
            throw new AuthoringExtensionContractException("Document read requires the canonical owner, resolver and one exact range.");
        }

        // The sole manifest validator supplies owned capability arrays and the
        // original declared budgets; a typed record or self-declared target is
        // not a replacement for the active package resolver below.
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(package.Contract.Manifest, platform);
        if (!string.Equals(contract.ContractIdentity, package.Contract.ContractIdentity, StringComparison.Ordinal) ||
            !string.Equals(contract.RegistryIdentity, package.Contract.RegistryIdentity, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Document read manifest no longer matches the verified package.");
        }
        package = package with
        {
            Contract = contract
        };
        AuthoringContributionDeclaration contribution = contract.Manifest.Contributions.SingleOrDefault(candidate =>
            string.Equals(candidate.Id, envelope.ContributionId, StringComparison.Ordinal)) ??
            throw new AuthoringExtensionContractException("Document read contribution is not declared.");
        if (!contribution.Capabilities.Contains(capability) ||
            (long)range.End - range.Start > contract.Manifest.Limits.MaximumResponseBytes)
        {
            throw new AuthoringExtensionContractException("Document read exceeds the declared capability or response budget.");
        }

        byte[] requestBytes = SerializeReadRequestBudget(envelope, contract.Manifest.Limits.MaximumObjectDepth);
        if (requestBytes.Length > contract.Manifest.Limits.MaximumRequestBytes)
        {
            throw new AuthoringExtensionContractException("Document read metadata exceeds the declared request budget.");
        }
        await RequireReadTargetAsync(package, platform, envelope, cancellationToken);
        await grants.RequireAsync(envelope.GrantDigest, envelope, capability, cancellationToken);
        CheckReadReturnBoundary(envelope, cancellationToken);
        AuthoringCanonicalDocumentRead observation = await reader.ReadSnapshotAsync(envelope, cancellationToken);
        CheckReadReturnBoundary(envelope, cancellationToken);
        ValidateReadObservation(envelope, observation);

        if (!await revisionGate.IsCurrentAsync(envelope.DocumentId, envelope.DocumentEpoch,
                envelope.SourceRevision, cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw new AuthoringExtensionContractException("Document read is stale; nearest-match reads are forbidden.");
        }
        CheckReadReturnBoundary(envelope, cancellationToken);
        await RequireReadTargetAsync(package, platform, envelope, cancellationToken);
        await grants.RequireAsync(envelope.GrantDigest, envelope, capability, cancellationToken);
        CheckReadReturnBoundary(envelope, cancellationToken);
        // Prepare the original package lifetime with independent storage/trust
        // reads, then acquire the grant scope after that final await. Both remain
        // held through the same canonical owner's non-yielding
        // completion gate. Missing production scope implementations refuse;
        // neither earlier async observation nor a self-sealed DTO substitutes.
        IAuthoringInstalledPackageReadScope? packageScope = null;
        IAuthoringCapabilityGrantReadScope? grantScope = null;
        Exception? publicationFailure = null;
        try
        {
            packageScope = await executionResolver.AcquireReadScopeAsync(package, cancellationToken);
            CheckReadReturnBoundary(envelope, cancellationToken);
            grantScope = grants.AcquireReadScope(envelope.GrantDigest, envelope, capability);
            CheckCanonicalReadCurrent(reader, envelope, observation, cancellationToken);

            AuthoringDocumentReadReceipt receipt = CreateReadReceipt(envelope, observation.Snapshot.IncludedRange,
                Encoding.UTF8.GetByteCount(observation.Snapshot.Text)) with
            {
                ValueDigest = ComputeReadValueDigest(observation.Snapshot)
            };
            CheckReadReturnBoundary(envelope, cancellationToken);
            receipt = receipt with
            {
                ReceiptDigest = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(receipt)))
            };
            var result = new AuthoringDocumentReadResult(observation.Snapshot, receipt);
            ValidateReadResponseBudget(result, contract.Manifest.Limits, envelope, cancellationToken);
            CheckReadReturnBoundary(envelope, cancellationToken);
            CheckCanonicalReadCurrent(reader, envelope, observation, cancellationToken);
            DateTimeOffset publishedAt = timeProvider.GetUtcNow();
            cancellationToken.ThrowIfCancellationRequested();
            if (publishedAt >= envelope.Deadline ||
                packageScope.ActivePackage.Trust.ValidUntil <= publishedAt ||
                grantScope.Grant.ExpiresAt <= publishedAt)
            {
                throw new AuthoringExtensionContractException("Document read authority expired before publication.");
            }
            return result;
        }
        catch (Exception failure)
        {
            publicationFailure = failure;
            throw;
        }
        finally
        {
            // Reverse the fixed package-then-grant acquisition order; never
            // acquire either authority again while these scopes are held.
            AuthoringTerminalReadScopes.Release(publicationFailure, grantScope, packageScope);
        }
    }

    private async ValueTask RequireReadTargetAsync(
        VerifiedAuthoringPackage package,
        AuthoringHostPlatform platform,
        AuthoringRpcEnvelope envelope,
        CancellationToken cancellationToken)
    {
        AuthoringExecutionTarget target = await executionResolver!.ResolveAsync(package,
            envelope.ContributionId, platform, envelope.RuntimeIdentity, cancellationToken);
        CheckReadReturnBoundary(envelope, cancellationToken);
        if (target.Status != AuthoringExecutionResolutionStatus.Ready ||
            target.ExecutionClass != envelope.ExecutionClass ||
            !string.Equals(target.ExtensionId, envelope.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(target.ExtensionVersion, envelope.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(target.PackageSha256, envelope.PackageSha256, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.ContentSha256, envelope.ContentSha256, StringComparison.Ordinal) ||
            package.Trust.Status != AuthoringPackageTrustStatus.Trusted ||
            package.Trust.ValidUntil <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Document read package or execution binding is not current.");
        }
    }

    private static void ValidateReadObservation(AuthoringRpcEnvelope envelope, AuthoringCanonicalDocumentRead observation)
    {
        AuthoringTextRange requested = envelope.Payload.DocumentRange!;
        if (observation?.Snapshot is not { } snapshot || snapshot.IncludedRange is not { } included ||
            snapshot.Text is null || observation.Selection is not { } selection ||
            observation.DocumentLength < 0 || included != requested ||
            included.Start < 0 || included.End < included.Start || included.End > observation.DocumentLength ||
            snapshot.Text.Length != (long)included.End - included.Start ||
            selection.Start < 0 || selection.End < selection.Start || selection.End > observation.DocumentLength ||
            !string.Equals(snapshot.DocumentId, envelope.DocumentId, StringComparison.Ordinal) ||
            snapshot.DocumentEpoch != envelope.DocumentEpoch || snapshot.SourceRevision != envelope.SourceRevision ||
            !string.Equals(snapshot.SnapshotSha256, envelope.SnapshotSha256, StringComparison.Ordinal) ||
            envelope.Method == AuthoringRpcMethod.DocumentFullRead &&
                (included.Start != 0 || included.End != observation.DocumentLength) ||
            envelope.Method != AuthoringRpcMethod.DocumentFullRead && observation.DocumentLength > 0 &&
                included.Start == 0 && included.End == observation.DocumentLength ||
            envelope.Method == AuthoringRpcMethod.SelectionRead && included != selection)
        {
            throw new AuthoringExtensionContractException("Canonical document read is stale, overbroad or outside the exact requested scope.");
        }
    }

    private static AuthoringDocumentReadReceipt CreateReadReceipt(
        AuthoringRpcEnvelope envelope, AuthoringTextRange range, int returnedUtf8Bytes) => new(
            envelope.SchemaVersion, envelope.Method, envelope.RuntimeIdentity, envelope.ExtensionId,
            envelope.ExtensionVersion, envelope.PackageSha256, envelope.ContentSha256, envelope.ContributionId,
            envelope.ExecutionClass, envelope.RequestId, envelope.DocumentId, envelope.DocumentEpoch,
            envelope.SourceRevision, envelope.SnapshotSha256, envelope.HostApiDigest, envelope.SchemaDigest,
            envelope.PolicyDigest, envelope.GrantDigest, envelope.SiteIdentity, envelope.Purpose,
            envelope.Deadline, range, returnedUtf8Bytes, string.Empty, string.Empty);

    private static byte[] SerializeReadRequestBudget(AuthoringRpcEnvelope envelope, int maximumDepth)
    {
        // Measure the complete existing envelope, not the smaller receipt or
        // only its range. Absent byte payload has no content and is represented
        // as null here, avoiding enumeration of an uninitialized ImmutableArray.
        // This projection is used only for bounded size admission, not emitted
        // as a new public transport or accepted as a second request schema.
        try
        {
            return JsonSerializer.SerializeToUtf8Bytes(new
            {
                envelope.SchemaVersion,
                envelope.Method,
                envelope.RuntimeIdentity,
                envelope.ExtensionId,
                envelope.ExtensionVersion,
                envelope.PackageSha256,
                envelope.ContentSha256,
                envelope.ContributionId,
                envelope.ExecutionClass,
                envelope.RequestId,
                envelope.DocumentId,
                envelope.DocumentEpoch,
                envelope.SourceRevision,
                envelope.SnapshotSha256,
                envelope.HostApiDigest,
                envelope.SchemaDigest,
                envelope.PolicyDigest,
                envelope.GrantDigest,
                envelope.Deadline,
                Payload = new
                {
                    envelope.Payload.DocumentRange,
                    envelope.Payload.MutationPlan,
                    envelope.Payload.QueryReference,
                    envelope.Payload.BrokerGrantId,
                    envelope.Payload.DiagnosticSchemaReference,
                    envelope.Payload.StateKey,
                    StateValue = (byte[]?)null
                },
                envelope.SiteIdentity,
                envelope.Purpose
            }, new JsonSerializerOptions { MaxDepth = maximumDepth });
        }
        catch (JsonException)
        {
            throw new AuthoringExtensionContractException("Document read metadata exceeds the declared object depth.");
        }
    }

    private static string ComputeReadValueDigest(AuthoringDocumentSnapshot snapshot)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendPreviewString(hash, "fsusblog.authoring-document-read-value.v1");
        AppendPreviewString(hash, snapshot.DocumentId);
        AppendPreviewInteger(hash, snapshot.DocumentEpoch);
        AppendPreviewInteger(hash, snapshot.SourceRevision);
        AppendPreviewString(hash, snapshot.SnapshotSha256);
        AppendPreviewInteger(hash, snapshot.IncludedRange.Start);
        AppendPreviewInteger(hash, snapshot.IncludedRange.End);
        // Reuse the original framed UTF-16 producer, including lone code units;
        // UTF-8 replacement must not collapse distinct returned source values.
        AppendPreviewString(hash, snapshot.Text);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private void ValidateReadResponseBudget(
        AuthoringDocumentReadResult result, AuthoringResourceLimits limits,
        AuthoringRpcEnvelope envelope, CancellationToken cancellationToken)
    {
        var options = new JsonSerializerOptions { MaxDepth = limits.MaximumObjectDepth };
        long bytes;
        try
        {
            bytes = JsonSerializer.SerializeToUtf8Bytes(result with
            {
                Snapshot = result.Snapshot with
                {
                    Text = string.Empty
                }
            }, options).Length;
        }
        catch (JsonException)
        {
            throw new AuthoringExtensionContractException("Document read value exceeds the declared object depth.");
        }
        // Count the same default JSON string escaping in bounded chunks without
        // materializing a second document-sized serialized response. This is an
        // internal value-size check, not a public JSON transport or fallback.
        for (int offset = 0; offset < result.Snapshot.Text.Length;)
        {
            CheckReadReturnBoundary(envelope, cancellationToken);
            int count = Math.Min(512 / sizeof(char), result.Snapshot.Text.Length - offset);
            if (offset + count < result.Snapshot.Text.Length &&
                char.IsHighSurrogate(result.Snapshot.Text[offset + count - 1]) &&
                char.IsLowSurrogate(result.Snapshot.Text[offset + count]))
            {
                count--;
            }
            bytes += JsonEncodedText.Encode(result.Snapshot.Text.AsSpan(offset, count)).EncodedUtf8Bytes.Length;
            if (bytes > limits.MaximumResponseBytes)
            {
                throw new AuthoringExtensionContractException("Document read exceeds the declared serialized response budget.");
            }
            offset += count;
        }
        if (bytes > limits.MaximumResponseBytes)
        {
            throw new AuthoringExtensionContractException("Document read exceeds the declared serialized response budget.");
        }
    }

    private void CheckReadReturnBoundary(AuthoringRpcEnvelope envelope, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (envelope.Deadline <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Document read deadline has expired.");
        }
    }

    private void CheckCanonicalReadCurrent(
        IAuthoringCanonicalDocumentReadTransaction reader, AuthoringRpcEnvelope envelope,
        AuthoringCanonicalDocumentRead observation, CancellationToken cancellationToken)
    {
        bool current = reader.IsCurrentSnapshot(envelope, observation);
        CheckReadReturnBoundary(envelope, cancellationToken);
        if (!current)
        {
            throw new AuthoringExtensionContractException("Document read observation or selection is no longer current.");
        }
    }

    public async ValueTask<AuthoringTransactionReceipt> ApplyMutationAsync(
        AuthoringRpcEnvelope envelope,
        AuthoringMutationApproval approval,
        CancellationToken cancellationToken = default)
    {
        ValidateEnvelope(envelope);
        if (envelope.Method != AuthoringRpcMethod.MutationRequest || envelope.Payload.MutationPlan is null)
        {
            throw new AuthoringExtensionContractException("RPC method does not carry one closed mutation plan.");
        }

        envelope = CaptureOwnedMutationEnvelope(envelope);
        AuthoringMutationPlan plan = envelope.Payload.MutationPlan!;
        await grants.RequireAsync(
            envelope.GrantDigest,
            envelope,
            AuthoringCapability.DocumentMutationRequest,
            cancellationToken);
        ValidateMutationPlan(plan, envelope, approval);
        if (!await revisionGate.IsCurrentAsync(
                plan.DocumentId,
                plan.DocumentEpoch,
                plan.ExpectedSourceRevision,
                cancellationToken))
        {
            throw new AuthoringExtensionContractException("Mutation plan is stale; automatic rebasing is forbidden.");
        }

        ValidateMutationPlan(plan, envelope, approval);
        await grants.RequireAsync(
            envelope.GrantDigest,
            envelope,
            AuthoringCapability.DocumentMutationRequest,
            cancellationToken);

        lock (_gate)
        {
            if (envelope.Deadline <= timeProvider.GetUtcNow())
            {
                throw new AuthoringExtensionContractException("Mutation request deadline has expired.");
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (!_committedRequestIds.Add(envelope.RequestId))
            {
                throw new AuthoringExtensionContractException("Duplicate mutation request is rejected.");
            }
        }

        AuthoringTransactionReceipt receipt = await transaction.ApplyAsync(plan with
        {
            Mutations = [.. plan.Mutations]
        }, cancellationToken);
        ValidateTransactionReceipt(receipt, plan);
        return receipt;
    }

    /// <summary>
    /// Computes the content binding for a closed mutation preview, not permission
    /// to approve it. The host confirmation owner must supply its own approval.
    /// </summary>
    /// <remarks>
    /// Version 1 frames fields in the order below: integers are little-endian
    /// Int64; strings have an Int64 UTF-16 code-unit count followed by the exact
    /// little-endian code units. Ordered mutations are never sorted or normalized.
    /// This internal hash material is not an RPC serialization or a signature.
    /// </remarks>
    /// <param name="envelope">The host's closed preview envelope and bounded ordered mutation plan.</param>
    /// <returns>The lowercase SHA-256 of that exact owned content and host context.</returns>
    /// <exception cref="AuthoringExtensionContractException">The mutation payload is missing or violates the existing plan bounds.</exception>
    public static string ComputeMutationPreviewDigest(AuthoringRpcEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        envelope = CaptureOwnedMutationEnvelope(envelope);
        AuthoringMutationPlan plan = envelope.Payload.MutationPlan!;
        ValidateMutationPlanContent(plan, envelope);
        return ComputeOwnedMutationPreviewDigest(envelope, plan);
    }

    private static AuthoringRpcEnvelope CaptureOwnedMutationEnvelope(AuthoringRpcEnvelope envelope)
    {
        if (envelope.Method != AuthoringRpcMethod.MutationRequest ||
            envelope.Payload?.MutationPlan is not { } plan ||
            plan.Mutations.IsDefaultOrEmpty || plan.Mutations.Length > 1000)
        {
            throw new AuthoringExtensionContractException("RPC method does not carry one closed mutation plan.");
        }
        return envelope with
        {
            Payload = envelope.Payload with
            {
                MutationPlan = plan with
                {
                    Mutations = [.. plan.Mutations]
                }
            }
        };
    }

    private static string ComputeOwnedMutationPreviewDigest(
        AuthoringRpcEnvelope envelope,
        AuthoringMutationPlan plan)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendPreviewString(hash, "fsusblog.authoring-mutation-preview.v1");
        AppendPreviewInteger(hash, envelope.SchemaVersion);
        AppendPreviewInteger(hash, (int)envelope.Method);
        AppendPreviewString(hash, envelope.RuntimeIdentity);
        AppendPreviewString(hash, envelope.ExtensionId);
        AppendPreviewString(hash, envelope.ExtensionVersion);
        AppendPreviewString(hash, envelope.PackageSha256);
        AppendPreviewString(hash, envelope.ContentSha256);
        AppendPreviewString(hash, envelope.ContributionId);
        AppendPreviewInteger(hash, (int)envelope.ExecutionClass);
        AppendPreviewString(hash, envelope.RequestId);
        AppendPreviewString(hash, envelope.DocumentId);
        AppendPreviewInteger(hash, envelope.DocumentEpoch);
        AppendPreviewInteger(hash, envelope.SourceRevision);
        AppendPreviewString(hash, envelope.SnapshotSha256);
        AppendPreviewString(hash, envelope.HostApiDigest);
        AppendPreviewString(hash, envelope.SchemaDigest);
        AppendPreviewString(hash, envelope.PolicyDigest);
        AppendPreviewString(hash, envelope.GrantDigest);
        AppendPreviewInteger(hash, envelope.Deadline.UtcTicks);
        AppendPreviewString(hash, envelope.SiteIdentity);
        AppendPreviewString(hash, envelope.Purpose);
        AppendPreviewString(hash, plan.PlanId);
        AppendPreviewString(hash, plan.DocumentId);
        AppendPreviewInteger(hash, plan.DocumentEpoch);
        AppendPreviewInteger(hash, plan.ExpectedSourceRevision);
        AppendPreviewString(hash, plan.ExpectedSnapshotSha256);
        AppendPreviewString(hash, plan.SelectionIdentity);
        AppendPreviewInteger(hash, plan.Mutations.Length);
        foreach (AuthoringMutation mutation in plan.Mutations)
        {
            AppendPreviewInteger(hash, (int)mutation.Operation);
            AppendPreviewInteger(hash, mutation.Range.Start);
            AppendPreviewInteger(hash, mutation.Range.End);
            AppendPreviewString(hash, mutation.Text);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void AppendPreviewInteger(IncrementalHash hash, long value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
        hash.AppendData(bytes);
    }

    private static void AppendPreviewString(IncrementalHash hash, string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        AppendPreviewInteger(hash, value.Length);
        Span<byte> bytes = stackalloc byte[512];
        for (int offset = 0; offset < value.Length;)
        {
            int count = Math.Min(bytes.Length / sizeof(char), value.Length - offset);
            for (int index = 0; index < count; index++)
            {
                BinaryPrimitives.WriteUInt16LittleEndian(
                    bytes.Slice(index * sizeof(char), sizeof(char)), value[offset + index]);
            }
            hash.AppendData(bytes[..(count * sizeof(char))]);
            offset += count;
        }
    }

    public void ValidateEnvelope(AuthoringRpcEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(envelope.Payload);
        int payloadCount =
            (envelope.Payload.DocumentRange is null ? 0 : 1) +
            (envelope.Payload.MutationPlan is null ? 0 : 1) +
            (envelope.Payload.QueryReference is null ? 0 : 1) +
            (envelope.Payload.BrokerGrantId is null ? 0 : 1) +
            (envelope.Payload.DiagnosticSchemaReference is null ? 0 : 1) +
            (envelope.Payload.StateKey is null ? 0 : 1) +
            (envelope.Payload.StateValue.IsDefault ? 0 : 1);
        bool brokerMethod = envelope.Method is AuthoringRpcMethod.NetworkBrokerRequest or AuthoringRpcMethod.FileBrokerRequest;
        bool brokerPayload = envelope.Method == AuthoringRpcMethod.NetworkBrokerRequest
            ? envelope.Payload.NetworkBroker is not null && envelope.Payload.FileBroker is null
            : envelope.Method == AuthoringRpcMethod.FileBrokerRequest &&
                envelope.Payload.FileBroker is not null && envelope.Payload.NetworkBroker is null;
        bool versionedPayload = brokerMethod
            ? envelope.SchemaVersion == 2 && brokerPayload && payloadCount == 1 &&
                IsBoundedField(envelope.Payload.BrokerGrantId, 64) &&
                string.Equals(envelope.Payload.BrokerGrantId, envelope.GrantDigest, StringComparison.Ordinal)
            : envelope.SchemaVersion == 1 && payloadCount == 1 &&
                envelope.Payload.NetworkBroker is null && envelope.Payload.FileBroker is null;
        if (!versionedPayload || !Enum.IsDefined(envelope.Method) ||
            !Enum.IsDefined(envelope.ExecutionClass) ||
            envelope.Deadline <= timeProvider.GetUtcNow() ||
            envelope.DocumentEpoch < 1 || envelope.SourceRevision < 0 ||
            !IsBoundedField(envelope.ExtensionId, 128) ||
            !IsBoundedField(envelope.ExtensionVersion, 64) ||
            !IsBoundedField(envelope.ContributionId, 256) ||
            !IsBoundedField(envelope.RequestId, 256) ||
            !IsBoundedField(envelope.DocumentId, 256) ||
            !IsBoundedField(envelope.SiteIdentity, 256) ||
            !IsBoundedField(envelope.Purpose, 256) ||
            new[]
            {
                envelope.RuntimeIdentity,
                envelope.PackageSha256,
                envelope.ContentSha256,
                envelope.SnapshotSha256,
                envelope.HostApiDigest,
                envelope.SchemaDigest,
                envelope.PolicyDigest,
                envelope.GrantDigest
            }.Any(static digest => !IsDigest(digest)))
        {
            throw new AuthoringExtensionContractException("RPC envelope is unknown, untyped, unbounded, stale, or incompletely identity-bound.");
        }
    }

    private static void ValidateMutationPlan(
        AuthoringMutationPlan plan,
        AuthoringRpcEnvelope envelope,
        AuthoringMutationApproval approval)
    {
        if (approval is null || !approval.Approved ||
            !string.Equals(approval.PlanId, plan.PlanId, StringComparison.Ordinal) ||
            !IsBoundedField(approval.ApprovalReceiptId, 256) ||
            !IsDigest(approval.PreviewDigest))
        {
            throw new AuthoringExtensionContractException("Mutation plan is unapproved, stale, or outside its bound.");
        }
        ValidateMutationPlanContent(plan, envelope);
        if (!string.Equals(approval.PreviewDigest, ComputeOwnedMutationPreviewDigest(envelope, plan), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Mutation preview does not bind the exact approved plan and host context.");
        }
    }

    private static void ValidateMutationPlanContent(
        AuthoringMutationPlan plan,
        AuthoringRpcEnvelope envelope)
    {
        if (!IsBoundedField(plan.PlanId, 256) ||
            !IsBoundedField(plan.DocumentId, 256) ||
            !IsBoundedField(plan.SelectionIdentity, 256) ||
            !IsDigest(plan.ExpectedSnapshotSha256) ||
            !string.Equals(plan.DocumentId, envelope.DocumentId, StringComparison.Ordinal) ||
            plan.DocumentEpoch != envelope.DocumentEpoch ||
            plan.ExpectedSourceRevision != envelope.SourceRevision ||
            !string.Equals(plan.ExpectedSnapshotSha256, envelope.SnapshotSha256, StringComparison.Ordinal) ||
            plan.Mutations.IsDefaultOrEmpty || plan.Mutations.Length > 1000)
        {
            throw new AuthoringExtensionContractException("Mutation plan is unapproved, stale, or outside its bound.");
        }

        foreach (AuthoringMutation mutation in plan.Mutations)
        {
            if (mutation is null || mutation.Range is null || mutation.Text is null ||
                !Enum.IsDefined(mutation.Operation) ||
                mutation.Range.Start < 0 || mutation.Range.End < mutation.Range.Start ||
                mutation.Text.Length > 1024 * 1024 ||
                mutation.Text.Contains("<script", StringComparison.OrdinalIgnoreCase))
            {
                throw new AuthoringExtensionContractException("Mutation contains an invalid range or executable markup.");
            }
        }

        AuthoringTextRange[] orderedRanges = [.. plan.Mutations
            .Select(static mutation => mutation.Range)
            .OrderBy(static range => range.Start)
            .ThenBy(static range => range.End)];
        for (int index = 1; index < orderedRanges.Length; index++)
        {
            if (orderedRanges[index].Start < orderedRanges[index - 1].End)
            {
                throw new AuthoringExtensionContractException("Mutation ranges overlap; nearest-match merging is forbidden.");
            }
        }
    }

    public static string ComputeTransactionReceiptDigest(AuthoringTransactionReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        string material = string.Join('\n',
            receipt.TransactionId,
            receipt.PlanId,
            receipt.DocumentId,
            receipt.PreviousRevision,
            receipt.NewRevision,
            receipt.HistoryEntryId,
            receipt.SelectionIdentity,
            receipt.Dirty);
        return Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(material)));
    }

    private static void ValidateTransactionReceipt(
        AuthoringTransactionReceipt receipt,
        AuthoringMutationPlan plan)
    {
        if (receipt is null ||
            !IsBoundedField(receipt.TransactionId, 256) ||
            !string.Equals(receipt.PlanId, plan.PlanId, StringComparison.Ordinal) ||
            !string.Equals(receipt.DocumentId, plan.DocumentId, StringComparison.Ordinal) ||
            receipt.PreviousRevision != plan.ExpectedSourceRevision ||
            receipt.NewRevision <= receipt.PreviousRevision ||
            !IsBoundedField(receipt.HistoryEntryId, 256) ||
            !string.Equals(receipt.SelectionIdentity, plan.SelectionIdentity, StringComparison.Ordinal) ||
            !receipt.Dirty ||
            !string.Equals(
                receipt.ReceiptDigest,
                ComputeTransactionReceiptDigest(receipt),
                StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException(
                "Canonical transaction receipt is stale, tampered, or incompletely bound.");
        }
    }

    private static bool IsBoundedField(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= maximumLength &&
        value == value.Trim() &&
        !value.ContainsAny(['\0', '\r', '\n']);

    private static bool IsDigest(string? value) =>
        value?.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
