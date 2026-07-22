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
    private static readonly TimeSpan s_retryDelay = TimeSpan.FromMilliseconds(100);

    public async Task<IAsyncDisposable> AcquireAsync(CancellationToken cancellationToken)
    {
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("致命错误：未配置数据库连接字符串 DefaultConnection。");
        }

        var connection = new NpgsqlConnection(SqlSugarInitializer.NormalizeConnectionString(connectionString));
        try
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            while (true)
            {
                await using var command = connection.CreateCommand();
                command.CommandText = "SELECT pg_try_advisory_lock(@lock_key);";
                command.Parameters.AddWithValue("lock_key", LockKey);
                object? acquired = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
                if (acquired is true)
                {
                    return new Releaser(connection);
                }

                // A blocking advisory-lock statement owns a virtual transaction while
                // waiting. That can deadlock the lock holder when a migration executes
                // CREATE INDEX CONCURRENTLY, which waits for all virtual transactions.
                await Task.Delay(s_retryDelay, cancellationToken).ConfigureAwait(false);
            }
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
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
