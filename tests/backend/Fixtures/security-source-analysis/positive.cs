using System.Security.Cryptography;

internal sealed class PositiveSecurityFixture
{
    private const int MinMemoryKib = 19_456;
    private const int MinIterations = 2;
    private const int RecoveryKeyPbkdf2Iterations = 600_000;

    internal static byte[] CreateNonce() => RandomNumberGenerator.GetBytes(32);

    internal static bool Compare(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
        => expected.Length == actual.Length && CryptographicOperations.FixedTimeEquals(expected, actual);

    internal static void Log(ILogger logger, string accountSubjectHash)
        => logger.LogInformation("AccountSubjectHash={AccountSubjectHash}", accountSubjectHash);
}

