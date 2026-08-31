using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.SchemaMigration;

using SqlSugar;

using DbType = SqlSugar.DbType;

namespace FsusBlog.Server.Infrastructure.Testing;

public static class CurrentSchemaTestMaterializationCandidateCommandLine
{
    public const string CommandName = "verify-current-schema-test-materialization-candidate";

    public static bool IsRequested(IReadOnlyList<string> arguments)
        => arguments.Count > 0
            && string.Equals(arguments[0], CommandName, StringComparison.Ordinal);

    public static CurrentSchemaTestMaterializationOptions Parse(IReadOnlyList<string> arguments)
    {
        if (!IsRequested(arguments))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_command_missing");
        }
        return CurrentSchemaTestMaterializationCommandLine.Parse(
        [
            CurrentSchemaTestMaterializationCommandLine.CommandName,
            .. arguments.Skip(1)
        ]);
    }
}

public sealed record CurrentSchemaTestMaterializationCandidateVerification(
    string Schema,
    string Status,
    string CommandMode,
    bool TestOnly,
    bool ReadOnly,
    bool QualificationEligible,
    string RunId,
    string SourceCommit,
    string MaterializationReceiptDigest,
    string MaterializationReceiptFileSha256,
    string AssemblySha256,
    CurrentSchemaTestServiceIdentity ServiceIdentity,
    CurrentSchemaTestDatabaseIdentity DatabaseIdentity,
    CurrentSchemaIdentity CanonicalIdentity,
    string ObservedDatabaseDigest,
    int TableCount,
    string ContentDigest);

