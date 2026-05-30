using FsusBlog.Server.Infrastructure.Pagination;

namespace FsusBlog.Server.Services;

public static class CommentCursorPolicies
{
    public static readonly CursorPolicy Threads = new(10, 5, 50);
    public static readonly CursorPolicy Replies = new(20, 5, 100);
    public static readonly CursorPolicy UserComments = new(10, 5, 50);
}
