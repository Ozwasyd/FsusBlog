using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCommentPolicyService
{
    AnonymousCommentPolicySnapshot Current
    {
        get;
    }

    Task<AnonymousCommentPolicySnapshot> GetCurrentAsync(CancellationToken cancellationToken = default);

    AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null);

    Task<AnonymousCommentPolicySnapshot> UpdatePolicyAsync(
        AnonymousCommentPolicyUpdateRequest request,
        long? adminPrincipalId = null,
        CancellationToken cancellationToken = default);

    CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected);

    Task<CommentAuthorModeDecision> EvaluateAuthorModeAsync(
        string? requestedAuthorMode,
        bool publicSendExplicitlySelected,
        CancellationToken cancellationToken = default);
}

public interface IAnonymousCommentPolicyInvalidationSink
{
    void InvalidateLocalSnapshot();
}

public sealed class AnonymousCommentPolicyService(
    IConfiguration configuration,
    IServiceScopeFactory? scopeFactory = null,
    ILogger<AnonymousCommentPolicyService>? logger = null) : IAnonymousCommentPolicyService, IAnonymousCommentPolicyInvalidationSink
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private AnonymousCommentPolicySnapshot? _current;

    public AnonymousCommentPolicySnapshot Current
    {
        get
        {
            AnonymousCommentPolicySnapshot? current = _current;
            if (current is not null)
            {
                return current;
            }

            AnonymousCommentPolicySnapshot initial = BuildInitialPolicy();
            if (scopeFactory is null)
            {
                _current = initial;
            }

            return initial;
        }
    }

    public AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null)
    {
        if (scopeFactory is not null)
        {
            throw new InvalidOperationException("anonymous_comment_policy_async_required");
        }

        AnonymousCommentPolicySnapshot next = BuildNextPolicy(Current, request, adminPrincipalId);
        _current = next;
        return next;
    }

    public void InvalidateLocalSnapshot()
    {
        _current = null;
    }

    public CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected)
        => EvaluateAuthorMode(Current, requestedAuthorMode, publicSendExplicitlySelected);

    public async Task<AnonymousCommentPolicySnapshot> GetCurrentAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await LoadCurrentUnsafeAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<AnonymousCommentPolicySnapshot> UpdatePolicyAsync(
        AnonymousCommentPolicyUpdateRequest request,
        long? adminPrincipalId = null,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            AnonymousCommentPolicySnapshot current = await LoadCurrentUnsafeAsync(cancellationToken);
            AnonymousCommentPolicySnapshot next = BuildNextPolicy(current, request, adminPrincipalId);
            await PersistPolicyAsync(next, adminPrincipalId, cancellationToken);
            _current = next;
            await InvalidatePolicyCacheAsync(cancellationToken);
            return _current;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CommentAuthorModeDecision> EvaluateAuthorModeAsync(
        string? requestedAuthorMode,
        bool publicSendExplicitlySelected,
        CancellationToken cancellationToken = default)
        => EvaluateAuthorMode(await GetCurrentAsync(cancellationToken), requestedAuthorMode, publicSendExplicitlySelected);

    private async Task<AnonymousCommentPolicySnapshot> LoadCurrentUnsafeAsync(CancellationToken cancellationToken)
    {
        if (scopeFactory is not null)
        {
            AnonymousCommentPolicySnapshot? persisted = await LoadPersistedPolicyAsync(cancellationToken);
            if (persisted is not null)
            {
                _current = persisted;
                return persisted;
            }
        }

        return _current ??= BuildInitialPolicy();
    }

    private static AnonymousCommentPolicySnapshot BuildNextPolicy(
        AnonymousCommentPolicySnapshot current,
        AnonymousCommentPolicyUpdateRequest request,
        long? adminPrincipalId)
    {
        string defaultAuthorMode = current.DefaultAuthorMode;
        if (request.DefaultAuthorMode is not null && IsRetiredAnonymousMode(request.DefaultAuthorMode))
        {
            throw new ArgumentException("anonymous_author_mode_retired", nameof(request.DefaultAuthorMode));
        }

        if (request.DefaultAuthorMode is not null && !TryNormalizeAuthorMode(request.DefaultAuthorMode, out defaultAuthorMode))
        {
            throw new ArgumentException("author_mode_invalid", nameof(request.DefaultAuthorMode));
        }

        return BuildRuntimeSnapshot(
            new AnonymousCommentPolicySnapshot(
            request.AnonymousCommentsEnabled ?? current.AnonymousCommentsEnabled,
            request.PublicCommentsEnabled ?? current.PublicCommentsEnabled,
            request.ZkAnonymousEnabled ?? current.ZkAnonymousEnabled,
            defaultAuthorMode,
            NormalizeLanguages(request.SupportedDisplayLanguages, current.SupportedDisplayLanguages),
            ResolveRequestedCommentMaxChars(request.CommentMaxChars, current.CommentMaxChars),
            ResolveRequestedCommentMaxUtf8Bytes(request.CommentMaxUtf8Bytes, current.CommentMaxUtf8Bytes)),
            ChangedBy(adminPrincipalId),
            TextHelpers.NormalizeNullable(request.Reason, 256),
            DateTime.UtcNow);
    }

    public static CommentAuthorModeDecision EvaluateAuthorMode(
        AnonymousCommentPolicySnapshot policy,
        string? requestedAuthorMode,
        bool publicSendExplicitlySelected)
    {
        string mode;
        if (string.IsNullOrWhiteSpace(requestedAuthorMode))
        {
            mode = NormalizeAuthorMode(policy.DefaultAuthorMode, CommentAuthorModes.ZkAnonymous);
        }
        else if (IsRetiredAnonymousMode(requestedAuthorMode))
        {
            return CommentAuthorModeDecision.Reject(
                CommentAuthorModes.RetiredAnonymous,
                "anonymous_author_mode_retired",
                "The server-visible anonymous author mode is retired");
        }
        else if (!TryNormalizeAuthorMode(requestedAuthorMode, out mode))
        {
            return CommentAuthorModeDecision.Reject("invalid", "author_mode_invalid", "Author mode is invalid");
        }

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

        return CommentAuthorModeDecision.Reject(mode, "author_mode_invalid", "Author mode is invalid");
    }

    private AnonymousCommentPolicySnapshot BuildInitialPolicy()
        => BuildRuntimeSnapshot(new AnonymousCommentPolicySnapshot(
            configuration.GetValue("AnonymousIdentity:AnonymousCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:PublicCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false),
            NormalizeAuthorMode(configuration["AnonymousIdentity:DefaultAuthorMode"], CommentAuthorModes.ZkAnonymous),
            NormalizeLanguages(
                configuration.GetSection("AnonymousIdentity:SupportedDisplayLanguages").Get<string[]>(),
                AnonymousCommentPolicySnapshot.DefaultDisplayLanguages),
            CommentLimits.NormalizeMaxChars(configuration.GetValue<int?>("AnonymousIdentity:CommentMaxChars")),
            CommentLimits.NormalizeMaxUtf8Bytes(configuration.GetValue<int?>("AnonymousIdentity:CommentMaxUtf8Bytes"))),
            "configuration",
            "bootstrap_fallback",
            DateTime.UtcNow);

    private async Task<AnonymousCommentPolicySnapshot?> LoadPersistedPolicyAsync(CancellationToken cancellationToken)
    {
        if (scopeFactory is null)
        {
            return null;
        }

        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            AnonymousCommentPolicy? entity = await db.Queryable<AnonymousCommentPolicy>()
                .Where(static item => item.Id == 1)
                .FirstAsync(cancellationToken);
            return entity is null ? null : FromEntity(entity);
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "匿名评论策略持久化快照加载失败，回退配置文件");
            _current = null;
            return null;
        }
    }

    private async Task PersistPolicyAsync(
        AnonymousCommentPolicySnapshot snapshot,
        long? adminPrincipalId,
        CancellationToken cancellationToken)
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
            AnonymousCommentPolicy? existing = await db.Queryable<AnonymousCommentPolicy>()
                .Where(static item => item.Id == 1)
                .FirstAsync(cancellationToken);
            if (existing is null)
            {
                await db.Insertable(entity).ExecuteCommandAsync(cancellationToken);
            }
            else
            {
                await db.Updateable(entity).ExecuteCommandAsync(cancellationToken);
            }
        }
        catch (Exception ex)
        {
            logger?.LogError(ex, "匿名评论策略持久化快照写入失败 | SnapshotHash: {SnapshotHash}", snapshot.SnapshotHash);
            throw new InvalidOperationException("匿名评论策略持久化快照写入失败", ex);
        }
    }

    private async Task InvalidatePolicyCacheAsync(CancellationToken cancellationToken)
    {
        if (scopeFactory is null)
        {
            return;
        }

        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            ICacheInvalidationDispatcher? dispatcher = scope.ServiceProvider.GetService<ICacheInvalidationDispatcher>();
            if (dispatcher is not null)
            {
                await dispatcher.InvalidateCommentPolicyAsync(cancellationToken);
            }
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
                NormalizeAuthorMode(entity.DefaultAuthorMode, CommentAuthorModes.ZkAnonymous),
                NormalizeLanguages(
                    entity.SupportedDisplayLanguages.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                    AnonymousCommentPolicySnapshot.DefaultDisplayLanguages),
                CommentLimits.NormalizeMaxChars(entity.CommentMaxChars),
                CommentLimits.NormalizeMaxUtf8Bytes(entity.CommentMaxUtf8Bytes)),
            string.IsNullOrWhiteSpace(entity.ChangedBy) ? "database" : entity.ChangedBy,
            TextHelpers.NormalizeNullable(entity.UpdatedReason, 256),
            entity.UpdatedAtUtc == default ? DateTime.UtcNow : entity.UpdatedAtUtc,
            TextHelpers.NormalizeNullable(entity.SnapshotHash, 64));

    private static AnonymousCommentPolicy ToEntity(AnonymousCommentPolicySnapshot snapshot, long? adminPrincipalId)
        => new()
        {
            Id = 1,
            AnonymousCommentsEnabled = snapshot.AnonymousCommentsEnabled,
            PublicCommentsEnabled = snapshot.PublicCommentsEnabled,
            ZkAnonymousEnabled = snapshot.ZkAnonymousEnabled,
            DefaultAuthorMode = NormalizeAuthorMode(snapshot.DefaultAuthorMode, CommentAuthorModes.ZkAnonymous),
            SupportedDisplayLanguages = string.Join(',', NormalizeLanguages(snapshot.SupportedDisplayLanguages, AnonymousCommentPolicySnapshot.DefaultDisplayLanguages)),
            CommentMaxChars = CommentLimits.NormalizeMaxChars(snapshot.CommentMaxChars),
            CommentMaxUtf8Bytes = CommentLimits.NormalizeMaxUtf8Bytes(snapshot.CommentMaxUtf8Bytes),
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
        string hash = AnonymousCommentPolicySnapshotHash.NormalizeHash(persistedHash);
        if (hash.Length == 0)
        {
            hash = AnonymousCommentPolicySnapshotHash.Compute(prepared);
        }

        return prepared with
        {
            SnapshotHash = hash
        };
    }

    private static string NormalizeAuthorMode(string? value, string fallback)
    {
        return TryNormalizeAuthorMode(value, out string normalized) ? normalized : fallback;
    }

    private static bool TryNormalizeAuthorMode(string? value, out string normalized)
    {
        normalized = TextHelpers.NormalizeModeToken(value) ?? string.Empty;
        return normalized is CommentAuthorModes.Public or
            CommentAuthorModes.ZkAnonymous;
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

    private static int ResolveRequestedCommentMaxChars(int? requested, int current)
    {
        if (!requested.HasValue)
        {
            return CommentLimits.NormalizeMaxChars(current);
        }

        CommentLimits.ValidateMaxChars(requested.Value);
        return requested.Value;
    }

    private static int ResolveRequestedCommentMaxUtf8Bytes(int? requested, int current)
    {
        if (!requested.HasValue)
        {
            return CommentLimits.NormalizeMaxUtf8Bytes(current);
        }

        CommentLimits.ValidateMaxUtf8Bytes(requested.Value);
        return requested.Value;
    }

    private static bool IsRetiredAnonymousMode(string? mode)
    {
        string normalized = TextHelpers.NormalizeModeToken(mode) ?? string.Empty;
        return normalized is CommentAuthorModes.RetiredAnonymous or CommentAuthorModes.LegacyServerVisiblePseudonymous;
    }

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

}
