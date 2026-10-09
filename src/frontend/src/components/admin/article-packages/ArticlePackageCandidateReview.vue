<template>
    <section ref="rootRef" class="package-review" :aria-labelledby="`${id}-title`" :aria-busy="state === 'loading'">
        <h2 :id="`${id}-title`" ref="titleRef" tabindex="-1">文章包候选审阅（只读）</h2>
        <p>这是有限字节候选及调用方请求的投影。结构有效、提示齐全或时间区间内均不授予导入执行权限。</p>
        <p v-if="state === 'loading'" role="status">正在读取候选审阅。</p>
        <p v-else-if="state === 'error' || invalidReview" role="alert" data-reason-code="article_package_candidate_review_invalid">
            候选审阅不可用。请由集成入口重新读取。
        </p>
        <p v-else-if="!boundedReview" role="status">尚未提供候选审阅。</p>
        <template v-if="boundedReview && state === 'ready'">
            <p v-if="stale || boundedReview.intervalStatus !== 'caller_interval_current'" role="status" data-reason-code="article_package_import_plan_stale">
                候选已过时，或调用方声明的有效区间尚未开始／已经结束。需由原始入口重新读取或生成候选。
            </p>
            <dl class="package-review__summary">
                <dt>候选状态</dt><dd>有限字节已验证；完整包准入尚未获得</dd>
                <dt>现有候选摘要</dt><dd>{{ boundedReview.summary.articleCount }} 篇文章，{{ boundedReview.summary.fileCount }} 个文件</dd>
                <dt>版本</dt><dd>Schema {{ boundedReview.summary.schemaVersion }} / Canonical hash {{ boundedReview.summary.canonicalHashVersion }} / Property {{ boundedReview.summary.propertySchemaVersion }}</dd>
                <dt>请求模式</dt><dd>{{ boundedReview.requestedMode === 'CreateNew' ? '请求创建新身份' : '请求更新（提示未验证）' }}</dd>
                <dt>调用方声明的有效区间（UTC）</dt><dd><time :datetime="boundedReview.createdAtUtc">{{ boundedReview.createdAtUtc }}</time> 至 <time :datetime="boundedReview.expiresAtUtc">{{ boundedReview.expiresAtUtc }}</time></dd>
                <dt>投影时的区间状态</dt><dd>{{ boundedReview.intervalStatus }}</dd>
                <dt>Plan digest</dt><dd>{{ boundedReview.planDigest }}</dd>
                <dt>调用方 Policy digest（断言）</dt><dd>{{ boundedReview.policyDigest }}</dd>
                <dt>Package bytes digest</dt><dd>{{ boundedReview.summary.packageBytesDigest }}</dd>
                <dt>Manifest semantic digest</dt><dd>{{ boundedReview.summary.manifestSemanticDigest }}</dd>
                <dt>Checksum component digest</dt><dd>{{ boundedReview.summary.checksumComponentDigest }}</dd>
            </dl>
            <h3 :id="`${id}-targets`" ref="targetsRef" tabindex="-1">请求目标提示</h3>
            <p>以下是调用方请求提示或新身份要求，尚未解析为当前目标，也未通过权限或 revision 验证。</p>
            <ol class="package-review__targets" :start="boundedReview.pageIndex * boundedReview.pageSize + 1" :aria-labelledby="`${id}-targets`">
                <li v-for="target in boundedReview.targets" :key="target.portableArticle">
                    <dl class="package-review__summary">
                        <dt>Portable article</dt><dd>{{ target.portableArticle }}</dd>
                        <dt>新身份要求</dt><dd>{{ target.requiresNewIdentity ? '需要新身份（尚未创建）' : '请求更新' }}</dd>
                        <dt>请求目标 article ID</dt><dd>{{ target.requestedTargetArticleId ?? '未提供' }}</dd>
                        <dt>期望目标 revision（断言）</dt><dd>{{ target.expectedTargetRevision ?? '未提供' }}</dd>
                    </dl>
                </li>
            </ol>
            <nav class="package-review__pages" aria-label="请求目标提示分页">
                <ElButton native-type="button" :disabled="pagePending || boundedReview.pageIndex === 0" @click="requestPage(boundedReview.pageIndex - 1)">上一页</ElButton>
                <ElButton native-type="button" :disabled="pagePending || boundedReview.pageIndex + 1 >= pageCount" @click="requestPage(boundedReview.pageIndex + 1)">下一页</ElButton>
                <span role="status" aria-live="polite">第 {{ boundedReview.pageIndex + 1 }} / {{ pageCount }} 页；共 {{ boundedReview.totalTargets }} 条提示{{ pagePending ? '；等待读取' : '' }}</span>
            </nav>
            <h3>仍需原始 authority</h3>
            <ul><li v-for="authority in boundedReview.requiredAuthorities" :key="authority">{{ authority }}</li></ul>
        </template>
        <p :id="`${id}-refusal`" role="status" :data-reason-code="executionRefusal">
            执行不可用：{{ executionRefusal }}。现有候选不是可执行导入计划。
        </p>
        <ElButton native-type="button" disabled :aria-describedby="`${id}-refusal`" :data-reason-code="executionRefusal">执行导入</ElButton>
        <p>集成缺口：完整导出、认证 intake 与读取路由、权限投影、resolution、executor 和 result center。</p>
    </section>
