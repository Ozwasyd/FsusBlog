using System.Data;
using System.Text.Json;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Themes;

public sealed partial class InMemoryThemeRegistry
{
    private readonly List<ThemeActivationHistorySnapshot> _activationHistory = [];

    public async Task<long?> GetConfigVersionAsync(
        string themeId,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return _configs.TryGetValue(themeId, out (string ConfigJson, long Version) config)
                ? config.Version
                : null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ThemeActivationHistorySnapshot> ActivateAsync(
        ThemeActivationScope scope,
        string themeId,
        string assetVersion,
        long? configVersion,
        string mode,
        string activatedBy,
        DateTimeOffset activatedAtUtc,
        CancellationToken cancellationToken)
    {
        ValidateMutationInput(assetVersion, mode, activatedBy);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThemeRegistrySnapshot target = GetInstallableTheme(themeId);
            ThemeActivationSnapshot? previous = _activations.GetValueOrDefault(scope);
            var activationId = Guid.NewGuid();
            _activations[scope] = new ThemeActivationSnapshot(
                scope,
                themeId,
                mode,
                activatedAtUtc,
                activationId,
                assetVersion,
                configVersion);
            _themes[themeId] = target with
            {
                InstallState = ThemeInstallState.Enabled,
                Enabled = true,
                UpdatedAtUtc = activatedAtUtc
            };
            if (previous is not null
                && !string.Equals(previous.ActiveThemeId, themeId, StringComparison.Ordinal))
            {
                RecalculateEnabledState(previous.ActiveThemeId, activatedAtUtc);
            }

            ThemeActivationHistorySnapshot history = CreateHistory(
                activationId,
                scope,
                themeId,
                previous?.ActiveThemeId,
                assetVersion,
                previous?.AssetVersion,
                configVersion,
                previous?.ConfigVersion,
                mode,
                previous?.Mode,
                ThemeActivationStatus.Applied,
                activatedAtUtc,
                failureReason: null,
                activatedBy);
            _activationHistory.Add(history);
            return history;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ThemeActivationHistorySnapshot> RollbackAsync(
        ThemeActivationScope scope,
        Guid expectedActivationId,
        string activatedBy,
        string failureReason,
        DateTimeOffset rolledBackAtUtc,
        CancellationToken cancellationToken)
    {
        ValidateActorAndReason(activatedBy, failureReason);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThemeActivationSnapshot current = _activations.GetValueOrDefault(scope)
                ?? throw new ThemeLifecycleException(
                    "theme_rollback_activation_missing",
                    $"Theme scope '{scope}' has no active theme to roll back.");
            if (current.ActivationId != expectedActivationId)
            {
                throw new ThemeLifecycleException(
                    "theme_rollback_activation_conflict",
                    "Theme activation changed before rollback could be applied.");
            }

            int sourceIndex = _activationHistory.FindIndex(item => item.Id == expectedActivationId);
            if (sourceIndex < 0)
            {
                throw new ThemeLifecycleException(
                    "theme_rollback_history_missing",
                    "Theme activation history required for rollback is missing.");
            }

            ThemeActivationHistorySnapshot source = _activationHistory[sourceIndex];
            var rollbackId = Guid.NewGuid();
            if (source.PreviousThemeId is null)
            {
                _activations.Remove(scope);
            }
            else
            {
                _ = GetInstallableTheme(source.PreviousThemeId);
                _activations[scope] = new ThemeActivationSnapshot(
                    scope,
                    source.PreviousThemeId,
                    source.PreviousMode ?? "auto",
                    rolledBackAtUtc,
                    rollbackId,
                    source.PreviousAssetVersion,
                    source.PreviousConfigVersion);
                ThemeRegistrySnapshot restored = _themes[source.PreviousThemeId];
                _themes[source.PreviousThemeId] = restored with
                {
                    InstallState = ThemeInstallState.Enabled,
                    Enabled = true,
                    UpdatedAtUtc = rolledBackAtUtc
                };
            }

            RecalculateEnabledState(current.ActiveThemeId, rolledBackAtUtc);
            _activationHistory[sourceIndex] = WithStatus(
                source,
                ThemeActivationStatus.RolledBack,
                rolledBackAtUtc,
                failureReason);
            ThemeActivationHistorySnapshot rollback = CreateHistory(
                rollbackId,
                scope,
                source.PreviousThemeId,
                current.ActiveThemeId,
                source.PreviousAssetVersion,
                current.AssetVersion,
                source.PreviousConfigVersion,
                current.ConfigVersion,
                source.PreviousMode,
                current.Mode,
                ThemeActivationStatus.RolledBack,
                rolledBackAtUtc,
                failureReason,
                activatedBy);
            _activationHistory.Add(rollback);
            return rollback;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ThemeActivationHistorySnapshot> ResetToDefaultAsync(
        ThemeActivationScope scope,
        string activatedBy,
        string reason,
        DateTimeOffset resetAtUtc,
        CancellationToken cancellationToken)
    {
        ValidateActorAndReason(activatedBy, reason);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _activations.Remove(scope, out ThemeActivationSnapshot? previous);
            if (previous is not null)
            {
                RecalculateEnabledState(previous.ActiveThemeId, resetAtUtc);
            }

            ThemeActivationHistorySnapshot history = CreateHistory(
                Guid.NewGuid(),
                scope,
                themeId: null,
                previous?.ActiveThemeId,
                assetVersion: null,
                previous?.AssetVersion,
                configVersion: null,
                previous?.ConfigVersion,
                mode: null,
                previous?.Mode,
                ThemeActivationStatus.ResetToDefault,
                resetAtUtc,
                reason,
                activatedBy);
            _activationHistory.Add(history);
            return history;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ThemeActivationHistorySnapshot> RecordActivationFailureAsync(
        ThemeActivationScope scope,
        string? themeId,
        string activatedBy,
        string failureReason,
        DateTimeOffset failedAtUtc,
        CancellationToken cancellationToken)
    {
        ValidateActorAndReason(activatedBy, failureReason);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThemeActivationSnapshot? current = _activations.GetValueOrDefault(scope);
            ThemeActivationHistorySnapshot history = CreateHistory(
                Guid.NewGuid(),
                scope,
                themeId,
                current?.ActiveThemeId,
                assetVersion: null,
                current?.AssetVersion,
                configVersion: null,
                current?.ConfigVersion,
                mode: null,
                current?.Mode,
                ThemeActivationStatus.Rejected,
                failedAtUtc,
                failureReason,
                activatedBy);
            _activationHistory.Add(history);
            return history;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<IReadOnlyList<ThemeActivationHistorySnapshot>> GetActivationHistoryAsync(
        ThemeActivationScope scope,
        int limit,
        CancellationToken cancellationToken)
    {
        ValidateHistoryLimit(limit);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return _activationHistory
                .Where(item => item.Scope == scope)
                .OrderByDescending(static item => item.StartedAtUtc)
                .ThenByDescending(static item => item.Id)
                .Take(limit)
                .ToArray();
        }
        finally
        {
            _gate.Release();
        }
    }

    internal static void ValidateMutationInput(string assetVersion, string mode, string activatedBy)
    {
        if (!IsSha256(assetVersion))
        {
            throw new ThemeLifecycleException(
                "theme_activation_asset_version_invalid",
                "Theme activation asset version must be a lowercase SHA-256 digest.");
        }
        if (mode is not ("auto" or "light" or "dark"))
        {
            throw new ThemeLifecycleException(
                "theme_activation_mode_invalid",
                "Theme activation mode must be auto, light, or dark.");
        }

        ValidateActor(activatedBy);
    }

    internal static void ValidateActorAndReason(string activatedBy, string reason)
    {
        ValidateActor(activatedBy);
        if (string.IsNullOrWhiteSpace(reason) || reason.Length > 1000)
        {
            throw new ThemeLifecycleException(
                "theme_activation_reason_invalid",
                "Theme activation reason must contain 1 to 1000 characters.");
        }
    }

    private static void ValidateActor(string activatedBy)
    {
        if (string.IsNullOrWhiteSpace(activatedBy) || activatedBy.Length > 160)
        {
            throw new ThemeLifecycleException(
                "theme_activation_actor_invalid",
                "Theme activation actor must contain 1 to 160 characters.");
        }
    }

    internal static void ValidateHistoryLimit(int limit)
    {
        if (limit is < 1 or > 200)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), "History limit must be between 1 and 200.");
        }
    }

    private static bool IsSha256(string value)
        => value.Length == 64
            && value.All(static character =>
                character is >= '0' and <= '9'
                or >= 'a' and <= 'f');

    internal static ThemeActivationHistorySnapshot CreateHistory(
        Guid id,
        ThemeActivationScope scope,
        string? themeId,
        string? previousThemeId,
        string? assetVersion,
        string? previousAssetVersion,
        long? configVersion,
        long? previousConfigVersion,
        string? mode,
        string? previousMode,
        ThemeActivationStatus status,
        DateTimeOffset timestamp,
        string? failureReason,
        string activatedBy)
    {
        var history = new ThemeActivationHistorySnapshot(
            id,
            scope,
            themeId,
            previousThemeId,
            assetVersion,
            previousAssetVersion,
            configVersion,
            previousConfigVersion,
            mode,
            previousMode,
            status,
            timestamp,
            timestamp,
            failureReason,
            activatedBy,
            EvidenceJson: string.Empty);
        return history with
        {
            EvidenceJson = JsonSerializer.Serialize(
                history,
                ThemeJsonSerializerContext.Default.ThemeActivationHistorySnapshot)
        };
    }

    internal static ThemeActivationHistorySnapshot WithStatus(
        ThemeActivationHistorySnapshot history,
        ThemeActivationStatus status,
        DateTimeOffset completedAtUtc,
        string? failureReason)
    {
        ThemeActivationHistorySnapshot updated = history with
        {
            Status = status,
            CompletedAtUtc = completedAtUtc,
            FailureReason = failureReason,
            EvidenceJson = string.Empty
        };
        return updated with
        {
            EvidenceJson = JsonSerializer.Serialize(
                updated,
                ThemeJsonSerializerContext.Default.ThemeActivationHistorySnapshot)
        };
    }
}

public sealed partial class PostgresThemeRegistry
{
    public async Task<long?> GetConfigVersionAsync(
        string themeId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await db.Ado.GetDataTableAsync(
            "SELECT version FROM theme_config WHERE theme_id = @theme_id;",
            new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
        return table.Rows.Count == 0
            ? null
            : Convert.ToInt64(table.Rows[0]["version"], System.Globalization.CultureInfo.InvariantCulture);
    }

    public async Task<ThemeActivationHistorySnapshot> ActivateAsync(
        ThemeActivationScope scope,
        string themeId,
        string assetVersion,
        long? configVersion,
        string mode,
        string activatedBy,
        DateTimeOffset activatedAtUtc,
        CancellationToken cancellationToken)
    {
        InMemoryThemeRegistry.ValidateMutationInput(assetVersion, mode, activatedBy);
        cancellationToken.ThrowIfCancellationRequested();
        ThemeActivationHistorySnapshot? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnsureInstallableAsync(themeId).ConfigureAwait(false);
            ThemeActivationSnapshot? previous = await ReadActivationForUpdateAsync(scope).ConfigureAwait(false);
            var activationId = Guid.NewGuid();
            await UpsertActivationAsync(
                scope,
                themeId,
                mode,
                activationId,
                assetVersion,
                configVersion,
                activatedAtUtc).ConfigureAwait(false);
            await MarkThemeEnabledAsync(themeId, activatedAtUtc).ConfigureAwait(false);
            if (previous is not null
                && !string.Equals(previous.ActiveThemeId, themeId, StringComparison.Ordinal))
            {
                await RecalculateEnabledStateAsync(previous.ActiveThemeId, activatedAtUtc).ConfigureAwait(false);
            }

            result = InMemoryThemeRegistry.CreateHistory(
                activationId,
                scope,
                themeId,
                previous?.ActiveThemeId,
                assetVersion,
                previous?.AssetVersion,
                configVersion,
                previous?.ConfigVersion,
                mode,
                previous?.Mode,
                ThemeActivationStatus.Applied,
                activatedAtUtc,
                failureReason: null,
                activatedBy);
            await InsertHistoryAsync(result).ConfigureAwait(false);
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme activation transaction failed.");
        return result
            ?? throw new ThemeLifecycleException(
                "theme_activation_transaction_failed",
                "Theme activation transaction returned no history record.");
    }

    public async Task<ThemeActivationHistorySnapshot> RollbackAsync(
        ThemeActivationScope scope,
        Guid expectedActivationId,
        string activatedBy,
        string failureReason,
        DateTimeOffset rolledBackAtUtc,
        CancellationToken cancellationToken)
    {
        InMemoryThemeRegistry.ValidateActorAndReason(activatedBy, failureReason);
        cancellationToken.ThrowIfCancellationRequested();
        ThemeActivationHistorySnapshot? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ThemeActivationSnapshot current = await ReadActivationForUpdateAsync(scope).ConfigureAwait(false)
                ?? throw new ThemeLifecycleException(
                    "theme_rollback_activation_missing",
                    $"Theme scope '{scope}' has no active theme to roll back.");
            if (current.ActivationId != expectedActivationId)
            {
                throw new ThemeLifecycleException(
                    "theme_rollback_activation_conflict",
                    "Theme activation changed before rollback could be applied.");
            }

            ThemeActivationHistorySnapshot source = await ReadHistoryForUpdateAsync(
                expectedActivationId).ConfigureAwait(false)
                ?? throw new ThemeLifecycleException(
                    "theme_rollback_history_missing",
                    "Theme activation history required for rollback is missing.");
            var rollbackId = Guid.NewGuid();
            if (source.PreviousThemeId is null)
            {
                await DeleteActivationAsync(scope).ConfigureAwait(false);
            }
            else
            {
                await EnsureInstallableAsync(source.PreviousThemeId).ConfigureAwait(false);
                await UpsertActivationAsync(
                    scope,
                    source.PreviousThemeId,
                    source.PreviousMode ?? "auto",
                    rollbackId,
                    source.PreviousAssetVersion,
                    source.PreviousConfigVersion,
                    rolledBackAtUtc).ConfigureAwait(false);
                await MarkThemeEnabledAsync(source.PreviousThemeId, rolledBackAtUtc).ConfigureAwait(false);
            }

            await RecalculateEnabledStateAsync(current.ActiveThemeId, rolledBackAtUtc).ConfigureAwait(false);
            await UpdateHistoryStatusAsync(
                source,
                ThemeActivationStatus.RolledBack,
                rolledBackAtUtc,
                failureReason).ConfigureAwait(false);
            result = InMemoryThemeRegistry.CreateHistory(
                rollbackId,
                scope,
                source.PreviousThemeId,
                current.ActiveThemeId,
                source.PreviousAssetVersion,
                current.AssetVersion,
                source.PreviousConfigVersion,
                current.ConfigVersion,
                source.PreviousMode,
                current.Mode,
                ThemeActivationStatus.RolledBack,
                rolledBackAtUtc,
                failureReason,
                activatedBy);
            await InsertHistoryAsync(result).ConfigureAwait(false);
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme rollback transaction failed.");
        return result
            ?? throw new ThemeLifecycleException(
                "theme_rollback_transaction_failed",
                "Theme rollback transaction returned no history record.");
    }

    public async Task<ThemeActivationHistorySnapshot> ResetToDefaultAsync(
        ThemeActivationScope scope,
        string activatedBy,
        string reason,
        DateTimeOffset resetAtUtc,
        CancellationToken cancellationToken)
    {
        InMemoryThemeRegistry.ValidateActorAndReason(activatedBy, reason);
        cancellationToken.ThrowIfCancellationRequested();
        ThemeActivationHistorySnapshot? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ThemeActivationSnapshot? previous = await ReadActivationForUpdateAsync(scope).ConfigureAwait(false);
            await DeleteActivationAsync(scope).ConfigureAwait(false);
            if (previous is not null)
            {
                await RecalculateEnabledStateAsync(previous.ActiveThemeId, resetAtUtc).ConfigureAwait(false);
            }

            result = InMemoryThemeRegistry.CreateHistory(
                Guid.NewGuid(),
                scope,
                themeId: null,
                previous?.ActiveThemeId,
                assetVersion: null,
                previous?.AssetVersion,
                configVersion: null,
                previous?.ConfigVersion,
                mode: null,
                previous?.Mode,
                ThemeActivationStatus.ResetToDefault,
                resetAtUtc,
                reason,
                activatedBy);
            await InsertHistoryAsync(result).ConfigureAwait(false);
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme default reset transaction failed.");
        return result
            ?? throw new ThemeLifecycleException(
                "theme_reset_transaction_failed",
                "Theme reset transaction returned no history record.");
    }

    public async Task<ThemeActivationHistorySnapshot> RecordActivationFailureAsync(
        ThemeActivationScope scope,
        string? themeId,
        string activatedBy,
        string failureReason,
        DateTimeOffset failedAtUtc,
        CancellationToken cancellationToken)
    {
        InMemoryThemeRegistry.ValidateActorAndReason(activatedBy, failureReason);
        cancellationToken.ThrowIfCancellationRequested();
        ThemeActivationSnapshot? current = await GetActivationAsync(scope, cancellationToken).ConfigureAwait(false);
        ThemeActivationHistorySnapshot history = InMemoryThemeRegistry.CreateHistory(
            Guid.NewGuid(),
            scope,
            themeId,
            current?.ActiveThemeId,
            assetVersion: null,
            current?.AssetVersion,
            configVersion: null,
            current?.ConfigVersion,
            mode: null,
            current?.Mode,
            ThemeActivationStatus.Rejected,
            failedAtUtc,
            failureReason,
            activatedBy);
        await InsertHistoryAsync(history).ConfigureAwait(false);
        return history;
    }

    public async Task<IReadOnlyList<ThemeActivationHistorySnapshot>> GetActivationHistoryAsync(
        ThemeActivationScope scope,
        int limit,
        CancellationToken cancellationToken)
    {
        InMemoryThemeRegistry.ValidateHistoryLimit(limit);
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await db.Ado.GetDataTableAsync(
            """
            SELECT id, scope, theme_id, previous_theme_id, asset_version, previous_asset_version,
                   config_version, previous_config_version, mode, previous_mode, status,
                   started_at_utc, completed_at_utc, failure_reason, activated_by, evidence_json
            FROM theme_activation_history
            WHERE scope = @scope
            ORDER BY started_at_utc DESC, id DESC
            LIMIT @limit;
            """,
            new SugarParameter("@scope", scope.Value),
            new SugarParameter("@limit", limit)).ConfigureAwait(false);
        return table.Rows.Cast<DataRow>().Select(ReadHistory).ToArray();
    }

    private async Task<ThemeActivationSnapshot?> ReadActivationForUpdateAsync(ThemeActivationScope scope)
    {
        DataTable table = await db.Ado.GetDataTableAsync(
            """
            SELECT active_theme_id, mode, updated_at_utc, activation_id, asset_version, config_version
            FROM theme_activation
            WHERE scope = @scope
            FOR UPDATE;
            """,
            new SugarParameter("@scope", scope.Value)).ConfigureAwait(false);
        if (table.Rows.Count == 0)
        {
            return null;
        }

        DataRow row = table.Rows[0];
        return new ThemeActivationSnapshot(
            scope,
            Convert.ToString(row["active_theme_id"]) ?? string.Empty,
            Convert.ToString(row["mode"]) ?? string.Empty,
            AsUtc(row["updated_at_utc"]),
            row.IsNull("activation_id") ? null : Guid.Parse(Convert.ToString(row["activation_id"])!),
            row.IsNull("asset_version") ? null : Convert.ToString(row["asset_version"]),
            row.IsNull("config_version")
                ? null
                : Convert.ToInt64(row["config_version"], System.Globalization.CultureInfo.InvariantCulture));
    }

    private Task UpsertActivationAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        Guid activationId,
        string? assetVersion,
        long? configVersion,
        DateTimeOffset updatedAtUtc)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO theme_activation(
                scope, active_theme_id, mode, updated_at_utc,
                activation_id, asset_version, config_version)
            VALUES (
                @scope, @theme_id, @mode, @updated_at_utc,
                @activation_id, @asset_version, CAST(@config_version AS bigint))
            ON CONFLICT (scope) DO UPDATE
            SET active_theme_id = EXCLUDED.active_theme_id,
                mode = EXCLUDED.mode,
                updated_at_utc = EXCLUDED.updated_at_utc,
                activation_id = EXCLUDED.activation_id,
                asset_version = EXCLUDED.asset_version,
                config_version = EXCLUDED.config_version;
            """,
            new SugarParameter("@scope", scope.Value),
            new SugarParameter("@theme_id", themeId),
            new SugarParameter("@mode", mode),
            new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime),
            new SugarParameter("@activation_id", activationId.ToString("D")),
            new SugarParameter("@asset_version", (object?)assetVersion ?? DBNull.Value),
            new SugarParameter("@config_version", (object?)configVersion ?? DBNull.Value));

    private Task DeleteActivationAsync(ThemeActivationScope scope)
        => db.Ado.ExecuteCommandAsync(
            "DELETE FROM theme_activation WHERE scope = @scope;",
            new SugarParameter("@scope", scope.Value));

    private async Task<ThemeActivationHistorySnapshot?> ReadHistoryForUpdateAsync(Guid id)
    {
        DataTable table = await db.Ado.GetDataTableAsync(
            """
            SELECT id, scope, theme_id, previous_theme_id, asset_version, previous_asset_version,
                   config_version, previous_config_version, mode, previous_mode, status,
                   started_at_utc, completed_at_utc, failure_reason, activated_by, evidence_json
            FROM theme_activation_history
            WHERE id = @id
            FOR UPDATE;
            """,
            new SugarParameter("@id", id.ToString("D"))).ConfigureAwait(false);
        return table.Rows.Count == 0 ? null : ReadHistory(table.Rows[0]);
    }

    private Task InsertHistoryAsync(ThemeActivationHistorySnapshot history)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO theme_activation_history(
                id, scope, theme_id, previous_theme_id, asset_version, previous_asset_version,
                config_version, previous_config_version, mode, previous_mode, status,
                started_at_utc, completed_at_utc, failure_reason, activated_by, evidence_json)
            VALUES (
                @id, @scope, @theme_id, @previous_theme_id, @asset_version, @previous_asset_version,
                CAST(@config_version AS bigint), CAST(@previous_config_version AS bigint),
                @mode, @previous_mode, @status,
                @started_at_utc, @completed_at_utc, @failure_reason, @activated_by, @evidence_json::jsonb);
            """,
            HistoryParameters(history));

