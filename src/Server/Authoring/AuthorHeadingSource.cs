using System.Buffers;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Server.Authoring;

internal readonly record struct AuthorHeadingRange(int Start, int End);
internal sealed record AuthorHeadingBlock(IReadOnlyList<AuthorHeadingRange> ContentRanges);
internal sealed class AuthorHeadingBudgetException() : Exception("The Markdown heading projection exceeds its per-source work budget.");

internal static class AuthorHeadingSource
{
    private const string NativeLibraryName = "fsus_author_heading";
    private const int MaxSyntaxWork = 4096;
    private const int MaxJsonBytes = 8 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly SemaphoreSlim NativeGate = new(1, 1);

    internal static IReadOnlyList<AuthorHeadingBlock> Collect(string source, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (source.Length == 0) return [];
        if (source.Length > AuthorTextProfile.MaxSourceChars) throw new AuthorHeadingBudgetException();

        try
        {
            var sourceBytes = Utf8.GetByteCount(source);
            if (sourceBytes > WireLimits.BodyBytes) throw new AuthorHeadingBudgetException();
            var origins = MapOrigins(source, sourceBytes, ct);
            // Match FsusUI's editor newline normalization before calling the native
            // collector, which drops every CR, including isolated occurrences.
            var input = Utf8.GetBytes(source.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n'));
            return ReadHeadings(CollectJson(input, ct), origins, ct);
        }
        catch (EncoderFallbackException)
        {
            throw InvalidProjection();
        }
        catch (JsonException)
        {
            throw InvalidProjection();
        }
    }

    private static byte[] CollectJson(byte[] input, CancellationToken ct)
    {
        // The C++ collector's JSON belongs to a process-wide buffer until the next call.
        NativeGate.Wait(ct);
        try
        {
            if (CollectNative(input, input.Length) != 1) throw InvalidProjection();
            ct.ThrowIfCancellationRequested();
            var length = JsonLength();
            var pointer = JsonPointer();
            if (length > MaxJsonBytes) throw new AuthorHeadingBudgetException();
            if (length <= 0 || pointer == IntPtr.Zero) throw InvalidProjection();
            var json = new byte[length];
            Marshal.Copy(pointer, json, 0, length);
            return json;
        }
        finally
        {
            NativeGate.Release();
        }
    }

    private static int[] MapOrigins(string source, int byteLength, CancellationToken ct)
    {
        // FsusUI's projection maps each normalized boundary to its earliest raw caret.
        // Store raw offsets plus one so a non-boundary byte retains the zero sentinel.
        var origins = new int[byteLength + 1];
        origins[0] = 1;
        var normalized = 0;
        var work = 1;
        var raw = 0;
        var nextCancellation = 0;
        while (raw < source.Length)
        {
            if (raw >= nextCancellation)
            {
                ct.ThrowIfCancellationRequested();
                nextCancellation = raw + 512;
            }
            // Keep the earliest raw boundary when the BOM or the CR in CRLF folds away.
            if (raw == 0 && source[raw] == '\uFEFF' ||
                source[raw] == '\r' && raw + 1 < source.Length && source[raw + 1] == '\n')
            {
                raw++;
                continue;
            }

            // The upstream parent pass is quadratic in emitted syntax nodes. Each line
            // can yield blocks and each inline opener can yield a child. Bound those inputs
            // before entering native code, including unmatched delimiters that cost a scan.
            if (source[raw] is '\n' or '\r' or '[' or '<' or '$' or '`' or '\\')
            {
                if (++work > MaxSyntaxWork) throw new AuthorHeadingBudgetException();
            }
            if (Rune.DecodeFromUtf16(source.AsSpan(raw), out var scalar, out var width) != OperationStatus.Done)
                throw InvalidProjection();
            raw += width;
            normalized += scalar.Utf8SequenceLength;
            origins[normalized] = raw + 1;
        }
        ct.ThrowIfCancellationRequested();
        return origins;
    }

    private static IReadOnlyList<AuthorHeadingBlock> ReadHeadings(ReadOnlySpan<byte> json, int[] origins, CancellationToken ct)
    {
        var reader = new Utf8JsonReader(json, new JsonReaderOptions { MaxDepth = 8 });
        if (!reader.Read() || reader.TokenType != JsonTokenType.StartArray) throw InvalidProjection();
        var headings = new List<AuthorHeadingBlock>();
        var previousHeadingEnd = 0;
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            ct.ThrowIfCancellationRequested();
            if (reader.TokenType != JsonTokenType.StartObject) throw InvalidProjection();
            var probe = reader;
            if (!probe.Read() || probe.TokenType != JsonTokenType.PropertyName || !probe.ValueTextEquals("kind"u8) ||
                !probe.Read() || probe.TokenType != JsonTokenType.String)
                throw InvalidProjection();
            if (!probe.ValueTextEquals("heading"u8))
            {
                reader.Skip();
                continue;
            }

            using var parsed = JsonDocument.ParseValue(ref reader);
            var node = parsed.RootElement;
            var heading = ReadRange(node, origins);
            if (heading.Start < previousHeadingEnd ||
                !node.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String ||
                !status.ValueEquals("valid"u8) || !node.TryGetProperty("contentRanges", out var ranges) ||
                ranges.ValueKind != JsonValueKind.Array || ranges.GetArrayLength() > MaxSyntaxWork)
                throw InvalidProjection();
            var content = new AuthorHeadingRange[ranges.GetArrayLength()];
            var previousRangeEnd = heading.Start;
            var index = 0;
            foreach (var value in ranges.EnumerateArray())
            {
                var range = ReadRange(value, origins);
                if (range.Start < previousRangeEnd || range.End > heading.End) throw InvalidProjection();
                content[index++] = range;
                previousRangeEnd = range.End;
            }
            headings.Add(new(content));
            previousHeadingEnd = heading.End;
        }
        if (reader.TokenType != JsonTokenType.EndArray || reader.Read()) throw InvalidProjection();
        return headings;
    }

    private static AuthorHeadingRange ReadRange(JsonElement value, int[] origins)
    {
        if (value.ValueKind != JsonValueKind.Object) throw InvalidProjection();
        var start = ReadOffset(value, "start", origins);
        var end = ReadOffset(value, "end", origins);
        if (end <= start) throw InvalidProjection();
        return new(start, end);
    }

    private static int ReadOffset(JsonElement value, string name, int[] origins)
    {
        if (!value.TryGetProperty(name, out var number) || number.ValueKind != JsonValueKind.Number ||
            !number.TryGetInt32(out var offset) || (uint)offset >= (uint)origins.Length || origins[offset] == 0)
            throw InvalidProjection();
        return origins[offset] - 1;
    }

    private static ProtocolException InvalidProjection() => new("The canonical Markdown heading projection is invalid.");

    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
    [DllImport(NativeLibraryName, EntryPoint = "markdown_syntax_collect", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern int CollectNative(byte[] input, int length);

    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
    [DllImport(NativeLibraryName, EntryPoint = "markdown_syntax_json_len", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern int JsonLength();

    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory)]
    [DllImport(NativeLibraryName, EntryPoint = "markdown_syntax_json_ptr", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
    private static extern IntPtr JsonPointer();
}
