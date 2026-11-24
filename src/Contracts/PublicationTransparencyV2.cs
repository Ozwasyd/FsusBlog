namespace FsusBlog.V2.Contracts;

public static class PublicationTransparencyV2
{
    public static byte[] ReceiptDigest(ReadOnlySpan<byte> transcript, ReadOnlySpan<byte> signature)
    {
        if (transcript.IsEmpty || signature.Length != 64) throw new ArgumentException("Invalid signed publication receipt.");
        var domain = "fsusblog.integrity.native-transparency-receipt.v2\0"u8;
        Span<byte> input = stackalloc byte[domain.Length + 32 + 64];
        domain.CopyTo(input);
        SHA256.HashData(transcript, input.Slice(domain.Length, 32));
        signature.CopyTo(input[(domain.Length + 32)..]);
        return SHA256.HashData(input);
    }

    public static byte[] EntryDigest(long sequence, ReadOnlySpan<byte> previous, ReadOnlySpan<byte> receipt)
    {
        if (sequence <= 0 || previous.Length != 32 || receipt.Length != 32)
            throw new ArgumentException("Invalid publication transparency entry.");
        var domain = "fsusblog.integrity.native-transparency-entry.v2\0"u8;
        Span<byte> input = stackalloc byte[domain.Length + 8 + 32 + 32];
        domain.CopyTo(input);
        BinaryPrimitives.WriteInt64BigEndian(input.Slice(domain.Length, 8), sequence);
        previous.CopyTo(input.Slice(domain.Length + 8, 32));
        receipt.CopyTo(input[(domain.Length + 40)..]);
        return SHA256.HashData(input);
    }
}
