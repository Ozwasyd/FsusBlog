using IP2Location;

using Microsoft.Extensions.ObjectPool;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// Pools initialized IP2Location components because each borrowed instance is not shared concurrently.
/// </summary>
public sealed class IP2LocationPooledObjectPolicy : IPooledObjectPolicy<Component>
{
    private readonly string _dbPath;
    private readonly ILogger<IP2LocationPooledObjectPolicy> _logger;

    /// <summary>
    /// 初始化策略
    /// </summary>
    /// <param name="dbPath">IP2Location BIN 数据库的物理路径</param>
    /// <param name="logger">日志组件</param>
    public IP2LocationPooledObjectPolicy(string dbPath, ILogger<IP2LocationPooledObjectPolicy> logger)
    {
        _dbPath = dbPath;
        _logger = logger;

        // 启动防御：如果数据库文件丢失，直接阻断启动，防止后续统计业务崩溃
        if (!File.Exists(_dbPath))
        {
            _logger.LogCritical("严重错误：IP2Location 数据库文件缺失 | 路径: {Path}", _dbPath);
            throw new FileNotFoundException("IP2Location BIN file not found.", _dbPath);
        }
    }

    /// <summary>
    /// 池化对象创建逻辑
    /// </summary>
    public Component Create()
    {
        try
        {
            return CreateCore();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "初始化 IP2Location 实例失败 | 路径: {Path}", _dbPath);
            throw new InvalidOperationException("初始化 IP2Location 实例失败。对象池无法创建可复用实例。", ex);
        }
    }

    private Component CreateCore()
    {
        var component = new Component();

        // OWNERSHIP: A component enters the pool only after its database handle and metadata are initialized.
        component.Open(_dbPath);

        _logger.LogDebug("已成功初始化并预热一个新的 IP2Location 实例");
        return component;
    }

    /// <summary>
    /// 对象归还逻辑
    /// </summary>
    public bool Return(Component obj) =>
        // 只要对象不为空，则认为可继续复用
        obj != null;
}
