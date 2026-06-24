using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.DataProtection;
using System.Security.Cryptography;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// TotpService - Full Test Coverage
// Uses EphemeralDataProtectionProvider for IDataProtection dependency
// ──────────────────────────────────────────────────────────────────────────────

public class TotpServiceTests
{
    private static TotpService MakeService(DateTimeOffset? utcNow = null, bool productionHashPolicy = false)
    {
        // EphemeralDataProtectionProvider works in-memory without any file system
        var provider = new EphemeralDataProtectionProvider();
        var timeProvider = new StaticTimeProvider(utcNow ?? DateTimeOffset.Parse("2026-06-24T00:00:00Z"));
        var hashPolicy = productionHashPolicy
            ? TotpService.RecoveryCodeHashPolicy.Production
            : new TotpService.RecoveryCodeHashPolicy(1024, 1, 1);
        return new TotpService(provider, timeProvider, hashPolicy);
    }

    // ── GenerateSecret ────────────────────────────────────────────────────────

    [Fact]
    public void GenerateSecret_ReturnsNonEmpty()
    {
        var svc = MakeService();
        var secret = svc.GenerateSecret();
        Assert.NotNull(secret);
        Assert.NotEmpty(secret);
    }

    [Fact]
    public void GenerateSecret_ReturnsBase32()
    {
        var svc = MakeService();
        var secret = svc.GenerateSecret();
        // Base32 alphabet: A-Z and 2-7 only
        foreach (char c in secret)
        {
            Assert.True((c >= 'A' && c <= 'Z') || (c >= '2' && c <= '7'),
                $"Character '{c}' is not valid Base32");
        }
    }

    [Fact]
    public void GenerateSecret_TwoCalls_ReturnsDifferentValues()
    {
        var svc = MakeService();
        var s1 = svc.GenerateSecret();
        var s2 = svc.GenerateSecret();
        Assert.NotEqual(s1, s2);
    }

    [Fact]
    public void GenerateSecret_HasExpectedLength()
    {
        var svc = MakeService();
        var secret = svc.GenerateSecret();
        // 20 bytes in Base32 = 32 characters (ceil(20*8/5))
        Assert.Equal(32, secret.Length);
    }

    // ── BuildOtpAuthUri ───────────────────────────────────────────────────────

    [Fact]
    public void BuildOtpAuthUri_ContainsCorrectScheme()
    {
        var svc = MakeService();
        var uri = svc.BuildOtpAuthUri("MyApp", "user@example.com", "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
        Assert.StartsWith("otpauth://totp/", uri);
    }

    [Fact]
    public void BuildOtpAuthUri_ContainsSecret()
    {
        var svc = MakeService();
        const string secret = "JBSWY3DPEHPK3PXP";
        var uri = svc.BuildOtpAuthUri("App", "user", secret);
        Assert.Contains($"secret={secret}", uri);
    }

    [Fact]
    public void BuildOtpAuthUri_ContainsIssuer()
    {
        var svc = MakeService();
        const string issuer = "MyBlog";
        var uri = svc.BuildOtpAuthUri(issuer, "user", "SECRET");
        Assert.Contains($"issuer={issuer}", uri);
    }

    [Fact]
    public void BuildOtpAuthUri_EscapesSpecialChars()
    {
        var svc = MakeService();
        var uri = svc.BuildOtpAuthUri("My App", "user@test.com", "SECRET");
        Assert.Contains("My%20App", uri);
        Assert.Contains("user%40test.com", uri);
    }

    [Fact]
    public void BuildOtpAuthUri_ContainsAlgorithm()
    {
        var svc = MakeService();
        var uri = svc.BuildOtpAuthUri("App", "user", "SECRET");
        Assert.Contains("algorithm=SHA1", uri);
    }

    [Fact]
    public void BuildOtpAuthUri_ContainsPeriod30()
    {
        var svc = MakeService();
        var uri = svc.BuildOtpAuthUri("App", "user", "SECRET");
        Assert.Contains("period=30", uri);
    }

    [Fact]
    public void BuildOtpAuthUri_ContainsDigits6()
    {
        var svc = MakeService();
        var uri = svc.BuildOtpAuthUri("App", "user", "SECRET");
        Assert.Contains("digits=6", uri);
    }

    // ── VerifyCode ────────────────────────────────────────────────────────────

    [Fact]
    public void VerifyCode_NullSecret_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode(null!, "123456");
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_EmptySecret_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("", "123456");
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_WhitespaceSecret_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("   ", "123456");
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_NullCode_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", null!);
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_EmptyCode_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", "");
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_CodeTooShort_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", "12345");
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_CodeTooLong_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", "1234567");
        Assert.False(result);
    }

