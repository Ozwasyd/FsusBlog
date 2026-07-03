using System.Diagnostics;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using Npgsql;

namespace FsusBlog.Server.Tests;

public sealed class PostgresSchemaMigrationFixture : IAsyncLifetime
{
    private string? _containerName;
    private string? _adminConnectionString;

    public async Task InitializeAsync()
    {
        _containerName = $"fsus-schema-migration-{Guid.NewGuid():N}";
        string postgresImage = Environment.GetEnvironmentVariable("FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE") ?? "postgres:18-alpine";

        string containerId = await RunDockerAsync(
            "run",
            "--rm",
            "-d",
            "--name", _containerName,
            "-e", "POSTGRES_USER=postgres",
            "-e", "POSTGRES_PASSWORD=postgres",
            "-e", "POSTGRES_DB=postgres",
            "-p", "127.0.0.1::5432",
            postgresImage).ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(containerId))
        {
            throw new InvalidOperationException("Failed to start PostgreSQL container for schema migration tests.");
        }

        string portOutput = await RunDockerAsync("port", _containerName, "5432/tcp").ConfigureAwait(false);
        int port = ParseMappedPort(portOutput);
        _adminConnectionString = $"Host=127.0.0.1;Port={port};Database=postgres;Username=postgres;Password=postgres;Pooling=false;Timeout=30;Command Timeout=60";

        await WaitUntilReadyAsync(_adminConnectionString).ConfigureAwait(false);
    }

    public async Task DisposeAsync()
    {
        if (!string.IsNullOrWhiteSpace(_containerName))
        {
            _ = await TryRunDockerAsync("rm", "-f", _containerName).ConfigureAwait(false);
        }
    }

    public async Task<string> CreateDatabaseAsync()
    {
        string databaseName = $"fsus_migration_{Guid.NewGuid():N}";
        await using var connection = new NpgsqlConnection(_adminConnectionString);
        await connection.OpenAsync().ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandText = $"CREATE DATABASE \"{databaseName}\";";
        await command.ExecuteNonQueryAsync().ConfigureAwait(false);
        return databaseName;
    }

    public string BuildDatabaseConnectionString(string databaseName)
    {
        if (string.IsNullOrWhiteSpace(_adminConnectionString))
        {
            throw new InvalidOperationException("Fixture is not initialized.");
        }

        var builder = new NpgsqlConnectionStringBuilder(_adminConnectionString)
        {
            Database = databaseName
        };
        return SqlSugarInitializer.NormalizeConnectionString(builder.ConnectionString);
    }

    public async Task ExecuteAsync(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync().ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync().ConfigureAwait(false);
    }

    public async Task<T> QueryScalarAsync<T>(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync().ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        object? value = await command.ExecuteScalarAsync().ConfigureAwait(false);
        return (T)Convert.ChangeType(value!, typeof(T))!;
    }

    public async Task RestoreCustomDumpAsync(string connectionString, string dumpPath)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString);
        string host = builder.Host ?? "127.0.0.1";
        string password = builder.Password ?? "postgres";
        string username = builder.Username ?? "postgres";
        string database = builder.Database ?? throw new InvalidOperationException("Connection string database is required for dump restore.");
        var environment = new Dictionary<string, string?>
        {
            ["PGPASSWORD"] = password
        };

        string[] args =
        [
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "-h", host,
            "-p", builder.Port.ToString(),
            "-U", username,
            "-d", database,
            dumpPath
        ];

        try
        {
            await RunProcessAsync("pg_restore", args, throwOnNonZeroExitCode: true, environment).ConfigureAwait(false);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            await RestoreCustomDumpInsidePostgresContainerAsync(dumpPath, username, password, database).ConfigureAwait(false);
        }
    }

    private async Task RestoreCustomDumpInsidePostgresContainerAsync(
        string dumpPath,
        string username,
        string password,
        string database)
    {
        if (string.IsNullOrWhiteSpace(_containerName))
        {
            throw new InvalidOperationException("PostgreSQL container is not initialized and local pg_restore is unavailable.");
        }

        const string containerDumpPath = "/tmp/fsus-legacy-20260517.pgcustom";
        await RunDockerAsync("cp", dumpPath, $"{_containerName}:{containerDumpPath}").ConfigureAwait(false);
        await RunDockerAsync(
            "exec",
            "-e", $"PGPASSWORD={password}",
            _containerName,
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "-h", "127.0.0.1",
            "-p", "5432",
            "-U", username,
            "-d", database,
            containerDumpPath).ConfigureAwait(false);
    }

    public async Task<bool> ColumnExistsAsync(string connectionString, string tableName, string columnName)
        => await QueryScalarAsync<int>(
            connectionString,
            $"""
            SELECT COUNT(1)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = '{tableName}'
              AND column_name = '{columnName}';
            """).ConfigureAwait(false) > 0;

    public async Task<bool> TableExistsAsync(string connectionString, string tableName)
        => await QueryScalarAsync<int>(
            connectionString,
            $"""
            SELECT COUNT(1)
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = '{tableName}';
            """).ConfigureAwait(false) > 0;

    public async Task<bool> IndexExistsAsync(string connectionString, string indexName)
        => await QueryScalarAsync<int>(
            connectionString,
            $"""
            SELECT COUNT(1)
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = '{indexName}';
            """).ConfigureAwait(false) > 0;

    private static async Task WaitUntilReadyAsync(string connectionString)
    {
        Exception? last = null;
        for (int attempt = 0; attempt < 60; attempt++)
        {
            try
            {
                await using var connection = new NpgsqlConnection(connectionString);
                await connection.OpenAsync().ConfigureAwait(false);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                await Task.Delay(500).ConfigureAwait(false);
            }
        }

        throw new InvalidOperationException("Timed out waiting for PostgreSQL test container to become ready.", last);
    }

    private static int ParseMappedPort(string output)
    {
        string lastToken = output
            .Trim()
            .Split([':', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Last();

        return int.Parse(lastToken, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static Task<string> TryRunDockerAsync(params string[] args)
        => RunProcessAsync("docker", args, throwOnNonZeroExitCode: false, environment: null);

    private static Task<string> RunDockerAsync(params string[] args)
        => RunProcessAsync("docker", args, throwOnNonZeroExitCode: true, environment: null);

    private static async Task<string> RunProcessAsync(
        string fileName,
        string[] args,
        bool throwOnNonZeroExitCode,
        IReadOnlyDictionary<string, string?>? environment)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
        };

        for (int i = 0; i < args.Length; i++)
        {
            process.StartInfo.ArgumentList.Add(args[i]);
        }

        if (environment is not null)
        {
            foreach ((string key, string? value) in environment)
            {
                if (value is not null)
                {
                    process.StartInfo.Environment[key] = value;
                }
            }
        }

        process.Start();
        string stdout = await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
        string stderr = await process.StandardError.ReadToEndAsync().ConfigureAwait(false);
        await process.WaitForExitAsync().ConfigureAwait(false);

        if (throwOnNonZeroExitCode && process.ExitCode != 0)
        {
            throw new InvalidOperationException($"{fileName} {string.Join(' ', args)} failed with exit code {process.ExitCode}: {stderr}");
        }

        return string.IsNullOrWhiteSpace(stdout) ? stderr.Trim() : stdout.Trim();
    }
}
