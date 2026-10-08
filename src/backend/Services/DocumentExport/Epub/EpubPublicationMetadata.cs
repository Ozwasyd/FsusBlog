using System.Collections.Immutable;
using System.Globalization;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Explicit publication-only projection supplied by the frozen metadata owner.
/// Its canonical digest must equal the existing input MetadataDigest; this is
/// neither a task schema nor a metadata resolver. No owner or database facts are exported.
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
            || Language.Split('-')[0].Length is < 2 or > 8
            || !Language.Split('-')[0].All(char.IsAsciiLetter)
            || !Language.Split('-').All(part => part.Length is > 0 and <= 8 && part.All(char.IsAsciiLetterOrDigit))
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
}
