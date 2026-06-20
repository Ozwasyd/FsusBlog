// Portions adapted from the CFRG Blind BBS draft fixtures and algorithms
// (Apache-2.0), cfrg/draft-irtf-cfrg-bbs-blind-signatures commit
// cf6ad94041e16cf29c2b45b08241085f4d837d60.
// Curve arithmetic is provided by Neo.Cryptography.BLS12_381 (MIT).
// Modifications: converted the draft algorithms to a deterministic .NET 10
// server-side issuer for FsusBlog anonymous credentials.

using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Neo.Cryptography.BLS12_381;

namespace FsusBlog.Server.Services.Security;

internal sealed class ManagedBbsBlindCredentialSigner
{
    public const int SignatureSizeBytes = 80;
    public const int CommitmentPointSizeBytes = 48;
    public const int ScalarSizeBytes = 32;
    public const int PublicKeySizeBytes = 96;
    public const int SecretKeySizeBytes = 32;
    public const int RequiredCommittedCredentialMessages = 1;
    public const string ApiId = "BBS_BLS12381G1_XMD:SHA-256_SSWU_RO_BLIND_H2G_HM2S_";

    private const string HashToScalarSuffix = "H2S_";
    private const string MapMessageToScalarSuffix = "MAP_MSG_TO_SCALAR_AS_HASH_";
    private const string ScalarOrderHex = "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001";
    private static readonly BigInteger ScalarOrder = new(HexToBytes(ScalarOrderHex), isUnsigned: true, isBigEndian: true);
    private static readonly Encoding Utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private readonly Scalar _secretKey;
    private readonly G2Affine _publicKey;

    private ManagedBbsBlindCredentialSigner(Scalar secretKey, G2Affine publicKey)
    {
        _secretKey = secretKey;
        _publicKey = publicKey;
    }

    public static bool TryCreate(
        BbsBlindCredentialIssuerOptions options,
        out ManagedBbsBlindCredentialSigner? signer,
        out string publicKeyHash,
        out string reason)
    {
        signer = null;
        publicKeyHash = string.Empty;
        reason = "not_configured";

        if (!string.Equals(options.Backend, BbsBlindCredentialIssuerOptions.ManagedBbsBlindBackend, StringComparison.Ordinal))
        {
            reason = "unsupported_backend";
            return false;
        }

        if (!TryReadKeyFile(options.IssuerPrivateKeyPath, SecretKeySizeBytes, out byte[] secretKeyBytes) ||
            !TryReadKeyFile(options.IssuerPublicKeyPath, PublicKeySizeBytes, out byte[] publicKeyBytes))
        {
            reason = "key_file_unreadable";
            return false;
        }

        publicKeyHash = Convert.ToHexStringLower(SHA256.HashData(publicKeyBytes));
        if (!string.Equals(publicKeyHash, options.IssuerPublicKeyHash, StringComparison.Ordinal))
        {
            reason = "public_key_hash_mismatch";
            return false;
        }

        if (!TryScalarFromBigEndian(secretKeyBytes, out Scalar secretKey) ||
            !TryParsePublicKey(publicKeyBytes, out G2Affine publicKey))
        {
            reason = "key_material_invalid";
            return false;
        }

        G2Affine derivedPublicKey = new(G2Projective.Generator * secretKey);
        if (!CryptographicOperations.FixedTimeEquals(derivedPublicKey.ToCompressed(), publicKeyBytes))
        {
            reason = "public_key_secret_key_mismatch";
            return false;
        }

        signer = new ManagedBbsBlindCredentialSigner(secretKey, publicKey);
        reason = "ready";
        return true;
    }

