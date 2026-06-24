using System.Globalization;
using System.Linq.Expressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.PublicAot;
using Microsoft.Extensions.Configuration;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public class AuditLogStoreTests
{
    [Fact]
    public async Task WriteBatchAsync_LinksRecordsWithinTheSameChain()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        SugarParameter[]? capturedParameters = null;
        db.Ado.Returns(ado);
        ConfigureChainTail(db, null);
        ado.ExecuteCommandAsync(
                Arg.Any<string>(),
                Arg.Do<SugarParameter[]>(parameters => capturedParameters = parameters))
            .Returns(Task.FromResult(2));
        var store = new AuditLogStore(db, new ConfigurationBuilder().Build());

        await store.WriteBatchAsync(
        [
            BuildRecord("first"),
            BuildRecord("second")
        ], CancellationToken.None);

        Assert.NotNull(capturedParameters);
        string? firstPrevHash = ReadStringParameter(capturedParameters!, "@prev_hash_0");
        string? firstRecordHash = ReadStringParameter(capturedParameters!, "@record_hash_0");
        string? secondPrevHash = ReadStringParameter(capturedParameters!, "@prev_hash_1");
        string? secondRecordHash = ReadStringParameter(capturedParameters!, "@record_hash_1");

        Assert.Null(firstPrevHash);
        Assert.False(string.IsNullOrWhiteSpace(firstRecordHash));
        Assert.Equal(firstRecordHash, secondPrevHash);
        Assert.False(string.IsNullOrWhiteSpace(secondRecordHash));
        Assert.NotEqual(firstRecordHash, secondRecordHash);
    }

    [Fact]
    public async Task WriteBatchAsync_LinksFirstRecordToExistingChainTail()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        SugarParameter[]? capturedParameters = null;
        db.Ado.Returns(ado);
        ConfigureChainTail(db, "previous-record-hash");
        ado.ExecuteCommandAsync(
                Arg.Any<string>(),
                Arg.Do<SugarParameter[]>(parameters => capturedParameters = parameters))
            .Returns(Task.FromResult(1));
        var store = new AuditLogStore(db, new ConfigurationBuilder().Build());

        await store.WriteBatchAsync([BuildRecord("next")], CancellationToken.None);

        Assert.NotNull(capturedParameters);
        Assert.Equal("previous-record-hash", ReadStringParameter(capturedParameters!, "@prev_hash_0"));
        Assert.False(string.IsNullOrWhiteSpace(ReadStringParameter(capturedParameters!, "@record_hash_0")));
    }

    [Fact]
    public async Task WriteBatchAsync_GeneratesContextJsonFromBinaryPayload()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        SugarParameter[]? capturedParameters = null;
        db.Ado.Returns(ado);
        ConfigureChainTail(db, null);
        ado.ExecuteCommandAsync(
                Arg.Any<string>(),
                Arg.Do<SugarParameter[]>(parameters => capturedParameters = parameters))
            .Returns(Task.FromResult(1));
        var store = new AuditLogStore(db, new ConfigurationBuilder().Build());
        byte[] payload = PublicAotBinaryPayload.EncodeObjectFrame(new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["trace"] = "trace-1",
            ["count"] = 2
        });

        await store.WriteBatchAsync([BuildRecord("with-context") with { ContextPayload = payload }], CancellationToken.None);

        Assert.NotNull(capturedParameters);
        Assert.Equal("{\"trace\":\"trace-1\",\"count\":2}", ReadStringParameter(capturedParameters!, "@context_json_0"));
    }

    [Fact]
    public async Task WriteBatchAsync_UsesInvariantChainIdAcrossCultures()
    {
        string[] chainIds = [];
        foreach (string cultureName in new[] { "en-US", "fa-IR", "ar-SA", "th-TH" })
        {
            chainIds = [.. chainIds, await CaptureWrittenChainIdAsync(cultureName)];
        }

        Assert.All(chainIds, chainId => Assert.Equal("20260614", chainId));
    }

    [Fact]
    public async Task WriteBatchAsync_ChainTailQueryHitsInvariantChainAcrossCultures()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        Expression<Func<AuditLog, bool>>? capturedWhere = null;
        db.Ado.Returns(ado);
        ConfigureChainTail(db, "previous-record-hash", where => capturedWhere = where);
        ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(1));
        var store = new AuditLogStore(db, new ConfigurationBuilder().Build());

        await RunWithCultureAsync("fa-IR", () => store.WriteBatchAsync([BuildRecord("cross-node")], CancellationToken.None));

        Assert.NotNull(capturedWhere);
        Func<AuditLog, bool> predicate = capturedWhere!.Compile();
        Assert.True(predicate(new AuditLog { ChainId = "20260614", RecordHash = "previous-record-hash" }));
    }

    private static AuditRecord BuildRecord(string eventInfo)
        => new(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new DateTime(2026, 6, 14, 12, 0, 0, DateTimeKind.Utc),
            eventInfo,
            null,
            Action: "auth.test",
            Outcome: AuditOutcomeCatalog.Success,
            Severity: AuditSeverityCatalog.Info);

    private static async Task<string> CaptureWrittenChainIdAsync(string cultureName)
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        SugarParameter[]? capturedParameters = null;
        db.Ado.Returns(ado);
        ConfigureChainTail(db, null);
        ado.ExecuteCommandAsync(
                Arg.Any<string>(),
                Arg.Do<SugarParameter[]>(parameters => capturedParameters = parameters))
            .Returns(Task.FromResult(1));
        var store = new AuditLogStore(db, new ConfigurationBuilder().Build());

        await RunWithCultureAsync(cultureName, () => store.WriteBatchAsync([BuildRecord(cultureName)], CancellationToken.None));

        Assert.NotNull(capturedParameters);
        return ReadStringParameter(capturedParameters!, "@chain_id_0")!;
    }

    private static async Task RunWithCultureAsync(string cultureName, Func<Task> action)
    {
        CultureInfo previousCulture = CultureInfo.CurrentCulture;
        CultureInfo previousUiCulture = CultureInfo.CurrentUICulture;
        CultureInfo culture = CultureInfo.GetCultureInfo(cultureName);
        CultureInfo.CurrentCulture = culture;
        CultureInfo.CurrentUICulture = culture;
        try
        {
            await action();
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
            CultureInfo.CurrentUICulture = previousUiCulture;
        }
    }

    private static string? ReadStringParameter(SugarParameter[] parameters, string name)
    {
        var value = parameters.Single(parameter => parameter.ParameterName == name).Value;
        return value == DBNull.Value ? null : (string?)value;
    }

    private static void ConfigureChainTail(
        ISqlSugarClient db,
        string? tail,
        Action<Expression<Func<AuditLog, bool>>>? captureWhere = null)
    {
        var queryable = Substitute.For<ISugarQueryable<AuditLog>>();
        var hashQueryable = Substitute.For<ISugarQueryable<string>>();
        db.Queryable<AuditLog>().Returns(queryable);
        queryable.Where(Arg.Do<Expression<Func<AuditLog, bool>>>(where => captureWhere?.Invoke(where))).Returns(queryable);
        queryable.OrderByDescending(Arg.Any<Expression<Func<AuditLog, object>>>()).Returns(queryable);
        queryable.Select(Arg.Any<Expression<Func<AuditLog, string>>>()).Returns(hashQueryable);
        hashQueryable.FirstAsync(Arg.Any<CancellationToken>())
            .Returns(tail is null ? Task.FromResult<string>(null!) : Task.FromResult(tail));
    }
}
