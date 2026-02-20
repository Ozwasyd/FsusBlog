using SqlSugar;

namespace FsusBlog.Server.Entities;

public enum MessageCategory
{
    /// <summary>全站公告 (拉模式)</summary>
    Broadcast = 1,
    /// <summary>系统通知 (删评、封禁等 - 推模式)</summary>
    SystemTask = 2,
    /// <summary>事务性通知 (点对点消息)</summary>
    Transactional = 3
}

[SugarTable("sys_message")]
[SugarIndex("idx_message_type_time", nameof(Category), OrderByType.Desc, nameof(CreateTime), OrderByType.Desc)]
public class SysMessage
{
    [SugarColumn(IsPrimaryKey = true)]
    public long Id { get; init; }

    public string Title { get; init; }

    [SugarColumn(ColumnDataType = "text")]
    public string Content { get; init; } = null!;

    public MessageCategory Category { get; init; }

    /// <summary>
    /// 触发此消息的业务ID (如评论ID，封禁记录ID)
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public long? SourceId { get; init; }

    public DateTime CreateTime { get; init; } = DateTime.UtcNow;
}

[SugarTable("sys_user_message")]
public class SysUserMessage
{
    [SugarColumn(IsPrimaryKey = true)]
    public long UserId { get; init; }

    [SugarColumn(IsPrimaryKey = true)]
    public long MessageId { get; init; }

    public bool IsRead { get; set; }

    [SugarColumn(IsNullable = true)]
    public DateTime? ReadTime { get; set; }
}