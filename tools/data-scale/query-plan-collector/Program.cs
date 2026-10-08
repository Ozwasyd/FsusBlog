using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Testing;

using Npgsql;

using NpgsqlTypes;

try
{
    if (args.Length == 3 && args[0] == "--expected-controls")
    {
        ExpectedArticleControls.Run(args[1], args[2]);
        return 0;
    }
    if (args.Length == 6 && args[0] == "--expected-articles")
    {
        await CanonicalQueryExpectedArticles.ExportAsync(args[1], args[2], args[3], args[4], args[5]);
        return 0;
    }
    if (args.Length > 0 && args[0] == "--self-test")
    {
        return await CollectorControls.RunAsync(args);
    }
    if (args.Length != 4)
    {
        Console.Error.WriteLine("usage: QueryPlanCollector <private-command-capture> <binding> <private-connection-file> <private-output>");
        return 2;
    }
    await QueryPlanCollector.CollectAsync(args[0], args[1], args[2], args[3]);
    Console.WriteLine("{\"status\":\"collected\",\"qualification\":\"not-performed\"}");
    return 0;
}
catch (Exception exception)
{
    // Driver exception messages can contain SQL, parameters or credentials.
    Console.Error.WriteLine(JsonSerializer.Serialize(new
    {
        status = "failed",
        code = exception.GetType().Name
    }));
    return 1;
}

