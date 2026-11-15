using System.Data.Common;
using System.Security.Cryptography;
using Npgsql;

internal static partial class Migration
{
    private static async Task<byte[]> ReadBoundedArtifactAsync(Stream input, int limit, CancellationToken ct,
        Func<Exception> invalidSize, Func<Exception> changed, string? expectedSha256 = null)
    {
        var length = input.Length;
        if (length < 1 || length > limit) throw invalidSize();
        var bytes = new byte[(int)length];
        await input.ReadExactlyAsync(bytes, ct);
        if (input.ReadByte() != -1 || expectedSha256 is not null &&
            Convert.ToHexStringLower(SHA256.HashData(bytes)) != expectedSha256)
            throw changed();
        return bytes;
    }

    private static async Task<int> RunBoundedLegacyOperationAsync(CancellationToken token, int minutes,
        string timeoutError, string databaseError, Func<CancellationToken, Task<int>> run,
        bool postgresState = false, string? representationError = null)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(minutes));
        try
        {
            return await run(deadline.Token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            throw new InvalidOperationException(timeoutError);
        }
        catch (DbException error)
        {
            var code = postgresState && error is PostgresException postgres ? postgres.SqlState : error.GetType().Name;
            throw new InvalidOperationException($"{databaseError} ({code}).");
        }
        catch (Exception error) when (representationError is not null && error is (OverflowException or InvalidCastException))
        {
            throw new InvalidOperationException(representationError);
        }
    }
}
