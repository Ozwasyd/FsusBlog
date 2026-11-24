namespace FsusBlog.V2.Contracts;

public readonly record struct InboxReplayRecord(long Sequence, int Kind, long ConversationId, long MessageId, DateTimeOffset OccurredAt);

public static class InboxReplayWire
{
    public static byte[] Encode(long next, bool hasMore, bool requiresResync, IReadOnlyList<InboxReplayRecord> events)
    {
        if (next < 0 || events.Count > WireLimits.InboxReplayMaxEvents ||
            (hasMore && events.Count == 0) || (requiresResync && (hasMore || events.Count > 0)))
            throw new ProtocolException("Invalid private inbox replay page.");

        var payload = new byte[WireLayouts.InboxReplayHeaderBytes + events.Count * WireLayouts.InboxReplayEventBytes];
        payload[0] = WireLayouts.InboxReplayVersion;
        payload[1] = (byte)((hasMore ? WireLayouts.InboxReplayHasMore : 0) | (requiresResync ? WireLayouts.InboxReplayRequiresResync : 0));
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(4), events.Count);
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(8), next);

        for (var index = 0; index < events.Count; index++)
        {
            var entry = events[index];
            if (entry.Sequence <= 0 || entry.Sequence != next - (events.Count - 1 - index) ||
                entry.Kind is not (WireLayouts.InboxConversationUpsert or WireLayouts.InboxMessageAppend or WireLayouts.InboxReadUpdated) ||
                entry.ConversationId <= 0 || entry.MessageId <= 0)
                throw new ProtocolException("Invalid private inbox replay event.");

            var target = payload.AsSpan(WireLayouts.InboxReplayHeaderBytes + index * WireLayouts.InboxReplayEventBytes);
            BinaryPrimitives.WriteInt64LittleEndian(target, entry.Sequence);
            BinaryPrimitives.WriteInt32LittleEndian(target[8..], entry.Kind);
            BinaryPrimitives.WriteInt64LittleEndian(target[12..], entry.ConversationId);
            BinaryPrimitives.WriteInt64LittleEndian(target[20..], entry.MessageId);
            BinaryPrimitives.WriteInt64LittleEndian(target[28..], entry.OccurredAt.ToUnixTimeMilliseconds());
        }
        return Aeds.Encode(FrameType.InboxReplay, payload);
    }
}
