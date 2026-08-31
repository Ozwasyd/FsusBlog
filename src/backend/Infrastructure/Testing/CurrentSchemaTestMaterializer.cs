using System.Data;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;

using Npgsql;

using SqlSugar;

using DbType = SqlSugar.DbType;

namespace FsusBlog.Server.Infrastructure.Testing;

public static class CurrentSchemaTestMaterializationCommandLine
{
    public const string CommandName = "materialize-current-schema-test";

    public static bool IsRequested(IReadOnlyList<string> arguments)
        => arguments.Count > 0
            && string.Equals(arguments[0], CommandName, StringComparison.Ordinal);

    public static CurrentSchemaTestMaterializationOptions Parse(IReadOnlyList<string> arguments)
    {
        if (!IsRequested(arguments))
        {
            throw new InvalidOperationException("current_schema_materializer_command_missing");
        }

        string? output = null;
        string? runId = null;
        string? sourceCommit = null;
        string? serviceEnvelope = null;
        var seenOptions = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 1; index < arguments.Count; index++)
        {
            string value = arguments[index];
            string ReadValue()
                => ++index < arguments.Count
                    ? arguments[index]
                    : throw new InvalidOperationException($"current_schema_materializer_argument_missing:{value}");

            switch (value)
            {
                case "--output":
                    EnsureSingleOccurrence(value, seenOptions);
                    output = ReadValue();
                    break;
                case "--run-id":
                    EnsureSingleOccurrence(value, seenOptions);
                    runId = ReadValue();
                    break;
                case "--source-commit":
                    EnsureSingleOccurrence(value, seenOptions);
                    sourceCommit = ReadValue();
                    break;
                case "--service-envelope":
                    EnsureSingleOccurrence(value, seenOptions);
                    serviceEnvelope = ReadValue();
                    break;
                default:
                    throw new InvalidOperationException($"current_schema_materializer_argument_unknown:{value}");
            }
        }

        return new CurrentSchemaTestMaterializationOptions(
            RequireValue(output, "output"),
            RequireValue(runId, "run-id"),
            RequireSourceCommit(sourceCommit),
            RequireValue(serviceEnvelope, "service-envelope"));
    }

    private static string RequireValue(string? value, string name)
        => string.IsNullOrWhiteSpace(value)
            ? throw new InvalidOperationException($"current_schema_materializer_argument_missing:{name}")
            : value;

    private static void EnsureSingleOccurrence(string option, HashSet<string> seenOptions)
    {
        if (!seenOptions.Add(option))
        {
            throw new InvalidOperationException($"current_schema_materializer_argument_duplicate:{option}");
        }
    }

    private static string RequireSourceCommit(string? value)
    {
        string commit = RequireValue(value, "source-commit");
        if (commit.Length != 40 || commit.Any(static character => !Uri.IsHexDigit(character) || char.IsUpper(character)))
        {
            throw new InvalidOperationException("current_schema_materializer_source_commit_invalid");
        }
        return commit;
    }
}

public sealed record CurrentSchemaTestMaterializationOptions(
    string OutputPath,
    string RunId,
    string SourceCommit,
    string ServiceEnvelopePath);

public sealed record CurrentSchemaTestDatabaseIdentity(
    string Provider,
    string Host,
    int Port,
    string Database,
    string SearchPath);

public sealed record CurrentSchemaTestServiceIdentity(
    string EnvelopeSha256,
    string ProducerId,
    string ContainerId,
    string ImageReference,
    string ImageId,
    string RepositoryDigest,
    int HostPort);

public sealed record CurrentSchemaTestMaterializationReceipt(
    string Schema,
    string Status,
    string CommandMode,
    string ProducerId,
    bool TestOnly,
    string RunId,
    string SourceCommit,
    CurrentSchemaTestServiceIdentity ServiceIdentity,
    CurrentSchemaTestDatabaseIdentity DatabaseIdentity,
    CurrentSchemaIdentity CanonicalIdentity,
    string ObservedDatabaseDigest,
    int TableCount,
    IReadOnlyList<string> Tables,
    bool EmptyBefore,
    bool CodeFirstApplied,
    string StartupVerifier,
    string AssemblySha256,
    string ReceiptDigest);

