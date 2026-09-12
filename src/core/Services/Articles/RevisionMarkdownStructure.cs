using System.Collections.Immutable;
using System.Security.Cryptography;

namespace FsusBlog.Core.Services.Articles;

public enum RevisionMarkdownStructureReadStatus
{
    Available = 0,
    Unavailable = 1,
    Invalid = 2
}

public sealed record RevisionMarkdownHeadingNode(
    int Level,
    int LineIndex,
    RevisionByteRange Source,
    string IdentityDigest);

public sealed record RevisionMarkdownStructureRequest(
    string SourceDigest,
    ImmutableArray<byte> RawMarkdown);

public sealed record RevisionMarkdownStructureSnapshot(
    int SchemaVersion,
    string ParserVersion,
    string SourceDigest,
    ImmutableArray<RevisionMarkdownHeadingNode> Headings,
    string ContentDigest);

public sealed record RevisionMarkdownStructureReadResult(
    RevisionMarkdownStructureReadStatus Status,
    RevisionMarkdownStructureSnapshot? Snapshot)
{
    public static RevisionMarkdownStructureReadResult Unavailable()
        => new(RevisionMarkdownStructureReadStatus.Unavailable, null);

    public static RevisionMarkdownStructureReadResult Invalid()
        => new(RevisionMarkdownStructureReadStatus.Invalid, null);

    public static RevisionMarkdownStructureReadResult Available(RevisionMarkdownStructureSnapshot snapshot)
        => new(RevisionMarkdownStructureReadStatus.Available, snapshot);
}

public interface IRevisionMarkdownStructureProvider
{
    Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default);
}

public interface IRevisionMarkdownStructureAuthority
{
    Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class RevisionMarkdownStructureAuthority(
    IEnumerable<IRevisionMarkdownStructureProvider> providers) : IRevisionMarkdownStructureAuthority
{
    private readonly IRevisionMarkdownStructureProvider[] _providers = [.. providers];

    public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default)
    {
        if (_providers.Length == 0)
        {
            return RevisionMarkdownStructureReadResult.Unavailable();
        }
        if (_providers.Length != 1)
        {
            return RevisionMarkdownStructureReadResult.Invalid();
        }

        RevisionMarkdownStructureReadResult result = await _providers[0]
            .ReadAsync(request, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (result.Status != RevisionMarkdownStructureReadStatus.Available
            || result.Snapshot is null)
        {
            return new RevisionMarkdownStructureReadResult(result.Status, null);
        }
        return RevisionMarkdownStructureSnapshotSeal.Verify(request, result.Snapshot)
            ? result
            : RevisionMarkdownStructureReadResult.Invalid();
    }
}

/// <summary>
/// Produces the repository's canonical, read-only heading projection directly from
/// immutable Markdown source bytes. It recognizes only top-level CommonMark ATX and
/// setext headings and deliberately excludes fenced and indented code, block quotes,
/// list items, and HTML. It never renders or normalizes the source.
/// </summary>
public sealed class CanonicalRevisionMarkdownStructureProvider : IRevisionMarkdownStructureProvider
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

