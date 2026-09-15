using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed record RevisionSourceDiffReceipt(
    int SchemaVersion,
    string EngineVersion,
    string SegmenterVersion,
    string StructureParserVersion,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string PlanDigest,
    string BaseSourceDigest,
    string CompareSourceDigest,
    string BaseStructureDigest,
    string CompareStructureDigest,
    string BudgetDigest,
    string AdmissionDigest,
    int BaseSourceByteCount,
    int CompareSourceByteCount,
    int BaseLineCount,
    int CompareLineCount,
    int TokenCount,
    int WordEditCount,
    int HeadingCount,
    int ContextGroupCount,
    int HunkCount,
    int ChunkCount,
    long EstimatedMemoryBytes,
    long EstimatedOutputBytes,
    string ContentDigest);

public sealed record RevisionSourceDiffAttemptReceipt(
    string SemanticContentDigest,
    RevisionComparePlanStatus Status,
    long ElapsedMilliseconds,
    string ContentDigest);

public sealed record RevisionSourceDiffResult(
    RevisionComparePlanStatus Status,
    ImmutableArray<RevisionDiffChunk> Chunks,
    ImmutableArray<RevisionDiffLine> BaseLines,
    ImmutableArray<RevisionDiffLine> CompareLines,
    ImmutableArray<RevisionDiffHeading> BaseHeadings,
    ImmutableArray<RevisionDiffHeading> CompareHeadings,
    ImmutableArray<RevisionDiffContextGroup> ContextGroups,
    RevisionSourceDiffReceipt Receipt,
    RevisionSourceDiffAttemptReceipt AttemptReceipt)
{
    public bool IsSuccess => Status == RevisionComparePlanStatus.Accepted;
}
