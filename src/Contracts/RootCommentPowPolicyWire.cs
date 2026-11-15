namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    public static bool IsRootCommentPowLifetime(int seconds) =>
        seconds is >= WireLimits.RootCommentPowMinSeconds and <= WireLimits.PowChallengeSeconds;

    private static bool IsRootCommentPowDigest(string digest) =>
        digest.Length == WireLimits.RootCommentPowDigestBytes && digest.All(char.IsAsciiHexDigitLower);

    internal static void Validate(AdminRootCommentPowPolicy value)
    {
        if (value.Generation < 1 || !IsRootCommentPowDigest(value.Digest) || !IsRootCommentPowLifetime(value.ProofSeconds) ||
            (value.Generation == 1 ? value.ProofSeconds != WireLimits.PowChallengeSeconds || value.PreviousSeconds != 0
                : !IsRootCommentPowLifetime(value.PreviousSeconds) || value.PreviousSeconds == value.ProofSeconds))
            throw new ProtocolException("Invalid root comment proof policy.");
    }

    internal static void Validate(AdminRootCommentPowCommand value)
    {
        if (value.ExpectedGeneration < 1 || !IsRootCommentPowDigest(value.ExpectedDigest) || !IsRootCommentPowLifetime(value.ProofSeconds))
            throw new ProtocolException("Invalid root comment proof policy command.");
    }
}
