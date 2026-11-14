using System.Buffers.Binary;
using FsusBlog.V2.Contracts;

internal static class InboxVectors
{
    public static void Run(string fixtures)
    {
        byte[] Fixture(string name) => Convert.FromHexString(string.Concat(
            File.ReadAllLines(Path.Combine(fixtures, name + ".hex"))));

        // The list and message fixtures come directly from pinned v1. Current detail and
        // request fixtures use independent field packing from the pinned v1 POD layouts.
        var time = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var item = new InboxListRecord(7, "Support", 1, 2, time, time.AddDays(1), true, true,
            new InboxPreviewRecord(1, time.AddDays(2), "Latest reply", "Admin"));
        Equal(Fixture("conversation-list-frame"), InboxWire.EncodeList([item], 1));
        var message = new InboxMessageRecord(11, 7, 0, time.AddHours(1), "Message body", "Alice");
        Equal(Fixture("conversation-message-frame"), InboxWire.EncodeMessage(message));
        var detail = new InboxDetailRecord(7, "Support", 0, 1, time, 11, false, true, [message]);
        Equal(Fixture("conversation-detail-v2"), InboxWire.EncodeDetail(detail with { Replayed = true }, createResponse: true));
        Equal(Fixture("conversation-detail-v3"), InboxWire.EncodeDetail(detail with { Previous = 11 }));

        var cursor = new InboxCursor(9_007_199_254_741_001, time, 7);
        var token = InboxWire.EncodeCursor(cursor);
        var cursorList = Aeds.Decode(InboxWire.EncodeList([item], 2, token), FrameType.ConversationList);
        if (InboxWire.DecodeCursor(token) != cursor || BinaryPrimitives.ReadInt32LittleEndian(cursorList) != 0x4D534743 ||
            BinaryPrimitives.ReadInt32LittleEndian(cursorList[4..]) != 1 || cursorList[8] != 1 ||
            BinaryPrimitives.ReadInt32LittleEndian(cursorList[13..]) != 32 ||
            BinaryPrimitives.ReadInt32LittleEndian(cursorList[17..]) != 2 ||
            !cursorList[^56..^24].SequenceEqual(System.Text.Encoding.ASCII.GetBytes(token)))
            throw new InvalidOperationException("Incorrect inbox list cursor envelope");
        Reject(() => InboxWire.DecodeCursor(token + "="));

        var create = Fixture("conversation-create-request");
        var reply = Fixture("conversation-reply-request");
        var read = Fixture("conversation-read-request");
        if (InboxWire.DecodeCreate(create) != ("申诉", "A café 🐈") ||
            InboxWire.DecodeReply(reply) != (cursor.SnapshotMessageId, "A café 🐈") ||
            InboxWire.DecodeRead(read) != cursor.SnapshotMessageId)
            throw new InvalidOperationException("Incorrect inbox request decoding");

        foreach (int length in Enumerable.Range(0, create.Length))
            Reject(() => InboxWire.DecodeCreate(create.AsSpan(0, length)));
        var payload = Aeds.Decode(create, FrameType.ConversationCreateRequest).ToArray();
        payload[^1] = 255;
        Reject(() => InboxWire.DecodeCreate(Aeds.Encode(FrameType.ConversationCreateRequest, payload)));
        BinaryPrimitives.WriteInt32LittleEndian(payload, int.MaxValue);
        Reject(() => InboxWire.DecodeCreate(Aeds.Encode(FrameType.ConversationCreateRequest, payload)));
        Reject(() => InboxWire.DecodeReply(Aeds.Encode(FrameType.AccountConversationReplyRequest, new byte[20])));
        Reject(() => InboxWire.DecodeRead(Aeds.Encode(FrameType.ConversationReadRequest, new byte[9])));
    }

    private static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
    {
        if (!expected.SequenceEqual(actual))
            throw new InvalidOperationException("Inbox AEDS differs from its reference vector");
    }

    private static void Reject(Action run)
    {
        try
        {
            run();
        }
        catch (ProtocolException)
        {
            return;
        }
        throw new InvalidOperationException("Invalid inbox AEDS accepted");
    }
}
