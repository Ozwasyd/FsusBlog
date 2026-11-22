namespace FsusBlog.V2.Server.Administration;

internal readonly record struct AdminInboxActivityCursor(long Snapshot, DateTimeOffset At, long Conversation)
{
    internal const int EncodedLength = 75;

    internal string Encode(byte[] session, byte scope) =>
        AdminInboxCursorAuth.Encode(session, scope, [Snapshot, At.UtcTicks, Conversation]);

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxActivityCursor cursor)
    {
        cursor = default;
        Span<long> coordinates = stackalloc long[3];
        if (!AdminInboxCursorAuth.TryRead(value, EncodedLength, session, scope, coordinates)) return false;
        var snapshot = coordinates[0];
        var ticks = coordinates[1];
        var conversation = coordinates[2];
        if (snapshot <= 0 || conversation <= 0 || ticks <= 0 || ticks > DateTimeOffset.MaxValue.Ticks)
            return false;
        cursor = new(snapshot, new DateTimeOffset(ticks, TimeSpan.Zero), conversation);
        return true;
    }
}
