namespace FsusBlog.V2.Integration.Tests;

/// <summary>
/// Test-only scoped PoW client: decodes issued challenges, solves them against an oracle that is independent of
/// the production verifier, and writes the FPOW v1 proof envelope byte by byte. Pinned vectors live in
/// <see cref="PowFixtureTests"/>.
/// </summary>
internal static class PowFixture
{
    /// <summary>Every currently issued challenge is pinned at 12 leading zero bits; a lowered contract must fail here.</summary>
    internal const int FixedDifficulty = 12;

    /// <summary>A 12-bit search succeeds within this budget except with probability below e^-244.</summary>
    internal const int DefaultWorkBudget = 1_000_000;

    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static PowChallenge DecodeChallenge(byte[] frame) => DecodeChallengePayload(Aeds.Decode(frame, FrameType.PowChallenge));

    internal static PowChallenge DecodeChallengePayload(ReadOnlySpan<byte> payload)
    {
        Assert.Equal(WireLayouts.PowChallengeBytes, payload.Length);
        var salt = FixedText(payload[..WireLayouts.PowChallengeSaltBytes], "salt");
        var difficulty = BinaryPrimitives.ReadInt32LittleEndian(payload[WireLayouts.PowChallengeSaltBytes..]);
        var timestamp = BinaryPrimitives.ReadInt64LittleEndian(payload[WireLayouts.PowChallengeTimestampOffset..]);
        var signature = FixedText(payload[WireLayouts.PowChallengeSignatureOffset..], "signature");
        Assert.InRange(difficulty, 1, 28);
        Assert.True(timestamp > 0, $"PoW challenge timestamp {timestamp} is not positive.");
        return new(salt, difficulty, timestamp, signature);
    }

    /// <summary>Decodes an issued challenge frame and returns the Base64 FPOW proof for the fixed 12-bit contract.</summary>
    internal static string SolveFrame(byte[] frame, string clientNonce, CancellationToken ct) =>
        Solve(DecodeChallenge(frame), clientNonce, ct);

    /// <summary>Solves an issued challenge; asserts the fixed 12-bit difficulty rather than accepting any lower one.</summary>
    internal static string Solve(PowChallenge challenge, string clientNonce, CancellationToken ct, int budget = DefaultWorkBudget)
    {
        Assert.Equal(FixedDifficulty, challenge.Difficulty);
        Assert.Equal(FixedDifficulty, WireLimits.PowChallengeDifficulty);
        return EncodeProof(challenge, FindNonce(challenge, clientNonce, ct, budget), clientNonce);
    }

    /// <summary>Returns the smallest decimal nonce whose work digest meets the challenge difficulty.</summary>
    internal static string FindNonce(PowChallenge challenge, string clientNonce, CancellationToken ct, int budget = DefaultWorkBudget)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(budget);
        if (challenge.Difficulty is < 1 or > 256)
            throw new ArgumentOutOfRangeException(nameof(challenge), challenge.Difficulty, "PoW difficulty must be within 1..256 bits.");
        for (var attempt = 0; attempt < budget; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            var nonce = attempt.ToString(CultureInfo.InvariantCulture);
            if (HasLeadingZeroBits(WorkDigest(challenge.Salt, nonce, clientNonce), challenge.Difficulty)) return nonce;
        }
        throw new InvalidOperationException(
            $"No PoW nonce met {challenge.Difficulty} leading zero bits within {budget} attempts " +
            $"(salt {challenge.Salt}, timestamp {challenge.Timestamp}, client nonce {clientNonce}).");
    }

    /// <summary>SHA-256 over the UTF-8 preimage <c>salt:nonce:clientNonce</c>, computed without the production verifier.</summary>
    internal static byte[] WorkDigest(string salt, string nonce, string clientNonce) =>
        SHA256.HashData(StrictUtf8.GetBytes($"{salt}:{nonce}:{clientNonce}"));

    /// <summary>Independent leading-zero oracle: counts zero bits from the most significant bit of byte 0.</summary>
    internal static bool HasLeadingZeroBits(ReadOnlySpan<byte> digest, int bits)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(bits);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(bits, digest.Length * 8);
        var zeros = 0;
        foreach (var value in digest)
        {
            if (value != 0)
            {
                for (var mask = 0x80; (value & mask) == 0; mask >>= 1) zeros++;
                break;
            }
            zeros += 8;
        }
        return zeros >= bits;
    }

    /// <summary>
    /// Writes FPOW v1: ASCII magic, version byte 1, little-endian int32 difficulty and int64 timestamp, then salt, nonce,
    /// signature and client nonce, each prefixed by its little-endian uint16 UTF-8 byte length. Also builds illegal
    /// variants when callers pass a modified challenge.
    /// </summary>
    internal static string EncodeProof(PowChallenge challenge, string nonce, string clientNonce)
    {
        string[] fields = [challenge.Salt, nonce, challenge.Signature, clientNonce];
        var encoded = fields.Select(StrictUtf8.GetBytes).ToArray();
        var bytes = new byte[WireLayouts.PowProofHeaderBytes + encoded.Sum(field => 2 + field.Length)];
        "FPOW"u8.CopyTo(bytes);
        bytes[4] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(5), challenge.Difficulty);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(9), challenge.Timestamp);
        var offset = WireLayouts.PowProofHeaderBytes;
        foreach (var field in encoded)
        {
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset), checked((ushort)field.Length));
            field.CopyTo(bytes, offset + 2);
            offset += 2 + field.Length;
        }
        return Convert.ToBase64String(bytes);
    }

    private static string FixedText(ReadOnlySpan<byte> field, string name)
    {
        var end = field.IndexOf((byte)0);
        if (end < 0) end = field.Length;
        Assert.True(end > 0, $"PoW challenge {name} is empty.");
        Assert.False(field[end..].ContainsAnyExcept((byte)0), $"PoW challenge {name} has non-zero padding.");
        return StrictUtf8.GetString(field[..end]);
    }
}
