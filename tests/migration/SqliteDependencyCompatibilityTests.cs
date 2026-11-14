using Microsoft.Data.Sqlite;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Exercises the centrally pinned native library through Migration's real provider.
/// This owned database fixture proves storage compatibility, not FILESTAT or migration admission.
/// </summary>
public sealed class SqliteDependencyCompatibilityTests
{
    [Fact]
    public void PinnedNativeLibraryPreservesCommittedBytesAndRollsBackChangesAfterReopen()
    {
        string directory = Path.Combine(Path.GetTempPath(), "fsusblog-sqlite-dependency-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "compatibility.db"),
            Pooling = false
        }.ToString();
        byte[] bytes = [0, 1, 127, 128, 255];
        const string Text = "标题🙂'\nunchanged";
        try
        {
            using (var connection = new SqliteConnection(connectionString))
            {
                connection.Open();
                Assert.Equal("3.53.3", connection.ServerVersion);
                Assert.Equal(3053003, SQLitePCL.raw.sqlite3_libversion_number());
                using SqliteCommand command = connection.CreateCommand();
                command.CommandText = "CREATE TABLE item(id INTEGER PRIMARY KEY, body TEXT NOT NULL, payload BLOB NOT NULL)";
                command.ExecuteNonQuery();
                using (SqliteTransaction transaction = connection.BeginTransaction())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT INTO item VALUES(1, @body, @payload)";
                    command.Parameters.AddWithValue("@body", Text);
                    command.Parameters.AddWithValue("@payload", bytes);
                    Assert.Equal(1, command.ExecuteNonQuery());
                    transaction.Commit();
                }
                using (SqliteTransaction transaction = connection.BeginTransaction())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE item SET body = 'changed', payload = X'FF'";
                    Assert.Equal(1, command.ExecuteNonQuery());
                    transaction.Rollback();
                }
            }
            using (var connection = new SqliteConnection(connectionString))
            {
                connection.Open();
                using SqliteCommand command = connection.CreateCommand();
                command.CommandText = "SELECT body, payload FROM item WHERE id = 1";
                using (SqliteDataReader reader = command.ExecuteReader())
                {
                    Assert.True(reader.Read());
                    Assert.Equal(Text, reader.GetString(0));
                    Assert.Equal(bytes, reader.GetFieldValue<byte[]>(1));
                    Assert.False(reader.Read());
                }
                command.CommandText = "PRAGMA integrity_check";
                Assert.Equal("ok", command.ExecuteScalar());
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
