using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Security;

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

public sealed class AuthRiskService(
    ISqlSugarClient db,
    IUserSessionMetadataProtector metadataProtector,
    IConfiguration configuration) : IAuthRiskService
{
    public async Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent)
    {
        var sessions = await db.Queryable<UserSession>()
            .Where(s => s.UserId == userId && s.RevokedAt == null)
            .OrderByDescending(s => s.LastSeenAt)
            .Take(20)
            .Select(s => new AuthRiskSessionSample
            {
                DeviceSignalHash = s.DeviceSignalHash,
                DeviceSignalEpoch = s.DeviceSignalEpoch,
                NetworkSignalHash = s.NetworkSignalHash,
                NetworkSignalEpoch = s.NetworkSignalEpoch,
                BrowserFamily = s.BrowserFamily,
                OperatingSystemFamily = s.OperatingSystemFamily,
                FormFactor = s.FormFactor,
                CreatedAt = s.CreatedAt
            })
            .ToListAsync();

        if (sessions.Count == 0)
        {
            return new RiskEvaluationResult(false, AuthRiskFlags.None, 0, "first_login");
        }

        int score = 0;
        AuthRiskFlags flags = AuthRiskFlags.None;

        bool metadataRiskSignalsEnabled = configuration.GetValue(
            UserSessionMetadataRetentionPolicy.RiskSignalsEnabledConfigurationKey,
            true);
        IReadOnlyList<SecurityRiskPseudonym> deviceSignals = metadataRiskSignalsEnabled
            ? metadataProtector.ProtectDeviceForRead(userId, deviceFingerprint)
            : [];
        bool knownDevice = deviceSignals.Count == 0 || sessions.Any(session =>
            deviceSignals.Any(signal =>
                signal.Epoch == session.DeviceSignalEpoch
                && string.Equals(signal.Hash, session.DeviceSignalHash, StringComparison.Ordinal)));
        if (deviceSignals.Count > 0 && !knownDevice)
        {
            score += 50;
            flags |= AuthRiskFlags.UnknownDevice;
        }

        IReadOnlyList<SecurityRiskPseudonym> networkSignals = metadataRiskSignalsEnabled
            ? metadataProtector.ProtectNetworkForRead(userId, clientIp)
            : [];
        bool knownNetwork = networkSignals.Count == 0 || sessions.Any(session =>
            networkSignals.Any(signal =>
                signal.Epoch == session.NetworkSignalEpoch
                && string.Equals(signal.Hash, session.NetworkSignalHash, StringComparison.Ordinal)));
        if (networkSignals.Count > 0 && !knownNetwork)
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

        if (metadataRiskSignalsEnabled && !string.IsNullOrWhiteSpace(userAgent))
        {
            UserSessionMetadataSnapshot coarse = metadataProtector.Capture(userId, null, null, userAgent);
            bool knownUa = sessions.Any(s =>
                string.Equals(s.BrowserFamily, coarse.BrowserFamily, StringComparison.Ordinal)
                && string.Equals(s.OperatingSystemFamily, coarse.OperatingSystemFamily, StringComparison.Ordinal)
                && string.Equals(s.FormFactor, coarse.FormFactor, StringComparison.Ordinal));
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
        if (action is "update-password" or "admin-sensitive")
        {
            return new RiskEvaluationResult(true, baseline.RiskFlags, Math.Max(60, baseline.Score), "sensitive_action_requires_mfa");
        }

        return baseline;
    }

    private sealed record AuthRiskSessionSample
    {
        public string? DeviceSignalHash
        {
            get; init;
        }
        public int? DeviceSignalEpoch
        {
            get; init;
        }
        public string? NetworkSignalHash
        {
            get; init;
        }
        public int? NetworkSignalEpoch
        {
            get; init;
        }
        public string BrowserFamily { get; init; } = "Unknown";
        public string OperatingSystemFamily { get; init; } = "Unknown";
        public string FormFactor
        {
            get; init;
        } = "Unknown";
        public DateTime CreatedAt
        {
            get; init;
        }
    }
}
