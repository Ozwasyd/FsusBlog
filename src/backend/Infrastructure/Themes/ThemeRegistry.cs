using System.Data;
using System.Text.Json;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Themes;

public interface IThemeRegistry
{
    Task<ThemeRegistrySnapshot?> GetThemeAsync(string themeId, CancellationToken cancellationToken);

    Task<ThemeActivationSnapshot?> GetActivationAsync(
        ThemeActivationScope scope,
        CancellationToken cancellationToken);

    Task<long?> GetConfigVersionAsync(string themeId, CancellationToken cancellationToken);

    Task<ThemeActivationHistorySnapshot> ActivateAsync(
        ThemeActivationScope scope,
        string themeId,
        string assetVersion,
        long? configVersion,
        string mode,
        string activatedBy,
        DateTimeOffset activatedAtUtc,
        CancellationToken cancellationToken);

    Task<ThemeActivationHistorySnapshot> RollbackAsync(
        ThemeActivationScope scope,
        Guid expectedActivationId,
        string activatedBy,
        string failureReason,
        DateTimeOffset rolledBackAtUtc,
        CancellationToken cancellationToken);

    Task<ThemeActivationHistorySnapshot> ResetToDefaultAsync(
        ThemeActivationScope scope,
        string activatedBy,
        string reason,
        DateTimeOffset resetAtUtc,
        CancellationToken cancellationToken);

    Task<ThemeActivationHistorySnapshot> RecordActivationFailureAsync(
        ThemeActivationScope scope,
        string? themeId,
        string activatedBy,
        string failureReason,
        DateTimeOffset failedAtUtc,
        CancellationToken cancellationToken);

    Task<IReadOnlyList<ThemeActivationHistorySnapshot>> GetActivationHistoryAsync(
        ThemeActivationScope scope,
        int limit,
        CancellationToken cancellationToken);

    Task InstallAsync(
        ValidatedThemePackage package,
        string packageLocation,
        DateTimeOffset installedAtUtc,
        CancellationToken cancellationToken);

    Task EnableAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken);

    Task DisableAsync(
        ThemeActivationScope scope,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken);

    Task SaveConfigAsync(
        string themeId,
        string configJson,
        long version,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken);

    Task UninstallAsync(
        string themeId,
        string? replacementThemeId,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken);
}

