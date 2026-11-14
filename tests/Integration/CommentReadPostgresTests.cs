using System.Buffers.Binary;
using System.Net;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Comments;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CommentReadPostgresTests
{
    private const long Start = 9007199254740993;
    private const string VisibleBody = "Visible public text 独立";
    private const string VisibleAuthor = "Public Display Name";
    private static readonly string[] PrivateText = ["hidden private", "private author", "pending text", "deleted body", "regional secret", "private article body"];

    [PostgresFact]
    public async Task PublicFramesExposeOnlyApprovedVisibleTextAndBoundedTreeRelations()
    {
        using var time = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = time.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await Seed(fixture, ct);
        var read = new CommentReadStore(fixture.DataSource);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var rootFrame = await read.Roots(1, null, 5, ct);
        var roots = Payload(rootFrame, FrameType.CommentTreeRootCursor);
        Assert.Equal(2, Read32(roots, 9));
        Assert.Equal(Start + 13, Read64(roots, 13));
        var hiddenRoot = NextNode(roots, 13) + 4;
        Assert.Equal(Start + 1, Read64(roots, hiddenRoot));
        Assert.Equal(1, roots[hiddenRoot + 40]);
        Assert.Equal(Start + 2, Read64(roots, NextNode(roots, hiddenRoot) + 4));
        Assert.Contains(VisibleBody, Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);
        Assert.Contains(VisibleAuthor, Encoding.UTF8.GetString(rootFrame), StringComparison.Ordinal);

        var childrenFrame = await read.Children(1, Start + 1, null, 5, ct);
        var children = Payload(childrenFrame, FrameType.CommentChildCursor);
        Assert.Equal(Start + 1, Read64(children, 8));
        Assert.Equal(5, Read32(children, 24));
        Assert.Equal(Start + 6, Read64(children, 16));
        Assert.Equal(Start + 2, Read64(children, 32));
        var next = Payload(await read.Children(1, Start + 1, Start + 6, 5, ct), FrameType.CommentChildCursor);
        Assert.Equal(1, Read32(next, 24));
        Assert.Equal(0, Read64(next, 16));
        Assert.Equal(Start + 7, Read64(next, 32));
        var grandchild = Payload(await read.Children(1, Start + 2, null, 5, ct), FrameType.CommentChildCursor);
        Assert.Equal(1, Read32(grandchild, 24));
        Assert.Equal(Start + 8, Read64(grandchild, 32));

        var contextFrame = await read.Context(1, Start + 3, 2, ct);
        var context = Payload(contextFrame, FrameType.CommentPermalinkContext);
        Assert.Equal(Start + 3, Read64(context, 0));
        Assert.Equal(Start + 1, Read64(context, 8));
        Assert.Equal(1, Read32(context, 16));
        Assert.Equal(2, Read32(context, 20));
        Assert.Equal(1, context[32 + 40]); // A hidden ancestor is a redacted structural tombstone.
        Assert.Equal(Start + 3, Read64(context, NextNode(context, 32)));

        var unavailable = await read.Context(1, Start + 99, 6, ct);
        Assert.Equal(32, Payload(unavailable, FrameType.CommentPermalinkContext).Length);
        foreach (var id in new[] { Start + 1, Start + 9, Start + 10, Start + 11 })
            Assert.Equal(unavailable, await read.Context(1, id, 6, ct));
        Assert.Equal(unavailable, await read.Context(2, Start + 12, 6, ct));
        Assert.Equal(unavailable, await read.Context(1, Start + 12, 6, ct));

        var thread = await read.Thread(1, Start + 1, null, 20, ct);
        Assert.Equal(7, Read32(Payload(thread, FrameType.CommentThreadReplyCursor), 17));
        foreach (var (path, frame) in new[]
        {
            ("/api/binary/comment/1?limit=5", rootFrame),
            ($"/api/binary/comment/1/children/{Start + 1}?limit=5", childrenFrame),
            ($"/api/binary/comment/1/context/{Start + 3}?window=2", contextFrame),
            ($"/api/binary/comment/1/thread/{Start + 1}", thread),
            ($"/api/binary/comment/2/context/{Start + 12}", unavailable),
        })
        {
            using var response = await server.Client.GetAsync(path, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(frame, await response.Content.ReadAsByteArrayAsync(ct));
        }
        foreach (var frame in new[] { rootFrame, childrenFrame, contextFrame, thread, unavailable })
            foreach (var text in PrivateText)
                Assert.DoesNotContain(text, Encoding.UTF8.GetString(frame), StringComparison.Ordinal);
        var noPublic = Payload(await read.Roots(2, null, 10, ct), FrameType.CommentTreeRootCursor);
        Assert.Equal(0, Read32(noPublic, 9));

        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var withdraw = Store.Sql(connection, null, "update public.article set published_revision=null where id=1"))
            await withdraw.ExecuteNonQueryAsync(ct);
        Assert.Equal(unavailable, await read.Context(1, Start + 3, 6, ct));
        Assert.Equal(0, Read32(Payload(await read.Roots(1, null, 10, ct), FrameType.CommentTreeRootCursor), 9));
        Assert.Equal(unavailable, await server.Client.GetByteArrayAsync($"/api/binary/comment/1/context/{Start + 3}", ct));
    }

    private static async Task Seed(ScratchDatabase fixture, CancellationToken ct)
    {
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        await using var setup = Store.Sql(db, tx, """
            insert into public.blog_user(id,name,can_author,enabled,generation)
            values ('87dead9a-1591-4eae-846c-0192aaeeccca','comment fixture',true,true,1);
            insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted)
            overriding system value values
            (1,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'visible article','text',1,1,false),
            (2,'87dead9a-1591-4eae-846c-0192aaeeccca',1,'private article','text',null,0,false);
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            values (1,1,'visible article','text',now()),(2,1,'private article','text',now());
            insert into public.article_publication(article_id,revision,published_at) values (1,1,now());
            """);
        await setup.ExecuteNonQueryAsync(ct);

        await Add(1, 0, null, 0, 0); // Unattached pending root is completely absent.
        await Add(1, 1, null, 1, 3, body: "hidden private", author: "private author");
        for (var index = 2; index <= 7; index++)
            await Add(1, index, 1, 1, 1, replyTo: 1, body: index == 3 ? VisibleBody : "child comment");
        await Add(1, 8, 2, 1, 1, depth: 2, body: "public grandchild");
        await Add(1, 9, 1, 1, 0, body: "pending text");
        await Add(1, 10, 1, 1, 1, deleted: true, body: "deleted body");
        await Add(1, 11, 1, 1, 1, body: "regional secret");
        await Add(2, 12, null, 12, 1, body: "private article body");
        await Add(1, 13, null, 13, 1, body: "public root");
        await using var block = Store.Sql(db, tx, "insert into public.comment_blocked_region values (1,$1,'CN')", Start + 11);
        await block.ExecuteNonQueryAsync(ct);
        await tx.CommitAsync(ct);

        async Task Add(int article, int id, int? parent, int root, short status, int depth = 1,
            bool deleted = false, int? replyTo = null, string body = "comment", string author = VisibleAuthor)
        {
            await using var command = Store.Sql(db, tx, """
                insert into public.comment(article_id,id,parent_id,root_id,parent_depth,reply_to_id,depth,moderation_status,deleted,
                    body,author_mode,display_name,display_language,created_at)
                values ($1,$2,nullif($3,0),$4,nullif($5,-1),nullif($6,0),$7,$8,$9,$10,3,$11,'en',now())
                """, article, Start + id, parent is { } p ? Start + p : 0L, Start + root, parent.HasValue ? depth - 1 : -1,
                    replyTo is { } r ? Start + r : 0L, parent.HasValue ? depth : 0, status, deleted, body, author);
            await command.ExecuteNonQueryAsync(ct);
        }
    }

    private static byte[] Payload(byte[] body, FrameType type) => Aeds.Decode(body, type).ToArray();
    private static int Read32(byte[] bytes, int offset) => BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset));
    private static long Read64(byte[] bytes, int offset) => BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(offset));
    private static int NextNode(byte[] bytes, int offset) => offset + 64 + Read32(bytes, offset + 60);
}
