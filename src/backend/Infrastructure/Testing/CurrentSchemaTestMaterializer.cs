using System.Buffers;
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

        string? runId = null;
        string? sourceCommit = null;
        string? serviceEnvelope = null;
        string? serviceCatalog = null;
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
                case "--service-catalog":
                    EnsureSingleOccurrence(value, seenOptions);
                    serviceCatalog = ReadValue();
                    break;
                default:
                    throw new InvalidOperationException($"current_schema_materializer_argument_unknown:{value}");
            }
        }

        return new CurrentSchemaTestMaterializationOptions(
            RequireValue(runId, "run-id"),
            RequireSourceCommit(sourceCommit),
            RequireValue(serviceEnvelope, "service-envelope"),
            RequireValue(serviceCatalog, "service-catalog"));
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
    string RunId,
    string SourceCommit,
    string ServiceEnvelopePath,
    string ServiceCatalogPath);

public sealed record CurrentSchemaTestDatabaseIdentity(
    string Provider,
    string Host,
    int Port,
    string Database,
    string Username,
    string SearchPath);

public sealed record CurrentSchemaTestResourceLimits(
    long NanoCpus,
    long Memory,
    long MemoryReservation,
    long PidsLimit);

public sealed record CurrentSchemaTestPostgresInstanceIdentity(
    string SystemIdentifier,
    string Database,
    string Username,
    string ServerVersion,
    string ServerVersionNumber);

public sealed record CurrentSchemaTestServiceIdentity(
    string CatalogDigest,
    string EnvelopeSha256,
    string ProducerId,
    string ContainerId,
    string CreatedAt,
    string ImageReference,
    string ImageId,
    string RepositoryDigest,
    string ServiceVersion,
    string NetworkMode,
    string NetworkNamespace,
    int HostPort,
    CurrentSchemaTestResourceLimits ResourceLimits,
    CurrentSchemaTestPostgresInstanceIdentity PostgresInstance);

