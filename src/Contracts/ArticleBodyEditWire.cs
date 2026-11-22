using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record BodyEdit(int Offset, int RemovedLength, string Insert);
public sealed record ArticleBodyEditsCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, string Title, string Body,
    IReadOnlyList<BodyEdit> Edits);
public sealed record DraftRevisionBodyEditEdge(string SourceDigest, string Digest, IReadOnlyList<BodyEdit> Edits);
public sealed record DraftRevisionBodyEditChain(int Id, long Revision, long SourceRevision, bool Available,
    string SourceBody, string Body, IReadOnlyList<DraftRevisionBodyEditEdge> Edges);

public static partial class Wire
{
    public static byte[] EncodeArticleBodyEditsCommand(ArticleBodyEditsCommand value)
    {
        ValidateArticleBodyEdits(value);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.IdempotencyKey);
        writer.Text(value.Title, WireLimits.TitleBytes);
        writer.Text(value.Body, WireLimits.BodyBytes);
        WriteBodyEdits(writer, value.Edits);
        return Aeds.Encode(FrameType.ArticleBodyEditsCommand, writer.Written);
    }

    public static ArticleBodyEditsCommand DecodeArticleBodyEditsCommand(ReadOnlySpan<byte> frame)
    {
        var reader = Reader.Open(frame, FrameType.ArticleBodyEditsCommand, WireLimits.MaxArticleBodyEditsCommandFrameBytes,
            InvalidBodyEdits);
        var value = new ArticleBodyEditsCommand(reader.I32(), reader.I64(), reader.Uuid(), reader.Text(WireLimits.TitleBytes),
            reader.Text(WireLimits.BodyBytes), ReadBodyEdits(ref reader));
        reader.Finish();
        ValidateArticleBodyEdits(value);
        return value;
    }

    public static byte[] EncodeDraftRevisionBodyEditChain(DraftRevisionBodyEditChain value)
    {
        ValidateBodyEditChain(value);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.Revision);
        writer.I64(value.SourceRevision);
        writer.Bool(value.Available);
        writer.Text(value.SourceBody, WireLimits.BodyBytes);
        writer.Text(value.Body, WireLimits.BodyBytes);
        writer.I32(value.Edges.Count);
        foreach (var edge in value.Edges)
        {
            writer.Text(edge.SourceDigest, WireLimits.ArticleBodyInsertionDigestBytes);
            writer.Text(edge.Digest, WireLimits.ArticleBodyInsertionDigestBytes);
            WriteBodyEdits(writer, edge.Edits);
        }
        return Aeds.Encode(FrameType.DraftRevisionBodyEditChain, writer.Written);
    }

    public static DraftRevisionBodyEditChain DecodeDraftRevisionBodyEditChain(ReadOnlySpan<byte> frame)
    {
        var reader = Reader.Open(frame, FrameType.DraftRevisionBodyEditChain, WireLimits.MaxDraftRevisionBodyEditChainFrameBytes,
            InvalidBodyEdits);
        var id = reader.I32();
        var revision = reader.I64();
        var sourceRevision = reader.I64();
        var available = reader.Bool();
        var source = reader.Text(WireLimits.BodyBytes);
        var body = reader.Text(WireLimits.BodyBytes);
        var edges = new DraftRevisionBodyEditEdge[reader.Count(0, WireLimits.ArticleBodyInsertionChainEdges, InvalidBodyEdits)];
        for (var index = 0; index < edges.Length; index++)
            edges[index] = new(reader.Text(WireLimits.ArticleBodyInsertionDigestBytes), reader.Text(WireLimits.ArticleBodyInsertionDigestBytes),
                ReadBodyEdits(ref reader));
        reader.Finish();
        var result = new DraftRevisionBodyEditChain(id, revision, sourceRevision, available, source, body, edges);
        ValidateBodyEditChain(result);
        return result;
    }

    private static void WriteBodyEdits(Writer writer, IReadOnlyList<BodyEdit> edits)
    {
        writer.I32(edits.Count);
        foreach (var edit in edits)
        {
            writer.I32(edit.Offset);
            writer.I32(edit.RemovedLength);
            writer.Text(edit.Insert, WireLimits.BodyBytes);
        }
    }

    private static BodyEdit[] ReadBodyEdits(ref Reader reader)
    {
        var edits = new BodyEdit[reader.Count(0, WireLimits.ArticleBodyInsertionOperations, InvalidBodyEdits)];
        for (var index = 0; index < edits.Length; index++) edits[index] = new(reader.I32(), reader.I32(), reader.Text(WireLimits.BodyBytes));
        return edits;
    }

    private static void ValidateArticleBodyEdits(ArticleBodyEditsCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Edits.Count is < 1 or > WireLimits.ArticleBodyInsertionOperations) throw InvalidBodyEdits();
        var sourceLength = value.Body.Length + value.Edits.Sum(edit => (long)edit.RemovedLength - edit.Insert.Length);
        var remaining = WireLimits.BodyBytes;
        if (BodyLengthAfterEdits(sourceLength, value.Edits, ref remaining) != value.Body.Length) throw InvalidBodyEdits();
    }

    private static void ValidateBodyEditChain(DraftRevisionBodyEditChain value)
    {
        if (value.Id <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision) throw InvalidBodyEdits();
        if (!value.Available)
        {
            if (value.Edges.Count != 0 || value.SourceBody.Length != 0 || value.Body.Length != 0) throw InvalidBodyEdits();
            return;
        }
        if (value.Edges.Count > WireLimits.ArticleBodyInsertionChainEdges || value.Edges.Count != value.Revision - value.SourceRevision)
            throw InvalidBodyEdits();
        var remaining = WireLimits.BodyBytes;
        long length = value.SourceBody.Length;
        string? previousDigest = null;
        foreach (var edge in value.Edges)
        {
            if (!IsInsertionDigest(edge.SourceDigest) || !IsInsertionDigest(edge.Digest) ||
                (previousDigest is not null && edge.SourceDigest != previousDigest) ||
                (edge.Edits.Count == 0 && edge.SourceDigest != edge.Digest)) throw InvalidBodyEdits();
            length = BodyLengthAfterEdits(length, edge.Edits, ref remaining);
            previousDigest = edge.Digest;
        }
        if (length != value.Body.Length) throw InvalidBodyEdits();
    }

    private static long BodyLengthAfterEdits(long length, IReadOnlyList<BodyEdit> edits, ref int bytesRemaining)
    {
        if (length is < 0 or > WireLimits.BodyBytes || edits.Count > WireLimits.ArticleBodyInsertionOperations) throw InvalidBodyEdits();
        foreach (var edit in edits)
        {
            if (edit.Offset < 0 || edit.Offset > length || edit.RemovedLength < 0 || edit.RemovedLength > length - edit.Offset ||
                (edit.RemovedLength == 0 && edit.Insert.Length == 0) || edit.Insert.Contains('\0')) throw InvalidBodyEdits();
            try { bytesRemaining -= Utf8.GetByteCount(edit.Insert); }
            catch (EncoderFallbackException) { throw InvalidBodyEdits(); }
            length += (long)edit.Insert.Length - edit.RemovedLength;
            if (length > WireLimits.BodyBytes || bytesRemaining < 0) throw InvalidBodyEdits();
        }
        return length;
    }

    private static ProtocolException InvalidBodyEdits() => new("Invalid saved body edit chain.");
}
