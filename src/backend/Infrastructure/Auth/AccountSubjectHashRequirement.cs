using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>
/// Enforces the post-cutover account subject invariant at runtime boundaries.
/// Account subjects are SHA-256 digests produced from stable anonymous-account
/// identity material; callers must fail closed instead of deriving from account id.
/// </summary>
public static class AccountSubjectHashRequirement
{
    public const int Sha256HexLength = 64;

    public static bool TryResolve(string? value, out string accountSubjectHash)
    {
        accountSubjectHash = TextHelpers.LowerTrimmed(value) ?? string.Empty;
        return accountSubjectHash.Length == Sha256HexLength
            && accountSubjectHash.All(static character => char.IsAsciiHexDigit(character));
    }

    public static string Require(string? value, string boundary)
    {
        if (TryResolve(value, out string accountSubjectHash))
        {
            return accountSubjectHash;
        }

        throw new InvalidOperationException(
            $"A stable account subject hash is required at boundary '{boundary}'.");
    }
}
