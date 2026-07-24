namespace FsusBlog.Server.Infrastructure.Plugins;

public interface IPluginRegistryStore
{
    Task<PluginRegistryEntry?> FindAsync(string pluginId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(CancellationToken cancellationToken = default);

    Task<bool> TryInstallAsync(PluginRegistryEntry entry, CancellationToken cancellationToken = default);

    Task<PluginRegistryEntry?> TryUpdateAsync(
        PluginRegistryEntry entry,
        long expectedVersion,
        CancellationToken cancellationToken = default);
}

public interface IPluginRegistry
{
    Task<PluginRegistryEntry?> FindAsync(string pluginId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(CancellationToken cancellationToken = default);
}

public sealed class PluginRegistry(IPluginRegistryStore store) : IPluginRegistry
{
    public Task<PluginRegistryEntry?> FindAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
        => store.FindAsync(pluginId, cancellationToken);

    public Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(CancellationToken cancellationToken = default)
        => store.ListAsync(cancellationToken);
}

public interface IPluginLifecycle
{
    Task<PluginRegistryEntry> InstallAsync(Stream package, CancellationToken cancellationToken = default);

    Task<PluginRegistryEntry> EnableAsync(string pluginId, CancellationToken cancellationToken = default);

    Task<PluginRegistryEntry> DisableAsync(string pluginId, CancellationToken cancellationToken = default);

    Task<PluginRegistryEntry> UninstallAsync(string pluginId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Owns durable lifecycle transitions. Package verification completes before the
/// first Registry write, and state changes use optimistic compare-and-swap.
/// </summary>
public sealed class PluginLifecycle(
    PluginPackageReader packageReader,
    IPluginRegistryStore registry,
    TimeProvider timeProvider) : IPluginLifecycle
{
    public async Task<PluginRegistryEntry> InstallAsync(
        Stream package,
        CancellationToken cancellationToken = default)
    {
        PluginPackage verified = await packageReader.ReadAsync(package, cancellationToken).ConfigureAwait(false);
        DateTimeOffset now = timeProvider.GetUtcNow();
        var entry = new PluginRegistryEntry(
            verified.Manifest,
            PluginInstallState.Installed,
            Enabled: false,
            verified.PackageBytes,
            verified.PackageSha256,
            now,
            now,
            Version: 1);
        if (!await registry.TryInstallAsync(entry, cancellationToken).ConfigureAwait(false))
        {
            throw new PluginLifecycleException(
                $"Plugin '{verified.Manifest.Id}' is already registered and was not replaced.");
        }
        return entry;
    }

    public Task<PluginRegistryEntry> EnableAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
        => TransitionAsync(
            pluginId,
            static current => current.InstallState is PluginInstallState.Installed or PluginInstallState.Disabled,
            PluginInstallState.Enabled,
            enabled: true,
            clearPackage: false,
            cancellationToken);

    public Task<PluginRegistryEntry> DisableAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
        => TransitionAsync(
            pluginId,
            static current => current.InstallState == PluginInstallState.Enabled,
            PluginInstallState.Disabled,
            enabled: false,
            clearPackage: false,
            cancellationToken);

    public Task<PluginRegistryEntry> UninstallAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
        => TransitionAsync(
            pluginId,
            static current => current.InstallState is not PluginInstallState.Uninstalled,
            PluginInstallState.Uninstalled,
            enabled: false,
            clearPackage: true,
            cancellationToken);

    public Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(CancellationToken cancellationToken = default)
        => registry.ListAsync(cancellationToken);

    private async Task<PluginRegistryEntry> TransitionAsync(
        string pluginId,
        Func<PluginRegistryEntry, bool> transitionAllowed,
        PluginInstallState targetState,
        bool enabled,
        bool clearPackage,
        CancellationToken cancellationToken)
    {
        string normalizedId = pluginId?.Trim() ?? string.Empty;
        if (normalizedId.Length == 0)
        {
            throw new ArgumentException("Plugin id cannot be empty.", nameof(pluginId));
        }

        for (int attempt = 0; attempt < 3; attempt++)
        {
            PluginRegistryEntry current = await registry.FindAsync(normalizedId, cancellationToken).ConfigureAwait(false)
                ?? throw new PluginLifecycleException($"Plugin '{normalizedId}' is not registered.");
            if (!transitionAllowed(current))
            {
                throw new PluginLifecycleException(
                    $"Plugin '{normalizedId}' cannot transition from {current.InstallState} to {targetState}.");
            }

            PluginRegistryEntry requested = current with
            {
                InstallState = targetState,
                Enabled = enabled,
                PackageBytes = clearPackage ? [] : current.PackageBytes,
                UpdatedAtUtc = timeProvider.GetUtcNow()
            };
            PluginRegistryEntry? updated = await registry.TryUpdateAsync(
                requested,
                current.Version,
                cancellationToken).ConfigureAwait(false);
            if (updated is not null)
            {
                return updated;
            }
        }

        throw new PluginLifecycleException(
            $"Plugin '{normalizedId}' changed concurrently; retry the lifecycle operation.");
    }
}
