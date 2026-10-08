using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationCoordinatorTests
{
    [Fact]
    public void ExecuteAsync_FailsClosedWithoutControlPlaneWrites()
    {
        // Preserve the historical test identity, but exercise the sole Server
        // entry point: there is no coordinator or writable store to construct.
        foreach (string phase in new[] { "expand", "backfill", "backfill-resume", "contract" })
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                ServerCommandLine.Parse(
                [
                    "migrate", "--phase", phase,
                    "--id", "20260720-post-comment-mutation-outbox",
                    "--release", "20260720000000-aaaaaaaaaaaa",
                    "--confirm-destructive"
                ]));
            Assert.Equal("server_command_unknown", error.Message);
        }

        foreach (string name in new[]
        {
            "OnlineSchemaMigrationCoordinator", "IOnlineSchemaMigrationCoordinator",
            "OnlineSchemaMigrationCommandHost", "ServeSchemaCompatibilityRunner",
            "OnlineSchemaCompatibilityRuntimeState", "PostgresOnlineSchemaMigrationStateStore",
            "IOnlineSchemaMigrationStateStore", "OnlineSchemaMigrationServiceCollectionExtensions"
        })
        {
            Assert.Null(typeof(ServerCommandLine).Assembly.GetType(
                "FsusBlog.Server.Infrastructure.SchemaMigration." + name));
        }
    }

    [Fact]
    public void CheckAsync_DoesNotInferCurrentSchemaFromCatalog()
    {
        InvalidOperationException legacy = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse(["migrate", "--check", "--release", "20260720000000-aaaaaaaaaaaa"]));
        Assert.Equal("server_command_unknown", legacy.Message);
        InvalidOperationException missing = Assert.Throws<InvalidOperationException>(() =>
            ServerCommandLine.Parse(["current-schema-check"]));
        Assert.Equal("server_command_current_schema_inputs_required", missing.Message);

        ServerCommand current = ServerCommandLine.Parse(
        [
            "current-schema-check", "--receipt", Path.Combine(Path.GetTempPath(), "current-receipt.json"),
            "--receipt-sha256", new string('a', 64),
            "--candidate-source-revision", new string('b', 40),
            "--env-file", Path.Combine(Path.GetTempPath(), "server.env")
        ]);
        Assert.Equal(ServerCommandKind.CurrentSchemaCheck, current.Kind);
        Assert.Equal(new string('a', 64), current.SchemaCheck!.ArtifactSha256);
        Assert.Equal(new string('b', 40), current.SchemaCheck.CandidateSourceRevision);
        // Parsing explicit inputs is not receipt issuance or native admission.
    }
}
