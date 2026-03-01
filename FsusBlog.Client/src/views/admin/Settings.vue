<template>
  <div class="settings-container max-w-6xl mx-auto p-2 sm:p-4">
    <!-- 顶部状态提示 -->
    <el-alert 
      title="高权限管理模式" 
      type="warning" 
      show-icon 
      :closable="false"
      class="mb-4 sm:mb-6 shadow-sm border-none ring-1 ring-amber-100 bg-amber-50!"
    >
      <p class="text-xs text-amber-700 mt-1 leading-relaxed">
        封面更换将自动触发物理磁盘清理。若同步至持久化层失败，系统将执行原子化回滚以保护 SEO 状态。
      </p>
    </el-alert>

    <el-tabs v-model="activeTab" type="border-card" class="rounded-xl! overflow-hidden shadow-sm">
      <!-- 站点 SEO 配置面板 -->
      <el-tab-pane label="SEO 配置" name="site">
        <div class="p-4 sm:p-8">
          <el-form :model="siteForm" label-position="top" class="max-w-3xl" @submit.prevent novalidate>
            <el-row :gutter="20">
              <el-col :xs="24" :sm="12">
                <el-form-item label="网站标题" required>
                  <el-input v-model="siteForm.title" maxlength="50" show-word-limit placeholder="Fsus's Blog" :disabled="savingSite" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="作者名称" required>
                  <el-input v-model="siteForm.author" maxlength="20" placeholder="Fsu" :disabled="savingSite" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="站点基础 URL" required>
              <el-input v-model="siteForm.baseUrl" placeholder="https://fsus.blog" :disabled="savingSite">
                <template #prepend>URL</template>
              </el-input>
              <div class="text-[11px] text-zinc-400 mt-2 font-medium">
                用于生成 RSS、邮件通知及绝对路径资源。物理规则：必须以 http/https 开头，末尾禁止携带斜杠 /
              </div>
            </el-form-item>

            <el-form-item label="社交媒体预览图 (OgImage)">
              <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6">
                <el-upload 
                  action="#" 
                  :http-request="handleImageAction" 
                  :show-file-list="false" 
                  accept="image/*"
                  :disabled="imageLoading"
                  class="w-full sm:w-auto"
                >
                  <div v-loading="imageLoading" class="w-full sm:w-60 aspect-video rounded-lg overflow-hidden border border-zinc-200 shadow-sm bg-zinc-50 transition-all hover:border-blue-400">
                    <img v-if="displayUrl" :src="displayUrl" class="w-full h-full object-cover" />
                    <div v-else class="h-full flex flex-col items-center justify-center text-zinc-400">
                      <el-icon size="24"><Plus /></el-icon>
                      <span class="text-xs mt-2 font-medium uppercase tracking-widest">Upload Cover</span>
                    </div>
                  </div>
                </el-upload>
                
                <div class="flex-1 flex flex-col items-center sm:items-start text-center sm:text-left">
                  <p class="text-[11px] text-zinc-400 leading-relaxed mb-4 italic">
                    建议尺寸 1200x630px。变更将触发算力防御拦截。
                  </p>
                  <el-button 
                    v-if="siteForm.ogImage" 
                    type="danger" 
                    link 
                    @click="handleImageRemove"
                    :disabled="imageLoading"
                  >
                    <el-icon class="mr-1"><Delete /></el-icon>物理删除文件并重置
                  </el-button>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="SEO 描述 (Description)">
              <el-input v-model="siteForm.description" type="textarea" :rows="3" maxlength="200" show-word-limit :disabled="savingSite" />
            </el-form-item>

            <el-form-item label="关键词 (Keywords)">
              <el-input v-model="siteForm.keywords" @blur="sanitizeKeywords" placeholder="英文逗号分隔" :disabled="savingSite" />
              <div class="flex gap-2 mt-3 flex-wrap">
                <el-tag v-for="tag in computedKeywords" :key="tag" size="small" type="info" class="rounded-md tabular-nums border-zinc-100">
                  {{ tag }}
                </el-tag>
              </div>
            </el-form-item>

            <div class="mt-8 pt-6 border-t border-zinc-100 flex justify-center sm:justify-end">
              <el-button 
                type="primary" 
                :loading="savingSite" 
                @click="saveSiteConfig" 
                class="w-full sm:w-auto px-10 font-bold shadow-lg shadow-blue-50"
              >
                保存同步
              </el-button>
            </div>
          </el-form>
        </div>
      </el-tab-pane>

      <!-- 动态页面编辑面板 -->
      <el-tab-pane label="页面编辑" name="pages">
        <div class="p-2 sm:p-6 flex flex-col gap-5">
          <div class="flex flex-col sm:flex-row items-center gap-4 bg-zinc-50 p-4 rounded-lg border border-zinc-100">
            <span class="text-sm font-bold text-zinc-600 select-none">编辑目标:</span>
            <el-radio-group v-model="currentSlug" size="small" class="flex flex-wrap justify-center" :disabled="pageLoading">
                <el-radio-button value="about">关于我</el-radio-button>
                <el-radio-button value="privacy">隐私政策</el-radio-button>
                <el-radio-button value="guidelines">用户守则</el-radio-button>
            </el-radio-group>
          </div>
          <div class="editor-container rounded-xl border border-zinc-200 overflow-hidden" v-loading="pageLoading">
            <md-editor v-model="pageContent" preview-theme="github" class="h-112.5 sm:h-150!" />
          </div>
          <div class="flex justify-center sm:justify-end pt-2">
            <el-button 
              type="primary" 
              size="large" 
              :loading="savingPage" 
              @click="savePageContent" 
              class="w-full sm:w-auto px-12 font-bold shadow-lg shadow-blue-50"
            >
              发布更新
            </el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
