using System.Buffers.Binary;

namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    public const int ArticleReadSubmitFrameSize = Aeds.HeaderSize + sizeof(int) + WireLayouts.ArticleReadTicketSize;

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
}
