using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Npgsql;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class AuthoringStateProcessWorker
{
    internal const string Command = "authoring-state-process-worker";
    internal sealed record Request(string ConnectionString, string Operation, AuthoringFencedStateMigration Plan);

    internal static readonly JsonSerializerOptions s_jsonOptions = new()
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) }
    };

    internal static async Task<int> RunAsync()
    {
        try
        {
            Request request = JsonSerializer.Deserialize<Request>(await Console.In.ReadToEndAsync(), s_jsonOptions)
                ?? throw new InvalidDataException("state_worker_input_missing");
            var connection = new NpgsqlConnectionStringBuilder(request.ConnectionString);
            if (connection.Host != "127.0.0.1" || connection.Database?.StartsWith("fsus_", StringComparison.Ordinal) != true)
            {
                throw new InvalidDataException("state_worker_requires_isolated_fixture_database");
            }
            using var db = PostgresSqlSugarTestClient.Create(request.ConnectionString);
            var store = new PostgresAuthoringExtensionStateStore(db);
            VerifiedAuthoringPackage oldPackage = Package("1.0.0", 1);
            VerifiedAuthoringPackage newPackage = Package("2.0.0", 2);
            if (request.Operation == "backup-and-wait")
            {
                await store.BackupAsync(oldPackage, newPackage, request.Plan, CancellationToken.None);
                Console.WriteLine("state-backup-durable");
                await Console.Out.FlushAsync();
                await Task.Delay(TimeSpan.FromSeconds(30));
                return 70;
            }
            if (request.Operation == "apply")
            {
                await store.ApplyAsync(oldPackage, newPackage, request.Plan, CancellationToken.None);
            }
            else if (request.Operation == "rollback")
            {
                await store.RollbackAsync(oldPackage, newPackage, request.Plan, CancellationToken.None);
            }
            else if (request.Operation == "complete")
            {
                await store.CompleteAsync(oldPackage, newPackage, request.Plan, CancellationToken.None);
            }
            else
            {
                throw new InvalidDataException("state_worker_operation_unknown");
            }
            return 0;
        }
        catch
        {
            // Do not print fixture connection strings or persisted state bytes.
            Console.Error.WriteLine("state-worker-rejected");
            return 65;
        }
    }

    internal static VerifiedAuthoringPackage Package(string version, int schema)
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Version = version,
            StateSchemaVersion = schema
        };
        return new(
            AuthoringExtensionContractValidator.Verify(manifest),
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(AuthoringPackageTrustStatus.Trusted, "acme", "key-1",
                DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1)),
            new string(schema == 1 ? 'a' : 'b', 64));
    }

    internal static AuthoringStateScope Scope(VerifiedAuthoringPackage package) =>
        new(package.Contract.Manifest.Id, package.Contract.Manifest.Version, "synthetic-site", "synthetic-user", "synthetic-document", package.Contract.Manifest.StateSchemaVersion);

    internal static AuthoringFencedStateMigration Plan(AuthoringStateSnapshot source, AuthoringStateScope destination, ImmutableArray<AuthoringStateTransform>? transforms = null)
    {
        var plan = new AuthoringFencedStateMigration(1, "synthetic-migration", source.Scope, destination, source.Revision, 0,
            source.ContentSha256, 100, 1024, TimeSpan.FromSeconds(10),
            transforms ?? [new(AuthoringStateTransformKind.RenameKey, "old", "new", [])],
            "synthetic-backup", "synthetic-rollback", string.Empty);
        return plan with
        {
            ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
        };
    }
}
