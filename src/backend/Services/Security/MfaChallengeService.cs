using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Audit;

namespace FsusBlog.Server.Services.Security;

public sealed record class MfaChallengeTicket
{
    public required string TicketId { get; init; }
    public required int UserId { get; init; }
    public required string Type { get; init; } // login | action
    public required string Action { get; init; }
    public bool RememberMe { get; init; }
    public bool RiskTriggered { get; init; }
    public DateTime CreatedAtUtc { get; init; } = DateTime.UtcNow;
}

public interface IMfaChallengeService
{
    Task<MfaChallengeTicket> CreateLoginChallengeAsync(int userId, bool riskTriggered, bool rememberMe);
    Task<MfaChallengeTicket> CreateActionChallengeAsync(int userId, string action, bool riskTriggered);
    Task<MfaChallengeTicket?> GetChallengeAsync(string ticketId);
    Task ConsumeChallengeAsync(string ticketId);
    Task<bool> RecordFailureAsync(MfaChallengeTicket ticket, string clientIp, string? userAgent);
    Task<string> CreateProofTokenAsync(int userId, string action, TimeSpan ttl);
    Task<bool> ValidateAndConsumeProofTokenAsync(int userId, string action, string token);
}

public sealed class MfaChallengeService(IUnifiedCache cache, ILogger<MfaChallengeService> logger) : IMfaChallengeService
{
    private const uint TicketMagic = 0x41464D46; // FMFA
    private const byte TicketVersion = 1;
    private const int MaxTicketFailures = 5;
    private const int MaxUserWindowFailures = 10;
    private const int MaxIpWindowFailures = 25;

    public Task<MfaChallengeTicket> CreateLoginChallengeAsync(int userId, bool riskTriggered, bool rememberMe)
        => CreateAsync(userId, "login", "login", riskTriggered, rememberMe, TimeSpan.FromMinutes(5));

    public Task<MfaChallengeTicket> CreateActionChallengeAsync(int userId, string action, bool riskTriggered)
        => CreateAsync(userId, "action", action, riskTriggered, rememberMe: false, TimeSpan.FromMinutes(3));

    public async Task<MfaChallengeTicket?> GetChallengeAsync(string ticketId)
    {
        if (string.IsNullOrWhiteSpace(ticketId))
        {
            return null;
        }

        string? value = await cache.GetStringAsync(CachePolicyId.SecurityMfaChallenge, ticketId);
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return DecodeTicket(value);
    }

    public Task ConsumeChallengeAsync(string ticketId)
        => cache.RemoveAsync(CachePolicyId.SecurityMfaChallenge, ticketId);

