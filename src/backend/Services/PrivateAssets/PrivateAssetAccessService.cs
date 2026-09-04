using System.Globalization;
using System.Security.Claims;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Services.PrivateAssets;

internal sealed class PrivateAssetAccessService(
    IPrivateAssetStore store,
    IEnumerable<IPrivateAssetAuthorizationPolicy> policies,
    PrivateAssetTicketService tickets) : IPrivateAssetAccessService
{
    public async Task<PrivateAssetTicketIssueResult?> IssueTicketAsync(
        AssetId assetId,
        PrivateAssetAccessPurpose purpose,
        ClaimsPrincipal principal,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(principal);
        IPrivateAssetAuthorizationPolicy? policy = FindUniquePolicy(purpose);
        if (policy is null)
        {
            return null;
        }

        await using PrivateAssetReadHandle? handle = await store.ValidateAsync(assetId, cancellationToken);
        if (handle is null)
        {
            return null;
        }

        string? subject = ResolveSubjectPrincipalId(principal);
        PrivateAssetAuthorizationGrant grant = await policy.AuthorizeAsync(
            new PrivateAssetAuthorizationContext(assetId, purpose, principal, subject),
            cancellationToken);
        if (!GrantMatches(grant, subject))
        {
            return null;
        }

        return tickets.Protect(
            assetId,
            purpose,
            grant == PrivateAssetAuthorizationGrant.Anonymous ? null : subject);
    }

    public async Task<PrivateAssetAccessResult?> RedeemAsync(
        string ticket,
        ClaimsPrincipal principal,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(principal);
        if (!tickets.TryUnprotect(ticket, out PrivateAssetTicketPayload? payload) || payload is null)
        {
            return null;
        }

        string? subject = ResolveSubjectPrincipalId(principal);
        if (payload.SubjectPrincipalId is not null
            && !CryptographicEquals(payload.SubjectPrincipalId, subject))
        {
            return null;
        }

        IPrivateAssetAuthorizationPolicy? policy = FindUniquePolicy(payload.Purpose);
        if (policy is null)
        {
            return null;
        }

        PrivateAssetReadHandle? validated = await store.ValidateAsync(
            payload.AssetId,
            cancellationToken);
        if (validated is null)
        {
            return null;
        }

        PrivateAssetAuthorizationGrant grant = await policy.AuthorizeAsync(
            new PrivateAssetAuthorizationContext(
                payload.AssetId,
                payload.Purpose,
                principal,
                subject),
            cancellationToken);
        if (payload.SubjectPrincipalId is null
            ? grant != PrivateAssetAuthorizationGrant.Anonymous
            : grant != PrivateAssetAuthorizationGrant.Subject)
        {
            await validated.DisposeAsync();
            return null;
        }

        return new PrivateAssetAccessResult(validated);
    }

    internal static string? ResolveSubjectPrincipalId(ClaimsPrincipal principal)
    {
        if (principal.IsAdminPrincipal() && principal.TryGetAdminPrincipalId(out long adminId))
        {
            return $"admin:{adminId.ToString(CultureInfo.InvariantCulture)}";
        }

        long? userId = FastUserIdProvider.TryParseUserId(principal);
        return userId.HasValue
            ? $"user:{userId.Value.ToString(CultureInfo.InvariantCulture)}"
            : null;
    }

    private IPrivateAssetAuthorizationPolicy? FindUniquePolicy(PrivateAssetAccessPurpose purpose)
    {
        IPrivateAssetAuthorizationPolicy? match = null;
        foreach (IPrivateAssetAuthorizationPolicy policy in policies)
        {
            if (policy.Purpose != purpose)
            {
                continue;
            }

            if (match is not null)
            {
                return null;
            }

            match = policy;
        }

        return match;
    }

    private static bool GrantMatches(PrivateAssetAuthorizationGrant grant, string? subject)
        => grant == PrivateAssetAuthorizationGrant.Anonymous
            || grant == PrivateAssetAuthorizationGrant.Subject && subject is not null;

    private static bool CryptographicEquals(string expected, string? actual)
    {
        if (actual is null)
        {
            return false;
        }

        byte[] expectedBytes = System.Text.Encoding.UTF8.GetBytes(expected);
        byte[] actualBytes = System.Text.Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length
            && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }
}
