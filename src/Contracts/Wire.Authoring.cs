namespace FsusBlog.V2.Contracts;

public sealed record BodyEdit(int Offset, int RemovedLength, string Insert);
public sealed record ArticleBodyEditsCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, string Title, string Body,
    IReadOnlyList<BodyEdit> Edits);
public sealed record DraftRevisionBodyEditEdge(string SourceDigest, string Digest, IReadOnlyList<BodyEdit> Edits);
public sealed record DraftRevisionBodyEditChain(int Id, long Revision, long SourceRevision, bool Available,
    string SourceBody, string Body, IReadOnlyList<DraftRevisionBodyEditEdge> Edges);

public sealed record BodyInsertion(int Offset, int Length);
public sealed record ArticleBodyInsertionsCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, string Title, string Body,
    IReadOnlyList<BodyInsertion> Insertions);
public sealed record DraftRevisionBodyInsertionEdge(string SourceDigest, string Digest, IReadOnlyList<BodyInsertion> Insertions);
public sealed record DraftRevisionBodyInsertionChain(int Id, long Revision, long SourceRevision, bool Available,
    string SourceBody, string Body, IReadOnlyList<DraftRevisionBodyInsertionEdge> Edges);

public sealed record ArticleCoverCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, Guid AssetId)
{
    public const int FrameBytes = Aeds.HeaderSize + 44;
}

public sealed record ArticleMediaCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, Guid AssetId, bool Attach)
{
    public const int FrameBytes = Aeds.HeaderSize + 45;
}

public sealed record ArticleMediaEntry(Guid Id, string Ticket);
public sealed record PublishedArticleRights(long SnapshotId, ArticleRightsPolicy Policy);
public sealed record ArticleSummaryCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, string Text);
public sealed record ArticleSummary(int Id, long Revision, string Text);

public enum AuthorArticleState { Draft = 1, Scheduled, Published, Retracted, Deleted }
public sealed record AuthorArticleRow(int Id, long Revision, string Title, AuthorArticleState State, long ModifiedUnixMs,
    long ScheduledUnixMs, TaxonomyName? Category, IReadOnlyList<TaxonomyName> Tags);
public sealed record AuthorArticlePage(int Total, int NextId, IReadOnlyList<AuthorArticleRow> Items);

public sealed record AuthorRecentOpenRow(int ArticleId, long ArticleRevision, long Sequence, long OpenedAtUnixMs, string Title);
public sealed record AuthorRecentOpenPage(long Revision, string NextCursor, IReadOnlyList<AuthorRecentOpenRow> Items);

public enum DocumentExportFormat : byte { Html = 1, Pdf, Docx, Epub }
public enum DocumentExportState : byte { Queued = 1, Running, Succeeded, Failed, Cancelled, Blocked, Cancelling }
public enum DocumentExportFailure : byte { None, Unsupported, Unavailable, Permission, Interrupted }
public sealed record DocumentExportCreate(Guid Id, int Article, long Revision, long SourceRevision, DocumentExportFormat Format);
public sealed record DocumentExportTask(DocumentExportCreate Request, DocumentExportState State, DocumentExportFailure Failure,
    byte Provider, long Created, long Started, long Finished, long Expires, byte[] SourceDigest, byte[]? OutputDigest, int OutputBytes);

public sealed record PrivateMediaItem(Guid Id, string Name, int Format, int Length, int Width, int Height, DateTimeOffset CreatedAt);

public sealed record ArticlePublishImages(int ArticleId, long ExpectedRevision, Guid IdempotencyKey, IReadOnlyList<Guid> AssetIds)
{
    public const int Maximum = 32;
    public const int MaxFrameBytes = Aeds.HeaderSize + 32 + Maximum * 16;
}

public sealed record PublishedArticleImage(string Digest, int Format, int Length, int Width, int Height)
{
    private const int MaximumWebpChunks = 128;

    public static bool ValidDigest(string value) => value.Length == 64 && value.All(char.IsAsciiHexDigitLower);

    public static bool MatchesFormat(ReadOnlySpan<byte> bytes, int format) => format switch
    {
        1 => bytes.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        2 => bytes.StartsWith((ReadOnlySpan<byte>)[0xff, 0xd8, 0xff]),
        3 => IsStaticWebp(bytes),
        _ => false
    };

    public static string FilePath(int article, long publication, string digest)
    {
        if (article <= 0 || publication <= 0 || !ValidDigest(digest))
            throw new ProtocolException("Invalid public image coordinates.");
        return string.Create(CultureInfo.InvariantCulture, $"/public-media/{article}/{publication}/{digest}");
    }

    public bool Valid() => ValidDigest(Digest) && Format is 1 or 2 or 3 &&
        Length is >= 1 and <= 20 * 1024 * 1024 && Width is >= 1 and <= 8192 && Height is >= 1 and <= 8192 &&
        (long)Width * Height <= 16 * 1024 * 1024;

    private static bool IsStaticWebp(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 20 || !bytes.StartsWith("RIFF"u8) || !bytes[8..12].SequenceEqual("WEBP"u8) ||
            BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..8]) != bytes.Length - 8) return false;
        var chunks = bytes[12..];
        var hasImage = false;
        for (var chunk = 0; chunks.Length >= 8; chunk++)
        {
            if (chunk == MaximumWebpChunks) return false;
            var tag = chunks[..4];
            var size = BinaryPrimitives.ReadUInt32LittleEndian(chunks[4..8]);
            var padded = (long)size + (size & 1);
            if (padded > chunks.Length - 8 || tag.SequenceEqual("ANIM"u8) || tag.SequenceEqual("ANMF"u8)) return false;
            if (tag.SequenceEqual("VP8X"u8) && (chunk != 0 || size != 10 || (chunks[8] & 0x02) != 0)) return false;
            if (tag.SequenceEqual("VP8 "u8) || tag.SequenceEqual("VP8L"u8))
            {
                if (hasImage || size == 0) return false;
                hasImage = true;
            }
            chunks = chunks[(8 + (int)padded)..];
        }
        return hasImage && chunks.IsEmpty;
    }
}

public sealed record PublicArticleMedia(int ArticleId, long Publication, IReadOnlyList<PublishedArticleImage> Images);
public sealed record RevisionHistoryItem(long Revision, string Title, long SavedAtUnixMs, long SourceRevision, string Reason);
public sealed record RevisionHistoryPage(int Id, long Revision, long PublishedRevision, string NextCursor,
    IReadOnlyList<RevisionHistoryItem> Items);
