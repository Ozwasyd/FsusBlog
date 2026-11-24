using Xunit.Sdk;

namespace FsusBlog.V2.Integration.Tests;

/// <summary>
/// Pins the test PoW client to fixed byte vectors so neither proof generation nor its acceptance depends solely on
/// the production <see cref="ScopedPow"/> implementation. The challenge frame and proof bytes mirror
/// <c>tests/Protocol/fixtures/pow-challenge-v1.hex</c> and <c>tests/Protocol/pow.test.ts</c>.
/// </summary>
public sealed class PowFixtureTests
{
    private const string ChallengeFrameHex =
        "41454453021000001e00cc000000220873616c742d76616c7565000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000004000000508dfe69000000007369676e" +
        "61747572652d76616c7565000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "00000000000000000000000000000000000000000000000000000000";

    private const string ProofHex =
        "46504f5701" + "04000000" + "508dfe6900000000" +
        "0a00" + "73616c742d76616c7565" +
        "0300" + "313233" +
        "0f00" + "7369676e61747572652d76616c7565" +
        "0400" + "61626364";

    private static readonly PowChallenge Pinned = new("salt-value", 4, 1778290000L, "signature-value");
    private static readonly PowChallenge Fixed = Pinned with { Difficulty = PowFixture.FixedDifficulty };

    // SHA-256("salt-value:<nonce>:abcd"); 1618 is the smallest decimal nonce with at least 12 leading zero bits.
    private const string FirstTwelveBitNonce = "1618";
    private const string FirstTwelveBitDigest = "0006b7d6b489af34ae3b4bbe852c16559cb00c88f106c950c22a2a355a6b09dc";
    private const string ElevenBitNonce = "23341";
    private const string ElevenBitDigest = "001b1fa24a87c81ecdcbf36941939aaea2d20011fad3b7e31b4a57ea51432645";
    private const string ZeroBitDigest = "c3b2e0132d4db2a680e48bfc0d4016514394aba716cf516b00757dc78eb73615";

    [Fact]
    public void DecodesPinnedChallengeFrameAndMatchesTheProductionEncoder()
    {
        var frame = Convert.FromHexString(ChallengeFrameHex);
        Assert.Equal(Pinned, PowFixture.DecodeChallenge(frame));
        Assert.Equal(frame, PowWire.EncodeChallenge(Pinned));
    }

