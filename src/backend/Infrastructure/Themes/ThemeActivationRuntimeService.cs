using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.Themes;

public interface IThemeActivationEffects
{
    Task PublishAsync(
        ThemeActivationHistorySnapshot transition,
        bool invalidateSharedAssets,
        CancellationToken cancellationToken);
}

public sealed record ThemeRuntimeStateSnapshot(
    long EventVersion,
    long AssetCacheVersion,
    Guid? LastTransitionId,
    string? LastScope,
    string? LastStatus,
    string? LastFailureReason,
    DateTimeOffset? LastTransitionAtUtc);

public sealed class ThemeRuntimeState
{
    private readonly object _gate = new();
    private ThemeRuntimeStateSnapshot _snapshot = new(0, 0, null, null, null, null, null);

    public ThemeRuntimeStateSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    public void Record(ThemeActivationHistorySnapshot transition, bool invalidateSharedAssets)
    {
        lock (_gate)
        {
            _snapshot = new ThemeRuntimeStateSnapshot(
                _snapshot.EventVersion + 1,
                invalidateSharedAssets
                    ? _snapshot.AssetCacheVersion + 1
                    : _snapshot.AssetCacheVersion,
                transition.Id,
                transition.Scope.Value,
                transition.Status.ToString(),
                transition.FailureReason,
                transition.CompletedAtUtc);
        }
    }
}

public sealed class ThemeActivationEffects(
    ThemeRuntimeState state,
    IHttpCacheInvalidator httpCacheInvalidator) : IThemeActivationEffects
{
    public async Task PublishAsync(
        ThemeActivationHistorySnapshot transition,
        bool invalidateSharedAssets,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        state.Record(transition, invalidateSharedAssets);
        if (invalidateSharedAssets)
        {
            await httpCacheInvalidator.InvalidateAsync(
                CacheTag.Theme,
                CacheTag.Aot,
                CacheTag.SystemPage).ConfigureAwait(false);
        }
    }
}

public sealed class NoOpThemeActivationEffects : IThemeActivationEffects
{
    public Task PublishAsync(
        ThemeActivationHistorySnapshot transition,
        bool invalidateSharedAssets,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }
}

