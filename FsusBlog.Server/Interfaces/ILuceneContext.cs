using Lucene.Net.Index;
using Lucene.Net.Search;

namespace FsusBlog.Server.Interfaces
{
    /// <summary>
    /// Lucene 写入上下文单例封装
    /// 确保全局只有一个 IndexWriter 实例，解决 write.lock 冲突
    /// </summary>
    public interface ILuceneContext : IDisposable
    {
        // 写入：代理模式
        void ExecuteWrite(Action<IndexWriter> action);
        void SaveChanges();

        // 读取：获取最新的 IndexSearcher
        IndexSearcher GetSearcher();
        void ReleaseSearcher(IndexSearcher searcher);
    }
}
