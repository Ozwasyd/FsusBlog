using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

[Flags]
public enum AuthRiskFlags
{
    None = 0,
    UnknownDevice = 1 << 0,
    UnknownIp = 1 << 1,
    RapidRefresh = 1 << 2
}

public readonly record struct RiskEvaluationResult(bool RequiresMfa, AuthRiskFlags RiskFlags, int Score, string ReasonCode);

public interface IAuthRiskService
{
    Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent);
    Task<RiskEvaluationResult> EvaluateSensitiveActionRiskAsync(int userId, string clientIp, string? deviceFingerprint, string action);
}

public sealed class AuthRiskService(ISqlSugarClient db) : IAuthRiskService
{
    public async Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent)
    {
        var sessions = await db.Queryable<UserSession>()
            .Where(s => s.UserId == userId && s.RevokedAt == null)
            .OrderByDescending(s => s.LastSeenAt)
            .Take(20)
            .Select(s => new AuthRiskSessionSample
            {
                DeviceFingerprint = s.DeviceFingerprint,
                LastIp = s.LastIp,
                UserAgent = s.UserAgent,
                CreatedAt = s.CreatedAt
            })
            .ToListAsync();

        if (sessions.Count == 0)
        {
            return new RiskEvaluationResult(false, AuthRiskFlags.None, 0, "first_login");
        }

        int score = 0;
        AuthRiskFlags flags = AuthRiskFlags.None;

        bool knownDevice = !string.IsNullOrWhiteSpace(deviceFingerprint)
            && sessions.Any(s => s.DeviceFingerprint == deviceFingerprint);
        if (!knownDevice)
        {
            score += 50;
            flags |= AuthRiskFlags.UnknownDevice;
        }

        bool knownIp = sessions.Any(s => string.Equals(s.LastIp, clientIp, StringComparison.Ordinal));
        if (!knownIp)
        {
            score += 40;
            flags |= AuthRiskFlags.UnknownIp;
        }

        DateTime recentSessionBoundary = DateTime.UtcNow.AddMinutes(-20);
        int recentNewSessions = sessions.Count(s => s.CreatedAt > recentSessionBoundary);
        if (recentNewSessions >= 4)
        {
            score += 30;
            flags |= AuthRiskFlags.RapidRefresh;
        }

        if (!string.IsNullOrWhiteSpace(userAgent))
        {
            bool knownUa = sessions.Any(s => string.Equals(s.UserAgent, userAgent, StringComparison.Ordinal));
            if (!knownUa)
            {
                score += 15;
            }
        }

        bool requiresMfa = score >= 60;
        string reason = requiresMfa ? "risk_threshold_exceeded" : "risk_low";
        return new RiskEvaluationResult(requiresMfa, flags, score, reason);
    }

    public async Task<RiskEvaluationResult> EvaluateSensitiveActionRiskAsync(int userId, string clientIp, string? deviceFingerprint, string action)
    {
        var baseline = await EvaluateLoginRiskAsync(userId, clientIp, deviceFingerprint, null);
        if (baseline.RequiresMfa)
        {
            return baseline;
        }

        // 敏感动作默认至少要求一次 MFA，只有近期已验证场景才放行（由上层逻辑处理短期 proof）
        if (action is "update-username" or "update-password" or "admin-sensitive")
        {
            return new RiskEvaluationResult(true, baseline.RiskFlags, Math.Max(60, baseline.Score), "sensitive_action_requires_mfa");
        }

        return baseline;
    }

    private sealed record AuthRiskSessionSample
    {
        public string? DeviceFingerprint { get; init; }
        public string? LastIp { get; init; }
        public string? UserAgent { get; init; }
        public DateTime CreatedAt { get; init; }
    }
}
