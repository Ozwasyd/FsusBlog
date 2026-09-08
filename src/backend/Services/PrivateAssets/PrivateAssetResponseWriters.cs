using FsusBlog.Server.Interfaces;

using Microsoft.Extensions.Hosting;
using Microsoft.Net.Http.Headers;

namespace FsusBlog.Server.Services.PrivateAssets;

internal sealed class OpenRestyPrivateAssetResponseWriter : IPrivateAssetResponseWriter
{
    internal const string InternalLocationPrefix = "/_fsus/private-assets/";

    public Task WriteAsync(
        HttpContext context,
        PrivateAssetReadHandle handle,
        CancellationToken cancellationToken = default)
    {
        SetSuccessHeaders(context.Response, handle);
        context.Response.Headers["X-Accel-Redirect"] = InternalLocationPrefix + handle.StorageKey.Value;
        return Task.CompletedTask;
    }

    internal static void SetSuccessHeaders(HttpResponse response, PrivateAssetReadHandle handle)
    {
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = handle.MediaType;
        response.ContentLength = handle.SizeBytes;
        response.Headers.CacheControl = "private,no-store";
        response.Headers.Pragma = "no-cache";
        response.Headers[HeaderNames.XContentTypeOptions] = "nosniff";
    }
}

internal sealed class KestrelPrivateAssetResponseWriter(IPrivateAssetStore store) : IPrivateAssetResponseWriter
{
    public async Task WriteAsync(
        HttpContext context,
        PrivateAssetReadHandle handle,
        CancellationToken cancellationToken = default)
    {
        if (HttpMethods.IsHead(context.Request.Method))
        {
            OpenRestyPrivateAssetResponseWriter.SetSuccessHeaders(context.Response, handle);
            return;
        }

        await using PrivateAssetReadHandle? opened = await store.OpenReadAsync(
            handle.AssetId,
            cancellationToken);
        if (opened?.Content is null || !Matches(handle, opened))
        {
            throw new FileNotFoundException("private_asset_unavailable");
        }

        OpenRestyPrivateAssetResponseWriter.SetSuccessHeaders(context.Response, opened);
        await opened.Content.CopyToAsync(context.Response.Body, cancellationToken);
    }

    private static bool Matches(PrivateAssetReadHandle expected, PrivateAssetReadHandle actual)
        => expected.AssetId == actual.AssetId
            && expected.StorageKey == actual.StorageKey
            && expected.SizeBytes == actual.SizeBytes
            && string.Equals(expected.Sha256, actual.Sha256, StringComparison.OrdinalIgnoreCase)
            && string.Equals(expected.MediaType, actual.MediaType, StringComparison.Ordinal);
}

internal static class PrivateAssetResponseWriterFactory
{
    public static IPrivateAssetResponseWriter Create(
        IHostEnvironment environment,
        IPrivateAssetStore store)
        => environment.IsProduction()
            ? new OpenRestyPrivateAssetResponseWriter()
            : new KestrelPrivateAssetResponseWriter(store);
}
