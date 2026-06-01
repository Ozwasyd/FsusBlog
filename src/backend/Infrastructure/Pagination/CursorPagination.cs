using FsusBlog.Core.Mapping.Models;
using Microsoft.AspNetCore.Http;
using System.Globalization;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Pagination;

public readonly record struct CursorPolicy(
    int DefaultLimit,
    int MinLimit,
    int MaxLimit,
    string CursorKey = "cursor",
    string LimitKey = "limit")
{
    public int NormalizeLimit(int? requested)
    {
        int value = requested ?? DefaultLimit;
        if (value < MinLimit)
        {
            return MinLimit;
        }

        return value > MaxLimit ? MaxLimit : value;
    }
}

public readonly record struct CursorPageRequest<TCursor>(string? RawCursor, TCursor? Cursor, int Limit)
    where TCursor : struct;

public sealed record CursorEnvelope<TCursor, TItem>
    where TCursor : struct
{
    public List<TItem> Data { get; init; } = [];
    public TCursor? NextCursor { get; init; }
    public bool HasMore { get; init; }
}

public sealed record CursorWindow<TItem>
{
    public List<TItem> Data { get; init; } = [];
    public string? NextCursor { get; init; }
    public bool HasMore { get; init; }
}

public interface ICursorCodec<TCursor>
    where TCursor : struct
{
    bool TryParse(string raw, out TCursor value);
    string Format(TCursor value);
}

public sealed class Int64CursorCodec : ICursorCodec<long>
{
    public static Int64CursorCodec Instance { get; } = new();

    private Int64CursorCodec()
    {
    }

    public bool TryParse(string raw, out long value)
        => long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value > 0;

    public string Format(long value)
        => value.ToString(CultureInfo.InvariantCulture);
}

public readonly record struct CursorBindResult<TCursor>(bool IsSuccess, CursorPageRequest<TCursor> Request, string? ErrorMessage)
    where TCursor : struct;

public static class CursorPageBinder
{
    public static CursorBindResult<TCursor> Bind<TCursor>(HttpRequest request, CursorPolicy policy, ICursorCodec<TCursor> codec)
        where TCursor : struct
    {
        string? rawCursor = request.Query[policy.CursorKey].FirstOrDefault();
        int? requestedLimit = TryReadLimit(request.Query[policy.LimitKey].FirstOrDefault());
        int normalizedLimit = policy.NormalizeLimit(requestedLimit);

        if (string.IsNullOrWhiteSpace(rawCursor))
        {
            return new CursorBindResult<TCursor>(true, new CursorPageRequest<TCursor>(null, null, normalizedLimit), null);
        }

        if (!codec.TryParse(rawCursor, out TCursor cursor))
        {
            return new CursorBindResult<TCursor>(
                false,
                new CursorPageRequest<TCursor>(rawCursor, null, normalizedLimit),
                $"查询参数 `{policy.CursorKey}` 非法");
        }

        return new CursorBindResult<TCursor>(true, new CursorPageRequest<TCursor>(rawCursor, cursor, normalizedLimit), null);
    }

    private static int? TryReadLimit(string? raw)
        => int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ? value : null;
}

public static class CursorPagination
{
    public static int WindowCount<TSource>(IReadOnlyList<TSource> rows, int limit)
    {
        int safeLimit = Math.Max(limit, 1);
        return rows.Count > safeLimit ? safeLimit : rows.Count;
    }

