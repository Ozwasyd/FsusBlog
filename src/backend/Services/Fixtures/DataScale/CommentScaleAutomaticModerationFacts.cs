using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Explicit selection of an existing noninitial planned step and owner-observed
/// policy inputs. Content, current native identity, region and model authenticity
/// remain caller obligations. This record neither generates scores nor admits rows.
/// </summary>
public sealed record CommentScaleAutomaticModerationFacts(
    CommentScaleRequestCoordinate Coordinate,
    int ModerationStepIndex,
    string ContentRole,
    CommentScaleArtifactReference ContentArtifact,
    Comment CurrentComment,
    RegionModerationDecision Region,
    AntiSpamModerationResult ModelResult);

/// <summary>
/// Ordered explicit automatic-step selections, including an empty selection for
/// an occurrence with no automatic transitions. Unselected steps are not assessed.
/// </summary>
public sealed record CommentScaleAutomaticModerationOccurrenceFacts(
    CommentScaleGraphOccurrence Occurrence,
    IReadOnlyList<CommentScaleAutomaticModerationFacts> Assessments);

/// <summary>
/// Complete original policy decision for a matching requested transition. AutoApplied
/// is the original policy's eligibility flag, not a successful CAS or committed event.
/// The planned instant is preserved without creating a timeline or outbox row.
/// </summary>
public sealed record CommentScaleResolvedAutomaticModeration(
    CommentScaleRequestCoordinate Coordinate,
    int ModerationStepIndex,
    CommentScaleResolvedModerationRequest Step,
    CommentModerationDisposition Disposition);

/// <summary>
/// One occurrence's assessed subset, not a physical graph or equivalence receipt.
/// Complete enumeration is required to detect missing or extra occurrence facts.
/// </summary>
public sealed record CommentScaleResolvedAutomaticModerationGraph(
    CommentScaleResolvedGraphIntent Intent,
    IReadOnlyList<CommentScaleResolvedAutomaticModeration> Assessments);
