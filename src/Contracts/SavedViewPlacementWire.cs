namespace FsusBlog.V2.Contracts;

public enum SavedViewPlacementAction { Pin = 4, Unpin = 5, Default = 6, ClearDefault = 7, MoveBefore = 8 }
public sealed record SavedViewPlacementCommand(SavedViewPlacementAction Action, Guid Id, long Revision, long CollectionRevision,
    Guid RequestId, Guid BeforeId);
public sealed record SavedViewPlacement(long CollectionRevision, SavedViewSummary? Default, SavedViewSummary? Requested,
    bool RequestedPinned, int NextOffset, IReadOnlyList<SavedViewSummary> Pins);

public static partial class Wire
{
    public static byte[] EncodeSavedViewPlacementCommand(SavedViewPlacementCommand value)
    {
        Validate(value);
        var writer = new Writer();
        writer.I32((int)value.Action);
        writer.Uuid(value.Id);
        writer.I64(value.Revision);
        writer.I64(value.CollectionRevision);
        writer.Uuid(value.RequestId);
        writer.Uuid(value.BeforeId);
        return Aeds.Encode(FrameType.SavedViewPlacementCommand, writer.Written);
    }

    public static SavedViewPlacementCommand DecodeSavedViewPlacementCommand(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.SavedViewPlacementCommand));
        var value = new SavedViewPlacementCommand((SavedViewPlacementAction)reader.I32(), reader.Uuid(), reader.I64(), reader.I64(), reader.Uuid(), reader.Uuid());
        reader.Finish();
        Validate(value);
        return value;
    }

    public static byte[] EncodeSavedViewPlacement(SavedViewPlacement value)
    {
        var writer = new Writer();
        writer.I64(value.CollectionRevision);
        writer.Bool(value.Default is not null);
        if (value.Default is { } fallback) Write(fallback);
        writer.Bool(value.Requested is not null);
        if (value.Requested is { } selected) Write(selected);
        writer.Bool(value.RequestedPinned);
        writer.I32(value.NextOffset);
        writer.I32(value.Pins.Count);
        foreach (var pin in value.Pins) Write(pin);
        return Aeds.Encode(FrameType.SavedViewPlacement, writer.Written);

        void Write(SavedViewSummary entry)
        {
            writer.Uuid(entry.Id);
            writer.I64(entry.Revision);
            writer.Text(entry.Name, WireLimits.SavedViewNameBytes);
        }
    }

    public static SavedViewPlacement DecodeSavedViewPlacement(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.SavedViewPlacement));
        var revision = reader.I64();
        var fallback = reader.Bool() ? ReadSavedViewSummary(ref reader, revision) : null;
        var requested = reader.Bool() ? ReadSavedViewSummary(ref reader, revision) : null;
        var requestedPinned = reader.Bool();
        var next = reader.I32();
        var count = reader.I32();
        if (requestedPinned && requested is null || revision < 0 || count is < 0 or > WireLimits.SavedViewPageSize || next is < 0 or > WireLimits.SavedViewMaxCount ||
            next != 0 && count != WireLimits.SavedViewPageSize) throw InvalidSavedView();
        var pins = new SavedViewSummary[count];
        for (var i = 0; i < count; ++i) pins[i] = ReadSavedViewSummary(ref reader, revision);
        reader.Finish();
        if (pins.Select(pin => pin.Id).Distinct().Count() != count) throw InvalidSavedView();
        return new(revision, fallback, requested, requestedPinned, next, pins);
    }

    private static SavedViewSummary ReadSavedViewSummary(ref Reader reader, long revision)
    {
        var value = new SavedViewSummary(reader.Uuid(), reader.I64(), reader.Text(WireLimits.SavedViewNameBytes));
        if (value.Id == Guid.Empty || value.Revision <= 0 || value.Revision > revision || value.Name != NormalizeSavedViewName(value.Name))
            throw InvalidSavedView();
        return value;
    }

    private static void Validate(SavedViewPlacementCommand value)
    {
        if (!Enum.IsDefined(value.Action) || value.Id == Guid.Empty || value.RequestId == Guid.Empty || value.Revision <= 0 ||
            value.CollectionRevision < value.Revision || value.BeforeId == value.Id ||
            value.Action != SavedViewPlacementAction.MoveBefore && value.BeforeId != Guid.Empty) throw InvalidSavedView();
    }
}
