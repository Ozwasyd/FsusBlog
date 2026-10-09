using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests;

public sealed class SystemSiteIdentityTests
{
    private const string InstallationKey = "SiteIdentity_Installation_0000000001";
    private const string MappingKey = "SiteIdentity_Scope_0000000001_0000000001";
    private const string Scope = "https://reviewed.example";

    [Fact]
    public void ValidJournal_ExposesActorCompatibleIdentityAndExactMapping()
    {
        SystemSiteIdentityReadModel result = Parse(ValidRows());
        Assert.Equal(SystemSiteIdentityState.Current, result.State);
        Assert.True(ArticleRelationContractValidator.Validate(new ArticleRelationActorContext(
            "actor:test", result.Identity!, new string('a', 64))).IsValid);
        Assert.Equal(1, result.LifecycleVersion);
        Assert.Equal(1, result.Generation);
        Assert.Equal(1, result.MappingRevision);
        Assert.Equal(Scope, Assert.Single(result.Scopes).Scope);
    }

    [Fact]
    public void EmptyOrOrphanJournal_RefusesAuthority()
    {
        AssertRefusal(Parse(new Dictionary<string, string>()), SystemSiteIdentityState.Absent);
        Dictionary<string, string> rows = ValidRows();
        rows.Remove(InstallationKey);
        AssertRefusal(Parse(rows), SystemSiteIdentityState.Ambiguous);
        rows = ValidRows();
        rows["SiteIdentity_Unknown"] = "1|extra";
        AssertRefusal(Parse(rows), SystemSiteIdentityState.Ambiguous);
    }

    [Fact]
    public void UnsupportedOrOversizeJournal_RefusesWithoutFallback()
    {
        Dictionary<string, string> rows = ValidRows();
        rows[MappingKey] = "2|future";
        AssertRefusal(Parse(rows), SystemSiteIdentityState.UnsupportedVersion);
        rows = ValidRows();
        rows[MappingKey] = new string('x', 513);
        AssertRefusal(Parse(rows), SystemSiteIdentityState.Malformed);
    }

    [Fact]
    public void MalformedIdentityDigestAndScope_RefuseAuthority()
    {
        foreach (string value in new[] { "http:scope", "fsus-site:short", "fsus-site:" + new string('A', 64) })
        {
            Dictionary<string, string> rows = ValidRows();
            string[] parts = rows[InstallationKey].Split('|');
            parts[1] = value;
            rows[InstallationKey] = string.Join('|', parts);
            AssertRefusal(Parse(rows), SystemSiteIdentityState.Malformed);
        }
        foreach (string scope in new[] { "https://unreviewed.example", "https://a.example?q=1", "https://user@a.example", "https://a.example/#bad", " https://a.example" })
        {
            Dictionary<string, string> rows = ValidRows();
            string[] parts = rows[MappingKey].Split('|');
            parts[4] = scope;
            rows[MappingKey] = string.Join('|', parts);
            AssertRefusal(Parse(rows), SystemSiteIdentityState.Malformed);
        }
    }

    [Fact]
    public void MissingRevisionAndDuplicateIntent_RefuseAuthority()
    {
        Dictionary<string, string> rows = ValidRows();
        rows["SiteIdentity_Scope_0000000001_0000000003"] = rows[MappingKey];
        AssertRefusal(Parse(rows), SystemSiteIdentityState.Ambiguous);
        rows.Remove("SiteIdentity_Scope_0000000001_0000000003");
        rows["SiteIdentity_Scope_0000000001_0000000002"] = rows[MappingKey];
        AssertRefusal(Parse(rows), SystemSiteIdentityState.Malformed);
    }

    [Fact]
    public async Task InvalidOperatorInputs_AreRejectedBeforeStorageAccess()
    {
        SystemService service = CreateService(Substitute.For<ISqlSugarClient>());
        await Assert.ThrowsAsync<ArgumentException>(() => service.InitializeSiteIdentityAsync(Guid.Empty, Scope));
        foreach (string scope in new[] { "https://a.example/" + new string('x', 256), "https://a.example|bad", "https://a.example?x=1", "https://user@a.example", "https://a.example\n", "ftp://a.example" })
        {
            await Assert.ThrowsAsync<ArgumentException>(() => service.InitializeSiteIdentityAsync(Guid.NewGuid(), scope));
        }
        await Assert.ThrowsAsync<ArgumentException>(() => service.CloneSiteIdentityAsync(
            Guid.NewGuid(), 1, 1, Scope, (SystemSiteIdentityCloneDisposition)0));
    }

    internal static SystemService CreateService(ISqlSugarClient db)
        => new(db, Substitute.For<IUnifiedCache>(), Substitute.For<IUnifiedCache>(),
            Substitute.For<IUnifiedCache>(), Substitute.For<ICacheMissCoordinator>(),
            Substitute.For<IDbConcurrencyGate>(), NullLogger<SystemService>.Instance,
            Substitute.For<IPublicAotInvalidationService>(), Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<ICacheInvalidationDispatcher>());

    private static Dictionary<string, string> ValidRows()
    {
        var intent = Guid.Parse("04865d69-58c4-4c6e-ae4e-fd41838a35d7");
        string digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"1|Fresh|{intent:N}|0|0|{Scope}")));
        return new(StringComparer.Ordinal)
        {
            [InstallationKey] = $"1|fsus-site:{new string('a', 64)}|{intent:N}|{digest}|Fresh|-|-",
            [MappingKey] = $"1|{intent:N}|{digest}|Add|{Scope}"
        };
    }

    private static SystemSiteIdentityReadModel Parse(IReadOnlyDictionary<string, string> rows)
    {
        MethodInfo method = typeof(SystemService).GetMethod("ParseIdentityJournal", BindingFlags.NonPublic | BindingFlags.Static)!;
        object journal = method.Invoke(null, [rows])!;
        return (SystemSiteIdentityReadModel)journal.GetType().GetProperty("ReadModel")!.GetValue(journal)!;
    }

    private static void AssertRefusal(SystemSiteIdentityReadModel result, SystemSiteIdentityState state)
    {
        Assert.Equal(state, result.State);
        Assert.Null(result.Identity);
        Assert.Null(result.MappingRevision);
        Assert.Empty(result.Scopes);
    }
}
