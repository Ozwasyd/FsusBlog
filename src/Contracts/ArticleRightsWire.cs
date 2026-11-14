namespace FsusBlog.V2.Contracts;

public sealed record PublishedArticleRights(long SnapshotId, ArticleRightsPolicy Policy);

public static partial class Wire
{
    public static ArticleRightsPolicy RightsPolicy(ArticleRightsCommand input, long revision) => new(
        input.Id, revision, true, input.Enabled, input.LicenseType, input.CopyrightHolder, input.CopyrightYear,
        input.RightsStatement, input.AttributionTemplate, input.CopyPolicy, input.MaxExcerptChars,
        input.AllowCodeCopy, input.ShowPublicBadge, input.ProofBindingEnabled);

    public static ArticleRightsPolicy DefaultRights(int id, long revision) => new(id, revision, true,
        true, "all-rights-reserved", "", 0, "", "", "append-attribution", 300, true, true, true);

    public static ArticleRightsPolicy MissingRights(int id, long revision) => new(id, revision, false,
        false, "", "", 0, "", "", "", 0, false, false, false);

    internal static void Validate(ArticleRightsCommand value)
    {
        if (value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid rights command");
        Validate(RightsPolicy(value, value.ExpectedRevision));
    }

    public static void Validate(ArticleRightsPolicy value)
    {
        if (value.Id <= 0 || value.Revision <= 0)
            throw new ProtocolException("Invalid article rights coordinates");
        if (!value.Present)
        {
            if (value != MissingRights(value.Id, value.Revision))
                throw new ProtocolException("An absent policy cannot carry rights values");
            return;
        }
        if (value.LicenseType is not ("all-rights-reserved" or "CC-BY-4.0" or "CC-BY-SA-4.0" or "CC-BY-NC-4.0" or "CC0-1.0") ||
            value.CopyPolicy is not ("append-attribution" or "excerpt-only" or "disabled") ||
            value.CopyrightYear != 0 && value.CopyrightYear is < 1000 or > 9999 ||
            value.MaxExcerptChars is < 0 or > 10000 ||
            !ValidText(value.CopyrightHolder, 256, false) ||
            !ValidText(value.RightsStatement, 4000, true) || !ValidText(value.AttributionTemplate, 4000, true))
            throw new ProtocolException("Invalid article rights policy");
    }

    private static bool ValidText(string value, int max, bool multiline) =>
        value.Length <= max && value == value.Trim() &&
        !value.Any(character => char.IsControl(character) && (!multiline || character is not ('\r' or '\n' or '\t')));
}
