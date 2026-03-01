using FsusBlog.Server.Interfaces;
using Lucene.Net.Analysis.Cn.Smart;
using Lucene.Net.Index;
using Lucene.Net.Search;
using Lucene.Net.Store;
using Lucene.Net.Util;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// Lucene 搜索上下文
/// 修复日期: 2026-02-23 (增加 sealed 修饰符提供 JIT 虚方法消除优化)
/// </summary>
public sealed class LuceneContext : ILuceneContext
{
    private readonly IndexWriter _writer;
    private readonly SearcherManager _searcherManager;
    private readonly FSDirectory _directory;
    private readonly SmartChineseAnalyzer _analyzer;
    private readonly object _syncLock = new();

    public LuceneContext(string indexPath)
    {
        _directory = FSDirectory.Open(indexPath);

        // 1. 自动处理残留锁
        if (IndexWriter.IsLocked(_directory)) IndexWriter.Unlock(_directory);

        _analyzer = new SmartChineseAnalyzer(LuceneVersion.LUCENE_48);
        var config = new IndexWriterConfig(LuceneVersion.LUCENE_48, _analyzer)
        {
            OpenMode = OpenMode.CREATE_OR_APPEND,
            RAMBufferSizeMB = 64.0 // 增大缓冲区提升批量写入性能
        };

        _writer = new IndexWriter(_directory, config);

        // 2. 初始化 SearcherManager (近实时搜索的核心)
        // 参数 true 表示在内存中实时刷新应用变更
        _searcherManager = new SearcherManager(_writer, true, null);
    }

    // --- 写入逻辑 ---
    public void ExecuteWrite(Action<IndexWriter> action)
    {
        lock (_syncLock)
        {
            action(_writer);
        }
    }

    public void SaveChanges()
    {
        lock (_syncLock)
        {
            _writer.Commit();
            // 告诉管理器：索引已变，下次获取 Searcher 时请刷新
            _searcherManager.MaybeRefreshBlocking();
        }
    }

    // --- 读取逻辑 ---
    public IndexSearcher GetSearcher()
    {
        // 获取当前最新的有效 Searcher，由管理器维护引用计数
        return _searcherManager.Acquire();
    }

    public void ReleaseSearcher(IndexSearcher searcher)
    {
        // 必须手动释放引用，否则会导致索引文件无法被删除/合并
        _searcherManager.Release(searcher);
    }

    public void Dispose()
    {
        lock (_syncLock)
        {
            _searcherManager?.Dispose();
            _writer?.Commit();
            _writer?.Dispose();
            _analyzer?.Dispose();
            _directory?.Dispose();
        }
        GC.SuppressFinalize(this);
    }
}