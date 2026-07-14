using System.Text;

namespace FsusBlog.Server.Infrastructure.PublicAot;

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
}
