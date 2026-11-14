using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentReadEndpoints
{
    internal static void Map(WebApplication app, Publications publications, string cookie,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.CommentRoots, (HttpContext ctx, CommentReadStore store, int articleId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Roots(articleId, cursor, Limit(ctx, 10, 50), ct),
                () => CommentReadWire.Roots([], null))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentChildren, (HttpContext ctx, CommentReadStore store, int articleId, long parentId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Children(articleId, parentId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Children(parentId, 0, [], null))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentContext, (HttpContext ctx, CommentReadStore store, int articleId, long commentId, int? window, CancellationToken ct) =>
            Read(publications, articleId, null, _ => store.Context(articleId, commentId, Math.Clamp(window ?? 6, 2, 20), ct),
                () => CommentReadWire.Context(null, [], []))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentThread, (HttpContext ctx, CommentReadStore store, int articleId, long rootId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Thread(articleId, rootId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Thread(rootId, [], null))).RequireRateLimiting("query");

        if (app.Configuration.GetValue("FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS", false))
        {
            app.MapGet(WireRoutes.PublicCommentEligibility, async (HttpContext ctx, int articleId, Store store, CancellationToken ct) =>
            {
                if (!long.TryParse(ctx.Request.Query["publication"].FirstOrDefault(), NumberStyles.None,
                    CultureInfo.InvariantCulture, out var publication) || publication <= 0)
                    throw new BusinessException(Rejection.Invalid, "A valid publication is required.");
                var result = await store.WithSession(ctx.Request.Cookies[cookie], false,
                    (db, tx, actor) => CommentWriteStore.Eligibility(db, tx, actor, articleId, publication, ct), ct);
                return Results.Bytes(Wire.EncodePublicCommentEligibility(result), Aeds.ContentType);
            }).RequireRateLimiting("command");
            app.MapPost(WireRoutes.PublicCommentPowChallenge, (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) =>
                ScopedPow.Protect(ctx, async () =>
                {
                    var (frame, input) = await ReadSubmission(ctx, ct);
                    var session = ctx.Request.Cookies[cookie];
                    var source = ScopedPow.Source(ctx);
                    var nonce = ScopedPow.ReadClientNonce(ctx);
                    var challenge = await store.WithSession(session, false, async (db, tx, actor) =>
                    {
                        await CommentWriteStore.AdmitChallenge(db, tx, actor, input, ct);
                        return pow.Issue(PowScope.PublicCommentSubmit, "", session!, source, nonce, frame);
                    }, ct);
                    return PowWire.EncodeChallenge(challenge);
                })).RequireRateLimiting("command");
            app.MapPost(WireRoutes.SubmitPublicComment, (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) =>
                ScopedPow.Protect(ctx, async () =>
                {
                    var (frame, input) = await ReadSubmission(ctx, ct);
                    var session = ctx.Request.Cookies[cookie];
                    var source = ScopedPow.Source(ctx);
                    var receipt = await store.WithSession(session, false, async (db, tx, actor) =>
                    {
                        await pow.Consume(db, tx, PowScope.PublicCommentSubmit, "", session!, source, frame, ScopedPow.ReadProof(ctx), ct);
                        return await CommentWriteStore.Submit(db, tx, actor, input, ct);
                    }, ct);
                    return Wire.EncodePublicCommentSubmissionResult(receipt);
                })).RequireRateLimiting("command");

            async Task<(byte[] Frame, PublicCommentSubmission Input)> ReadSubmission(HttpContext ctx, CancellationToken ct)
            {
                var frame = await readFrame(ctx, WireLimits.PublicCommentFrameBytes, ct);
                var input = Wire.DecodePublicCommentSubmission(frame);
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) || header.Count != 1 ||
                    !Guid.TryParseExact(header[0], "D", out var key) || input.IdempotencyKey != key)
                    throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
                return (frame, input);
            }
        }
    }

    private static async Task<IResult> Read(Publications publications, int article, long? cursor, Func<long?, Task<byte[]>> fetch, Func<byte[]> hidden)
    {
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var bytes = snapshot.Article(article) is not null ? await fetch(cursor) : hidden();
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        return Results.Bytes(bytes, Aeds.ContentType);
    }

    private static long? Cursor(HttpContext ctx)
    {
        if (!ctx.Request.Query.TryGetValue("cursor", out var values)) return null;
        if (values.Count == 1)
        {
            if (string.IsNullOrWhiteSpace(values[0])) return null;
            if (values[0] is { Length: <= 24 } value &&
                long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var cursor) && cursor > 0)
                return cursor;
        }
        throw new BusinessException(Rejection.Invalid, "Invalid comment cursor.");
    }

    private static int Limit(HttpContext ctx, int fallback, int max) =>
        int.TryParse(ctx.Request.Query["limit"].FirstOrDefault(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var count)
            ? Math.Clamp(count, 5, max)
            : fallback;
}