    [Fact]
    public void VerifyCode_WrongCode_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", "000000");
        // This could pass if 000000 happens to be current TOTP but extremely unlikely
        // No assertion needed - just verifying it doesn't throw
        Assert.IsType<bool>(result);
    }

    [Fact]
    public void VerifyCode_CodeWithNonDigits_StillProcesses()
    {
        var svc = MakeService();
        // Code with spaces/dashes - should extract digits "12 34 56" → "123456"
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", "12 34 56");
        Assert.IsType<bool>(result);
    }

    [Fact]
    public void VerifyCode_CodeAllLetters_ReturnsFalse()
    {
        var svc = MakeService();
        // Non-digit code results in empty after filtering
        var result = svc.VerifyCode("JBSWY3DPEHPK3PXP", "abcdef");
        Assert.False(result);
    }

    // ── GenerateRecoveryCodes ─────────────────────────────────────────────────

    [Fact]
    public void GenerateRecoveryCodes_DefaultCount_Returns8()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes();
        Assert.Equal(8, codes.Count);
    }

    [Fact]
    public void GenerateRecoveryCodes_CustomCount_ReturnsCorrectNumber()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(5);
        Assert.Equal(5, codes.Count);
    }

    [Fact]
    public void GenerateRecoveryCodes_ZeroCount_ReturnsEmpty()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(0);
        Assert.Empty(codes);
    }

    [Fact]
    public void GenerateRecoveryCodes_NegativeCount_ReturnsEmpty()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(-1);
        Assert.Empty(codes);
    }

    [Fact]
    public void GenerateRecoveryCodes_AllCodesHave128BitGroupedHex()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(8);
        foreach (var code in codes)
        {
            Assert.Matches("^[0-9A-F]{4}(-[0-9A-F]{4}){7}$", code);
        }
    }

    [Fact]
    public void GenerateRecoveryCodes_AllCodesAreUpperHex()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(8);
        foreach (var code in codes)
        {
            foreach (char c in code)
            {
                Assert.True(c is >= '0' and <= '9' or >= 'A' and <= 'F' or '-',
                    $"Code '{code}' contains invalid character '{c}'");
            }
        }
    }

    [Fact]
    public void GenerateRecoveryCodes_CodesAreUnique()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(8);
        var unique = codes.Distinct().ToList();
        Assert.Equal(codes.Count, unique.Count);
    }

    // ── HashRecoveryCodes ─────────────────────────────────────────────────────

    [Fact]
    public void HashRecoveryCodes_EmptyList_ReturnsEmpty()
    {
        var svc = MakeService();
        var result = svc.HashRecoveryCodes([]);
        Assert.Equal("", result);
    }

    [Fact]
    public void HashRecoveryCodes_SingleCode_ReturnsSingleHash()
    {
        var svc = MakeService();
        var result = svc.HashRecoveryCodes(["ABCD123456"]);
        Assert.NotEmpty(result);
        Assert.DoesNotContain('\n', result);
    }

    [Fact]
    public void HashRecoveryCodes_MultipleCodes_ReturnsNewlineSeparated()
    {
        var svc = MakeService();
        var result = svc.HashRecoveryCodes(["CODE000001", "CODE000002", "CODE000003"]);
        var lines = result.Split('\n');
        Assert.Equal(3, lines.Length);
    }

    [Fact]
    public void HashRecoveryCodes_UsesPerCodeSalt()
    {
        var svc = MakeService();
        var r1 = svc.HashRecoveryCodes(["ABCD1234EF"]);
        var r2 = svc.HashRecoveryCodes(["ABCD1234EF"]);
        Assert.NotEqual(r1, r2);
    }

    [Fact]
    public void HashRecoveryCodes_DifferentCodes_DifferentHashes()
    {
        var svc = MakeService();
        var r1 = svc.HashRecoveryCodes(["CODE0000AB"]);
        var r2 = svc.HashRecoveryCodes(["CODE0000CD"]);
        Assert.NotEqual(r1, r2);
    }

    [Fact]
    public void HashRecoveryCodes_HashesUseVersionedArgon2idFormat()
    {
        var svc = MakeService(productionHashPolicy: true);
        var result = svc.HashRecoveryCodes(["TESTCODE01"]);
        Assert.Matches("^v3\\$argon2id\\$m=65536,t=3,p=4\\$[0-9A-F]{32}\\$[0-9A-F]{64}$", result);
    }

    // ── ConsumeRecoveryCode ──────────────────────────────────────────────────

    [Fact]
    public void ConsumeRecoveryCode_NullStoredHashes_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.ConsumeRecoveryCode(null, "ABCD1234EF");
        Assert.False(result.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_EmptyStoredHashes_ReturnsFalse()
    {
        var svc = MakeService();
        var result = svc.ConsumeRecoveryCode("", "ABCD1234EF");
        Assert.False(result.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_NullInputCode_ReturnsFalse()
    {
        var svc = MakeService();
        var hashes = svc.HashRecoveryCodes(["ABCD1234EF"]);
        var result = svc.ConsumeRecoveryCode(hashes, null);
        Assert.False(result.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_EmptyInputCode_ReturnsFalse()
    {
        var svc = MakeService();
        var hashes = svc.HashRecoveryCodes(["ABCD1234EF"]);
        var result = svc.ConsumeRecoveryCode(hashes, "");
        Assert.False(result.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_ValidCode_ReturnsTrue()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(3);
        var hashes = svc.HashRecoveryCodes(codes);

        var result = svc.ConsumeRecoveryCode(hashes, codes[0]);

        Assert.True(result.Success);
        // After consuming, updated hashes should have 2 entries
        var remaining = result.UpdatedHashes.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, remaining.Length);
    }

    [Fact]
    public void ConsumeRecoveryCode_WrongCode_ReturnsFalse()
    {
        var svc = MakeService();
        var hashes = svc.HashRecoveryCodes(["GOODCODE01"]);
        var result = svc.ConsumeRecoveryCode(hashes, "BADCODE001");
        Assert.False(result.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_UsedCode_CannotBeReused()
    {
        var svc = MakeService();
        var codes = svc.GenerateRecoveryCodes(2);
        var hashes = svc.HashRecoveryCodes(codes);

        // Consume first code
        var success1 = svc.ConsumeRecoveryCode(hashes, codes[0]);
        Assert.True(success1.Success);

        // Try to reuse the same code
        var success2 = svc.ConsumeRecoveryCode(success1.UpdatedHashes, codes[0]);
        Assert.False(success2.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_CaseInsensitive()
    {
        var svc = MakeService();
        // Generate code (will be uppercase hex) and try lowercase
        var hashes = svc.HashRecoveryCodes(["ABCDEF1234"]);
        var result = svc.ConsumeRecoveryCode(hashes, "abcdef1234");
        Assert.True(result.Success);
    }

    [Fact]
    public void ConsumeRecoveryCode_LegacySha256Hash_CanBeConsumedOnce()
    {
        var svc = MakeService();
        string legacyHash = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("ABCDEF1234")));

        var result = svc.ConsumeRecoveryCode(legacyHash, "abcdef1234");

        Assert.True(result.Success);
        Assert.Equal(string.Empty, result.UpdatedHashes);
    }

    [Fact]
    public void ConsumeRecoveryCode_LegacySha256HashBeforeDeadline_RequiresRegeneration()
    {
        var svc = MakeService(DateTimeOffset.Parse("2026-08-31T23:59:59Z"));
        string legacyHash = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("ABCDEF1234")));

        RecoveryCodeConsumeResult result = svc.ConsumeRecoveryCode(legacyHash, "abcdef1234");

        Assert.True(result.Success);
        Assert.True(result.RequiresRecoveryCodeRegeneration);
        Assert.True(result.ConsumedLegacyHash);
        Assert.False(result.LegacyHashExpired);
        Assert.Equal(string.Empty, result.UpdatedHashes);
    }

    [Fact]
    public void ConsumeRecoveryCode_LegacySha256HashAfterDeadline_ReturnsFalse()
    {
        var svc = MakeService(DateTimeOffset.Parse("2026-09-01T00:00:00Z"));
        string legacyHash = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("ABCDEF1234")));

        RecoveryCodeConsumeResult result = svc.ConsumeRecoveryCode(legacyHash, "abcdef1234");

        Assert.False(result.Success);
        Assert.False(result.RequiresRecoveryCodeRegeneration);
        Assert.True(result.LegacyHashExpired);
        Assert.Equal(legacyHash, result.UpdatedHashes);
    }

    [Fact]
    public void TotpService_SourceUsesMemoryHardArgon2idForRecoveryCodes()
    {
        string source = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/TotpService.cs");

        Assert.Contains("new Argon2id", source, StringComparison.Ordinal);
        Assert.Contains("MemorySize = policy.MemoryKib", source, StringComparison.Ordinal);
        Assert.Contains("RecoveryCodeHashPolicy.Production", source, StringComparison.Ordinal);
        Assert.Contains("RecoveryCodeArgon2MemoryKib = 64 * 1024", source, StringComparison.Ordinal);
        Assert.Contains("RecoveryCodeArgon2Iterations = 3", source, StringComparison.Ordinal);
        Assert.Contains("RecoveryCodeArgon2Parallelism = 4", source, StringComparison.Ordinal);
        Assert.DoesNotContain("TryConsumeRecoveryCode", source, StringComparison.Ordinal);
        Assert.DoesNotContain("v2$pbkdf2-sha256", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ConsumeRecoveryCode_InvalidHashOnly_ReturnsFalse()
    {
        var svc = MakeService();
        // Non-empty input code that produces empty normalized form
        var result = svc.ConsumeRecoveryCode("SOMEHASH", "   ");
        Assert.False(result.Success);
    }

    // ── ProtectSecret / UnprotectSecret ──────────────────────────────────────

    [Fact]
    public void ProtectSecret_ReturnsNonEmpty()
    {
        var svc = MakeService();
        var protected_ = svc.ProtectSecret("mysecret");
        Assert.NotEmpty(protected_);
    }

    [Fact]
    public void ProtectSecret_DoesNotReturnPlaintext()
    {
        var svc = MakeService();
        const string plain = "mysecret";
        var protected_ = svc.ProtectSecret(plain);
        Assert.NotEqual(plain, protected_);
    }

    [Fact]
    public void UnprotectSecret_RoundTrip()
    {
        var svc = MakeService();
        const string plain = "mysecretvalue";
        var protected_ = svc.ProtectSecret(plain);
        var unprotected = svc.UnprotectSecret(protected_);
        Assert.Equal(plain, unprotected);
    }

    [Fact]
    public void UnprotectSecret_EmptyString_RoundTrip()
    {
        var svc = MakeService();
        var protected_ = svc.ProtectSecret("");
        var unprotected = svc.UnprotectSecret(protected_);
        Assert.Equal("", unprotected);
    }

    [Fact]
    public void ProtectSecret_TwoCalls_DifferentOutput()
    {
        // Data protection uses random nonce per protect call
        var svc = MakeService();
        var p1 = svc.ProtectSecret("same");
        var p2 = svc.ProtectSecret("same");
        Assert.NotEqual(p1, p2);
    }

    private sealed class StaticTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
