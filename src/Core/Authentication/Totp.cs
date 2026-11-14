using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core.Authentication;

public static class Totp
{
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    public const int SecretBytes = 20;
    public const int Digits = 6;
    public const int StepSeconds = 30;

    public static bool IsCode(string code) => code.Length == Digits && code.All(char.IsAsciiDigit);

    public static long? Match(ReadOnlySpan<byte> secret, string code, DateTimeOffset now, long lastUsed)
    {
        if (secret.Length != SecretBytes || !IsCode(code)) return null;
        Span<byte> supplied = stackalloc byte[Digits];
        Encoding.ASCII.GetBytes(code, supplied);
        Span<byte> expected = stackalloc byte[Digits];
        var step = now.ToUnixTimeSeconds() / StepSeconds;
        long? matched = null;
        for (var candidate = Math.Max(0, step - 1); candidate <= step + 1; candidate++)
        {
            WriteCode(secret, candidate, expected);
            if (CryptographicOperations.FixedTimeEquals(expected, supplied) && candidate > lastUsed) matched = candidate;
        }
        return matched;
    }

    public static string EncodeSecret(ReadOnlySpan<byte> secret)
    {
        if (secret.Length != SecretBytes) throw new ArgumentException("Invalid TOTP seed length.", nameof(secret));
        Span<char> text = stackalloc char[SecretBytes * 8 / 5];
        var written = 0;
        var bits = 0;
        var value = 0;
        foreach (var octet in secret)
        {
            value = (value << 8) | octet;
            bits += 8;
            while (bits >= 5)
            {
                bits -= 5;
                text[written++] = Alphabet[(value >> bits) & 31];
            }
        }
        return new string(text);
    }

    private static void WriteCode(ReadOnlySpan<byte> secret, long counter, Span<byte> code)
    {
        Span<byte> input = stackalloc byte[8];
        Span<byte> mac = stackalloc byte[20];
        BinaryPrimitives.WriteInt64BigEndian(input, counter);
        HMACSHA1.HashData(secret, input, mac);
        var int31 = BinaryPrimitives.ReadUInt32BigEndian(mac[(mac[^1] & 15)..]) & 0x7fff_ffff;
        for (var i = code.Length - 1; i >= 0; i--)
        {
            code[i] = (byte)('0' + int31 % 10);
            int31 /= 10;
        }
    }
}
