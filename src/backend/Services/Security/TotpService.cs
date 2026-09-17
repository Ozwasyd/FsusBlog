using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using Konscious.Security.Cryptography;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Services.Security;

public interface ITotpService
{
    string GenerateSecret();
    string BuildOtpAuthUri(string issuer, string account, string secret);
    bool VerifyCode(string secretBase32, string code, int allowedDriftSteps = 1);
    bool TryVerifyCode(string secretBase32, string code, out long matchedStep, int allowedDriftSteps = 1);
    IReadOnlyList<string> GenerateRecoveryCodes(int count = 8);
    string HashRecoveryCodes(IEnumerable<string> codes);
    RecoveryCodeConsumeResult ConsumeRecoveryCode(string? storedHashes, string? inputCode);
    string ProtectSecret(string plainSecret);
    string UnprotectSecret(string protectedSecret);
}

public sealed record RecoveryCodeConsumeResult(
    bool Success,
    string UpdatedHashes,
    bool ConsumedLegacyHash,
    bool LegacyHashExpired,
    bool RequiresRecoveryCodeRegeneration);

public sealed class TotpService : ITotpService
{
    private const int SecretBytesLength = 20;
    private const int TimeStepSeconds = 30;
    private const int RecoveryCodeBytesLength = 16;
    private const int RecoveryCodeSaltBytesLength = 16;
    private const int RecoveryCodeHashBytesLength = 32;
    private const int RecoveryCodeArgon2MemoryKib = 64 * 1024;
    private const int RecoveryCodeArgon2Iterations = 3;
    private const int RecoveryCodeArgon2Parallelism = 4;
    public const short CurrentRecoveryCodeHashVersion = 3;
    private static readonly DateTimeOffset s_legacyRecoveryCodeDeadlineUtc = new(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
    private readonly IDataProtector _protector;
    private readonly TimeProvider _timeProvider;
    private readonly RecoveryCodeHashPolicy _recoveryCodeHashPolicy;

    public TotpService(IDataProtectionProvider dataProtectionProvider, TimeProvider timeProvider)
        : this(dataProtectionProvider, timeProvider, RecoveryCodeHashPolicy.Production)
    {
    }

    internal TotpService(
        IDataProtectionProvider dataProtectionProvider,
        TimeProvider timeProvider,
        RecoveryCodeHashPolicy recoveryCodeHashPolicy)
    {
        _protector = dataProtectionProvider.CreateProtector("fsusblog.auth.totp.v1");
        _timeProvider = timeProvider;
        _recoveryCodeHashPolicy = recoveryCodeHashPolicy;
    }

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
        => TryVerifyCode(secretBase32, code, out _, allowedDriftSteps);

    public bool TryVerifyCode(string secretBase32, string code, out long matchedStep, int allowedDriftSteps = 1)
    {
        matchedStep = -1;
        if (string.IsNullOrWhiteSpace(secretBase32) || string.IsNullOrWhiteSpace(code))
        {
            return false;
        }

        string sanitizedCode = SanitizeTotpCode(code);
        if (sanitizedCode.Length != 6)
        {
            return false;
        }

        byte[] secret = Base32Decode(secretBase32);
        long nowStep = _timeProvider.GetUtcNow().ToUnixTimeSeconds() / TimeStepSeconds;

        for (int i = -allowedDriftSteps; i <= allowedDriftSteps; i++)
        {
            long candidateStep = nowStep + i;
            if (FixedTimeEquals(ComputeTotp(secret, candidateStep), sanitizedCode))
            {
                matchedStep = candidateStep;
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
        Span<byte> random = stackalloc byte[RecoveryCodeBytesLength];
        for (int i = 0; i < count; i++)
        {
            RandomNumberGenerator.Fill(random);
            string hex = Convert.ToHexString(random);
            codes.Add(string.Join('-', Enumerable.Range(0, hex.Length / 4).Select(index => hex.Substring(index * 4, 4))));
        }

        return codes;
    }

    public string HashRecoveryCodes(IEnumerable<string> codes)
    {
        var hashes = codes
            .Select(HashRecoveryCode)
            .Where(static c => c.Length > 0)
            .ToArray();
        return string.Join('\n', hashes);
    }

    public RecoveryCodeConsumeResult ConsumeRecoveryCode(string? storedHashes, string? inputCode)
    {
        string initialHashes = storedHashes ?? string.Empty;
        if (string.IsNullOrWhiteSpace(storedHashes) || string.IsNullOrWhiteSpace(inputCode))
        {
            return new RecoveryCodeConsumeResult(false, initialHashes, false, false, false);
        }

        string normalized = SanitizeRecoveryCode(inputCode);
        if (normalized.Length == 0)
        {
            return new RecoveryCodeConsumeResult(false, initialHashes, false, false, false);
        }

        var lines = storedHashes
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToList();

        int matchedIndex = -1;
        bool consumedLegacyHash = false;
        bool legacyHashExpired = false;
        for (int index = 0; index < lines.Count; index++)
        {
            RecoveryCodeHashVerification verification = VerifyRecoveryCodeHash(lines[index], normalized, _timeProvider.GetUtcNow());
            if (verification.LegacyHashExpired)
            {
                legacyHashExpired = true;
            }

            if (verification.Success)
            {
                matchedIndex = index;
                consumedLegacyHash = verification.LegacyHash;
                break;
            }
        }

        if (matchedIndex < 0)
        {
            return new RecoveryCodeConsumeResult(false, initialHashes, false, legacyHashExpired, false);
        }

        lines.RemoveAt(matchedIndex);
        string updatedHashes = string.Join('\n', lines);
        return new RecoveryCodeConsumeResult(
            true,
            updatedHashes,
            consumedLegacyHash,
            false,
            consumedLegacyHash);
    }

    public string ProtectSecret(string plainSecret)
        => _protector.Protect(plainSecret);

    public string UnprotectSecret(string protectedSecret)
        => _protector.Unprotect(protectedSecret);

    private string HashRecoveryCode(string code)
    {
        string normalized = SanitizeRecoveryCode(code);
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        byte[] salt = RandomNumberGenerator.GetBytes(RecoveryCodeSaltBytesLength);
        byte[] hash = ComputeArgon2idHash(normalized, salt, _recoveryCodeHashPolicy);
        return $"v3$argon2id$m={_recoveryCodeHashPolicy.MemoryKib},t={_recoveryCodeHashPolicy.Iterations},p={_recoveryCodeHashPolicy.Parallelism}${Convert.ToHexString(salt)}${Convert.ToHexString(hash)}";
    }

    private RecoveryCodeHashVerification VerifyRecoveryCodeHash(string storedHash, string normalizedCode, DateTimeOffset nowUtc)
    {
        if (storedHash.StartsWith("v3$argon2id$", StringComparison.Ordinal))
        {
            string[] parts = storedHash.Split('$');
            if (parts.Length != 5 ||
                !string.Equals(parts[2], $"m={_recoveryCodeHashPolicy.MemoryKib},t={_recoveryCodeHashPolicy.Iterations},p={_recoveryCodeHashPolicy.Parallelism}", StringComparison.Ordinal) ||
                !TryDecodeHex(parts[3], RecoveryCodeSaltBytesLength, out byte[] salt) ||
                !TryDecodeHex(parts[4], RecoveryCodeHashBytesLength, out byte[] expectedHash))
            {
                return RecoveryCodeHashVerification.Failed;
            }

            byte[] actualHash = ComputeArgon2idHash(normalizedCode, salt, _recoveryCodeHashPolicy);
            return RecoveryCodeHashVerification.FromSuccess(CryptographicOperations.FixedTimeEquals(actualHash, expectedHash), legacyHash: false);
        }

        if (nowUtc >= s_legacyRecoveryCodeDeadlineUtc)
        {
            return RecoveryCodeHashVerification.ExpiredLegacy;
        }

        byte[] legacyHash = SHA256.HashData(Encoding.UTF8.GetBytes(normalizedCode));
        string legacyHex = Convert.ToHexString(legacyHash);
        return RecoveryCodeHashVerification.FromSuccess(
            FixedTimeEqualsHash(storedHash, Encoding.UTF8.GetBytes(legacyHex)),
            legacyHash: true);
    }

    private static byte[] ComputeArgon2idHash(string normalizedCode, byte[] salt, RecoveryCodeHashPolicy policy)
    {
        var argon = new Argon2id(Encoding.UTF8.GetBytes(normalizedCode))
        {
            Salt = salt,
            MemorySize = policy.MemoryKib,
            Iterations = policy.Iterations,
            DegreeOfParallelism = policy.Parallelism
        };
        return argon.GetBytes(RecoveryCodeHashBytesLength);
    }

    private static bool TryDecodeHex(string value, int expectedBytes, out byte[] bytes)
    {
        bytes = [];
        if (value.Length != expectedBytes * 2)
        {
            return false;
        }

        try
        {
            bytes = Convert.FromHexString(value);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string ComputeTotp(byte[] secret, long timestep)
    {
        Span<byte> counter = stackalloc byte[8];
        for (int i = 7; i >= 0; i--)
        {
            counter[i] = (byte)(timestep & 0xFF);
            timestep >>= 8;
        }

        Span<byte> hash = stackalloc byte[20];
        HMACSHA1.HashData(secret, counter, hash);
        int offset = hash[^1] & 0x0F;
        int binary =
            ((hash[offset] & 0x7F) << 24) |
            (hash[offset + 1] << 16) |
            (hash[offset + 2] << 8) |
            hash[offset + 3];
        int otp = binary % 1_000_000;
        return otp.ToString("D6", CultureInfo.InvariantCulture);
    }

    private static string SanitizeTotpCode(string code)
    {
        Span<char> digits = stackalloc char[6];
        int written = 0;
        foreach (char ch in code)
        {
            if (!char.IsDigit(ch))
            {
                continue;
            }

            if (written >= digits.Length)
            {
                return string.Empty;
            }

            digits[written++] = ch;
        }

        return written == digits.Length ? new string(digits) : string.Empty;
    }

    private static string SanitizeRecoveryCode(string code)
    {
        Span<char> chars = stackalloc char[64];
        int written = 0;
        foreach (char ch in code)
        {
            if (!char.IsLetterOrDigit(ch))
            {
                continue;
            }

            if (written >= chars.Length)
            {
                return string.Empty;
            }

            chars[written++] = char.ToUpperInvariant(ch);
        }

        return written == 0 ? string.Empty : new string(chars[..written]);
    }

    private static bool FixedTimeEqualsHash(string storedHash, ReadOnlySpan<byte> codeHashBytes)
    {
        if (storedHash.Length != codeHashBytes.Length)
        {
            return false;
        }

        Span<byte> storedHashBytes = stackalloc byte[64];
        Encoding.UTF8.GetBytes(storedHash.AsSpan(), storedHashBytes);
        return CryptographicOperations.FixedTimeEquals(storedHashBytes, codeHashBytes);
    }

    private static bool FixedTimeEquals(string expected, string actual)
    {
        Span<byte> expectedBytes = stackalloc byte[6];
        Span<byte> actualBytes = stackalloc byte[6];
        if (Encoding.ASCII.GetBytes(expected.AsSpan(), expectedBytes) != 6 ||
            Encoding.ASCII.GetBytes(actual.AsSpan(), actualBytes) != 6)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    private readonly record struct RecoveryCodeHashVerification(bool Success, bool LegacyHash, bool LegacyHashExpired)
    {
        public static RecoveryCodeHashVerification Failed => new(false, false, false);
        public static RecoveryCodeHashVerification ExpiredLegacy => new(false, true, true);

        public static RecoveryCodeHashVerification FromSuccess(bool success, bool legacyHash)
            => success ? new RecoveryCodeHashVerification(true, legacyHash, false) : Failed;
    }

    internal readonly record struct RecoveryCodeHashPolicy(int MemoryKib, int Iterations, int Parallelism)
    {
        public static RecoveryCodeHashPolicy Production => new(
            RecoveryCodeArgon2MemoryKib,
            RecoveryCodeArgon2Iterations,
            RecoveryCodeArgon2Parallelism);
    }

    private static string Base32Encode(ReadOnlySpan<byte> data)
    {
        const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
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
            output.Append(Alphabet[index]);
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
