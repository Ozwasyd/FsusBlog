using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaCatalogObserverTests
{
    [Fact]
    public void NativeIndexObservation_PreservesCompleteOriginalPhysicalKeySemantics()
    {
        const string json = """[{"column":"name","direction":"desc","nullPlacement":"first","operatorClass":"public.text_pattern_ops","collation":"public.c"}]""";
        SchemaIndexKeyModel key = Assert.Single(PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(json, hasExpressions: false));
        Assert.Equal(new SchemaIndexKeyModel("name", "desc", "first", "public.text_pattern_ops", "public.c"), key);
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(json, hasExpressions: true));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(
            """[{"column":"name","direction":"asc","nullPlacement":"last","operatorClass":"default","collation":"default","unknown":true}]""", false));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys("[]", false));
    }

    [Fact]
    public void NativeGenerationObservation_RejectsUnknownOrInconsistentIdentitySequenceFacts()
    {
        Assert.Equal("owned-sequence-default", PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("", "nextval('probe_seq'::regclass)", true));
        Assert.Equal("identity-by-default", PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("d", null, true));
        Assert.Equal("identity-always", PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("a", null, true));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("unknown", null, false));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("", null, true));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("d", "nextval('probe_seq'::regclass)", true));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind("a", null, false));
    }

    [Fact]
    public void NativePhysicalObservation_OnlyNormalizesOriginalDefaultTimestampPrecision()
    {
        Assert.Equal("timestamp without time zone", PgCurrentSchemaCatalogObserver.NormalizePostgresPhysicalType("timestamp(6) without time zone"));
        Assert.Equal("timestamp(0) without time zone", PgCurrentSchemaCatalogObserver.NormalizePostgresPhysicalType("timestamp(0) without time zone"));
        Assert.Equal("public.c", PgCurrentSchemaCatalogObserver.NormalizePostgresCollation("public.c"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresCollation("unknown"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresForeignKeyAction("unknown"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresForeignKeyMatchType("unknown"));
    }
}
