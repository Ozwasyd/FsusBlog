using System.Data.Common;

namespace FsusBlog.Server.Infrastructure.Data;

public static class DbDataReaderNamedExtensions
{
    public static bool ReadBoolean(this DbDataReader reader, string columnName)
        => reader.GetBoolean(RequireOrdinal(reader, columnName));

    public static DateTime ReadDateTime(this DbDataReader reader, string columnName)
        => reader.GetDateTime(RequireOrdinal(reader, columnName));

    public static double ReadDouble(this DbDataReader reader, string columnName)
        => reader.GetDouble(RequireOrdinal(reader, columnName));

    public static int ReadInt32(this DbDataReader reader, string columnName)
        => reader.GetInt32(RequireOrdinal(reader, columnName));

    public static long ReadInt64(this DbDataReader reader, string columnName)
        => reader.GetInt64(RequireOrdinal(reader, columnName));

    public static string ReadString(this DbDataReader reader, string columnName)
        => reader.GetString(RequireOrdinal(reader, columnName));

    public static object ReadValue(this DbDataReader reader, string columnName)
        => reader.GetValue(RequireOrdinal(reader, columnName));

    public static T ReadFieldValue<T>(this DbDataReader reader, string columnName)
        => reader.GetFieldValue<T>(RequireOrdinal(reader, columnName));

    public static bool IsNull(this DbDataReader reader, string columnName)
        => reader.IsDBNull(RequireOrdinal(reader, columnName));

    public static int RequireOrdinal(this DbDataReader reader, string columnName)
    {
        ArgumentNullException.ThrowIfNull(reader);
        if (string.IsNullOrWhiteSpace(columnName))
        {
            throw new ArgumentException("Projection column name is required.", nameof(columnName));
        }

        int ordinal;
        try
        {
            ordinal = reader.GetOrdinal(columnName);
        }
        catch (Exception exception) when (exception is ArgumentException or IndexOutOfRangeException)
        {
            throw new InvalidOperationException(
                $"Required projection column '{columnName}' was not returned by the query.",
                exception);
        }

        string actualName = reader.GetName(ordinal);
        if (!string.Equals(actualName, columnName, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Projection column '{columnName}' resolved to unexpected column '{actualName}'.");
        }

        return ordinal;
    }
}
