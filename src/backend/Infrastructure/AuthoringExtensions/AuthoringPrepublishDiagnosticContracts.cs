using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringDiagnosticSeverity
{
    Info = 0,
    Warning = 1,
    Blocking = 2
}

public enum AuthoringDiagnosticReadScope
{
    Metadata = 0,
    SourceRanges = 1
}

public enum AuthoringDiagnosticCompletion
{
    Findings = 0,
    NoFindings = 1
}

public enum AuthoringDiagnosticUnavailableReason
{
    Disabled = 0,
    Incompatible = 1,
    Crashed = 2,
    TimedOut = 3,
    Cancelled = 4,
    ResourceExceeded = 5,
    Stale = 6,
    PermissionRevoked = 7,
    Uninstalled = 8
}

public enum AuthoringDiagnosticOutcomeStatus
{
    Findings = 0,
    NoFindings = 1,
    RequiredUnavailable = 2,
    OptionalNotEvaluable = 3
}

/// <summary>Diagnostic-specific admission limits; these values grant no runtime resources or retry authority.</summary>
public sealed record AuthoringDiagnosticBudget(
    TimeSpan CpuTime,
    TimeSpan WallTime,
    long MemoryBytes,
    int InputBytes,
    int OutputBytes,
    int ConcurrentCalls,
    int QueueDepth,
    int MaximumFacts,
    int MaximumRanges,
    int MaximumEvidence);

/// <summary>Only named metadata and exact source ranges are supported by this contract version.</summary>
public sealed record AuthoringDiagnosticInputSchema(
    int SchemaVersion,
    AuthoringDiagnosticReadScope Scope,
    string ReadModelReference,
    ImmutableArray<string> MetadataKeys);

/// <summary>Category metadata joined to the existing manifest declaration, never another plugin manifest.</summary>
public sealed record AuthoringPrepublishDiagnosticContribution(
    int SchemaVersion,
    string DiagnosticId,
    string Version,
    string ExtensionId,
    string ContributionId,
    string ContentSha256,
    AuthoringExecutionClass ExecutionClass,
    ImmutableArray<AuthoringCapability> Permissions,
    AuthoringDiagnosticInputSchema InputSchema,
    string PolicyReference,
    AuthoringDiagnosticBudget Budget);

/// <summary>The host fixes one severity per result code. Runtime output cannot choose a different severity.</summary>
public sealed record AuthoringDiagnosticCodePolicy(string Code, AuthoringDiagnosticSeverity Severity);

/// <summary>Host-owned requiredness, result vocabulary, fix references and effective resource ceilings.</summary>
public sealed record AuthoringDiagnosticHostPolicy(
    string DiagnosticId,
    string PolicyReference,
    bool Required,
    ImmutableArray<AuthoringDiagnosticCodePolicy> Codes,
    ImmutableArray<string> FixCommandReferences,
    AuthoringDiagnosticBudget Budget);

/// <summary>
/// An explicit observation supplied by the original core check owner. It neither runs nor redefines a core check.
/// ResultSha256 binds the owner's complete result, including its pass/failure semantics.
/// </summary>
public sealed record AuthoringDiagnosticCoreResult(
    string CheckId,
    bool Required,
    AuthoringDiagnosticSeverity Severity,
    string ResultSha256);

/// <summary>
/// Current host coordinates. GrantSha256 refers to admission by the original grant owner;
/// constructing this value or hashing it does not issue a grant or prove live permission.
/// </summary>
public sealed record AuthoringDiagnosticHostContext(
    long ArticleId,
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    int DocumentLength,
    string SourceSha256,
    string ConfigSha256,
    string GrantSha256,
    string RuntimeIdentity,
    string RuntimeVersion,
    string HostApiSha256,
    string RequestId,
    DateTimeOffset Deadline);

public sealed record AuthoringDiagnosticMetadata(string Key, string Value);

/// <summary>Text already admitted by the canonical host read owner, with exact UTF-16 source coordinates.</summary>
public sealed record AuthoringDiagnosticSourceRange(
    string NodeId,
    AuthoringTextRange Range,
    string Text);

/// <summary>Immutable minimal input; core observations are represented by a digest, never plugin-editable results.</summary>
public sealed record AuthoringPrepublishDiagnosticInput(
    int SchemaVersion,
    string RegistrySha256,
    string DiagnosticId,
    string DiagnosticVersion,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContentSha256,
    string ContributionSha256,
    string PolicySha256,
    string CoreResultsSha256,
    AuthoringDiagnosticHostContext Context,
    AuthoringDiagnosticInputSchema Scope,
    ImmutableArray<AuthoringDiagnosticMetadata> Metadata,
    ImmutableArray<AuthoringDiagnosticSourceRange> SourceRanges,
    string InputSha256);

/// <summary>Evidence is a bounded fact reference and digest, not inline content, HTML, a URL or executable data.</summary>
public sealed record AuthoringDiagnosticEvidence(string Reference, string Sha256);

/// <summary>Plain diagnostic facts. A fix reference is inert until an explicit host command transaction.</summary>
public sealed record AuthoringDiagnosticFact(
    string Id,
    string Code,
    AuthoringDiagnosticSeverity Severity,
    string Message,
    ImmutableArray<AuthoringTextRange> Ranges,
    ImmutableArray<AuthoringDiagnosticEvidence> Evidence,
    string? FixCommandReference);

/// <summary>
/// The only accepted plugin output. NoFindings is explicit; Findings requires at least one fact.
/// There is no pass, requiredness, core result replacement, HTML or patch member.
/// </summary>
public sealed record AuthoringPrepublishDiagnosticResponse(
    int SchemaVersion,
    string DiagnosticId,
    string InputSha256,
    AuthoringDiagnosticCompletion Completion,
    ImmutableArray<AuthoringDiagnosticFact> Facts);

/// <summary>
/// A structurally validated immutable outcome. Host policy owns Required. This is not a publication receipt,
/// live grant, sandbox attestation or final gate decision; those owners must recheck current authority.
/// </summary>
public sealed class AuthoringPrepublishDiagnosticResult
{
    internal AuthoringPrepublishDiagnosticResult(
        AuthoringPrepublishDiagnosticInput input,
        bool required,
        AuthoringDiagnosticOutcomeStatus status,
        ImmutableArray<AuthoringDiagnosticFact> facts,
        AuthoringDiagnosticUnavailableReason? unavailableReason)
    {
        Input = input;
        Required = required;
        Status = status;
        Facts = facts;
        UnavailableReason = unavailableReason;
    }

    public AuthoringPrepublishDiagnosticInput Input
    {
        get;
    }

    public bool Required
    {
        get;
    }

    public AuthoringDiagnosticOutcomeStatus Status
    {
        get;
    }

    public ImmutableArray<AuthoringDiagnosticFact> Facts
    {
        get;
    }

    public AuthoringDiagnosticUnavailableReason? UnavailableReason
    {
        get;
    }
}
