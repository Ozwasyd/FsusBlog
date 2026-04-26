using System.Text.Json;
using FsusBlog.Server.Infrastructure.Cache;

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
    Task<string> CreateProofTokenAsync(int userId, string action, TimeSpan ttl);
    Task<bool> ValidateAndConsumeProofTokenAsync(int userId, string action, string token);
}

public sealed class MfaChallengeService(IUnifiedCache cache) : IMfaChallengeService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

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

        return JsonSerializer.Deserialize<MfaChallengeTicket>(value, JsonOptions);
    }

    public Task ConsumeChallengeAsync(string ticketId)
        => cache.RemoveAsync(CachePolicyId.SecurityMfaChallenge, ticketId);

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

        string json = JsonSerializer.Serialize(ticket, JsonOptions);
        await cache.SetStringAsync(CachePolicyId.SecurityMfaChallenge, ticketId, json, ttl);
        return ticket;
    }
}