public sealed partial class InMemoryThemeRegistry : IThemeRegistry
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, ThemeRegistrySnapshot> _themes = new(StringComparer.Ordinal);
    private readonly Dictionary<ThemeActivationScope, ThemeActivationSnapshot> _activations = [];
    private readonly Dictionary<string, (string ConfigJson, long Version)> _configs = new(StringComparer.Ordinal);

    public async Task<ThemeRegistrySnapshot?> GetThemeAsync(
        string themeId,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return _themes.GetValueOrDefault(themeId);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ThemeActivationSnapshot?> GetActivationAsync(
        ThemeActivationScope scope,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return _activations.GetValueOrDefault(scope);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task InstallAsync(
        ValidatedThemePackage package,
        string packageLocation,
        DateTimeOffset installedAtUtc,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            bool enabled = _themes.TryGetValue(package.Manifest.Id, out ThemeRegistrySnapshot? existing)
                && existing.Enabled;
            _themes[package.Manifest.Id] = new ThemeRegistrySnapshot(
                package.Manifest,
                package.ManifestJson,
                package.ConfigSchemaJson,
                package.PackageHash,
                packageLocation,
                enabled ? ThemeInstallState.Enabled : ThemeInstallState.Installed,
                enabled,
                existing?.InstalledAtUtc ?? installedAtUtc,
                installedAtUtc);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task EnableAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThemeRegistrySnapshot target = GetInstallableTheme(themeId);
            string? previousThemeId = _activations.GetValueOrDefault(scope)?.ActiveThemeId;
            _activations[scope] = new ThemeActivationSnapshot(scope, themeId, mode, updatedAtUtc);
            _themes[themeId] = target with
            {
                InstallState = ThemeInstallState.Enabled,
                Enabled = true,
                UpdatedAtUtc = updatedAtUtc
            };
            RecalculateEnabledState(previousThemeId, updatedAtUtc);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DisableAsync(
        ThemeActivationScope scope,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_activations.Remove(scope, out ThemeActivationSnapshot? activation))
            {
                RecalculateEnabledState(activation.ActiveThemeId, updatedAtUtc);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveConfigAsync(
        string themeId,
        string configJson,
        long version,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _ = GetInstallableTheme(themeId);
            if (version <= 0)
            {
                throw new ThemeLifecycleException(
                    "theme_config_version_invalid",
                    "Theme config version must be positive.");
            }

            if (_configs.TryGetValue(themeId, out (string ConfigJson, long Version) existing)
                && version <= existing.Version)
            {
                throw new ThemeLifecycleException(
                    "theme_config_version_conflict",
                    "Theme config version must advance monotonically.");
            }

            _configs[themeId] = (configJson, version);
            _themes[themeId] = _themes[themeId] with
            {
                UpdatedAtUtc = updatedAtUtc
            };
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UninstallAsync(
        string themeId,
        string? replacementThemeId,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThemeRegistrySnapshot target = GetInstallableTheme(themeId);
            ThemeRegistrySnapshot? replacement = null;
            if (replacementThemeId is not null)
            {
                if (string.Equals(themeId, replacementThemeId, StringComparison.Ordinal))
                {
                    throw new ThemeLifecycleException(
                        "theme_uninstall_replacement_invalid",
                        "Replacement theme must differ from the uninstalled theme.");
                }

                replacement = GetInstallableTheme(replacementThemeId);
            }

            ThemeActivationScope[] activeScopes =
            [
                .. _activations
                    .Where(pair => string.Equals(pair.Value.ActiveThemeId, themeId, StringComparison.Ordinal))
                    .Select(static pair => pair.Key)
            ];
            if (activeScopes.Length > 0 && replacement is null)
            {
                throw new ThemeLifecycleException(
                    "theme_uninstall_active_replacement_required",
                    "An active theme cannot be uninstalled without selecting an installed replacement.");
            }

            foreach (ThemeActivationScope scope in activeScopes)
            {
                ThemeActivationSnapshot current = _activations[scope];
                _activations[scope] = current with
                {
                    ActiveThemeId = replacementThemeId!,
                    UpdatedAtUtc = updatedAtUtc
                };
            }

            _themes[themeId] = target with
            {
                InstallState = ThemeInstallState.Uninstalled,
                Enabled = false,
                UpdatedAtUtc = updatedAtUtc
            };
            _configs.Remove(themeId);
            if (replacement is not null && activeScopes.Length > 0)
            {
                _themes[replacementThemeId!] = replacement with
                {
                    InstallState = ThemeInstallState.Enabled,
                    Enabled = true,
                    UpdatedAtUtc = updatedAtUtc
                };
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private ThemeRegistrySnapshot GetInstallableTheme(string themeId)
    {
        if (!_themes.TryGetValue(themeId, out ThemeRegistrySnapshot? snapshot)
            || snapshot.InstallState is ThemeInstallState.Uninstalled
                or ThemeInstallState.Failed
                or ThemeInstallState.RolledBack)
        {
            throw new ThemeLifecycleException(
                "theme_not_installed",
                $"Theme '{themeId}' is not installed.");
        }

        return snapshot;
    }

    private void RecalculateEnabledState(string? themeId, DateTimeOffset updatedAtUtc)
    {
        if (themeId is null || !_themes.TryGetValue(themeId, out ThemeRegistrySnapshot? theme))
        {
            return;
        }

        bool remainsActive = _activations.Values.Any(
            activation => string.Equals(activation.ActiveThemeId, themeId, StringComparison.Ordinal));
        _themes[themeId] = theme with
        {
            InstallState = remainsActive ? ThemeInstallState.Enabled : ThemeInstallState.Disabled,
            Enabled = remainsActive,
            UpdatedAtUtc = updatedAtUtc
        };
    }
}

public sealed partial class PostgresThemeRegistry(ISqlSugarClient db) : IThemeRegistry
{
    public async Task<ThemeRegistrySnapshot?> GetThemeAsync(
        string themeId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await db.Ado.GetDataTableAsync(
            """
            SELECT manifest_json, config_schema_json, package_hash, package_location,
                   install_state, enabled,
                   installed_at_utc, updated_at_utc
            FROM theme_registry
            WHERE id = @theme_id;
            """,
            new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
        if (table.Rows.Count == 0)
        {
            return null;
        }

        DataRow row = table.Rows[0];
        string manifestJson = Convert.ToString(row["manifest_json"]) ?? string.Empty;
        ThemeManifest manifest = DeserializeManifest(manifestJson);
        return new ThemeRegistrySnapshot(
            manifest,
            manifestJson,
            Convert.ToString(row["config_schema_json"]) ?? string.Empty,
            Convert.ToString(row["package_hash"]) ?? string.Empty,
            Convert.ToString(row["package_location"]) ?? string.Empty,
            ParseInstallState(Convert.ToString(row["install_state"])),
            Convert.ToBoolean(row["enabled"]),
            AsUtc(row["installed_at_utc"]),
            AsUtc(row["updated_at_utc"]));
    }

    public async Task<ThemeActivationSnapshot?> GetActivationAsync(
        ThemeActivationScope scope,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await db.Ado.GetDataTableAsync(
            """
            SELECT active_theme_id, mode, updated_at_utc,
                   activation_id, asset_version, config_version
            FROM theme_activation
            WHERE scope = @scope;
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
                : Convert.ToInt64(
                    row["config_version"],
                    System.Globalization.CultureInfo.InvariantCulture));
    }

    public async Task InstallAsync(
        ValidatedThemePackage package,
        string packageLocation,
        DateTimeOffset installedAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO theme_registry(
                    id, name, version, manifest_json, config_schema_json, package_hash,
                    package_location, install_state, enabled,
                    installed_at_utc, updated_at_utc
                )
                VALUES (
                    @id, @name, @version, @manifest_json::jsonb, @config_schema_json::jsonb,
                    @package_hash, @package_location, 'installed', FALSE,
                    @installed_at_utc, @updated_at_utc
                )
                ON CONFLICT (id) DO UPDATE
                SET name = EXCLUDED.name,
                    version = EXCLUDED.version,
                    manifest_json = EXCLUDED.manifest_json,
                    config_schema_json = EXCLUDED.config_schema_json,
                    package_hash = EXCLUDED.package_hash,
                    package_location = EXCLUDED.package_location,
                    install_state = CASE
                        WHEN theme_registry.enabled THEN 'enabled'
                        ELSE 'installed'
                    END,
                    updated_at_utc = EXCLUDED.updated_at_utc;
                """,
                new SugarParameter("@id", package.Manifest.Id),
                new SugarParameter("@name", package.Manifest.Name),
                new SugarParameter("@version", package.Manifest.Version),
                new SugarParameter("@manifest_json", package.ManifestJson),
                new SugarParameter("@config_schema_json", package.ConfigSchemaJson),
                new SugarParameter("@package_hash", package.PackageHash),
                new SugarParameter("@package_location", packageLocation),
                new SugarParameter("@installed_at_utc", installedAtUtc.UtcDateTime),
                new SugarParameter("@updated_at_utc", installedAtUtc.UtcDateTime)).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM theme_asset WHERE theme_id = @theme_id;",
                new SugarParameter("@theme_id", package.Manifest.Id)).ConfigureAwait(false);
            foreach (ThemeAssetMetadata asset in package.Assets.Values)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO theme_asset(theme_id, asset_key, content_hash, path, size_bytes)
                    VALUES (@theme_id, @asset_key, @content_hash, @path, @size_bytes);
                    """,
                    new SugarParameter("@theme_id", package.Manifest.Id),
                    new SugarParameter("@asset_key", asset.AssetKey),
                    new SugarParameter("@content_hash", asset.ContentHash),
                    new SugarParameter("@path", asset.Path),
                    new SugarParameter("@size_bytes", asset.SizeBytes)).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme installation transaction failed.");
    }

    public async Task EnableAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnsureInstallableAsync(themeId).ConfigureAwait(false);
            string? previousThemeId = await ReadActiveThemeIdAsync(scope).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO theme_activation(scope, active_theme_id, mode, updated_at_utc)
                VALUES (@scope, @theme_id, @mode, @updated_at_utc)
                ON CONFLICT (scope) DO UPDATE
                SET active_theme_id = EXCLUDED.active_theme_id,
                    mode = EXCLUDED.mode,
                    updated_at_utc = EXCLUDED.updated_at_utc;
                """,
                new SugarParameter("@scope", scope.Value),
                new SugarParameter("@theme_id", themeId),
                new SugarParameter("@mode", mode),
                new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime)).ConfigureAwait(false);
            await MarkThemeEnabledAsync(themeId, updatedAtUtc).ConfigureAwait(false);
            if (previousThemeId is not null
                && !string.Equals(previousThemeId, themeId, StringComparison.Ordinal))
            {
                await RecalculateEnabledStateAsync(previousThemeId, updatedAtUtc).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme activation transaction failed.");
    }

    public async Task DisableAsync(
        ThemeActivationScope scope,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            string? previousThemeId = await ReadActiveThemeIdAsync(scope).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM theme_activation WHERE scope = @scope;",
                new SugarParameter("@scope", scope.Value)).ConfigureAwait(false);
            if (previousThemeId is not null)
            {
                await RecalculateEnabledStateAsync(previousThemeId, updatedAtUtc).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme disable transaction failed.");
    }

    public async Task SaveConfigAsync(
        string themeId,
        string configJson,
        long version,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (version <= 0)
        {
            throw new ThemeLifecycleException(
                "theme_config_version_invalid",
                "Theme config version must be positive.");
        }

        await EnsureInstallableAsync(themeId).ConfigureAwait(false);
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO theme_config(theme_id, config_json, version, updated_at_utc)
            VALUES (@theme_id, @config_json::jsonb, @version, @updated_at_utc)
            ON CONFLICT (theme_id) DO UPDATE
            SET config_json = EXCLUDED.config_json,
                version = EXCLUDED.version,
                updated_at_utc = EXCLUDED.updated_at_utc
            WHERE theme_config.version < EXCLUDED.version;
            """,
            new SugarParameter("@theme_id", themeId),
            new SugarParameter("@config_json", configJson),
            new SugarParameter("@version", version),
            new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime)).ConfigureAwait(false);
        if (affected != 1)
        {
            throw new ThemeLifecycleException(
                "theme_config_version_conflict",
                "Theme config version must advance monotonically.");
        }
    }

    public async Task UninstallAsync(
        string themeId,
        string? replacementThemeId,
        DateTimeOffset updatedAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnsureInstallableAsync(themeId).ConfigureAwait(false);
            if (string.Equals(themeId, replacementThemeId, StringComparison.Ordinal))
            {
                throw new ThemeLifecycleException(
                    "theme_uninstall_replacement_invalid",
                    "Replacement theme must differ from the uninstalled theme.");
            }

            int activeCount = await db.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM theme_activation WHERE active_theme_id = @theme_id;",
                new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
            if (activeCount > 0 && replacementThemeId is null)
            {
                throw new ThemeLifecycleException(
                    "theme_uninstall_active_replacement_required",
                    "An active theme cannot be uninstalled without selecting an installed replacement.");
            }

            if (replacementThemeId is not null && activeCount > 0)
            {
                await EnsureInstallableAsync(replacementThemeId).ConfigureAwait(false);
                await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE theme_activation
                    SET active_theme_id = @replacement_theme_id,
                        updated_at_utc = @updated_at_utc
                    WHERE active_theme_id = @theme_id;
                    """,
                    new SugarParameter("@replacement_theme_id", replacementThemeId),
                    new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime),
                    new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
                await MarkThemeEnabledAsync(replacementThemeId, updatedAtUtc).ConfigureAwait(false);
            }

            await db.Ado.ExecuteCommandAsync(
                """
                UPDATE theme_registry
                SET install_state = 'uninstalled',
                    enabled = FALSE,
                    updated_at_utc = @updated_at_utc
                WHERE id = @theme_id;
                """,
                new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime),
                new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM theme_config WHERE theme_id = @theme_id;",
                new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM theme_asset WHERE theme_id = @theme_id;",
                new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
        }).ConfigureAwait(false);
        EnsureTransactionSucceeded(transaction, "Theme uninstall transaction failed.");
    }

    private async Task EnsureInstallableAsync(string themeId)
    {
        int count = await db.Ado.GetIntAsync(
            """
            SELECT COUNT(*)
            FROM theme_registry
            WHERE id = @theme_id
              AND install_state NOT IN ('failed', 'rolled_back', 'uninstalled');
            """,
            new SugarParameter("@theme_id", themeId)).ConfigureAwait(false);
        if (count != 1)
        {
            throw new ThemeLifecycleException(
                "theme_not_installed",
                $"Theme '{themeId}' is not installed.");
        }
    }

    private async Task<string?> ReadActiveThemeIdAsync(ThemeActivationScope scope)
    {
        DataTable table = await db.Ado.GetDataTableAsync(
            "SELECT active_theme_id FROM theme_activation WHERE scope = @scope FOR UPDATE;",
            new SugarParameter("@scope", scope.Value)).ConfigureAwait(false);
        return table.Rows.Count == 0
            ? null
            : Convert.ToString(table.Rows[0]["active_theme_id"]);
    }

    private Task MarkThemeEnabledAsync(string themeId, DateTimeOffset updatedAtUtc)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE theme_registry
            SET install_state = 'enabled',
                enabled = TRUE,
                updated_at_utc = @updated_at_utc
            WHERE id = @theme_id;
            """,
            new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime),
            new SugarParameter("@theme_id", themeId));

    private Task RecalculateEnabledStateAsync(string themeId, DateTimeOffset updatedAtUtc)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE theme_registry
            SET enabled = EXISTS (
                    SELECT 1
                    FROM theme_activation
                    WHERE active_theme_id = @theme_id
                ),
                install_state = CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM theme_activation
                        WHERE active_theme_id = @theme_id
                    ) THEN 'enabled'
                    ELSE 'disabled'
                END,
                updated_at_utc = @updated_at_utc
            WHERE id = @theme_id;
            """,
            new SugarParameter("@theme_id", themeId),
            new SugarParameter("@updated_at_utc", updatedAtUtc.UtcDateTime));

    private static ThemeManifest DeserializeManifest(string manifestJson)
    {
        try
        {
            return JsonSerializer.Deserialize(
                manifestJson,
                ThemeJsonSerializerContext.Default.ThemeManifest)
                ?? throw new ThemeLifecycleException(
                    "theme_registry_manifest_invalid",
                    "Persisted theme manifest cannot be null.");
        }
        catch (JsonException exception)
        {
            throw new ThemeLifecycleException(
                "theme_registry_manifest_invalid",
                "Persisted theme manifest is invalid.",
                exception);
        }
    }

    private static ThemeInstallState ParseInstallState(string? value)
        => value switch
        {
            "discovered" => ThemeInstallState.Discovered,
            "validated" => ThemeInstallState.Validated,
            "installed" => ThemeInstallState.Installed,
            "enabled" => ThemeInstallState.Enabled,
            "disabled" => ThemeInstallState.Disabled,
            "failed" => ThemeInstallState.Failed,
            "rolled_back" => ThemeInstallState.RolledBack,
            "uninstalled" => ThemeInstallState.Uninstalled,
            _ => throw new ThemeLifecycleException(
                "theme_registry_state_invalid",
                $"Persisted theme install state '{value}' is invalid.")
        };

    private static DateTimeOffset AsUtc(object value)
    {
        DateTime dateTime = Convert.ToDateTime(value, System.Globalization.CultureInfo.InvariantCulture);
        return new DateTimeOffset(DateTime.SpecifyKind(dateTime, DateTimeKind.Utc));
    }

    private static void EnsureTransactionSucceeded(
        DbResult<bool> transaction,
        string message)
    {
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException
                ?? new ThemeLifecycleException("theme_registry_transaction_failed", message);
        }
    }
}
