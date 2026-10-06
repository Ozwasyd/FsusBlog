using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaCatalogObserverTests
{
    [Theory]
    [InlineData("_int2", "int2", "smallint[]", "int16-array")]
    [InlineData("_uuid", "uuid", "uuid[]", "uuid-array")]
    [InlineData("_text", "text", "text[]", "string-array")]
    public void NativeArrayIdentityRequiresBuiltinElementPhysicalTypeAndActualRankOne(
        string udt, string element, string physical, string semantic)
    {
        Assert.Equal(semantic, PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "ARRAY", udt, physical, 1, "b", "pg_catalog", element, "pg_catalog"));
        foreach (int rank in new[] { -1, 0, 2 })
        {
            Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
                "ARRAY", udt, physical, rank, "b", "pg_catalog", element, "pg_catalog"));
        }
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "ARRAY", udt, physical, 1, "d", "pg_catalog", element, "pg_catalog"));
        // The actual query exposes a domain's formatted base as semantic_data_type,
        // while physical_type and attndims still describe the domain column.
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            physical, udt, "public.array_domain", 0, "d", "public", "", ""));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "ARRAY", udt, physical, 1, "b", "public", element, "pg_catalog"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "ARRAY", udt, physical, 1, "b", "pg_catalog", element, "public"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "ARRAY", udt, physical + "[]", 1, "b", "pg_catalog", element, "pg_catalog"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "ARRAY", udt, physical, 1, "b", "pg_catalog", "unknown", "pg_catalog"));
    }

    [Fact]
    public void ScalarColumnRequiresActualRankZeroAndCannotAdoptAnArrayPhysicalType()
    {
        Assert.Equal("int32", PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "integer", "int4", "integer", 0, "b", "pg_catalog", "", ""));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "integer", "int4", "integer", 1, "b", "pg_catalog", "", ""));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.NormalizePostgresColumnSemanticType(
            "uuid", "_uuid", "uuid[]", 0, "b", "pg_catalog", "uuid", "pg_catalog"));
    }

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
