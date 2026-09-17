using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed record RevisionDiffHunk(
    RevisionDiffKind Kind,
    int BaseStartLine,
    int BaseLineCount,
    int CompareStartLine,
    int CompareLineCount,
    RevisionByteRange Base,
    RevisionByteRange Compare,
    ImmutableArray<RevisionDiffWordEdit> WordEdits,
    ImmutableArray<string> HeadingIdentities);

public sealed record RevisionDiffChunk(
    int Index,
    ImmutableArray<RevisionDiffHunk> Hunks,
    string ContentDigest);
public sealed record RevisionDiffContextGroup(
    int Index,
    bool Collapsed,
    int BaseStartLine,
    int BaseLineCount,
    int CompareStartLine,
    int CompareLineCount,
    RevisionByteRange Base,
    RevisionByteRange Compare,
    string ContentDigest);