public sealed class ThemeActivationRuntimeService(
    ThemePackageValidator packageValidator,
    IThemeRegistry registry,
    Version fsusBlogVersion,
    TimeProvider timeProvider,
    IThemePackageStore packageStore,
    IThemeActivationEffects? effects = null)
{
    private readonly IThemeActivationEffects _effects = effects ?? new NoOpThemeActivationEffects();

    public Task<ThemeActivationHistorySnapshot> PreviewAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        string activatedBy,
        CancellationToken cancellationToken)
    {
        if (!scope.Value.StartsWith("user-preview:", StringComparison.Ordinal))
        {
            throw new ThemeLifecycleException(
                "theme_preview_scope_invalid",
                "Theme preview requires an explicit user-preview scope.");
        }

        return ActivateCoreAsync(
            scope,
            themeId,
            mode,
            activatedBy,
            invalidateSharedAssets: false,
            cancellationToken);
    }

    public Task<ThemeActivationHistorySnapshot> ApplyAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        string activatedBy,
        CancellationToken cancellationToken)
    {
        if (scope.Value.StartsWith("user-preview:", StringComparison.Ordinal))
        {
            throw new ThemeLifecycleException(
                "theme_apply_scope_invalid",
                "Per-user preview scopes must use the preview operation.");
        }

        return ActivateCoreAsync(
            scope,
            themeId,
            mode,
            activatedBy,
            invalidateSharedAssets: true,
            cancellationToken);
    }

    public async Task<ThemeActivationHistorySnapshot> RollbackAsync(
        ThemeActivationScope scope,
        Guid activationId,
        string activatedBy,
        string reason,
        CancellationToken cancellationToken)
    {
        ThemeActivationHistorySnapshot transition = await registry.RollbackAsync(
            scope,
            activationId,
            activatedBy,
            reason,
            timeProvider.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
        await _effects.PublishAsync(
            transition,
            invalidateSharedAssets: !IsPreview(scope),
            cancellationToken).ConfigureAwait(false);
        return transition;
    }

    public async Task<ThemeActivationHistorySnapshot> ResetToDefaultAsync(
        ThemeActivationScope scope,
        string activatedBy,
        string reason,
        CancellationToken cancellationToken)
    {
        ThemeActivationHistorySnapshot transition = await registry.ResetToDefaultAsync(
            scope,
            activatedBy,
            reason,
            timeProvider.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
        await _effects.PublishAsync(
            transition,
            invalidateSharedAssets: !IsPreview(scope),
            cancellationToken).ConfigureAwait(false);
        return transition;
    }

    public async Task<ThemeActivationHistorySnapshot> ReportRuntimeCssLoadFailureAsync(
        ThemeRuntimeCssFailure failure,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(failure);
        if (string.IsNullOrWhiteSpace(failure.FailureCode)
            || string.IsNullOrWhiteSpace(failure.Detail)
            || failure.Detail.Length > 1000)
        {
            throw new ThemeLifecycleException(
                "theme_runtime_failure_invalid",
                "Runtime theme failure must include a bounded code and detail.");
        }

        ThemeActivationSnapshot current = await registry.GetActivationAsync(
            failure.Scope,
            cancellationToken).ConfigureAwait(false)
            ?? throw new ThemeLifecycleException(
                "theme_runtime_failure_stale",
                "Runtime theme failure does not match an active theme.");
        if (current.ActivationId != failure.ActivationId
            || !string.Equals(current.ActiveThemeId, failure.ThemeId, StringComparison.Ordinal)
            || !string.Equals(current.AssetVersion, failure.ContentHash, StringComparison.Ordinal))
        {
            throw new ThemeLifecycleException(
                "theme_runtime_failure_stale",
                "Runtime theme failure does not match the current activation version.");
        }

        string reason = $"{failure.FailureCode}: {failure.Detail}";
        return await RollbackAsync(
            failure.Scope,
            failure.ActivationId,
            failure.ReportedBy,
            reason,
            cancellationToken).ConfigureAwait(false);
    }

    public Task<IReadOnlyList<ThemeActivationHistorySnapshot>> GetHistoryAsync(
        ThemeActivationScope scope,
        int limit,
        CancellationToken cancellationToken)
        => registry.GetActivationHistoryAsync(scope, limit, cancellationToken);

    private async Task<ThemeActivationHistorySnapshot> ActivateCoreAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        string activatedBy,
        bool invalidateSharedAssets,
        CancellationToken cancellationToken)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        ThemeRegistrySnapshot theme;
        ValidatedThemePackage rescanned;
        try
        {
            theme = await registry.GetThemeAsync(themeId, cancellationToken).ConfigureAwait(false)
                ?? throw new ThemeLifecycleException(
                    "theme_not_installed",
                    $"Theme '{themeId}' is not installed.");
            await using Stream storedPackage = await packageStore.OpenReadAsync(
                theme.PackageLocation,
                cancellationToken).ConfigureAwait(false);
            rescanned = packageValidator.Validate(storedPackage, fsusBlogVersion);
            if (!string.Equals(rescanned.Manifest.Id, themeId, StringComparison.Ordinal)
                || !string.Equals(rescanned.PackageHash, theme.PackageHash, StringComparison.Ordinal))
            {
                throw new ThemeLifecycleException(
                    "theme_activation_package_mismatch",
                    $"Theme '{themeId}' package identity changed after installation.");
            }
        }
        catch (Exception exception) when (exception is ThemePackageException or ThemeLifecycleException)
        {
            string reason = exception is ThemePackageException packageException
                ? $"{packageException.ErrorCode}: {packageException.Message}"
                : $"{((ThemeLifecycleException)exception).ErrorCode}: {exception.Message}";
            await registry.RecordActivationFailureAsync(
                scope,
                themeId,
                activatedBy,
                reason,
                now,
                CancellationToken.None).ConfigureAwait(false);
            throw;
        }

        long? configVersion = await registry.GetConfigVersionAsync(
            themeId,
            cancellationToken).ConfigureAwait(false);
        ThemeActivationHistorySnapshot transition = await registry.ActivateAsync(
            scope,
            themeId,
            rescanned.PackageHash,
            configVersion,
            mode,
            activatedBy,
            now,
            cancellationToken).ConfigureAwait(false);
        try
        {
            await _effects.PublishAsync(
                transition,
                invalidateSharedAssets,
                cancellationToken).ConfigureAwait(false);
            return transition;
        }
        catch (Exception effectFailure)
        {
            string reason = $"theme_activation_publish_failed: {effectFailure.Message}";
            ThemeActivationHistorySnapshot rollback = await registry.RollbackAsync(
                scope,
                transition.Id,
                "system:auto-rollback",
                reason,
                timeProvider.GetUtcNow(),
                CancellationToken.None).ConfigureAwait(false);
            try
            {
                await _effects.PublishAsync(
                    rollback,
                    invalidateSharedAssets,
                    CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                // The registry rollback is authoritative. A failed secondary publication
                // remains visible in the persisted failure reason and must not re-activate.
            }

            throw new ThemeLifecycleException(
                "theme_activation_publish_failed",
                "Theme activation effects failed and the previous activation was restored.",
                effectFailure);
        }
    }

    private static bool IsPreview(ThemeActivationScope scope)
        => scope.Value.StartsWith("user-preview:", StringComparison.Ordinal);
}