    public static CursorEnvelope<TCursor, TSource> Slice<TCursor, TSource>(
        IReadOnlyList<TSource> rows,
        int limit,
        Func<TSource, TCursor> cursorSelector)
        where TCursor : struct
    {
        int safeLimit = Math.Max(limit, 1);
        bool hasMore = rows.Count > safeLimit;
        int count = hasMore ? safeLimit : rows.Count;
        var data = new List<TSource>(count);
        for (int i = 0; i < count; i++)
        {
            data.Add(rows[i]);
        }

        TCursor? nextCursor = hasMore && count > 0 ? cursorSelector(rows[count - 1]) : null;
        return new CursorEnvelope<TCursor, TSource>
        {
            Data = data,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
    }

    public static CursorResponse<TTarget> SliceMapToResponse<TCursor, TSource, TTarget>(
        IReadOnlyList<TSource> rows,
        int limit,
        Func<TSource, TCursor> cursorSelector,
        Func<TSource, TTarget> map,
        ICursorCodec<TCursor> codec)
        where TCursor : struct
    {
        int safeLimit = Math.Max(limit, 1);
        bool hasMore = rows.Count > safeLimit;
        int count = hasMore ? safeLimit : rows.Count;
        var data = new List<TTarget>(count);
        for (int i = 0; i < count; i++)
        {
            data.Add(map(rows[i]));
        }

        TCursor? nextCursor = hasMore && count > 0 ? cursorSelector(rows[count - 1]) : null;
        return new CursorResponse<TTarget>
        {
            Data = data,
            NextCursor = nextCursor.HasValue ? codec.Format(nextCursor.Value) : null,
            HasMore = hasMore
        };
    }

    public static CursorEnvelope<TCursor, TTarget> Map<TCursor, TSource, TTarget>(
        CursorEnvelope<TCursor, TSource> source,
        Func<TSource, TTarget> map)
        where TCursor : struct
        => new()
        {
            Data = source.Data.Select(map).ToList(),
            NextCursor = source.NextCursor,
            HasMore = source.HasMore
        };

    public static async Task<CursorEnvelope<TCursor, TTarget>> MapAsync<TCursor, TSource, TTarget>(
        CursorEnvelope<TCursor, TSource> source,
        Func<TSource, Task<TTarget>> map)
        where TCursor : struct
    {
        var data = new List<TTarget>(source.Data.Count);
        foreach (TSource item in source.Data)
        {
            data.Add(await map(item));
        }

        return new CursorEnvelope<TCursor, TTarget>
        {
            Data = data,
            NextCursor = source.NextCursor,
            HasMore = source.HasMore
        };
    }

    public static CursorResponse<TItem> ToResponse<TCursor, TItem>(
        CursorEnvelope<TCursor, TItem> source,
        ICursorCodec<TCursor> codec)
        where TCursor : struct
        => new()
        {
            Data = source.Data,
            NextCursor = source.NextCursor.HasValue ? codec.Format(source.NextCursor.Value) : null,
            HasMore = source.HasMore
        };

    public static CursorWindow<TItem> ToWindow<TCursor, TItem>(
        CursorEnvelope<TCursor, TItem> source,
        ICursorCodec<TCursor> codec)
        where TCursor : struct
        => new()
        {
            Data = source.Data,
            NextCursor = source.NextCursor.HasValue ? codec.Format(source.NextCursor.Value) : null,
            HasMore = source.HasMore
        };
}

public static class CursorInterop
{
    public static CursorResponse<TTarget> FromCore<TSource, TTarget>(
        CoreCursorResult<TSource> source,
        Func<TSource, TTarget> map,
        ICursorCodec<long> codec)
        => new()
        {
            Data = source.Data.Select(map).ToList(),
            NextCursor = source.NextCursor.HasValue ? codec.Format(source.NextCursor.Value) : null,
            HasMore = source.HasMore
        };

    public static CoreCursorResult<TTarget> ToCore<TSource, TTarget>(
        CursorResponse<TSource> source,
        Func<TSource, TTarget> map,
        ICursorCodec<long> codec)
    {
        long? nextCursor = null;
        if (!string.IsNullOrWhiteSpace(source.NextCursor) && codec.TryParse(source.NextCursor, out long parsed))
        {
            nextCursor = parsed;
        }

        return new CoreCursorResult<TTarget>(source.Data.Select(map).ToList(), nextCursor, source.HasMore);
    }
}
