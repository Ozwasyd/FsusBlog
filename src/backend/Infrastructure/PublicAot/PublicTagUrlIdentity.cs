using System.Text;

using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal readonly record struct CanonicalTagIdentity(int? TagId, string? Description);

internal static class PublicTagUrlIdentity
{
    internal static string NormalizeDisplayName(string value)
        => (value ?? string.Empty).Trim().Normalize(NormalizationForm.FormC);

    internal static string NormalizeLookupKey(string value)
        => NormalizeDisplayName(value).ToUpperInvariant();

    internal static bool IsNameRouteKey(string routeKey)
        => (routeKey ?? string.Empty).StartsWith(
            string.Concat(FsusBlog.Shared.Contracts.Outputs.PublicRouteIdentityRegistry.TagNameBucket, ":"),
            StringComparison.OrdinalIgnoreCase);

    internal static int? MatchCanonicalTagId(
        IReadOnlyList<(int Id, string Name)> tags,
        IReadOnlyList<(string NormalizedName, int TagId)> aliases,
        string name)
    {
        string lookupKey = NormalizeLookupKey(name);
        if (lookupKey.Length == 0)
        {
            return null;
        }

        int[] matches = tags
            .Where(tag => string.Equals(NormalizeLookupKey(tag.Name), lookupKey, StringComparison.Ordinal))
            .Select(tag => tag.Id)
            .Where(static id => id > 0)
            .Distinct()
            .Take(2)
            .ToArray();
        if (matches.Length == 1)
        {
            return matches[0];
        }

        if (matches.Length > 1)
        {
            return null;
        }

        int[] aliasMatches = aliases
            .Where(alias => string.Equals(alias.NormalizedName, lookupKey, StringComparison.Ordinal))
            .Select(alias => alias.TagId)
            .Where(static id => id > 0)
            .Distinct()
            .Take(2)
            .ToArray();
        return aliasMatches.Length == 1 ? aliasMatches[0] : null;
    }

    internal static async Task<int?> ResolveCanonicalTagIdAsync(
        ISqlSugarClient db,
        string name,
        CancellationToken cancellationToken)
        => (await ResolveCanonicalTagIdentityAsync(db, name, cancellationToken)).TagId;

    internal static async Task<CanonicalTagIdentity> ResolveCanonicalTagIdentityAsync(
        ISqlSugarClient db,
        string name,
        CancellationToken cancellationToken)
    {
        string normalizedName = NormalizeDisplayName(name);
        if (normalizedName.Length == 0)
        {
            return new CanonicalTagIdentity(null, null);
        }

        string lookupKey = NormalizeLookupKey(normalizedName);
        List<Tag> tags = await db.Queryable<Tag>().ToListAsync(cancellationToken);
        Tag[] normalizedMatches = tags
            .Where(tag => tag.Id > 0
                && string.Equals(NormalizeLookupKey(tag.Name), lookupKey, StringComparison.Ordinal))
            .DistinctBy(static tag => tag.Id)
            .Take(2)
            .ToArray();
        if (normalizedMatches.Length == 1)
        {
            Tag match = normalizedMatches[0];
            return new CanonicalTagIdentity(match.Id, match.Description);
        }

        if (normalizedMatches.Length > 1)
        {
            return new CanonicalTagIdentity(null, null);
        }

        Tag? aliasMatch = await db.Queryable<TagUrlAlias>()
            .Where(alias => alias.NormalizedName == lookupKey)
            .InnerJoin<Tag>((alias, tag) => alias.TagId == tag.Id)
            .Select((alias, tag) => new Tag
            {
                Id = tag.Id,
                Name = tag.Name,
                Description = tag.Description
            })
            .FirstAsync(cancellationToken);
        return aliasMatch is null
            ? new CanonicalTagIdentity(null, null)
            : new CanonicalTagIdentity(aliasMatch.Id, aliasMatch.Description);
    }
}
