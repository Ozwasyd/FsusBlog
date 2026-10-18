using System.Collections.Immutable;
using System.Globalization;

using FsusBlog.Server.Infrastructure.Fonts;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Maps an explicitly selected frozen installed batch to the existing export asset
/// contract. RequiredFonts remains the sole tuple authority. This mapper neither
/// chooses fallback fonts nor qualifies font decoding, glyph coverage or rendering.
/// </summary>
public static class DocumentExportFontMapper
{
    public static async Task<ImmutableArray<DocumentExportAsset>> ReadAsync(
        IFontByteSource source,
        IReadOnlyList<FontFaceReadRequest> selection,
        long maximumBytes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(selection);
        FontFaceReadRequest[] frozen = selection.ToArray();
        IReadOnlyList<DocumentExportRequiredFont> required = DocumentExportReadingStyleAuthority.RequiredFonts;
        if (frozen.Length != required.Count || frozen.Any(static request => request is null)
            || required.Any(tuple => frozen.Count(request => request.Family == tuple.Family
                && request.Weight == tuple.Weight && request.Style == tuple.Style) != 1))
        {
            throw new FontRegistryException("export_font_tuple_set_invalid", "Export requires exactly the authoritative font tuples.");
        }

        IReadOnlyList<FontRegistryFaceBytes> faces = await source.ReadFaceBytesAsync(
            frozen, maximumBytes, cancellationToken).ConfigureAwait(false);
        if (faces.Count != frozen.Length || frozen.Any(request => faces.Count(face => face.Identity == request) != 1))
        {
            throw new FontRegistryException("export_font_identity_invalid", "Font byte results differ from the frozen selection.");
        }

        return required.Select((tuple, index) =>
        {
            FontRegistryFaceBytes face = faces.Single(face => face.Identity.Family == tuple.Family
                && face.Identity.Weight == tuple.Weight && face.Identity.Style == tuple.Style);
            if (face.Bytes.IsDefaultOrEmpty || DocumentExportDigest.ComputeBytes(face.Bytes.AsSpan()) != $"sha256:{face.Identity.ContentHash}")
            {
                throw new FontRegistryException("export_font_identity_invalid", "Font byte result integrity is invalid.");
            }

            return new DocumentExportAsset(
                $"font-{(index + 1).ToString(CultureInfo.InvariantCulture)}", "font/woff2",
                $"sha256:{face.Identity.ContentHash}", face.Bytes, string.Empty, "font",
                face.Identity.Family, face.Identity.Weight, face.Identity.Style);
        }).ToImmutableArray();
    }
}
