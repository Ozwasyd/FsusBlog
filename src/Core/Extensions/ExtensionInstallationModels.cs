using System.Collections.Immutable;

namespace FsusBlog.V2.Core.Extensions;

public sealed record ExtensionCheckpoint(long Sequence, string Digest);
public sealed record ExtensionQuarantine(Guid Receipt, string Reason, DateTimeOffset QuarantinedAt,
    Guid? ReleaseApproval = null, DateTimeOffset? ReleasedAt = null);
public sealed record ExtensionInstallationStatus(string Id, string Version, string Publisher, string Identity, string State,
    string? VerificationIssue, ExtensionQuarantine? Quarantine);
public sealed record ExtensionStoreStatus(ExtensionCheckpoint Checkpoint, ImmutableArray<ExtensionInstallationStatus> Installations);
