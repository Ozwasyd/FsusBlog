using System.Collections.Immutable;
using System.Globalization;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Explicit publication-only projection supplied by the frozen metadata owner.
/// Its canonical digest must equal the existing input MetadataDigest; this is
/// neither a task schema nor a metadata resolver. No owner or database facts are exported.
/// Language uses a closed language, optional script/region, unique variants policy;
/// extension, private-use, extlang and grandfathered tags are not supported.
/// </summary>
public sealed record EpubPublicationMetadata(
    string Title,
    string Language,
    string Direction,
    ImmutableArray<string> Authors,
    string Identifier,
    string Modified)
{
    /// <summary>Returns the existing canonical digest of this immutable projection.</summary>
    public string ComputeFrozenDigest() => DocumentExportDigest.Compute(this);

    internal void Validate(DocumentExportFrozenInput input)
    {
        if (Authors.IsDefault || Authors.Length > 32
            || !ValidText(Title, 512)
            || Authors.Any(author => !ValidText(author, 512))
            || Authors.Distinct(StringComparer.Ordinal).Count() != Authors.Length
            || Language != input.Locale
            || !ValidText(Language, 64)
            || !ValidLanguage(Language)
            || Direction is not ("ltr" or "rtl")
            || !Identifier.StartsWith("urn:uuid:", StringComparison.Ordinal)
            || !Guid.TryParseExact(Identifier[9..], "D", out Guid identifier)
            || identifier == Guid.Empty
            || Identifier != $"urn:uuid:{identifier:D}"
            || !DateTimeOffset.TryParseExact(Modified, "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out _)
            || ComputeFrozenDigest() != input.MetadataDigest)
        {
            throw new InvalidDataException("EPUB publication metadata is missing, malformed or not frozen by the input owner.");
        }
    }

    private static bool ValidText(string value, int maximumLength)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && !value.Any(char.IsControl);

    private static bool ValidLanguage(string value)
    {
        string[] parts = value.Split('-');
        if (parts[0].Length is < 2 or > 8 || !parts[0].All(char.IsAsciiLetter))
        {
            return false;
        }
        int index = 1;
        if (index < parts.Length && parts[index].Length == 4 && parts[index].All(char.IsAsciiLetter))
        {
            index++;
        }
        if (index < parts.Length && (parts[index].Length == 2 && parts[index].All(char.IsAsciiLetter)
            || parts[index].Length == 3 && parts[index].All(char.IsAsciiDigit)))
        {
            index++;
        }
        var variants = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (; index < parts.Length; index++)
        {
            string variant = parts[index];
            if (!(variant.Length is >= 5 and <= 8 || variant.Length == 4 && char.IsAsciiDigit(variant[0]))
                || !variant.All(char.IsAsciiLetterOrDigit) || !variants.Add(variant))
            {
                return false;
            }
        }
        return true;
    }
}