    private async Task UpdateHistoryStatusAsync(
        ThemeActivationHistorySnapshot history,
        ThemeActivationStatus status,
        DateTimeOffset completedAtUtc,
        string? failureReason)
    {
        ThemeActivationHistorySnapshot updated = InMemoryThemeRegistry.WithStatus(
            history,
            status,
            completedAtUtc,
            failureReason);
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE theme_activation_history
            SET status = @status,
                completed_at_utc = @completed_at_utc,
                failure_reason = @failure_reason,
                evidence_json = @evidence_json::jsonb
            WHERE id = @id;
            """,
            new SugarParameter("@status", StatusToStorage(updated.Status)),
            new SugarParameter("@completed_at_utc", updated.CompletedAtUtc.UtcDateTime),
            new SugarParameter("@failure_reason", (object?)updated.FailureReason ?? DBNull.Value),
            new SugarParameter("@evidence_json", updated.EvidenceJson),
            new SugarParameter("@id", updated.Id.ToString("D"))).ConfigureAwait(false);
    }

    private static SugarParameter[] HistoryParameters(ThemeActivationHistorySnapshot history)
        =>
        [
            new("@id", history.Id.ToString("D")),
            new("@scope", history.Scope.Value),
            new("@theme_id", (object?)history.ThemeId ?? DBNull.Value),
            new("@previous_theme_id", (object?)history.PreviousThemeId ?? DBNull.Value),
            new("@asset_version", (object?)history.AssetVersion ?? DBNull.Value),
            new("@previous_asset_version", (object?)history.PreviousAssetVersion ?? DBNull.Value),
            new("@config_version", (object?)history.ConfigVersion ?? DBNull.Value),
            new("@previous_config_version", (object?)history.PreviousConfigVersion ?? DBNull.Value),
            new("@mode", (object?)history.Mode ?? DBNull.Value),
            new("@previous_mode", (object?)history.PreviousMode ?? DBNull.Value),
            new("@status", StatusToStorage(history.Status)),
            new("@started_at_utc", history.StartedAtUtc.UtcDateTime),
            new("@completed_at_utc", history.CompletedAtUtc.UtcDateTime),
            new("@failure_reason", (object?)history.FailureReason ?? DBNull.Value),
            new("@activated_by", history.ActivatedBy),
            new("@evidence_json", history.EvidenceJson)
        ];

    private static ThemeActivationHistorySnapshot ReadHistory(DataRow row)
        => new(
            Guid.Parse(Convert.ToString(row["id"])!),
            ThemeActivationScope.Parse(Convert.ToString(row["scope"])!),
            row.IsNull("theme_id") ? null : Convert.ToString(row["theme_id"]),
            row.IsNull("previous_theme_id") ? null : Convert.ToString(row["previous_theme_id"]),
            row.IsNull("asset_version") ? null : Convert.ToString(row["asset_version"]),
            row.IsNull("previous_asset_version") ? null : Convert.ToString(row["previous_asset_version"]),
            row.IsNull("config_version")
                ? null
                : Convert.ToInt64(row["config_version"], System.Globalization.CultureInfo.InvariantCulture),
            row.IsNull("previous_config_version")
                ? null
                : Convert.ToInt64(row["previous_config_version"], System.Globalization.CultureInfo.InvariantCulture),
            row.IsNull("mode") ? null : Convert.ToString(row["mode"]),
            row.IsNull("previous_mode") ? null : Convert.ToString(row["previous_mode"]),
            StatusFromStorage(Convert.ToString(row["status"])),
            AsUtc(row["started_at_utc"]),
            AsUtc(row["completed_at_utc"]),
            row.IsNull("failure_reason") ? null : Convert.ToString(row["failure_reason"]),
            Convert.ToString(row["activated_by"]) ?? string.Empty,
            Convert.ToString(row["evidence_json"]) ?? "{}");

    private static string StatusToStorage(ThemeActivationStatus status)
        => status switch
        {
            ThemeActivationStatus.Applied => "applied",
            ThemeActivationStatus.Rejected => "rejected",
            ThemeActivationStatus.RolledBack => "rolled_back",
            ThemeActivationStatus.ResetToDefault => "reset_to_default",
            _ => throw new ArgumentOutOfRangeException(nameof(status))
        };

    private static ThemeActivationStatus StatusFromStorage(string? status)
        => status switch
        {
            "applied" => ThemeActivationStatus.Applied,
            "rejected" => ThemeActivationStatus.Rejected,
            "rolled_back" => ThemeActivationStatus.RolledBack,
            "reset_to_default" => ThemeActivationStatus.ResetToDefault,
            _ => throw new ThemeLifecycleException(
                "theme_activation_history_status_invalid",
                $"Persisted theme activation status '{status}' is invalid.")
        };
}
