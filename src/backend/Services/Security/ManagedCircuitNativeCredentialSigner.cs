using System.Buffers.Binary;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Security;

internal static class ManagedCircuitNativeCredentialSigner
{
    public const int PrivateKeyBytes = 32;
    public const int PublicKeyBytes = 64;
    public const int SignatureBytes = 96;

    private const string TranscriptDomain = "fsus.anonymous.comment.v2:credential-signature:v1";
    private const int MaxSigningAttempts = 1024;

    private static readonly BigInteger FieldPrime = BigInteger.Parse(
        "21888242871839275222246405745257275088696311157297823662689037894645226208583",
        CultureInfo.InvariantCulture);
    private static readonly BigInteger ScalarOrder = BigInteger.Parse(
        "21888242871839275222246405745257275088548364400416034343698204186575808495617",
        CultureInfo.InvariantCulture);
    private static readonly BigInteger LowSUpperBound = ScalarOrder / 2;
    private static readonly CurvePoint Generator = new(BigInteger.One, new BigInteger(2), false);

    public static byte[] DerivePublicKey(ReadOnlySpan<byte> privateKey)
    {
        BigInteger scalar = ReadPrivateScalar(privateKey);
        CurvePoint publicKey = Multiply(Generator, scalar);
        if (publicKey.Infinity)
        {
            throw new CryptographicException("invalid circuit-native public key");
        }

        return WritePublicKey(publicKey);
    }

    public static byte[] Sign(
        ReadOnlySpan<byte> privateKey,
        ReadOnlySpan<byte> publicKey,
        CircuitNativeCredentialIssueMaterial material)
    {
        BigInteger secret = ReadPrivateScalar(privateKey);
        CurvePoint expectedPublicKey = Multiply(Generator, secret);
        CurvePoint configuredPublicKey = ReadPublicKey(publicKey);
        if (!PointEquals(expectedPublicKey, configuredPublicKey))
        {
            throw new CryptographicException("circuit-native issuer public key mismatch");
        }

        byte[] canonical = Canonicalize(material);
        byte[]? nonceBytes = null;
        BigInteger response = BigInteger.Zero;
        for (int attempt = 0; attempt < MaxSigningAttempts; attempt++)
        {
            BigInteger nonce = HashToScalar(ResolveNoncePurpose(attempt), privateKey, publicKey, canonical);
            CurvePoint noncePoint = Multiply(Generator, nonce);
            nonceBytes = WritePublicKey(noncePoint);
            BigInteger challenge = HashToScalar("challenge", publicKey, nonceBytes, canonical);
            response = Mod(nonce + challenge * secret, ScalarOrder);
            if (response.Sign > 0 && response < LowSUpperBound)
            {
                break;
            }

            nonceBytes = null;
            response = BigInteger.Zero;
        }

        if (nonceBytes is null || response.Sign <= 0)
        {
            throw new CryptographicException("unable to generate canonical circuit-native signature");
        }

        byte[] signature = new byte[SignatureBytes];
        nonceBytes.CopyTo(signature.AsSpan(0, PublicKeyBytes));
        WriteFieldElement(response, signature.AsSpan(PublicKeyBytes, 32));
        return signature;
    }

