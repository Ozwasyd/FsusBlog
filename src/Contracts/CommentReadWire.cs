using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public enum CommentAuthorMode : byte { LegacyPseudonymous = 1, Public = 3, ZkAnonymous = 4 }

public sealed record CommentAuthor(CommentAuthorMode Mode, string DisplayName, string DisplayLanguage, string? ScopeLabel = null);

public sealed record CommentNode(long Id, long? ParentId, long RootId, long? ReplyToId, int Depth, int ChildCount,
    bool IsDeleted, bool HasMoreChildren, DateTimeOffset CreatedAt, string Content,
    CommentAuthor Author, CommentAuthor? ReplyToAuthor = null, bool IsEdited = false);

public sealed record CommentRoot(CommentNode Node, IReadOnlyList<CommentNode> Children);

public static class CommentReadWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] Roots(IReadOnlyList<CommentRoot> rows, long? next)
    {
        var writer = WriteCursor(new Wire.Writer(), next, rows.Count);
        foreach (var root in rows)
        {
            WriteNode(writer, root.Node);
            writer.Items(root.Children, static (w, child) => WriteNode(w, child));
        }
        return Aeds.Encode(FrameType.CommentTreeRootCursor, writer.Written);
    }

    public static byte[] Children(long parentId, long rootId, IReadOnlyList<CommentNode> rows, long? next)
    {
        var writer = new Wire.Writer().I64(parentId).I64(rootId).I64(next ?? 0).I32(rows.Count).I32(next.HasValue ? 1 : 0);
        foreach (var row in rows) WriteNode(writer, row);
        return Aeds.Encode(FrameType.CommentChildCursor, writer.Written);
    }

    public static byte[] Context(CommentNode? target, IReadOnlyList<CommentNode> ancestors, IReadOnlyList<CommentNode> siblings,
        bool previous = false, bool next = false)
    {
        var writer = new Wire.Writer().I64(target?.Id ?? 0).I64(target?.RootId ?? 0).I32(ancestors.Count).I32(siblings.Count)
            .Bool(target is null).Bool(target is not null).Bool(previous).Bool(next).I32(0);
        foreach (var ancestor in ancestors) WriteNode(writer, ancestor);
        if (target is not null) WriteNode(writer, target);
        foreach (var sibling in siblings) WriteNode(writer, sibling);
        return Aeds.Encode(FrameType.CommentPermalinkContext, writer.Written);
    }

    public static byte[] Thread(long rootId, IReadOnlyList<CommentNode> rows, long? next)
    {
        var writer = WriteCursor(new Wire.Writer().I64(rootId), next, rows.Count);
        foreach (var row in rows) WriteNode(writer, row, flatReply: true);
        return Aeds.Encode(FrameType.CommentThreadReplyCursor, writer.Written);
    }

    private static Wire.Writer WriteCursor(Wire.Writer writer, long? next, int count) =>
        writer.I64(next ?? 0).Bool(next.HasValue).I32(count);

    private static void WriteNode(Wire.Writer writer, CommentNode node, bool flatReply = false)
    {
        var content = Utf8.GetBytes(node.Content);
        var author = Author(node.Author);
        var reply = node.ReplyToAuthor is { } view ? Author(view) : [];
        writer.I64(node.Id).I64(node.ParentId ?? 0).I64(node.RootId);
        if (flatReply) writer.I32(0); // Retired reply-to-user field.
        writer.I64(node.ReplyToId ?? 0).I32(node.Depth);
        if (!flatReply) writer.I32(node.ChildCount);
        writer.Bool(node.IsDeleted).Bool(!flatReply && node.HasMoreChildren).Bool(node.IsEdited).Byte(0)
            .I64(node.CreatedAt.ToUnixTimeMilliseconds()).I32(0).I32(content.Length)
            .I32(content.Length + author.Length + reply.Length + 8)
            .FixedBytes(content).Bytes(author).Bytes(reply);
    }

    private static byte[] Author(CommentAuthor author)
    {
        string[] strings = [author.DisplayName, author.DisplayLanguage, "", author.ScopeLabel ?? ""];
        var bytes = new byte[36 + strings.Sum(Utf8.GetByteCount)];
        bytes[0] = (byte)author.Mode;
        var offset = 0;
        for (var index = 0; index < strings.Length; index++)
        {
            var length = Utf8.GetBytes(strings[index], bytes.AsSpan(36 + offset));
            var field = bytes.AsSpan(4 + index * 8);
            BinaryPrimitives.WriteInt32LittleEndian(field, offset);
            BinaryPrimitives.WriteInt32LittleEndian(field[4..], length);
            offset += length;
        }
        return bytes;
    }
}
