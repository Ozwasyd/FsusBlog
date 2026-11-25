using System.Buffers;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace FsusBlog.V2.Core.Authoring;

public sealed partial class CanvasPortableBundle
{
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>
    /// The SHA-256 is over the exact UTF-8 prefix ending after the edges array, before the
    /// checksum field. The version, text encoding and newline policy are in that prefix.
    /// </summary>
    public byte[] Encode()
    {
        var (bytes, hash) = WriteBody();
        AppendChecksum(bytes, hash);
        return bytes.WrittenSpan.ToArray();
    }

    public static CanvasPortableBundle Decode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is < 1 or > MaxBytes)
            throw Invalid("Canvas package exceeds its size limit.");

        try
        {
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 4 });
            Read(ref reader, JsonTokenType.StartObject);
            ExpectString(ref reader, "kind"u8, Kind);
            Name(ref reader, "version"u8);
            if (Int(ref reader) != Version) throw Invalid("Unsupported Canvas package version.");
            ExpectString(ref reader, "encoding"u8, "utf-8");
            ExpectString(ref reader, "newlines"u8, "preserve");
            Name(ref reader, "sourceRevision"u8);
            Read(ref reader, JsonTokenType.Number);
            long sourceRevision = reader.GetInt64();
            Name(ref reader, "title"u8);
            string title = Text(ref reader, MaxTitleCharacters) ?? throw Invalid("Canvas package title is missing.");
            Name(ref reader, "viewport"u8);
            Read(ref reader, JsonTokenType.StartArray);
            var viewport = new CanvasPortableViewport(Int(ref reader), Int(ref reader), Int(ref reader));
            Read(ref reader, JsonTokenType.EndArray);
            Name(ref reader, "nodes"u8);
            var nodes = ReadNodes(ref reader);
            Name(ref reader, "edges"u8);
            var edges = ReadEdges(ref reader);
            Name(ref reader, "sha256"u8);
            var declared = Text(ref reader, 64);
            Read(ref reader, JsonTokenType.EndObject);
            if (reader.Read()) throw Invalid("Unexpected data after the Canvas package.");

            var bundle = new CanvasPortableBundle(title, viewport, sourceRevision, nodes, edges);
            var (canonical, hash) = bundle.WriteBody();
            string checksum = Convert.ToHexStringLower(hash);
            if (!StringComparer.Ordinal.Equals(declared, checksum)) throw Invalid("Canvas package checksum does not match.");
            AppendChecksum(canonical, hash);
            if (!bytes.SequenceEqual(canonical.WrittenSpan)) throw Invalid("Canvas package bytes are not canonical.");
            bundle.ValidateGraph();
            bundle.Checksum = checksum;
            return bundle;
        }
        catch (Exception error) when (error is JsonException or FormatException or InvalidOperationException or ArgumentException)
        { throw Invalid("Invalid Canvas package JSON."); }
    }

    private (ArrayBufferWriter<byte> Bytes, byte[] Hash) WriteBody()
    {
        var bytes = new ArrayBufferWriter<byte>();
        using var w = new Utf8JsonWriter(bytes, WriterOptions);
        w.WriteStartObject();
        w.WriteString("kind", Kind);
        w.WriteNumber("version", Version);
        w.WriteString("encoding", "utf-8");
        w.WriteString("newlines", "preserve");
        w.WriteNumber("sourceRevision", SourceRevision);
        w.WriteString("title", Title);
        w.WriteStartArray("viewport");
        WriteInts(w, Viewport.X, Viewport.Y, Viewport.Zoom);
        w.WriteEndArray();
        w.WriteStartArray("nodes");
        foreach (var node in _nodes)
        {
            w.WriteStartArray();
            WriteInts(w, (int)node.Kind, node.Geometry.X, node.Geometry.Y, node.Geometry.Width, node.Geometry.Height, node.Reference);
            w.WriteStringValue(node.Anchor);
            w.WriteBooleanValue(node.Pinned);
            w.WriteStringValue(node.Text);
            w.WriteStartArray();
            foreach (int slot in node.Members) w.WriteNumberValue(slot);
            w.WriteEndArray();
            w.WriteEndArray();
            CheckLimit(w.BytesPending + w.BytesCommitted);
        }
        w.WriteEndArray();
        w.WriteStartArray("edges");
        foreach (var edge in _edges)
        {
            w.WriteStartArray();
            WriteInts(w, (int)edge.Kind, edge.From, edge.To, edge.Order);
            w.WriteStringValue(edge.Label);
            w.WriteEndArray();
            CheckLimit(w.BytesPending + w.BytesCommitted);
        }
        w.WriteEndArray();
        w.Flush();
        CheckLimit(bytes.WrittenCount + ChecksumSuffixLength);
        return (bytes, SHA256.HashData(bytes.WrittenSpan));

        static void WriteInts(Utf8JsonWriter writer, params ReadOnlySpan<int> values) { foreach (int v in values) writer.WriteNumberValue(v); }
        static void CheckLimit(long total) { if (total > MaxBytes) throw Invalid("Canvas package exceeds its size limit."); }
    }

    private static ReadOnlySpan<byte> ChecksumPrefix => ",\"sha256\":\""u8;
    private static int ChecksumSuffixLength => ChecksumPrefix.Length + 64 + 2;

    private static void AppendChecksum(ArrayBufferWriter<byte> bytes, byte[] hash)
    {
        Span<byte> target = bytes.GetSpan(ChecksumSuffixLength);
        ChecksumPrefix.CopyTo(target);
        int written = ChecksumPrefix.Length;
        foreach (char character in Convert.ToHexStringLower(hash)) target[written++] = (byte)character;
        target[written++] = (byte)'"';
        target[written++] = (byte)'}';
        bytes.Advance(written);
    }

    private static ImmutableArray<PortableNode> ReadNodes(ref Utf8JsonReader reader)
    {
        Read(ref reader, JsonTokenType.StartArray);
        var nodes = ImmutableArray.CreateBuilder<PortableNode>();
        int membershipCount = 0;
        while (reader.Read() && reader.TokenType == JsonTokenType.StartArray)
        {
            if (nodes.Count == CanvasGraph.MaxNodes) throw Invalid("Canvas package has too many nodes.");
            var kind = (CanvasNodeKind)Int(ref reader);
            if (!Enum.IsDefined(kind)) throw Invalid("Unknown Canvas package node kind.");
            var geometry = new CanvasGeometry(Int(ref reader), Int(ref reader), Int(ref reader), Int(ref reader));
            int reference = Int(ref reader);
            var anchor = Text(ref reader, 64);
            if (!reader.Read() || reader.TokenType is not (JsonTokenType.True or JsonTokenType.False))
                throw Invalid("Invalid Canvas package pin flag.");
            bool pinned = reader.GetBoolean();
            var text = Text(ref reader, CanvasGraph.MaxNoteLength);
            Read(ref reader, JsonTokenType.StartArray);
            var members = ImmutableArray.CreateBuilder<int>();
            while (reader.Read() && reader.TokenType == JsonTokenType.Number)
            {
                if (++membershipCount > CanvasGraph.MaxMemberships || members.Count == CanvasGraph.MaxNodes)
                    throw Invalid("Canvas package membership exceeds its size limit.");
                members.Add(reader.GetInt32());
            }
            Require(ref reader, JsonTokenType.EndArray);
            Read(ref reader, JsonTokenType.EndArray);
            nodes.Add(new(kind, geometry, reference, anchor, pinned, text, members.ToImmutable()));
        }
        Require(ref reader, JsonTokenType.EndArray);
        return nodes.ToImmutable();
    }

    private static ImmutableArray<PortableEdge> ReadEdges(ref Utf8JsonReader reader)
    {
        Read(ref reader, JsonTokenType.StartArray);
        var edges = ImmutableArray.CreateBuilder<PortableEdge>();
        while (reader.Read() && reader.TokenType == JsonTokenType.StartArray)
        {
            if (edges.Count == CanvasGraph.MaxEdges) throw Invalid("Canvas package has too many edges.");
            var kind = (CanvasGraphEdgeKind)Int(ref reader);
            if (!Enum.IsDefined(kind)) throw Invalid("Unknown Canvas package edge kind.");
            edges.Add(new(kind, Int(ref reader), Int(ref reader), Int(ref reader), Text(ref reader, CanvasGraph.MaxLabelLength)));
            Read(ref reader, JsonTokenType.EndArray);
        }
        Require(ref reader, JsonTokenType.EndArray);
        return edges.ToImmutable();
    }

    private static void Read(ref Utf8JsonReader reader, JsonTokenType expected)
    {
        if (!reader.Read()) throw Invalid("Canvas package ends unexpectedly.");
        Require(ref reader, expected);
    }

    private static void Require(ref Utf8JsonReader reader, JsonTokenType expected)
    {
        if (reader.TokenType != expected) throw Invalid("Unexpected Canvas package field.");
    }

    private static void Name(ref Utf8JsonReader reader, ReadOnlySpan<byte> name)
    {
        Read(ref reader, JsonTokenType.PropertyName);
        if (!reader.ValueTextEquals(name)) throw Invalid("Unknown Canvas package field.");
    }

    private static void ExpectString(ref Utf8JsonReader reader, ReadOnlySpan<byte> name, string value)
    {
        Name(ref reader, name);
        Read(ref reader, JsonTokenType.String);
        if (!reader.ValueTextEquals(value)) throw Invalid("Invalid Canvas package format.");
    }

    private static int Int(ref Utf8JsonReader reader) { Read(ref reader, JsonTokenType.Number); return reader.GetInt32(); }

    private static string? Text(ref Utf8JsonReader reader, int maxCharacters)
    {
        if (!reader.Read()) throw Invalid("Canvas package ends unexpectedly.");
        if (reader.TokenType == JsonTokenType.Null) return null;
        Require(ref reader, JsonTokenType.String);
        // An escaped UTF-16 code unit consumes at most six input bytes.
        if (reader.ValueSpan.Length > maxCharacters * 6) throw Invalid("Canvas package text exceeds its size limit.");
        string text = reader.GetString()!;
        return text.Length > maxCharacters ? throw Invalid("Canvas package text exceeds its size limit.") : text;
    }
}
