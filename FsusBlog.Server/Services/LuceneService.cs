using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using Lucene.Net.Analysis.Cn.Smart;
using Lucene.Net.Documents;
using Lucene.Net.Index;
using Lucene.Net.QueryParsers.Classic;
using Lucene.Net.Search;
using Lucene.Net.Util;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services;

/// <summary>
/// Lucene 站内检索服务实现 (线程安全与高性能版)
/// 修复日期: 2026-02-23 (恢复 Content 存储以支持自包含摘要生成，保留滑动窗口正则优化，内部闭环)
/// </summary>
public partial class LuceneService(ILuceneContext context, ILogger<LuceneService> logger) : ILuceneService
{
    private const LuceneVersion _version = LuceneVersion.LUCENE_48;
    private static readonly string[] SearchFields = ["Title", "Content"];

    // 核心性能优化：Analyzer 全局单例复用
    private static readonly SmartChineseAnalyzer _sharedAnalyzer = new(_version);

    // 正则源生成器 (保留优化)
    [GeneratedRegex(@"<.*?>")]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"!?\[(?<text>.*?)\]\(.*?\)")]
    private static partial Regex MdLinkRegex();

    [GeneratedRegex(@"[#*>=_~`\-]")]
    private static partial Regex MdSymbolRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhiteSpaceRegex();

    public async Task BuildIndexAsync(List<Article> articles)
    {
        LogBuildIndexStart(articles.Count);

        await Task.Run(() =>
        {
            try
            {
                context.ExecuteWrite(writer =>
                {
                    writer.DeleteAll();
                    foreach (var article in articles)
                    {
                        writer.AddDocument(MapArticleToDocument(article));
                    }
                    writer.Commit();
                });

                context.SaveChanges();
                LogBuildIndexSuccess();
            }
            catch (Exception ex)
            {
                LogBuildIndexError(ex);
                throw;
            }
        });
    }

    public Task<List<Article>> SearchAsync(string keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword)) return Task.FromResult(new List<Article>());

        var result = new List<Article>();
        IndexSearcher? searcher = null;

        try
        {
            searcher = context.GetSearcher();

            var parser = new MultiFieldQueryParser(_version, SearchFields, _sharedAnalyzer)
            {
                DefaultOperator = Operator.AND
            };

            var safeKeyword = QueryParserBase.Escape(keyword.Trim());
            if (string.IsNullOrWhiteSpace(safeKeyword)) return Task.FromResult(result);

            var query = parser.Parse(safeKeyword);
            var hits = searcher.Search(query, 20).ScoreDocs;

            foreach (var hit in hits)
            {
                var doc = searcher.Doc(hit.Doc);
                var rawContent = doc.Get("Content") ?? ""; // 从索引中直接获取原文

                result.Add(new Article
                {
                    Id = int.Parse(doc.Get("Id")),
                    Title = doc.Get("Title"),
                    // 内部直接生成摘要，对外透明
                    Content = GetPlainSnippet(rawContent, keyword)
                });
            }
        }
        catch (Exception ex)
        {
            LogSearchError(ex, keyword);
        }
        finally
        {
            if (searcher != null)
            {
                context.ReleaseSearcher(searcher);
            }
        }

        return Task.FromResult(result);
    }

    public async Task AddOrUpdateIndexAsync(Article article)
    {
        await Task.Run(() =>
        {
            try
            {
                context.ExecuteWrite(writer =>
                {
                    writer.UpdateDocument(
                        new Term("Id", article.Id.ToString()),
                        MapArticleToDocument(article)
                    );
                });
                context.SaveChanges();
            }
            catch (Exception ex)
            {
                LogUpdateIndexError(ex, article.Id);
            }
        });
    }

    public async Task DeleteIndexAsync(int id)
    {
        await Task.Run(() =>
        {
            try
            {
                context.ExecuteWrite(writer =>
                {
                    writer.DeleteDocuments(new Term("Id", id.ToString()));
                });
                context.SaveChanges();
            }
            catch (Exception ex)
            {
                LogDeleteIndexError(ex, id);
            }
        });
    }

    private static Document MapArticleToDocument(Article article)
    {
        return
        [
            new StringField("Id", article.Id.ToString(), Field.Store.YES),
            new TextField("Title", article.Title ?? "", Field.Store.YES),
            // 核心回退：必须设为 Store.YES，否则 SearchAsync 无法获取内容生成摘要。
            // 虽然这会增加内存开销，但这是为了维持架构分层（Service不感知Lucene细节）的必要代价。
            new TextField("Content", article.Content ?? "", Field.Store.YES)
        ];
    }

    /// <summary>
    /// 高性能纯文本摘要生成算法 (内部私有，滑动窗口优化)
    /// </summary>
    private static string GetPlainSnippet(string content, string keyword)
    {
        if (string.IsNullOrEmpty(content)) return "";

        // 1. 先定位，不清洗 (0 分配)
        int rawIndex = content.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);

        string window;
        int windowStart = 0;
        int windowEnd;

        // 2. 切片 (只在内存中分配一个小窗口字符串，而不是清洗整篇几万字的文章)
        if (rawIndex != -1)
        {
            // 如果找到，提取前后各约 100 字符的窗口
            windowStart = Math.Max(0, rawIndex - 100);
            windowEnd = Math.Min(content.Length, rawIndex + keyword.Length + 100);
            window = content[windowStart..windowEnd];
        }
        else
        {
            // 没找到（可能是分词匹配），退化为截取前 300 字
            windowEnd = Math.Min(content.Length, 300);
            window = content[..windowEnd];
        }

        // 3. 仅对小窗口进行正则清洗 (极速)
        var plainText = MdLinkRegex().Replace(window, m => m.Groups["text"].Value);
        plainText = HtmlTagRegex().Replace(plainText, "");
        plainText = MdSymbolRegex().Replace(plainText, "");
        plainText = WhiteSpaceRegex().Replace(plainText, " ").Trim();

        // 4. 在清洗后的文本中精确定位
        int index = plainText.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
        if (index == -1) return plainText.Length > 120 ? string.Concat(plainText.AsSpan(0, 120), "...") : plainText;

        int start = Math.Max(0, index - 60);
        int end = Math.Min(plainText.Length, index + keyword.Length + 60);

        var snippetSpan = plainText.AsSpan(start, end - start);

        bool hasPrefix = start > 0 || windowStart > 0;
        bool hasSuffix = end < plainText.Length || windowEnd < content.Length;

        // 5. 零分配拼接
        if (hasPrefix && hasSuffix) return string.Concat("...", snippetSpan, "...");
        if (hasPrefix) return string.Concat("...", snippetSpan);
        if (hasSuffix) return string.Concat(snippetSpan, "...");

        return snippetSpan.ToString();
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Information, Message = "启动全量索引构建 | 待处理文档: {Count}")]
    private partial void LogBuildIndexStart(int count);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "全量索引构建成功")]
    private partial void LogBuildIndexSuccess();

    [LoggerMessage(EventId = 3, Level = LogLevel.Error, Message = "全量索引构建失败")]
    private partial void LogBuildIndexError(Exception ex);

    [LoggerMessage(EventId = 4, Level = LogLevel.Error, Message = "执行搜索时发生未知错误 | Keyword: {Keyword}")]
    private partial void LogSearchError(Exception ex, string keyword);

    [LoggerMessage(EventId = 5, Level = LogLevel.Error, Message = "更新索引失败 | ID: {Id}")]
    private partial void LogUpdateIndexError(Exception ex, int id);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "删除索引失败 | ID: {Id}")]
    private partial void LogDeleteIndexError(Exception ex, int id);
}