using System.Globalization;
using System.Text;

namespace FsusBlog.V2.Core.Authoring;

public enum CanvasAnchorState { Missing, Duplicate, Resolved }

/// <summary>The offset, when resolved, is the zero-based UTF-16 index of the marker's caret.</summary>
public readonly record struct CanvasAnchorResolution(CanvasAnchorState State, string? Excerpt, int? SourceOffset);

/// <summary>Projects the explicit FsusUI Markdown anchor grammar from one article revision.</summary>
public static class CanvasAnchor
{
    public const int MaxSourceCharacters = 200_000;
    public const int MaxExcerptCharacters = 256;

    public static CanvasAnchorResolution Find(string source, string canonicalAnchor, bool requireHeading,
        CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (source is null || source.Length > MaxSourceCharacters || !IsCanonical(canonicalAnchor))
            return default;

        (int lastLatexClose, int lastContainerClose) = LastClosers(source, ct);
        int firstClaim = -1;
        bool heading = false;
        string? excerpt = null;
        var previousLine = default(SourceLine);
        var lastNonblank = default(SourceLine);
        var beforeLastNonblank = default(SourceLine);
        var literal = new LiteralRegion(RegionKind.None);
        int next = 0;
        while (next < source.Length)
        {
            ct.ThrowIfCancellationRequested();
            var currentLine = ReadLine(source, ref next);
            var line = currentLine.Slice(source);
            var previous = previousLine.Slice(source);
            var syntax = TrimSyntaxIndent(line);
            var fence = FenceLength(syntax);
            if (literal.Kind != RegionKind.None)
            {
                if (literal.Closes(syntax, fence)) literal = default;
            }
            else if (fence >= 3) literal = new(RegionKind.Fence, syntax[0], fence);
            else if (currentLine.Start < lastLatexClose && syntax.StartsWith("$$", StringComparison.Ordinal)) literal = new(RegionKind.Latex);
            else if (currentLine.Start < lastContainerClose && IsContainerOpen(syntax)) literal = new(RegionKind.Container);
            else
            {
                int caret = line.Length - canonicalAnchor.Length - 1;
                if (caret >= 0 && line[caret] == '^' && (caret == 0 || line[caret - 1] == ' ')
                    && line[(caret + 1)..].SequenceEqual(canonicalAnchor))
                {
                    // v1 also accepts the single-indented form via its following-line path.
                    // Longer whitespace-only indentation or orphan exclusive lines confer no ownership.
                    bool exclusive = line[0] == '^';
                    var owner = exclusive || caret == 1 ? previous : line[..caret];
                    if (exclusive ? IsAtomicOwner(previous) : caret == 1 || !Trim(owner).IsEmpty)
                    {
                        if (firstClaim >= 0) return new(CanvasAnchorState.Duplicate, null, null);
                        firstClaim = currentLine.Start + caret;
                        if (exclusive && IsBareCloser(previous)) owner = beforeLastNonblank.Slice(source);
                        heading = !exclusive && TryHeading(owner, out _);
                        excerpt = PlainExcerpt(TryHeading(TrimStart(owner), out var body) ? body : owner);
                    }
                }
            }

            previousLine = currentLine;
            if (!Trim(line).IsEmpty) (beforeLastNonblank, lastNonblank) = (lastNonblank, currentLine);
        }

        return firstClaim < 0 || requireHeading && !heading ? default : new(CanvasAnchorState.Resolved, excerpt, firstClaim);
    }

    private static (int Latex, int Container) LastClosers(string source, CancellationToken ct)
    {
        // FsusUI suppresses $$ and ::: blocks only if a later bare closer exists. Looking
        // up the last possible closer first avoids a repeated lookahead through malformed source.
        int latex = -1;
        int container = -1;
        int next = 0;
        while (next < source.Length)
        {
            ct.ThrowIfCancellationRequested();
            var current = ReadLine(source, ref next);
            var line = TrimEnd(TrimSyntaxIndent(current.Slice(source)));
            if (line.SequenceEqual("$$")) latex = current.Start;
            if (line.SequenceEqual(":::")) container = current.Start;
        }
        return (latex, container);
    }

    private static SourceLine ReadLine(string source, ref int next)
    {
        int start = next;
        var remainder = source.AsSpan(next);
        int lf = remainder.IndexOf('\n');
        int length = lf < 0 ? remainder.Length : lf;
        next += length + (lf < 0 ? 0 : 1);
        if (length > 0 && remainder[length - 1] == '\r') length--;
        return new(start, length);
    }

    internal static bool IsCanonical(string? anchor)
    {
        if (anchor is not { Length: >= 1 and <= 64 } || anchor[0] is < 'a' or > 'z') return false;
        foreach (char character in anchor.AsSpan(1))
            if (character is not (>= 'a' and <= 'z' or >= '0' and <= '9' or '-')) return false;
        return true;
    }

