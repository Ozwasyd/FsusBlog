using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class AnonymousGovernanceAdminEndpointTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void AdminAnonymousGovernanceEndpoints_AreBinaryAdminStepUpAndPermissionGated()
    {
        string composition = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs");
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousGovernance.cs");

        Assert.Contains("MapBinaryAnonymousGovernanceEndpoints(group)", composition, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/admin/anonymous-governance/status\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/admin/anonymous-governance/nullifiers\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/admin/anonymous-governance/nullifiers/block\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/admin/anonymous-governance/credentials/revoke\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AnonymousCommentConfigure", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AnonymousNullifierBlock", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminPermissions.AnonymousCredentialRevoke", endpoints, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", endpoints, StringComparison.Ordinal);
        Assert.True(CountOccurrences(endpoints, "RequireAnonymousGovernance") >= 4);
        Assert.True(CountOccurrences(endpoints, "RecordHighValueAsync") >= 4);
        Assert.Contains("AnonymousGovernanceStatusRead", endpoints, StringComparison.Ordinal);
        Assert.Contains("AnonymousGovernanceNullifiersRead", endpoints, StringComparison.Ordinal);
        Assert.Contains("HashAuditTargetId(\"anonymous_governance_status\", \"status\")", endpoints, StringComparison.Ordinal);
        Assert.Contains("HashAuditTargetId(\"comment_anonymous_nullifier\", \"collection\")", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("/author/comments/moderation", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("Results.Json", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousGovernanceDtos_DoNotExposeDeanonymizationFields()
    {
        string dto = BackendTestPaths.ReadAllTextFromRoot("src/backend/Models/Dtos/AnonymousGovernanceDtos.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousGovernanceService.cs");

        foreach (string forbidden in new[]
        {
            "UserId",
            "UserName",
            "PublicHandle",
            "CredentialCommitment",
            "CommitmentHash",
            "Proof",
            "Witness",
            "Secret"
        })
        {
            Assert.DoesNotContain(forbidden, dto, StringComparison.OrdinalIgnoreCase);
        }

        Assert.Contains("MaskHash", service, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccount", service, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<User>", service, StringComparison.Ordinal);
        Assert.DoesNotContain("Navigate", dto, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnonymousGovernanceService_ListsMaskedNullifiersWithoutUserIdentity()
    {
        using SqlSugarClient db = await CreateGovernanceDbAsync();
        CreateNullifierTable(db);
        db.Insertable(new CommentAnonymousNullifier
        {
            NullifierHash = "0123456789abcdef0123456789abcdef",
            Scope = "article:42",
            UseCount = 2,
            FirstCommentId = 1001,
            LastCommentId = 1002,
            Blocked = true,
            BlockReason = "spam wave",
            CreatedAtUtc = DateTime.Parse("2026-06-19T01:00:00Z").ToUniversalTime(),
            UpdatedAtUtc = DateTime.Parse("2026-06-19T02:00:00Z").ToUniversalTime()
        }).ExecuteCommand();

            var service = new AnonymousGovernanceService(db, new EmptyRootService());

            AnonymousGovernanceNullifierListResponse response = await service.ListNullifiersAsync(CancellationToken.None);

            AnonymousGovernanceNullifierRow row = Assert.Single(response.Items);
            Assert.Equal("article:42", row.Scope);
            Assert.Equal("blocked", row.Status);
            Assert.Equal(2, row.UseCount);
            Assert.Equal("01234567...89abcdef", row.MaskedHash);
            Assert.Equal("0123456789abcdef0123456789abcdef", row.NullifierHash);

            string json = JsonSerializer.Serialize(row);
            Assert.DoesNotContain("user", json, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("credentialCommitment", json, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("proof", json, StringComparison.OrdinalIgnoreCase);
    }

    private static int CountOccurrences(string value, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = value.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private Task<SqlSugarClient> CreateGovernanceDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateNullifierTable(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(db, typeof(CommentAnonymousNullifier));

    private sealed class EmptyRootService : IAnonymousCredentialRootService
    {
        public Task<FsusBlog.Core.Common.Result<FsusBlog.Core.Mapping.Models.AnonymousCredentialRootSnapshotCoreModel>> GetCurrentSnapshotAsync(
            CancellationToken cancellationToken = default)
            => Task.FromResult(FsusBlog.Core.Common.Result<FsusBlog.Core.Mapping.Models.AnonymousCredentialRootSnapshotCoreModel>.Failure(
                FsusBlog.Core.Common.ErrorCode.InfraFailure,
                "anonymous_root_unavailable"));

        public void Invalidate()
        {
        }
    }
}
