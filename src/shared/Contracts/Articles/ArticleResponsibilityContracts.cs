namespace FsusBlog.Contracts.Articles;

/// <summary>A responsibility author's public display name and optional profile URL.</summary>
public sealed record ArticleResponsiblePerson(string Name, string? ProfileUrl);

/// <summary>Structured responsibility evidence; private sources remain marked private.</summary>
public sealed record ArticleEvidenceSource(
    string Title,
    string Url,
    string SourceType,
    DateOnly? AccessedOn,
    string? Version,
    string? CitationNote,
    bool IsPublic = true);

/// <summary>Explicit current responsibility input, including human confirmation and disclosure intent.</summary>
/// <remarks>This does not create a snapshot, infer a legacy author, or supply site configuration.</remarks>
public sealed record ArticleResponsibilityDraft(
    bool InheritSiteAuthor,
    IReadOnlyList<ArticleResponsiblePerson> Authors,
    ArticleResponsiblePerson? Reviewer,
    IReadOnlyList<ArticleEvidenceSource> Sources,
    string? UpdateSummary,
    string? UpdateReason,
    DateTime? EffectiveAt,
    string? ConclusionImpact,
    string? Methodology,
    string? Applicability,
    string? Limitations,
    bool ResponsiblePersonConfirmed,
    bool ContainsStrongClaims,
    bool IsSubstantiveUpdate,
    bool RequiresMethodsDisclosure,
    int ExpectedVersion);

/// <summary>A current prepublication issue with its existing severity, stable code and message.</summary>
public sealed record class PrepublishIssue(string Severity, string Code, string Message);
