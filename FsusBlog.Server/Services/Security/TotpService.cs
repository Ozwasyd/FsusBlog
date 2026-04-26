using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Services.Security;

public interface ITotpService
{
    string GenerateSecret();
    string BuildOtpAuthUri(string issuer, string account, string secret);
    bool VerifyCode(string secretBase32, string code, int allowedDriftSteps = 1);
    IReadOnlyList<string> GenerateRecoveryCodes(int count = 8);
    string HashRecoveryCodes(IEnumerable<string> codes);
    bool TryConsumeRecoveryCode(string? storedHashes, string? inputCode, out string updatedHashes);
    string ProtectSecret(string plainSecret);
    string UnprotectSecret(string protectedSecret);
}

public sealed class TotpService(IDataProtectionProvider dataProtectionProvider) : ITotpService
{
    private const int SecretBytesLength = 20;
    private const int TimeStepSeconds = 30;
    private readonly IDataProtector _protector = dataProtectionProvider.CreateProtector("fsusblog.auth.totp.v1");

    public string GenerateSecret()
    {
        Span<byte> bytes = stackalloc byte[SecretBytesLength];
        RandomNumberGenerator.Fill(bytes);
        return Base32Encode(bytes);
    }

    public string BuildOtpAuthUri(string issuer, string account, string secret)
    {
        var safeIssuer = Uri.EscapeDataString(issuer);
        var safeAccount = Uri.EscapeDataString(account);
        return $"otpauth://totp/{safeIssuer}:{safeAccount}?secret={secret}&issuer={safeIssuer}&algorithm=SHA1&digits=6&period={TimeStepSeconds}";
    }

    public bool VerifyCode(string secretBase32, string code, int allowedDriftSteps = 1)
    {
        if (string.IsNullOrWhiteSpace(secretBase32) || string.IsNullOrWhiteSpace(code))
        {
            return false;
        }

        var sanitizedCode = new string(code.Where(char.IsDigit).ToArray());
        if (sanitizedCode.Length != 6)
        {
            return false;
        }

        byte[] secret = Base32Decode(secretBase32);
        long nowStep = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / TimeStepSeconds;

        for (int i = -allowedDriftSteps; i <= allowedDriftSteps; i++)
        {
            if (ComputeTotp(secret, nowStep + i) == sanitizedCode)
            {
                return true;
            }
        }

        return false;
    }

    public IReadOnlyList<string> GenerateRecoveryCodes(int count = 8)
    {
        if (count < 1)
        {
            return [];
        }

        var codes = new List<string>(count);
        byte[] random = new byte[8];
        for (int i = 0; i < count; i++)
        {
            RandomNumberGenerator.Fill(random);
            string code = Convert.ToHexString(random)[..10];
            codes.Add(code);
        }

        return codes;
    }

    public string HashRecoveryCodes(IEnumerable<string> codes)
    {
        var hashes = codes
            .Select(static c => HashRecoveryCode(c))
            .Where(static c => c.Length > 0)
            .ToArray();
        return string.Join('\n', hashes);
    }

    public bool TryConsumeRecoveryCode(string? storedHashes, string? inputCode, out string updatedHashes)
    {
        updatedHashes = storedHashes ?? string.Empty;
        if (string.IsNullOrWhiteSpace(storedHashes) || string.IsNullOrWhiteSpace(inputCode))
        {
            return false;
        }

        string codeHash = HashRecoveryCode(inputCode);
        if (codeHash.Length == 0)
        {
            return false;
        }

        var lines = storedHashes
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToList();

        int matchedIndex = lines.FindIndex(hash => CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(hash),
            Encoding.UTF8.GetBytes(codeHash)));
        if (matchedIndex < 0)
        {
            return false;
        }

        lines.RemoveAt(matchedIndex);
        updatedHashes = string.Join('\n', lines);
        return true;
    }

    public string ProtectSecret(string plainSecret)
        => _protector.Protect(plainSecret);

    public string UnprotectSecret(string protectedSecret)
        => _protector.Unprotect(protectedSecret);

    private static string HashRecoveryCode(string code)
    {
        string normalized = new string(code.Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(hash);
    }

    private static string ComputeTotp(byte[] secret, long timestep)
    {
        Span<byte> counter = stackalloc byte[8];
        for (int i = 7; i >= 0; i--)
        {
            counter[i] = (byte)(timestep & 0xFF);
            timestep >>= 8;
        }

        using var hmac = new HMACSHA1(secret);
        byte[] hash = hmac.ComputeHash(counter.ToArray());
        int offset = hash[^1] & 0x0F;
        int binary =
            ((hash[offset] & 0x7F) << 24) |
            (hash[offset + 1] << 16) |
            (hash[offset + 2] << 8) |
            hash[offset + 3];
        int otp = binary % 1_000_000;
        return otp.ToString("D6");
    }

    private static string Base32Encode(ReadOnlySpan<byte> data)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var output = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = data[0];
        int next = 1;
        int bitsLeft = 8;
        while (bitsLeft > 0 || next < data.Length)
        {
            if (bitsLeft < 5)
            {
                if (next < data.Length)
                {
                    buffer <<= 8;
                    buffer |= data[next++] & 0xFF;
                    bitsLeft += 8;
                }
                else
                {
                    int pad = 5 - bitsLeft;
                    buffer <<= pad;
                    bitsLeft += pad;
                }
            }

            int index = (buffer >> (bitsLeft - 5)) & 0x1F;
            bitsLeft -= 5;
            output.Append(alphabet[index]);
        }

        return output.ToString();
    }

    private static byte[] Base32Decode(string input)
    {
        string normalized = input.Trim().TrimEnd('=').ToUpperInvariant();
        if (normalized.Length == 0)
        {
            return [];
        }

        var result = new List<byte>(normalized.Length * 5 / 8);
        int buffer = 0;
        int bitsLeft = 0;
        foreach (char c in normalized)
        {
            int val = c switch
            {
                >= 'A' and <= 'Z' => c - 'A',
                >= '2' and <= '7' => c - '2' + 26,
                _ => -1
            };
            if (val < 0)
            {
                continue;
            }

            buffer <<= 5;
            buffer |= val & 0x1F;
            bitsLeft += 5;
            if (bitsLeft >= 8)
            {
                result.Add((byte)((buffer >> (bitsLeft - 8)) & 0xFF));
                bitsLeft -= 8;
            }
        }

        return [.. result];
    }
}
