using System.Buffers.Binary;
using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Security;

public sealed record class MfaChallengeTicket
{
    public required string TicketId { get; init; }
    public required int AccountId { get; init; }
    public required string AccountSubjectHash { get; init; }
    public required string Type { get; init; } // login | action
    public required string Action { get; init; }
    public bool RememberMe { get; init; }
    public bool RiskTriggered { get; init; }
    public DateTime CreatedAtUtc { get; init; } = DateTime.UtcNow;
}

public interface IMfaChallengeService
{
    Task<MfaChallengeTicket> CreateLoginChallengeAsync(int accountId, string accountSubjectHash, bool riskTriggered, bool rememberMe);
    Task<MfaChallengeTicket> CreateActionChallengeAsync(int accountId, string accountSubjectHash, string action, bool riskTriggered);
    Task<MfaChallengeTicket?> GetChallengeAsync(string ticketId);
    Task ConsumeChallengeAsync(string ticketId);
    Task<bool> RecordFailureAsync(MfaChallengeTicket ticket, string clientIp, string? userAgent);
    Task<string> CreateProofTokenAsync(int accountId, string action, TimeSpan ttl);
    Task<bool> ValidateAndConsumeProofTokenAsync(int accountId, string action, string token);
}

public sealed class MfaChallengeService(IUnifiedCache cache, ILogger<MfaChallengeService> logger) : IMfaChallengeService
{
    private const uint TicketMagic = 0x41464D46; // FMFA
    private const byte TicketVersion = 2;
    private const byte LegacyTicketVersion = 1;
    private const int MaxTicketFailures = 5;
    private const int MaxSubjectWindowFailures = 10;
    private const int MaxIpWindowFailures = 25;

    public Task<MfaChallengeTicket> CreateLoginChallengeAsync(int accountId, string accountSubjectHash, bool riskTriggered, bool rememberMe)
        => CreateAsync(accountId, accountSubjectHash, "login", "login", riskTriggered, rememberMe, TimeSpan.FromMinutes(5));

