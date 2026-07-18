using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using Npgsql;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaMigrationLock
{
    Task<IAsyncDisposable> AcquireAsync(CancellationToken cancellationToken);
}

public sealed class SchemaMigrationLock(IConfiguration configuration) : ISchemaMigrationLock
{
    private const long LockKey = 761245219401267873L;

    public async Task<IAsyncDisposable> AcquireAsync(CancellationToken cancellationToken)
    {
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("致命错误：未配置数据库连接字符串 DefaultConnection。");
        }

        var connection = new NpgsqlConnection(SqlSugarInitializer.NormalizeConnectionString(connectionString));
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT pg_advisory_lock(@lock_key);";
        command.Parameters.AddWithValue("lock_key", LockKey);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);

        return new Releaser(connection);
    }

    private sealed class Releaser(NpgsqlConnection connection) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            try
            {
                await using var command = connection.CreateCommand();
                command.CommandText = "SELECT pg_advisory_unlock(@lock_key);";
                command.Parameters.AddWithValue("lock_key", LockKey);
                _ = await command.ExecuteNonQueryAsync().ConfigureAwait(false);
            }
            finally
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }
        }
    }
}
