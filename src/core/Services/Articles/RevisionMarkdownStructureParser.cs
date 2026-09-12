using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class CanonicalRevisionMarkdownStructureProvider
{
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

}
