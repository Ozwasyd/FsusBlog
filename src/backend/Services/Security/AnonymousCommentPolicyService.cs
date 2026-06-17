using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.CommentIdentity;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCommentPolicyService
{
    AnonymousCommentPolicySnapshot Current { get; }

    AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null);

    CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected);
}

public sealed class AnonymousCommentPolicyService(
    IConfiguration configuration,
    IServiceScopeFactory? scopeFactory = null,
    ILogger<AnonymousCommentPolicyService>? logger = null) : IAnonymousCommentPolicyService
{
    private readonly object _gate = new();
    private AnonymousCommentPolicySnapshot? _current;

    public AnonymousCommentPolicySnapshot Current
    {
        get
        {
            lock (_gate)
            {
                return _current ??= LoadPersistedPolicy() ?? BuildInitialPolicy();
            }
        }
    }

    public AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null)
    {
        lock (_gate)
        {
            AnonymousCommentPolicySnapshot current = Current;
            AnonymousCommentPolicySnapshot next = BuildRuntimeSnapshot(
                new AnonymousCommentPolicySnapshot(
                request.AnonymousCommentsEnabled ?? current.AnonymousCommentsEnabled,
                request.PublicCommentsEnabled ?? current.PublicCommentsEnabled,
                request.ZkAnonymousEnabled ?? current.ZkAnonymousEnabled,
                NormalizeAuthorMode(request.DefaultAuthorMode, current.DefaultAuthorMode),
                NormalizeLanguages(request.SupportedDisplayLanguages, current.SupportedDisplayLanguages)),
                ChangedBy(adminPrincipalId),
                NormalizeNullable(request.Reason, 256),
                DateTime.UtcNow);
            PersistPolicy(next, adminPrincipalId);
            _current = next;
            InvalidatePolicyCache();
            return _current;
        }
    }

    public CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected)
    {
        AnonymousCommentPolicySnapshot policy = Current;
        string mode = NormalizeAuthorMode(requestedAuthorMode, policy.DefaultAuthorMode);
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            if (!publicSendExplicitlySelected)
            {
                return CommentAuthorModeDecision.Reject(mode, "public_opt_in_required", "Public author mode requires explicit opt-in");
            }

            return policy.PublicCommentsEnabled
                ? CommentAuthorModeDecision.Allow(mode)
                : CommentAuthorModeDecision.Reject(mode, "public_comments_disabled", "Public comments are disabled");
        }

        if (string.Equals(mode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal))
        {
            if (!policy.AnonymousCommentsEnabled)
            {
                return CommentAuthorModeDecision.Reject(mode, "anonymous_comments_disabled", "Anonymous comments are disabled");
            }

            return policy.ZkAnonymousEnabled
                ? CommentAuthorModeDecision.Allow(mode)
                : CommentAuthorModeDecision.Reject(mode, "zk_anonymous_disabled", "ZK anonymous comments are disabled");
        }

        if (IsAnonymousMode(mode) && !policy.AnonymousCommentsEnabled)
        {
            return CommentAuthorModeDecision.Reject(mode, "anonymous_comments_disabled", "Anonymous comments are disabled");
        }

        return CommentAuthorModeDecision.Allow(mode);
    }

    private AnonymousCommentPolicySnapshot BuildInitialPolicy()
        => BuildRuntimeSnapshot(new AnonymousCommentPolicySnapshot(
            configuration.GetValue("AnonymousIdentity:AnonymousCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:PublicCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false),
            NormalizeAuthorMode(configuration["AnonymousIdentity:DefaultAuthorMode"], CommentAuthorModes.Anonymous),
            NormalizeLanguages(
                configuration.GetSection("AnonymousIdentity:SupportedDisplayLanguages").Get<string[]>(),
                AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)),
            "configuration",
            "bootstrap_fallback",
            DateTime.UtcNow);

    private AnonymousCommentPolicySnapshot? LoadPersistedPolicy()
    {
        if (scopeFactory is null)
        {
            return null;
        }

        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            AnonymousCommentPolicy? entity = db.Queryable<AnonymousCommentPolicy>()
                .Where(static item => item.Id == 1)
                .FirstAsync()
                .GetAwaiter()
                .GetResult();
            return entity is null ? null : FromEntity(entity);
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "匿名评论策略持久化快照加载失败，回退配置文件");
            return null;
        }
    }

    private void PersistPolicy(AnonymousCommentPolicySnapshot snapshot, long? adminPrincipalId)
    {
        if (scopeFactory is null)
        {
            return;
        }

        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            AnonymousCommentPolicy entity = ToEntity(snapshot, adminPrincipalId);
            AnonymousCommentPolicy? existing = db.Queryable<AnonymousCommentPolicy>()
                .Where(static item => item.Id == 1)
                .FirstAsync()
                .GetAwaiter()
                .GetResult();
            if (existing is null)
            {
                db.Insertable(entity).ExecuteCommandAsync().GetAwaiter().GetResult();
            }
            else
            {
                db.Updateable(entity).ExecuteCommandAsync().GetAwaiter().GetResult();
            }
        }
        catch (Exception ex)
        {
            logger?.LogError(ex, "匿名评论策略持久化快照写入失败 | SnapshotHash: {SnapshotHash}", snapshot.SnapshotHash);
            throw new InvalidOperationException("匿名评论策略持久化快照写入失败", ex);
        }
    }

    private void InvalidatePolicyCache()
    {
        if (scopeFactory is null)
        {
            return;
        }

        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            scope.ServiceProvider.GetService<ICacheInvalidationDispatcher>()
                ?.InvalidateCommentPolicyAsync()
                .GetAwaiter()
                .GetResult();
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "匿名评论策略缓存失效广播失败");
        }
    }

    private static AnonymousCommentPolicySnapshot FromEntity(AnonymousCommentPolicy entity)
        => BuildRuntimeSnapshot(
            new AnonymousCommentPolicySnapshot(
                entity.AnonymousCommentsEnabled,
                entity.PublicCommentsEnabled,
                entity.ZkAnonymousEnabled,
                NormalizeAuthorMode(entity.DefaultAuthorMode, CommentAuthorModes.Anonymous),
                NormalizeLanguages(
                    entity.SupportedDisplayLanguages.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                    AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)),
            string.IsNullOrWhiteSpace(entity.ChangedBy) ? "database" : entity.ChangedBy,
            NormalizeNullable(entity.UpdatedReason, 256),
            entity.UpdatedAtUtc == default ? DateTime.UtcNow : entity.UpdatedAtUtc,
            NormalizeNullable(entity.SnapshotHash, 64));

    private static AnonymousCommentPolicy ToEntity(AnonymousCommentPolicySnapshot snapshot, long? adminPrincipalId)
        => new()
        {
            Id = 1,
            AnonymousCommentsEnabled = snapshot.AnonymousCommentsEnabled,
            PublicCommentsEnabled = snapshot.PublicCommentsEnabled,
            ZkAnonymousEnabled = snapshot.ZkAnonymousEnabled,
            DefaultAuthorMode = NormalizeAuthorMode(snapshot.DefaultAuthorMode, CommentAuthorModes.Anonymous),
            SupportedDisplayLanguages = string.Join(',', NormalizeLanguages(snapshot.SupportedDisplayLanguages, AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)),
            SnapshotHash = snapshot.SnapshotHash,
            UpdatedReason = snapshot.Reason,
            ChangedBy = NormalizeChangedBy(snapshot.ChangedBy),
            UpdatedAtUtc = snapshot.UpdatedAtUtc,
            UpdatedByAdminId = adminPrincipalId
        };

    private static AnonymousCommentPolicySnapshot BuildRuntimeSnapshot(
        AnonymousCommentPolicySnapshot snapshot,
        string changedBy,
        string? reason,
        DateTime updatedAtUtc,
        string? persistedHash = null)
    {
        AnonymousCommentPolicySnapshot prepared = snapshot with
        {
            ChangedBy = NormalizeChangedBy(changedBy),
            Reason = reason,
            UpdatedAtUtc = updatedAtUtc,
            SnapshotHash = string.Empty
        };
        string hash = string.IsNullOrWhiteSpace(persistedHash)
            ? ComputeSnapshotHash(prepared)
            : persistedHash.Trim();
        return prepared with { SnapshotHash = hash };
    }

    private static string ComputeSnapshotHash(AnonymousCommentPolicySnapshot snapshot)
    {
        string payload = string.Join('|',
            snapshot.AnonymousCommentsEnabled ? "1" : "0",
            snapshot.PublicCommentsEnabled ? "1" : "0",
            snapshot.ZkAnonymousEnabled ? "1" : "0",
            NormalizeAuthorMode(snapshot.DefaultAuthorMode, CommentAuthorModes.Anonymous),
            string.Join(',', NormalizeLanguages(snapshot.SupportedDisplayLanguages, AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();
    }

    private static string NormalizeAuthorMode(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        return normalized is CommentAuthorModes.Anonymous or
            CommentAuthorModes.Pseudonymous or
            CommentAuthorModes.Public or
            CommentAuthorModes.ZkAnonymous
            ? normalized
            : fallback;
    }

    private static IReadOnlyList<string> NormalizeLanguages(IReadOnlyList<string>? values, IReadOnlyList<string> fallback)
    {
        string[] normalized = (values ?? [])
            .Select(static value => value.Trim())
            .Where(static value => string.Equals(value, "zh-CN", StringComparison.Ordinal) || string.Equals(value, "en", StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return normalized.Length > 0 ? normalized : fallback;
    }

    private static bool IsAnonymousMode(string mode)
        => string.Equals(mode, CommentAuthorModes.Anonymous, StringComparison.Ordinal) ||
            string.Equals(mode, CommentAuthorModes.Pseudonymous, StringComparison.Ordinal);

    private static string ChangedBy(long? adminPrincipalId)
        => adminPrincipalId.HasValue
            ? $"admin:{adminPrincipalId.Value.ToString(CultureInfo.InvariantCulture)}"
            : "system";

    private static string NormalizeChangedBy(string? value)
    {
        string normalized = (value ?? "system").Trim();
        return string.IsNullOrWhiteSpace(normalized)
            ? "system"
            : normalized.Length <= 64 ? normalized : normalized[..64];
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }
}