    private static int FenceLength(ReadOnlySpan<char> syntax)
    {
        if (syntax.IsEmpty || syntax[0] is not ('`' or '~')) return 0;
        int length = 1;
        while (length < syntax.Length && syntax[length] == syntax[0]) length++;
        return length;
    }

    private static bool IsContainerOpen(ReadOnlySpan<char> syntax) =>
        syntax.Length > 3 && syntax.StartsWith(":::", StringComparison.Ordinal) && !IsWhitespace(syntax[3]);

    private static bool IsAtomicOwner(ReadOnlySpan<char> line)
    {
        var syntax = TrimSyntaxIndent(line);
        return FenceLength(syntax) >= 3 || syntax.StartsWith("$$", StringComparison.Ordinal)
            || syntax.StartsWith(":::", StringComparison.Ordinal) || TrimStart(line).StartsWith("|", StringComparison.Ordinal)
            || IsRegistered(syntax);
    }

    private static bool IsBareCloser(ReadOnlySpan<char> line)
    {
        var syntax = TrimEnd(TrimSyntaxIndent(line));
        return syntax.SequenceEqual("```") || syntax.SequenceEqual("~~~")
            || syntax.SequenceEqual("$$") || syntax.SequenceEqual(":::");
    }

    private static bool IsRegistered(ReadOnlySpan<char> syntax)
    {
        if (syntax.Length < 4 || !syntax.StartsWith("::", StringComparison.Ordinal) || syntax[2] is < 'a' or > 'z')
            return false;
        int index = 3;
        while (index < syntax.Length && syntax[index] is >= 'a' and <= 'z' or >= '0' and <= '9' or '-') index++;
        return index < syntax.Length && syntax[index] == '[';
    }

    private static bool TryHeading(ReadOnlySpan<char> owner, out ReadOnlySpan<char> body)
    {
        int hash = 0;
        while (hash < owner.Length && owner[hash] == '#' && hash <= 6) hash++;
        body = hash is >= 1 and <= 6 && hash < owner.Length && IsWhitespace(owner[hash])
            ? Trim(owner[hash..]) : default;
        return !body.IsEmpty;
    }

    private static ReadOnlySpan<char> TrimSyntaxIndent(ReadOnlySpan<char> value)
    {
        int indent = 0;
        while (indent < 3 && indent < value.Length && IsWhitespace(value[indent])) indent++;
        return value[indent..];
    }

    private static ReadOnlySpan<char> Trim(ReadOnlySpan<char> value) => TrimEnd(TrimStart(value));

    private static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> value)
    {
        int start = 0;
        while (start < value.Length && IsWhitespace(value[start])) start++;
        return value[start..];
    }

    private static ReadOnlySpan<char> TrimEnd(ReadOnlySpan<char> value)
    {
        int end = value.Length;
        while (end > 0 && IsWhitespace(value[end - 1])) end--;
        return value[..end];
    }

    // Match ECMAScript whitespace used by the checked-out FsusUI grammar.
    private static bool IsWhitespace(char value) =>
        value is '\t' or '\n' or '\u000B' or '\u000C' or '\r' or '\u00A0' or '\u1680'
            or >= '\u2000' and <= '\u200A' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' or ' ';

    private static string PlainExcerpt(ReadOnlySpan<char> value)
    {
        Span<char> output = stackalloc char[MaxExcerptCharacters];
        int used = 0;
        foreach (var rune in Trim(value).EnumerateRunes())
        {
            Rune display = rune.Value switch
            {
                '<' => new('‹'),
                '>' => new('›'),
                _ when Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format => new(' '),
                _ => rune
            };
            if (used + display.Utf16SequenceLength > output.Length) break;
            used += display.EncodeToUtf16(output[used..]);
        }
        return output[..used].Trim().ToString();
    }

    private readonly record struct SourceLine(int Start, int Length)
    {
        public ReadOnlySpan<char> Slice(string source) => source.AsSpan(Start, Length);
    }

    private enum RegionKind { None, Fence, Latex, Container }

    private readonly record struct LiteralRegion(RegionKind Kind, char Marker = default, int Length = 0)
    {
        public bool Closes(ReadOnlySpan<char> syntax, int fence) => Kind switch
        {
            RegionKind.Fence => fence >= Length && syntax[0] == Marker && Trim(syntax[fence..]).IsEmpty,
            RegionKind.Latex => TrimEnd(syntax).SequenceEqual("$$"),
            RegionKind.Container => TrimEnd(syntax).SequenceEqual(":::"),
            _ => false
        };
    }
}