public sealed record CurrentSchemaTestMaterializationReceipt(
    string Schema,
    string Status,
    string CommandMode,
    string ProducerId,
    bool TestOnly,
    bool QualificationEligible,
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
    public const string PublicationFaultEnvironmentVariable = "FSUSBLOG_CURRENT_SCHEMA_TEST_PUBLICATION_FAULT";
    public const string ReceiptSchema = "fsusblog.current-schema-test-materialization-receipt.v1";
    public const string ProducerId = "current-schema-test-materializer";
    public const string PublicSchemaObjectInventorySql = """
        SELECT c.relname AS object_name, 'relation:' || c.relkind::text AS object_kind
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        UNION ALL
        SELECT p.proname AS object_name, 'routine:' || p.prokind::text AS object_kind
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT t.typname AS object_name, 'type:' || t.typtype::text AS object_kind
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typrelid = 0
          AND t.typelem = 0
        UNION ALL
        SELECT o.oprname AS object_name, 'operator' AS object_kind
        FROM pg_catalog.pg_operator o
        JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT c.opcname AS object_name, 'operator-class' AS object_kind
        FROM pg_catalog.pg_opclass c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT f.opfname AS object_name, 'operator-family' AS object_kind
        FROM pg_catalog.pg_opfamily f
        JOIN pg_catalog.pg_namespace n ON n.oid = f.opfnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT c.conname AS object_name, 'conversion' AS object_kind
        FROM pg_catalog.pg_conversion c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT c.collname AS object_name, 'collation' AS object_kind
        FROM pg_catalog.pg_collation c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT s.stxname AS object_name, 'statistics' AS object_kind
        FROM pg_catalog.pg_statistic_ext s
        JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT c.cfgname AS object_name, 'text-search-configuration' AS object_kind
        FROM pg_catalog.pg_ts_config c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT d.dictname AS object_name, 'text-search-dictionary' AS object_kind
        FROM pg_catalog.pg_ts_dict d
        JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT p.prsname AS object_name, 'text-search-parser' AS object_kind
        FROM pg_catalog.pg_ts_parser p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.prsnamespace
        WHERE n.nspname = 'public'
        UNION ALL
        SELECT t.tmplname AS object_name, 'text-search-template' AS object_kind
        FROM pg_catalog.pg_ts_template t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.tmplnamespace
        WHERE n.nspname = 'public'
        ORDER BY object_kind, object_name;
        """;

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
        string resolvedOutputPath = ResolveOutputPath(options.RunId, environment);
        string preparedOutputPath = resolvedOutputPath + ".prepared";
        ValidateAssemblySourceCommit(options.SourceCommit);
        string connectionString = environment.TryGetValue("ConnectionStrings__DefaultConnection", out string? configured)
            ? configured ?? string.Empty
            : string.Empty;
        CurrentSchemaTestDatabaseIdentity databaseIdentity = ValidateDatabaseIdentity(connectionString);
        CurrentSchemaTestServiceIdentity serviceIdentity = ValidateServiceEnvelope(
            options.ServiceEnvelopePath,
            options.ServiceCatalogPath,
            options.RunId,
            databaseIdentity);
        RejectArtifactAlias(resolvedOutputPath, options.ServiceEnvelopePath, options.ServiceCatalogPath);
        if (File.Exists(resolvedOutputPath))
        {
            throw new InvalidOperationException("current_schema_materializer_terminal_receipt_exists");
        }
        if (File.Exists(preparedOutputPath))
        {
            throw new InvalidOperationException("current_schema_materializer_prepared_receipt_exists");
        }

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

        bool preparedPublished = false;
        bool verifiedPublished = false;
        bool committed = false;
        await db.Ado.BeginTranAsync().ConfigureAwait(false);
        try
        {
            await ValidateLivePostgresInstanceAsync(db, serviceIdentity.PostgresInstance, cancellationToken)
                .ConfigureAwait(false);
            await EnsurePublicSchemaIsExactlyEmptyAsync(db, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            db.CodeFirst.InitTables(entityTypes.ToArray());

            var verifier = new CurrentSchemaStartupVerifier(db, inspector);
            await verifier.RunAsync(cancellationToken).ConfigureAwait(false);
            SchemaModelSnapshot actual = await inspector.ReadActualModelAsync(db, cancellationToken).ConfigureAwait(false);
            string observedDatabaseDigest = CurrentSchemaCanonicalAuthority.ComputeObservationDigest(actual.Tables);
            string[] tables = actual.Tables.Keys.Order(StringComparer.Ordinal).ToArray();
            string assemblyPath = typeof(CurrentSchemaTestMaterializer).Assembly.Location;
            string assemblyDigest = Convert.ToHexString(
                SHA256.HashData(await File.ReadAllBytesAsync(assemblyPath, cancellationToken).ConfigureAwait(false)))
                .ToLowerInvariant();

            var unsignedVerified = new CurrentSchemaTestMaterializationReceipt(
                ReceiptSchema,
                "verified",
                CurrentSchemaTestMaterializationCommandLine.CommandName,
                ProducerId,
                TestOnly: true,
                QualificationEligible: true,
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
            string receiptDigest = Sha256(JsonSerializer.Serialize(unsignedVerified, s_json));
            CurrentSchemaTestMaterializationReceipt verifiedReceipt = unsignedVerified with
            {
                ReceiptDigest = receiptDigest
            };

            CurrentSchemaTestMaterializationReceipt preparedReceipt = unsignedVerified with
            {
                Status = "prepared",
                QualificationEligible = false,
                ReceiptDigest = string.Empty
            };
            string preparedDigest = Sha256(JsonSerializer.Serialize(preparedReceipt, s_json));
            preparedReceipt = preparedReceipt with
            {
                ReceiptDigest = preparedDigest
            };
            AtomicWrite(preparedOutputPath, JsonSerializer.Serialize(preparedReceipt, s_json) + "\n");
            preparedPublished = true;
            if (environment.TryGetValue(PublicationFaultEnvironmentVariable, out string? preparedFault)
                && string.Equals(preparedFault, "after-prepared-hold", StringComparison.Ordinal))
            {
                Console.Error.WriteLine("current_schema_materializer_fault_ready:after-prepared-hold");
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
            }
            await db.Ado.CommitTranAsync().ConfigureAwait(false);
            committed = true;
            if (environment.TryGetValue(PublicationFaultEnvironmentVariable, out string? publicationFault)
                && string.Equals(publicationFault, "after-commit", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("current_schema_materializer_publication_fault_after_commit");
            }
            AtomicWrite(resolvedOutputPath, JsonSerializer.Serialize(verifiedReceipt, s_json) + "\n");
            verifiedPublished = true;
            File.Delete(preparedOutputPath);
            preparedPublished = false;
            return verifiedReceipt;
        }
        catch
        {
            if (!committed)
            {
                try
                {
                    await db.Ado.RollbackTranAsync().ConfigureAwait(false);
                }
                catch
                {
                    // Preserve the materialization failure; a failed transaction remains unusable.
                }
            }
            else
            {
                await CompensateCommittedMaterializationAsync(db).ConfigureAwait(false);
            }
            if (verifiedPublished)
            {
                TryDeleteReceipt(resolvedOutputPath);
            }
            if (preparedPublished)
            {
                TryDeleteReceipt(preparedOutputPath);
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
        if (!string.Equals(database, "fsusblog", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_database_mismatch");
        }
        string username = builder.Username?.Trim() ?? string.Empty;
        if (!string.Equals(username, "fsusblog", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_username_mismatch");
        }

        return new CurrentSchemaTestDatabaseIdentity(
            "postgresql",
            host,
            builder.Port,
            database,
            username,
            "public");
    }

    public static string ResolveOutputPath(
        string runId,
        IReadOnlyDictionary<string, string?> environment)
    {
        string configuredRoot = environment.TryGetValue(ReceiptRootEnvironmentVariable, out string? value)
            ? value ?? string.Empty
            : string.Empty;
        if (string.IsNullOrWhiteSpace(configuredRoot) || !Path.IsPathFullyQualified(configuredRoot))
        {
            throw new InvalidOperationException("current_schema_materializer_receipt_root_required");
        }
        string lexicalRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(configuredRoot));
        string pathRoot = Path.GetPathRoot(lexicalRoot)
            ?? throw new InvalidOperationException("current_schema_materializer_receipt_root_required");
        if (!CanonicalPathBoundary.TryResolveCandidate(pathRoot, lexicalRoot, out string physicalRoot)
            || !string.Equals(
                Path.TrimEndingDirectorySeparator(physicalRoot),
                lexicalRoot,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_receipt_root_not_canonical");
        }
        string runDigest = Sha256(runId);
        string expectedOutputPath = Path.Combine(
            lexicalRoot,
            $"current-schema-test-materialization-{runDigest}.json");
        if (!CanonicalPathBoundary.TryResolveCandidate(
                lexicalRoot,
                expectedOutputPath,
                out string resolvedOutput))
        {
            throw new InvalidOperationException("current_schema_materializer_output_outside_run_root");
        }
        return resolvedOutput;
    }

    public static void RejectArtifactAlias(
        string outputPath,
        string serviceEnvelopePath,
        string serviceCatalogPath)
    {
        string output = Path.GetFullPath(outputPath);
        foreach (string input in new[] { serviceEnvelopePath, serviceCatalogPath })
        {
            if (string.Equals(output, Path.GetFullPath(input), StringComparison.Ordinal))
            {
                throw new InvalidOperationException("current_schema_materializer_output_alias");
            }
        }
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
        string serviceCatalogPath,
        string runId,
        CurrentSchemaTestDatabaseIdentity databaseIdentity)
    {
        if (!Path.IsPathFullyQualified(serviceEnvelopePath) || !File.Exists(serviceEnvelopePath)
            || !Path.IsPathFullyQualified(serviceCatalogPath) || !File.Exists(serviceCatalogPath))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_required");
        }

        using JsonDocument catalogDocument = JsonDocument.Parse(File.ReadAllBytes(serviceCatalogPath));
        JsonElement catalog = catalogDocument.RootElement;
        RequireExactProperties(catalog, "schema", "version", "correctnessPhase", "containerRuntime", "services");
        if (!HasString(catalog, "schema", "fsusblog.test-execution-service-catalog.v2")
            || !HasInt32(catalog, "version", 2))
        {
            throw new InvalidOperationException("current_schema_materializer_service_catalog_invalid");
        }
        string catalogDigest = ComputeCanonicalJsonDigest(catalog);
        JsonElement correctness = RequiredProperty(catalog, "correctnessPhase", JsonValueKind.Object);
        JsonElement catalogServices = RequiredProperty(catalog, "services", JsonValueKind.Object);

        byte[] content = File.ReadAllBytes(serviceEnvelopePath);
        using JsonDocument document = JsonDocument.Parse(content);
        JsonElement root = document.RootElement;
        if (!HasString(root, "schema", "fsusblog.test-execution-envelope-services.v2")
            || !HasBoolean(root, "qualificationEligible", expected: true)
            || !HasString(root, "catalogDigest", catalogDigest)
            || !HasString(root, "admission", RequiredString(correctness, "admission"))
            || !HasString(root, "correctnessImagePull", RequiredString(correctness, "imagePull"))
            || !HasString(root, "hostFallback", RequiredString(correctness, "hostFallback"))
            || !HasString(root, "runId", runId))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_invalid");
        }
        string producerId = RequiredString(root, "producerId");
        JsonElement requiredServices = RequiredProperty(root, "requiredServices", JsonValueKind.Array);
        string[] requiredServiceIds = requiredServices.EnumerateArray()
            .Select(static value => value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty)
            .ToArray();
        if (requiredServiceIds.Length == 0
            || requiredServiceIds.Distinct(StringComparer.Ordinal).Count() != requiredServiceIds.Length
            || requiredServiceIds.Count(static id => string.Equals(id, "postgres", StringComparison.Ordinal)) != 1
            || requiredServiceIds.Any(id => !catalogServices.TryGetProperty(id, out _)))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_postgres_required");
        }

        JsonElement planned = RequiredProperty(root, "planned", JsonValueKind.Object);
        JsonElement actual = RequiredProperty(root, "actual", JsonValueKind.Object);
        if (!JsonElement.DeepEquals(planned, actual))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_drift");
        }
        ValidateRuntimeIdentity(actual, catalog);
        JsonElement actualServices = RequiredProperty(actual, "services", JsonValueKind.Array);
        string[] actualServiceIds = actualServices.EnumerateArray()
            .Select(static service => RequiredString(service, "id"))
            .ToArray();
        if (!actualServiceIds.Order(StringComparer.Ordinal).SequenceEqual(
                requiredServiceIds.Order(StringComparer.Ordinal),
                StringComparer.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_topology_mismatch");
        }

        CurrentSchemaTestServiceIdentity? postgresIdentity = null;
        foreach (string serviceId in requiredServiceIds)
        {
            JsonElement service = RequiredService(actual, serviceId);
            JsonElement catalogService = RequiredProperty(catalogServices, serviceId, JsonValueKind.Object);
            CurrentSchemaTestServiceIdentity identity = ValidateContainerService(
                service,
                catalogService,
                catalogDigest,
                Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
                producerId,
                serviceId == "postgres" ? databaseIdentity : null);
            if (serviceId == "postgres")
            {
                postgresIdentity = identity;
            }
        }

        return postgresIdentity
            ?? throw new InvalidOperationException("current_schema_materializer_service_envelope_postgres_required");
    }

    public static string ComputeCanonicalJsonDigest(JsonElement value)
    {
        var canonical = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(canonical))
        {
            WriteCanonicalJson(writer, value);
        }
        return $"sha256:{Convert.ToHexString(SHA256.HashData(canonical.WrittenSpan)).ToLowerInvariant()}";
    }

    private static CurrentSchemaTestServiceIdentity ValidateContainerService(
        JsonElement service,
        JsonElement catalogService,
        string catalogDigest,
        string envelopeSha256,
        string producerId,
        CurrentSchemaTestDatabaseIdentity? databaseIdentity)
    {
        if (!HasString(service, "kind", "container") || !HasString(catalogService, "kind", "container"))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_kind_mismatch");
        }
        string containerId = RequiredString(service, "containerId");
        string createdAt = RequiredString(service, "createdAt");
        string imageReference = RequiredString(service, "imageReference");
        string imageId = RequiredString(service, "imageId");
        string repositoryDigest = RequiredString(service, "repositoryDigest");
        string serviceVersion = RequiredString(service, "serviceVersion");
        string networkMode = RequiredString(service, "networkMode");
        string networkNamespace = RequiredString(service, "networkNamespace");
        string expectedImageReference = RequiredString(catalogService, "imageReference");
        string expectedVersion = RequiredString(catalogService, "version");
        string[] requiredIdentityFields = RequiredProperty(
                catalogService,
                "requiredIdentityFields",
                JsonValueKind.Array)
            .EnumerateArray()
            .Select(static field => field.ValueKind == JsonValueKind.String ? field.GetString() ?? string.Empty : string.Empty)
            .ToArray();
        string[] expectedIdentityFields = databaseIdentity is null
            ? ["containerId", "imageReference", "imageId", "repositoryDigest", "serviceVersion", "networkMode", "ports", "resourceLimits"]
            : ["containerId", "imageReference", "imageId", "repositoryDigest", "serviceVersion", "networkMode", "ports", "resourceLimits", "databaseIdentity"];
        if (!requiredIdentityFields.SequenceEqual(expectedIdentityFields, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_service_catalog_identity_fields_invalid");
        }
        string[] expectedServiceProperties = databaseIdentity is null
            ? [
                "id", "kind", "containerId", "createdAt", "imageReference", "imageId",
                "repositoryDigest", "serviceVersion", "networkMode", "networkNamespace",
                "ports", "resourceLimits"
            ]
            : [
                "id", "kind", "containerId", "createdAt", "imageReference", "imageId",
                "repositoryDigest", "serviceVersion", "networkMode", "networkNamespace",
                "ports", "resourceLimits", "databaseIdentity"
            ];
        RequireExactProperties(service, expectedServiceProperties);
        if (!IsLowerHex(containerId, 64)
            || !DateTimeOffset.TryParse(createdAt, out _)
            || !imageReference.Equals(expectedImageReference, StringComparison.Ordinal)
            || !imageId.StartsWith("sha256:", StringComparison.Ordinal)
            || !IsLowerHex(imageId["sha256:".Length..], 64)
            || !repositoryDigest.Equals(expectedImageReference, StringComparison.Ordinal)
            || !serviceVersion.Contains(expectedVersion, StringComparison.Ordinal)
            || !HasBoolean(catalogService, "hostNativeAllowed", expected: false))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_identity_mismatch");
        }

        JsonElement resourceLimits = RequiredProperty(service, "resourceLimits", JsonValueKind.Object);
        RequireExactProperties(resourceLimits, "nanoCpus", "memory", "memoryReservation", "pidsLimit");
        var limits = new CurrentSchemaTestResourceLimits(
            RequiredNonnegativeInt64(resourceLimits, "nanoCpus"),
            RequiredNonnegativeInt64(resourceLimits, "memory"),
            RequiredNonnegativeInt64(resourceLimits, "memoryReservation"),
            RequiredNonnegativeInt64(resourceLimits, "pidsLimit"));

        JsonElement ports = RequiredProperty(service, "ports", JsonValueKind.Array);
        JsonElement[] portEntries = ports.EnumerateArray().ToArray();
        if (portEntries.Length == 0)
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_topology_mismatch");
        }
        foreach (JsonElement port in portEntries)
        {
            RequireExactProperties(port, "containerPort", "hostIp", "hostPort");
            _ = RequiredString(port, "containerPort");
            _ = RequiredString(port, "hostIp");
            _ = RequiredString(port, "hostPort");
        }

        int hostPort = 0;
        CurrentSchemaTestPostgresInstanceIdentity? postgresInstance = null;
        if (databaseIdentity is not null)
        {
            JsonElement[] postgresPorts = portEntries.Where(static port =>
                HasString(port, "containerPort", "5432/tcp")).ToArray();
            if (postgresPorts.Length != 1
                || !HasString(postgresPorts[0], "hostIp", "127.0.0.1")
                || !int.TryParse(RequiredString(postgresPorts[0], "hostPort"), out hostPort)
                || hostPort != databaseIdentity.Port
                || !string.Equals(databaseIdentity.Host, "127.0.0.1", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("current_schema_materializer_service_envelope_port_mismatch");
            }

            JsonElement instance = RequiredProperty(service, "databaseIdentity", JsonValueKind.Object);
            RequireExactProperties(
                instance,
                "systemIdentifier",
                "database",
                "username",
                "serverVersion",
                "serverVersionNumber");
            string systemIdentifier = RequiredString(instance, "systemIdentifier");
            string database = RequiredString(instance, "database");
            string username = RequiredString(instance, "username");
            string serverVersion = RequiredString(instance, "serverVersion");
            string serverVersionNumber = RequiredString(instance, "serverVersionNumber");
            if (!systemIdentifier.All(char.IsAsciiDigit)
                || string.Equals(systemIdentifier, "0", StringComparison.Ordinal)
                || !string.Equals(database, databaseIdentity.Database, StringComparison.Ordinal)
                || !string.Equals(username, databaseIdentity.Username, StringComparison.Ordinal)
                || !string.Equals(database, RequiredString(catalogService, "database"), StringComparison.Ordinal)
                || !string.Equals(username, RequiredString(catalogService, "username"), StringComparison.Ordinal)
                || !string.Equals(
                    serverVersionNumber,
                    RequiredString(catalogService, "serverVersionNumber"),
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException("current_schema_materializer_database_observation_invalid");
            }
            postgresInstance = new CurrentSchemaTestPostgresInstanceIdentity(
                systemIdentifier,
                database,
                username,
                serverVersion,
                serverVersionNumber);
        }

        return new CurrentSchemaTestServiceIdentity(
            catalogDigest,
            envelopeSha256,
            producerId,
            containerId,
            createdAt,
            imageReference,
            imageId,
            repositoryDigest,
            serviceVersion,
            networkMode,
            networkNamespace,
            hostPort,
            limits,
            postgresInstance
                ?? throw new InvalidOperationException("current_schema_materializer_database_observation_required"));
    }

    internal static async Task ValidateLivePostgresInstanceAsync(
        ISqlSugarClient db,
        CurrentSchemaTestPostgresInstanceIdentity expected,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable rows = await db.Ado.GetDataTableAsync("""
            SELECT
                control.system_identifier::text AS system_identifier,
                current_database()::text AS database_name,
                current_user::text AS database_user,
                current_setting('server_version')::text AS server_version,
                current_setting('server_version_num')::text AS server_version_number
            FROM pg_catalog.pg_control_system() AS control;
            """).ConfigureAwait(false);
        if (rows.Rows.Count != 1)
        {
            throw new InvalidOperationException("current_schema_materializer_database_observation_mismatch");
        }

        DataRow row = rows.Rows[0];
        bool matches = string.Equals(Convert.ToString(row["system_identifier"]), expected.SystemIdentifier, StringComparison.Ordinal)
            && string.Equals(Convert.ToString(row["database_name"]), expected.Database, StringComparison.Ordinal)
            && string.Equals(Convert.ToString(row["database_user"]), expected.Username, StringComparison.Ordinal)
            && string.Equals(Convert.ToString(row["server_version"]), expected.ServerVersion, StringComparison.Ordinal)
            && string.Equals(Convert.ToString(row["server_version_number"]), expected.ServerVersionNumber, StringComparison.Ordinal);
        if (!matches)
        {
            throw new InvalidOperationException("current_schema_materializer_database_observation_mismatch");
        }
    }

    private static async Task CompensateCommittedMaterializationAsync(ISqlSugarClient db)
    {
        try
        {
            await db.Ado.ExecuteCommandAsync("""
                DROP SCHEMA public CASCADE;
                CREATE SCHEMA public;
                """).ConfigureAwait(false);
        }
        catch
        {
            // Terminal evidence remains absent even when environmental failure prevents compensation.
        }
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

    private static void ValidateRuntimeIdentity(JsonElement envelope, JsonElement catalog)
    {
        JsonElement runtime = RequiredProperty(envelope, "runtime", JsonValueKind.Object);
        JsonElement runtimeCatalog = RequiredProperty(catalog, "containerRuntime", JsonValueKind.Object);
        JsonElement identityFields = RequiredProperty(runtimeCatalog, "identityFields", JsonValueKind.Array);
        string[] expectedFields = identityFields.EnumerateArray()
            .Select(static field => field.ValueKind == JsonValueKind.String ? field.GetString() ?? string.Empty : string.Empty)
            .ToArray();
        RequireExactProperties(runtime, expectedFields);
        foreach (string field in expectedFields)
        {
            _ = RequiredString(runtime, field);
        }
    }

    private static long RequiredNonnegativeInt64(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out JsonElement value)
            || value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt64(out long parsed)
            || parsed < 0)
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_resource_invalid");
        }
        return parsed;
    }

    private static void RequireExactProperties(JsonElement value, params string[] names)
    {
        string[] actual = value.EnumerateObject().Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(names.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new InvalidOperationException("current_schema_materializer_service_envelope_shape_invalid");
        }
    }

    private static bool IsLowerHex(string value, int length)
        => value.Length == length
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void WriteCanonicalJson(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in value.EnumerateObject().OrderBy(static property => property.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonicalJson(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in value.EnumerateArray())
                {
                    WriteCanonicalJson(writer, item);
                }
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(value.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(value.GetRawText(), skipInputValidation: true);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new InvalidOperationException("current_schema_materializer_service_catalog_invalid");
        }
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

    private static bool HasInt32(JsonElement parent, string name, int expected)
        => parent.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out int actual)
            && actual == expected;

    private static async Task EnsurePublicSchemaIsExactlyEmptyAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable objects = await db.Ado.GetDataTableAsync(PublicSchemaObjectInventorySql)
            .ConfigureAwait(false);
        if (objects.Rows.Count > 0)
        {
            string first = Convert.ToString(objects.Rows[0]["object_name"]) ?? "unknown";
            string kind = Convert.ToString(objects.Rows[0]["object_kind"]) ?? "unknown";
            throw new InvalidOperationException(
                $"current_schema_materializer_public_schema_not_empty:first={kind}/{first};count={objects.Rows.Count}");
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
            File.Move(temporaryPath, fullPath, overwrite: false);
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
