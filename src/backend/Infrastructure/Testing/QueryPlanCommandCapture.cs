using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Npgsql;

using SqlSugar;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Infrastructure.Testing;

// Private, test-only command material. Public runtime-cache receipts remain redacted.
internal sealed class QueryPlanCommandCaptureStore
{
    internal const string DirectoryKey = "fsus:queryPlanCaptureDirectory";
    internal const string BindingPathKey = "fsus:queryPlanCaptureBindingPath";
    private readonly string _directory;
    private readonly JsonElement _binding;
    private readonly Dictionary<string, string> _captureIdentities = new(StringComparer.Ordinal);
    private readonly object _identityGate = new();

    private QueryPlanCommandCaptureStore(string directory, JsonElement binding)
    {
        _directory = directory;
        _binding = binding;
    }

    internal static QueryPlanCommandCaptureStore? Load(IConfiguration configuration, IHostEnvironment environment)
    {
        string? directory = configuration[DirectoryKey];
        if (string.IsNullOrWhiteSpace(directory))
        {
            return null;
        }
        if ((!environment.IsDevelopment() && !environment.IsEnvironment("Test")) || !Path.IsPathFullyQualified(directory))
        {
            throw new InvalidOperationException("query plan capture requires Development/Test and an absolute private directory");
        }
        string bindingPath = configuration[BindingPathKey]
            ?? throw new InvalidOperationException("query plan capture binding unavailable");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(bindingPath));
        JsonElement binding = document.RootElement.Clone();
        CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(binding.GetProperty("sourceCommit").GetString()!);
        foreach (string field in new[] { "dataScaleRunId", "fixtureGeneration", "seedReceiptDigest", "expectedModelDigest", "businessEpochUtc" })
        {
            if (string.IsNullOrWhiteSpace(binding.GetProperty(field).GetString()))
            {
                throw new InvalidOperationException("query plan capture binding incomplete");
            }
        }
        TestTemporalRuntimeContext temporal = TestTemporalRuntimeContext.LoadOptional()
            ?? throw new InvalidOperationException("query plan capture requires the canonical fixed temporal context");
        if (temporal.BusinessEpochUtc != DateTimeOffset.Parse(binding.GetProperty("businessEpochUtc").GetString()!, CultureInfo.InvariantCulture))
        {
            throw new InvalidOperationException("query plan capture business epoch mismatch");
        }
        if (Directory.Exists(directory))
        {
            if (new DirectoryInfo(directory).LinkTarget is not null || (!OperatingSystem.IsWindows()
                && (File.GetUnixFileMode(directory) & (UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
                    | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute)) != 0))
            {
                throw new InvalidOperationException("query plan capture directory must be private and not a symbolic link");
            }
        }
        else if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(directory);
        }
        else
        {
            Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return new(directory, binding);
    }

    internal QueryPlanCommandCapture Begin(string requestId)
    {
        lock (_identityGate)
        {
            if (_captureIdentities.Count >= 4096 && !_captureIdentities.ContainsKey(requestId))
            {
                throw new InvalidOperationException("query capture request inventory exhausted");
            }
            string identity = Guid.NewGuid().ToString("N");
            bool unique = _captureIdentities.TryAdd(requestId, identity);
            if (!unique)
            {
                _captureIdentities[requestId] = identity;
            }
            return new(_directory, _binding, requestId,
                publish =>
                {
                    lock (_identityGate)
                    {
                        if (_captureIdentities.TryGetValue(requestId, out string? current) && current == identity)
                        {
                            publish();
                        }
                    }
                }, unique ? null : "duplicateRequestId");
        }
    }
}

internal sealed class QueryPlanCommandCapture(string directory, JsonElement binding, string requestId, Action<Action> publishIfCurrent, string? initialFailure)
{
    private const int MaxCommands = 1024;
    private const int MaxMaterialBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions s_json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly object _gate = new();
    private readonly List<QueryPlanCapturedCommand> _commands = [];
    private readonly List<string> _failures = initialFailure is null ? [] : [initialFailure];
    private int _materialBytes;