    private static ImmutableArray<SourceLine> SplitLines(
        ReadOnlySpan<byte> source,
        CancellationToken cancellationToken)
    {
        if (source.IsEmpty)
        {
            return [];
        }
        var lines = ImmutableArray.CreateBuilder<SourceLine>();
        int start = 0;
        for (int index = 0; index < source.Length; index++)
        {
            if ((index & 4095) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            int terminatorLength = source[index] switch
            {
                (byte)'\n' => 1,
                (byte)'\r' when index + 1 < source.Length && source[index + 1] == (byte)'\n' => 2,
                (byte)'\r' => 1,
                _ => 0
            };
            if (terminatorLength == 0)
            {
                continue;
            }
            lines.Add(new SourceLine(start, index - start, terminatorLength));
            index += terminatorLength - 1;
            start = index + 1;
        }
        if (start < source.Length)
        {
            lines.Add(new SourceLine(start, source.Length - start, 0));
        }
        else if (source.Length > 0 && (source[^1] == (byte)'\n' || source[^1] == (byte)'\r'))
        {
            lines.Add(new SourceLine(source.Length, 0, 0));
        }
        return lines.ToImmutable();
    }

    private static ReadOnlySpan<byte> StripBom(ReadOnlySpan<byte> line, int lineIndex)
        => lineIndex == 0
            && line.Length >= 3
            && line[0] == 0xef
            && line[1] == 0xbb
            && line[2] == 0xbf
                ? line[3..]
                : line;

    private static bool TryAtxLevel(ReadOnlySpan<byte> line, out int level)
    {
        level = 0;
        int index = LeadingSpaces(line);
        if (index > 3)
        {
            return false;
        }
        while (index + level < line.Length && line[index + level] == (byte)'#' && level < 7)
        {
            level++;
        }
        return level is >= 1 and <= 6
            && (index + level == line.Length || IsSpaceOrTab(line[index + level]));
    }

    private static bool TrySetextLevel(ReadOnlySpan<byte> line, out int level)
    {
        level = 0;
        int index = LeadingSpaces(line);
        if (index > 3 || index >= line.Length || line[index] is not ((byte)'=' or (byte)'-'))
        {
            return false;
        }
        byte marker = line[index++];
        while (index < line.Length && line[index] == marker)
        {
            index++;
        }
        while (index < line.Length && IsSpaceOrTab(line[index]))
        {
            index++;
        }
        if (index != line.Length)
        {
            return false;
        }
        level = marker == (byte)'=' ? 1 : 2;
        return true;
    }

    private static bool IsParagraphCandidate(ReadOnlySpan<byte> line)
    {
        int leading = LeadingSpaces(line);
        if (leading > 3 || leading >= line.Length)
        {
            return false;
        }
        byte first = line[leading];
        return first is not ((byte)'>' or (byte)'<' or (byte)'#' or (byte)'`' or (byte)'~')
            && !IsListMarker(line[leading..]);
    }

    private static bool IsListMarker(ReadOnlySpan<byte> line)
    {
        if (line.Length >= 2
            && (line[0] is (byte)'-' or (byte)'+' or (byte)'*')
            && IsSpaceOrTab(line[1]))
        {
            return true;
        }
        int index = 0;
        while (index < line.Length && index < 9 && line[index] is >= (byte)'0' and <= (byte)'9')
        {
            index++;
        }
        return index > 0
            && index + 1 < line.Length
            && (line[index] is (byte)'.' or (byte)')')
            && IsSpaceOrTab(line[index + 1]);
    }

    private static bool StartsHtmlBlock(ReadOnlySpan<byte> line)
    {
        int index = LeadingSpaces(line);
        if (index > 3 || index >= line.Length || line[index] != (byte)'<')
        {
            return false;
        }
        ReadOnlySpan<byte> content = line[index..];
        if (content.StartsWith("<!--"u8)
            || content.StartsWith("<?"u8)
            || content.StartsWith("<![CDATA["u8))
        {
            return true;
        }
        if (content.Length >= 3 && content[1] == (byte)'!')
        {
            return IsAsciiLetter(content[2]);
        }

        int name = 1;
        if (name < content.Length && content[name] == (byte)'/')
        {
            name++;
        }
        int start = name;
        while (name < content.Length && (IsAsciiLetter(content[name]) || IsAsciiDigit(content[name])))
        {
            name++;
        }
        return name > start
            && name < content.Length
            && (IsSpaceOrTab(content[name]) || content[name] is (byte)'/' or (byte)'>');
    }

    private static bool IsAsciiLetter(byte value)
        => value is >= (byte)'A' and <= (byte)'Z' or >= (byte)'a' and <= (byte)'z';

    private static bool IsAsciiDigit(byte value)
        => value is >= (byte)'0' and <= (byte)'9';

    private static bool TryFence(ReadOnlySpan<byte> line, FenceState current, out FenceState next)
    {
        next = current;
        int index = LeadingSpaces(line);
        if (index > 3 || index >= line.Length || line[index] is not ((byte)'`' or (byte)'~'))
        {
            return false;
        }
        byte marker = line[index];
        int count = 0;
        while (index + count < line.Length && line[index + count] == marker)
        {
            count++;
        }
        if (count < 3)
        {
            return false;
        }
        if (!current.Open)
        {
            next = new FenceState(true, marker, count);
            return true;
        }
        if (current.Marker != marker || count < current.Length)
        {
            return false;
        }
        for (int trailing = index + count; trailing < line.Length; trailing++)
        {
            if (!IsSpaceOrTab(line[trailing]))
            {
                return false;
            }
        }
        next = default;
        return true;
    }

    private static int LeadingSpaces(ReadOnlySpan<byte> line)
    {
        int count = 0;
        while (count < line.Length && line[count] == (byte)' ')
        {
            count++;
        }
        return count;
    }

    private static bool IsSpaceOrTab(byte value)
        => value is (byte)' ' or (byte)'\t';

    private readonly record struct SourceLine(int Offset, int ContentLength, int TerminatorLength)
    {
        public int TotalLength => checked(ContentLength + TerminatorLength);
    }

    private readonly record struct FenceState(bool Open, byte Marker, int Length);
}

public static class RevisionMarkdownStructureSnapshotSeal
{
    public const int SchemaVersion = 1;

