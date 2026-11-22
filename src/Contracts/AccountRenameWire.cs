using System.Text;

namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private const long MaxAccountRenameUnixMs = 8_640_000_000_000_000L;

    public static bool ValidAdminHandle(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > WireLimits.AdminHandleBytes) return false;
        var first = value[0];
        if (first is < 'a' or > 'z') return false;
        for (var i = 1; i < value.Length; i++)
        {
            var c = value[i];
            if (c is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '_' and not '.' and not '-')
                return false;
        }
        return true;
    }

    public static bool ValidSiteDisplayName(string? value)
    {
        if (string.IsNullOrEmpty(value) || value != value.Trim()) return false;
        var runes = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            if (Rune.IsControl(rune)) return false;
            runes++;
            if (runes > WireLimits.SiteDisplayNameChars) return false;
        }
        return runes > 0 && Encoding.UTF8.GetByteCount(value) <= WireLimits.PublicCommentHandleBytes;
    }

    internal static void Validate(SiteDisplayNameState value)
    {
        if (value is null || value.DisplayName is null)
            throw new ProtocolException("Invalid site display name state.");
        if (value.DisplayName.Length > 0 && !ValidSiteDisplayName(value.DisplayName))
            throw new ProtocolException("Invalid site display name state.");
    }

    internal static void Validate(SiteDisplayNameCommand value)
    {
        if (value is null || !ValidSiteDisplayName(value.DisplayName))
            throw new ProtocolException("Invalid site display name command.");
    }

    internal static void Validate(AdminHandleCommand value)
    {
        if (value is null || value.IdempotencyKey == Guid.Empty ||
            !ValidAdminHandle(value.ExpectedHandle) || !ValidAdminHandle(value.NewHandle) ||
            string.Equals(value.ExpectedHandle, value.NewHandle, StringComparison.Ordinal))
            throw new ProtocolException("Invalid administrator handle rename command.");
    }

    internal static void Validate(AdminHandleReceipt value)
    {
        if (value is null || !ValidAdminHandle(value.Handle) ||
            value.HappenedAtUnixMs <= 0 || value.HappenedAtUnixMs > MaxAccountRenameUnixMs)
            throw new ProtocolException("Invalid administrator handle rename receipt.");
    }
}