// [修复 2026-02-24] 补全 nextTick 导入，解决 TS 2304 错误
import { ref, reactive, computed, onMounted, watch, onUnmounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Delete } from '@element-plus/icons-vue'
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { getSiteConfig, updateSiteConfig, getPageData, updatePageData, uploadImage, deleteImage } from '@/api/system'
import type { AxiosRequestConfig } from 'axios'

const baseURL = import.meta.env.VITE_API_BASE_URL || window.location.origin;

// --- 状态管理 ---
const activeTab = ref('site')
const savingSite = ref(false)
const savingPage = ref(false)
const pageLoading = ref(false)
const imageLoading = ref(false)

const siteForm = reactive({
  title: '', 
  description: '', 
  keywords: '', 
  author: '', 
  ogImage: '',
  baseUrl: '' 
})

let siteController: AbortController | null = null
let pageController: AbortController | null = null
let uploadController: AbortController | null = null
let initialLoadController: AbortController | null = null

const previousOgImage = ref('')
const currentSlug = ref('about')
const pageContent = ref('')

// --- 计算属性 ---
const displayUrl = computed(() => {
  if (!siteForm.ogImage) return '';
  return siteForm.ogImage.startsWith('http') ? siteForm.ogImage : `${baseURL}${siteForm.ogImage}`;
})

const computedKeywords = computed(() => 
  siteForm.keywords ? siteForm.keywords.split(',').map(s => s.trim()).filter(s => s) : []
)

