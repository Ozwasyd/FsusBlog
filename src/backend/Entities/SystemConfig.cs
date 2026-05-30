using SqlSugar;

namespace FsusBlog.Server.Entities
{
    /// <summary>
    /// 系统配置表
    /// </summary>
    [SugarTable("sys_systemConfig")]
    public class SystemConfig
    {
        // 系统配置的字段是易变且不确定的，用 Key-Value。
        [SugarColumn(IsPrimaryKey = true, Length = 64)]
        public string Key { get; set; } = null!;

        [SugarColumn(Length = 512)]
        public string Value { get; set; } = null!;
    }
}
