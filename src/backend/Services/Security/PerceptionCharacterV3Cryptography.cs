using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Services.Security;

public sealed record PerceptionCharacterV3ProtocolContract(
    string Enum, string WireName, string Algorithm, byte Version,
    PerceptionCharacterV3AnswerContract Answer, PerceptionCharacterV3CryptoContract Cryptography,
    PerceptionCharacterV3RasterContract Raster);
public sealed record PerceptionCharacterV3AnswerContract(string Alphabet, int Length, int RejectionByteLimitExclusive);
public sealed record PerceptionCharacterV3CryptoContract(string AnswerDomain, int KeyBytes, int NonceBytes, int TagBytes);
public sealed record PerceptionCharacterV3RasterContract(
    int PhysicalWidth, int PhysicalHeight, int DisplayWidth, int DisplayHeight, int GlyphVariantsPerSymbol,
    Dictionary<string, string[]> GlyphAtlasBaseRows, int[][][] GlyphVariantOffsets,
    PerceptionIntRange TranslationX, PerceptionIntRange TranslationY, PerceptionIntRange RotationDegrees,
    PerceptionDoubleRange ShearX, PerceptionDoubleRange ScaleX, PerceptionDoubleRange ScaleY,
    PerceptionIntRange BaselineOffsetPixels, PerceptionIntRange OverlapPixels,
    PerceptionDisplacementContract Displacement, PerceptionCurveContract InterferenceCurves,
    PerceptionOccluderContract Occluders, PerceptionNoiseContract Noise);
public sealed record PerceptionIntRange(int Min, int Max);
public sealed record PerceptionDoubleRange(double Min, double Max);
public sealed record PerceptionDisplacementContract(int LatticeColumns, int LatticeRows, int ComponentMinPixels, int ComponentMaxPixels);
public sealed record PerceptionCurveContract(int MinCount, int MaxCount, int MinWidthPixels, int MaxWidthPixels, int MinGray, int MaxGray);
public sealed record PerceptionOccluderContract(int MinCount, int MaxCount, int MinWidthPixels, int MaxWidthPixels, int MinHeightPixels, int MaxHeightPixels, int MinGray, int MaxGray);
public sealed record PerceptionNoiseContract(int AdditiveAmplitude, int MinImpulseCount, int MaxImpulseCount);

public static class PerceptionCharacterV3CanonicalContract
{
    private static readonly Lazy<PerceptionCharacterV3ProtocolContract> s_value = new(LoadCore, LazyThreadSafetyMode.ExecutionAndPublication);
    public static PerceptionCharacterV3ProtocolContract Value => s_value.Value;

