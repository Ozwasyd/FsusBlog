using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core;

public sealed class SubscriptionIdentity
{
    public const string KeySetting = "FSUSBLOG_SUBSCRIPTION_HMAC_KEY";
    public const int EmailLimit = 254;
    public const int ProofLength = 64;
    public const short RssChannel = 1;
    public const short EmailChannel = 2;
    public static readonly TimeSpan ProofLifetime = TimeSpan.FromMinutes(15);

    private readonly byte[] _key;

    private SubscriptionIdentity(byte[] key) => _key = key;

    public static SubscriptionIdentity? Read(string? setting)
    {
        if (string.IsNullOrEmpty(setting)) return null;
        if (!IsHex(setting) || setting.All(character => character == setting[0]))
            throw new InvalidOperationException($"{KeySetting} must contain a random 32-byte key as 64 lowercase hexadecimal characters.");
        return new(Convert.FromHexString(setting));
    }

    public byte[]? EmailKey(string email)
    {
        var address = email.Trim(' ');
        if (address.Length is < 5 or > EmailLimit || address.Any(character => !char.IsAscii(character))) return null;
        var at = address.IndexOf('@');
        if (at is < 1 or > 64 || at != address.LastIndexOf('@')) return null;
        var local = address[..at];
        var domain = address[(at + 1)..];
        if (local.StartsWith('.') || local.EndsWith('.') || local.Contains("..", StringComparison.Ordinal) ||
            !local.All(character => char.IsAsciiLetterOrDigit(character) || ".!#$%&'*+-/=?^_`{|}~".Contains(character))) return null;
        var labels = domain.Split('.');
        if (labels.Length < 2 || !labels.All(label => label.Length is >= 1 and <= 63 && !label.StartsWith('-') && !label.EndsWith('-') &&
            label.All(character => char.IsAsciiLetterOrDigit(character) || character == '-'))) return null;

        var utf8 = Encoding.ASCII.GetBytes("fsusblog:site-subscription:email:v1:" + address.ToLowerInvariant());
        try { return HMACSHA256.HashData(_key, utf8); }
        finally { CryptographicOperations.ZeroMemory(utf8); }
    }

    public static byte[]? ProofDigest(string? proof)
    {
        if (proof is null || !IsHex(proof)) return null;
        Span<byte> secret = stackalloc byte[32];
        try
        {
            Convert.FromHexString(proof.AsSpan(), secret, out _, out _);
            return SHA256.HashData(secret);
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }

    private static bool IsHex(string value) => value.Length == ProofLength && value.All(char.IsAsciiHexDigitLower);
}
