using FsusBlog.V2.Contracts;

internal static class CommentReadVectors
{
    internal static void Run(string fixtures)
    {
        const long rootId = 9007199254740993;
        var publicAuthor = new CommentAuthor(CommentAuthorMode.Public, "Writer", "en");
        var anonymous = new CommentAuthor(CommentAuthorMode.ZkAnonymous, "匿名角色", "zh-CN", "some scope");
        var time = DateTimeOffset.FromUnixTimeMilliseconds(1700000000000);
        var root = new CommentNode(rootId, null, rootId, null, 0, 1, false, false, time, "Root fixture", publicAuthor, IsEdited: true);
        var reply = new CommentNode(rootId + 1, rootId, rootId, rootId, 1, 0, false, false, time,
            "Visible reply 独立", anonymous, publicAuthor);
        Check("root", CommentReadWire.Roots([new(root, [reply])], null));
        Check("children", CommentReadWire.Children(rootId, rootId, [reply], null));
        Check("context", CommentReadWire.Context(reply, [root], []));
        return;

        void Check(string label, byte[] actual)
        {
            var path = Path.Combine(fixtures, $"comment-{label}-current.hex");
            var expected = Convert.FromHexString(File.ReadAllText(path).Trim());
            if (!actual.AsSpan().SequenceEqual(expected))
                throw new InvalidOperationException($"Comment {label} wire bytes differ from the independent vector.");
        }
    }
}
