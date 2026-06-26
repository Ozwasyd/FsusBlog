<template>
  <div class="space-y-8">
    <section
      class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
    >
      <div
        class="flex flex-col gap-5 border-b border-[var(--fsusblog-panel-border)] p-5 lg:flex-row lg:items-end lg:justify-between"
      >
        <div>
          <div
            class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
          >
            地区
          </div>
          <h2
            class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]"
          >
            地区定义与生效策略
          </h2>
          <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">
            默认策略模板是工程预设，不构成法律建议。
          </p>
        </div>
        <el-button :icon="Refresh" :loading="loading" @click="loadRegions"
          >刷新</el-button
        >
      </div>

      <FsusUiDataList
        class="moderation-regions-mobile-list"
        :rows="regions"
        :columns="regionMobileColumns"
        row-key="regionCode"
        :active-key="selectedRegionCode"
        :loading-key="previewLoadingRegion"
        :href="regionPreviewHrefForRow"
        density="compact"
        aria-label="地区定义列表"
        @row-click="handleMobileRegionClick"
      >
        <template #cell="{ row, column, active }">
          <span
            v-if="column.key === 'region'"
            class="moderation-regions-mobile-cell moderation-regions-mobile-cell--name"
            :title="getRegionCode(row)"
          >
            {{ formatRegionName(getRegionCode(row)) }}
          </span>
          <span
            v-else-if="column.key === 'scope'"
            class="moderation-regions-mobile-cell moderation-regions-mobile-cell--muted"
            :title="getRegionDisplayName(row)"
          >
            {{ formatRegionScope(row as ModerationRegionDefinition) }}
          </span>
          <span
            v-else
            class="moderation-regions-mobile-cell moderation-regions-mobile-cell--action"
            :class="{ 'is-active': active }"
          >
            {{ active ? "查看中" : "查看" }}
          </span>
        </template>
        <template #empty>
          <AdminInlineEmptyState
            v-if="!loading"
            title="暂无地区定义"
            description="内置或自定义地区载入后，会在这里显示生效策略入口。"
          />
        </template>
      </FsusUiDataList>

      <div class="blog-scroll-x-safe moderation-regions-table-scroll">
        <el-table
          ref="regionsTableRef"
          v-loading="loading"
          :data="regions"
          row-key="regionCode"
          highlight-current-row
          @current-change="selectRegion"
          @row-click="selectRegion"
        >
          <el-table-column
            label="地区"
            min-width="150"
            class-name="moderation-region-table-cell"
          >
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <span class="moderation-region-name" :title="row.regionCode">{{
                formatRegionName(row.regionCode)
              }}</span>
            </template>
          </el-table-column>
          <el-table-column label="范围" min-width="120">
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <span
                class="moderation-region-name moderation-region-name--muted"
                :title="row.displayName"
                >{{ formatRegionScope(row) }}</span
              >
            </template>
          </el-table-column>
          <el-table-column
            label="上级地区"
            width="130"
            class-name="moderation-region-table__secondary"
            label-class-name="moderation-region-table__secondary"
          >
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <span
                class="moderation-region-name moderation-region-name--muted"
                :title="row.parentRegion ?? undefined"
              >
                {{
                  row.parentRegion ? formatRegionName(row.parentRegion) : "无"
                }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="所属大区"
            width="160"
            class-name="moderation-region-table__secondary"
            label-class-name="moderation-region-table__secondary"
          >
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <span
                class="moderation-region-name moderation-region-name--muted"
                :title="row.primaryGroup ?? undefined"
              >
                {{
                  row.primaryGroup ? formatRegionName(row.primaryGroup) : "无"
                }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="策略模板"
            min-width="210"
            class-name="moderation-region-table__secondary"
            label-class-name="moderation-region-table__secondary"
          >
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <span
                class="moderation-region-name moderation-region-name--muted"
                :title="row.policyTemplate ?? undefined"
              >
                {{
                  row.policyTemplate
                    ? formatPolicyTemplate(row.policyTemplate)
                    : "无"
                }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="120"
            class-name="moderation-region-table__secondary"
            label-class-name="moderation-region-table__secondary"
          >
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{
                row.enabled ? "已启用" : "已关闭"
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="来源类型"
            width="110"
            class-name="moderation-region-table__secondary"
            label-class-name="moderation-region-table__secondary"
          >
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <el-tag :type="row.builtin ? 'info' : 'warning'">{{
                row.builtin ? "内置" : "自定义"
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="96" align="right">
            <template #default="{ row }: { row: ModerationRegionDefinition }">
              <a
                class="moderation-region-preview-link"
                :class="{
                  'is-active': selectedRegionCode === row.regionCode,
                  'is-loading': previewLoadingRegion === row.regionCode,
                }"
                :href="regionPreviewHref(row.regionCode)"
                :data-region-code="row.regionCode"
                @click.prevent.stop="previewRegion(row.regionCode)"
              >
                {{ selectedRegionCode === row.regionCode ? "查看中" : "查看" }}
              </a>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState
              title="暂无地区定义"
              description="内置或自定义地区载入后，会在这里显示生效策略入口。"
            />
          </template>
        </el-table>
      </div>
    </section>

    <section
      ref="previewSectionRef"
      class="grid gap-8 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1fr)]"
    >
      <section
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
      >
        <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
          <div
            class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
          >
            继承链
          </div>
        </div>
        <div class="divide-y divide-[var(--fsusblog-panel-border)]">
          <div
            v-for="step in preview?.inheritance ?? []"
            :key="`${step.step}:${step.sourceId}`"
            class="p-5"
          >
            <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">
              {{ step.step }}
            </div>
            <div class="mt-1 text-[12px] text-[var(--fsusblog-text-muted)]">
              来源：{{ formatSourceType(step.sourceType) }}；{{
                formatSourceId(step.sourceId)
              }}；规则：{{ step.rules.length }} 条
            </div>
          </div>
          <div
            v-if="!preview"
            class="p-5 text-[12px] text-[var(--fsusblog-text-muted)]"
          >
            选择地区查看生效策略。
          </div>
        </div>
      </section>

      <section
        class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
      >
        <div
          class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fsusblog-panel-border)] p-5"
        >
          <div>
            <div
              class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
            >
              生效规则
            </div>
            <div class="moderation-regions-preview-meta">
              <span>地区：{{ formatRegionName(preview?.region) }}</span>
              <span
                class="moderation-regions-preview-meta__checksum"
                :title="preview?.checksum ?? undefined"
              >
                校验值：{{ formatChecksum(preview?.checksum) }}
              </span>
            </div>
          </div>
          <el-tag
            v-for="warning in preview?.warnings ?? []"
            :key="warning"
            type="warning"
            >{{ warning }}</el-tag
          >
        </div>
        <div class="blog-scroll-x-safe moderation-regions-rules-scroll">
          <el-table :data="preview?.rules ?? []" row-key="category">
            <el-table-column label="分类" min-width="180">
              <template
                #default="{ row }: { row: ModerationEffectivePolicyRule }"
              >
                <span class="moderation-region-name" :title="row.category">{{
                  formatRiskCategory(row.category)
                }}</span>
              </template>
            </el-table-column>
            <el-table-column label="提交动作" width="180">
              <template
                #default="{ row }: { row: ModerationEffectivePolicyRule }"
              >
                <span
                  class="moderation-region-name moderation-region-name--muted"
                  :title="row.submitAction"
                >
                  {{ formatPolicyAction(row.submitAction) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="展示动作" width="190">
              <template
                #default="{ row }: { row: ModerationEffectivePolicyRule }"
              >
                <span
                  class="moderation-region-name moderation-region-name--muted"
                  :title="row.displayAction"
                >
                  {{ formatPolicyAction(row.displayAction) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="来源" min-width="180">
              <template
                #default="{ row }: { row: ModerationEffectivePolicyRule }"
              >
                来源：{{ formatSourceType(row.sourceType) }}；{{
                  formatSourceId(row.sourceId)
                }}
              </template>
            </el-table-column>
            <template #empty>
              <AdminInlineEmptyState
                :title="preview ? '暂无生效规则' : '选择地区查看生效规则'"
                :description="
                  preview
                    ? '当前地区没有返回可展示的提交或展示动作规则。'
                    : '选择左侧地区后显示继承链计算出的生效规则。'
                "
              />
            </template>
          </el-table>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  getModerationEffectivePolicy,
  listModerationRegions,
  type ModerationEffectivePolicyPreview,
  type ModerationEffectivePolicyRule,
  type ModerationRegionDefinition,
} from "@/api/authoring";
import AdminInlineEmptyState from "@/components/admin/AdminInlineEmptyState.vue";
import {
  FsusUiDataList,
  type FsusUiDataListColumn,
  type FsusUiDataListRow,
  type FsusUiDataListRowKey,
} from "@/fsusui";
import { Refresh } from "@/fsusui/icons";
import { showErrorToast } from "@/utils/errorPresentation";
import {
  formatModerationRegionName,
  formatModerationRegionVersion,
  formatModerationAction,
  formatModerationRiskCategory,
  formatModerationSourceType,
} from "@/utils/moderationRegionDisplay";

const loading = shallowRef(false);
const route = useRoute();
const router = useRouter();
const regions = shallowRef<ModerationRegionDefinition[]>([]);
const preview = shallowRef<ModerationEffectivePolicyPreview | null>(null);
const previewLoadingRegion = shallowRef<string | null>(null);
const selectedRegionCode = shallowRef<string | null>(null);
const previewSectionRef = shallowRef<HTMLElement | null>(null);
type RegionsTableInstance = {
  setCurrentRow: (row?: ModerationRegionDefinition) => void;
};
const regionsTableRef = shallowRef<RegionsTableInstance | null>(null);
const regionMobileColumns: FsusUiDataListColumn[] = [
  { key: "region", label: "地区", grid: "minmax(0, 1.15fr)" },
  { key: "scope", label: "范围", grid: "minmax(0, 1fr)" },
  { key: "action", label: "操作", grid: "minmax(4rem, auto)", align: "end" },
];

const formatRegionName = (region?: string | null): string =>
  formatModerationRegionName(region);
const formatSourceType = (sourceType?: string | null): string =>
  formatModerationSourceType(sourceType);
const formatPolicyTemplate = (template: string): string =>
  formatModerationRegionVersion(template);
const formatRiskCategory = (category: string): string =>
  formatModerationRiskCategory(category);
const formatPolicyAction = (action: string): string =>
  formatModerationAction(action);
const formatChecksum = (checksum?: string | null): string => {
  if (!checksum) return "无";
  return checksum.length > 12
    ? `${checksum.slice(0, 8)}...${checksum.slice(-4)}`
    : checksum;
};

const formatRegionScope = (region: ModerationRegionDefinition): string => {
  if (region.regionCode === "GLOBAL") return "默认策略";
  if (region.regionCode === "UNKNOWN") return "未知来源";
  if (region.regionCode.startsWith("EU-")) return "欧盟成员";
  if (region.regionCode.startsWith("US-")) return "美国州级";
  if (region.parentRegion) return "子地区";
  return "独立地区";
};

const formatSourceId = (sourceId?: string | null): string => {
  if (!sourceId) return "无来源";
  const regionName = formatModerationRegionName(sourceId);
  if (regionName !== sourceId) return regionName;
  const version = formatModerationRegionVersion(sourceId);
  return version !== sourceId ? version : sourceId;
};

const getRouteRegion = (): string | null =>
  typeof route.query.region === "string" ? route.query.region : null;

const regionPreviewHref = (regionCode: string): string => {
  return router.resolve({
    path: route.path,
    query: {
      ...route.query,
      region: regionCode,
    },
  }).href;
};

const getRegionCode = (row: FsusUiDataListRow): string =>
  String(row.regionCode ?? "");
const getRegionDisplayName = (row: FsusUiDataListRow): string =>
  String(row.displayName ?? "");
const regionPreviewHrefForRow = (row: FsusUiDataListRow): string =>
  regionPreviewHref(getRegionCode(row));
const handleMobileRegionClick = (
  _row: FsusUiDataListRow,
  key: FsusUiDataListRowKey,
  event: MouseEvent,
): void => {
  event.preventDefault();
  void previewRegion(String(key));
};

const loadRegions = async (): Promise<void> => {
  loading.value = true;
  try {
    regions.value = await listModerationRegions();
    if (regions.value.length === 0) return;

    const requestedRegion = getRouteRegion();
    const initialRegion =
      requestedRegion &&
      regions.value.some((region) => region.regionCode === requestedRegion)
        ? requestedRegion
        : regions.value[0]!.regionCode;

    if (initialRegion !== selectedRegionCode.value) {
      await loadPreview(initialRegion);
    }
  } catch (error) {
    showErrorToast(error, "地区定义加载失败");
  } finally {
    loading.value = false;
  }
};

const selectRegion = (row?: ModerationRegionDefinition): void => {
  if (row) {
    void loadPreview(row.regionCode);
  }
};

const previewRegion = async (regionCode: string): Promise<void> => {
  if (regionCode !== getRouteRegion()) {
    await router.push({
      path: route.path,
      query: {
        ...route.query,
        region: regionCode,
      },
    });
    return;
  }

  if (regionCode !== selectedRegionCode.value) {
    await loadPreview(regionCode, { reveal: true });
  }
};

const loadPreview = async (
  regionCode: string,
  options: { reveal?: boolean } = {},
): Promise<void> => {
  previewLoadingRegion.value = regionCode;
  try {
    preview.value = await getModerationEffectivePolicy(regionCode);
    selectedRegionCode.value = regionCode;
    await nextTick();
    regionsTableRef.value?.setCurrentRow(
      regions.value.find((region) => region.regionCode === regionCode),
    );
    if (options.reveal) {
      previewSectionRef.value?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  } catch (error) {
    showErrorToast(error, "生效策略预览加载失败");
  } finally {
    previewLoadingRegion.value = null;
  }
};

onMounted(() => {
  void loadRegions();
});

watch(
  () => route.query.region,
  (region) => {
    if (typeof region !== "string") return;
    if (region === selectedRegionCode.value) return;
    if (!regions.value.some((item) => item.regionCode === region)) return;

    void loadPreview(region, { reveal: true });
  },
);
</script>

<style scoped>
.moderation-regions-table-scroll,
.moderation-regions-rules-scroll {
  max-width: 100%;
  overflow-x: auto;
}

.moderation-regions-mobile-list {
  display: none;
}

.moderation-region-name {
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  color: var(--fsusblog-text-primary);
}

.moderation-region-name--muted {
  color: var(--fsusblog-text-muted);
}

.moderation-region-preview-link {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: flex-end;
  color: var(--fsusblog-text-muted);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  text-decoration: none;
}

.moderation-region-preview-link:hover,
.moderation-region-preview-link.is-active {
  color: var(--fsusblog-text-primary);
}

.moderation-region-preview-link.is-loading {
  pointer-events: none;
  opacity: 0.62;
}

:deep(.moderation-region-table-cell .cell) {
  display: flex;
  align-items: center;
  min-height: 24px;
}

@media (max-width: 768px) {
  .moderation-regions-table-scroll {
    display: none;
  }

  .moderation-regions-mobile-list {
    display: grid;
  }
}

.moderation-regions-mobile-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.moderation-regions-mobile-cell--name {
  font-weight: 760;
}

.moderation-regions-mobile-cell--muted,
.moderation-regions-mobile-cell--action {
  color: var(--fsusblog-text-muted);
  font-weight: 700;
}

.moderation-regions-mobile-cell--action.is-active {
  color: var(--fsusblog-text-primary);
}

.moderation-regions-preview-meta {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 4px;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--fsusblog-text-primary);
}

.moderation-regions-preview-meta__checksum {
  min-width: 0;
  max-width: min(100%, 32rem);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fsusblog-text-muted);
}
</style>
