using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class SecurityChallengePersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void Migration_CreatesChallengeAuditTablesWithoutRawPayload()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260618-post-security-challenge-persistence");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS security_challenge", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS security_challenge_attempt", fingerprint, StringComparison.Ordinal);
        Assert.Contains("status varchar(32) NOT NULL DEFAULT 'issued'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("payload_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("traceparent varchar(128) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_security_challenge_status_expiry", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_security_challenge_attempt_challenge", fingerprint, StringComparison.Ordinal);
        Assert.Contains("'issued'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("'verified'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("'expired'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("'replayed'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("'failed'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("'revoked'", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("payload_raw", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("raw_payload", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Entities_MapChallengeTablesWithoutPayloadSourceColumns()
    {
        string[] challengeColumns = typeof(SecurityChallenge)
            .GetProperties()
            .Select(static property => property.Name)
            .ToArray();
        string[] attemptColumns = typeof(SecurityChallengeAttempt)
            .GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.Contains(nameof(SecurityChallenge.PayloadHash), challengeColumns);
        Assert.Contains(nameof(SecurityChallengeAttempt.PayloadHash), attemptColumns);
        Assert.DoesNotContain(challengeColumns, static column => column.Contains("Raw", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(attemptColumns, static column => column.Contains("Raw", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(challengeColumns, static column => string.Equals(column, "Payload", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(attemptColumns, static column => string.Equals(column, "Payload", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RuntimeServices_RegisterSecurityChallengePersistence()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengePersistenceService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(SecurityChallengePersistenceService), descriptor.ImplementationType);
    }

    [Fact]
    public void RecordAttemptAsync_UsesReturningMetricsWithoutPostTransactionAttemptChallengeReloads()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/Security/SecurityChallengePersistenceService.cs"));
        string record = ExtractMethodBlock(source, "public async Task<SecurityChallengeAttempt> RecordAttemptAsync");

        Assert.Contains("RETURNING", source, StringComparison.Ordinal);
        Assert.Contains("ReadChallengeMetricContextAsync", record, StringComparison.Ordinal);
        Assert.DoesNotContain("storedAttempt", record, StringComparison.Ordinal);
        Assert.DoesNotContain("storedChallenge", record, StringComparison.Ordinal);
        Assert.DoesNotContain("SingleAsync(item => item.AttemptId", record, StringComparison.Ordinal);
        Assert.DoesNotContain("SingleAsync(item => item.ChallengeId", record, StringComparison.Ordinal);
    }

    [Fact]
    public async Task IssueAsync_PersistsChallengeHashMetadata()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        var service = new SecurityChallengePersistenceService(db);
        SecurityChallengeIssueRequest request = CreateIssueRequest();

        SecurityChallenge issued = await service.IssueAsync(request, CancellationToken.None);

        Assert.Equal(SecurityChallengeStatuses.Issued, issued.Status);
        SecurityChallenge stored = await db.Queryable<SecurityChallenge>()
            .SingleAsync(item => item.ChallengeId == request.ChallengeId);
        Assert.Equal(SecurityChallengeStatuses.Issued, stored.Status);
        Assert.Equal(request.Kind, stored.Kind);
        Assert.Equal(request.Algorithm, stored.Algorithm);
        Assert.Equal(request.Action, stored.Action);
        Assert.Equal(request.RouteKey, stored.RouteKey);
        Assert.Equal(request.SubjectHash, stored.SubjectHash);
        Assert.Equal(request.ClientIpHash, stored.ClientIpHash);
        Assert.Equal(request.DeviceFpHash, stored.DeviceFpHash);
        Assert.Equal(request.PolicyVersion, stored.PolicyVersion);
        Assert.Equal(request.PayloadHash, stored.PayloadHash);
        Assert.Equal(request.TraceId, stored.TraceId);
        Assert.Equal(request.Traceparent, stored.Traceparent);

        string[] dbColumns = db.DbMaintenance.GetColumnInfosByTableName("security_challenge")
            .Select(static column => column.DbColumnName)
            .ToArray();
        Assert.Contains("payload_hash", dbColumns);
        Assert.DoesNotContain(dbColumns, static column => string.Equals(column, "payload", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("raw", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task RecordAttemptAsync_WritesSuccessAttemptAndTransitionsChallenge()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        var service = new SecurityChallengePersistenceService(db);
        SecurityChallengeIssueRequest request = CreateIssueRequest();
        await service.IssueAsync(request, CancellationToken.None);

        SecurityChallengeAttempt attempt = await service.RecordAttemptAsync(
            CreateAttemptRequest(request.ChallengeId, SecurityChallengeAttemptOutcomes.Verified),
            CancellationToken.None);

        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, attempt.Outcome);
        SecurityChallenge stored = await db.Queryable<SecurityChallenge>()
            .SingleAsync(item => item.ChallengeId == request.ChallengeId);
        Assert.Equal(SecurityChallengeStatuses.Verified, stored.Status);
        Assert.NotNull(stored.VerifiedAtUtc);
        Assert.Equal(1, await db.Queryable<SecurityChallengeAttempt>()
            .CountAsync(item => item.ChallengeId == request.ChallengeId));
    }

    [Fact]
    public async Task RecordAttemptAsync_WritesFailureAndReplayAttemptsIndependently()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        var service = new SecurityChallengePersistenceService(db);
        SecurityChallengeIssueRequest request = CreateIssueRequest();
        await service.IssueAsync(request, CancellationToken.None);

        await service.RecordAttemptAsync(
            CreateAttemptRequest(request.ChallengeId, SecurityChallengeAttemptOutcomes.Failed, "bad_solution"),
            CancellationToken.None);
        await service.RecordAttemptAsync(
            CreateAttemptRequest(request.ChallengeId, SecurityChallengeAttemptOutcomes.Replayed, "already_consumed"),
            CancellationToken.None);

        SecurityChallenge stored = await db.Queryable<SecurityChallenge>()
            .SingleAsync(item => item.ChallengeId == request.ChallengeId);
        List<SecurityChallengeAttempt> attempts = await db.Queryable<SecurityChallengeAttempt>()
            .Where(item => item.ChallengeId == request.ChallengeId)
            .OrderBy(item => item.Id)
            .ToListAsync();

        Assert.Equal(SecurityChallengeStatuses.Replayed, stored.Status);
        Assert.Equal(2, attempts.Count);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempts[0].Outcome);
        Assert.Equal("bad_solution", attempts[0].Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, attempts[1].Outcome);
        Assert.Equal("already_consumed", attempts[1].Reason);
    }

    [Fact]
    public async Task ExpireAndRevokeAsync_RecordTerminalStateAttempts()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        var service = new SecurityChallengePersistenceService(db);
        SecurityChallengeIssueRequest expiring = CreateIssueRequest();
        SecurityChallengeIssueRequest revoked = CreateIssueRequest(challengeId: SecurityChallengeContracts.CreateChallengeId());
        await service.IssueAsync(expiring, CancellationToken.None);
        await service.IssueAsync(revoked, CancellationToken.None);

        Assert.True(await service.ExpireAsync(expiring.ChallengeId, "ttl_elapsed", CancellationToken.None));
        Assert.True(await service.RevokeAsync(revoked.ChallengeId, "admin_revoked", CancellationToken.None));

        SecurityChallenge expired = await db.Queryable<SecurityChallenge>()
            .SingleAsync(item => item.ChallengeId == expiring.ChallengeId);
        SecurityChallenge revokedChallenge = await db.Queryable<SecurityChallenge>()
            .SingleAsync(item => item.ChallengeId == revoked.ChallengeId);

        Assert.Equal(SecurityChallengeStatuses.Expired, expired.Status);
        Assert.Equal(SecurityChallengeStatuses.Revoked, revokedChallenge.Status);
        Assert.Equal(2, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
    }

    private static SecurityChallengeIssueRequest CreateIssueRequest(string? challengeId = null)
    {
        DateTime now = DateTime.UtcNow;
        return new SecurityChallengeIssueRequest(
            challengeId ?? SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1),
            "sha256-pow-v1",
            "public.article.read",
            "/article/42",
            HashA,
            HashA,
            HashA,
            "risk-policy-v2",
            HashA,
            "trace-1",
            Traceparent,
            now,
            now.AddMinutes(5));
    }

    private static SecurityChallengeAttemptRequest CreateAttemptRequest(
        string challengeId,
        string outcome,
        string? reason = null)
        => new(
            challengeId,
            outcome,
            reason,
            HashB,
            HashA,
            HashA,
            "trace-attempt",
            Traceparent,
            DateTime.UtcNow);

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(SecurityChallenge),
            typeof(SecurityChallengeAttempt));
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing method signature: {signature}");

        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart >= 0, $"Missing method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