public static class CurrentSchemaTestMaterializationCandidateVerifier
{
    public const string VerificationSchema =
        "fsusblog.current-schema-test-materialization-candidate-verification.v1";

    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static async Task<CurrentSchemaTestMaterializationCandidateVerification> RunAsync(
        CurrentSchemaTestMaterializationOptions options,
        IReadOnlyDictionary<string, string?> environment,
        CancellationToken cancellationToken)
    {
        CurrentSchemaTestMaterializer.ValidateTestBoundary(environment);
        CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(options.SourceCommit);
        string receiptPath = CurrentSchemaTestMaterializer.ResolveOutputPath(options.RunId, environment);
        if (File.Exists(receiptPath + ".prepared"))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_prepared_receipt_exists");
        }
        if (!File.Exists(receiptPath))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_receipt_missing");
        }

        byte[] receiptBytes = await File.ReadAllBytesAsync(receiptPath, cancellationToken).ConfigureAwait(false);
        CurrentSchemaTestMaterializationReceipt receipt;
        try
        {
            receipt = JsonSerializer.Deserialize<CurrentSchemaTestMaterializationReceipt>(receiptBytes, s_json)
                ?? throw new JsonException("receipt is null");
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException(
                "current_schema_candidate_verifier_receipt_invalid",
                exception);
        }

        string connectionString = environment.TryGetValue(
            "ConnectionStrings__DefaultConnection",
            out string? configured)
                ? configured ?? string.Empty
                : string.Empty;
        CurrentSchemaTestDatabaseIdentity databaseIdentity =
            CurrentSchemaTestMaterializer.ValidateDatabaseIdentity(connectionString);
        CurrentSchemaTestServiceIdentity serviceIdentity =
            CurrentSchemaTestMaterializer.ValidateServiceEnvelope(
                options.ServiceEnvelopePath,
                options.ServiceCatalogPath,
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
                PgSqlIsAutoToLower = true
            }
        });
        await CurrentSchemaTestMaterializer.ValidateLivePostgresInstanceAsync(
            db,
            serviceIdentity.PostgresInstance,
            cancellationToken).ConfigureAwait(false);

        var inspector = new SchemaModelInspector();
        IReadOnlyList<Type> entityTypes = inspector.GetManagedEntityTypes();
        CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(entityTypes);
        _ = CurrentSchemaCanonicalAuthority.Generate(canonical);
        var startupVerifier = new CurrentSchemaStartupVerifier(db, inspector);
        await startupVerifier.RunAsync(cancellationToken).ConfigureAwait(false);
        SchemaModelSnapshot actual = await inspector.ReadActualModelAsync(db, cancellationToken)
            .ConfigureAwait(false);
        string observedDatabaseDigest =
            CurrentSchemaCanonicalAuthority.ComputeObservationDigest(actual.Tables);
        string[] tables = actual.Tables.Keys.Order(StringComparer.Ordinal).ToArray();
        string assemblyDigest = Convert.ToHexString(
            SHA256.HashData(await File.ReadAllBytesAsync(
                typeof(CurrentSchemaTestMaterializationCandidateVerifier).Assembly.Location,
                cancellationToken).ConfigureAwait(false)))
            .ToLowerInvariant();

        ValidateReceipt(
            receipt,
            options,
            serviceIdentity,
            databaseIdentity,
            canonical.Identity,
            observedDatabaseDigest,
            tables,
            assemblyDigest);

        var unsigned = new CurrentSchemaTestMaterializationCandidateVerification(
            VerificationSchema,
            "verified",
            CurrentSchemaTestMaterializationCandidateCommandLine.CommandName,
            TestOnly: true,
            ReadOnly: true,
            QualificationEligible: true,
            options.RunId,
            options.SourceCommit,
            receipt.ReceiptDigest,
            $"sha256:{Sha256(receiptBytes)}",
            assemblyDigest,
            serviceIdentity,
            databaseIdentity,
            canonical.Identity,
            observedDatabaseDigest,
            tables.Length,
            ContentDigest: string.Empty);
        return unsigned with
        {
            ContentDigest = $"sha256:{Sha256(JsonSerializer.SerializeToUtf8Bytes(unsigned, s_json))}"
        };
    }

    public static void ValidateReceipt(
        CurrentSchemaTestMaterializationReceipt receipt,
        CurrentSchemaTestMaterializationOptions options,
        CurrentSchemaTestServiceIdentity serviceIdentity,
        CurrentSchemaTestDatabaseIdentity databaseIdentity,
        CurrentSchemaIdentity canonicalIdentity,
        string observedDatabaseDigest,
        IReadOnlyList<string> tables,
        string assemblyDigest)
    {
        if (!string.Equals(receipt.Schema, CurrentSchemaTestMaterializer.ReceiptSchema, StringComparison.Ordinal)
            || !string.Equals(receipt.Status, "verified", StringComparison.Ordinal)
            || !string.Equals(
                receipt.CommandMode,
                CurrentSchemaTestMaterializationCommandLine.CommandName,
                StringComparison.Ordinal)
            || !string.Equals(receipt.ProducerId, CurrentSchemaTestMaterializer.ProducerId, StringComparison.Ordinal)
            || !receipt.TestOnly
            || !receipt.QualificationEligible
            || !receipt.EmptyBefore
            || !receipt.CodeFirstApplied
            || !string.Equals(receipt.StartupVerifier, "green", StringComparison.Ordinal)
            || !string.Equals(receipt.RunId, options.RunId, StringComparison.Ordinal)
            || !string.Equals(receipt.SourceCommit, options.SourceCommit, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_receipt_identity_mismatch");
        }
        string computedReceiptDigest = ComputeMaterializationReceiptDigest(receipt);
        if (!string.Equals(receipt.ReceiptDigest, computedReceiptDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_receipt_digest_mismatch");
        }
        if (!JsonElement.DeepEquals(
                JsonSerializer.SerializeToElement(receipt.ServiceIdentity, s_json),
                JsonSerializer.SerializeToElement(serviceIdentity, s_json)))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_service_identity_mismatch");
        }
        if (receipt.DatabaseIdentity != databaseIdentity)
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_database_identity_mismatch");
        }
        if (receipt.CanonicalIdentity != canonicalIdentity)
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_canonical_identity_mismatch");
        }
        if (!string.Equals(receipt.ObservedDatabaseDigest, observedDatabaseDigest, StringComparison.Ordinal)
            || receipt.TableCount != tables.Count
            || !receipt.Tables.SequenceEqual(tables, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_live_database_mismatch");
        }
        if (!string.Equals(receipt.AssemblySha256, assemblyDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("current_schema_candidate_verifier_assembly_mismatch");
        }
    }

    public static string ComputeMaterializationReceiptDigest(
        CurrentSchemaTestMaterializationReceipt receipt)
    {
        CurrentSchemaTestMaterializationReceipt unsigned = receipt with
        {
            ReceiptDigest = string.Empty
        };
        return Sha256(JsonSerializer.SerializeToUtf8Bytes(unsigned, s_json));
    }

    private static string Sha256(ReadOnlySpan<byte> value)
        => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
}

public static class CurrentSchemaTestMaterializationCandidateCommandHost
{
    public static async Task<int> RunAsync(string[] arguments, CancellationToken cancellationToken)
    {
        CurrentSchemaTestMaterializationOptions options =
            CurrentSchemaTestMaterializationCandidateCommandLine.Parse(arguments);
        IReadOnlyDictionary<string, string?> environment = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(
                static entry => Convert.ToString(entry.Key) ?? string.Empty,
                static entry => Convert.ToString(entry.Value),
                StringComparer.Ordinal);
        CurrentSchemaTestMaterializationCandidateVerification verification =
            await CurrentSchemaTestMaterializationCandidateVerifier
                .RunAsync(options, environment, cancellationToken)
                .ConfigureAwait(false);
        Console.WriteLine(JsonSerializer.Serialize(verification, s_commandJson));
        return 0;
    }

    private static readonly JsonSerializerOptions s_commandJson = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
}