public sealed record SavedRevisionMetadata(string Summary, TaxonomyName? Category, IReadOnlyList<TaxonomyName> Tags);

public static partial class Wire
{
    public const int ArticleReadSubmitFrameSize = Aeds.HeaderSize + sizeof(int) + WireLayouts.ArticleReadTicketSize;
    public const int DocumentExportTasksPerOwner = 4;
    private const int DocumentExportTaskSize = 140;
    private static readonly byte[] AbsentDocumentExportDigest = new byte[32];

    public static byte[] EncodeArticleBodyEditsCommand(ArticleBodyEditsCommand value)
    {
        ValidateArticleBodyEdits(value);
        return EncodeBodyOpsCommand(FrameType.ArticleBodyEditsCommand, value.Id, value.ExpectedRevision, value.IdempotencyKey,
            value.Title, value.Body, value.Edits, WriteBodyEdit);
    }

    public static ArticleBodyEditsCommand DecodeArticleBodyEditsCommand(ReadOnlySpan<byte> frame) =>
        DecodeBodyOpsCommand(FrameType.ArticleBodyEditsCommand, frame, MaxArticleBodyEditsCommandFrameBytes, InvalidBodyEdits,
            ReadBodyEdit, static (id, rev, key, title, body, ops) => new ArticleBodyEditsCommand(id, rev, key, title, body, ops),
            ValidateArticleBodyEdits);

    public static byte[] EncodeDraftRevisionBodyEditChain(DraftRevisionBodyEditChain value)
    {
        ValidateBodyEditChain(value);
        return EncodeBodyOpsChain(FrameType.DraftRevisionBodyEditChain, value.Id, value.Revision, value.SourceRevision,
            value.Available, value.SourceBody, value.Body, value.Edges,
            static (w, edge) => w.Text(edge.SourceDigest, ArticleBodyInsertionDigestBytes)
                .Text(edge.Digest, ArticleBodyInsertionDigestBytes).Items(edge.Edits, WriteBodyEdit));
    }

    public static DraftRevisionBodyEditChain DecodeDraftRevisionBodyEditChain(ReadOnlySpan<byte> frame) =>
        DecodeBodyOpsChain(FrameType.DraftRevisionBodyEditChain, frame, MaxDraftRevisionBodyEditChainFrameBytes, InvalidBodyEdits,
            static (ref Reader r) => new DraftRevisionBodyEditEdge(r.Text(ArticleBodyInsertionDigestBytes),
                r.Text(ArticleBodyInsertionDigestBytes), r.Items(0, ArticleBodyInsertionOperations, InvalidBodyEdits, ReadBodyEdit)),
            static (id, rev, src, avail, srcBody, body, edges) => new DraftRevisionBodyEditChain(id, rev, src, avail, srcBody, body, edges),
            ValidateBodyEditChain);

    public static byte[] EncodeArticleBodyInsertionsCommand(ArticleBodyInsertionsCommand value)
    {
        ValidateBodyInsertionsCommand(value);
        return EncodeBodyOpsCommand(FrameType.ArticleBodyInsertionsCommand, value.Id, value.ExpectedRevision, value.IdempotencyKey,
            value.Title, value.Body, value.Insertions, WriteBodyInsertion);
    }

    public static ArticleBodyInsertionsCommand DecodeArticleBodyInsertionsCommand(ReadOnlySpan<byte> frame) =>
        DecodeBodyOpsCommand(FrameType.ArticleBodyInsertionsCommand, frame, MaxArticleBodyInsertionsCommandFrameBytes,
            InvalidBodyInsertionChain, ReadBodyInsertion,
            static (id, rev, key, title, body, ops) => new ArticleBodyInsertionsCommand(id, rev, key, title, body, ops),
            ValidateBodyInsertionsCommand);

    public static byte[] EncodeDraftRevisionBodyInsertionChain(DraftRevisionBodyInsertionChain value)
    {
        ValidateBodyInsertionChain(value);
        return EncodeBodyOpsChain(FrameType.DraftRevisionBodyInsertionChain, value.Id, value.Revision, value.SourceRevision,
            value.Available, value.SourceBody, value.Body, value.Edges,
            static (w, edge) => w.Text(edge.SourceDigest, ArticleBodyInsertionDigestBytes)
                .Text(edge.Digest, ArticleBodyInsertionDigestBytes).Items(edge.Insertions, WriteBodyInsertion));
    }

    public static DraftRevisionBodyInsertionChain DecodeDraftRevisionBodyInsertionChain(ReadOnlySpan<byte> frame) =>
        DecodeBodyOpsChain(FrameType.DraftRevisionBodyInsertionChain, frame, MaxDraftRevisionBodyInsertionChainFrameBytes,
            InvalidBodyInsertionChain,
            static (ref Reader r) => new DraftRevisionBodyInsertionEdge(r.Text(ArticleBodyInsertionDigestBytes),
                r.Text(ArticleBodyInsertionDigestBytes), r.Items(0, ArticleBodyInsertionOperations, InvalidBodyInsertionChain, ReadBodyInsertion)),
            static (id, rev, src, avail, srcBody, body, edges) => new DraftRevisionBodyInsertionChain(id, rev, src, avail, srcBody, body, edges),
            ValidateBodyInsertionChain);

    private static byte[] EncodeBodyOpsCommand<TOp>(FrameType type, int id, long expectedRevision, Guid key,
        string title, string body, IReadOnlyList<TOp> ops, Action<Writer, TOp> writeOp) =>
        EncodeFrame(type, writer => writer.I32(id).I64(expectedRevision).Uuid(key)
            .Text(title, TitleBytes).Text(body, BodyBytes).Items(ops, writeOp));

    private static TCmd DecodeBodyOpsCommand<TOp, TCmd>(FrameType type, ReadOnlySpan<byte> frame, int maxBytes,
        Func<ProtocolException> invalid, ReadRecord<TOp> readOp,
        Func<int, long, Guid, string, string, TOp[], TCmd> build, Action<TCmd> validate)
    {
        var value = DecodeFrame(type, frame, maxBytes, invalid, (ref Reader reader) => build(reader.I32(), reader.I64(),
            reader.Uuid(), reader.Text(TitleBytes), reader.Text(BodyBytes),
            reader.Items(0, ArticleBodyInsertionOperations, invalid, readOp)));
        validate(value);
        return value;
    }

