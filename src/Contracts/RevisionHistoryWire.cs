using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record RevisionHistoryItem(long Revision, string Title, long SavedAtUnixMs, long SourceRevision, string Reason);
public sealed record RevisionHistoryPage(int Id, long Revision, long PublishedRevision, string NextCursor,
    IReadOnlyList<RevisionHistoryItem> Items);

public static partial class Wire
{
    public static byte[] EncodeRevisionHistory(RevisionHistoryPage page)
    {
        Validate(page);
        var writer = new Writer();
        writer.I32(page.Id);
        writer.I64(page.Revision);
        writer.I64(page.PublishedRevision);
        writer.Text(page.NextCursor, WireLimits.RevisionHistoryCursorChars);
        writer.I32(page.Items.Count);
        foreach (var item in page.Items)
        {
            writer.I64(item.Revision);
            writer.Text(item.Title, WireLimits.TitleBytes);
            writer.I64(item.SavedAtUnixMs);
            writer.I64(item.SourceRevision);
            writer.Text(item.Reason, WireLimits.RollbackReasonBytes);
        }
        return Aeds.Encode(FrameType.RevisionHistory, writer.Written);
    }

    public static RevisionHistoryPage DecodeRevisionHistory(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.RevisionHistory));
        var id = reader.I32();
        var revision = reader.I64();
        var published = reader.I64();
        var cursor = reader.Text(WireLimits.RevisionHistoryCursorChars);
        var items = new RevisionHistoryItem[reader.Count(0, WireLimits.RevisionHistoryPageSize, static () => new ProtocolException("Invalid revision history size"))];
        for (var i = 0; i < items.Length; i++)
            items[i] = new(reader.I64(), reader.Text(WireLimits.TitleBytes), reader.I64(), reader.I64(),
                reader.Text(WireLimits.RollbackReasonBytes));
        reader.Finish();
        var page = new RevisionHistoryPage(id, revision, published, cursor, items);
        Validate(page);
        return page;
    }

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
            page.Items.Count > WireLimits.RevisionHistoryPageSize ||
            page.NextCursor.Length != 0 && (page.NextCursor.Length != WireLimits.RevisionHistoryCursorChars ||
                page.Items.Count != WireLimits.RevisionHistoryPageSize ||
                page.NextCursor.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')))
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
}
