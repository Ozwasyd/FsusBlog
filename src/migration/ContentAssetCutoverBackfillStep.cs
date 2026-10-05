namespace FsusBlog.Migration;

internal sealed record ContentAssetCutoverBackfillStep : SchemaMigrationStep
{
    internal override string Kind => "ContentAssetCutoverBackfill";
    internal override string Fingerprint => "asset-id-v1:files+article+draft+revision:fail-closed";

    internal override async Task ExecuteAsync(
        SqlSugar.ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string? publicAssetRoot = ContentAssetCutoverBackfillContext.PublicAssetRoot;
        if (string.IsNullOrWhiteSpace(publicAssetRoot))
        {
            throw new InvalidOperationException("content_asset_cutover_storage_root_missing");
        }

        await ContentAssetCutoverBackfill.ExecuteAsync(
            db,
            publicAssetRoot,
            cancellationToken).ConfigureAwait(false);
    }

    internal override SchemaMigrationCommand? BuildCommand(ISchemaDdlProvider ddl) => null;
}

internal static class ContentAssetCutoverBackfillContext
{
    private static readonly AsyncLocal<string?> s_publicAssetRoot = new();

    internal static string? PublicAssetRoot => s_publicAssetRoot.Value;

    internal static IDisposable Push(string? publicAssetRoot)
    {
        string? previous = s_publicAssetRoot.Value;
        s_publicAssetRoot.Value = publicAssetRoot;
        return new Scope(previous);
    }

    private sealed class Scope(string? previous) : IDisposable
    {
        private readonly string? _previous = previous;
        private bool _disposed;

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            s_publicAssetRoot.Value = _previous;
        }
    }
}