    private static byte[] EncodeBodyOpsChain<TEdge>(FrameType type, int id, long revision, long sourceRevision,
        bool available, string sourceBody, string body, IReadOnlyList<TEdge> edges, Action<Writer, TEdge> writeEdge) =>
        EncodeFrame(type, writer => writer.I32(id).I64(revision).I64(sourceRevision).Bool(available)
            .Text(sourceBody, BodyBytes).Text(body, BodyBytes).Items(edges, writeEdge));

    private static TChain DecodeBodyOpsChain<TEdge, TChain>(FrameType type, ReadOnlySpan<byte> frame, int maxBytes,
        Func<ProtocolException> invalid, ReadRecord<TEdge> readEdge,
        Func<int, long, long, bool, string, string, TEdge[], TChain> build, Action<TChain> validate)
    {
        var value = DecodeFrame(type, frame, maxBytes, invalid, (ref Reader reader) => build(reader.I32(), reader.I64(),
            reader.I64(), reader.Bool(), reader.Text(BodyBytes), reader.Text(BodyBytes),
            reader.Items(0, ArticleBodyInsertionChainEdges, invalid, readEdge)));
        validate(value);
        return value;
    }

    private static void WriteBodyEdit(Writer writer, BodyEdit edit) =>
        writer.I32(edit.Offset).I32(edit.RemovedLength).Text(edit.Insert, BodyBytes);

    private static BodyEdit ReadBodyEdit(ref Reader reader) => new(reader.I32(), reader.I32(), reader.Text(BodyBytes));

    private static void WriteBodyInsertion(Writer writer, BodyInsertion insertion) =>
        writer.I32(insertion.Offset).I32(insertion.Length);

    private static BodyInsertion ReadBodyInsertion(ref Reader reader) => new(reader.I32(), reader.I32());