    internal void Record(string sql, SugarParameter[] parameters, string connectionString)
        => RecordCore(sql, connectionString, () => parameters.Select(static parameter => Encode(
            parameter.ParameterName, parameter.Value, parameter.DbType, null)).ToArray());

    internal void Record(NpgsqlCommand command)
        => RecordCore(command.CommandText, command.Connection?.ConnectionString ?? string.Empty, () => command.Parameters.Cast<NpgsqlParameter>().Select(static parameter => Encode(
            parameter.ParameterName, parameter.Value, parameter.DbType, parameter.NpgsqlDbType.ToString())).ToArray());

    private void RecordCore(string sql, string connectionString, Func<QueryPlanCapturedParameter[]> encode)
    {
        lock (_gate)
        {
            try
            {
                if (_commands.Count >= MaxCommands || Encoding.UTF8.GetByteCount(sql) > 256 * 1024)
                {
                    throw new InvalidOperationException("query command capture truncated");
                }
                QueryPlanCapturedParameter[] parameters = encode();
                int bytes = Encoding.UTF8.GetByteCount(sql) + JsonSerializer.SerializeToUtf8Bytes(parameters, s_json).Length;
                if (_materialBytes + bytes > MaxMaterialBytes)
                {
                    throw new InvalidOperationException("query parameter capture truncated");
                }
                _materialBytes += bytes;
                var connection = new NpgsqlConnectionStringBuilder(connectionString);
                _commands.Add(new(sql, parameters, new(connection.Host, connection.Port, connection.Database,
                    connection.SearchPath, connection.Options)));
            }
            catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException or JsonException or ArgumentException)
            {
                // Do not log SQL or values, even when the private capture fails.
                if (_failures.Count == 0)
                {
                    _failures.Add(exception.GetType().Name);
                }
            }
        }
    }

    private static QueryPlanCapturedParameter Encode(string name, object? value, DbType? dbType, string? npgsqlDbType)
    {
        value = value is DBNull ? null : value;
        string valueType = value?.GetType().FullName ?? "null";
        if (valueType is not ("null" or "System.Boolean" or "System.Int16" or "System.Int32" or "System.Int64"
            or "System.Single" or "System.Double" or "System.Decimal" or "System.String" or "System.Guid"
            or "System.DateTime" or "System.DateTimeOffset" or "System.Byte[]" or "System.Int32[]" or "System.String[]"))
        {
            throw new NotSupportedException("query parameter type unsupported");
        }
        return new(name, valueType, dbType?.ToString(), npgsqlDbType, JsonSerializer.SerializeToElement(value));
    }

    internal void Publish(RuntimeCacheRequestObservation observation)
    {
        lock (_gate)
        {
            publishIfCurrent(() => PublishCurrent(observation));
        }
    }

    private void PublishCurrent(RuntimeCacheRequestObservation observation)
    {
        bool complete = observation.DatabaseAttributionComplete && observation.DatabaseObservationStatus == "complete"
            && observation.DatabaseCommandCount == _commands.Count && _failures.Count == 0
            && observation.DatabaseFingerprints.Order(StringComparer.Ordinal).SequenceEqual(
                _commands.Select(static command => RuntimeCacheEvidenceObservation.FingerprintSql(command.Sql)).Order(StringComparer.Ordinal));
        string fileName = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(requestId))) + ".json";
        string path = Path.Combine(directory, fileName);
        string temporaryPath = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        try
        {
            using (var stream = new FileStream(temporaryPath, options))
            {
                JsonSerializer.Serialize(stream, new
                {
                    schema = "fsusblog.query-command-capture.v1",
                    status = complete ? "captured" : "failed",
                    qualification = "not-performed",
                    binding,
                    observation,
                    commands = _commands,
                    failureReasons = _failures
                }, s_json);
            }
            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }
}

internal sealed record QueryPlanCapturedCommand(string Sql, QueryPlanCapturedParameter[] Parameters, QueryPlanCapturedDatabaseContext DatabaseContext);
internal sealed record QueryPlanCapturedDatabaseContext(string? Host, int Port, string? Database, string? SearchPath, string? Options);
internal sealed record QueryPlanCapturedParameter(string Name, string ValueType, string? DbType, string? NpgsqlDbType, JsonElement Value);