</template>

<script setup lang="ts">
import { ElButton } from '@ozwasyd/element-plus';
import { computed, nextTick, ref, useId, watch } from 'vue';

import type { ArticlePackageCandidateReview, ArticlePackageCandidateReviewPageRequest } from '@/api/types/articlePackageCandidateReview';

defineOptions({ name: 'ArticlePackageCandidateReview', inheritAttrs: false });
const props = withDefaults(defineProps<{
    review?: ArticlePackageCandidateReview | null;
    state?: 'ready' | 'loading' | 'error';
    stale?: boolean;
}>(), { review: null, state: 'ready', stale: false });
const emit = defineEmits<{
    'request-page': [request: ArticlePackageCandidateReviewPageRequest];
}>();
const id = useId();
const rootRef = ref<HTMLElement>();
const titleRef = ref<HTMLElement>();
const targetsRef = ref<HTMLElement>();
const requestedPage = ref<ArticlePackageCandidateReviewPageRequest | null>(null);
const executionRefusal = 'article_package_import_authority_unavailable';

// Display-budget checks only. The original backend owns candidate parsing and authority.
// Refuse unsafe or oversized supplied read models before rendering any of their fields.
function isBounded(review: ArticlePackageCandidateReview): boolean
{
    const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
    const integer = (value: unknown, min: number, max: number): boolean => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
    const summary = review.summary;
    return review.candidateStatus === 'finite_bytes_validated'
        && review.executeDisabled === true && review.executionReasonCode === executionRefusal
        && ['CreateNew', 'UpdateRequested'].includes(review.requestedMode)
        && ['caller_interval_not_started', 'caller_interval_current', 'caller_interval_expired'].includes(review.intervalStatus)
        && integer(review.pageSize, 1, 50) && integer(review.totalTargets, 1, 1000)
        && integer(review.pageIndex, 0, Math.ceil(review.totalTargets / review.pageSize) - 1)
        && text(review.planDigest, 64) && text(review.policyDigest, 64)
        && text(review.createdAtUtc, 40) && text(review.expiresAtUtc, 40)
        && !!summary && integer(summary.articleCount, 1, 1000) && summary.articleCount === review.totalTargets
        && integer(summary.fileCount, 3, 1002)
        && [summary.schemaVersion, summary.canonicalHashVersion, summary.propertySchemaVersion].every(value => integer(value, 1, 2147483647))
        && [summary.packageBytesDigest, summary.manifestSemanticDigest, summary.checksumComponentDigest].every(value => text(value, 64))
        && Array.isArray(review.targets)
        && review.targets.length === Math.min(review.pageSize, review.totalTargets - review.pageIndex * review.pageSize)
        && review.targets.every(target => target && text(target.portableArticle, 128)
            && typeof target.requiresNewIdentity === 'boolean'
            && (target.requestedTargetArticleId === null || integer(target.requestedTargetArticleId, 1, 2147483647))
            && (target.expectedTargetRevision === null || (text(target.expectedTargetRevision, 19) && /^[1-9][0-9]*$/u.test(target.expectedTargetRevision)))
        )
        && Array.isArray(review.requiredAuthorities) && review.requiredAuthorities.length > 0 && review.requiredAuthorities.length <= 16
        && review.requiredAuthorities.every(value => text(value, 128));
}

const boundedReview = computed(() => props.review && isBounded(props.review) ? props.review : null);
const invalidReview = computed(() => props.review !== null && !boundedReview.value);
const pageCount = computed(() => boundedReview.value ? Math.ceil(boundedReview.value.totalTargets / boundedReview.value.pageSize) : 0);
const pagePending = computed(() => requestedPage.value !== null || props.state === 'loading');

function requestPage(pageIndex: number): void
{
    const review = boundedReview.value;
    if (!review || pagePending.value || pageIndex < 0 || pageIndex >= pageCount.value)
    {
        return;
    }
    requestedPage.value = { planDigest: review.planDigest, pageIndex, pageSize: review.pageSize };
    emit('request-page', requestedPage.value);
}

watch(() => [props.review, props.state] as const, async ([review, state], [previous]) =>
{
    const ownedFocus = rootRef.value?.contains(document.activeElement);
    const request = requestedPage.value;
    const arrived = state === 'ready' && review?.planDigest === request?.planDigest && review?.pageIndex === request?.pageIndex;
    const replaced = review?.planDigest !== previous?.planDigest;
    const failed = state === 'error' || invalidReview.value || !review;
    if (arrived || replaced || failed)
    {
        requestedPage.value = null;
        await nextTick();
        if (ownedFocus)
        {
            (arrived && boundedReview.value ? targetsRef.value : titleRef.value)?.focus();
        }
    }
});
</script>

<style scoped>
.package-review
{
    min-width: 0;
    color: var(--el-text-color-primary);
    overflow-wrap: anywhere;
}

.package-review__summary
{
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: var(--fsus-space-2) var(--fsus-space-4);
}

.package-review__summary dd
{
    margin: 0;
    min-width: 0;
}

.package-review__targets
{
    padding-inline-start: var(--fsus-space-6);
}

.package-review__pages
{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-2);
}

@media (width <= 639px)
{
    .package-review__summary
    {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
