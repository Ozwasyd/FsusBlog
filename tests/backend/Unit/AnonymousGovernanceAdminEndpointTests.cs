using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousGovernanceAdminEndpointTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminAnonymousGovernanceEndpoints_AreBinaryAdminStepUpAndPermissionGated()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        var expected = new (string Route, string Method, string Permission)[]
        {
            ("/api/binary/admin/anonymous-governance/status", HttpMethods.Get, AdminPermissions.AnonymousCommentConfigure),
            ("/api/binary/admin/anonymous-governance/nullifiers", HttpMethods.Get, AdminPermissions.AnonymousNullifierBlock),
            ("/api/binary/admin/anonymous-governance/nullifiers/block", HttpMethods.Post, AdminPermissions.AnonymousNullifierBlock),
            ("/api/binary/admin/anonymous-governance/credentials/revoke", HttpMethods.Post, AdminPermissions.AnonymousCredentialRevoke)
        };
        foreach ((string route, string method, string permission) in expected)
        {
            AssertPermission(EndpointContractApplication.Find(app, route, method), permission);
        }

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "MapBinaryAnonymousGovernanceEndpoints",
            "HandleAnonymousGovernanceStatusAsync",
            "HandleAnonymousGovernanceNullifiersAsync",
            "HandleAnonymousGovernanceNullifierBlockAsync",
            "HandleAnonymousGovernanceCredentialRevokeAsync",
            "RequireAnonymousGovernanceReadAsync",
            "RecordAnonymousGovernanceStatusReadAuditAsync",
            "RecordAnonymousGovernanceNullifiersReadAuditAsync");
        Assert.Contains("RequireAdminSensitiveStepUpAsync", runtimeShape, StringComparison.Ordinal);
        Assert.True(CountOccurrences(runtimeShape, "RequireAnonymousGovernance") >= 4);
        Assert.True(CountOccurrences(runtimeShape, "RecordHighValueAsync") >= 4);
        Assert.Contains("AnonymousGovernanceStatusRead", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AnonymousGovernanceNullifiersRead", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("anonymous_governance_status", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("comment_anonymous_nullifier", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("/author/comments/moderation", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("Results.Json", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousGovernanceRuntimeDtos_DoNotExposeDeanonymizationFields()
    {
        PropertyInfo[] dtoProperties = typeof(AnonymousGovernanceStatusResponse).Assembly.DefinedTypes
            .Where(static type => type.Namespace == typeof(AnonymousGovernanceStatusResponse).Namespace)
            .Where(static type => type.Name.StartsWith("AnonymousGovernance", StringComparison.Ordinal))
            .SelectMany(static type => type.GetProperties(BindingFlags.Instance | BindingFlags.Public))
            .ToArray();

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
            Assert.DoesNotContain(dtoProperties, property =>
                property.Name.Contains(forbidden, StringComparison.OrdinalIgnoreCase));
        }

        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(AnonymousGovernanceService));
        Assert.Contains("MaskHash", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccount", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("FsusBlog.Server.Entities.User", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain(dtoProperties, static property =>
            property.Name.Contains("Navigate", StringComparison.OrdinalIgnoreCase));
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

    private static void AssertPermission(RouteEndpoint endpoint, string expectedPermission)
    {
        ClaimsAuthorizationRequirement permission = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(expectedPermission, permission.AllowedValues ?? []);
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
