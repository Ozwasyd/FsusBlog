using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Themes;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

public static class ThemeAdminEndpoints
{
    public static IEndpointRouteBuilder MapThemeAdminEndpoints(
        this IEndpointRouteBuilder app)
    {
        RouteGroupBuilder group = app.MapGroup("/api/binary/author/ops/themes")
            .WithTags("ThemeAdmin")
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        group.MapGet("/registry", ListRegistryAsync);
        group.MapGet("/registry/{themeId}", GetThemeAsync);
        group.MapGet("/activations", ListActivationsAsync);
        group.MapGet("/activations/{scope}", GetActivationAsync);
        group.MapGet("/activations/{scope}/history", GetActivationHistoryAsync);
        return app;
    }

    private static async Task<IResult> ListRegistryAsync(
        IAedsEncoder aeds,
        [FromServices] IThemeRegistry registry,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ThemeRegistrySnapshot> installed = await registry.ListThemesAsync(cancellationToken);
        return AedsJsonResults.Ok(aeds, AedsFrameType.ThemeAdminSnapshot, installed.Select(t => new
        {
            themeId = t.Manifest.Id,
            t.Manifest.Name,
            t.Manifest.Version,
            t.Manifest.Author,
            t.Manifest.Description,
            t.Manifest.Type,
            installState = t.InstallState.ToString(),
            t.Enabled,
            t.PackageHash,
            t.PackageLocation,
            t.InstalledAtUtc,
            t.UpdatedAtUtc
        }));
    }

    private static async Task<IResult> GetThemeAsync(
        string themeId,
        IAedsEncoder aeds,
        [FromServices] IThemeRegistry registry,
        CancellationToken cancellationToken)
    {
        ThemeRegistrySnapshot? theme = await registry.GetThemeAsync(themeId, cancellationToken);
        if (theme is null)
            return AedsJsonResults.NotFound(aeds, "theme_not_found");

        return AedsJsonResults.Ok(aeds, AedsFrameType.ThemeAdminSnapshot, new
        {
            themeId = theme.Manifest.Id,
            theme.Manifest.Name,
            theme.Manifest.Version,
            theme.Manifest.Author,
            theme.Manifest.Description,
            theme.Manifest.Type,
            installState = theme.InstallState.ToString(),
            theme.Enabled,
            theme.PackageHash,
            theme.PackageLocation,
            theme.ManifestJson,
            theme.ConfigSchemaJson,
            theme.InstalledAtUtc,
            theme.UpdatedAtUtc,
            modes = theme.Manifest.Modes,
            supports = theme.Manifest.Supports,
            budgets = theme.Manifest.Budgets,
            permissions = theme.Manifest.Permissions
        });
    }

    private static async Task<IResult> ListActivationsAsync(
        IAedsEncoder aeds,
        [FromServices] IThemeRegistry registry,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ThemeActivationSnapshot> activations = await registry.ListActivationsAsync(cancellationToken);
        return AedsJsonResults.Ok(aeds, AedsFrameType.ThemeAdminSnapshot, activations.Select(a => new
        {
            scope = a.Scope.Value,
            a.ActiveThemeId,
            a.Mode,
            a.ActivationId,
            a.AssetVersion,
            a.ConfigVersion,
            a.UpdatedAtUtc
        }));
    }

    private static async Task<IResult> GetActivationAsync(
        string scope,
        IAedsEncoder aeds,
        [FromServices] IThemeRegistry registry,
        CancellationToken cancellationToken)
    {
        ThemeActivationScope parsedScope = ThemeActivationScope.Parse(scope);
        ThemeActivationSnapshot? activation = await registry.GetActivationAsync(parsedScope, cancellationToken);
        if (activation is null)
            return AedsJsonResults.Ok(aeds, AedsFrameType.ThemeAdminSnapshot, new
            {
                scope = parsedScope.Value,
                activeThemeId = (string?)null
            });

        return AedsJsonResults.Ok(aeds, AedsFrameType.ThemeAdminSnapshot, new
        {
            scope = activation.Scope.Value,
            activation.ActiveThemeId,
            activation.Mode,
            activation.ActivationId,
            activation.AssetVersion,
            activation.ConfigVersion,
            activation.UpdatedAtUtc
        });
    }

    private static async Task<IResult> GetActivationHistoryAsync(
        string scope,
        IAedsEncoder aeds,
        [FromServices] IThemeRegistry registry,
        CancellationToken cancellationToken)
    {
        ThemeActivationScope parsedScope = ThemeActivationScope.Parse(scope);
        IReadOnlyList<ThemeActivationHistorySnapshot> history =
            await registry.GetActivationHistoryAsync(parsedScope, cancellationToken);
        return AedsJsonResults.Ok(aeds, AedsFrameType.ThemeAdminSnapshot, history.Select(h => new
        {
            h.Id,
            scope = h.Scope.Value,
            h.ThemeId,
            h.PreviousThemeId,
            h.AssetVersion,
            h.PreviousAssetVersion,
            h.ConfigVersion,
            h.PreviousConfigVersion,
            h.Mode,
            h.PreviousMode,
            status = h.Status.ToString(),
            h.FailureReason,
            h.StartedAtUtc,
            h.CompletedAtUtc,
            h.ActivatedBy
        }));
    }
}
