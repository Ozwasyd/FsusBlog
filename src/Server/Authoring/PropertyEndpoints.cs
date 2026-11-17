using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Server.Authoring;

internal static class PropertyEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame,
        Func<HttpContext, string, int, string?> query)
    {
        Map(WireRoutes.PropertyWorkspace, async (store, frame, ct) =>
            Wire.EncodePropertyWorkspace(await store.Read(Wire.DecodePropertyWorkspaceRequest(frame), ct)));
        Map(WireRoutes.PropertyDefinitionCommand, async (store, frame, ct) =>
            Wire.EncodePropertyCommandReceipt(await store.Change(Wire.DecodePropertyDefinitionCommand(frame), ct)));
        Map(WireRoutes.PropertyTextCommand, async (store, frame, ct) =>
            Wire.EncodePropertyCommandReceipt(await store.WriteText(Wire.DecodePropertyTextCommand(frame), ct)));
        MapSession(WireRoutes.PropertyEditor, async (store, actor, ctx, frame, session, ct) =>
        {
            Aeds.Decode(frame, out var type);
            if (type != FrameType.PropertyTextHitRequest)
                return Wire.EncodePropertyEditor(await store.ReadEditor(Wire.DecodePropertyWorkspaceRequest(frame), kind: null, ct));
            var expected = SiteSessions.Requested(ctx);
            var digest = Store.TokenDigest(session)!;
            SiteSessions.RequireCurrent(actor.Id, digest, expected);
            var page = await store.ReadTextHit(Wire.DecodePropertyTextHitRequest(frame), ct);
            ct.ThrowIfCancellationRequested();
            SiteSessions.RequireCurrent(actor.Id, digest, expected);
            return Wire.EncodePropertyEditor(page);
        });
        Map(WireRoutes.PropertySchemaCommand, async (store, frame, ct) =>
        {
            Aeds.Decode(frame, out var type);
            var receipt = type == FrameType.PropertyDefinitionProjectionCommand
                ? await store.Change(Wire.DecodePropertyDefinitionProjectionCommand(frame), ct)
                : await store.Change(Wire.DecodePropertySchemaInput(frame), textOnly: false, ct);
            return Wire.EncodePropertyCommandReceipt(receipt);
        });
        MapSession(WireRoutes.PropertyValueCommand, async (store, actor, ctx, frame, session, ct) =>
        {
            Aeds.Decode(frame, out var type);
            if (type != FrameType.PropertyValueBatchCommand)
            {
                if (frame.Length > WireLimits.PropertyMaxCommandBytes)
                    throw new BusinessException(Rejection.Invalid, "Invalid article property.");
                return Wire.EncodePropertyCommandReceipt(await store.Write(Wire.DecodePropertyValueInput(frame), textOnly: false, frame, ct));
            }
            var expected = SiteSessions.Requested(ctx);
            SiteSessions.IfCurrent(actor.Id, session, expected);
            var rebuild = ctx.RequestServices.GetRequiredService<AuthorTextRebuildWorker>();
            var receipt = await store.WriteBatch(Wire.DecodePropertyValueBatch(frame), frame, rebuild.Queue, actor, ct);
            ct.ThrowIfCancellationRequested();
            SiteSessions.IfCurrent(actor.Id, session, expected);
            return Wire.EncodePropertyValueBatchReceipt(receipt);
        }, WireLimits.PropertyBatchMaxCommandBytes);
        Map(WireRoutes.PropertyFilterability, async (store, frame, ct) =>
            Wire.EncodePropertyCommandReceipt(await store.SetFilterable(Wire.DecodePropertyFilterabilityCommand(frame), ct)));

        app.MapGet(WireRoutes.PropertySchemaCommand, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            if (!Guid.TryParseExact(query(ctx, "definition", 36), "D", out var id) || id == Guid.Empty)
                throw new BusinessException(Rejection.Invalid, "Invalid property definition.");
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Results.Bytes(Wire.EncodePropertyDefinitionProjection(await new PropertyStore(db, tx, actor).ReadProjection(id, ct)),
                    Aeds.ContentType), ct);
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.PropertyFilterCatalog, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[cookie];
            var projection = query(ctx, "projection", 1) switch
            {
                null => false,
                "1" => true,
                _ => throw new BusinessException(Rejection.Invalid, "Invalid property catalog mode."),
            };
            var expected = SiteSessions.Requested(ctx) ?? (projection ? "" : null);
            var after = query(ctx, "after", WireLimits.PropertyKeyBytes);
            var schema = query(ctx, "schema", 19);
            long version = 0;
            if (after is not null && (after.Length == 0 ||
                !long.TryParse(schema, NumberStyles.None, CultureInfo.InvariantCulture, out version) || version <= 0) ||
                after is null && schema is not null)
                throw new BusinessException(Rejection.Invalid, "Invalid property catalog page.");
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.IfCurrent(actor.Id, token, expected);
                var properties = new PropertyStore(db, tx, actor);
                var catalog = projection ? Wire.EncodePropertyProjectionCatalog(await properties.ProjectionCatalog(after, version, ct))
                    : Wire.EncodePropertyFilterCatalog(await properties.Catalog(after, version, ct));
                ct.ThrowIfCancellationRequested();
                SiteSessions.IfCurrent(actor.Id, token, expected);
                return Results.Bytes(catalog, Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");
        MapSession(WireRoutes.PropertyArticleQuery, async (store, actor, ctx, frame, session, ct) =>
        {
            var input = Wire.DecodePropertyArticleQueryGroup(frame);
            if (input.Keyword.Length != 0)
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(session)!, SiteSessions.Requested(ctx));
            return Wire.EncodePropertyArticlePage(await store.Filter(input, session, ct));
        }, WireLimits.PropertyKeywordQueryFrameBytes);

        void Map(string path, Func<PropertyStore, byte[], CancellationToken, Task<byte[]>> operation) =>
            MapSession(path, (store, _, _, frame, _, ct) => operation(store, frame, ct));

        void MapSession(string path, Func<PropertyStore, Identity, HttpContext, byte[], string, CancellationToken, Task<byte[]>> operation,
            int frameBytes = WireLimits.PropertyMaxCommandBytes)
        {
            app.MapPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
            {
                var frame = await readFrame(ctx, frameBytes, ct);
                var session = ctx.Request.Cookies[cookie];
                try
                {
                    var result = await store.WithSession(session, true,
                        (db, tx, actor) => operation(new PropertyStore(db, tx, actor), actor, ctx, frame, session!, ct), ct);
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