    [Fact]
    public void RejectsMalformedChallengePayloads()
    {
        var payload = Aeds.Decode(Convert.FromHexString(ChallengeFrameHex), FrameType.PowChallenge).ToArray();
        Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(payload[..^1]));
        var padded = payload.ToArray();
        padded[WireLayouts.PowChallengeSaltBytes - 1] = (byte)'x';
        Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(padded));
        var unsigned = payload.ToArray();
        unsigned.AsSpan(WireLayouts.PowChallengeSignatureOffset).Clear();
        Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(unsigned));
        var unsalted = payload.ToArray();
        unsalted.AsSpan(0, WireLayouts.PowChallengeSaltBytes).Clear();
        Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(unsalted));
        var paddedSignature = payload.ToArray();
        paddedSignature[^1] = (byte)'x';
        Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(paddedSignature));
        var zeroTimestamp = payload.ToArray();
        zeroTimestamp.AsSpan(WireLayouts.PowChallengeTimestampOffset, sizeof(long)).Clear();
        Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(zeroTimestamp));
        foreach (var badDifficulty in new[] { 0, 29 })
        {
            var invalidDifficulty = payload.ToArray();
            BinaryPrimitives.WriteInt32LittleEndian(invalidDifficulty.AsSpan(WireLayouts.PowChallengeSaltBytes), badDifficulty);
            Assert.ThrowsAny<XunitException>(() => PowFixture.DecodeChallengePayload(invalidDifficulty));
        }
    }

    [Fact]
    public void WritesTheExactFpowV1Envelope()
    {
        var proof = PowFixture.EncodeProof(Pinned, "123", "abcd");
        var expected = Convert.FromHexString(ProofHex);
        Assert.Equal(Convert.ToBase64String(expected), proof);

        var bytes = Convert.FromBase64String(proof);
        Assert.Equal(17, WireLayouts.PowProofHeaderBytes);
        Assert.Equal("FPOW"u8.ToArray(), bytes[..4]);
        Assert.Equal(1, bytes[4]);
        Assert.Equal(new byte[] { 4, 0, 0, 0 }, bytes[5..9]);
        Assert.Equal(1778290000L, BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(9, 8)));
        Assert.Equal(new byte[] { 0x50, 0x8d, 0xfe, 0x69, 0, 0, 0, 0 }, bytes[9..17]);
        var offset = 17;
        foreach (var field in new[] { "salt-value", "123", "signature-value", "abcd" })
        {
            Assert.Equal(field.Length, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(offset)));
            Assert.Equal(System.Text.Encoding.ASCII.GetBytes(field), bytes[(offset + 2)..(offset + 2 + field.Length)]);
            offset += 2 + field.Length;
        }
        Assert.Equal(bytes.Length, offset);
        Assert.Equal(new PowProof("salt-value", "123", 4, 1778290000L, "signature-value", "abcd"), PowWire.ReadProof(proof));
    }

    [Fact]
    public void LengthPrefixesCountUtf8BytesNotCharacters()
    {
        var bytes = Convert.FromBase64String(PowFixture.EncodeProof(Pinned with { Signature = "signé" }, "7", "abcd"));
        var signatureOffset = 17 + 2 + 10 + 2 + 1;
        Assert.Equal(6, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(signatureOffset)));
        Assert.Equal("7369676ec3a9", Convert.ToHexStringLower(bytes.AsSpan(signatureOffset + 2, 6)));
    }

    [Fact]
    public void EncodeProofPreservesNegativePathForIllegalProofEnvelopes()
    {
        var downgraded = PowFixture.EncodeProof(Fixed with { Difficulty = 11 }, FirstTwelveBitNonce, "abcd");
        Assert.Equal(11, PowWire.ReadProof(downgraded).Difficulty);

        var emptyField = PowFixture.EncodeProof(Fixed, "", "abcd");
        Assert.Throws<ProtocolException>(() => PowWire.ReadProof(emptyField));
    }

    [Fact]
    public void IndependentOracleMatchesPinnedDigestsAndBitBoundaries()
    {
        Assert.Equal(FirstTwelveBitDigest, Convert.ToHexStringLower(PowFixture.WorkDigest("salt-value", FirstTwelveBitNonce, "abcd")));
        Assert.Equal(ElevenBitDigest, Convert.ToHexStringLower(PowFixture.WorkDigest("salt-value", ElevenBitNonce, "abcd")));
        Assert.Equal(ZeroBitDigest, Convert.ToHexStringLower(PowFixture.WorkDigest("salt-value", "0", "abcd")));

        var twelve = Convert.FromHexString(FirstTwelveBitDigest);
        Assert.True(PowFixture.HasLeadingZeroBits(twelve, 12));
        Assert.True(PowFixture.HasLeadingZeroBits(twelve, 13));
        Assert.False(PowFixture.HasLeadingZeroBits(twelve, 14));
        var eleven = Convert.FromHexString(ElevenBitDigest);
        Assert.True(PowFixture.HasLeadingZeroBits(eleven, 11));
        Assert.False(PowFixture.HasLeadingZeroBits(eleven, 12));
        Assert.False(PowFixture.HasLeadingZeroBits(Convert.FromHexString(ZeroBitDigest), 1));

        byte[] exactlyTwelve = [0x00, 0x0f, 0xff, 0xff];
        Assert.True(PowFixture.HasLeadingZeroBits(exactlyTwelve, 12));
        Assert.False(PowFixture.HasLeadingZeroBits(exactlyTwelve, 13));
        byte[] onlyEleven = [0x00, 0x10, 0x00, 0x00];
        Assert.True(PowFixture.HasLeadingZeroBits(onlyEleven, 11));
        Assert.False(PowFixture.HasLeadingZeroBits(onlyEleven, 12));
        Assert.True(PowFixture.HasLeadingZeroBits(new byte[32], 256));
        Assert.Throws<ArgumentOutOfRangeException>(() => PowFixture.HasLeadingZeroBits(new byte[32], 0));
        Assert.Throws<ArgumentOutOfRangeException>(() => PowFixture.HasLeadingZeroBits(new byte[32], 257));
    }

    [Fact]
    public void ProductionVerifierAgreesWithTheIndependentOracleOnPinnedVectors()
    {
        // Cross-check only: the fixture never consults ScopedPow.HasWork to choose or validate a nonce.
        Assert.True(ScopedPow.HasWork("salt-value", FirstTwelveBitNonce, "abcd", 12));
        Assert.True(ScopedPow.HasWork("salt-value", FirstTwelveBitNonce, "abcd", 13));
        Assert.False(ScopedPow.HasWork("salt-value", FirstTwelveBitNonce, "abcd", 14));
        Assert.True(ScopedPow.HasWork("salt-value", ElevenBitNonce, "abcd", 11));
        Assert.False(ScopedPow.HasWork("salt-value", ElevenBitNonce, "abcd", 12));
        Assert.False(ScopedPow.HasWork("salt-value", "0", "abcd", 1));
    }

    [Fact]
    public void SolveFindsTheFirstQualifyingNonceAtTheFixedDifficulty()
    {
        Assert.Equal(12, PowFixture.FixedDifficulty);
        Assert.Equal(FirstTwelveBitNonce, PowFixture.FindNonce(Fixed, "abcd", CancellationToken.None));
        var proof = PowWire.ReadProof(PowFixture.Solve(Fixed, "abcd", CancellationToken.None));
        Assert.Equal(new PowProof("salt-value", FirstTwelveBitNonce, 12, 1778290000L, "signature-value", "abcd"), proof);
        Assert.True(PowFixture.HasLeadingZeroBits(PowFixture.WorkDigest(proof.Salt, proof.Nonce, proof.ClientNonce), 12));
    }

    [Fact]
    public void SolveRefusesChallengesBelowTheFixedDifficulty()
    {
        Assert.Throws<EqualException>(() => PowFixture.Solve(Pinned, "abcd", CancellationToken.None));
        Assert.Throws<EqualException>(() => PowFixture.Solve(Fixed with { Difficulty = 11 }, "abcd", CancellationToken.None));
    }

    [Fact]
    public void SearchIsCancellableAndBoundedByAnExplicitWorkBudget()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => PowFixture.Solve(Fixed, "abcd", cancelled.Token));

        var exhausted = Assert.Throws<InvalidOperationException>(() =>
            PowFixture.Solve(Fixed, "abcd", CancellationToken.None, budget: 1618));
        Assert.Contains("12 leading zero bits within 1618 attempts", exhausted.Message, StringComparison.Ordinal);
        Assert.Contains("salt salt-value", exhausted.Message, StringComparison.Ordinal);
        Assert.Contains("client nonce abcd", exhausted.Message, StringComparison.Ordinal);
        Assert.Equal(FirstTwelveBitNonce, PowFixture.FindNonce(Fixed, "abcd", CancellationToken.None, budget: 1619));
        Assert.Throws<ArgumentOutOfRangeException>(() => PowFixture.FindNonce(Fixed, "abcd", CancellationToken.None, budget: 0));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PowFixture.FindNonce(Fixed with { Difficulty = 0 }, "abcd", CancellationToken.None));
    }
}
