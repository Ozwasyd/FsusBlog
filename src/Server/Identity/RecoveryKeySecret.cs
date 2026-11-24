namespace FsusBlog.V2.Server.Passkeys;

internal sealed class RecoveryKeySecret(byte[] pepper)
{
    internal const string KeySetting = "FSUSBLOG_RECOVERY_KEY_PEPPER_HEX";
    private const int Iterations = 600_000;
    internal record Generated(string Key, byte[] Lookup, byte[] Salt, byte[] Verifier);

    internal static RecoveryKeySecret? Read(IConfiguration configuration)
    {
        var value = configuration[KeySetting];
        if (value is null) return null;
        if (value.Length != 64 || !value.All(char.IsAsciiHexDigit))
            throw new InvalidOperationException(KeySetting + " must encode a dedicated 32-byte secret.");
        if (string.Equals(value, configuration["FSUSBLOG_TOTP_KEY_HEX"], StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(KeySetting + " and the TOTP key must differ.");
        return new(Convert.FromHexString(value));
    }

    internal Generated Generate()
    {
        var selector = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        var key = "frk_" + selector + "_" + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var salt = RandomNumberGenerator.GetBytes(16);
        return new(key, Lookup(key), salt, Derive(key, salt));
    }

    internal byte[] Lookup(string key) => HMACSHA256.HashData(pepper, Encoding.ASCII.GetBytes("recovery-key-lookup:" + key[4..36]));

    internal bool Verify(string key, byte[] salt, byte[] expected)
    {
        var actual = Derive(key, salt);
        try { return CryptographicOperations.FixedTimeEquals(actual, expected); }
        finally { CryptographicOperations.ZeroMemory(actual); }
    }

    private byte[] Derive(string key, byte[] salt)
    {
        Span<byte> prehash = stackalloc byte[32];
        Span<byte> encoded = stackalloc byte[key.Length];
        Encoding.ASCII.GetBytes(key, encoded);
        try
        {
            HMACSHA256.HashData(pepper, encoded, prehash);
            return Rfc2898DeriveBytes.Pbkdf2(prehash, salt, Iterations, HashAlgorithmName.SHA256, 32);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(prehash);
            CryptographicOperations.ZeroMemory(encoded);
        }
    }
}