    public bool TrySign(
        BbsBlindCredentialIssueMaterial material,
        out byte[] signature,
        out string reason)
    {
        signature = [];
        reason = "invalid_request";

        if (!TryParseCommitmentWithProof(material.BlindedCommitment, out CommitmentProof proof) ||
            proof.MessageCommitments.Length != RequiredCommittedCredentialMessages ||
            !VerifyCommitmentProof(proof))
        {
            reason = "blinded_commitment_invalid";
            return false;
        }

        Scalar[] messageScalars = MapMessagesToScalars(BuildSignerMessages(material));
        if (messageScalars.Length > MessageGenerators.Length)
        {
            reason = "too_many_messages";
            return false;
        }

        G1Affine[] blindGenerators = GetBlindGenerators(proof.MessageCommitments.Length);
        G1Affine[] signatureGenerators = GetSignatureGenerators(messageScalars.Length);
        Scalar domain = CalculateDomain(_publicKey, signatureGenerators[0], signatureGenerators.AsSpan(1), blindGenerators, []);
        G1Affine b = CalculateB(signatureGenerators, messageScalars, proof.Commitment, domain);
        Scalar e = HashToScalar(Serialize(_secretKey, b, domain), ApiId + HashToScalarSuffix);
        Scalar denominator = _secretKey.Sum(in e);
        Scalar inverse = denominator.Invert();
        G1Affine a = new(b.ToCurve() * inverse);
        if (a.IsIdentity)
        {
            reason = "invalid_signature";
            return false;
        }

        signature = new byte[SignatureSizeBytes];
        a.ToCompressed().CopyTo(signature.AsSpan(0, CommitmentPointSizeBytes));
        ScalarToBigEndian(e).CopyTo(signature.AsSpan(CommitmentPointSizeBytes, ScalarSizeBytes));
        reason = "ready";
        return true;
    }

    internal bool VerifySignatureForTests(
        BbsBlindCredentialIssueMaterial material,
        ReadOnlySpan<byte> signature)
    {
        if (signature.Length != SignatureSizeBytes ||
            !TryParseCommitmentWithProof(material.BlindedCommitment, out CommitmentProof proof))
        {
            return false;
        }

        Scalar[] messageScalars = MapMessagesToScalars(BuildSignerMessages(material));
        G1Affine[] blindGenerators = GetBlindGenerators(proof.MessageCommitments.Length);
        G1Affine[] signatureGenerators = GetSignatureGenerators(messageScalars.Length);
        Scalar domain = CalculateDomain(_publicKey, signatureGenerators[0], signatureGenerators.AsSpan(1), blindGenerators, []);
        G1Affine b = CalculateB(signatureGenerators, messageScalars, proof.Commitment, domain);
        return VerifyCore(_publicKey, signature, b);
    }

    internal static byte[] CreateCommitmentWithProofForTests(
        string committedMessageScalarHex,
        string proverBlindHex,
        string blindTildeHex,
        string messageTildeHex)
    {
        Scalar committedMessage = ScalarFromBigEndian(HexToBytes(committedMessageScalarHex));
        Scalar proverBlind = ScalarFromBigEndian(HexToBytes(proverBlindHex));
        Scalar blindTilde = ScalarFromBigEndian(HexToBytes(blindTildeHex));
        Scalar messageTilde = ScalarFromBigEndian(HexToBytes(messageTildeHex));
        G1Affine[] blindGenerators = GetBlindGenerators(1);

        G1Projective commitmentProjective = blindGenerators[0].ToCurve() * proverBlind;
        commitmentProjective += blindGenerators[1].ToCurve() * committedMessage;
        G1Affine commitment = new(commitmentProjective);

        G1Projective cbarProjective = blindGenerators[0].ToCurve() * blindTilde;
        cbarProjective += blindGenerators[1].ToCurve() * messageTilde;
        G1Affine cbar = new(cbarProjective);

        Scalar challenge = CalculateBlindChallenge(commitment, cbar, blindGenerators);
        Scalar blindChallenge = proverBlind.Multiply(in challenge);
        Scalar messageChallenge = committedMessage.Multiply(in challenge);
        Scalar blindCommitment = blindTilde.Sum(in blindChallenge);
        Scalar messageCommitment = messageTilde.Sum(in messageChallenge);

        byte[] output = new byte[CommitmentPointSizeBytes + 3 * ScalarSizeBytes];
        commitment.ToCompressed().CopyTo(output.AsSpan(0, CommitmentPointSizeBytes));
        ScalarToBigEndian(blindCommitment).CopyTo(output.AsSpan(CommitmentPointSizeBytes, ScalarSizeBytes));
        ScalarToBigEndian(messageCommitment).CopyTo(output.AsSpan(CommitmentPointSizeBytes + ScalarSizeBytes, ScalarSizeBytes));
        ScalarToBigEndian(challenge).CopyTo(output.AsSpan(CommitmentPointSizeBytes + 2 * ScalarSizeBytes, ScalarSizeBytes));
        return output;
    }

