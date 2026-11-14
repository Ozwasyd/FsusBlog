using System.Security.Cryptography;
using FsusBlog.V2.Core.Authentication;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed class TotpSecret(byte[] key)
{
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private const byte Version = 1;
    internal const int EnvelopeBytes = 1 + NonceBytes + Totp.SecretBytes + TagBytes;

    internal static TotpSecret? Read(IConfiguration configuration)
    {
        var value = configuration["FSUSBLOG_TOTP_KEY_HEX"];
        if (value is null) return null;
        if (value.Length != 64 || !value.All(char.IsAsciiHexDigit))
            throw new InvalidOperationException("FSUSBLOG_TOTP_KEY_HEX must encode a dedicated 32-byte secret.");
        return new(Convert.FromHexString(value));
    }

    internal byte[] Seal(Guid owner, ReadOnlySpan<byte> seed)
    {
        if (seed.Length != Totp.SecretBytes) throw new ArgumentException("Invalid TOTP seed length.", nameof(seed));
        var envelope = new byte[EnvelopeBytes];
        envelope[0] = Version;
        RandomNumberGenerator.Fill(envelope.AsSpan(1, NonceBytes));
        using var aes = new AesGcm(key, TagBytes);
        aes.Encrypt(envelope.AsSpan(1, NonceBytes), seed, envelope.AsSpan(1 + NonceBytes, Totp.SecretBytes),
            envelope.AsSpan(1 + NonceBytes + Totp.SecretBytes), AssociatedData(owner));
        return envelope;
    }

    internal byte[] Open(Guid owner, ReadOnlySpan<byte> envelope)
    {
        if (envelope.Length != EnvelopeBytes || envelope[0] != Version)
            throw new CryptographicException("Invalid TOTP secret envelope.");
        var seed = new byte[Totp.SecretBytes];
        using var aes = new AesGcm(key, TagBytes);
        aes.Decrypt(envelope.Slice(1, NonceBytes), envelope.Slice(1 + NonceBytes, Totp.SecretBytes),
            envelope[(1 + NonceBytes + Totp.SecretBytes)..], seed, AssociatedData(owner));
        return seed;
    }

    private static byte[] AssociatedData(Guid owner)
    {
        var data = new byte[17];
        data[0] = Version;
        owner.TryWriteBytes(data.AsSpan(1));
        return data;
    }
}