public static class CurrentSchemaTestMaterializer
{
    public const string OptInEnvironmentVariable = "FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION";
    public const string ReceiptRootEnvironmentVariable = "FSUSBLOG_CURRENT_SCHEMA_TEST_RECEIPT_ROOT";
    public const string ReceiptSchema = "fsusblog.current-schema-test-materialization-receipt.v1";
    public const string ProducerId = "current-schema-test-materializer";

    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static async Task<CurrentSchemaTestMaterializationReceipt> RunAsync(
        CurrentSchemaTestMaterializationOptions options,
        IReadOnlyDictionary<string, string?> environment,
        CancellationToken cancellationToken)
    {
        ValidateTestBoundary(environment);
        string resolvedOutputPath = ResolveOutputPath(options.OutputPath, environment);
        ValidateAssemblySourceCommit(options.SourceCommit);
        string connectionString = environment.TryGetValue("ConnectionStrings__DefaultConnection", out string? configured)
            ? configured ?? string.Empty
            : string.Empty;
        CurrentSchemaTestDatabaseIdentity databaseIdentity = ValidateDatabaseIdentity(connectionString);
        CurrentSchemaTestServiceIdentity serviceIdentity = ValidateServiceEnvelope(
            options.ServiceEnvelopePath,
            options.RunId,
            databaseIdentity);

        using var db = new SqlSugarClient(new ConnectionConfig
        {
            ConnectionString = connectionString,
            DbType = DbType.PostgreSQL,
            IsAutoCloseConnection = true,
            InitKeyType = InitKeyType.Attribute,
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        });
        var inspector = new SchemaModelInspector();
        IReadOnlyList<Type> entityTypes = inspector.GetManagedEntityTypes();
        CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(entityTypes);
        _ = CurrentSchemaCanonicalAuthority.Generate(canonical);

        File.Delete(resolvedOutputPath);
        bool receiptPublished = false;
        await db.Ado.BeginTranAsync().ConfigureAwait(false);
        try
        {
            await EnsurePublicSchemaIsExactlyEmptyAsync(db, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            db.CodeFirst.InitTables(entityTypes.ToArray());

            var verifier = new CurrentSchemaStartupVerifier(db, inspector);
            await verifier.RunAsync(cancellationToken).ConfigureAwait(false);
            SchemaModelSnapshot actual = await inspector.ReadActualModelAsync(db, cancellationToken).ConfigureAwait(false);
            string observedDatabaseDigest = CurrentSchemaCanonicalAuthority.ComputeContentDigest(actual.Tables);
            string[] tables = actual.Tables.Keys.Order(StringComparer.Ordinal).ToArray();
            string assemblyPath = typeof(CurrentSchemaTestMaterializer).Assembly.Location;
            string assemblyDigest = Convert.ToHexString(
                SHA256.HashData(await File.ReadAllBytesAsync(assemblyPath, cancellationToken).ConfigureAwait(false)))
                .ToLowerInvariant();

            var unsigned = new CurrentSchemaTestMaterializationReceipt(
                ReceiptSchema,
                "verified",
                CurrentSchemaTestMaterializationCommandLine.CommandName,
                ProducerId,
                TestOnly: true,
                options.RunId,
                options.SourceCommit,
                serviceIdentity,
                databaseIdentity,
                canonical.Identity,
                observedDatabaseDigest,
                tables.Length,
                tables,
                EmptyBefore: true,
                CodeFirstApplied: true,
                StartupVerifier: "green",
                assemblyDigest,
                ReceiptDigest: string.Empty);
            string receiptDigest = Sha256(JsonSerializer.Serialize(unsigned, s_json));
            CurrentSchemaTestMaterializationReceipt receipt = unsigned with
            {
                ReceiptDigest = receiptDigest
            };
            AtomicWrite(resolvedOutputPath, JsonSerializer.Serialize(receipt, s_json) + "\n");
            receiptPublished = true;
            await db.Ado.CommitTranAsync().ConfigureAwait(false);
            return receipt;
        }
        catch
        {
            try
            {
                await db.Ado.RollbackTranAsync().ConfigureAwait(false);
            }
            catch
            {
                // Preserve the materialization failure; a failed transaction remains unusable.
            }
            if (receiptPublished || File.Exists(resolvedOutputPath))
            {
                TryDeleteReceipt(resolvedOutputPath);
            }
            throw;
        }
    }

    public static void ValidateTestBoundary(IReadOnlyDictionary<string, string?> environment)
    {
        string environmentName = environment.TryGetValue("ASPNETCORE_ENVIRONMENT", out string? configured)
            ? configured ?? string.Empty
            : string.Empty;
        if (!string.Equals(environmentName, "Test", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_test_environment_required");
        }
        string optIn = environment.TryGetValue(OptInEnvironmentVariable, out string? value)
            ? value ?? string.Empty
            : string.Empty;
        if (!string.Equals(optIn, "1", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_opt_in_required");
        }
    }

    public static CurrentSchemaTestDatabaseIdentity ValidateDatabaseIdentity(string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("current_schema_materializer_connection_required");
        }

        var builder = new NpgsqlConnectionStringBuilder(connectionString);
        string host = builder.Host?.Trim() ?? string.Empty;
        bool loopback = string.Equals(host, "127.0.0.1", StringComparison.Ordinal)
            || string.Equals(host, "::1", StringComparison.Ordinal)
            || Path.IsPathRooted(host);
        if (!loopback)
        {
            throw new InvalidOperationException("current_schema_materializer_loopback_required");
        }
        if (!string.Equals(builder.SearchPath?.Trim(), "public", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_public_search_path_required");
        }
        string database = builder.Database?.Trim() ?? string.Empty;
        if (database.Length == 0)
        {
            throw new InvalidOperationException("current_schema_materializer_database_required");
        }

        return new CurrentSchemaTestDatabaseIdentity(
            "postgresql",
            host,
            builder.Port,
            database,
            "public");
    }

    public static string ResolveOutputPath(
        string outputPath,
        IReadOnlyDictionary<string, string?> environment)
    {
        string configuredRoot = environment.TryGetValue(ReceiptRootEnvironmentVariable, out string? value)
            ? value ?? string.Empty
            : string.Empty;
        if (string.IsNullOrWhiteSpace(configuredRoot) || !Path.IsPathFullyQualified(configuredRoot))
        {
            throw new InvalidOperationException("current_schema_materializer_receipt_root_required");
        }
        if (!CanonicalPathBoundary.TryResolveCandidate(
                configuredRoot,
                outputPath,
                out string resolvedOutput))
        {
            throw new InvalidOperationException("current_schema_materializer_output_outside_run_root");
        }
        return resolvedOutput;
    }

    public static void ValidateAssemblySourceCommit(string sourceCommit)
    {
        Assembly assembly = typeof(CurrentSchemaTestMaterializer).Assembly;
        string? assemblyCommit = assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(static attribute =>
                string.Equals(attribute.Key, "FsusBlog.SourceCommit", StringComparison.Ordinal))
            ?.Value;
        if (!string.Equals(assemblyCommit, sourceCommit, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_assembly_source_mismatch");
        }
    }

    public static CurrentSchemaTestServiceIdentity ValidateServiceEnvelope(
        string serviceEnvelopePath,
        string runId,
        CurrentSchemaTestDatabaseIdentity databaseIdentity)
    {
        if (!Path.IsPathFullyQualified(serviceEnvelopePath) || !File.Exists(serviceEnvelopePath))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_required");
        }

        byte[] content = File.ReadAllBytes(serviceEnvelopePath);
        using JsonDocument document = JsonDocument.Parse(content);
        JsonElement root = document.RootElement;
        if (!HasString(root, "schema", "fsusblog.test-execution-envelope-services.v1")
            || !HasBoolean(root, "qualificationEligible", expected: true)
            || !HasString(root, "admission", "planned-actual-exact")
            || !HasString(root, "correctnessImagePull", "denied")
            || !HasString(root, "hostFallback", "denied")
            || !HasString(root, "runId", runId))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_invalid");
        }
        string producerId = RequiredString(root, "producerId");
        JsonElement requiredServices = RequiredProperty(root, "requiredServices", JsonValueKind.Array);
        if (requiredServices.EnumerateArray().Count(static value =>
                value.ValueKind == JsonValueKind.String
                && string.Equals(value.GetString(), "postgres", StringComparison.Ordinal)) != 1)
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_postgres_required");
        }

        JsonElement planned = RequiredProperty(root, "planned", JsonValueKind.Object);
        JsonElement actual = RequiredProperty(root, "actual", JsonValueKind.Object);
        if (!JsonElement.DeepEquals(planned, actual))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_drift");
        }
        JsonElement postgres = RequiredService(actual, "postgres");
        string containerId = RequiredString(postgres, "containerId");
        string imageReference = RequiredString(postgres, "imageReference");
        string imageId = RequiredString(postgres, "imageId");
        string repositoryDigest = RequiredString(postgres, "repositoryDigest");
        JsonElement ports = RequiredProperty(postgres, "ports", JsonValueKind.Array);
        JsonElement[] postgresPorts = ports.EnumerateArray().Where(static port =>
            HasString(port, "containerPort", "5432/tcp")).ToArray();
        if (postgresPorts.Length != 1
            || !HasString(postgresPorts[0], "hostIp", "127.0.0.1")
            || !int.TryParse(RequiredString(postgresPorts[0], "hostPort"), out int hostPort)
            || hostPort != databaseIdentity.Port
            || !string.Equals(databaseIdentity.Host, "127.0.0.1", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_port_mismatch");
        }

        return new CurrentSchemaTestServiceIdentity(
            Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
            producerId,
            containerId,
            imageReference,
            imageId,
            repositoryDigest,
            hostPort);
    }

    private static JsonElement RequiredService(JsonElement envelope, string serviceId)
    {
        JsonElement services = RequiredProperty(envelope, "services", JsonValueKind.Array);
        JsonElement[] matches = services.EnumerateArray().Where(service =>
            service.ValueKind == JsonValueKind.Object
            && HasString(service, "id", serviceId)).ToArray();
        return matches.Length == 1
            ? matches[0]
            : throw new InvalidOperationException("current_schema_materializer_service_envelope_postgres_invalid");
    }

    private static JsonElement RequiredProperty(JsonElement parent, string name, JsonValueKind kind)
        => parent.TryGetProperty(name, out JsonElement value) && value.ValueKind == kind
            ? value
            : throw new InvalidOperationException("current_schema_materializer_service_envelope_invalid");

    private static string RequiredString(JsonElement parent, string name)
        => parent.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(value.GetString())
                ? value.GetString()!
                : throw new InvalidOperationException("current_schema_materializer_service_envelope_invalid");

    private static bool HasString(JsonElement parent, string name, string expected)
        => parent.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
            && string.Equals(value.GetString(), expected, StringComparison.Ordinal);

    private static bool HasBoolean(JsonElement parent, string name, bool expected)
        => parent.TryGetProperty(name, out JsonElement value)
            && (expected ? value.ValueKind == JsonValueKind.True : value.ValueKind == JsonValueKind.False);

    private static async Task EnsurePublicSchemaIsExactlyEmptyAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable objects = await db.Ado.GetDataTableAsync("""
            SELECT c.relname, c.relkind
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            ORDER BY c.relname;
            """).ConfigureAwait(false);
        if (objects.Rows.Count > 0)
        {
            string first = Convert.ToString(objects.Rows[0]["relname"]) ?? "unknown";
            throw new InvalidOperationException(
                $"current_schema_materializer_public_schema_not_empty:first={first};count={objects.Rows.Count}");
        }
    }

