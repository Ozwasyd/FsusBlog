using System.Buffers;
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
    public static byte[] Roots(IReadOnlyList<CommentRoot> rows, long? next)
    {
        var writer = new Writer();
        writer.Cursor(next, rows.Count);
        foreach (var root in rows)
        {
            writer.Node(root.Node);
            writer.I32(root.Children.Count);
            foreach (var child in root.Children) writer.Node(child);
        }
        return writer.Frame(FrameType.CommentTreeRootCursor);
    }

    public static byte[] Children(long parentId, long rootId, IReadOnlyList<CommentNode> rows, long? next)
    {
        var writer = new Writer();
        writer.I64(parentId);
        writer.I64(rootId);
        writer.I64(next ?? 0);
        writer.I32(rows.Count);
        writer.I32(next.HasValue ? 1 : 0);
        foreach (var row in rows) writer.Node(row);
        return writer.Frame(FrameType.CommentChildCursor);
    }

    public static byte[] Context(CommentNode? target, IReadOnlyList<CommentNode> ancestors, IReadOnlyList<CommentNode> siblings,
        bool previous = false, bool next = false)
    {
        var writer = new Writer();
        writer.I64(target?.Id ?? 0);
        writer.I64(target?.RootId ?? 0);
        writer.I32(ancestors.Count);
        writer.I32(siblings.Count);
        writer.Flag(target is null);
        writer.Flag(target is not null);
        writer.Flag(previous);
        writer.Flag(next);
        writer.I32(0);
        foreach (var ancestor in ancestors) writer.Node(ancestor);
        if (target is not null) writer.Node(target);
        foreach (var sibling in siblings) writer.Node(sibling);
        return writer.Frame(FrameType.CommentPermalinkContext);
    }

    public static byte[] Thread(long rootId, IReadOnlyList<CommentNode> rows, long? next)
    {
        var writer = new Writer();
        writer.I64(rootId);
        writer.Cursor(next, rows.Count);
        foreach (var row in rows) writer.Node(row, flatReply: true);
        return writer.Frame(FrameType.CommentThreadReplyCursor);
    }

    private sealed class Writer
    {
        private static readonly UTF8Encoding Utf8 = new(false, true);
        private readonly ArrayBufferWriter<byte> buffer = new();

        internal byte[] Frame(FrameType type) => Aeds.Encode(type, buffer.WrittenSpan);
        internal void I64(long value)
        {
            BinaryPrimitives.WriteInt64LittleEndian(buffer.GetSpan(8), value);
            buffer.Advance(8);
        }
        internal void I32(int value)
        {
            BinaryPrimitives.WriteInt32LittleEndian(buffer.GetSpan(4), value);
            buffer.Advance(4);
        }
        internal void Flag(bool value) => Byte(value ? (byte)1 : (byte)0);
        private void Byte(byte value)
        {
            buffer.GetSpan(1)[0] = value;
            buffer.Advance(1);
        }
        internal void Cursor(long? next, int count)
        {
            I64(next ?? 0);
            Flag(next.HasValue);
            I32(count);
        }
        internal void Node(CommentNode node, bool flatReply = false)
        {
            var content = Utf8.GetBytes(node.Content);
            var author = Author(node.Author);
            var reply = node.ReplyToAuthor is { } view ? Author(view) : [];
            I64(node.Id);
            I64(node.ParentId ?? 0);
            I64(node.RootId);
            if (flatReply) I32(0); // Retired reply-to-user field.
            I64(node.ReplyToId ?? 0);
            I32(node.Depth);
            if (!flatReply) I32(node.ChildCount);
            Flag(node.IsDeleted);
            Flag(!flatReply && node.HasMoreChildren);
            Flag(node.IsEdited);
            Byte(0);
            I64(node.CreatedAt.ToUnixTimeMilliseconds());
            I32(0);
            I32(content.Length);
            I32(content.Length + author.Length + reply.Length + 8);
            buffer.Write(content);
            I32(author.Length);
            buffer.Write(author);
            I32(reply.Length);
            buffer.Write(reply);
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
}