    public Task<MfaChallengeTicket> CreateActionChallengeAsync(int accountId, string accountSubjectHash, string action, bool riskTriggered)
        => CreateAsync(accountId, accountSubjectHash, "action", action, riskTriggered, rememberMe: false, TimeSpan.FromMinutes(3));

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
        string ticketHash = HashIdentity(ticket.TicketId);
        string clientIpHash = HashIdentity(clientIp);
        string userAgentHash = HashIdentity(userAgent ?? string.Empty);
        string accountSubjectHash = ResolveAccountSubjectHash(ticket.AccountId, ticket.AccountSubjectHash);
        string ticketIdentity = string.Concat("fail:ticket:", ticket.TicketId);
        string subjectIdentity = string.Concat("fail:subject:", accountSubjectHash);
        string ipIdentity = string.Concat("fail:ip:", clientIpHash);
        Task<long> ticketFailuresTask = cache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, ticketIdentity);
        Task<long> subjectFailuresTask = cache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, subjectIdentity);
        Task<long> ipFailuresTask = cache.IncrementAsync(CachePolicyId.SecurityMfaChallenge, ipIdentity);
        await Task.WhenAll(ticketFailuresTask, subjectFailuresTask, ipFailuresTask).ConfigureAwait(false);
        long ticketFailures = ticketFailuresTask.Result;
        long subjectFailures = subjectFailuresTask.Result;
        long ipFailures = ipFailuresTask.Result;

        bool locked = ticketFailures >= MaxTicketFailures ||
            subjectFailures >= MaxSubjectWindowFailures ||
            ipFailures >= MaxIpWindowFailures;

        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", locked ? "mfa_challenge_locked" : "mfa_challenge_failed"),
            new KeyValuePair<string, object?>("AccountId", ticket.AccountId),
            new KeyValuePair<string, object?>("AccountSubjectHash", accountSubjectHash),
            new KeyValuePair<string, object?>("TicketHash", ticketHash),
            new KeyValuePair<string, object?>("ClientIpHash", clientIpHash),
            new KeyValuePair<string, object?>("UserAgentHash", userAgentHash),
            new KeyValuePair<string, object?>("TicketFailures", ticketFailures));
        if (locked)
        {
            logger.LogWarning(
                "MFA challenge verification failed. AccountId={AccountId} TicketHash={TicketHash} Locked={Locked}",
                ticket.AccountId,
                ticketHash,
                locked);
        }
        else
        {
            logger.LogInformation(
                "MFA challenge verification failed. AccountId={AccountId} TicketHash={TicketHash} Locked={Locked}",
                ticket.AccountId,
                ticketHash,
                locked);
        }

        if (locked)
        {
            await ConsumeChallengeAsync(ticket.TicketId);
        }

        return locked;
    }

    public async Task<string> CreateProofTokenAsync(int accountId, string action, TimeSpan ttl)
    {
        string token = Convert.ToHexString(Guid.NewGuid().ToByteArray());
        string identity = $"{accountId}:{action}:{token}";
        await cache.SetStringAsync(CachePolicyId.SecurityMfaProof, identity, "1", ttl);
        return token;
    }

    public Task<bool> ValidateAndConsumeProofTokenAsync(int accountId, string action, string token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return Task.FromResult(false);
        }

        string identity = $"{accountId}:{action}:{token}";
        return cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, identity);
    }

    private async Task<MfaChallengeTicket> CreateAsync(
        int accountId,
        string accountSubjectHash,
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
            AccountId = accountId,
            AccountSubjectHash = ResolveAccountSubjectHash(accountId, accountSubjectHash),
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
        byte[] accountSubjectHash = Encoding.UTF8.GetBytes(ticket.AccountSubjectHash);
        byte[] type = Encoding.UTF8.GetBytes(ticket.Type);
        byte[] action = Encoding.UTF8.GetBytes(ticket.Action);
        int length = 4 + 1 + 4 + 1 + 1 + 8
            + 2 + ticketId.Length
            + 2 + type.Length
            + 2 + action.Length
            + 2 + accountSubjectHash.Length;
        byte[] bytes = new byte[length];
        Span<byte> span = bytes;
        BinaryPrimitives.WriteUInt32LittleEndian(span[..4], TicketMagic);
        span[4] = TicketVersion;
        BinaryPrimitives.WriteInt32LittleEndian(span[5..9], ticket.AccountId);
        span[9] = ticket.RememberMe ? (byte)1 : (byte)0;
        span[10] = ticket.RiskTriggered ? (byte)1 : (byte)0;
        BinaryPrimitives.WriteInt64LittleEndian(span[11..19], ticket.CreatedAtUtc.ToUniversalTime().Ticks);
        int offset = 19;
        WriteString(bytes, ref offset, ticketId);
        WriteString(bytes, ref offset, type);
        WriteString(bytes, ref offset, action);
        WriteString(bytes, ref offset, accountSubjectHash);
        return Base64UrlEncode(bytes);
    }

    private static MfaChallengeTicket? DecodeTicket(string value)
    {
        try
        {
            byte[] bytes = Base64UrlDecode(value);
            if (bytes.Length < 19 ||
                BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(0, 4)) != TicketMagic ||
                (bytes[4] != TicketVersion && bytes[4] != LegacyTicketVersion))
            {
                return null;
            }

            byte version = bytes[4];
            int accountId = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(5, 4));
            int offset = 19;
            string ticketId = ReadString(bytes, ref offset);
            string type = ReadString(bytes, ref offset);
            string action = ReadString(bytes, ref offset);
            string accountSubjectHash = version == TicketVersion
                ? ReadString(bytes, ref offset)
                : ResolveAccountSubjectHash(accountId, null);
            if (offset != bytes.Length || string.IsNullOrWhiteSpace(ticketId) || string.IsNullOrWhiteSpace(type))
            {
                return null;
            }

            return new MfaChallengeTicket
            {
                TicketId = ticketId,
                AccountId = accountId,
                AccountSubjectHash = accountSubjectHash,
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

    private static string ResolveAccountSubjectHash(int accountId, string? accountSubjectHash)
    {
        if (!string.IsNullOrWhiteSpace(accountSubjectHash))
        {
            return accountSubjectHash.Trim().ToLowerInvariant();
        }

        return AccountSubjectHasher.Create(
            AnonymousIdentityRuntime.AnonymousAccountKind,
            string.Concat("legacy-account:", accountId.ToString(CultureInfo.InvariantCulture)));
    }

    private static string HashIdentity(string value)
    {
        ReadOnlySpan<char> trimmed = value.AsSpan().Trim();
        if (trimmed.IsEmpty)
        {
            return string.Empty;
        }

        int byteCount = Encoding.UTF8.GetByteCount(trimmed);
        byte[]? rented = null;
        Span<byte> bytes = byteCount <= 256
            ? stackalloc byte[byteCount]
            : rented = ArrayPool<byte>.Shared.Rent(byteCount);

        try
        {
            int bytesWritten = Encoding.UTF8.GetBytes(trimmed, bytes);
            Span<byte> hash = stackalloc byte[32];
            SHA256.HashData(bytes[..bytesWritten], hash);
            return Convert.ToHexStringLower(hash[..16]);
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented);
            }
        }
    }

    private static byte[] Base64UrlDecode(string value)
    {
        string normalized = value.Trim().Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(normalized);
    }
}
