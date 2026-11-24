namespace FsusBlogV2.Storage;

internal static class RequiredReaderRow
{
    internal static async Task ReadRequired(this NpgsqlDataReader reader, CancellationToken ct, Func<Exception> missing)
    {
        if (!await reader.ReadAsync(ct)) throw missing();
    }
}
