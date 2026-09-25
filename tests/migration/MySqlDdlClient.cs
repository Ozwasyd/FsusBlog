using System.Globalization;
using System.Text;

using MySqlConnector;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Test-only TCP transport for an already admitted, run-owned MySQL fixture.
/// The caller owns catalog/receipt admission, resource grants and container cleanup;
/// this client cannot start a service or substitute an ambient connection string.
/// </summary>
public sealed class MySqlDdlClient
{
    private readonly string _connectionString;
    private readonly string _databasePrefix;
    private readonly Guid _serverUuid;
    private readonly string _serverVersion;
    private readonly string _userName;
    private int _databaseSequence;

    public MySqlDdlClient(
        uint port,
        string userName,
        string password,
        string databasePrefix,
        Guid serverUuid,
        string serverVersion,
        uint timeoutSeconds)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(userName);
        ArgumentException.ThrowIfNullOrWhiteSpace(password);
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePrefix);
        ArgumentException.ThrowIfNullOrWhiteSpace(serverVersion);
        if (port is 0 or > 65535 || timeoutSeconds is 0 or > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(port), "MySQL requires a valid admitted port and positive operation budget.");
        }
        if (userName.Length > 32 || userName.Equals("root", StringComparison.OrdinalIgnoreCase)
            || userName.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_'))
        {
            throw new ArgumentException("MySQL DDL requires a dedicated fixture account, not root.", nameof(userName));
        }
        if (databasePrefix.Length is < 5 or > 30
            || !databasePrefix.StartsWith("ddl_", StringComparison.Ordinal)
            || !databasePrefix.EndsWith('_')
            || !IsIdentifier(databasePrefix))
        {
            throw new ArgumentException("MySQL requires an exact ddl_ fixture namespace prefix.", nameof(databasePrefix));
        }
        if (serverUuid == Guid.Empty
            || !Version.TryParse(serverVersion, out Version? version)
            || version.Build < 0 || version.Revision != -1
            || version.ToString() != serverVersion)
        {
            throw new ArgumentException("MySQL requires the observed server UUID and exact catalog version.", nameof(serverVersion));
        }
        _databasePrefix = databasePrefix;
        _serverUuid = serverUuid;
        _serverVersion = serverVersion;
        _userName = userName;
        _connectionString = new MySqlConnectionStringBuilder
        {
            Server = "127.0.0.1",
            Port = port,
            UserID = userName,
            Password = password,
            SslMode = MySqlSslMode.Disabled,
            AllowPublicKeyRetrieval = true,
            AllowUserVariables = true,
            Pooling = false,
            AutoEnlist = false,
            TreatTinyAsBoolean = false,
            ConnectionTimeout = timeoutSeconds,
            DefaultCommandTimeout = timeoutSeconds
        }.ConnectionString;
    }

    public async Task<string> CreateDatabaseAsync(CancellationToken cancellationToken = default)
    {
        int sequence = Interlocked.Increment(ref _databaseSequence);
        if (sequence <= 0)
        {
            throw new InvalidOperationException("MySQL fixture database sequence exhausted.");
        }
        string database = _databasePrefix + sequence.ToString(CultureInfo.InvariantCulture);
        (await ExecuteAsync(null, $"CREATE DATABASE `{database}` CHARACTER SET utf8mb4;", cancellationToken)).RequireSuccess();
        return database;
    }

    public async Task<SqlResult> ExecuteAsync(string? database, string sql, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);
        if (database is not null
            && (database.Length > 64 || !database.StartsWith(_databasePrefix, StringComparison.Ordinal)
                || database.Length == _databasePrefix.Length || !IsIdentifier(database)))
        {
            throw new ArgumentException("MySQL database is outside the admitted fixture namespace.", nameof(database));
        }
        // Open without a default database so identity drift is rejected before
        // selecting a schema or executing any caller-owned DDL.
        await using var connection = new MySqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await RequireServerIdentityAsync(connection, cancellationToken);
        try
        {
            if (database is not null)
            {
                await connection.ChangeDatabaseAsync(database, cancellationToken);
            }
            await using var command = new MySqlCommand(sql, connection);
            await using MySqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
            var output = new StringBuilder();
            bool hasRows = false;
            do
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    if (hasRows)
                    {
                        output.Append('\n');
                    }
                    hasRows = true;
                    for (int index = 0; index < reader.FieldCount; index++)
                    {
                        if (index > 0)
                        {
                            output.Append('\t');
                        }
                        output.Append(FormatCell(reader.GetValue(index)));
                    }
                }
            }
            while (await reader.NextResultAsync(cancellationToken));
            return new SqlResult(0, output.ToString(), string.Empty);
        }
        catch (MySqlException exception) when (exception.Number > 0 && exception.SqlState is { Length: 5 })
        {
            return new SqlResult(exception.Number, string.Empty,
                $"ERROR {exception.Number} ({exception.SqlState}): {exception.Message}");
        }
    }

    private async Task RequireServerIdentityAsync(MySqlConnection connection, CancellationToken cancellationToken)
    {
        await using var command = new MySqlCommand("SELECT @@server_uuid, VERSION(), CURRENT_USER();", connection);
        await using MySqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)
            || !Guid.TryParseExact(reader.GetString(0), "D", out Guid observedUuid)
            || observedUuid != _serverUuid
            || reader.GetString(1) != _serverVersion
            || reader.GetString(2) != $"{_userName}@%"
            || await reader.ReadAsync(cancellationToken)
            || await reader.NextResultAsync(cancellationToken))
        {
            throw new InvalidOperationException("MySQL server UUID, version or fixture account drifted from admission.");
        }
    }

    private static bool IsIdentifier(string value)
    {
        return value.All(character => char.IsAsciiLetterLower(character)
            || char.IsAsciiDigit(character) || character == '_');
    }

    private static string FormatCell(object value)
    {
        return value switch
        {
            DBNull => "NULL",
            string text => text,
            byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal
                => Convert.ToString(value, CultureInfo.InvariantCulture)!,
            _ => throw new InvalidOperationException($"Unsupported MySQL DDL observation type: {value.GetType().Name}.")
        };
    }

    public sealed record SqlResult(int ExitCode, string Output, string Error)
    {
        public string RequireSuccess()
        {
            if (ExitCode != 0 || !string.IsNullOrEmpty(Error))
            {
                throw new InvalidOperationException($"MySQL DDL execution failed ({ExitCode}): {Error}");
            }
            return Output;
        }
    }
}
