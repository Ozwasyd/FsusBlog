namespace FsusBlog.Migration;

internal sealed record ContentAssetCutoverBackfillStep : SchemaMigrationStep
{
    internal override string Kind => "ContentAssetCutoverBackfill";
    internal override string Fingerprint => "asset-id-v1:files+article+draft+revision:fail-closed";
    internal override SchemaMigrationCommand? BuildCommand(ISchemaDdlProvider ddl) => null;
}
