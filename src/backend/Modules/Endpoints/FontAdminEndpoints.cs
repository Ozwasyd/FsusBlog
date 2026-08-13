using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Infrastructure.Results;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

public static class FontAdminEndpoints
{
    public static IEndpointRouteBuilder MapFontAdminEndpoints(
        this IEndpointRouteBuilder app)
    {
        RouteGroupBuilder group = app.MapGroup("/api/binary/author/ops/fonts")
            .WithTags("FontAdmin")
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        group.MapGet("/registry", ListFontsAsync);
        group.MapGet("/registry/{fontId}", GetFontAsync);
        group.MapGet("/activations", ListActivationsAsync);
        return app;
    }

    private static async Task<IResult> ListFontsAsync(
        IAedsEncoder aeds,
        [FromServices] IFontRegistry registry,
        CancellationToken cancellationToken)
    {
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken);
        return AedsJsonResults.Ok(aeds, AedsFrameType.FontAdminSnapshot, snapshot.Fonts.Select(f => new
        {
            fontId = f.Id,
            f.Name,
            f.Family,
            f.Category,
            f.Version,
            installState = f.InstallState,
            f.Enabled,
            f.BuiltIn,
            faceCount = f.Faces.Count,
            criticalFaceCount = f.Faces.Count(face => face.Critical),
            totalSizeBytes = f.Faces.Sum(face => face.SizeBytes),
            f.InstalledAt,
            f.UpdatedAt
        }));
    }

    private static async Task<IResult> GetFontAsync(
        string fontId,
        IAedsEncoder aeds,
        [FromServices] IFontRegistry registry,
        CancellationToken cancellationToken)
    {
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken);
        FontRegistryEntry? font = snapshot.Fonts.FirstOrDefault(
            f => string.Equals(f.Id, fontId, StringComparison.Ordinal));
        if (font is null)
            return AedsJsonResults.NotFound(aeds, "font_not_found");

        return AedsJsonResults.Ok(aeds, AedsFrameType.FontAdminSnapshot, new
        {
            fontId = font.Id,
            font.Name,
            font.Family,
            font.Category,
            font.Version,
            installState = font.InstallState,
            font.Enabled,
            font.BuiltIn,
            font.LicenseText,
            font.LicenseSourceJson,
            font.ManifestJson,
            font.InstalledAt,
            font.UpdatedAt,
            faces = font.Faces.Select(face => new
            {
                face.Weight,
                face.Style,
                face.FilePath,
                face.ContentHash,
                face.SizeBytes,
                face.UnicodeRange,
                face.Critical,
                face.FontDisplay
            }),
            totalSizeBytes = font.Faces.Sum(f => f.SizeBytes)
        });
    }

    private static async Task<IResult> ListActivationsAsync(
        IAedsEncoder aeds,
        [FromServices] IFontRegistry registry,
        CancellationToken cancellationToken)
    {
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken);
        return AedsJsonResults.Ok(aeds, AedsFrameType.FontAdminSnapshot, snapshot.Activations.Select(a => new
        {
            a.Scope,
            a.UiFontId,
            a.ProseFontId,
            a.CodeFontId,
            a.CjkFontId,
            a.EmojiFontId,
            a.ConfigVersion,
            a.UpdatedAt
        }));
    }
}
