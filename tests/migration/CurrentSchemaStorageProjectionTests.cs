using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentSchemaStorageProjectionTests
{
    [Fact]
    public void PhysicalConversionDomain_DoesNotReplaceLogicalInputOrJsonStorageFacts()
    {
        var logical = new SchemaColumnModel("payload", false, false, false, null, "json", Conversion: "json",
            Owner: new("FsusBlog.Server.Entities.Probe.Payload", "original-owner"));
        CurrentSchemaCanonicalModel canonical = Model(logical);
        CurrentSchemaIdentity before = canonical.Identity;
        SchemaModelSnapshot physical = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql);
        Assert.Equal("json", canonical.SemanticSchema.Tables["probe"].Columns["payload"].Conversion);
        Assert.Equal(before, canonical.Identity);
        Assert.Equal("none", physical.Tables["probe"].Columns["payload"].Conversion);
        Assert.Equal("jsonb", physical.Tables["probe"].Columns["payload"].PhysicalType);
        Assert.Equal(logical.Owner, physical.Tables["probe"].Columns["payload"].Owner);
        Assert.NotEqual(before.ContentDigest, Model(logical with { Conversion = "none" }).Identity.ContentDigest);

        SchemaColumnModel actualWrongType = physical.Tables["probe"].Columns["payload"] with { PhysicalType = "text" };
        Assert.NotEmpty(SchemaModelComparer.Compare(physical, Snapshot(actualWrongType)));
        SchemaColumnModel inventedActualLogicalConversion = physical.Tables["probe"].Columns["payload"] with { Conversion = "json" };
        Assert.NotEmpty(SchemaModelComparer.Compare(physical, Snapshot(inventedActualLogicalConversion)));
    }

    [Fact]
    public void UnknownLogicalConverter_CannotBeErasedByPhysicalProjection()
    {
        CurrentSchemaCanonicalModel canonical = Model(new("payload", false, false, false, null, "json", Conversion: "unknown-converter"));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql));
    }

    private static CurrentSchemaCanonicalModel Model(SchemaColumnModel column)
        => CurrentSchemaCanonicalAuthority.Create(Snapshot(column).Tables, new string('a', 64));

    private static SchemaModelSnapshot Snapshot(SchemaColumnModel column)
        => new(new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal)
        {
            ["probe"] = new("probe", new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal) { [column.Name] = column }, [],
                owner: new("FsusBlog.Server.Entities.Probe", "original-owner"))
        }, provider: SchemaProviderKind.PostgreSql);
}
