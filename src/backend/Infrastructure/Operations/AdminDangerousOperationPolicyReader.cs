using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IAdminDangerousOperationPolicyReader
{
    DangerousOperationPolicyResponse Get();
}

internal sealed class AdminDangerousOperationPolicyReader : IAdminDangerousOperationPolicyReader
{
    public DangerousOperationPolicyResponse Get()
        => new(
            [
                new DangerousOperationRuleResponse("normal-confirm", "confirm", ["刷新缓存", "重建搜索索引", "重新生成 sitemap/feed"]),
                new DangerousOperationRuleResponse("strong-confirm", "二次确认", ["删除文件", "清理孤立资产", "清空 output cache"]),
                new DangerousOperationRuleResponse("typed-confirm", "输入对象名", ["删除标签并解除关联", "删除分类并迁移文章"]),
                new DangerousOperationRuleResponse("admin-step-up", "Admin step-up proof", ["批量封禁匿名账号", "撤销账号会话", "导出站点备份", "应用数据巡检修复"]),
                new DangerousOperationRuleResponse("diff-preview", "展示 changed fields", ["系统设置保存", "内容导入", "revision rollback", "静态页面修改"])
            ],
            ["system-settings-save", "content-import", "revision-rollback", "taxonomy-update", "integrity-fix"],
            ["comment-bulk-moderation", "anonymous-account-suspend", "session-revoke", "site-backup-export", "integrity-fix"],
            "single-author-v1");
}
