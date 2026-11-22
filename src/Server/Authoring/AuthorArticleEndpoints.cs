using System.Buffers.Binary;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorArticleEndpoints
{
    internal static void Map(WebApplication app, string authorCookie, Publications publications)
    {
        app.MapCommandGet(WireRoutes.Draft, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[authorCookie];
            var expected = SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.IfCurrent(actor.Id, token, expected);
                return ServerHttp.DraftResponse(await Store.Find(db, tx, actor, id, false, ct));
            }, ct);
        });

        MapMutation(app, authorCookie, publications, WireRoutes.Save, ArticleAction.Save);
        MapMutation(app, authorCookie, publications, WireRoutes.Publish, ArticleAction.Publish);
        MapMutation(app, authorCookie, publications, WireRoutes.Retract, ArticleAction.Retract);
        MapMutation(app, authorCookie, publications, WireRoutes.Delete, ArticleAction.Delete);
        MapMutation(app, authorCookie, publications, WireRoutes.Restore, ArticleAction.Restore);
    }

    private static void MapMutation(WebApplication app, string authorCookie, Publications publications, string path, ArticleAction action)
    {
        app.MapCommandPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var frame = await ServerHttp.ReadFrame(ctx, action == ArticleAction.Save ? WireLimits.MaxArticleBodyEditsCommandFrameBytes :
                WireLimits.MaxCommandFrameBytes, ct);
            var type = action == ArticleAction.Save && frame.Length >= WireHeader.HeaderSize
                ? (FrameType)BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(WireHeader.TypeOffset)) : FrameType.ArticleCommand;
            var insertion = type == FrameType.ArticleBodyInsertionCommand ? Wire.DecodeArticleBodyInsertionCommand(frame) : null;
            var insertions = type == FrameType.ArticleBodyInsertionsCommand ? Wire.DecodeArticleBodyInsertionsCommand(frame) : null;
            var bodyEdits = type == FrameType.ArticleBodyEditsCommand ? Wire.DecodeArticleBodyEditsCommand(frame) : null;
            var input = (bodyEdits, insertions, insertion) switch
            {
                ({ } edited, _, _) => new ArticleCommand(edited.Id, edited.ExpectedRevision, edited.IdempotencyKey, edited.Title, edited.Body),
                (_, { } many, _) => new ArticleCommand(many.Id, many.ExpectedRevision, many.IdempotencyKey, many.Title, many.Body),
                (_, _, { } one) => new ArticleCommand(one.Id, one.ExpectedRevision, one.IdempotencyKey, one.Title, one.Body),
                _ => Wire.DecodeArticleCommand(frame),
            };
            if (!ClientMutationHeader.Matches(ctx, input.IdempotencyKey))
                return ServerHttp.Error(ctx, 400, ClientMutationHeader.Mismatch);
            var edit = Publishing.Validate(action, new(input.Id, input.ExpectedRevision, input.IdempotencyKey, input.Title, input.Body));
            var result = await publications.Command(store, ctx.Request.Cookies[authorCookie], action, edit, ct,
                SiteSessions.Requested(ctx), insertion, insertions, bodyEdits);
            return action == ArticleAction.Delete
                ? Results.Bytes(Wire.EncodeEmptySuccess(), ServerHttp.BinaryContentType)
                : ServerHttp.DraftResponse(result.Article);
        });
    }
}
