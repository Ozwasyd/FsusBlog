namespace FsusBlog.Server.Infrastructure.Themes;

public sealed class ThemeLifecycleService(
    ThemePackageValidator packageValidator,
    IThemeRegistry registry,
    Version fsusBlogVersion,
    TimeProvider timeProvider,
    IThemePackageStore? packageStore = null)
{
    private readonly IThemePackageStore _packageStore = packageStore ?? new InMemoryThemePackageStore();

    public ValidatedThemePackage Validate(Stream packageStream)
        => packageValidator.Validate(packageStream, fsusBlogVersion);

    public async Task<ThemeRegistrySnapshot> InstallAsync(
        Stream packageStream,
        CancellationToken cancellationToken)
    {
        ValidatedThemePackage package = Validate(packageStream);
        DateTimeOffset now = timeProvider.GetUtcNow();
        ThemePackageStoreReceipt receipt = await _packageStore.StoreAsync(
            package,
            cancellationToken).ConfigureAwait(false);
        try
        {
            await registry.InstallAsync(
                package,
                receipt.Location,
                now,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            if (receipt.Created)
            {
                await _packageStore.DeleteAsync(receipt.Location, CancellationToken.None).ConfigureAwait(false);
            }

            throw;
        }

        return await registry.GetThemeAsync(package.Manifest.Id, cancellationToken).ConfigureAwait(false)
            ?? throw new ThemeLifecycleException(
                "theme_install_persistence_failed",
                "Installed theme could not be read from the registry.");
    }

    public Task EnableAsync(
        ThemeActivationScope scope,
        string themeId,
        CancellationToken cancellationToken)
        => EnableAsync(scope, themeId, "auto", cancellationToken);

    public Task EnableAsync(
        ThemeActivationScope scope,
        string themeId,
        string mode,
        CancellationToken cancellationToken)
    {
        if (mode is not ("auto" or "light" or "dark"))
        {
            throw new ThemeLifecycleException(
                "theme_activation_mode_invalid",
                "Theme activation mode must be auto, light, or dark.");
        }

        return registry.EnableAsync(
            scope,
            themeId,
            mode,
            timeProvider.GetUtcNow(),
            cancellationToken);
    }

    public Task DisableAsync(
        ThemeActivationScope scope,
        CancellationToken cancellationToken)
        => registry.DisableAsync(scope, timeProvider.GetUtcNow(), cancellationToken);

    public async Task SaveConfigAsync(
        string themeId,
        string configJson,
        long version,
        CancellationToken cancellationToken)
    {
        ThemeRegistrySnapshot theme = await registry.GetThemeAsync(themeId, cancellationToken).ConfigureAwait(false)
            ?? throw new ThemeLifecycleException(
                "theme_not_installed",
                $"Theme '{themeId}' is not installed.");
        var package = new ValidatedThemePackage(
            theme.Manifest,
            theme.ManifestJson,
            theme.ConfigSchemaJson,
            theme.PackageHash,
            ReadOnlyMemory<byte>.Empty,
            [],
            new Dictionary<string, ThemeAssetMetadata>());
        packageValidator.ValidateConfig(package, configJson);
        await registry.SaveConfigAsync(
            themeId,
            configJson,
            version,
            timeProvider.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
    }

    public Task UninstallAsync(
        string themeId,
        string? replacementThemeId,
        CancellationToken cancellationToken)
        => UninstallCoreAsync(themeId, replacementThemeId, cancellationToken);

    private async Task UninstallCoreAsync(
        string themeId,
        string? replacementThemeId,
        CancellationToken cancellationToken)
    {
        ThemeRegistrySnapshot target = await registry.GetThemeAsync(themeId, cancellationToken).ConfigureAwait(false)
            ?? throw new ThemeLifecycleException(
                "theme_not_installed",
                $"Theme '{themeId}' is not installed.");
        if (target.InstallState == ThemeInstallState.Uninstalled)
        {
            await _packageStore.DeleteAsync(target.PackageLocation, cancellationToken).ConfigureAwait(false);
            return;
        }

        await registry.UninstallAsync(
            themeId,
            replacementThemeId,
            timeProvider.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
        await _packageStore.DeleteAsync(target.PackageLocation, cancellationToken).ConfigureAwait(false);
    }
}