    private static void AtomicWrite(string outputPath, string content)
    {
        string fullPath = Path.GetFullPath(outputPath);
        string directory = Path.GetDirectoryName(fullPath)
            ?? throw new InvalidOperationException("current_schema_materializer_output_invalid");
        Directory.CreateDirectory(directory);
        string temporaryPath = Path.Combine(directory, $".{Path.GetFileName(fullPath)}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(temporaryPath, content, new UTF8Encoding(false));
            File.Move(temporaryPath, fullPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static void TryDeleteReceipt(string outputPath)
    {
        try
        {
            File.Delete(outputPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Receipt cleanup is best effort; transaction rollback remains authoritative.
        }
    }

    private static string Sha256(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

public static class CurrentSchemaTestMaterializationCommandHost
{
    public static async Task<int> RunAsync(string[] arguments, CancellationToken cancellationToken)
    {
        CurrentSchemaTestMaterializationOptions options = CurrentSchemaTestMaterializationCommandLine.Parse(arguments);
        IReadOnlyDictionary<string, string?> environment = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(
                static entry => Convert.ToString(entry.Key) ?? string.Empty,
                static entry => Convert.ToString(entry.Value),
                StringComparer.Ordinal);
        CurrentSchemaTestMaterializationReceipt receipt = await CurrentSchemaTestMaterializer
            .RunAsync(options, environment, cancellationToken)
            .ConfigureAwait(false);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            status = receipt.Status,
            schema = receipt.Schema,
            producerId = receipt.ProducerId,
            receiptDigest = receipt.ReceiptDigest
        }));
        return 0;
    }
}
