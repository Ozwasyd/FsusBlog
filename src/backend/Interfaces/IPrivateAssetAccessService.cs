using System.Security.Claims;

using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Interfaces;

public readonly record struct PrivateAssetAccessPurpose
{
    private const int MaximumLength = 64;

    private PrivateAssetAccessPurpose(string value)
    {
        Value = value;
    }

    public string Value
    {
        get;
    }

    public static PrivateAssetAccessPurpose Parse(string value)
    {
        if (!TryParse(value, out PrivateAssetAccessPurpose purpose))
        {
            throw new ArgumentException("Private asset access purpose is invalid.", nameof(value));
        }

        return purpose;
    }

    public static bool TryParse(string? value, out PrivateAssetAccessPurpose purpose)
    {
        purpose = default;
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > MaximumLength
            || value.Contains('*', StringComparison.Ordinal)
            || value.Any(static character => !(character is >= 'a' and <= 'z'
                or >= '0' and <= '9'
                or '.'
                or '-')))
        {
            return false;
        }

        purpose = new PrivateAssetAccessPurpose(value);
        return true;
    }

    public override string ToString() => Value;
}

public enum PrivateAssetAuthorizationGrant
{
    Denied,
    Subject,
    Anonymous
}

public sealed record PrivateAssetAuthorizationContext(
    AssetId AssetId,
    PrivateAssetAccessPurpose Purpose,
    ClaimsPrincipal Principal,
    string? SubjectPrincipalId);

public interface IPrivateAssetAuthorizationPolicy
{
    PrivateAssetAccessPurpose Purpose
    {
        get;
    }

    ValueTask<PrivateAssetAuthorizationGrant> AuthorizeAsync(
        PrivateAssetAuthorizationContext context,
        CancellationToken cancellationToken = default);
}

public sealed record PrivateAssetTicketIssueResult(string Ticket, DateTimeOffset ExpiresAtUtc);

public interface IPrivateAssetAccessService
{
    Task<PrivateAssetTicketIssueResult?> IssueTicketAsync(
        AssetId assetId,
        PrivateAssetAccessPurpose purpose,
        ClaimsPrincipal principal,
        CancellationToken cancellationToken = default);
}

internal sealed record PrivateAssetAccessResult(PrivateAssetReadHandle Handle);

internal interface IPrivateAssetTicketRedemptionService
{
    Task<PrivateAssetAccessResult?> RedeemAsync(
        string ticket,
        ClaimsPrincipal principal,
        CancellationToken cancellationToken = default);
}

internal interface IPrivateAssetResponseWriter
{
    Task WriteAsync(
        HttpContext context,
        PrivateAssetReadHandle handle,
        CancellationToken cancellationToken = default);
}
