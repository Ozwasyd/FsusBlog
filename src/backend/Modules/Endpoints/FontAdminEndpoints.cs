using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Shared.Contracts.Outputs;

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
        [FromServices] IFontRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken);
        var response = new FontRegistryListResponse(snapshot.Fonts.Select(ProjectFont).ToArray());
        return BinaryResults.Frame(aeds, AedsFrameType.FontRegistryList, writer => PodBinaryCodec.WriteFontRegistryList(response, writer));
    }

    private static async Task<IResult> GetFontAsync(
        string fontId,
        [FromServices] IFontRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken);
        FontRegistryEntry? font = snapshot.Fonts.FirstOrDefault(
            f => string.Equals(f.Id, fontId, StringComparison.Ordinal));
        if (font is null)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.NotFound, "Font was not found.", "font_not_found"),
                aeds);
        }

        var response = new FontRegistryDetailResponse(
            ProjectFont(font),
            font.LicenseText,
            font.LicenseSourceJson,
            font.ManifestJson,
            font.Faces.Select(static face => new FontFaceResponse(
                face.Weight,
                face.Style,
                face.FilePath,
                face.ContentHash,
                face.SizeBytes,
                face.UnicodeRange,
                face.Critical,
                face.FontDisplay)).ToArray());
        return BinaryResults.Frame(aeds, AedsFrameType.FontRegistryDetail, writer => PodBinaryCodec.WriteFontRegistryDetail(response, writer));
    }

    private static async Task<IResult> ListActivationsAsync(
        [FromServices] IFontRegistry registry,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken);
        var response = new FontActivationListResponse(snapshot.Activations.Select(static activation => new FontActivationResponse(
            activation.Scope,
            activation.UiFontId,
            activation.ProseFontId,
            activation.CodeFontId,
            activation.CjkFontId,
            activation.EmojiFontId,
            activation.ConfigVersion,
            activation.UpdatedAt)).ToArray());
        return BinaryResults.Frame(aeds, AedsFrameType.FontActivationList, writer => PodBinaryCodec.WriteFontActivationList(response, writer));
    }

    private static FontRegistryItemResponse ProjectFont(FontRegistryEntry font)
        => new(
            font.Id,
            font.Name,
            font.Family,
            font.Category,
            font.Version,
            font.InstallState,
            font.Enabled,
            font.BuiltIn,
            font.Faces.Count,
            font.Faces.Count(static face => face.Critical),
            font.Faces.Sum(static face => face.SizeBytes),
            font.InstalledAt,
            font.UpdatedAt);
}
