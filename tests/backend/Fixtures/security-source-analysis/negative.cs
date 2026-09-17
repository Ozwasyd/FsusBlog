internal sealed class NegativeSecurityFixture
{
    private const int MinMemoryKib = 1_024;
    private const int MinIterations = 1;
    private const int RecoveryKeyPbkdf2Iterations = 10_000;

    internal static int WeakRandom() => Random.Shared.Next() + new Random().Next();

    internal static bool Compare(string expectedRoot, string root)
        => string.Equals(expectedRoot, root, StringComparison.OrdinalIgnoreCase);

    internal static void Log(ILogger logger, string token)
        => logger.LogWarning("Token={Token}", token);

    internal static IResult Leak(Exception ex)
        => Results.Problem(ex.Message);
}

