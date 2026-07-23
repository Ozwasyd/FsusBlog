import type { SecurityOverviewResponse } from '@/api/security';

export type SecurityDashboardSeverity = 'critical' | 'warning' | 'attention' | 'unavailable';

export interface SecurityDashboardTask {
    actionLabel: string;
    helper: string;
    key: string;
    occurredAt: string;
    severity: SecurityDashboardSeverity;
    severityLabel: string;
    title: string;
    to: { name: string; };
}

export interface SecurityDashboardTrend {
    key: string;
    label: string;
    value: string;
}

export interface SecurityDashboardChange {
    actor: string;
    key: string;
    label: string;
    occurredAt: string;
    value: string;
}

export interface SecurityDashboardModel {
    checkedAtUtc: string;
    changes: readonly SecurityDashboardChange[];
    status: 'attention' | 'healthy';
    statusCopy: string;
    tasks: readonly SecurityDashboardTask[];
    trends: readonly SecurityDashboardTrend[];
}

const task = (
    key: string,
    severity: SecurityDashboardSeverity,
    severityLabel: string,
    title: string,
    helper: string,
    occurredAt: string,
    actionLabel: string,
    routeName: string
): SecurityDashboardTask => ({
    actionLabel,
    helper,
    key,
    occurredAt,
    severity,
    severityLabel,
    title,
    to: { name: routeName }
});

const positive = (value: number | null | undefined): number =>
  Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;

export const createSecurityDashboardModel = (
    overview: SecurityOverviewResponse
): SecurityDashboardModel =>
{
    const occurredAt = overview.checkedAtUtc;
    const tasks: SecurityDashboardTask[] = [];
    const highRiskCount = positive(overview.risk.highRiskSnapshotCount);
    const replayRejects = positive(overview.pow.replayRejectsLastHour);
    const validationFailures = positive(overview.pow.validationFailuresLastHour);
    const fakeCrawlerEvents = positive(overview.antiCrawler.fakeCrawlerEvents);
    const unknownBotEvents = positive(overview.antiCrawler.unknownBotEvents);

    if (highRiskCount > 0)
    {
        tasks.push(task(
            'high-risk-subjects',
            'critical',
            '严重',
            `${highRiskCount} 个高风险主体需要复核`,
            '确认风险来源、处置结果和是否需要调整当前策略。',
            occurredAt,
            '查看风险事件',
            'ManageSecurityEvents'
        ));
    }
    if (replayRejects > 0)
    {
        tasks.push(task(
            'pow-replay-rejects',
            'warning',
            '警告',
            `${replayRejects} 次 PoW 重放被拒绝`,
            '检查来源分布与 proof 重放防护是否符合预期。',
            occurredAt,
            '检查 PoW',
            'ManageSecurityPow'
        ));
    }
    if (validationFailures > 0)
    {
        tasks.push(task(
            'pow-validation-failures',
            'warning',
            '警告',
            `${validationFailures} 次 PoW 验证失败`,
            '核对验证失败趋势、难度和 proof 有效期。',
            occurredAt,
            '检查 PoW',
            'ManageSecurityPow'
        ));
    }
    if (fakeCrawlerEvents > 0)
    {
        tasks.push(task(
            'fake-crawler-events',
            'attention',
            '关注',
            `${fakeCrawlerEvents} 个伪装爬虫事件`,
            '检查识别规则、来源范围和当前处置模式。',
            occurredAt,
            '检查反爬虫',
            'ManageSecurityCrawler'
        ));
    }
    if (unknownBotEvents > 0)
    {
        tasks.push(task(
            'unknown-bot-events',
            'attention',
            '关注',
            `${unknownBotEvents} 个未知自动化来源`,
            '确认未知来源是否需要加入规则或列表。',
            occurredAt,
            '检查反爬虫',
            'ManageSecurityCrawler'
        ));
    }

    const changes: SecurityDashboardChange[] = overview.pow.policy.updatedAtUtc
        ? [{
        actor: overview.pow.policy.updatedBy || '系统',
        key: `pow-policy-${overview.pow.policy.snapshotId}`,
        label: 'PoW 策略',
        occurredAt: overview.pow.policy.updatedAtUtc,
        value: overview.pow.policy.options.mode
      }]
        : [];

    return {
        checkedAtUtc: overview.checkedAtUtc,
        changes,
        status: tasks.length > 0 ? 'attention' : 'healthy',
        statusCopy: tasks.length > 0
            ? `发现 ${tasks.length} 类需要处理的安全异常。`
            : '系统处于预期状态，当前没有需要处理的安全异常。',
        tasks,
        trends: [
            { key: 'events-hour', label: '近 1 小时事件', value: String(positive(overview.risk.eventsLastHour)) },
            { key: 'events-day', label: '近 24 小时事件', value: String(positive(overview.risk.eventsLastDay)) },
            { key: 'high-risk', label: '高风险主体', value: String(highRiskCount) },
            { key: 'top-reason', label: '主要原因', value: overview.risk.topReason || '无' }
        ]
    };
};
