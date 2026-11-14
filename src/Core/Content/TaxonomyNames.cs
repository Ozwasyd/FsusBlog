using System.Text;

namespace FsusBlog.V2.Core.Content;

public static class TaxonomyNames
{
    // v1 normalizes both the active display name and each previously used URL name.
    public static string? TagLookupKey(string? name)
    {
        if (name is null || name.Length > 256 || name.Any(char.IsControl))
            return null;

        try
        {
            var display = name.Trim().Normalize(NormalizationForm.FormC);
            return display.Length == 0 || display.EnumerateRunes().Count() > 128 ? null : display.ToUpperInvariant();
        }
        catch (ArgumentException)
        {
            return null;
        }
    }
}
