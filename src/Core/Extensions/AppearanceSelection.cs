using System.Globalization;
using System.Text;

namespace FsusBlog.V2.Core.Extensions;

public sealed record AppearancePackage(string Id, string Version, string ArchiveDigest, bool Font);
public sealed record AppearanceSelection(string ThemeDigest = "", string FontDigest = "");

public sealed partial class AppearanceRegistry
{
    public AppearanceSelection Default => new(_theme?.Trust.Source.ArchiveSha256 ?? "", _font?.Trust.Source.ArchiveSha256 ?? "");

    public IReadOnlyList<AppearancePackage> Available() => _entries.Values.Where(Current)
        .OrderBy(item => item.Id, StringComparer.Ordinal)
        .Select(item => new AppearancePackage(item.Id, item.Version, item.Trust.Source.ArchiveSha256, item is Font))
        .ToArray();

    public bool IsCurrent(AppearanceSelection selection)
        => Resolve(selection.ThemeDigest, false, out _) && Resolve(selection.FontDigest, true, out _);

    public byte[]? SelectedStyle(AppearanceSelection selection, long activation)
    {
        if (!Resolve(selection.ThemeDigest, false, out var theme) || !Resolve(selection.FontDigest, true, out var font))
            return null;
        var versionPrefix = activation.ToString(CultureInfo.InvariantCulture) + "/";
        return Encoding.UTF8.GetBytes(ThemeCss((Theme?)theme) + FontCss((Font?)font, versionPrefix));
    }

    public byte[]? SelectedFont(AppearanceSelection selection, string digest)
    {
        if (!Resolve(selection.ThemeDigest, false, out _) || !Resolve(selection.FontDigest, true, out var font) ||
            font is not Font selected || selected.Hash != digest) return null;
        return selected.Bytes.ToArray();
    }

    private bool Resolve(string digest, bool isFont, out Entry? selected)
    {
        selected = null;
        if (digest.Length == 0) return true;
        selected = _entries.Values.FirstOrDefault(item => item.Trust.Source.ArchiveSha256 == digest && (item is Font) == isFont);
        return selected is not null && Current(selected);
    }
}