    internal static byte[] DerivePublicKeyForTests(string secretKeyHex)
    {
        Scalar secretKey = ScalarFromBigEndian(HexToBytes(secretKeyHex));
        return new G2Affine(G2Projective.Generator * secretKey).ToCompressed();
    }

    internal static bool VerifyOfficialNoMessageFixtureForTests()
    {
        Scalar secretKey = ScalarFromBigEndian(HexToBytes("60e55110f76883a13d030b2f6bd11883422d5abde717569fc0731f51237169fc"));
        G2Affine publicKey = new(G2Projective.Generator * secretKey);
        byte[] commitmentBytes = HexToBytes(
            "849d3cc626720202cbc1610fc01ab41ce32099af602def0c579f37dd18b485ef60719275a036bdd8120e7e938c8e1a3d4d" +
            "0322587441ccc5caf186001b45dd09ee159713c3e3ea0f411f94a5d6665546562d09c093b687a129e464a57e18cdbf5306" +
            "bcabf3e7cc95f5ba98cdd9bf3768");
        byte[] signatureBytes = HexToBytes(
            "ab54c35fb2af5c75d6368bc5772547e126d60a92205d011bb9ee5d1149432e91611fd376fe5b79d6ed7c2ba00a19b743" +
            "4744945fd77bf02cd4628a6e5deeae50768116d55510251bb6a716a38340e184");
        if (!TryParseCommitmentWithProof(commitmentBytes, out CommitmentProof proof) ||
            !VerifyCommitmentProof(proof))
        {
            return false;
        }

        G1Affine[] signatureGenerators = GetSignatureGenerators(0);
        G1Affine[] blindGenerators = GetBlindGenerators(0);
        Scalar domain = CalculateDomain(
            publicKey,
            signatureGenerators[0],
            signatureGenerators.AsSpan(1),
            blindGenerators,
            HexToBytes("11223344556677889900aabbccddeeff"));
        if (!CryptographicOperations.FixedTimeEquals(
                ScalarToBigEndian(domain),
                HexToBytes("0b3a152bc770ff9e21f09ac58f59c99379ca0eeb61990ba666d994014085b332")))
        {
            return false;
        }

        G1Affine b = CalculateB(signatureGenerators, [], proof.Commitment, domain);
        if (!CryptographicOperations.FixedTimeEquals(
                b.ToCompressed(),
                HexToBytes("9964a978251fcc52c918dee3d8f102d2152fa7a805df85b1e91e0c45d4d8d7c02aab78353a240176f6a33899b98b3379")))
        {
            return false;
        }

        return VerifyCore(publicKey, signatureBytes, b);
    }

    private static bool VerifyCore(G2Affine publicKey, ReadOnlySpan<byte> signature, G1Affine b)
    {
        try
        {
            G1Affine a = G1Affine.FromCompressed(signature[..CommitmentPointSizeBytes]);
            Scalar e = ScalarFromBigEndian(signature[CommitmentPointSizeBytes..SignatureSizeBytes]);
            if (a.IsIdentity || !a.IsOnCurve || !a.IsTorsionFree)
            {
                return false;
            }

            G1Projective aeMinusB = a.ToCurve() * e - b.ToCurve();
            G1Affine aeMinusBAffine = new(aeMinusB);
            Gt first = Bls12.Pairing(in a, in publicKey);
            G2Affine bp2 = G2Affine.Generator;
            Gt second = Bls12.Pairing(in aeMinusBAffine, in bp2);
            Fp12 secondValue = second.Value;
            Fp12 productValue = first.Value.Multiply(in secondValue);
            Gt product = new(in productValue);
            return product.Equals(Gt.Identity);
        }
        catch
        {
            return false;
        }
    }

    private static G1Affine CalculateB(
        ReadOnlySpan<G1Affine> signatureGenerators,
        ReadOnlySpan<Scalar> messageScalars,
        G1Affine commitment,
        Scalar domain)
    {
        G1Projective b = P1.ToCurve() + signatureGenerators[0].ToCurve() * domain;
        for (int i = 0; i < messageScalars.Length; i++)
        {
            b += signatureGenerators[i + 1].ToCurve() * messageScalars[i];
        }

        b += commitment.ToCurve();
        return new G1Affine(b);
    }

