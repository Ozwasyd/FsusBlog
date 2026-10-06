using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Themes;
using FsusBlog.Shared.Contracts.Outputs;

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
        [FromServices] IThemeRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ThemeRegistrySnapshot> installed = await registry.ListThemesAsync(cancellationToken);
        var response = new ThemeRegistryListResponse(installed.Select(ProjectTheme).ToArray());
        return BinaryResults.Frame(aeds, AedsFrameType.ThemeRegistryList, writer => PodBinaryCodec.WriteThemeRegistryList(response, writer));
    }

    private static async Task<IResult> GetThemeAsync(
        string themeId,
        [FromServices] IThemeRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        ThemeRegistrySnapshot? theme = await registry.GetThemeAsync(themeId, cancellationToken);
        if (theme is null)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.NotFound, "Theme was not found.", "theme_not_found"),
                aeds);
        }

        var response = new ThemeRegistryDetailResponse(
            ProjectTheme(theme),
            theme.ManifestJson,
            theme.ConfigSchemaJson,
            theme.Manifest.Modes,
            new ThemeSupportResponse(
                theme.Manifest.Supports.Public,
                theme.Manifest.Supports.Admin,
                theme.Manifest.Supports.Console,
                theme.Manifest.Supports.HighContrast,
                theme.Manifest.Supports.ReducedMotion,
                theme.Manifest.Supports.Rtl),
            new ThemeBudgetResponse(
                theme.Manifest.Budgets.CssBytes,
                theme.Manifest.Budgets.AssetBytes,
                theme.Manifest.Budgets.MaxSelectors,
                theme.Manifest.Budgets.MaxSelectorDepth,
                theme.Manifest.Budgets.MaxImportant,
                theme.Manifest.Budgets.MaxMotionDurationMs,
                theme.Manifest.Budgets.PreviewBytes),
            new ThemePermissionResponse(
                theme.Manifest.Permissions.Script,
                theme.Manifest.Permissions.Network,
                theme.Manifest.Permissions.Filesystem));
        return BinaryResults.Frame(aeds, AedsFrameType.ThemeRegistryDetail, writer => PodBinaryCodec.WriteThemeRegistryDetail(response, writer));
    }

    private static async Task<IResult> ListActivationsAsync(
        [FromServices] IThemeRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ThemeActivationSnapshot> activations = await registry.ListActivationsAsync(cancellationToken);
        var response = new ThemeActivationListResponse(activations.Select(ProjectActivation).ToArray());
        return BinaryResults.Frame(aeds, AedsFrameType.ThemeActivationList, writer => PodBinaryCodec.WriteThemeActivationList(response, writer));
    }

    private static async Task<IResult> GetActivationAsync(
        string scope,
        [FromServices] IThemeRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        if (!TryParseScope(scope, out ThemeActivationScope parsedScope))
        {
            return InvalidScope(aeds);
        }
        ThemeActivationSnapshot? activation = await registry.GetActivationAsync(parsedScope, cancellationToken);
        ThemeActivationResponse response = activation is null
            ? new ThemeActivationResponse(parsedScope.Value, null, null, null, null, null, null)
            : ProjectActivation(activation);
        return BinaryResults.Frame(aeds, AedsFrameType.ThemeActivation, writer => PodBinaryCodec.WriteThemeActivation(response, writer));
    }

    private static async Task<IResult> GetActivationHistoryAsync(
        string scope,
        [FromServices] IThemeRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        if (!TryParseScope(scope, out ThemeActivationScope parsedScope))
        {
            return InvalidScope(aeds);
        }
        IReadOnlyList<ThemeActivationHistorySnapshot> history =
            await registry.GetActivationHistoryAsync(parsedScope, cancellationToken);
        var response = new ThemeActivationHistoryResponse(history.Select(static item => new ThemeActivationHistoryItemResponse(
            item.Id,
            item.Scope.Value,
            item.ThemeId,
            item.PreviousThemeId,
            item.AssetVersion,
            item.PreviousAssetVersion,
            item.ConfigVersion,
            item.PreviousConfigVersion,
            item.Mode,
            item.PreviousMode,
            item.Status.ToString(),
            item.FailureReason,
            item.StartedAtUtc,
            item.CompletedAtUtc,
            item.ActivatedBy)).ToArray());
        return BinaryResults.Frame(aeds, AedsFrameType.ThemeActivationHistory, writer => PodBinaryCodec.WriteThemeActivationHistory(response, writer));
    }

    private static ThemeRegistryItemResponse ProjectTheme(ThemeRegistrySnapshot theme)
        => new(
            theme.Manifest.Id,
            theme.Manifest.Name,
            theme.Manifest.Version,
            theme.Manifest.Author,
            theme.Manifest.Description,
            theme.Manifest.Type,
            theme.InstallState.ToString(),
            theme.Enabled,
            theme.PackageHash,
            theme.PackageLocation,
            theme.InstalledAtUtc,
            theme.UpdatedAtUtc);

    private static ThemeActivationResponse ProjectActivation(ThemeActivationSnapshot activation)
        => new(
            activation.Scope.Value,
            activation.ActiveThemeId,
            activation.Mode,
            activation.ActivationId,
            activation.AssetVersion,
            activation.ConfigVersion,
            activation.UpdatedAtUtc);

    private static bool TryParseScope(string scope, out ThemeActivationScope parsedScope)
    {
        try
        {
            parsedScope = ThemeActivationScope.Parse(scope);
            return true;
        }
        catch (ArgumentException)
        {
            parsedScope = default;
            return false;
        }
    }

    private static IResult InvalidScope(IAedsEncoder aeds)
        => BinaryResults.FromError(
            ErrorDetail.Create(ErrorCode.Validation, "Theme activation scope is invalid.", "theme_activation_scope_invalid"),
            aeds,
            ApiErrorTransportMappingId.Default400Validation);
}