    public static RevisionMarkdownStructureSnapshot Create(
        RevisionMarkdownStructureRequest request,
        string parserVersion,
        IEnumerable<RevisionMarkdownHeadingNode> headings)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(parserVersion)
            || !string.Equals(
                request.SourceDigest,
                RevisionCompareCanonical.Sha256(request.RawMarkdown.AsSpan()),
                StringComparison.Ordinal))
        {
            throw new RevisionCompareContractException("revision_diff_structure_invalid");
        }
        ImmutableArray<RevisionMarkdownHeadingNode> materialized = [.. headings];
        if (!ValidHeadings(materialized, request.RawMarkdown))
        {
            throw new RevisionCompareContractException("revision_diff_structure_invalid");
        }
        return new RevisionMarkdownStructureSnapshot(
            SchemaVersion,
            parserVersion,
            request.SourceDigest,
            materialized,
            Digest(parserVersion, request.SourceDigest, materialized));
    }

    public static bool Verify(
        RevisionMarkdownStructureRequest request,
        RevisionMarkdownStructureSnapshot snapshot)
        => snapshot.SchemaVersion == SchemaVersion
            && !string.IsNullOrWhiteSpace(snapshot.ParserVersion)
            && string.Equals(snapshot.SourceDigest, request.SourceDigest, StringComparison.Ordinal)
            && string.Equals(
                request.SourceDigest,
                RevisionCompareCanonical.Sha256(request.RawMarkdown.AsSpan()),
                StringComparison.Ordinal)
            && ValidHeadings(snapshot.Headings, request.RawMarkdown)
            && string.Equals(
                snapshot.ContentDigest,
                Digest(snapshot.ParserVersion, snapshot.SourceDigest, snapshot.Headings),
                StringComparison.Ordinal);

    private static bool ValidHeadings(
        ImmutableArray<RevisionMarkdownHeadingNode> headings,
        ImmutableArray<byte> source)
    {
        int previousLine = -1;
        int previousEnd = 0;
        foreach (RevisionMarkdownHeadingNode heading in headings)
        {
            if (heading.Level is < 1 or > 6
                || heading.LineIndex <= previousLine
                || heading.Source.Offset < previousEnd
                || heading.Source.Offset < 0
                || heading.Source.Length <= 0
                || heading.Source.Offset > source.Length
                || heading.Source.Length > source.Length - heading.Source.Offset
                || !string.Equals(
                    heading.IdentityDigest,
                    RevisionCompareCanonical.Sha256(source.AsSpan(heading.Source.Offset, heading.Source.Length)),
                    StringComparison.Ordinal))
            {
                return false;
            }
            previousLine = heading.LineIndex;
            previousEnd = heading.Source.Offset + heading.Source.Length;
        }
        return true;
    }

    private static string Digest(
        string parserVersion,
        string sourceDigest,
        ImmutableArray<RevisionMarkdownHeadingNode> headings)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, SchemaVersion);
        RevisionCompareCanonical.Append(hash, parserVersion);
        RevisionCompareCanonical.Append(hash, sourceDigest);
        RevisionCompareCanonical.Append(hash, headings.Length);
        foreach (RevisionMarkdownHeadingNode heading in headings)
        {
            RevisionCompareCanonical.Append(hash, heading.Level);
            RevisionCompareCanonical.Append(hash, heading.LineIndex);
            RevisionCompareCanonical.Append(hash, heading.Source.Offset);
            RevisionCompareCanonical.Append(hash, heading.Source.Length);
            RevisionCompareCanonical.Append(hash, heading.IdentityDigest);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}
