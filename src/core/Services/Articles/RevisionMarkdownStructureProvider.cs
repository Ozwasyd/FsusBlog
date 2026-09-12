using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

/// <summary>
/// Produces the repository's canonical, read-only heading projection directly from
/// immutable Markdown source bytes. It recognizes only top-level CommonMark ATX and
/// setext headings and deliberately excludes fenced and indented code, block quotes,
/// list items, and HTML. It never renders or normalizes the source.
/// </summary>
public sealed partial class CanonicalRevisionMarkdownStructureProvider : IRevisionMarkdownStructureProvider
{
    public const string ParserVersion = "fsusblog-markdown-source-v1";

    public Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        if (!string.Equals(
            request.SourceDigest,
            RevisionCompareCanonical.Sha256(request.RawMarkdown.AsSpan()),
            StringComparison.Ordinal))
        {
            return Task.FromResult(RevisionMarkdownStructureReadResult.Invalid());
        }

        ImmutableArray<SourceLine> lines = SplitLines(request.RawMarkdown.AsSpan(), cancellationToken);
        var headings = ImmutableArray.CreateBuilder<RevisionMarkdownHeadingNode>();
        FenceState fence = default;
        bool htmlBlock = false;
        bool listContinuation = false;
        for (int index = 0; index < lines.Length; index++)
        {
            if ((index & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            SourceLine line = lines[index];
            ReadOnlySpan<byte> content = request.RawMarkdown.AsSpan(line.Offset, line.ContentLength);
            ReadOnlySpan<byte> syntax = StripBom(content, index);
            if (TryFence(syntax, fence, out FenceState nextFence))
            {
                fence = nextFence;
                continue;
            }
            if (fence.Open)
            {
                continue;
            }

            if (htmlBlock)
            {
                if (syntax.IsEmpty)
                {
                    htmlBlock = false;
                }
                continue;
            }
            if (StartsHtmlBlock(syntax))
            {
                htmlBlock = true;
                continue;
            }

            int leadingSpaces = LeadingSpaces(syntax);
            if (syntax.IsEmpty)
            {
                listContinuation = false;
                continue;
            }
            if (listContinuation)
            {
                if (leadingSpaces > 0)
                {
                    continue;
                }
                listContinuation = false;
            }
            if (leadingSpaces <= 3 && IsListMarker(syntax[leadingSpaces..]))
            {
                listContinuation = true;
                continue;
            }

            if (TryAtxLevel(syntax, out int atxLevel))
            {
                headings.Add(Node(request.RawMarkdown, atxLevel, index, line.Offset, line.TotalLength));
                continue;
            }

            if (index == 0 || !TrySetextLevel(syntax, out int setextLevel))
            {
                continue;
            }
            SourceLine previous = lines[index - 1];
            ReadOnlySpan<byte> previousContent = request.RawMarkdown.AsSpan(previous.Offset, previous.ContentLength);
            if (!IsParagraphCandidate(StripBom(previousContent, index - 1)))
            {
                continue;
            }
            int length = checked(line.Offset + line.TotalLength - previous.Offset);
            headings.Add(Node(request.RawMarkdown, setextLevel, index - 1, previous.Offset, length));
        }

        RevisionMarkdownStructureSnapshot snapshot = RevisionMarkdownStructureSnapshotSeal.Create(
            request,
            ParserVersion,
            headings);
        return Task.FromResult(RevisionMarkdownStructureReadResult.Available(snapshot));
    }

    private static RevisionMarkdownHeadingNode Node(
        ImmutableArray<byte> source,
        int level,
        int lineIndex,
        int offset,
        int length)
        => new(
            level,
            lineIndex,
            new RevisionByteRange(offset, length),
            RevisionCompareCanonical.Sha256(source.AsSpan(offset, length)));

    private readonly record struct SourceLine(int Offset, int ContentLength, int TerminatorLength)
    {
        public int TotalLength => checked(ContentLength + TerminatorLength);
    }

    private readonly record struct FenceState(bool Open, byte Marker, int Length);
}
