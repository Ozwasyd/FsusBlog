using System.Data.Common;

namespace FsusBlog.Core.Mapping.Readers;

public static class PodRowMapper
{
    public static int Ordinal(DbDataReader reader, string name) => reader.GetOrdinal(name);

    public static int Int32(DbDataReader reader, int ordinal) => reader.GetInt32(ordinal);

    public static long Int64(DbDataReader reader, int ordinal) => reader.GetInt64(ordinal);

    public static DateTime DateTime(DbDataReader reader, int ordinal) => reader.GetDateTime(ordinal);

    public static string String(DbDataReader reader, int ordinal, string fallback = "")
        => reader.IsDBNull(ordinal) ? fallback : reader.GetString(ordinal);

    public static bool Bool(DbDataReader reader, int ordinal, bool fallback = false)
        => reader.IsDBNull(ordinal) ? fallback : reader.GetBoolean(ordinal);

    public static int? NullableInt32(DbDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);

    public static DateTime? NullableDateTime(DbDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetDateTime(ordinal);
}
