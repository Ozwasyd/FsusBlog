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
/// </summary>
public partial class LuceneService(
    ILuceneContext _context,
    ILogger<LuceneService> _logger) : ILuceneService
{
    private readonly LuceneVersion _version = LuceneVersion.LUCENE_48;
    // 限制搜索域：只在标题和正文中查找
    private static readonly string[] SearchFields = ["Title", "Content"];

    // 🚀 性能优化：使用 .NET 7+ 源生成器预编译正则，消除运行时开销
    [GeneratedRegex(@"<.*?>", RegexOptions.Compiled)]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"!?\[(?<text>.*?)\]\(.*?\)", RegexOptions.Compiled)]
    private static partial Regex MdLinkRegex();

    [GeneratedRegex(@"[#*>=_~`\-]", RegexOptions.Compiled)]
    private static partial Regex MdSymbolRegex();

    [GeneratedRegex(@"\s+", RegexOptions.Compiled)]
    private static partial Regex WhiteSpaceRegex();

    /// <summary>
    /// 全量重构索引 (通常用于系统启动或数据修复)
    /// </summary>
    public async Task BuildIndexAsync(List<Article> articles)
    {
        _logger.LogInformation("启动全量索引构建 | 待处理文档: {Count}", articles.Count);

        // 移入后台线程，防止阻塞启动过程
        await Task.Run(() =>
        {
            try
            {
                _context.ExecuteWrite(writer =>
                {
                    writer.DeleteAll(); // 1. 清空旧索引

                    foreach (var article in articles)
                    {
                        writer.AddDocument(MapArticleToDocument(article));
                    }

                    writer.Commit(); // 2. 显式提交到磁盘
                });

                _context.SaveChanges(); // 3. 刷新 SearcherManager
                _logger.LogInformation("全量索引构建成功");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "全量索引构建失败");
                throw; // 关键启动错误需要向上抛出
            }
        });
    }

    /// <summary>
    /// 执行搜索 (NRT 近实时搜索)
    /// </summary>
    public async Task<List<Article>> SearchAsync(string keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword)) return [];

        return await Task.Run(() =>
        {
            var result = new List<Article>();
            IndexSearcher? searcher = null;

            try
            {
                // 1. 租赁 Searcher (引用计数 +1)
                searcher = _context.GetSearcher();

                using var analyzer = new SmartChineseAnalyzer(_version);
                var parser = new MultiFieldQueryParser(_version, SearchFields, analyzer)
                {
                    DefaultOperator = Operator.AND // 要求关键词所有分词都匹配
                };

                // 2. 解析查询 (自动处理分词)
                var query = parser.Parse(keyword.Trim());

                // 3. 执行检索 (取前 20 条)
                var hits = searcher.Search(query, 20).ScoreDocs;

                foreach (var hit in hits)
                {
                    var doc = searcher.Doc(hit.Doc);
                    var rawContent = doc.Get("Content") ?? "";

                    // 将 Lucene 文档映射回实体对象
                    result.Add(new Article
                    {
                        Id = int.Parse(doc.Get("Id")),
                        Title = doc.Get("Title"),
                        // 动态生成包含关键词的高亮摘要
                        Content = GetPlainSnippet(rawContent, keyword)
                    });
                }
            }
            catch (ParseException ex)
            {
                _logger.LogWarning("搜索语法解析失败 (用户输入了特殊字符) | Keyword: {Keyword} | Error: {Message}", keyword, ex.Message);
                // 返回空列表，不抛出异常
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "执行搜索时发生未知错误 | Keyword: {Keyword}", keyword);
            }
            finally
            {
                // 4. 归还 Searcher (引用计数 -1)，必须执行！
                if (searcher != null)
                {
                    _context.ReleaseSearcher(searcher);
                }
            }

            return result;
        });
    }

    /// <summary>
    /// 增量添加或更新索引
    /// </summary>
    public async Task AddOrUpdateIndexAsync(Article article)
    {
        await Task.Run(() =>
        {
            try
            {
                _context.ExecuteWrite(writer =>
                {
                    // UpdateDocument = Delete + Add (原子操作)
                    writer.UpdateDocument(
                        new Term("Id", article.Id.ToString()),
                        MapArticleToDocument(article)
                    );
                });
                _context.SaveChanges(); // 刷新
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "更新索引失败 | ID: {Id}", article.Id);
            }
        });
    }

    /// <summary>
    /// 物理删除索引
    /// </summary>
    public async Task DeleteIndexAsync(int id)
    {
        await Task.Run(() =>
        {
            try
            {
                _context.ExecuteWrite(writer =>
                {
                    writer.DeleteDocuments(new Term("Id", id.ToString()));
                });
                _context.SaveChanges(); // 刷新
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "删除索引失败 | ID: {Id}", id);
            }
        });
    }

    // 实体 -> Lucene Document 映射
    private static Document MapArticleToDocument(Article article)
    {
        return new Document
        {
            // StringField: 不分词，精确匹配 (用于 ID)
            new StringField("Id", article.Id.ToString(), Field.Store.YES),
            // TextField: 分词，全文检索 (用于标题和内容)
            new TextField("Title", article.Title ?? "", Field.Store.YES),
            new TextField("Content", article.Content ?? "", Field.Store.YES)
        };
    }

    /// <summary>
    /// 纯文本摘要生成算法 (动态滑动窗口)
    /// </summary>
    private static string GetPlainSnippet(string content, string keyword)
    {
        if (string.IsNullOrEmpty(content)) return "";

        // 1. 如果不包含关键词，直接返回前 120 个字符
        if (!content.Contains(keyword, StringComparison.OrdinalIgnoreCase))
        {
            var clean = WhiteSpaceRegex().Replace(HtmlTagRegex().Replace(content, ""), " ").Trim();
            return clean.Length > 120 ? string.Concat(clean.AsSpan(0, 120), "...") : clean;
        }

        // 2. 清洗 Markdown 和 HTML 标签
        var plainText = MdLinkRegex().Replace(content, m => m.Groups["text"].Value);
        plainText = HtmlTagRegex().Replace(plainText, "");
        plainText = MdSymbolRegex().Replace(plainText, "");
        plainText = WhiteSpaceRegex().Replace(plainText, " ").Trim();

        // 3. 定位关键词位置
        int index = plainText.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
        if (index == -1) return plainText.Length > 120 ? plainText[..120] : plainText;

        // 4. 计算窗口范围 (前60字 - 关键词 - 后90字)
        int start = Math.Max(0, index - 60);
        int end = Math.Min(plainText.Length, index + keyword.Length + 90);
        int length = end - start;

        var snippet = plainText.Substring(start, length);

        var prefix = start > 0 ? "..." : "";
        var suffix = end < plainText.Length ? "..." : "";

        return $"{prefix}{snippet}{suffix}";
    }
}