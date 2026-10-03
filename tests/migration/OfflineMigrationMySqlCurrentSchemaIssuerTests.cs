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
}