    public static bool Verify(
        ReadOnlySpan<byte> publicKey,
        CircuitNativeCredentialIssueMaterial material,
        ReadOnlySpan<byte> signature)
    {
        try
        {
            if (signature.Length != SignatureBytes)
            {
                return false;
            }

            CurvePoint issuerPublicKey = ReadPublicKey(publicKey);
            CurvePoint noncePoint = ReadPublicKey(signature[..PublicKeyBytes]);
            BigInteger response = ReadScalar(signature.Slice(PublicKeyBytes, 32));
            if (response.Sign <= 0 || response >= LowSUpperBound)
            {
                return false;
            }

            byte[] canonical = Canonicalize(material);
            BigInteger challenge = HashToScalar("challenge", publicKey, signature[..PublicKeyBytes], canonical);
            CurvePoint left = Multiply(Generator, response);
            CurvePoint right = Add(noncePoint, Multiply(issuerPublicKey, challenge));
            return PointEquals(left, right);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    public static bool TryReadPrivateKeyFile(string path, out byte[] privateKey)
    {
        privateKey = [];
        if (!TryReadKeyFile(path, PrivateKeyBytes, out privateKey))
        {
            return false;
        }

        try
        {
            _ = ReadPrivateScalar(privateKey);
            return true;
        }
        catch (CryptographicException)
        {
            privateKey = [];
            return false;
        }
    }

    public static bool TryReadPublicKeyFile(string path, out byte[] publicKey)
    {
        publicKey = [];
        if (!TryReadKeyFile(path, PublicKeyBytes, out publicKey))
        {
            return false;
        }

        try
        {
            _ = ReadPublicKey(publicKey);
            return true;
        }
        catch (CryptographicException)
        {
            publicKey = [];
            return false;
        }
    }

    private static bool TryReadKeyFile(string path, int expectedBytes, out byte[] key)
    {
        key = [];
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return false;
        }

        try
        {
            byte[] bytes = File.ReadAllBytes(path);
            if (bytes.Length == expectedBytes)
            {
                key = bytes;
                return true;
            }

            string text = Encoding.ASCII.GetString(bytes).Trim();
            if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                text = text[2..];
            }

            if (text.Length == expectedBytes * 2 &&
                text.All(static ch => Uri.IsHexDigit(ch)))
            {
                key = Convert.FromHexString(text);
                return true;
            }

            return false;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static byte[] Canonicalize(CircuitNativeCredentialIssueMaterial material)
    {
        byte[] circuitId = Encoding.UTF8.GetBytes(material.CircuitId);
        byte[] credentialLevel = Encoding.UTF8.GetBytes(material.CredentialLevel);
        byte[] request = material.CredentialRequest ?? [];
        byte[] output = new byte[
            4 + Encoding.UTF8.GetByteCount(TranscriptDomain) +
            8 +
            4 +
            2 +
            4 + circuitId.Length +
            4 + credentialLevel.Length +
            4 + request.Length];
        int offset = 0;
        WriteString(output, ref offset, TranscriptDomain);
        BinaryPrimitives.WriteInt64LittleEndian(output.AsSpan(offset, 8), material.CredentialEpoch);
        offset += 8;
        BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(offset, 4), material.CircuitNumericId);
        offset += 4;
        BinaryPrimitives.WriteUInt16LittleEndian(output.AsSpan(offset, 2), material.PublicInputLayoutVersion);
        offset += 2;
        WriteBytes(output, ref offset, circuitId);
        WriteBytes(output, ref offset, credentialLevel);
        WriteBytes(output, ref offset, request);
        return output;
    }

    private static string ResolveNoncePurpose(int attempt)
        => attempt == 0
            ? "nonce"
            : string.Concat("nonce:", attempt.ToString(CultureInfo.InvariantCulture));

    private static void WriteString(byte[] output, ref int offset, string value)
        => WriteBytes(output, ref offset, Encoding.UTF8.GetBytes(value));

    private static void WriteBytes(byte[] output, ref int offset, ReadOnlySpan<byte> value)
    {
        BinaryPrimitives.WriteInt32LittleEndian(output.AsSpan(offset, 4), value.Length);
        offset += 4;
        value.CopyTo(output.AsSpan(offset, value.Length));
        offset += value.Length;
    }

    private static BigInteger ReadPrivateScalar(ReadOnlySpan<byte> privateKey)
    {
        if (privateKey.Length != PrivateKeyBytes)
        {
            throw new CryptographicException("invalid circuit-native private key");
        }

        BigInteger scalar = ReadScalar(privateKey);
        if (scalar.Sign <= 0)
        {
            throw new CryptographicException("invalid circuit-native private key");
        }

        return scalar;
    }

    private static BigInteger ReadScalar(ReadOnlySpan<byte> bytes)
        => Mod(new BigInteger(bytes, isUnsigned: true, isBigEndian: true), ScalarOrder);

    private static CurvePoint ReadPublicKey(ReadOnlySpan<byte> publicKey)
    {
        if (publicKey.Length != PublicKeyBytes)
        {
            throw new CryptographicException("invalid circuit-native public key");
        }

        BigInteger x = ReadFieldElement(publicKey[..32]);
        BigInteger y = ReadFieldElement(publicKey.Slice(32, 32));
        var point = new CurvePoint(x, y, false);
        if (!IsOnCurve(point))
        {
            throw new CryptographicException("invalid circuit-native public key");
        }

        if (!IsInPrimeOrderSubgroup(point))
        {
            throw new CryptographicException("invalid circuit-native public key subgroup");
        }

        return point;
    }

    private static byte[] WritePublicKey(CurvePoint point)
    {
        if (point.Infinity)
        {
            throw new CryptographicException("invalid circuit-native public key");
        }

        byte[] output = new byte[PublicKeyBytes];
        WriteFieldElement(point.X, output.AsSpan(0, 32));
        WriteFieldElement(point.Y, output.AsSpan(32, 32));
        return output;
    }

    private static BigInteger ReadFieldElement(ReadOnlySpan<byte> bytes)
    {
        BigInteger value = new(bytes, isUnsigned: true, isBigEndian: true);
        if (value.Sign < 0 || value >= FieldPrime)
        {
            throw new CryptographicException("invalid circuit-native field element");
        }

        return value;
    }

    private static void WriteFieldElement(BigInteger value, Span<byte> destination)
    {
        value = Mod(value, FieldPrime);
        byte[] source = value.ToByteArray(isUnsigned: true, isBigEndian: true);
        if (source.Length > destination.Length)
        {
            throw new CryptographicException("invalid circuit-native field element");
        }

        destination.Clear();
        source.CopyTo(destination[(destination.Length - source.Length)..]);
    }

    private static BigInteger HashToScalar(
        string purpose,
        ReadOnlySpan<byte> first,
        ReadOnlySpan<byte> second,
        ReadOnlySpan<byte> third)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendHash(hash, Encoding.UTF8.GetBytes(TranscriptDomain));
        AppendHash(hash, Encoding.UTF8.GetBytes(purpose));
        AppendHash(hash, first);
        AppendHash(hash, second);
        AppendHash(hash, third);
        byte[] digest = hash.GetHashAndReset();
        BigInteger scalar = Mod(new BigInteger(digest, isUnsigned: true, isBigEndian: true), ScalarOrder);
        return scalar.Sign == 0 ? BigInteger.One : scalar;
    }

