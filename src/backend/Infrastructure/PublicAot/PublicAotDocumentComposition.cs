using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotDocumentComposition
{
    Task<PublicAotRenderOutcome> ClassifyRouteAsync(
        PublicAotRouteMatch match,
        CancellationToken cancellationToken);

    Task<Result<PublicAotNavigationSnapshot>> BuildNavigationSnapshotAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        DateTimeOffset generatedAtUtc,
        CancellationToken cancellationToken);

    Task<Result<PublicAotBackfillDocument>> BuildBackfillDocumentAsync(
        PublicAotBackfillRequest request,
        DateTimeOffset renderTimestampUtc,
        CancellationToken cancellationToken);
}

public sealed record PublicAotBackfillDocument(
    PublicAotRouteMatch Match,
    string Html,
    string RendererVersion,
    DateTimeOffset RenderTimestampUtc);

internal sealed class PublicAotDocumentComposition(
    IDbConcurrencyGate dbConcurrencyGate,
    IPublicAotRouteIdentity routeIdentity,
    IEnumerable<IPublicAotBootstrapProvider> bootstrapProviders,
    IPublicAotEntryRenderer entryRenderer,
    IPublicAotDocumentService documentService,
    ISpaAssetManifestService assetManifest) : IPublicAotDocumentComposition
{
    private readonly IReadOnlyDictionary<PublicPageKind, IPublicAotBootstrapProvider> _bootstrapProviders =
        BuildBootstrapProviderMap(bootstrapProviders);

    public async Task<PublicAotRenderOutcome> ClassifyRouteAsync(
        PublicAotRouteMatch match,
        CancellationToken cancellationToken)
    {
        if (!_bootstrapProviders.TryGetValue(match.Kind, out IPublicAotBootstrapProvider? provider))
        {
            return PublicAotRenderOutcome.TransientFailure(
                ErrorDetail.Create(ErrorCode.InfraFailure, $"public_aot_provider_missing:{match.Kind}"));
        }

        Result<PublicPageSnapshot> snapshot;
        try
        {
            snapshot = await dbConcurrencyGate.ExecuteClassifiedAsync(
                DbWorkloadClass.PublicShortRead,
                "public-aot-route-status",
                gateCt => provider.BuildSnapshotAsync(match, gateCt),
                _ => Task.FromResult(Result<PublicPageSnapshot>.Failure(ErrorCode.InfraFailure, "db-gate-timeout")),
                cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            return PublicAotRenderOutcome.TransientFailure(
                ErrorDetail.Create(ErrorCode.InfraFailure, "public_aot_route_status_failed"));
        }

        if (snapshot.IsSuccess && snapshot.Value is not null)
        {
            if (PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey)
                && snapshot.Value is PublicFilterPageSnapshot { FilterId: > 0 } filter)
            {
                string canonicalRouteKey = PublicRouteIdentity.BuildPaginatedRouteKey(
                    PublicRouteIdentity.BuildTagIdRouteKey(filter.FilterId),
                    match.Page);
                return PublicAotRenderOutcome.PermanentRedirect(string.Concat(
                    PublicRouteIdentity.BuildCanonicalPath(PublicPageId.Filter, canonicalRouteKey, null),
                    PublicRouteIdentity.BuildPaginationQueryString(match.Page)));
            }

            return PublicAotRenderOutcome.Success(null);
        }

        return snapshot.Error.Code is ErrorCode.NotFound or ErrorCode.Validation
            ? PublicAotRenderOutcome.NotFound(snapshot.Error)
            : PublicAotRenderOutcome.TransientFailure(snapshot.Error);
    }

    public async Task<Result<PublicAotNavigationSnapshot>> BuildNavigationSnapshotAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        DateTimeOffset generatedAtUtc,
        CancellationToken cancellationToken)
    {
        if (!_bootstrapProviders.TryGetValue(match.Kind, out IPublicAotBootstrapProvider? provider))
        {
            return Result<PublicAotNavigationSnapshot>.Failure(
                ErrorCode.Validation,
                $"public_aot_provider_missing:{match.Kind}");
        }

        Result<PublicPageSnapshot> snapshot = await provider.BuildSnapshotAsync(match, cancellationToken);
        if (snapshot.IsFailure || snapshot.Value is null)
        {
            return Result<PublicAotNavigationSnapshot>.Failure(snapshot.Error);
        }

        PublicPageSnapshot snapshotValue = snapshot.Value;
        if (PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey)
            && snapshotValue is PublicFilterPageSnapshot { FilterId: > 0 } filter)
        {
            string canonicalFilterKey = PublicRouteIdentity.BuildTagIdRouteKey(filter.FilterId);
            string canonicalRouteKey = PublicRouteIdentity.BuildPaginatedRouteKey(canonicalFilterKey, match.Page);
            string canonicalPath = PublicRouteIdentity.BuildTagPath(filter.FilterId);
            match = match with
            {
                RouteKey = canonicalRouteKey,
                Path = canonicalPath,
                CanonicalPath = canonicalPath
            };
            snapshotValue = filter with
            {
                RouteKey = canonicalRouteKey,
                FilterKey = canonicalFilterKey
            };
        }

        Result<PublicAotShellEntryContract> entry = await entryRenderer.BuildEntryAsync(
            new PublicAotRenderRequest(match, snapshotValue, generatedAtUtc),
            cancellationToken);
        if (entry.IsFailure || entry.Value is null)
        {
            return Result<PublicAotNavigationSnapshot>.Failure(entry.Error);
        }

        PublicAotShellEntryContract renderedEntry = entry.Value;
        if (!TryValidateRendererOutput(
            match,
            renderedEntry,
            out string normalizedRouteKey,
            out string normalizedHtml,
            out string error))
        {
            return Result<PublicAotNavigationSnapshot>.Failure(ErrorCode.Validation, error);
        }

        PublicAotShellEntryContract normalizedEntry = renderedEntry with
        {
            RouteKey = normalizedRouteKey,
            Html = normalizedHtml
        };
        PublicAotRouteMatch navigationMatch = match with
        {
            RouteKey = normalizedRouteKey
        };
        Result<PublicSeoHeadModel> seoHead = await documentService.BuildSeoHeadModelAsync(
            normalizedEntry,
            cancellationToken);
        if (seoHead.IsFailure || seoHead.Value is null)
        {
            return Result<PublicAotNavigationSnapshot>.Failure(seoHead.Error);
        }

        return Result<PublicAotNavigationSnapshot>.Success(PublicAotNavigationSnapshot.Create(
            navigationMatch,
            normalizedEntry,
            seoHead.Value,
            assetManifest.GetFrontendAssetVersion(context),
            generatedAtUtc));
    }

    public async Task<Result<PublicAotBackfillDocument>> BuildBackfillDocumentAsync(
        PublicAotBackfillRequest request,
        DateTimeOffset renderTimestampUtc,
        CancellationToken cancellationToken)
    {
        PublicAotRouteMatch match = routeIdentity.ResolveBackfillMatch(request);
        if (PublicTagUrlIdentity.IsNameRouteKey(match.RouteKey))
        {
            return Result<PublicAotBackfillDocument>.Failure(
                ErrorCode.Validation,
                "public_aot_tag_name_route_noncanonical");
        }

        if (!_bootstrapProviders.TryGetValue(match.Kind, out IPublicAotBootstrapProvider? provider))
        {
            return Result<PublicAotBackfillDocument>.Failure(
                ErrorCode.Validation,
                $"public_aot_provider_missing:{match.Kind}");
        }

        Result<PublicPageSnapshot> snapshot = await provider.BuildSnapshotAsync(match, cancellationToken);
        if (snapshot.IsFailure)
        {
            return Result<PublicAotBackfillDocument>.Failure(snapshot.Error);
        }

        Result<PublicAotShellEntryContract> entry = await entryRenderer.BuildEntryAsync(
            new PublicAotRenderRequest(match, snapshot.Value!, renderTimestampUtc),
            cancellationToken);
        if (entry.IsFailure)
        {
            return Result<PublicAotBackfillDocument>.Failure(entry.Error);
        }

        PublicAotShellEntryContract renderedEntry = entry.Value!;
        if (!TryValidateRendererOutput(
            match,
            renderedEntry,
            out string normalizedRouteKey,
            out string normalizedHtml,
            out string error))
        {
            return Result<PublicAotBackfillDocument>.Failure(ErrorCode.Validation, error);
        }

        PublicAotShellEntryContract normalizedEntry = renderedEntry with
        {
            RouteKey = normalizedRouteKey,
            Html = normalizedHtml
        };
        Result<string> document = await documentService.ComposeAsync(normalizedEntry, cancellationToken);
        if (document.IsFailure)
        {
            return Result<PublicAotBackfillDocument>.Failure(document.Error);
        }

        return Result<PublicAotBackfillDocument>.Success(new PublicAotBackfillDocument(
            match with
            {
                RouteKey = normalizedRouteKey
            },
            document.Value!,
            normalizedEntry.RendererVersion ?? PublicAotConstants.RendererVersion,
            renderTimestampUtc));
    }

    private static bool TryValidateRendererOutput(
        PublicAotRouteMatch match,
        PublicAotShellEntryContract entry,
        out string normalizedRouteKey,
        out string normalizedHtml,
        out string error)
    {
        if (!string.Equals(
                entry.RenderLocale,
                match.LocaleResolution.Locale.Code,
                StringComparison.Ordinal))
        {
            normalizedRouteKey = string.Empty;
            normalizedHtml = string.Empty;
            error = "public_aot_renderer_request_locale_mismatch";
            return false;
        }

        return PublicAotShellContractRules.TryValidateEntry(
            entry,
            out normalizedRouteKey,
            out normalizedHtml,
            out error);
    }

    private static IReadOnlyDictionary<PublicPageKind, IPublicAotBootstrapProvider> BuildBootstrapProviderMap(
        IEnumerable<IPublicAotBootstrapProvider> bootstrapProviders)
    {
        IPublicAotBootstrapProvider[] providers = bootstrapProviders.ToArray();
        PublicPageKind[] duplicateKinds = providers
            .GroupBy(static provider => provider.Kind)
            .Where(static group => group.Count() > 1)
            .Select(static group => group.Key)
            .OrderBy(static kind => kind)
            .ToArray();
        if (duplicateKinds.Length > 0)
        {
            throw new InvalidOperationException($"public_aot_provider_duplicate:{string.Join(',', duplicateKinds)}");
        }

        Dictionary<PublicPageKind, IPublicAotBootstrapProvider> providerMap = providers
            .ToDictionary(static provider => provider.Kind);
        PublicPageKind[] missingKinds = PublicAotPageIdentity.GetSeoEligibleKinds()
            .Where(kind => !providerMap.ContainsKey(kind))
            .OrderBy(static kind => kind)
            .ToArray();
        if (missingKinds.Length > 0)
        {
            throw new InvalidOperationException($"public_aot_provider_missing:{string.Join(',', missingKinds)}");
        }

        return providerMap;
    }
}
