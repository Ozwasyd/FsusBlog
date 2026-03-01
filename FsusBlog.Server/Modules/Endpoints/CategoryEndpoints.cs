using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.OutputCaching;
using SqlSugar;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 文章分类查询端点 (Minimal API)
/// 修复日期: 2026-02-23 (废弃内存 JOIN 逻辑，改用 DB 原生聚合查询；引入 DataReader 预热寻址彻底消灭装箱与错位风险)
/// </summary>
public static class CategoryEndpoints
{
    private const string CacheTag = "Category";

    public static void MapCategoryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/Category")
            .WithTags(CacheTag);

        // GET /api/Category
        group.MapGet("/", async (ISqlSugarClient db) =>
        {
            // 核心架构优化：将关系代数逻辑归还给数据库。
            // 使用 LeftJoin + GroupBy 一次性提取所有数据，消灭 N+1 查询与 C# 内存字典分配开销。
            var query = db.Queryable<Category>()
                .LeftJoin<Article>((c, a) => c.Id == a.CategoryId && a.IsDeleted == false)
                .GroupBy(c => new { c.Id, c.Name })
                .OrderBy(c => c.Id)
                .Select((c, a) => new
                {
                    c.Id,
                    c.Name,
                    // PostgreSQL COUNT 返回 bigint (Int64)
                    ArticleCount = SqlFunc.AggregateCount(a.Id)
                });

            var sqlObj = query.ToSql();
            var result = new List<CategoryDto>();

            // 核心物理优化：直接操作底层的 DbDataReader
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
            {
                // 性能与安全的平衡：在循环外预热列索引。
                // 确保了循环内部是绝对的 $O(1)$ 数组寻址，同时杜绝了 Select 顺序变动导致的业务错位。
                int fId = reader.GetOrdinal("Id");
                int fName = reader.GetOrdinal("Name");
                int fCount = reader.GetOrdinal("ArticleCount");

                while (await reader.ReadAsync())
                {
                    result.Add(new CategoryDto
                    {
                        Id = reader.GetInt32(fId),
                        Name = reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                        // 彻底修复装箱：强制使用 GetInt64 读取 8 字节整数，再进行栈上强转。
                        ArticleCount = (int)reader.GetInt64(fCount)
                    });
                }
            }

            return TypedResults.Ok(ApiResponse<List<CategoryDto>>.Success(result));
        })
        .CacheOutput(p => p.Expire(TimeSpan.FromMinutes(5)).Tag(CacheTag));
    }
}