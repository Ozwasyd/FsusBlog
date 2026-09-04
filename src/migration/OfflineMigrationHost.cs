using System.Text.Json;

using SqlSugar;

namespace FsusBlog.Migration;

/// <summary>
/// Offline migration command host (run-online-migrations.sh invoke target).
/// Applies schema descriptors from the migration assembly against a database
/// selected by <c>ConnectionStrings__DefaultConnection</c> (env file or
/// process environment), outside the Server process boundary.
/// </summary>
public static class OfflineMigrationHost
{
    internal const string StateLockConstant = "fsusblog-offline-migration";

    public static async Task<int> Main(string[] args)
    {
        OfflineMigrationCommandOptions parsed;
        try
        {
            parsed = OfflineMigrationCommandLine.Parse(args);
        }
        catch (InvalidOperationException exception)
        {
            WriteJson(new
            {
                status = "failed",
                code = exception.Message
            });
            return 2;
        }

        try
        {
            string connectionString = await ResolveConnectionStringAsync(parsed).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException("schema_connection_string_missing");
            }

            string releaseId = ResolveReleaseId(parsed);
            var result = await OfflineMigrationExecutor.RunAsync(
                parsed,
                connectionString,
                releaseId,
                CancellationToken.None).ConfigureAwait(false);
            WriteJson(new
            {
                status = result.Status,
                phase = result.Phase?.ToString().ToLowerInvariant(),
                migrationIds = result.MigrationIds,
                codes = result.Codes
            });
            return result.Status == "ok" ? 0 : 1;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            string code = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
            WriteJson(new
            {
                status = "failed",
                code,
                detail = exception.Message
            });
            return 1;
        }
    }

    private static async Task<string> ResolveConnectionStringAsync(OfflineMigrationCommandOptions parsed)
    {
        string? fromFile = parsed.EnvironmentFilePath is null
            ? null
            : ReadEnvironmentFile(parsed.EnvironmentFilePath)
                .GetValueOrDefault("ConnectionStrings__DefaultConnection");
        string fromProcess = Environment.GetEnvironmentVariable("ConnectionStrings__DefaultConnection") ?? string.Empty;
        // Env file wins for deployment invocation; process environment covers local runs.
        return !string.IsNullOrWhiteSpace(fromFile) ? fromFile : fromProcess;
    }

    private static string ResolveReleaseId(OfflineMigrationCommandOptions parsed)
    {
        if (!string.IsNullOrWhiteSpace(parsed.ReleaseManifestPath))
        {
            using JsonDocument document = JsonDocument.Parse(
                File.ReadAllText(parsed.ReleaseManifestPath));
            if (document.RootElement.TryGetProperty("releaseId", out JsonElement releaseId)
                && releaseId.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(releaseId.GetString()))
            {
                return releaseId.GetString()!;
            }
        }

        return Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID")
            ?? "dev-offline";
    }

    private static Dictionary<string, string> ReadEnvironmentFile(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string rawLine in File.ReadAllLines(path))
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
            {
                continue;
            }

            line = line.StartsWith("export ", StringComparison.Ordinal)
                ? line["export ".Length..].TrimStart()
                : line;
            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                throw new InvalidOperationException("schema_env_file_line_invalid");
            }

            string key = line[..separator].Trim();
            string value = line[(separator + 1)..].Trim();
            if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            {
                value = value[1..^1];
            }

            values[key] = value;
        }

        return values;
    }

    private static void WriteJson(object payload)
        => Console.WriteLine(JsonSerializer.Serialize(payload));

    internal static ISqlSugarClient CreateDatabase(string connectionString)
        => new SqlSugarClient(new ConnectionConfig
        {
            DbType = DbType.PostgreSQL,
            ConnectionString = connectionString,
            IsAutoCloseConnection = false
        });
}