    private static bool VerifyCommitmentProof(CommitmentProof proof)
    {
        G1Affine[] blindGenerators = GetBlindGenerators(proof.MessageCommitments.Length);
        Scalar negChallenge = proof.Challenge.Negate();
        G1Projective cbar = blindGenerators[0].ToCurve() * proof.BlindCommitment;
        for (int i = 0; i < proof.MessageCommitments.Length; i++)
        {
            cbar += blindGenerators[i + 1].ToCurve() * proof.MessageCommitments[i];
        }

        cbar += proof.Commitment.ToCurve() * negChallenge;
        Scalar actual = CalculateBlindChallenge(proof.Commitment, new G1Affine(cbar), blindGenerators);
        return CryptographicOperations.FixedTimeEquals(
            ScalarToBigEndian(actual),
            ScalarToBigEndian(proof.Challenge));
    }

    private static Scalar CalculateBlindChallenge(
        G1Affine commitment,
        G1Affine cbar,
        ReadOnlySpan<G1Affine> generators)
    {
        byte[] input = new byte[8 + CommitmentPointSizeBytes * generators.Length + CommitmentPointSizeBytes + CommitmentPointSizeBytes];
        Span<byte> cursor = input;
        BinaryPrimitives.WriteUInt64BigEndian(cursor, (ulong)(generators.Length - 1));
        cursor = cursor[8..];
        foreach (G1Affine generator in generators)
        {
            generator.ToCompressed().CopyTo(cursor);
            cursor = cursor[CommitmentPointSizeBytes..];
        }

        commitment.ToCompressed().CopyTo(cursor);
        cursor = cursor[CommitmentPointSizeBytes..];
        cbar.ToCompressed().CopyTo(cursor);
        return HashToScalar(input, ApiId + HashToScalarSuffix);
    }

    private static Scalar CalculateDomain(
        G2Affine publicKey,
        G1Affine q1,
        ReadOnlySpan<G1Affine> hPoints,
        ReadOnlySpan<G1Affine> blindGenerators,
        ReadOnlySpan<byte> header)
    {
        byte[] apiIdBytes = Encoding.ASCII.GetBytes(ApiId);
        int pointCount = hPoints.Length + blindGenerators.Length;
        byte[] input = new byte[
            PublicKeySizeBytes +
            8 +
            CommitmentPointSizeBytes * (1 + pointCount) +
            apiIdBytes.Length +
            8 +
            header.Length];
        Span<byte> cursor = input;
        publicKey.ToCompressed().CopyTo(cursor);
        cursor = cursor[PublicKeySizeBytes..];
        BinaryPrimitives.WriteUInt64BigEndian(cursor, (ulong)pointCount);
        cursor = cursor[8..];
        q1.ToCompressed().CopyTo(cursor);
        cursor = cursor[CommitmentPointSizeBytes..];
        foreach (G1Affine point in hPoints)
        {
            point.ToCompressed().CopyTo(cursor);
            cursor = cursor[CommitmentPointSizeBytes..];
        }

        foreach (G1Affine point in blindGenerators)
        {
            point.ToCompressed().CopyTo(cursor);
            cursor = cursor[CommitmentPointSizeBytes..];
        }

        apiIdBytes.CopyTo(cursor);
        cursor = cursor[apiIdBytes.Length..];
        BinaryPrimitives.WriteUInt64BigEndian(cursor, (ulong)header.Length);
        cursor = cursor[8..];
        header.CopyTo(cursor);
        return HashToScalar(input, ApiId + HashToScalarSuffix);
    }

    private static Scalar[] MapMessagesToScalars(ReadOnlySpan<byte[]> messages)
    {
        var scalars = new Scalar[messages.Length];
        for (int i = 0; i < messages.Length; i++)
        {
            scalars[i] = HashToScalar(messages[i], ApiId + MapMessageToScalarSuffix);
        }

        return scalars;
    }

