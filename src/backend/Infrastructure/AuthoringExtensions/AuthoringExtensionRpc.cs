using System.Collections.Immutable;

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
    ImmutableArray<byte> StateValue = default);

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

public interface IAuthoringCanonicalDocumentTransaction
{
    ValueTask<AuthoringTransactionReceipt> ApplyAsync(
        AuthoringMutationPlan plan,
        CancellationToken cancellationToken);
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
    TimeProvider timeProvider)
{
    private readonly HashSet<string> _committedRequestIds = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

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

        AuthoringMutationPlan plan = envelope.Payload.MutationPlan;
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

        lock (_gate)
        {
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
        if (envelope.SchemaVersion != 1 || !Enum.IsDefined(envelope.Method) ||
            !Enum.IsDefined(envelope.ExecutionClass) || payloadCount != 1 ||
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
        if (!approval.Approved ||
            !string.Equals(approval.PlanId, plan.PlanId, StringComparison.Ordinal) ||
            !IsBoundedField(plan.PlanId, 256) ||
            !IsBoundedField(plan.DocumentId, 256) ||
            !IsBoundedField(plan.SelectionIdentity, 256) ||
            !IsBoundedField(approval.ApprovalReceiptId, 256) ||
            !IsDigest(approval.PreviewDigest) ||
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
