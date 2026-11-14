using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;

namespace FsusBlog.V2.Server.Authoring;

internal static class PropertyEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        Map(WireRoutes.PropertyWorkspace, async (store, frame, ct) =>
            Wire.EncodePropertyWorkspace(await store.Read(Wire.DecodePropertyWorkspaceRequest(frame), ct)));
        Map(WireRoutes.PropertyDefinitionCommand, async (store, frame, ct) =>
            Wire.EncodePropertyCommandReceipt(await store.Change(Wire.DecodePropertyDefinitionCommand(frame), ct)));
        Map(WireRoutes.PropertyTextCommand, async (store, frame, ct) =>
            Wire.EncodePropertyCommandReceipt(await store.WriteText(Wire.DecodePropertyTextCommand(frame), ct)));

        void Map(string path, Func<PropertyStore, byte[], CancellationToken, Task<byte[]>> operation)
        {
            app.MapPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
            {
                var frame = await readFrame(ctx, WireLimits.PropertyMaxCommandBytes, ct);
                try
                {
                    var result = await store.WithSession(ctx.Request.Cookies[cookie], true,
                        (db, tx, actor) => operation(new PropertyStore(db, tx, actor), frame, ct), ct);
                    return Results.Bytes(result, Aeds.ContentType);
                }
                catch (PropertyValidationException)
                {
                    throw new BusinessException(Rejection.Invalid, "Invalid article property.");
                }
                catch (PropertySchemaException error)
                {
                    var message = error.AffectedCount is { } count && count > 0
                        ? $"Resolve {count} existing article values before changing this property definition."
                        : "The property definition changed or cannot be updated.";
                    throw new BusinessException(Rejection.Conflict, message);
                }
            }).RequireRateLimiting("command");
        }
    }
}