    private static byte[][] BuildSignerMessages(BbsBlindCredentialIssueMaterial material)
    {
        byte[] epoch = new byte[8];
        BinaryPrimitives.WriteInt64BigEndian(epoch, material.CredentialEpoch);
        byte[] circuitNumericId = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(circuitNumericId, material.CircuitNumericId);
        byte[] layoutVersion = new byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(layoutVersion, material.PublicInputLayoutVersion);
        return
        [
            epoch,
            circuitNumericId,
            layoutVersion,
            Utf8.GetBytes(material.CircuitId),
            Utf8.GetBytes(material.CredentialLevel)
        ];
    }

    private static bool TryParseCommitmentWithProof(
        ReadOnlySpan<byte> bytes,
        out CommitmentProof proof)
    {
        proof = default;
        if (bytes.Length < CommitmentPointSizeBytes + 2 * ScalarSizeBytes ||
            (bytes.Length - CommitmentPointSizeBytes) % ScalarSizeBytes != 0)
        {
            return false;
        }

        try
        {
            G1Affine commitment = G1Affine.FromCompressed(bytes[..CommitmentPointSizeBytes]);
            if (commitment.IsIdentity || !commitment.IsOnCurve || !commitment.IsTorsionFree)
            {
                return false;
            }

            int scalarCount = (bytes.Length - CommitmentPointSizeBytes) / ScalarSizeBytes;
            if (scalarCount < 2)
            {
                return false;
            }

            var scalars = new Scalar[scalarCount];
            for (int i = 0; i < scalarCount; i++)
            {
                if (!TryScalarFromBigEndian(bytes.Slice(CommitmentPointSizeBytes + i * ScalarSizeBytes, ScalarSizeBytes), out scalars[i]))
                {
                    return false;
                }
            }

            proof = new CommitmentProof(
                commitment,
                scalars[0],
                scalars[1..^1],
                scalars[^1]);
            return proof.MessageCommitments.Length <= BlindMessageGenerators.Length;
        }
        catch
        {
            proof = default;
            return false;
        }
    }

    private static byte[] Serialize(Scalar secretKey, G1Affine b, Scalar domain)
    {
        byte[] result = new byte[ScalarSizeBytes + CommitmentPointSizeBytes + ScalarSizeBytes];
        ScalarToBigEndian(secretKey).CopyTo(result.AsSpan(0, ScalarSizeBytes));
        b.ToCompressed().CopyTo(result.AsSpan(ScalarSizeBytes, CommitmentPointSizeBytes));
        ScalarToBigEndian(domain).CopyTo(result.AsSpan(ScalarSizeBytes + CommitmentPointSizeBytes, ScalarSizeBytes));
        return result;
    }

    private static Scalar HashToScalar(ReadOnlySpan<byte> message, string dst)
    {
        byte[] uniform = ExpandMessageXmdSha256(message, Encoding.ASCII.GetBytes(dst), 48);
        var value = new BigInteger(uniform, isUnsigned: true, isBigEndian: true);
        byte[] reduced = (value % ScalarOrder).ToByteArray(isUnsigned: true, isBigEndian: true);
        Span<byte> scalarBytes = stackalloc byte[ScalarSizeBytes];
        reduced.CopyTo(scalarBytes[(ScalarSizeBytes - reduced.Length)..]);
        return ScalarFromBigEndian(scalarBytes);
    }

    private static byte[] ExpandMessageXmdSha256(ReadOnlySpan<byte> message, ReadOnlySpan<byte> dst, int length)
    {
        if (dst.Length > byte.MaxValue)
        {
            throw new InvalidOperationException("BBS DST is too long.");
        }

        int ell = (length + 31) / 32;
        if (ell is <= 0 or > byte.MaxValue)
        {
            throw new InvalidOperationException("BBS expand length is invalid.");
        }

        byte[] dstPrime = new byte[dst.Length + 1];
        dst.CopyTo(dstPrime);
        dstPrime[^1] = (byte)dst.Length;

        byte[] msgPrime = new byte[64 + message.Length + 2 + 1 + dstPrime.Length];
        message.CopyTo(msgPrime.AsSpan(64));
        BinaryPrimitives.WriteUInt16BigEndian(msgPrime.AsSpan(64 + message.Length), (ushort)length);
        msgPrime[64 + message.Length + 2] = 0;
        dstPrime.CopyTo(msgPrime.AsSpan(64 + message.Length + 3));

        byte[] b0 = SHA256.HashData(msgPrime);
        byte[] b = SHA256.HashData(Concat(b0, [0x01], dstPrime));
        byte[] output = new byte[ell * 32];
        b.CopyTo(output, 0);
        Span<byte> xored = stackalloc byte[32];
        for (int i = 2; i <= ell; i++)
        {
            for (int j = 0; j < xored.Length; j++)
            {
                xored[j] = (byte)(b0[j] ^ b[j]);
            }

            b = SHA256.HashData(Concat(xored, [(byte)i], dstPrime));
            b.CopyTo(output, (i - 1) * 32);
        }

        return output[..length];
    }

