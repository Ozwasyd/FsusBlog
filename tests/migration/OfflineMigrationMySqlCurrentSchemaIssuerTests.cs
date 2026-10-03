using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration.Tests;

// These controls exercise structural admission and refusal before native access.
// They do not mint an owned context or represent a successful database receipt.
public sealed class OfflineMigrationMySqlCurrentSchemaIssuerTests
{
    private static readonly string s_digest = new('a', 64);

    [Theory]
    [InlineData("postgres")]
    [InlineData("sqlite")]
    [InlineData("unknown")]
    [InlineData("latest")]
    [InlineData("empty-checkpoints")]
    [InlineData("duplicate-checkpoints")]
    [InlineData("invocation-control")]
    public void OwnedRequest_RejectsUnsupportedOrAmbiguousInputs(string variant)
    {
        OfflineMigrationCurrentSchemaVerifyRequest request = Request();
        OfflineMigrationCurrentSchemaIssuer.ValidateOwnedMySqlRequest(request);
        // The old PostgreSQL entry remains provider-specific, not a raw-pair bypass.
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateRequest(request));
        OfflineMigrationCurrentSchemaVerifyRequest changed = variant switch
        {
            "postgres" => request with { Database = request.Database with { Provider = CurrentSchemaProviderKind.PostgreSql } },
            "sqlite" => request with { Database = request.Database with { Provider = CurrentSchemaProviderKind.Sqlite } },
            "unknown" => request with { Database = request.Database with { Provider = (CurrentSchemaProviderKind)999 } },
            "latest" => request with { Plan = request.Plan with { Reference = "plans/latest" } },
            "empty-checkpoints" => request with { Checkpoints = [] },
            "duplicate-checkpoints" => request with { Checkpoints = [request.Checkpoints[0], request.Checkpoints[0]] },
            "invocation-control" => request with { InvocationId = "invocation\n" },
            _ => throw new InvalidOperationException("Unknown owned-request control.")
        };
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateOwnedMySqlRequest(changed));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OwnedEntry_RequiresActualCreatorContextBeforeArtifactReads(bool existingReceipt)
    {
        OfflineMigrationCurrentSchemaVerifyRequest request = Request();
        OfflineMigrationCurrentSchemaIssuer.ValidateOwnedMySqlRequest(request);
        Task operation = existingReceipt
            ? OfflineMigrationCurrentSchemaIssuer.VerifyExistingOwnedMySqlAsync(new("receipt", s_digest), request, null!, null!, default)
            : OfflineMigrationCurrentSchemaIssuer.IssueOwnedMySqlAsync(request, null!, null!, default);
        ArgumentNullException error = await Assert.ThrowsAsync<ArgumentNullException>(() => operation);
        Assert.Equal("context", error.ParamName);
    }

    [Fact]
    public async Task Producer_RefusesMissingOwnersBeforeEnvironmentOrNativeAccess()
    {
        var owners = new OfflineMigrationCurrentSchemaVerificationCapabilities(null!, null!, null!, null!);
        IOfflineMigrationVerifiedReceiptProducer producer = OfflineMigrationVerifyEvidence.ComposeOwned(owners);
        var options = new OfflineMigrationVerifyCommandOptions(Request(), "not-read.env", "not-written.json", 1);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => producer.IssueAsync(options, default));
        Assert.Equal("current_verify_native_owners_not_configured", error.Message);
    }

    [Theory]
    [InlineData("issuer")]
    [InlineData("existing")]
    [InlineData("producer")]
    public async Task EntryCancellation_PrecedesContextOwnerAndEnvironmentAccess(string entry)
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Task operation = entry switch
        {
            "issuer" => OfflineMigrationCurrentSchemaIssuer.IssueOwnedMySqlAsync(null!, null!, null!, cancellation.Token),
            "existing" => OfflineMigrationCurrentSchemaIssuer.VerifyExistingOwnedMySqlAsync(null!, null!, null!, null!, cancellation.Token),
            "producer" => OfflineMigrationVerifyEvidence.ComposeOwned(
                new(null!, null!, null!, null!)).IssueAsync(null!, cancellation.Token),
            _ => throw new InvalidOperationException("Unknown entry control.")
        };
        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.Equal(cancellation.Token, error.CancellationToken);
    }

    [Theory]
    [InlineData("instance")]
    [InlineData("database")]
    [InlineData("target")]
    [InlineData("physical")]
    public void TerminalObservation_RequiresWholeCurrentBindingNotCatalogStatus(string variant)
    {
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", s_digest, s_digest);
        var original = new CurrentSchemaAdmissionObservation(target, Request().Database, s_digest);
        OfflineMigrationCurrentSchemaIssuer.ValidateTerminalCurrentObservation(original, original.Database, target, s_digest);
        CurrentSchemaAdmissionObservation changed = variant switch
        {
            "instance" => original with { Database = original.Database with { InstanceId = "other-instance" } },
            "database" => original with { Database = original.Database with { DatabaseId = "other-database" } },
            "target" => original with { Target = target with { ContentDigest = new string('b', 64) } },
            "physical" => original with { ActualSchemaDigest = new string('b', 64) },
            _ => throw new InvalidOperationException("Unknown terminal-binding control.")
        };
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCurrentSchemaIssuer.ValidateTerminalCurrentObservation(
            changed, original.Database, target, s_digest));
    }

    private static OfflineMigrationCurrentSchemaVerifyRequest Request()
        => new(new("plan", s_digest), new("apply", s_digest), [new("checkpoint", s_digest)],
            new(CurrentSchemaProviderKind.MySql, "instance", "database"), "invocation");

    [Fact]
    public async Task RetainedAuthority_DefaultOwnedPortDoesNotFallBackToRawPair()
    {
        var raw = new RawPairOnlyAuthority();
        IOfflineMigrationCurrentSchemaVerificationAuthority authority = raw;
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            authority.ReadAsync(null!, null!, default));
        Assert.Equal("offline_retained_authority_original_mysql_context_required", failure.Message);
        Assert.False(raw.RawPairCalled);
    }

    [Fact]
    public async Task RetainedAuthority_DefaultOwnedPortPreservesPreAccessCancellation()
    {
        var raw = new RawPairOnlyAuthority();
        IOfflineMigrationCurrentSchemaVerificationAuthority authority = raw;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        OperationCanceledException failure = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            authority.ReadAsync(null!, null!, cancellation.Token));
        Assert.Equal(cancellation.Token, failure.CancellationToken);
        Assert.False(raw.RawPairCalled);
    }

    [Theory]
    [InlineData("provider")]
    [InlineData("instance")]
    [InlineData("database")]
    [InlineData("target")]
    [InlineData("tool")]
    [InlineData("dag")]
    [InlineData("age")]
    public void RetainedBindingComparison_RequiresWholeOriginalPair(string variant)
    {
        // Synthetic comparison values are not an actual captured backup or held run.
        CurrentSchemaDatabaseIdentity captured = Request().Database;
        OfflineMigrationPlanningAuthority retained = Planning();
        OfflineMigrationRetainedEvidenceAuthority.ValidateRetainedBindings(captured, captured, retained, retained);
        CurrentSchemaDatabaseIdentity database = variant switch
        {
            "provider" => captured with { Provider = CurrentSchemaProviderKind.PostgreSql },
            "instance" => captured with { InstanceId = "other-instance" },
            "database" => captured with { DatabaseId = "other-database" },
            _ => captured
        };
        OfflineMigrationPlanningAuthority current = variant switch
        {
            "target" => retained with { Target = retained.Target with { ContentDigest = new string('b', 64) } },
            "tool" => retained with { Tool = retained.Tool with { ConfigurationDigest = new string('b', 64) } },
            "dag" => retained with { Dag = retained.Dag with { Steps = [retained.Dag.Steps[0] with { IdempotencyDefinition = "changed" }] } },
            "age" => retained with { MaximumBackupAge = retained.MaximumBackupAge.Add(TimeSpan.FromSeconds(1)) },
            _ => retained
        };
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationRetainedEvidenceAuthority.ValidateRetainedBindings(database, captured, retained, current));
        Assert.Equal(database == captured ? "offline_retained_plan_authority_changed"
            : "offline_retained_backup_native_database_changed", failure.Message);
    }

    [Theory]
    [InlineData("instance")]
    [InlineData("database")]
    [InlineData("provider")]
    [InlineData("isolation")]
    [InlineData("read-only")]
    [InlineData("increment")]
    [InlineData("offset")]
    public void RetainedIdentityComparison_RequiresWholeTerminalMaterial(string variant)
    {
        var initial = new OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial(
            Request().Database, "REPEATABLE-READ", "1", "1", "1");
        OfflineMigrationRetainedEvidenceAuthority.RequireMySqlIdentityUnchanged(initial, initial);
        OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial terminal = variant switch
        {
            "instance" => initial with { Database = initial.Database with { InstanceId = "other-instance" } },
            "database" => initial with { Database = initial.Database with { DatabaseId = "other-database" } },
            "provider" => initial with { Database = initial.Database with { Provider = CurrentSchemaProviderKind.PostgreSql } },
            "isolation" => initial with { Isolation = "READ-COMMITTED" },
            "read-only" => initial with { SessionReadOnly = "0" },
            "increment" => initial with { AutoIncrementIncrement = "2" },
            "offset" => initial with { AutoIncrementOffset = "2" },
            _ => throw new InvalidOperationException("Unknown terminal identity control.")
        };
        Assert.Equal("offline_retained_backup_native_database_changed", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationRetainedEvidenceAuthority.RequireMySqlIdentityUnchanged(initial, terminal)).Message);
    }

    [Theory]
    [InlineData("actual")]
    [InlineData("captured")]
    [InlineData("retained")]
    [InlineData("current")]
    public void RetainedBindingComparison_RejectsMissingValues(string missing)
    {
        CurrentSchemaDatabaseIdentity database = Request().Database;
        OfflineMigrationPlanningAuthority planning = Planning();
        Assert.Throws<ArgumentNullException>(() => OfflineMigrationRetainedEvidenceAuthority.ValidateRetainedBindings(
            missing == "actual" ? null! : database, missing == "captured" ? null! : database,
            missing == "retained" ? null! : planning, missing == "current" ? null! : planning));
    }

    private static OfflineMigrationPlanningAuthority Planning()
    {
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", s_digest, s_digest);
        var tool = new CurrentSchemaVerifierIdentity(new string('a', 40), s_digest, s_digest, s_digest);
        var step = new OfflineMigrationStep("step", "source", "target", [], "once", false,
            new("v1", 0, "none", "target"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "operation", s_digest, s_digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        return new(target, tool, new("dag", "v1", [step]), TimeSpan.FromHours(1));
    }

    private sealed class RawPairOnlyAuthority : IOfflineMigrationCurrentSchemaVerificationAuthority
    {
        internal bool RawPairCalled { get; private set; }

        public Task<OfflineMigrationCurrentSchemaAuthoritySnapshot> ReadAsync(
            OfflineMigrationPlan plan, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken)
        {
            RawPairCalled = true;
            throw new InvalidOperationException("Raw pair must not be used for the owned MySQL request.");
        }
    }
}
