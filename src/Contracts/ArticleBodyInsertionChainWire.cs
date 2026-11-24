namespace FsusBlog.V2.Contracts;

public sealed record BodyInsertion(int Offset, int Length);
public sealed record ArticleBodyInsertionsCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, string Title, string Body,
    IReadOnlyList<BodyInsertion> Insertions);
public sealed record DraftRevisionBodyInsertionEdge(string SourceDigest, string Digest, IReadOnlyList<BodyInsertion> Insertions);
public sealed record DraftRevisionBodyInsertionChain(int Id, long Revision, long SourceRevision, bool Available,
    string SourceBody, string Body, IReadOnlyList<DraftRevisionBodyInsertionEdge> Edges);

public static partial class Wire
{
    public static byte[] EncodeArticleBodyInsertionsCommand(ArticleBodyInsertionsCommand value)
    {
        ValidateBodyInsertionsCommand(value);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.IdempotencyKey);
        writer.Text(value.Title, WireLimits.TitleBytes);
        writer.Text(value.Body, WireLimits.BodyBytes);
        WriteBodyInsertions(writer, value.Insertions);
        return Aeds.Encode(FrameType.ArticleBodyInsertionsCommand, writer.Written);
    }

    public static ArticleBodyInsertionsCommand DecodeArticleBodyInsertionsCommand(ReadOnlySpan<byte> frame)
    {
        var reader = Reader.Open(frame, FrameType.ArticleBodyInsertionsCommand, WireLimits.MaxArticleBodyInsertionsCommandFrameBytes,
            InvalidBodyInsertionChain);
        var value = new ArticleBodyInsertionsCommand(reader.I32(), reader.I64(), reader.Uuid(), reader.Text(WireLimits.TitleBytes),
            reader.Text(WireLimits.BodyBytes), ReadBodyInsertions(ref reader));
        reader.Finish();
        ValidateBodyInsertionsCommand(value);
        return value;
    }

    public static byte[] EncodeDraftRevisionBodyInsertionChain(DraftRevisionBodyInsertionChain value)
    {
        ValidateBodyInsertionChain(value);
        var writer = WriteBodyChainHeader(value.Id, value.Revision, value.SourceRevision, value.Available,
            value.SourceBody, value.Body);
        writer.I32(value.Edges.Count);
        foreach (var edge in value.Edges)
        {
            writer.Text(edge.SourceDigest, WireLimits.ArticleBodyInsertionDigestBytes);
            writer.Text(edge.Digest, WireLimits.ArticleBodyInsertionDigestBytes);
            WriteBodyInsertions(writer, edge.Insertions);
        }
        return Aeds.Encode(FrameType.DraftRevisionBodyInsertionChain, writer.Written);
    }

    public static DraftRevisionBodyInsertionChain DecodeDraftRevisionBodyInsertionChain(ReadOnlySpan<byte> frame)
    {
        var reader = Reader.Open(frame, FrameType.DraftRevisionBodyInsertionChain, WireLimits.MaxDraftRevisionBodyInsertionChainFrameBytes,
            InvalidBodyInsertionChain);
        var (id, revision, source, available, sourceBody, body) = ReadBodyChainHeader(ref reader);
        var edges = new DraftRevisionBodyInsertionEdge[reader.Count(0, WireLimits.ArticleBodyInsertionChainEdges, InvalidBodyInsertionChain)];
        for (var index = 0; index < edges.Length; index++)
            edges[index] = new(reader.Text(WireLimits.ArticleBodyInsertionDigestBytes), reader.Text(WireLimits.ArticleBodyInsertionDigestBytes),
                ReadBodyInsertions(ref reader));
        reader.Finish();
        var value = new DraftRevisionBodyInsertionChain(id, revision, source, available, sourceBody, body, edges);
        ValidateBodyInsertionChain(value);
        return value;
    }

    private static void WriteBodyInsertions(Writer writer, IReadOnlyList<BodyInsertion> insertions)
    {
        writer.I32(insertions.Count);
        foreach (var insertion in insertions)
        {
            writer.I32(insertion.Offset);
            writer.I32(insertion.Length);
        }
    }

    private static BodyInsertion[] ReadBodyInsertions(ref Reader reader)
    {
        var insertions = new BodyInsertion[reader.Count(0, WireLimits.ArticleBodyInsertionOperations, InvalidBodyInsertionChain)];
        for (var index = 0; index < insertions.Length; index++)
            insertions[index] = new(reader.I32(), reader.I32());
        return insertions;
    }

    private static void ValidateBodyInsertionsCommand(ArticleBodyInsertionsCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Insertions.Count is < 1 or > WireLimits.ArticleBodyInsertionOperations)
            throw InvalidBodyInsertionChain();
        var sourceLength = value.Body.Length - value.Insertions.Sum(insertion => (long)insertion.Length);
        if (BodyInsertionLength(sourceLength, value.Insertions) != value.Body.Length) throw InvalidBodyInsertionChain();
    }

    private static void ValidateBodyInsertionChain(DraftRevisionBodyInsertionChain value)
    {
        if (value.Id <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision) throw InvalidBodyInsertionChain();
        if (!value.Available)
        {
            if (value.Edges.Count != 0 || value.SourceBody.Length != 0 || value.Body.Length != 0) throw InvalidBodyInsertionChain();
            return;
        }

        if (value.Edges.Count > WireLimits.ArticleBodyInsertionChainEdges || value.Edges.Count != value.Revision - value.SourceRevision)
            throw InvalidBodyInsertionChain();
        long length = value.SourceBody.Length;
        string? priorDigest = null;
        foreach (var edge in value.Edges)
        {
            if (!IsInsertionDigest(edge.SourceDigest) || !IsInsertionDigest(edge.Digest) ||
                (priorDigest is not null && edge.SourceDigest != priorDigest) ||
                (edge.Insertions.Count == 0 && edge.SourceDigest != edge.Digest))
                throw InvalidBodyInsertionChain();
            length = BodyInsertionLength(length, edge.Insertions);
            priorDigest = edge.Digest;
        }
        if (length != value.Body.Length) throw InvalidBodyInsertionChain();
    }

    private static long BodyInsertionLength(long length, IReadOnlyList<BodyInsertion> insertions)
    {
        if (length is < 0 or > WireLimits.BodyBytes || insertions.Count > WireLimits.ArticleBodyInsertionOperations)
            throw InvalidBodyInsertionChain();
        foreach (var operation in insertions)
        {
            if (operation.Offset < 0 || operation.Offset > length || operation.Length <= 0 ||
                operation.Length > WireLimits.BodyBytes - length)
                throw InvalidBodyInsertionChain();
            length += operation.Length;
        }
        return length;
    }

    private static ProtocolException InvalidBodyInsertionChain() => new("Invalid saved body insertion chain.");
}