    private static void ValidateArticleBodyEdits(ArticleBodyEditsCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Edits.Count is < 1 or > ArticleBodyInsertionOperations) throw InvalidBodyEdits();
        var sourceLength = value.Body.Length + value.Edits.Sum(edit => (long)edit.RemovedLength - edit.Insert.Length);
        var remaining = BodyBytes;
        if (BodyLengthAfterEdits(sourceLength, value.Edits, ref remaining) != value.Body.Length) throw InvalidBodyEdits();
    }

    private static void ValidateBodyEditChain(DraftRevisionBodyEditChain value)
    {
        var remaining = BodyBytes;
        ValidateBodyChainCore(value.Id, value.Revision, value.SourceRevision, value.Available, value.SourceBody, value.Body,
            value.Edges, InvalidBodyEdits, static e => (e.SourceDigest, e.Digest, e.Edits.Count == 0),
            (length, edge) => BodyLengthAfterEdits(length, edge.Edits, ref remaining));
    }

    private static void ValidateBodyInsertionsCommand(ArticleBodyInsertionsCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Insertions.Count is < 1 or > ArticleBodyInsertionOperations) throw InvalidBodyInsertionChain();
        var sourceLength = value.Body.Length - value.Insertions.Sum(insertion => (long)insertion.Length);
        if (BodyInsertionLength(sourceLength, value.Insertions) != value.Body.Length) throw InvalidBodyInsertionChain();
    }

    private static void ValidateBodyInsertionChain(DraftRevisionBodyInsertionChain value) =>
        ValidateBodyChainCore(value.Id, value.Revision, value.SourceRevision, value.Available, value.SourceBody, value.Body,
            value.Edges, InvalidBodyInsertionChain, static e => (e.SourceDigest, e.Digest, e.Insertions.Count == 0),
            static (length, edge) => BodyInsertionLength(length, edge.Insertions));

    private static void ValidateBodyChainCore<TEdge>(int id, long revision, long sourceRevision, bool available,
        string sourceBody, string body, IReadOnlyList<TEdge> edges, Func<ProtocolException> invalid,
        Func<TEdge, (string SourceDigest, string Digest, bool Empty)> edgeInfo, Func<long, TEdge, long> applyEdge)
    {
        if (id <= 0 || sourceRevision <= 0 || sourceRevision >= revision) throw invalid();
        if (!available)
        {
            if (edges.Count != 0 || sourceBody.Length != 0 || body.Length != 0) throw invalid();
            return;
        }
        if (edges.Count > ArticleBodyInsertionChainEdges || edges.Count != revision - sourceRevision) throw invalid();
        long length = sourceBody.Length;
        string? previousDigest = null;
        foreach (var edge in edges)
        {
            var (sourceDigest, digest, empty) = edgeInfo(edge);
            if (!IsLowerHex(sourceDigest, ArticleBodyInsertionDigestBytes) || !IsLowerHex(digest, ArticleBodyInsertionDigestBytes) ||
                (previousDigest is not null && sourceDigest != previousDigest) || (empty && sourceDigest != digest))
                throw invalid();
            length = applyEdge(length, edge);
            previousDigest = digest;
        }
        if (length != body.Length) throw invalid();
    }

    private static long BodyLengthAfterEdits(long length, IReadOnlyList<BodyEdit> edits, ref int bytesRemaining)
    {
        if (length is < 0 or > BodyBytes || edits.Count > ArticleBodyInsertionOperations) throw InvalidBodyEdits();
        foreach (var edit in edits)
        {
            if (edit.Offset < 0 || edit.Offset > length || edit.RemovedLength < 0 || edit.RemovedLength > length - edit.Offset ||
                (edit.RemovedLength == 0 && edit.Insert.Length == 0) || edit.Insert.Contains('\0')) throw InvalidBodyEdits();
            try { bytesRemaining -= Utf8.GetByteCount(edit.Insert); }
            catch (EncoderFallbackException) { throw InvalidBodyEdits(); }
            length += (long)edit.Insert.Length - edit.RemovedLength;
            if (length > BodyBytes || bytesRemaining < 0) throw InvalidBodyEdits();
        }
        return length;
    }

    private static long BodyInsertionLength(long length, IReadOnlyList<BodyInsertion> insertions)
    {
        if (length is < 0 or > BodyBytes || insertions.Count > ArticleBodyInsertionOperations) throw InvalidBodyInsertionChain();
        foreach (var operation in insertions)
        {
            if (operation.Offset < 0 || operation.Offset > length || operation.Length <= 0 ||
                operation.Length > BodyBytes - length) throw InvalidBodyInsertionChain();
            length += operation.Length;
        }
        return length;
    }

    internal static void Validate(ArticleBodyInsertionCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Offset < 0 || value.Length <= 0 || value.Length > value.Body.Length || value.Offset > value.Body.Length - value.Length)
            throw new ProtocolException("Invalid article insertion command coordinates.");
    }

    internal static void Validate(DraftRevisionBodyInsertion value)
    {
        if (value.Id <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision)
            throw new ProtocolException("Invalid saved body insertion coordinates.");
        if (value.Available)
        {
            if (value.SourceRevision == value.Revision - 1 && value.Offset >= 0 && value.Offset <= value.SourceBody.Length &&
                value.Length > 0 && value.Length == value.Body.Length - value.SourceBody.Length &&
                IsLowerHex(value.SourceDigest, ArticleBodyInsertionDigestBytes) &&
                IsLowerHex(value.Digest, ArticleBodyInsertionDigestBytes)) return;
        }
        else if (value.Offset == 0 && value.Length == 0 && value.SourceDigest.Length == 0 && value.Digest.Length == 0 &&
            value.SourceBody.Length == 0 && value.Body.Length == 0) return;
        throw new ProtocolException("Invalid saved body insertion payload.");
    }

    private static ProtocolException InvalidBodyEdits() => new("Invalid saved body edit chain.");
    private static ProtocolException InvalidBodyInsertionChain() => new("Invalid saved body insertion chain.");

    public static byte[] EncodeArticleCoverCommand(ArticleCoverCommand value) =>
        EncodeRecord(FrameType.ArticleCoverCommand, value, ValidateCover, static (writer, record) =>
            writer.I32(record.Id).I64(record.ExpectedRevision).Uuid(record.IdempotencyKey).Uuid(record.AssetId));

    public static ArticleCoverCommand DecodeArticleCoverCommand(ReadOnlySpan<byte> frame) =>
        DecodeRecord<ArticleCoverCommand>(FrameType.ArticleCoverCommand, frame,
            static (ref Reader reader) => new(reader.I32(), reader.I64(), reader.Uuid(), reader.Uuid()), ValidateCover);

    private static void ValidateCover(ArticleCoverCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid saved article cover command.");
    }

    public static byte[] EncodeArticleMediaCommand(ArticleMediaCommand value) =>
        EncodeRecord(FrameType.ArticleMediaCommand, value, ValidateMedia, static (writer, record) =>
            writer.I32(record.Id).I64(record.ExpectedRevision).Uuid(record.IdempotencyKey).Uuid(record.AssetId).Bool(record.Attach));

    public static ArticleMediaCommand DecodeArticleMediaCommand(ReadOnlySpan<byte> frame) =>
        DecodeRecord<ArticleMediaCommand>(FrameType.ArticleMediaCommand, frame,
            static (ref Reader reader) => new(reader.I32(), reader.I64(), reader.Uuid(), reader.Uuid(), reader.Bool()), ValidateMedia);

    public static byte[] EncodeArticleMedia(int article, long revision, IReadOnlyList<ArticleMediaEntry> entries)
    {
        if (article <= 0 || revision <= 0 || entries.Count > 32) throw new ProtocolException("Invalid private article attachments.");
        return EncodeFrame(FrameType.ArticleMedia, writer => writer.I32(article).I64(revision).Items(entries, static (w, entry) =>
        {
            if (entry.Id == Guid.Empty || entry.Ticket.Length != 91 || !IsBase64Url(entry.Ticket))
                throw new ProtocolException("Invalid private article attachment coordinate.");
            w.Uuid(entry.Id).Text(entry.Ticket, 91);
        }));
    }

    private static void ValidateMedia(ArticleMediaCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty || value.AssetId == Guid.Empty)
            throw new ProtocolException("Invalid private article attachment command.");
    }

    public static void DecodeArticleReadChallengeRequest(ReadOnlySpan<byte> frame)
    {
        if (!Aeds.Decode(frame, FrameType.ArticleReadChallengeRequest).IsEmpty)
            throw new ProtocolException("Unexpected article read challenge payload.");
    }

    public static byte[] EncodeArticleReadChallenge(ReadOnlySpan<byte> ticket)
    {
        if (ticket.Length != WireLayouts.ArticleReadTicketSize)
            throw new ProtocolException("Invalid article read challenge ticket length.");
        Span<byte> payload = stackalloc byte[sizeof(int) + WireLayouts.ArticleReadTicketSize];
        BinaryPrimitives.WriteInt32LittleEndian(payload, WireLayouts.ArticleReadDwellMs);
        ticket.CopyTo(payload[sizeof(int)..]);
        return Aeds.Encode(FrameType.ArticleReadChallenge, payload);
    }

    public static (int DwellMs, ReadOnlyMemory<byte> Ticket) DecodeArticleReadSubmit(ReadOnlyMemory<byte> frame)
    {
        var payload = Aeds.Decode(frame.Span, FrameType.ArticleReadSubmit);
        if (payload.Length != sizeof(int) + WireLayouts.ArticleReadTicketSize)
            throw new ProtocolException("Invalid article read submit payload length.");
        return (BinaryPrimitives.ReadInt32LittleEndian(payload), frame[(Aeds.HeaderSize + sizeof(int))..]);
    }

    public static byte[] EncodeArticleReadReceipt(bool counted) => Aeds.Encode(FrameType.ArticleReadReceipt, [(byte)(counted ? 1 : 0)]);

    public static ArticleRightsPolicy RightsPolicy(ArticleRightsCommand input, long revision) => new(
        input.Id, revision, true, input.Enabled, input.LicenseType, input.CopyrightHolder, input.CopyrightYear,
        input.RightsStatement, input.AttributionTemplate, input.CopyPolicy, input.MaxExcerptChars,
        input.AllowCodeCopy, input.ShowPublicBadge, input.ProofBindingEnabled);

    public static ArticleRightsPolicy DefaultRights(int id, long revision) => new(id, revision, true,
        true, "all-rights-reserved", "", 0, "", "", "append-attribution", 300, true, true, true);

    public static ArticleRightsPolicy MissingRights(int id, long revision) => new(id, revision, false,
        false, "", "", 0, "", "", "", 0, false, false, false);

    internal static void Validate(ArticleRightsCommand value)
    {
        if (value.IdempotencyKey == Guid.Empty) throw new ProtocolException("Invalid rights command");
        Validate(RightsPolicy(value, value.ExpectedRevision));
    }

    public static void Validate(ArticleRightsPolicy value)
    {
        if (value.Id <= 0 || value.Revision <= 0) throw new ProtocolException("Invalid article rights coordinates");
        if (!value.Present)
        {
            if (value != MissingRights(value.Id, value.Revision))
                throw new ProtocolException("An absent policy cannot carry rights values");
            return;
        }
        if (value.LicenseType is not ("all-rights-reserved" or "CC-BY-4.0" or "CC-BY-SA-4.0" or "CC-BY-NC-4.0" or "CC0-1.0") ||
            value.CopyPolicy is not ("append-attribution" or "excerpt-only" or "disabled") ||
            value.CopyrightYear != 0 && value.CopyrightYear is < 1000 or > 9999 ||
            value.MaxExcerptChars is < 0 or > 10000 || !ValidText(value.CopyrightHolder, 256, false) ||
            !ValidText(value.RightsStatement, 4000, true) || !ValidText(value.AttributionTemplate, 4000, true))
            throw new ProtocolException("Invalid article rights policy");
    }

    private static bool ValidText(string value, int max, bool multiline) =>
        value.Length <= max && value == value.Trim() &&
        !value.Any(character => char.IsControl(character) && (!multiline || character is not ('\r' or '\n' or '\t')));

    internal static void Validate(ArticleSchedule value)
    {
        if (value.Id <= 0 || value.Revision <= 0 || value.DueUnixMs < 0 || !IsValidUnixMs(value.DueUnixMs) ||
            value.PublishedRevision < 0 || value.PublishedRevision > value.Revision)
            throw new ProtocolException("Invalid schedule coordinates");
    }

    internal static void Validate(ArticleScheduleCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.DueUnixMs < 0 || !IsValidUnixMs(value.DueUnixMs))
            throw new ProtocolException("Invalid schedule command");
    }

    public static byte[] EncodeArticleSummaryCommand(ArticleSummaryCommand value)
    {
        ValidateArticleSummaryCommand(value);
        return EncodeFrame(FrameType.ArticleSummaryCommand, writer =>
            WriteArticleSummaryText(writer.I32(value.Id).I64(value.ExpectedRevision).Uuid(value.IdempotencyKey),
                value.Text, ArticleSummaryEditBytes));
    }

    public static ArticleSummaryCommand DecodeArticleSummaryCommand(ReadOnlySpan<byte> frame)
    {
        var value = DecodeFrame(FrameType.ArticleSummaryCommand, frame, MaxArticleSummaryCommandFrameBytes, InvalidArticleSummary,
            static (ref Reader reader) => new ArticleSummaryCommand(reader.I32(), reader.I64(), reader.Uuid(),
                reader.Text(ArticleSummaryEditBytes)));
        ValidateArticleSummaryCommand(value);
        return value;
    }

    public static byte[] EncodeArticleSummary(ArticleSummary value)
    {
        ValidateArticleSummary(value.Id, value.Revision, value.Text, ArticleSummaryReadChars);
        return EncodeFrame(FrameType.ArticleSummary, writer =>
            WriteArticleSummaryText(writer.I32(value.Id).I64(value.Revision), value.Text, ArticleSummaryReadBytes));
    }

    public static ArticleSummary DecodeArticleSummary(ReadOnlySpan<byte> frame)
    {
        var value = DecodeFrame(FrameType.ArticleSummary, frame,
            static (ref Reader reader) => new ArticleSummary(reader.I32(), reader.I64(), reader.Text(ArticleSummaryReadBytes)));
        ValidateArticleSummary(value.Id, value.Revision, value.Text, ArticleSummaryReadChars);
        return value;
    }

    private static void WriteArticleSummaryText(Writer writer, string text, int maxBytes)
    {
        try { writer.Text(text, maxBytes); }
        catch (EncoderFallbackException) { throw InvalidArticleSummary(); }
    }

    private static void ValidateArticleSummaryCommand(ArticleSummaryCommand value)
    {
        if (value.IdempotencyKey == Guid.Empty) throw InvalidArticleSummary();
        ValidateArticleSummary(value.Id, value.ExpectedRevision, value.Text, ArticleSummaryEditChars);
    }

    private static void ValidateArticleSummary(int id, long revision, string text, int maxChars)
    {
        if (id <= 0 || revision <= 0 || text.Length > maxChars || text.Contains('\0')) throw InvalidArticleSummary();
    }

    private static ProtocolException InvalidArticleSummary() => new("Invalid private article summary.");

    private static void WriteOptionalTaxonomy(Writer writer, TaxonomyName? category, IReadOnlyList<TaxonomyName> tags)
    {
        writer.I32(category?.Id ?? 0);
        if (category is not null) writer.Text(category.Name, TaxonomyNameBytes);
        writer.Items(tags, static (w, tag) => w.I32(tag.Id).Text(tag.Name, TaxonomyNameBytes));
    }

    public static byte[] EncodeAuthorArticlePage(AuthorArticlePage page) =>
        EncodeFrame(FrameType.AuthorArticlePage, writer => writer.I32(page.Total).I32(page.NextId).Items(page.Items, static (w, row) =>
            WriteOptionalTaxonomy(w.I32(row.Id).I64(row.Revision).Text(row.Title, TitleBytes)
                .I32((int)row.State).I64(row.ModifiedUnixMs).I64(row.ScheduledUnixMs), row.Category, row.Tags)));

    internal static void Validate(AuthorRecentOpenCommand value)
    {
        if (value.SchemaVersion != 1 || value.ExpectedRevision is < 0 or long.MaxValue || value.RequestId == Guid.Empty ||
            value.ArticleId <= 0 || value.ArticleRevision <= 0)
            throw new ProtocolException("Invalid author recent open command.");
    }

    internal static void Validate(AuthorRecentOpenReceipt value)
    {
        if (value.SchemaVersion != 1 || value.Revision <= 0 || value.RequestId == Guid.Empty || value.ArticleId <= 0 ||
            value.ArticleRevision <= 0 || value.OpenedAtUnixMs <= 0)
            throw new ProtocolException("Invalid author recent open receipt.");
    }

    public static byte[] EncodeAuthorRecentOpenPage(AuthorRecentOpenPage value) =>
        EncodeFrame(FrameType.AuthorRecentOpenPage, writer => writer.I32(1).I64(value.Revision)
            .Text(value.NextCursor, AuthorRecentOpenCursorChars).Items(value.Items, static (w, item) =>
                w.I32(item.ArticleId).I64(item.ArticleRevision).I64(item.Sequence).I64(item.OpenedAtUnixMs).Text(item.Title, TitleBytes)));

    public static void Validate(AuthoringWorkspaceSnapshot value) =>
        ValidateSnapshot(value.SchemaVersion, 1, value.Revision, value.UpdatedAtUnixMs, value.ActiveArticleId, value.Tabs, value.Skipped);

    internal static void Validate(AuthoringWorkspaceCommand value) =>
        ValidateWorkspace(value.SchemaVersion, 1, value.ExpectedRevision, value.ActiveArticleId, value.Tabs);

    internal static void Validate(AuthoringWorkspaceLayout value)
    {
        ValidateSnapshot(value.SchemaVersion, 2, value.Revision, value.UpdatedAtUnixMs, value.ActiveArticleId, value.Tabs, value.Skipped);
        if (value.Revision == 0 && value.InspectorOpen) throw new ProtocolException("Invalid authoring workspace layout.");
    }

    internal static void Validate(AuthoringWorkspaceLayoutCommand value) =>
        ValidateWorkspace(value.SchemaVersion, 2, value.ExpectedRevision, value.ActiveArticleId, value.Tabs);

    public static void Validate(AuthoringWorkspaceGroups value)
    {
        ValidateGroups(value.SchemaVersion, value.Revision, value.ActiveArticleId, value.Tabs,
            value.SecondaryActiveArticleId, value.SecondaryTabs, value.FocusedGroup);
        var count = value.Tabs.Count + value.SecondaryTabs.Count;
        if (value.Skipped < 0 || value.Skipped > AuthoringWorkspaceTabs - count ||
            (value.Revision == 0 ? value.UpdatedAtUnixMs != 0 || count != 0 || value.Skipped != 0 || value.InspectorOpen
                : value.UpdatedAtUnixMs <= 0))
            throw new ProtocolException("Invalid authoring workspace revision.");
    }

    internal static void Validate(AuthoringWorkspaceGroupsCommand value) =>
        ValidateGroups(value.SchemaVersion, value.ExpectedRevision, value.ActiveArticleId, value.Tabs,
            value.SecondaryActiveArticleId, value.SecondaryTabs, value.FocusedGroup);

    private static void ValidateSnapshot(int version, int expected, long revision, long updated, int active, IReadOnlyList<int> tabs, int skipped)
    {
        ValidateWorkspace(version, expected, revision, active, tabs);
        if (skipped is < 0 or > AuthoringWorkspaceTabs ||
            (revision == 0 ? updated != 0 || tabs.Count != 0 || skipped != 0 : updated <= 0))
            throw new ProtocolException("Invalid authoring workspace revision.");
    }

    private static void ValidateWorkspace(int version, int expected, long revision, int active, IReadOnlyList<int> tabs)
    {
        if (version != expected || revision < 0 || active < 0 || tabs.Count > AuthoringWorkspaceTabs)
            throw new ProtocolException("Invalid authoring workspace coordinates.");
        ValidatePane(active, tabs, []);
    }

    private static void ValidateGroups(int version, long revision, int active, IReadOnlyList<int> tabs,
        int secondaryActive, IReadOnlyList<int> secondaryTabs, int focusedGroup)
    {
        if (version != 3 || revision < 0 || active < 0 || secondaryActive < 0 ||
            tabs.Count > AuthoringWorkspaceTabs - secondaryTabs.Count ||
            focusedGroup is < 0 or > 1 || (focusedGroup == 1 && secondaryActive == 0))
            throw new ProtocolException("Invalid authoring workspace groups.");
        var ids = new HashSet<int>();
        ValidatePane(active, tabs, ids);
        ValidatePane(secondaryActive, secondaryTabs, ids);
    }

    private static void ValidatePane(int active, IReadOnlyList<int> tabs, HashSet<int> ids)
    {
        // A negative ID represents the group's sole preview. The magnitude is always a positive article ID.
        var preview = false;
        var hasActive = active == 0;
        foreach (var tab in tabs)
        {
            if (tab is 0 or int.MinValue || !ids.Add(Math.Abs(tab)) || (preview && tab < 0))
                throw new ProtocolException("Invalid authoring workspace tabs.");
            preview |= tab < 0;
            hasActive |= active == Math.Abs(tab);
        }
        if (!hasActive) throw new ProtocolException("Unknown active workspace article.");
    }

    public static byte[] EncodeDocumentExportCreate(DocumentExportCreate request) =>
        EncodeRecord(FrameType.DocumentExportCreate, request, ValidateDocumentExport, WriteDocumentExportRequest);

    public static DocumentExportCreate DecodeDocumentExportCreate(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.DocumentExportCreate, frame, ReadDocumentExportRequest);

    public static byte[] EncodeDocumentExportTaskRef(Guid id) =>
        id == Guid.Empty ? throw InvalidDocumentExport() : EncodeFrame(FrameType.DocumentExportTaskRef, writer => writer.Uuid(id));

    public static Guid DecodeDocumentExportTaskRef(ReadOnlySpan<byte> frame)
    {
        var id = DecodeFrame(FrameType.DocumentExportTaskRef, frame, static (ref Reader reader) => reader.Uuid());
        return id == Guid.Empty ? throw InvalidDocumentExport() : id;
    }

    public static byte[] EncodeDocumentExportTask(DocumentExportTask value) =>
        EncodeFrame(FrameType.DocumentExportTask, writer => WriteDocumentExportTask(writer, value));

    public static DocumentExportTask DecodeDocumentExportTask(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.DocumentExportTask, frame, ReadDocumentExportTask);

    public static byte[] EncodeDocumentExportTaskList(IReadOnlyList<DocumentExportTask> values)
    {
        if (values.Count > DocumentExportTasksPerOwner) throw InvalidDocumentExport();
        return EncodeFrame(FrameType.DocumentExportTaskList, writer =>
        {
            writer.Byte((byte)values.Count);
            foreach (var value in values) WriteDocumentExportTask(writer, value);
        });
    }

    public static IReadOnlyList<DocumentExportTask> DecodeDocumentExportTaskList(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, FrameType.DocumentExportTaskList);
        if (payload.IsEmpty || payload[0] > DocumentExportTasksPerOwner || payload.Length != 1 + payload[0] * DocumentExportTaskSize)
            throw InvalidDocumentExport();
        var result = new DocumentExportTask[payload[0]];
        var reader = new Reader(payload[1..]);
        for (var index = 0; index < result.Length; index++) result[index] = ReadDocumentExportTask(ref reader);
        return result;
    }

    private static void WriteDocumentExportRequest(Writer writer, DocumentExportCreate request) =>
        writer.Uuid(request.Id).I32(request.Article).I64(request.Revision).I64(request.SourceRevision).Byte((byte)request.Format);

    private static DocumentExportCreate ReadDocumentExportRequest(ref Reader reader)
    {
        var request = new DocumentExportCreate(reader.Uuid(), reader.I32(), reader.I64(), reader.I64(), (DocumentExportFormat)reader.Byte());
        ValidateDocumentExport(request);
        return request;
    }

    private static void WriteDocumentExportTask(Writer writer, DocumentExportTask task)
    {
        ValidateDocumentExportTask(task);
        WriteDocumentExportRequest(writer, task.Request);
        writer.FixedBytes([(byte)task.State, (byte)task.Failure, task.Provider])
            .I64(task.Created).I64(task.Started).I64(task.Finished).I64(task.Expires)
            .FixedBytes(task.SourceDigest).FixedBytes(task.OutputDigest ?? AbsentDocumentExportDigest).I32(task.OutputBytes);
    }

    private static DocumentExportTask ReadDocumentExportTask(ref Reader reader)
    {
        var request = ReadDocumentExportRequest(ref reader);
        var flags = reader.FixedBytes(3);
        var result = new DocumentExportTask(request, (DocumentExportState)flags[0], (DocumentExportFailure)flags[1], flags[2],
            reader.I64(), reader.I64(), reader.I64(), reader.I64(), reader.FixedBytes(32).ToArray(), reader.FixedBytes(32).ToArray(), reader.I32());
        if (result.OutputBytes == 0 && result.OutputDigest!.AsSpan().IndexOfAnyExcept((byte)0) == -1)
            result = result with { OutputDigest = null };
        ValidateDocumentExportTask(result);
        return result;
    }

    private static void ValidateDocumentExport(DocumentExportCreate request)
    {
        if (request.Id == Guid.Empty || request.Article <= 0 || request.SourceRevision <= 0 ||
            request.SourceRevision > request.Revision || !Enum.IsDefined(request.Format))
            throw InvalidDocumentExport();
    }

    private static void ValidateDocumentExportTask(DocumentExportTask task)
    {
        ValidateDocumentExport(task.Request);
        var ready = task.State == DocumentExportState.Succeeded;
        var terminal = task.State is DocumentExportState.Succeeded or DocumentExportState.Failed or
            DocumentExportState.Cancelled or DocumentExportState.Blocked;
        var failure = task.State is DocumentExportState.Failed or DocumentExportState.Blocked;
        if (!Enum.IsDefined(task.State) || !Enum.IsDefined(task.Failure) || task.Provider is < 1 or > 4 ||
            task.Created <= 0 || task.Expires <= task.Created ||
            (task.Started != 0 && task.Started < task.Created) ||
            (task.Finished != 0 && task.Finished < Math.Max(task.Created, task.Started)) ||
            (task.State is DocumentExportState.Running or DocumentExportState.Cancelling or DocumentExportState.Succeeded && task.Started == 0) ||
            terminal != (task.Finished != 0) || failure != (task.Failure != DocumentExportFailure.None) ||
            task.SourceDigest.Length != 32 ||
            (ready ? task.OutputDigest?.Length != 32 || task.OutputBytes is <= 0 or > 4 * 1024 * 1024 :
                task.OutputDigest is not null || task.OutputBytes != 0))
            throw InvalidDocumentExport();
    }

    private static ProtocolException InvalidDocumentExport() => new("Invalid document export frame.");

    internal static void Validate(DraftRecoveryScope input)
    {
        if (input.SiteId == Guid.Empty || input.UserId == Guid.Empty)
            throw new ProtocolException("Invalid recovery scope.");
    }

    public static byte[] EncodePrivateMediaUpload(Guid id, int length, int partSize, long expiresAt,
        bool reserved, Guid? asset, IReadOnlyList<int> received)
    {
        if (id == Guid.Empty || length is < 1 or > PrivateMediaBytes || partSize is < 65536 or > 2097152 ||
            expiresAt <= 0 || asset == Guid.Empty || asset.HasValue && (!reserved || received.Count != 0) || received.Count > 320)
            throw new ProtocolException("Invalid private upload state.");
        int total = (length + partSize - 1) / partSize;
        var previous = -1;
        foreach (var part in received)
        {
            if (part <= previous || part >= total) throw new ProtocolException("Invalid private upload part list.");
            previous = part;
        }
        return EncodeFrame(FrameType.PrivateMediaUploadState, writer => writer.Uuid(id).I32(length).I32(partSize)
            .I64(expiresAt).Bool(reserved).Optional(asset, static (w, coordinate) => w.Uuid(coordinate)).I32s(received, 320));
    }

    public static byte[] EncodePrivateMedia(IReadOnlyList<PrivateMediaItem> items, bool hasMore = false)
    {
        if (items.Count > 50 || items.Count == 0 && hasMore) throw new ProtocolException("Invalid private media page.");
        return EncodeFrame(FrameType.PrivateMediaItems, writer => writer.I32(WireLayouts.PrivateMediaVersion).Bool(hasMore)
            .Items(items, static (w, item) =>
            {
                if (item.Format is not (1 or 2 or 3) || item.Length is < 1 or > PrivateMediaBytes ||
                    item.Width is < 1 or > 8192 || item.Height is < 1 or > 8192 || item.Id == Guid.Empty ||
                    item.CreatedAt.Offset != TimeSpan.Zero || item.Name.Length == 0)
                    throw new ProtocolException("Invalid private media record.");
                w.Uuid(item.Id).I32(item.Format).I32(item.Length).I32(item.Width).I32(item.Height)
                    .I64(item.CreatedAt.UtcTicks).Text(item.Name, 255);
            }));
    }

    public static byte[] EncodeArticlePublishImages(ArticlePublishImages value) =>
        EncodeRecord(FrameType.ArticlePublishImages, value, ValidatePublishImages, static (writer, record) =>
            writer.I32(record.ArticleId).I64(record.ExpectedRevision).Uuid(record.IdempotencyKey)
                .Items(record.AssetIds, static (w, asset) => w.Uuid(asset)));

    public static ArticlePublishImages DecodeArticlePublishImages(ReadOnlySpan<byte> frame) =>
        DecodeRecord<ArticlePublishImages>(FrameType.ArticlePublishImages, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.Uuid(),
                reader.Items(1, ArticlePublishImages.Maximum, InvalidPublishImages, static (ref Reader r) => r.Uuid())),
            ValidatePublishImages);

    public static byte[] EncodePublicArticleMedia(PublicArticleMedia value) =>
        EncodeRecord(FrameType.PublicArticleMedia, value, ValidatePublicArticleMedia, static (writer, record) =>
            writer.I32(record.ArticleId).I64(record.Publication).Items(record.Images, static (w, image) =>
                w.FixedBytes(Convert.FromHexString(image.Digest)).I32(image.Format).I32(image.Length).I32(image.Width).I32(image.Height)));

    public static PublicArticleMedia DecodePublicArticleMedia(ReadOnlySpan<byte> frame) =>
        DecodeRecord<PublicArticleMedia>(FrameType.PublicArticleMedia, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.Items(0, ArticlePublishImages.Maximum, InvalidArticleMedia,
                static (ref Reader r) => new PublishedArticleImage(Convert.ToHexStringLower(r.FixedBytes(32)),
                    r.I32(), r.I32(), r.I32(), r.I32()))),
            ValidatePublicArticleMedia);

    private static void ValidatePublishImages(ArticlePublishImages value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.AssetIds.Count is < 1 or > ArticlePublishImages.Maximum || value.AssetIds.Contains(Guid.Empty) ||
            value.AssetIds.Distinct().Count() != value.AssetIds.Count)
            throw InvalidPublishImages();
    }

    private static void ValidatePublicArticleMedia(PublicArticleMedia value)
    {
        if (value.ArticleId <= 0 || value.Publication <= 0 || value.Images.Count > ArticlePublishImages.Maximum)
            throw InvalidArticleMedia();
        var total = 0L;
        var digests = new HashSet<string>(StringComparer.Ordinal);
        foreach (var image in value.Images)
            if (!image.Valid() || !digests.Add(image.Digest) || (total += image.Length) > 40 * 1024 * 1024)
                throw InvalidArticleMedia();
    }

    private static ProtocolException InvalidPublishImages() => new("Invalid published image selection.");
    private static ProtocolException InvalidArticleMedia() => new("Invalid public article images.");

    public static byte[] EncodeRevisionHistory(RevisionHistoryPage page) =>
        EncodeRecord(FrameType.RevisionHistory, page, Validate, static (writer, record) =>
            writer.I32(record.Id).I64(record.Revision).I64(record.PublishedRevision)
                .Text(record.NextCursor, RevisionHistoryCursorChars).Items(record.Items, static (w, item) =>
                    w.I64(item.Revision).Text(item.Title, TitleBytes).I64(item.SavedAtUnixMs)
                        .I64(item.SourceRevision).Text(item.Reason, RollbackReasonBytes)));

    public static RevisionHistoryPage DecodeRevisionHistory(ReadOnlySpan<byte> frame) =>
        DecodeRecord<RevisionHistoryPage>(FrameType.RevisionHistory, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.I64(), reader.Text(RevisionHistoryCursorChars),
                reader.Items(0, RevisionHistoryPageSize, static () => new ProtocolException("Invalid revision history size"),
                    static (ref Reader r) => new RevisionHistoryItem(r.I64(), r.Text(TitleBytes), r.I64(), r.I64(),
                        r.Text(RollbackReasonBytes)))),
            Validate);

    internal static void Validate(DraftRollback value)
    {
        if (value.Id <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.ExpectedRevision ||
            value.IdempotencyKey == Guid.Empty || !ValidRollbackReason(value.Reason))
            throw new ProtocolException("Invalid draft rollback");
    }

    internal static void Validate(RevisionComparison value)
    {
        if (value.Id <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision ||
            value.Title.Length == 0 || value.SourceTitle.Length == 0)
            throw new ProtocolException("Invalid revision comparison");
    }

    private static void Validate(RevisionHistoryPage page)
    {
        if (page.Id <= 0 || page.Revision <= 0 || page.PublishedRevision < 0 || page.PublishedRevision > page.Revision ||
            page.Items.Count > RevisionHistoryPageSize ||
            page.NextCursor.Length != 0 && (page.NextCursor.Length != RevisionHistoryCursorChars ||
                page.Items.Count != RevisionHistoryPageSize || !IsBase64Url(page.NextCursor)))
            throw new ProtocolException("Invalid revision history");
        long previous = 0;
        foreach (var item in page.Items)
        {
            if (item.Revision <= 0 || item.Revision > page.Revision || previous != 0 && item.Revision >= previous ||
                item.Title.Length == 0 || item.SourceRevision < 0 ||
                (item.SourceRevision == 0 ? item.Reason.Length != 0 :
                    item.SourceRevision >= item.Revision - 1 || !ValidRollbackReason(item.Reason)))
                throw new ProtocolException("Invalid revision history entry");
            previous = item.Revision;
        }
    }

    private static bool ValidRollbackReason(string value) =>
        value.Length is >= 8 and <= 1000 && value == value.Trim() &&
        !value.Any(char.IsControl) && value.EnumerateRunes().Count() is >= 8 and <= 500;

    public static byte[] EncodeRevisionMetadataComparison(int id, long revision, long sourceRevision,
        SavedRevisionMetadata current, SavedRevisionMetadata source) =>
        EncodeFrame(FrameType.RevisionMetadataComparison, writer =>
        {
            writer.I32(id).I64(revision).I64(sourceRevision);
            WriteRevisionMetadata(writer, current);
            WriteRevisionMetadata(writer, source);
        });

    private static void WriteRevisionMetadata(Writer writer, SavedRevisionMetadata metadata)
    {
        if (metadata.Tags.Count > TaxonomyTagCount) throw new ProtocolException("Too many tags on the saved revision.");
        WriteOptionalTaxonomy(writer.Text(metadata.Summary, ArticleSummaryReadBytes), metadata.Category, metadata.Tags);
    }
}