    private static void AppendHash(IncrementalHash hash, ReadOnlySpan<byte> value)
    {
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, value.Length);
        hash.AppendData(length);
        hash.AppendData(value);
    }

    private static bool IsOnCurve(CurvePoint point)
    {
        if (point.Infinity)
        {
            return false;
        }

        BigInteger left = Mod(point.Y * point.Y, FieldPrime);
        BigInteger right = Mod(point.X * point.X * point.X + 3, FieldPrime);
        return left == right;
    }

    private static bool IsInPrimeOrderSubgroup(CurvePoint point)
        => PointEquals(MultiplyUnreduced(point, ScalarOrder), CurvePoint.InfinityPoint);

    private static CurvePoint Multiply(CurvePoint point, BigInteger scalar)
    {
        scalar = Mod(scalar, ScalarOrder);
        return MultiplyUnreduced(point, scalar);
    }

    private static CurvePoint MultiplyUnreduced(CurvePoint point, BigInteger scalar)
    {
        CurvePoint result = CurvePoint.InfinityPoint;
        CurvePoint addend = point;
        while (scalar > BigInteger.Zero)
        {
            if (!scalar.IsEven)
            {
                result = Add(result, addend);
            }

            addend = Add(addend, addend);
            scalar >>= 1;
        }

        return result;
    }

    private static CurvePoint Add(CurvePoint left, CurvePoint right)
    {
        if (left.Infinity)
        {
            return right;
        }

        if (right.Infinity)
        {
            return left;
        }

        if (left.X == right.X)
        {
            if (Mod(left.Y + right.Y, FieldPrime).IsZero)
            {
                return CurvePoint.InfinityPoint;
            }

            return Double(left);
        }

        BigInteger lambda = Mod(
            (right.Y - left.Y) * ModInverse(right.X - left.X),
            FieldPrime);
        BigInteger x = Mod(lambda * lambda - left.X - right.X, FieldPrime);
        BigInteger y = Mod(lambda * (left.X - x) - left.Y, FieldPrime);
        return new CurvePoint(x, y, false);
    }

    private static CurvePoint Double(CurvePoint point)
    {
        if (point.Infinity || point.Y.IsZero)
        {
            return CurvePoint.InfinityPoint;
        }

        BigInteger lambda = Mod(
            (3 * point.X * point.X) * ModInverse(2 * point.Y),
            FieldPrime);
        BigInteger x = Mod(lambda * lambda - (2 * point.X), FieldPrime);
        BigInteger y = Mod(lambda * (point.X - x) - point.Y, FieldPrime);
        return new CurvePoint(x, y, false);
    }

    private static BigInteger ModInverse(BigInteger value)
        => BigInteger.ModPow(Mod(value, FieldPrime), FieldPrime - 2, FieldPrime);

    private static BigInteger Mod(BigInteger value, BigInteger modulus)
    {
        BigInteger result = value % modulus;
        return result.Sign < 0 ? result + modulus : result;
    }

    private static bool PointEquals(CurvePoint left, CurvePoint right)
        => left.Infinity == right.Infinity &&
            (left.Infinity || (left.X == right.X && left.Y == right.Y));

    private readonly record struct CurvePoint(BigInteger X, BigInteger Y, bool Infinity)
    {
        public static CurvePoint InfinityPoint { get; } = new(BigInteger.Zero, BigInteger.Zero, true);
    }
}
