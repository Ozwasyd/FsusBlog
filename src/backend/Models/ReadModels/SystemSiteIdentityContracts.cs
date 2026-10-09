namespace FsusBlog.Server.Models.ReadModels;

/// <summary>Refusal states never expose an identity as current authority.</summary>
public enum SystemSiteIdentityState
{
    Absent,
    MigrationRequired,
    Ambiguous,
    Malformed,
    UnsupportedVersion,
    Current
}

/// <summary>An exact reviewed URL binding; revision is the journal event that added it.</summary>
public sealed record SystemSiteIdentityScope(string Scope, int Revision);

/// <summary>Immutable snapshot of the current server installation and its approved scope bindings.</summary>
public sealed record SystemSiteIdentityReadModel(
    SystemSiteIdentityState State,
    string? Identity,
    int? LifecycleVersion,
    int? Generation,
    int? MappingRevision,
    IReadOnlyList<SystemSiteIdentityScope> Scopes);

/// <summary>Cloning leaves predecessor facts foreign and performs no data reassignment.</summary>
public enum SystemSiteIdentityCloneDisposition
{
    RetainAsForeign = 1
}
