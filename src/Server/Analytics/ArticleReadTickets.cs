using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Analytics;

internal sealed class ArticleReadTickets(TimeProvider clock) : IDisposable
{
    internal const int EpochSeconds = 15 * 60;
    internal const int MaxUserAgentBytes = 512;
    private const int PrefixSize = 24;
    private const int DigestSize = 32;
    private static readonly TimeSpan Dwell = TimeSpan.FromMilliseconds(WireLayouts.ArticleReadDwellMs);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private readonly long _started = clock.GetTimestamp();
    private readonly byte[] _ticketKey = RandomNumberGenerator.GetBytes(DigestSize);
    private readonly byte[] _dedupKey = RandomNumberGenerator.GetBytes(DigestSize);

    internal static long Epoch(DateTimeOffset utc) => utc.ToUnixTimeSeconds() / EpochSeconds;

    internal static bool CanIssue(DateTimeOffset utc, long epoch) =>
        epoch >= 0 && DateTimeOffset.FromUnixTimeSeconds(checked((epoch + 1) * EpochSeconds)) - utc > Dwell;

    internal byte[] Viewer(int article, long epoch, IPAddress address, string userAgent)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        Span<byte> context = stackalloc byte[sizeof(int) + sizeof(long) + 1 + 16 + MaxUserAgentBytes];
        BinaryPrimitives.WriteInt32LittleEndian(context, article);
        BinaryPrimitives.WriteInt64LittleEndian(context[sizeof(int)..], epoch);
        const int addressOffset = sizeof(int) + sizeof(long) + 1;
        try
        {
            if (!address.TryWriteBytes(context.Slice(addressOffset, 16), out var addressBytes))
                throw new InvalidOperationException("Unsupported read proof address.");
            context[addressOffset - 1] = (byte)addressBytes;
            var agentOffset = addressOffset + addressBytes;
            var agentBytes = Encoding.UTF8.GetBytes(userAgent, context[agentOffset..]);
            return HMACSHA256.HashData(_dedupKey, context[..(agentOffset + agentBytes)]);
        }
        finally { CryptographicOperations.ZeroMemory(context); }
    }

    internal byte[] Issue(int article, long publication, long epoch, ReadOnlySpan<byte> viewer)
    {
        var ticket = new byte[WireLayouts.ArticleReadTicketSize];
        BinaryPrimitives.WriteInt64LittleEndian(ticket, clock.GetElapsedTime(_started).Ticks);
        RandomNumberGenerator.Fill(ticket.AsSpan(sizeof(long), PrefixSize - sizeof(long)));
        Sign(article, publication, epoch, viewer, ticket.AsSpan(0, PrefixSize), ticket.AsSpan(PrefixSize));
        return ticket;
    }

    internal bool Accept(int article, long publication, long epoch, ReadOnlySpan<byte> viewer, ReadOnlySpan<byte> ticket, int dwellMs)
    {
        if (ticket.Length != WireLayouts.ArticleReadTicketSize || dwellMs < WireLayouts.ArticleReadDwellMs ||
            dwellMs > Lifetime.TotalMilliseconds) return false;
        Span<byte> digest = stackalloc byte[DigestSize];
        Sign(article, publication, epoch, viewer, ticket[..PrefixSize], digest);
        if (!CryptographicOperations.FixedTimeEquals(digest, ticket[PrefixSize..])) return false;
        var issued = BinaryPrimitives.ReadInt64LittleEndian(ticket);
        var now = clock.GetElapsedTime(_started).Ticks;
        if (issued < 0 || issued > now) return false;
        var elapsed = now - issued;
        return elapsed >= Dwell.Ticks && elapsed <= Lifetime.Ticks && elapsed >= dwellMs * TimeSpan.TicksPerMillisecond;
    }

    private void Sign(int article, long publication, long epoch, ReadOnlySpan<byte> viewer, ReadOnlySpan<byte> prefix, Span<byte> digest)
    {
        const int coordinates = sizeof(int) + 2 * sizeof(long);
        Span<byte> context = stackalloc byte[coordinates + DigestSize + PrefixSize];
        BinaryPrimitives.WriteInt32LittleEndian(context, article);
        BinaryPrimitives.WriteInt64LittleEndian(context[sizeof(int)..], publication);
        BinaryPrimitives.WriteInt64LittleEndian(context[(sizeof(int) + sizeof(long))..], epoch);
        viewer.CopyTo(context[coordinates..]);
        prefix.CopyTo(context[(coordinates + DigestSize)..]);
        HMACSHA256.HashData(_ticketKey, context, digest);
    }

    internal static int DwellBucket(int dwellMs) => dwellMs switch
    {
        < 10_000 => 0,
        < 30_000 => 1,
        < 120_000 => 2,
        _ => 3
    };

    public void Dispose()
    {
        CryptographicOperations.ZeroMemory(_ticketKey);
        CryptographicOperations.ZeroMemory(_dedupKey);
    }
}