    public async Task<bool> RecordFailureAsync(MfaChallengeTicket ticket, string clientIp, string? userAgent)
    {
        string ticketIdentity = $"fail:ticket:{ticket.TicketId}";
        string userIdentity = $"fail:user:{ticket.UserId}";
        string ipIdentity = $"fail:ip:{HashIdentity(clientIp)}";
        long ticketFailures = await cache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, ticketIdentity);
        long userFailures = await cache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, userIdentity);
        long ipFailures = await cache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, ipIdentity);

        bool locked = ticketFailures >= MaxTicketFailures ||
            userFailures >= MaxUserWindowFailures ||
            ipFailures >= MaxIpWindowFailures;

        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", locked ? "mfa_challenge_locked" : "mfa_challenge_failed"),
            new KeyValuePair<string, object?>("UserId", ticket.UserId),
            new KeyValuePair<string, object?>("TicketHash", HashIdentity(ticket.TicketId)),
            new KeyValuePair<string, object?>("ClientIpHash", HashIdentity(clientIp)),
            new KeyValuePair<string, object?>("UserAgentHash", HashIdentity(userAgent ?? string.Empty)),
            new KeyValuePair<string, object?>("TicketFailures", ticketFailures));
        logger.LogWarning(
            "MFA challenge verification failed. UserId={UserId} TicketHash={TicketHash} Locked={Locked}",
            ticket.UserId,
            HashIdentity(ticket.TicketId),
            locked);

        if (locked)
        {
            await ConsumeChallengeAsync(ticket.TicketId);
        }

        return locked;
    }

    public async Task<string> CreateProofTokenAsync(int userId, string action, TimeSpan ttl)
    {
        string token = Convert.ToHexString(Guid.NewGuid().ToByteArray());
        string identity = $"{userId}:{action}:{token}";
        await cache.SetStringAsync(CachePolicyId.SecurityMfaProof, identity, "1", ttl);
        return token;
    }

    public Task<bool> ValidateAndConsumeProofTokenAsync(int userId, string action, string token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return Task.FromResult(false);
        }

        string identity = $"{userId}:{action}:{token}";
        return cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, identity);
    }

    private async Task<MfaChallengeTicket> CreateAsync(
        int userId,
        string type,
        string action,
        bool riskTriggered,
        bool rememberMe,
        TimeSpan ttl)
    {
        string ticketId = Convert.ToHexString(Guid.NewGuid().ToByteArray());
        var ticket = new MfaChallengeTicket
        {
            TicketId = ticketId,
            UserId = userId,
            Type = type,
            Action = action,
            RememberMe = rememberMe,
            RiskTriggered = riskTriggered,
            CreatedAtUtc = DateTime.UtcNow
        };

        await cache.SetStringAsync(CachePolicyId.SecurityMfaChallenge, ticketId, EncodeTicket(ticket), ttl);
        return ticket;
    }

    private static string EncodeTicket(MfaChallengeTicket ticket)
    {
        byte[] ticketId = Encoding.UTF8.GetBytes(ticket.TicketId);
        byte[] type = Encoding.UTF8.GetBytes(ticket.Type);
        byte[] action = Encoding.UTF8.GetBytes(ticket.Action);
        int length = 4 + 1 + 4 + 1 + 1 + 8
            + 2 + ticketId.Length
            + 2 + type.Length
            + 2 + action.Length;
        byte[] bytes = new byte[length];
        Span<byte> span = bytes;
        BinaryPrimitives.WriteUInt32LittleEndian(span[..4], TicketMagic);
        span[4] = TicketVersion;
        BinaryPrimitives.WriteInt32LittleEndian(span[5..9], ticket.UserId);
        span[9] = ticket.RememberMe ? (byte)1 : (byte)0;
        span[10] = ticket.RiskTriggered ? (byte)1 : (byte)0;
        BinaryPrimitives.WriteInt64LittleEndian(span[11..19], ticket.CreatedAtUtc.ToUniversalTime().Ticks);
        int offset = 19;
        WriteString(bytes, ref offset, ticketId);
        WriteString(bytes, ref offset, type);
        WriteString(bytes, ref offset, action);
        return Base64UrlEncode(bytes);
    }

    private static MfaChallengeTicket? DecodeTicket(string value)
    {
        try
        {
            byte[] bytes = Base64UrlDecode(value);
            if (bytes.Length < 19 ||
                BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(0, 4)) != TicketMagic ||
                bytes[4] != TicketVersion)
            {
                return null;
            }

            int offset = 19;
            string ticketId = ReadString(bytes, ref offset);
            string type = ReadString(bytes, ref offset);
            string action = ReadString(bytes, ref offset);
            if (offset != bytes.Length || string.IsNullOrWhiteSpace(ticketId) || string.IsNullOrWhiteSpace(type))
            {
                return null;
            }

            return new MfaChallengeTicket
            {
                TicketId = ticketId,
                UserId = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(5, 4)),
                Type = type,
                Action = action,
                RememberMe = bytes[9] == 1,
                RiskTriggered = bytes[10] == 1,
                CreatedAtUtc = new DateTime(BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(11, 8)), DateTimeKind.Utc)
            };
        }
        catch (FormatException)
        {
            return null;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static void WriteString(byte[] target, ref int offset, byte[] value)
    {
        if (value.Length > ushort.MaxValue)
        {
            throw new InvalidOperationException("MFA ticket field too large.");
        }

        BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset, 2), (ushort)value.Length);
        offset += 2;
        value.CopyTo(target.AsSpan(offset));
        offset += value.Length;
    }

    private static string ReadString(byte[] source, ref int offset)
    {
        if (offset + 2 > source.Length)
        {
            throw new ArgumentException("MFA ticket truncated.");
        }

        int length = BinaryPrimitives.ReadUInt16LittleEndian(source.AsSpan(offset, 2));
        offset += 2;
        if (offset + length > source.Length)
        {
            throw new ArgumentException("MFA ticket string truncated.");
        }

        string value = Encoding.UTF8.GetString(source.AsSpan(offset, length));
        offset += length;
        return value;
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes)
        => Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private static string HashIdentity(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.Trim())))[..32];

    private static byte[] Base64UrlDecode(string value)
    {
        string normalized = value.Trim().Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(normalized);
    }
}
