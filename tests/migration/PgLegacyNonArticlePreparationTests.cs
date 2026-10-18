using System.Security.Cryptography;
using System.Text;

using Xunit;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration.Tests;

// Production binding/cleanup controls, not fake native migration approval.
public sealed class PgLegacyNonArticlePreparationTests
{
    private const string Owner = "FsusBlog.Server.Entities.Control";

    [Fact]
    public void PhysicalRenamesComeFromTheOwnedPropertyNotAnotherMapping()
    {
        var program = Bind(Table(), new Dictionary<string, string> { ["Id"] = "s.id", ["Value"] = "s.value" });
        Assert.Contains("INSERT INTO public.\"actual_table\" (\"actual_id\",\"actual_value\")", program.InsertSql, StringComparison.Ordinal);
        Assert.Contains("CAST((s.id) AS integer)", program.InsertSql, StringComparison.Ordinal);
        Assert.Contains("EXCEPT ALL", program.VerifySql, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE TABLE", program.InsertSql, StringComparison.Ordinal);
        Assert.Contains("char_length((s.value)::text)>64", program.InputValidationSql, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableDefaultsRemainTypedNulls()
    {
        var program = Bind(Table(nullable: true), new Dictionary<string, string> { ["Id"] = "s.id" });
        Assert.Contains("CAST((NULL) AS character varying(64))", program.InsertSql, StringComparison.Ordinal);
    }

    [Fact]
    public void RequiredCurrentValueCannotBeInvented()
        => Assert.Throws<InvalidOperationException>(() => Bind(Table(), new Dictionary<string, string> { ["Id"] = "s.id" }));

    [Theory]
    [InlineData("missing-owner")]
    [InlineData("duplicate-owner")]
    [InlineData("different-owner")]
    [InlineData("key-drift")]
    [InlineData("computed")]
    [InlineData("converter")]
    public void ActualOwnedFieldDriftRefusesTheSameProductionBinder(string change)
    {
        SchemaTableModel table = Table();
        SchemaColumnModel value = table.Columns["actual_value"];
        table.Columns["actual_value"] = change switch
        {
            "missing-owner" => value with { Owner = null },
            "duplicate-owner" => value with { Owner = new(Owner + ".Id", "control") },
            "different-owner" => value with { Owner = new("another.Value", "control") },
            "key-drift" => value with { Name = "another" },
            "computed" => value with { ComputedExpression = "1" },
            "converter" => value with { Conversion = "json" },
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<InvalidOperationException>(() => Bind(table, new Dictionary<string, string> { ["Id"] = "s.id", ["Value"] = "s.value" }));
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("omitted")]
    public void UnknownAssignedOrExcludedPropertyCannotDisappear(string change)
    {
        var expressions = new Dictionary<string, string> { ["Id"] = "s.id", ["Value"] = "s.value" };
        if (change == "unknown")
            expressions.Add("Unknown", "s.other");
        Assert.Throws<InvalidOperationException>(() => PgLegacyNonArticlePreparation.BindTable(
            Table(), Owner, "SELECT * FROM original", expressions, null, change == "omitted" ? ["Unknown"] : [], false, Input()));
    }

    [Fact]
    public void ReorderedOwnedColumnsAreStillTheSameBindings()
    {
        SchemaTableModel table = Table();
        var reordered = new SchemaTableModel(table.Name, table.Columns.Reverse().ToDictionary(pair => pair.Key, pair => pair.Value), [], owner: table.Owner);
        var expressions = new Dictionary<string, string> { ["Id"] = "s.id", ["Value"] = "s.value" };
        var first = Bind(table, expressions);
        var second = Bind(reordered, expressions);
        Assert.Equal(first.Properties["Id"], second.Properties["Id"]);
        Assert.Equal(first.Properties["Value"], second.Properties["Value"]);
        Assert.Contains("EXCEPT ALL", second.VerifySql, StringComparison.Ordinal);
    }

    [Fact]
    public void GeneratedIdRequiresTheActualIdentityPrimaryKey()
    {
        SchemaTableModel table = Table();
        Assert.Throws<InvalidOperationException>(() => PgLegacyNonArticlePreparation.BindTable(
            table, Owner, "SELECT * FROM original", new Dictionary<string, string> { ["Value"] = "s.value" }, "Id", [], false, Input()));
        table.Columns["actual_id"] = table.Columns["actual_id"] with
        {
            IsIdentity = true
        };
        var program = PgLegacyNonArticlePreparation.BindTable(table, Owner, "SELECT * FROM original",
            new Dictionary<string, string> { ["Value"] = "s.value" }, "Id", [], false, Input());
        Assert.DoesNotContain("CAST((s.id)", program.InsertSql, StringComparison.Ordinal);
        Assert.Contains("EXCEPT ALL", program.VerifySql, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(37)]
    public void HistoricalAccountIdsUseTheOriginalAnonymousHashWithoutPositiveIdBan(int id)
    {
        string expected = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            "fsus:account-subject:v1:anonymous_account:anonymous-account:" + id.ToString(System.Globalization.CultureInfo.InvariantCulture))));
        Assert.Equal(expected, AccountSubjectHashOnlineBackfillHandler.ComputeLegacyAnonymousAccountSubject(id));
    }

    [Fact]
    public async Task OperationFailureIsNotReplacedByDisposeFailure()
    {
        var original = new InvalidOperationException("original");
        var resource = new FailingResource();
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgLegacyNonArticlePreparation.WithResourceAsync<FailingResource, bool>(resource, _ => Task.FromException<bool>(original)));
        Assert.Same(original, actual);
        Assert.True(resource.Disposed);
        Assert.Equal("ApplicationException", actual.Data["legacy_nonarticle_cleanup_types"]);
    }

    [Fact]
    public async Task OriginalCancellationIsNotReplacedByCleanupFailure()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var original = new OperationCanceledException(cancellation.Token);
        OperationCanceledException actual = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            PgLegacyNonArticlePreparation.WithResourceAsync<FailingResource, bool>(new(), _ => Task.FromException<bool>(original)));
        Assert.Same(original, actual);
        Assert.Equal(cancellation.Token, actual.CancellationToken);
    }

    [Fact]
    public async Task CleanupOnlyFailureStillRefusesSuccess()
        => await Assert.ThrowsAsync<ApplicationException>(() =>
            PgLegacyNonArticlePreparation.WithResourceAsync<FailingResource, bool>(new(), _ => Task.FromResult(true)));

    [Fact]
    public async Task StreamingTextFailureIsNotReplacedByTextReaderDisposeFailure()
    {
        var original = new InvalidOperationException("original-text-read");
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgLegacyNonArticlePreparation.WithTextReaderAsync(new FailingTextReader(), _ => Task.FromException<bool>(original)));
        Assert.Same(original, actual);
        Assert.Equal("ApplicationException", actual.Data["legacy_nonarticle_cleanup_types"]);
    }

    private static PgLegacyNonArticlePreparation.LegacyTableProgram Bind(SchemaTableModel table, IReadOnlyDictionary<string, string> expressions)
        => PgLegacyNonArticlePreparation.BindTable(table, Owner, "SELECT * FROM original", expressions, null, [], false, Input());

    private static SchemaTableModel Table(bool nullable = false) => new("actual_table", new()
    {
        ["actual_id"] = new("actual_id", false, true, false, null, "int32", Owner: new(Owner + ".Id", "control")),
        ["actual_value"] = new("actual_value", nullable, false, false, 64, "string", Owner: new(Owner + ".Value", "control"))
    }, [], owner: new(Owner, "control"));

    private static CurrentSchemaBootstrapInput Input() => new(
        new(new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>()), new("m", "e", "g", "s", "c")),
        new("control", "control", "control", "control"), []);

    private sealed class FailingResource : IAsyncDisposable
    {
        internal bool Disposed
        {
            get; private set;
        }
        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.FromException(new ApplicationException("cleanup contains no authority"));
        }
    }

    private sealed class FailingTextReader : StringReader
    {
        internal FailingTextReader() : base("content")
        {
        }
        protected override void Dispose(bool disposing) => throw new ApplicationException("text-cleanup");
    }
}
