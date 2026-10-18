using System.Collections.Immutable;
using System.Reflection;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.Integration;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>
/// Reuses the frozen source owner's isolated SQL/Redis fixture unchanged. Its synthetic ACL is
/// diagnostic setup, not a canonical scope owner or production/native authorization acceptance.
/// No issuer, permission map, persistence implementation or approval flag is recreated here.
/// </summary>
internal sealed class OriginalApprovalFixture(object host) : IAsyncDisposable
{
    internal static async Task<OriginalApprovalFixture> CreateAsync(
        PostgresSchemaMigrationFixture postgres, PublicHotDeliveryRedisFixture redis)
    {
        MethodInfo factory = typeof(AuthoringExtensionApprovalPostgresTests).GetMethod("CreateAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        var pending = (Task)factory.Invoke(new AuthoringExtensionApprovalPostgresTests(postgres, redis), null)!;
        await pending;
        return new(pending.GetType().GetProperty("Result")!.GetValue(pending)!);
    }

    internal T Get<T>(string name) => (T)host.GetType().GetProperty(name)!.GetValue(host)!;
    internal T Call<T>(string name, params object?[] arguments)
        => (T)host.GetType().GetMethod(name)!.Invoke(host, arguments)!;

    internal AuthoringExtensionApprovalAuthority Authority => Get<AuthoringExtensionApprovalAuthority>("Authority");
    internal VerifiedAuthoringPackage OldPackage => Get<VerifiedAuthoringPackage>("OldPackage");
    internal VerifiedAuthoringPackage NewPackage => Get<VerifiedAuthoringPackage>("NewPackage");
    internal AuthoringFencedStateMigration Plan => Get<AuthoringFencedStateMigration>("Plan");
    internal ImmutableArray<AuthoringExecutionTarget> OldTargets => Get<ImmutableArray<AuthoringExecutionTarget>>("OldTargets");
    internal ImmutableArray<AuthoringExecutionTarget> NewTargets => Get<ImmutableArray<AuthoringExecutionTarget>>("NewTargets");
    internal AuthoringLifecycleReceipt Receipt => Get<AuthoringLifecycleReceipt>("Receipt");
    internal Task<long> EventsAsync() => Call<Task<long>>("ScalarAsync", "SELECT count(*) FROM authoring_extension_approval_event;");
    internal Task ExecuteAsync(string sql) => Call<Task>("ExecuteAsync", sql);
    public ValueTask DisposeAsync() => ((IAsyncDisposable)host).DisposeAsync();
}