    private static byte[] Concat(ReadOnlySpan<byte> first, ReadOnlySpan<byte> second, ReadOnlySpan<byte> third)
    {
        byte[] result = new byte[first.Length + second.Length + third.Length];
        first.CopyTo(result);
        second.CopyTo(result.AsSpan(first.Length));
        third.CopyTo(result.AsSpan(first.Length + second.Length));
        return result;
    }

    private static bool TryReadKeyFile(string path, int expectedLength, out byte[] keyBytes)
    {
        keyBytes = [];
        if (path.Length == 0 || !File.Exists(path))
        {
            return false;
        }

        try
        {
            byte[] raw = File.ReadAllBytes(path);
            if (raw.Length == expectedLength)
            {
                keyBytes = raw;
                return true;
            }

            string text = Utf8.GetString(raw).Trim();
            if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                text = text[2..];
            }

            string normalized = NormalizeHex(text);
            if (normalized.Length != expectedLength * 2)
            {
                return false;
            }

            keyBytes = Convert.FromHexString(normalized);
            return true;
        }
        catch
        {
            keyBytes = [];
            return false;
        }
    }

    internal static bool TryReadPrivateKeyFileForValidation(string path)
        => TryReadKeyFile(path, SecretKeySizeBytes, out byte[] keyBytes) &&
            keyBytes.Length == SecretKeySizeBytes;

    internal static bool TryReadPublicKeyFileForValidation(string path, out byte[] publicKeyBytes)
        => TryReadKeyFile(path, PublicKeySizeBytes, out publicKeyBytes) &&
            publicKeyBytes.Length == PublicKeySizeBytes;

    private static bool TryParsePublicKey(ReadOnlySpan<byte> publicKeyBytes, out G2Affine publicKey)
    {
        publicKey = default;
        if (publicKeyBytes.Length != PublicKeySizeBytes)
        {
            return false;
        }

        try
        {
            publicKey = G2Affine.FromCompressed(publicKeyBytes);
            return !publicKey.IsIdentity && publicKey.IsOnCurve && publicKey.IsTorsionFree;
        }
        catch
        {
            publicKey = default;
            return false;
        }
    }

    private static Scalar ScalarFromBigEndian(ReadOnlySpan<byte> bigEndian)
    {
        if (!TryScalarFromBigEndian(bigEndian, out Scalar scalar))
        {
            throw new ArgumentOutOfRangeException(nameof(bigEndian), "Invalid BLS12-381 scalar.");
        }

        return scalar;
    }

    private static bool TryScalarFromBigEndian(ReadOnlySpan<byte> bigEndian, out Scalar scalar)
    {
        scalar = default;
        if (bigEndian.Length != ScalarSizeBytes)
        {
            return false;
        }

        var value = new BigInteger(bigEndian, isUnsigned: true, isBigEndian: true);
        if (value.Sign <= 0 || value >= ScalarOrder)
        {
            return false;
        }

        Span<byte> littleEndian = stackalloc byte[ScalarSizeBytes];
        bigEndian.CopyTo(littleEndian);
        littleEndian.Reverse();
        scalar = Scalar.FromBytes(littleEndian);
        return !scalar.IsZero;
    }

    private static byte[] ScalarToBigEndian(Scalar scalar)
    {
        byte[] bytes = scalar.ToArray();
        Array.Reverse(bytes);
        return bytes;
    }

    private static string NormalizeHex(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (char ch in value)
        {
            if (Uri.IsHexDigit(ch))
            {
                builder.Append(char.ToLowerInvariant(ch));
            }
        }

        return builder.ToString();
    }

    private static byte[] HexToBytes(string value)
        => Convert.FromHexString(NormalizeHex(value));

    private static G1Affine Point(string hex)
        => G1Affine.FromCompressed(HexToBytes(hex));

    private static G1Affine[] GetSignatureGenerators(int messageCount)
        => [Q1, .. MessageGenerators.AsSpan(0, messageCount).ToArray()];

    private static G1Affine[] GetBlindGenerators(int committedMessageCount)
        => [BlindQ1, .. BlindMessageGenerators.AsSpan(0, committedMessageCount).ToArray()];

    private static readonly G1Affine P1 = Point("a8ce256102840821a3e94ea9025e4662b205762f9776b3a766c872b948f1fd225e7c59698588e70d11406d161b4e28c9");
    private static readonly G1Affine Q1 = Point("8aa0382ea3cd294680e3425bb0bb9293210a4d3e94d8ba59096fcb24eb9b56546645bea83e170b078ff3cc5aeac18c49");
    private static readonly G1Affine BlindQ1 = Point("a347532dc0ba9b83e4f15f3eeb7dffd934f5fa4668d927fbcb68096d5a26f6e59f66681201be1c263af1a25b6749759c");

    private static readonly G1Affine[] MessageGenerators =
    [
        Point("8065ec88f9bbee345b44e7825b2d602c91b0398b7c885d722450459c26efb1619eb4249428644b9e3d8d11d469d0c62b"),
        Point("b96f3af9abcd3ee2228fbe97d4e5a0ef10aaf655c6889e284f27a732492ecdb64a91f92dbaa93f2a7fb550659935985f"),
        Point("a99d1b53cc51738a46a7e1fe9b9d89a57977154dcccb7ce741eb779bf69ff655b110f0e97c4715616401e5a47d2c373a"),
        Point("9791c624fec3d688975f9c9143f066404115e0dcc1e318ef4f5290c0103ee4a2857dbf9347d997ee507ab629216797f6"),
        Point("8a472740d4968c831a3ad3d3c55ada8aca8478e4d0698ece52eff445d15aec1a479332e34562e80831b9593c85b435ec"),
        Point("b5102a6529b39de47c136de78a8697395e11013f8aa91f695f158009b52985adee67a63fc354846b7f4b944349295c95"),
        Point("845df3031a580f6c58b6d324f42f2158088a924dab9e77151851408a8bda31c266000c10bc47cc38aa3ac24dad22462c"),
        Point("b4296c820736cafb7c9229cf499788314a4578de69e88832ca39babe36c48073e61968ae320f9bae61079724a5271eac"),
        Point("9253f55dacd9e144f6da37f4adb420773325d142d900a6ae7de851c2643532e0b9181ae3ee02fe8c123b10dd12822876"),
        Point("979a52e753c367e3baa8826e7b74a23856abca5468ba5ce5719b4c57eb7e9ee879935f98fbd6959661d3e866477063b2")
    ];

    private static readonly G1Affine[] BlindMessageGenerators =
    [
        Point("af590ba56aa0e526a0763ae6926347dce988ffb9cc1a0b4510ada06fe08816f5c36a6c7007cc8558e5793f9a2cbae462"),
        Point("a9a6e5f3093823745734a2195d80886f47185be6a3e4d00df2bd5996aa9d664e34244ea15e9ad4c41d8825331fcfd5a3"),
        Point("a6c1a8fd251a338e25d3ea4e09334ea250f0257783f2be4ce4406798ea9acbce41e7648c7fb1409fcd822396f652c4e7"),
        Point("80d1232ee4a5623d7ac5a3912c555f9f6f34716edfe156ae40b6ac19afba58dd18556e49529e39da91aa806c9c55d493"),
        Point("b8775d3d2f58cafd808d135de79367f34c9ad22a6a878631fd0b1383541999b16b6f3bae96ab51bb4ab25caf69462473")
    ];

    private readonly record struct CommitmentProof(
        G1Affine Commitment,
        Scalar BlindCommitment,
        Scalar[] MessageCommitments,
        Scalar Challenge);
}