const sanitizeKeywords = () => {
  if (siteForm.keywords) {
    const raw = siteForm.keywords.replace(/，/g, ',').replace(/[<>"/\\`]/g, '');
    siteForm.keywords = Array.from(new Set(
      raw.split(',')
    )).map(s => s.trim()).filter(s => s).join(',');
  }
}

const validateBaseUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// --- 核心方法 ---

const syncSeoConfig = async (signal?: AbortSignal) => {
  try {
    if (siteForm.baseUrl) {
      siteForm.baseUrl = siteForm.baseUrl.trim().replace(/\/+$/, '');
      if (!validateBaseUrl(siteForm.baseUrl)) {
          throw new Error('BASEURL_PROTOCOL_INVALID');
      }
    }
    
    const payload = { ...siteForm };
    await updateSiteConfig(payload, { signal } as AxiosRequestConfig);
    
    previousOgImage.value = siteForm.ogImage;
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      siteForm.ogImage = previousOgImage.value;
      const errorMsg = err.message === 'BASEURL_PROTOCOL_INVALID' ? '站点URL协议不合法' : '配置同步失败，已回退状态';
      ElMessage.warning(errorMsg);
      throw err;
    }
  }
}

const handleImageAction = async (options: any) => {
  if (uploadController) uploadController.abort()
  const currentController = new AbortController()
  uploadController = currentController
  const { signal } = currentController

  imageLoading.value = true;
  previousOgImage.value = siteForm.ogImage;
  
  try {
    const res = await uploadImage(options.file, { signal } as AxiosRequestConfig);
    if (currentController !== uploadController) return;

    const data = res;
    siteForm.ogImage = data.relativeUrl || data.url;
    
    // 信号解耦：SEO 同步不再依赖上传控制器的信号
    await nextTick();
    await syncSeoConfig();
    
    ElMessage.success('配置图已更新');
  } catch (err: any) {
    if (err.name !== 'AbortError') {
       console.error("[Settings] Upload failed:", err);
       siteForm.ogImage = previousOgImage.value;
    }
  } finally {
    if (uploadController === currentController) {
      imageLoading.value = false;
      uploadController = null;
    }
  }
}

const handleImageRemove = async () => {
  try {
    await ElMessageBox.confirm('彻底删除物理资源并重置封面吗？', '确认', { 
      type: 'error',
      confirmButtonClass: 'el-button--danger',
      dangerouslyUseHTMLString: false
    });
    
    imageLoading.value = true;
    previousOgImage.value = siteForm.ogImage;
    
    await deleteImage(siteForm.ogImage);
    siteForm.ogImage = '';
    
    await syncSeoConfig();
    ElMessage.success('已物理重置');
  } catch (err) {
  } finally {
    imageLoading.value = false;
  }
}

const saveSiteConfig = async () => {
  if (!siteForm.title.trim()) return ElMessage.warning('标题不可为空');
  if (!siteForm.baseUrl.trim() || !validateBaseUrl(siteForm.baseUrl)) {
      return ElMessage.warning('请提供合法的站点基础 URL (http/https)');
  }
  
  if (siteController) siteController.abort()
  const currentController = new AbortController()
  siteController = currentController
  const { signal } = currentController

  savingSite.value = true;
  try {
    await syncSeoConfig(signal);
    if (!signal.aborted) ElMessage.success('SEO 配置同步成功');
  } finally {
    if (siteController === currentController) {
       savingSite.value = false;
       siteController = null;
    }
  }
}

const loadSiteConfig = async () => {
  if (initialLoadController) initialLoadController.abort()
  const currentController = new AbortController()
  initialLoadController = currentController
  const { signal } = currentController

  try {
    const data = await getSiteConfig({ signal } as AxiosRequestConfig);
    if (initialLoadController === currentController && data) {
      siteForm.title = data.title || (data as any).Title || '';
      siteForm.description = data.description || (data as any).Description || '';
      siteForm.keywords = data.keywords || (data as any).Keywords || '';
      siteForm.author = data.author || (data as any).Author || '';
      siteForm.ogImage = data.ogImage || (data as any).OgImage || '';
      siteForm.baseUrl = data.baseUrl || (data as any).BaseUrl || '';
      previousOgImage.value = siteForm.ogImage;
    }
  } catch (err) {
    if ((err as any).name !== 'AbortError') console.error('[Settings] Fetch Error:', err);
  } finally {
    if (initialLoadController === currentController) initialLoadController = null;
  }
}

const loadPage = async (slug: string) => {
  if (pageController) pageController.abort()
  const currentController = new AbortController()
  pageController = currentController
  const { signal } = currentController

  pageLoading.value = true;
  try {
    const data = await getPageData(slug, { signal } as AxiosRequestConfig);
    if (pageController === currentController && !signal.aborted) {
      pageContent.value = data?.content || '';
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') console.error('[Settings] Load failed:', err);
  } finally { 
    if (pageController === currentController) {
      pageLoading.value = false; 
      pageController = null;
    }
  }
}

const savePageContent = async () => {
  try {
    await ElMessageBox.confirm('确定要发布页面更新吗？', '同步确认', { type: 'warning' });
    savingPage.value = true;
    await updatePageData({ slug: currentSlug.value, content: pageContent.value });
    ElMessage.success('发布同步成功');
  } catch (err) {
  } finally { 
    savingPage.value = false; 
  }
}

watch(currentSlug, (val) => loadPage(val), { immediate: true })

onMounted(loadSiteConfig)

onUnmounted(() => {
  if (siteController) siteController.abort()
  if (pageController) pageController.abort()
  if (uploadController) uploadController.abort()
  if (initialLoadController) initialLoadController.abort()
  
  pageContent.value = '';
})
</script>

<style scoped>
.settings-container { animation: slide-in-top 0.4s ease-out; }
@keyframes slide-in-top { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

:deep(.el-tabs--border-card) { border-radius: 12px; border: none; }

.editor-container :deep(.md-editor) {
  border: none !important;
}

@media (max-width: 640px) {
  :deep(.el-form-item__label) { padding-bottom: 4px; font-weight: 600; }
  .editor-container :deep(.md-editor) { height: 400px !important; }
}
</style>