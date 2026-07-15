using System.Data.Common;

internal static class PositiveProjectionReader
{
    private const long MinMemoryKib = 19456;
    private const long MinIterations = 2;
    private const long RecoveryKeyPbkdf2Iterations = 600000;

    internal static int ReadId(DbDataReader reader)
        => reader.GetInt32(reader.GetOrdinal("id"));
}
