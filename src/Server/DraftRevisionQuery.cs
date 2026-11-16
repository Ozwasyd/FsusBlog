using System.Globalization;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server;

internal static class DraftRevisionQuery
{
    internal static long Read(HttpContext context, int id, Func<HttpContext, string, int, string?> query) =>
        Read(id > 0 ? query(context, "revision", 19) : null);

    internal static long Read(string? text) =>
        long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var revision) && revision > 0
            ? revision : throw new BusinessException(Rejection.Invalid, "A valid draft revision is required.");
}
