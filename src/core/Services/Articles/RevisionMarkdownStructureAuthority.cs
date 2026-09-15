using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed class RevisionMarkdownStructureAuthority(
    IEnumerable<IRevisionMarkdownStructureProvider> providers) : IRevisionMarkdownStructureAuthority
{
    private readonly IRevisionMarkdownStructureProvider[] _providers = [.. providers];

    public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default)
    {
        if (_providers.Length == 0)
        {
            return RevisionMarkdownStructureReadResult.Unavailable();
        }
        if (_providers.Length != 1)
        {
            return RevisionMarkdownStructureReadResult.Invalid();
        }

        RevisionMarkdownStructureReadResult result = await _providers[0]
            .ReadAsync(request, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (result.Status != RevisionMarkdownStructureReadStatus.Available
            || result.Snapshot is null)
        {
            return new RevisionMarkdownStructureReadResult(result.Status, null);
        }
        return RevisionMarkdownStructureSnapshotSeal.Verify(request, result.Snapshot)
            ? result
            : RevisionMarkdownStructureReadResult.Invalid();
    }
}
