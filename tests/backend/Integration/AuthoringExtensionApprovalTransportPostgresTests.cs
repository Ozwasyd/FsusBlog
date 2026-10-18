using System.Collections.Immutable;
using System.Security.Claims;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringExtensions;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionApprovalTransportPostgresTests(
    PostgresSchemaMigrationFixture postgres, PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task Adapter_ProjectsOnlyOriginalPersistedPendingDecisionAndExactIdentitySemantics()
    {
        await using OriginalApprovalFixture host = await OriginalApprovalFixture.CreateAsync(postgres, redis);
        var transport = new AuthoringExtensionApprovalTransport(host.Authority);
        AuthoringExtensionApprovalPreviewResponse pending = await PrepareAsync(transport, host);
        var reread = await transport.ReadAsync(new(2, pending.DecisionId));
        Assert.Equal(pending.Digest, reread.Digest);
        Assert.Equal((byte)AuthoringApprovalStatus.Pending, reread.Status);
        Assert.Equal(host.Plan.ContentSha256, reread.FrozenPlan!.ContentSha256);
        Assert.Equal(host.Plan.MaximumDuration.Ticks, reread.FrozenPlan.MaximumDurationTicks);
        Assert.Equal(host.Receipt.PackageSha256, reread.ExpectedLifecycleReceipt.PackageSha256);
        Assert.Equal(host.OldPackage.Contract.Manifest.PackageSha256, reread.OrderedOldTargets[0].PackageSha256);
        Assert.NotEqual(host.OldPackage.PackageIdentity, reread.OrderedOldTargets[0].PackageSha256);
        Assert.Equal(AuthoringExtensionStateContract.ScopeId(host.Plan.From), reread.OperationContext.SourceScopeSha256);
        Assert.Equal(1, await host.EventsAsync());
        byte[] bytes = PodBinaryCodec.EncodeAuthoringExtensionApprovalPreviewResponse(reread);
        Assert.True(PodBinaryCodec.TryDecodeAuthoringExtensionApprovalPreviewResponse(bytes, out var decoded));
        Assert.Equal(reread.Digest, decoded.Digest);
        Assert.DoesNotContain(typeof(AuthoringExtensionApprovalTransport).GetMethods(), method =>
            method.Name is "ClaimMigrationAsync" or "ClaimDeletionAsync" or "CompleteAsync");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DenyOrRevoke_CallsOriginalDurableTransitionRatherThanSynthesizingSnapshotReceipt(bool revoke)
    {
        await using OriginalApprovalFixture host = await OriginalApprovalFixture.CreateAsync(postgres, redis);
        var transport = new AuthoringExtensionApprovalTransport(host.Authority);
        var pending = await PrepareAsync(transport, host);
        var request = new AuthoringExtensionApprovalDecisionRequest(2, pending.DecisionId);
        var result = revoke ? await transport.RevokeAsync(request) : await transport.DenyAsync(request);
        Assert.Equal((byte)(revoke ? AuthoringApprovalStatus.Revoked : AuthoringApprovalStatus.Denied), result.Status);
        Assert.Equal(result.Status, (byte)(await host.Authority.ReadAsync(pending.DecisionId)).Status);
        Assert.Equal(2, await host.EventsAsync());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => transport.DenyAsync(request).AsTask());
        Assert.Equal(2, await host.EventsAsync());
    }

    [Fact]
    public async Task MissingScopeCustody_AllTransportActionsRefuseWithoutAppendingEvents()
    {
        await using OriginalApprovalFixture host = await OriginalApprovalFixture.CreateAsync(postgres, redis);
        var pending = await PrepareAsync(new(host.Authority), host);
        var unavailable = new AuthoringExtensionApprovalTransport(host.Call<AuthoringExtensionApprovalAuthority>("WithoutScopeAuthority"));
        var request = new AuthoringExtensionApprovalDecisionRequest(2, pending.DecisionId);
        foreach (Func<Task> action in new Func<Task>[]
        {
            () => unavailable.ReadAsync(request).AsTask(), () => unavailable.DenyAsync(request).AsTask(),
            () => unavailable.RevokeAsync(request).AsTask(),
            () => unavailable.ConfirmMigrationAsync(new(2, pending.DecisionId, pending.Digest, "inert-not-a-proof"),
                host.OldPackage, host.NewPackage, host.Plan, host.OldTargets, host.NewTargets, host.Receipt).AsTask()
        })
        {
            var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(action);
            Assert.Equal("approval_exact_scope_authority_unavailable", error.Message);
            Assert.Equal(1, await host.EventsAsync());
        }
    }

    [Theory]
    [InlineData("sql-permission")]
    [InlineData("sql-session")]
    [InlineData("site")]
    [InlineData("scope-user")]
    [InlineData("scope-document")]
    public async Task LiveOwnerRevocationOrScopeExpansion_RefusesThroughOriginalAuthority(string scenario)
    {
        await using OriginalApprovalFixture host = await OriginalApprovalFixture.CreateAsync(postgres, redis);
        var transport = new AuthoringExtensionApprovalTransport(host.Authority);
        var pending = await PrepareAsync(transport, host);
        if (scenario == "sql-permission")
        {
            // A client claim never repairs the actual SQL permission revocation.
            var identity = (ClaimsIdentity)host.Get<IHttpContextAccessor>("Context").HttpContext!.User.Identity!;
            identity.AddClaim(new("permissions", "system.config"));
            await host.ExecuteAsync("UPDATE admin_principal SET permissions='';");
        }
        else if (scenario == "sql-session")
        {
            await host.ExecuteAsync("UPDATE admin_session SET revokedatutc=clock_timestamp();");
        }
        else if (scenario == "site")
        {
            host.Get<IConfigurationRoot>("Configuration")["AuthoringExtensions:SiteId"] = "foreign-site";
        }
        else
        {
            var state = host.Get<PostgresAuthoringExtensionStateStore>("State");
            var from = scenario == "scope-user" ? host.Plan.From with
            {
                UserId = "foreign-user"
            }
                : host.Plan.From with
                {
                    DocumentId = "foreign-document"
                };
            var to = scenario == "scope-user" ? host.Plan.To with
            {
                UserId = "foreign-user"
            }
                : host.Plan.To with
                {
                    DocumentId = "foreign-document"
                };
            await state.InitializeAsync(host.OldPackage, from, default);
            await state.InitializeAsync(host.NewPackage, to, default);
            var plan = AuthoringStateProcessWorker.Plan(await state.ReadAsync(host.OldPackage, from, default), to, []);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => transport.PrepareMigrationAsync(
                host.OldPackage, host.NewPackage, plan, host.OldTargets, host.NewTargets, host.Receipt).AsTask());
            Assert.Equal(1, await host.EventsAsync());
            return;
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => transport.ReadAsync(new(2, pending.DecisionId)).AsTask());
        Assert.Equal(1, await host.EventsAsync());
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("target-order-or-identity")]
    [InlineData("plan")]
    public async Task ChangedConfirmationFacts_RefuseWithoutConsentOrClaim(string scenario)
    {
        await using OriginalApprovalFixture host = await OriginalApprovalFixture.CreateAsync(postgres, redis);
        var transport = new AuthoringExtensionApprovalTransport(host.Authority);
        var pending = await PrepareAsync(transport, host);
        var request = new AuthoringExtensionApprovalConfirmationRequest(2, pending.DecisionId,
            scenario == "digest" ? new string('0', 64) : pending.Digest, "inert-not-a-proof");
        AuthoringFencedStateMigration plan = host.Plan;
        var targets = host.NewTargets;
        if (scenario == "plan")
        {
            plan = plan with
            {
                BackupReference = "different-backup"
            };
            plan = plan with
            {
                ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
            };
        }
        if (scenario == "target-order-or-identity")
        {
            targets = targets.Length > 1 ? targets.Reverse().ToImmutableArray()
                : [targets[0] with { RuntimeIdentity = new string('f', 64) }];
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => transport.ConfirmMigrationAsync(
            request, host.OldPackage, host.NewPackage, plan, host.OldTargets, targets, host.Receipt).AsTask());
        Assert.Equal(1, await host.EventsAsync());
        Assert.Equal(AuthoringApprovalStatus.Pending, (await host.Authority.ReadAsync(pending.DecisionId)).Status);
    }

    private static ValueTask<AuthoringExtensionApprovalPreviewResponse> PrepareAsync(
        AuthoringExtensionApprovalTransport transport, OriginalApprovalFixture host)
        => transport.PrepareMigrationAsync(host.OldPackage, host.NewPackage, host.Plan,
            host.OldTargets, host.NewTargets, host.Receipt);
}