internal static partial class QueryPlanCollector
{
    internal static async Task CollectAsync(string capturePath, string bindingPath, string connectionPath, string outputPath)
    {
        using JsonDocument capture = JsonDocument.Parse(await File.ReadAllTextAsync(capturePath));
        using JsonDocument expectedBinding = JsonDocument.Parse(await File.ReadAllTextAsync(bindingPath));
        JsonElement root = capture.RootElement;
        ValidateCapture(root, expectedBinding.RootElement);
        var connectionBuilder = new NpgsqlConnectionStringBuilder((await File.ReadAllTextAsync(connectionPath)).Trim());
        if (connectionBuilder.Host is not ("127.0.0.1" or "localhost" or "::1")
            || string.IsNullOrWhiteSpace(connectionBuilder.Database))
        {
            throw new InvalidOperationException("collector requires an admitted disposable loopback database");
        }
        var queries = new List<object>();
        bool failed = false;
        foreach (JsonElement source in root.GetProperty("commands").EnumerateArray())
        {
            try
            {
                JsonElement context = source.GetProperty("databaseContext");
                if (context.GetProperty("host").GetString() != connectionBuilder.Host
                    || context.GetProperty("port").GetInt32() != connectionBuilder.Port
                    || context.GetProperty("database").GetString() != connectionBuilder.Database)
                {
                    throw new InvalidOperationException("captured database identity mismatch");
                }
                var scoped = new NpgsqlConnectionStringBuilder(connectionBuilder.ConnectionString)
                {
                    SearchPath = context.GetProperty("searchPath").GetString(),
                    Options = context.GetProperty("options").GetString(),
                    Pooling = false,
                    CommandTimeout = 30
                };
                string sql = source.GetProperty("sql").GetString()!;
                if (!ReadStatement().IsMatch(sql))
                {
                    throw new InvalidOperationException("captured statement is not a read query");
                }
                await using var connection = new NpgsqlConnection(scoped.ConnectionString);
                await connection.OpenAsync();
                await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
                await using (var guard = new NpgsqlCommand("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '5s';", connection, transaction))
                {
                    await guard.ExecuteNonQueryAsync();
                }
                await using (var epochCheck = new NpgsqlCommand("SELECT current_setting('fsusblog.test_business_epoch_utc', true)", connection, transaction))
                {
                    string? epoch = (await epochCheck.ExecuteScalarAsync()) as string;
                    if (!DateTimeOffset.TryParse(epoch, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset observedEpoch)
                        || observedEpoch != DateTimeOffset.Parse(expectedBinding.RootElement.GetProperty("businessEpochUtc").GetString()!, CultureInfo.InvariantCulture))
                    {
                        throw new InvalidOperationException("actual plan session business epoch mismatch");
                    }
                }
                await using var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, connection, transaction);
                foreach (JsonElement parameter in source.GetProperty("parameters").EnumerateArray())
                {
                    command.Parameters.Add(DecodeParameter(parameter));
                }
                string explain = (string)(await command.ExecuteScalarAsync() ?? throw new InvalidOperationException("actual plan unavailable"));
                using JsonDocument plan = JsonDocument.Parse(explain);
                queries.Add(new
                {
                    status = "collected",
                    command = source.Clone(),
                    explain = plan.RootElement.Clone()
                });
                await transaction.RollbackAsync();
            }
            catch (Exception exception)
            {
                failed = true;
                queries.Add(new
                {
                    status = "failed",
                    command = source.Clone(),
                    failureCode = exception.GetType().Name
                });
            }
        }
        WritePrivate(outputPath, new
        {
            schema = "fsusblog.query-plan-capture.v1",
            status = failed ? "failed" : "collected",
            qualification = "not-performed",
            binding = expectedBinding.RootElement.Clone(),
            observation = root.GetProperty("observation").Clone(),
            queries
        });
        if (failed)
        {
            throw new InvalidOperationException("one or more query plans failed");
        }
    }

    internal static void ValidateCapture(JsonElement capture, JsonElement expectedBinding)
    {
        CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(expectedBinding.GetProperty("sourceCommit").GetString()!);
        if (capture.GetProperty("schema").GetString() != "fsusblog.query-command-capture.v1"
            || capture.GetProperty("status").GetString() != "captured")
        {
            throw new InvalidOperationException("query command collector failed");
        }
        foreach (string field in new[] { "sourceCommit", "dataScaleRunId", "fixtureGeneration", "seedReceiptDigest", "expectedModelDigest", "businessEpochUtc" })
        {
            string? expected = expectedBinding.GetProperty(field).GetString();
            if (string.IsNullOrWhiteSpace(expected) || expected != capture.GetProperty("binding").GetProperty(field).GetString())
            {
                throw new InvalidOperationException("query binding mismatch");
            }
        }
        JsonElement observation = capture.GetProperty("observation");
        int count = capture.GetProperty("commands").GetArrayLength();
        if (!observation.GetProperty("databaseAttributionComplete").GetBoolean()
            || observation.GetProperty("databaseObservationStatus").GetString() != "complete"
            || observation.GetProperty("databaseCommandCount").GetInt32() != count
            || observation.GetProperty("databaseFingerprints").GetArrayLength() != count
            || observation.GetProperty("databaseDroppedCommandCount").GetInt32() != 0
            || observation.GetProperty("databaseLateCommandCount").GetInt32() != 0
            || capture.GetProperty("failureReasons").GetArrayLength() != 0 || count == 0)
        {
            throw new InvalidOperationException("query command attribution incomplete or unavailable");
        }
        if (observation.GetProperty("method").GetString() != "GET" || observation.GetProperty("status").GetInt32() != 200
            || observation.GetProperty("path").GetString()?.StartsWith("/api/binary/", StringComparison.Ordinal) != true)
        {
            throw new InvalidOperationException("captured HTTP read failed");
        }
    }

    internal static NpgsqlParameter DecodeParameter(JsonElement source)
    {
        JsonElement value = source.GetProperty("value");
        object decoded = source.GetProperty("valueType").GetString() switch
        {
            "null" => DBNull.Value,
            "System.Boolean" => value.GetBoolean(),
            "System.Int16" => value.GetInt16(),
            "System.Int32" => value.GetInt32(),
            "System.Int64" => value.GetInt64(),
            "System.Single" => value.GetSingle(),
            "System.Double" => value.GetDouble(),
            "System.Decimal" => value.GetDecimal(),
            "System.String" => value.GetString()!,
            "System.Guid" => value.GetGuid(),
            "System.DateTime" => DateTime.Parse(value.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            "System.DateTimeOffset" => value.GetDateTimeOffset(),
            "System.Byte[]" => value.GetBytesFromBase64(),
            "System.Int32[]" => value.EnumerateArray().Select(static element => element.GetInt32()).ToArray(),
            "System.String[]" => value.EnumerateArray().Select(static element => element.GetString()!).ToArray(),
            _ => throw new NotSupportedException("query parameter type unsupported")
        };
        var parameter = new NpgsqlParameter { ParameterName = source.GetProperty("name").GetString()!, Value = decoded };
        if (source.GetProperty("npgsqlDbType").GetString() is { } npgsqlType)
        {
            parameter.NpgsqlDbType = Enum.Parse<NpgsqlDbType>(npgsqlType);
        }
        else if (source.GetProperty("dbType").GetString() is { } dbType)
        {
            parameter.DbType = Enum.Parse<DbType>(dbType);
        }
        return parameter;
    }

    internal static void WritePrivate(string outputPath, object value)
    {
        string temporaryPath = outputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        try
        {
            using (var stream = new FileStream(temporaryPath, options))
            {
                JsonSerializer.Serialize(stream, value);
            }
            File.Move(temporaryPath, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    [GeneratedRegex(@"^\s*(?:SELECT|WITH)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ReadStatement();
}
