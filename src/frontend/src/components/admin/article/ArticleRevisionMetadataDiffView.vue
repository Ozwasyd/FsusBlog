<template>
    <section
        aria-label="经验证的元数据差异"
        class="revision-metadata-view"
    >
        <p
            v-if="metadata.receipt.status === 1"
            role="alert"
            class="revision-metadata-warning"
        >部分元数据缺少权威来源，不能视为完整比较或未变化。{{ metadata.receipt.missingAuthorities.map(authorityText).join('；') }}</p>
        <p
            v-else
            role="status"
        >已取得完整的服务端元数据比较 receipt。</p>
        <dl class="revision-metadata-fields">
            <div
                v-for="field in metadata.fields"
                :key="field.fieldId"
                class="revision-metadata-field"
                :data-field-id="field.fieldId"
            >
                <dt>{{ fieldLabels[field.fieldId] ?? field.fieldId }} · {{ changes[field.change] }}</dt>
                <dd>
                    <span>基准：{{ displayValue(field.before, field.sensitive) }}</span>
                    <span>比较：{{ displayValue(field.after, field.sensitive) }}</span>
                    <span v-if="field.change === 5">缺少权威来源；本字段不是未变化。</span>
                    <span v-if="field.change === 4">+ {{ field.addedIds.join(', ') || '无增加' }}；− {{ field.removedIds.join(', ') || '无删除' }}</span>
                </dd>
            </div>
        </dl>
    </section>
</template>
<script setup lang="ts">
import type { ArticleRevisionMetadataDiffResponse, ArticleRevisionMetadataDiffValue } from '@/api/articleRevisionCompare';

defineProps<{ metadata: ArticleRevisionMetadataDiffResponse; }>();
const changes = ['= 未变化', '+ 增加', '− 删除', '± 替换', '± 集合变化', '缺少权威来源', '不适用'];
const fieldLabels: Record<string, string> = {
    title: '标题', summary: '摘要', 'cover-image-url': '封面地址', 'category-id': '分类标识', 'tag-ids': '标签标识',
    status: '文章状态', 'scheduled-publish-at': '定时发布时间',
    'release.identity': '发布快照标识', 'release.state': '发布快照状态',
    'responsibility.identity': '责任快照标识', 'responsibility.state': '责任快照状态',
    'rights.identity': '版权快照标识', 'rights.state': '版权快照状态'
};
const authorityLabels: Record<string, string> = {
    cover_asset_id_missing_authority: '封面资源身份尚未核验',
    historical_lifecycle_missing_authority: '历史生命周期尚未核验',
    release_snapshot_coordinates_missing_authority: '发布快照坐标尚未核验',
    release_transition_enum_missing_authority: '发布状态变更尚未核验',
    responsibility_snapshot_content_digest_missing_authority: '责任快照内容尚未核验',
    rights_license_copy_enum_missing_authority: '版权许可副本尚未核验'
};
const authorityText = (authority: string): string => authorityLabels[authority] ?? '其他字段缺少权威来源';
const valueText = (value: ArticleRevisionMetadataDiffValue): string =>
{
    switch (value.kind)
    {
        case 0: return '未观测（缺少权威来源）';
        case 1: return '不适用';
        case 2: return '空值（null）';
        case 3: return value.text === '' ? '空字符串' : value.text!;
        case 4: return value.number!;
        case 5: return value.boolean ? '是' : '否';
        case 6:
        {
            const milliseconds = BigInt(value.number!) / 10000n - 62135596800000n;
            return milliseconds >= -8640000000000000n && milliseconds <= 8640000000000000n
                ? `${new Date(Number(milliseconds)).toISOString()} · UTC ticks ${value.number}` : `${value.number} UTC ticks`;
        }
        case 7: return `${value.number}（日期序号）`;
        case 8: return value.ids.length ? value.ids.join(', ') : '空集合';
        default: return '类型不可用';
    }
};
const displayValue = (value: ArticleRevisionMetadataDiffValue, sensitive: boolean): string =>
    sensitive && value.kind > 2 ? '已隐去敏感值' : valueText(value);
</script>
<style scoped>
.revision-metadata-view
 {
    min-width: 0;
}

.revision-metadata-warning
 {
    color: var(--fsusblog-text-primary);
    border-inline-start: 2px solid var(--el-color-warning);
    padding-inline-start: var(--fsus-space-2);
    overflow-wrap: anywhere;
}

.revision-metadata-fields
 {
    margin: 0;
}

.revision-metadata-field
 {
    min-width: 0;
    padding-block: var(--fsus-space-2);
    border-block-start: 1px solid var(--fsusblog-panel-border);
}

.revision-metadata-field dt
 {
    font-weight: 700;
    overflow-wrap: anywhere;
}

.revision-metadata-field dd
 {
    display: grid;
    gap: var(--fsus-space-1);
    margin-inline-start: 0;
    overflow-wrap: anywhere;
}
</style>