    private static PerceptionCharacterV3ProtocolContract LoadCore()
    {
        using Stream stream = typeof(PerceptionCharacterV3CanonicalContract).Assembly
            .GetManifestResourceStream("FsusBlog.PerceptionCharacterV3.Contract.json")
            ?? throw new InvalidOperationException("Canonical PerceptionCharacterV3 contract resource is missing.");
        return JsonSerializer.Deserialize<PerceptionCharacterV3ProtocolContract>(stream,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("Canonical PerceptionCharacterV3 contract is invalid.");
    }
}

public sealed record PerceptionCharacterV3BindingContext(
    string ChallengeId, string EnvelopeId, string Action, string RouteKey, string SubjectHash,
    string DeviceBindingHash, string ClientIpBindingHash, string PolicyVersion, string ArtifactHash,
    string Representation, string MediaType, ushort PhysicalWidth, ushort PhysicalHeight, ushort DisplayWidth, ushort DisplayHeight,
    long IssuedAtUnixMs, long ExpiresAtUnixMs, string TokenKeyVersion);

public sealed record PerceptionCharacterV3State(
    byte[] AnswerTag, string ArtifactHash, string MediaType, ushort PhysicalWidth, ushort PhysicalHeight, ushort DisplayWidth, ushort DisplayHeight,
    string ChallengeId, string EnvelopeId, string Action, string RouteKey,
    string SubjectHash, string DeviceBindingHash, string ClientIpBindingHash, string PolicyVersion, byte AttemptBudget,
    string Representation, long IssuedAtUnixMs, long ExpiresAtUnixMs, string TokenKeyVersion, string AnswerKeyVersion);

public interface IPerceptionCharacterV3NonceSource
{
    void Fill(Span<byte> destination);
}
public sealed class PerceptionCharacterV3RandomNonceSource : IPerceptionCharacterV3NonceSource
{
    public void Fill(Span<byte> destination) => RandomNumberGenerator.Fill(destination);
}

public static class PerceptionCharacterV3Crypto
{
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    public static string DeriveDeviceBinding(byte[] answerKey, string trustedMaterial)
    {
        ArgumentNullException.ThrowIfNull(answerKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(trustedMaterial);
        return Convert.ToHexStringLower(HMACSHA256.HashData(
            answerKey,
            s_utf8.GetBytes("fsus.perception-character.device\0" + trustedMaterial)));
    }

    public static string? NormalizeAnswer(string? value)
    {
        PerceptionCharacterV3ProtocolContract contract = PerceptionCharacterV3CanonicalContract.Value;
        var builder = new StringBuilder(value?.Length ?? 0);
        foreach (char ch in value ?? string.Empty)
        {
            if (ch is >= '\u0009' and <= '\u000d' or '\u0020')
                continue;
            builder.Append(ch is >= 'a' and <= 'z' ? (char)(ch - 32) : ch);
        }
        string result = builder.ToString();
        return result.Length == contract.Answer.Length && result.All(ch => contract.Answer.Alphabet.Contains(ch, StringComparison.Ordinal)) ? result : null;
    }

    public static string SampleAnswer(Func<int, byte[]> readBytes)
    {
        PerceptionCharacterV3ProtocolContract contract = PerceptionCharacterV3CanonicalContract.Value;
        Span<char> answer = stackalloc char[contract.Answer.Length];
        int written = 0;
        while (written < answer.Length)
        {
            byte[] sample = readBytes(1);
            if (sample.Length != 1)
                throw new InvalidOperationException("Random source returned an invalid byte count.");
            if (sample[0] < contract.Answer.RejectionByteLimitExclusive)
                answer[written++] = contract.Answer.Alphabet[sample[0] % contract.Answer.Alphabet.Length];
        }
        return new string(answer);
    }

    public static string SampleAnswer()
        => SampleAnswer(static count => RandomNumberGenerator.GetBytes(count));

    public static byte[] EncodeLp(params ReadOnlyMemory<byte>[] fields)
    {
        if (fields.Length > ushort.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(fields));
        int length = 2 + fields.Sum(static field => checked(4 + field.Length));
        byte[] result = GC.AllocateUninitializedArray<byte>(length);
        Span<byte> span = result;
        BinaryPrimitives.WriteUInt16BigEndian(span, checked((ushort)fields.Length));
        int offset = 2;
        foreach (ReadOnlyMemory<byte> field in fields)
        {
            BinaryPrimitives.WriteUInt32BigEndian(span[offset..], checked((uint)field.Length));
            offset += 4;
            field.Span.CopyTo(span[offset..]);
            offset += field.Length;
        }
        return result;
    }

    public static byte[] EncodeAnswerMaterial(PerceptionCharacterV3BindingContext context, string answer)
    {
        string normalized = NormalizeAnswer(answer) ?? throw new ArgumentException("Answer normalization failed.", nameof(answer));
        return EncodeAnswerMaterial(context, Encoding.ASCII.GetBytes(normalized));
    }

    private static byte[] EncodeAnswerMaterial(PerceptionCharacterV3BindingContext context, ReadOnlySpan<byte> normalizedAnswer)
    {
        PerceptionCharacterV3ProtocolContract c = PerceptionCharacterV3CanonicalContract.Value;
        if (normalizedAnswer.Length != c.Answer.Length ||
            normalizedAnswer.IndexOfAnyExcept(Encoding.ASCII.GetBytes(c.Answer.Alphabet)) >= 0)
            throw new ArgumentException("Normalized answer bytes are invalid.", nameof(normalizedAnswer));
        return EncodeLp(Utf8(c.Cryptography.AnswerDomain), new byte[] { c.Version }, Utf8(context.ChallengeId), Utf8(context.EnvelopeId),
            Utf8(context.Action), Utf8(context.RouteKey), Hex32(context.SubjectHash), Hex32(context.DeviceBindingHash),
            Utf8(context.PolicyVersion), Hex32(context.ArtifactHash), Ascii(context.Representation), Ascii(context.MediaType),
            UInt16(context.PhysicalWidth), UInt16(context.PhysicalHeight), UInt16(context.DisplayWidth), UInt16(context.DisplayHeight),
            normalizedAnswer.ToArray());
    }

    public static byte[] ComputeAnswerTag(ReadOnlySpan<byte> key, PerceptionCharacterV3BindingContext context, string answer)
    {
        RequireKey(key);
        byte[] material = EncodeAnswerMaterial(context, answer);
        try
        {
            return HMACSHA256.HashData(key, material);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(material);
        }
    }

    internal static byte[] ComputeAnswerTag(
        ReadOnlySpan<byte> key,
        PerceptionCharacterV3BindingContext context,
        ReadOnlySpan<byte> normalizedAnswer)
    {
        RequireKey(key);
        byte[] material = EncodeAnswerMaterial(context, normalizedAnswer);
        try
        {
            return HMACSHA256.HashData(key, material);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(material);
        }
    }

    public static bool FixedTimeTagEquals(ReadOnlySpan<byte> left, ReadOnlySpan<byte> right)
    {
        Span<byte> a = stackalloc byte[32];
        Span<byte> b = stackalloc byte[32];
        left[..Math.Min(left.Length, 32)].CopyTo(a);
        right[..Math.Min(right.Length, 32)].CopyTo(b);
        return CryptographicOperations.FixedTimeEquals(a, b) && left.Length == 32 && right.Length == 32;
    }

    public static byte[] EncodeAad(PerceptionCharacterV3BindingContext x)
    {
        PerceptionCharacterV3ProtocolContract c = PerceptionCharacterV3CanonicalContract.Value;
        return EncodeLp(Ascii(c.Enum), Ascii(c.WireName), Ascii(c.Algorithm), new byte[] { c.Version }, Utf8(x.ChallengeId), Utf8(x.EnvelopeId),
            Utf8(x.Action), Utf8(x.RouteKey), Hex32(x.ArtifactHash), Ascii(x.Representation), Ascii(x.MediaType),
            UInt16(x.PhysicalWidth), UInt16(x.PhysicalHeight), UInt16(x.DisplayWidth), UInt16(x.DisplayHeight),
            Int64(x.IssuedAtUnixMs), Int64(x.ExpiresAtUnixMs), Ascii(x.TokenKeyVersion));
    }

    public static byte[] EncodeState(PerceptionCharacterV3State x)
    {
        if (x.AnswerTag.Length != 32)
            throw new ArgumentException("Answer tag must be 32 bytes.");
        return EncodeLp(x.AnswerTag, Hex32(x.ArtifactHash), Ascii(x.MediaType),
            UInt16(x.PhysicalWidth), UInt16(x.PhysicalHeight), UInt16(x.DisplayWidth), UInt16(x.DisplayHeight),
            Utf8(x.ChallengeId), Utf8(x.EnvelopeId), Utf8(x.Action), Utf8(x.RouteKey),
            Hex32(x.SubjectHash), Hex32(x.DeviceBindingHash), Hex32(x.ClientIpBindingHash), Utf8(x.PolicyVersion), new byte[] { x.AttemptBudget },
            Ascii(x.Representation), Int64(x.IssuedAtUnixMs), Int64(x.ExpiresAtUnixMs), Ascii(x.TokenKeyVersion), Ascii(x.AnswerKeyVersion));
    }

    public static string SealState(ReadOnlySpan<byte> key, PerceptionCharacterV3BindingContext context, PerceptionCharacterV3State state, IPerceptionCharacterV3NonceSource nonceSource)
    {
        RequireKey(key);
        if (context.TokenKeyVersion != state.TokenKeyVersion)
            throw new ArgumentException("Key version mismatch.");
        byte[] plaintext = EncodeState(state);
        byte[] aad = EncodeAad(context);
        byte[] nonce = new byte[12];
        nonceSource.Fill(nonce);
        byte[] ciphertext = new byte[plaintext.Length];
        byte[] tag = new byte[16];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Encrypt(nonce, plaintext, ciphertext, tag, aad);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
        byte[] version = Ascii(context.TokenKeyVersion);
        byte[] token = new byte[3 + version.Length + nonce.Length + ciphertext.Length + tag.Length];
        token[0] = PerceptionCharacterV3CanonicalContract.Value.Version;
        BinaryPrimitives.WriteUInt16BigEndian(token.AsSpan(1), checked((ushort)version.Length));
        version.CopyTo(token, 3);
        nonce.CopyTo(token, 3 + version.Length);
        ciphertext.CopyTo(token, 3 + version.Length + 12);
        tag.CopyTo(token, token.Length - 16);
        return Convert.ToBase64String(token).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static bool TryOpenState(ReadOnlySpan<byte> key, string tokenText, PerceptionCharacterV3BindingContext context, out PerceptionCharacterV3State? state)
    {
        state = null;
        RequireKey(key);
        try
        {
            byte[] token = FromBase64Url(tokenText);
            if (token.Length < 32 || token[0] != 3)
                return false;
            int versionLength = BinaryPrimitives.ReadUInt16BigEndian(token.AsSpan(1));
            int nonceOffset = 3 + versionLength;
            if (versionLength is < 1 or > 64 || nonceOffset + 28 > token.Length)
                return false;
            string version = Encoding.ASCII.GetString(token, 3, versionLength);
            if (version != context.TokenKeyVersion)
                return false;
            ReadOnlySpan<byte> nonce = token.AsSpan(nonceOffset, 12);
            ReadOnlySpan<byte> tag = token.AsSpan(token.Length - 16);
            ReadOnlySpan<byte> ciphertext = token.AsSpan(nonceOffset + 12, token.Length - (nonceOffset + 12) - 16);
            byte[] plaintext = new byte[ciphertext.Length];
            byte[] aad = EncodeAad(context);
            try
            {
                using var aes = new AesGcm(key, 16);
                aes.Decrypt(nonce, ciphertext, tag, plaintext, aad);
                state = DecodeState(plaintext);
                return state is not null;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or DecoderFallbackException or ArgumentException)
        {
            return false;
        }
    }

    private static PerceptionCharacterV3State? DecodeState(ReadOnlySpan<byte> bytes)
    {
        if (!TryDecodeLp(bytes, 21, out byte[][] f) || f[0].Length != 32 || f[1].Length != 32 ||
            f[3].Length != 2 || f[4].Length != 2 || f[5].Length != 2 || f[6].Length != 2 ||
            f[11].Length != 32 || f[12].Length != 32 || f[13].Length != 32 || f[15].Length != 1 ||
            f[17].Length != 8 || f[18].Length != 8)
            return null;
        return new(f[0], Convert.ToHexStringLower(f[1]), Text(f[2]),
            BinaryPrimitives.ReadUInt16BigEndian(f[3]), BinaryPrimitives.ReadUInt16BigEndian(f[4]),
            BinaryPrimitives.ReadUInt16BigEndian(f[5]), BinaryPrimitives.ReadUInt16BigEndian(f[6]),
            Text(f[7]), Text(f[8]), Text(f[9]), Text(f[10]), Convert.ToHexStringLower(f[11]),
            Convert.ToHexStringLower(f[12]), Convert.ToHexStringLower(f[13]), Text(f[14]), f[15][0],
            Text(f[16]), BinaryPrimitives.ReadInt64BigEndian(f[17]), BinaryPrimitives.ReadInt64BigEndian(f[18]), Text(f[19]), Text(f[20]));
    }

    private static bool TryDecodeLp(ReadOnlySpan<byte> bytes, int expected, out byte[][] fields)
    {
        fields = [];
        if (bytes.Length < 2 || BinaryPrimitives.ReadUInt16BigEndian(bytes) != expected)
            return false;
        int offset = 2;
        var result = new byte[expected][];
        for (int i = 0; i < expected; i++)
        {
            if (offset > bytes.Length - 4)
                return false;
            uint length = BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);
            offset += 4;
            if (length > int.MaxValue || offset > bytes.Length - (int)length)
                return false;
            result[i] = bytes.Slice(offset, (int)length).ToArray();
            offset += (int)length;
        }
        if (offset != bytes.Length)
            return false;
        fields = result;
        return true;
    }

    private static byte[] Utf8(string value) => s_utf8.GetBytes(value);
    private static string Text(byte[] value) => s_utf8.GetString(value);
    private static byte[] Ascii(string value)
    {
        if (value.Any(ch => ch > 127))
            throw new ArgumentException("ASCII required.");
        return Encoding.ASCII.GetBytes(value);
    }
    private static byte[] Hex32(string value)
    {
        if (value.Length != 64 || value.Any(ch => !(ch is >= '0' and <= '9' or >= 'a' and <= 'f')))
            throw new ArgumentException("Lowercase hex32 required.");
        return Convert.FromHexString(value);
    }
    private static byte[] Int64(long value)
    {
        byte[] result = new byte[8];
        BinaryPrimitives.WriteInt64BigEndian(result, value);
        return result;
    }
    private static byte[] UInt16(ushort value)
    {
        byte[] result = new byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(result, value);
        return result;
    }
    private static void RequireKey(ReadOnlySpan<byte> key)
    {
        if (key.Length != 32)
            throw new ArgumentException("Key must be 256 bits.");
    }
    private static byte[] FromBase64Url(string value)
    {
        string x = value.Replace('-', '+').Replace('_', '/');
        x += new string('=', (4 - x.Length % 4) % 4);
        return Convert.FromBase64String(x);
    }
}
