<template>
  <div class="settings-container max-w-6xl mx-auto p-2 sm:p-4">
    <el-alert 
      title="高权限管理模式" 
      type="warning" 
      show-icon 
      :closable="false"
      class="mb-4 sm:mb-6 shadow-sm border-none ring-1 ring-amber-100 bg-amber-50!"
    >
      <p class="text-xs text-amber-700 mt-1 leading-relaxed">
        封面更换将自动触发 **服务器磁盘清理**。若同步至 Redis 失败，系统将尝试 **自动恢复** 状态快照。
      </p>
    </el-alert>

    <el-tabs v-model="activeTab" type="border-card" class="rounded-xl! overflow-hidden shadow-sm">
      <el-tab-pane label="SEO 配置" name="site">
        <div class="p-4 sm:p-8">
          <el-form :model="siteForm" label-position="top" class="max-w-3xl" @submit.prevent>
            <el-row :gutter="20">
              <el-col :xs="24" :sm="12">
                <el-form-item label="网站标题" required>
                  <el-input v-model="siteForm.title" maxlength="50" show-word-limit placeholder="Fsus's Blog" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="作者名称" required>
                  <el-input v-model="siteForm.author" maxlength="20" placeholder="Fsu" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="站点基础 URL" required>
              <el-input v-model="siteForm.baseUrl" placeholder="https://fsus.blog">
                <template #prepend>URL</template>
              </el-input>
              <div class="text-[11px] text-zinc-400 mt-2 font-medium">
                用于生成 RSS 订阅、邮件通知及绝对路径资源。结尾请勿携带斜杠 /
              </div>
            </el-form-item>

            <el-form-item label="社交媒体预览图 (OgImage)">
              <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6">
                <el-upload 
                  action="#" 
                  :http-request="handleImageAction" 
                  :show-file-list="false" 
                  accept="image/*"
                  v-loading="imageLoading"
                  class="w-full sm:w-auto"
                >
                  <div v-if="displayUrl" class="relative group w-full sm:w-60 aspect-video rounded-lg overflow-hidden border border-zinc-200 shadow-sm bg-zinc-50">
                    <img :src="displayUrl" class="w-full h-full object-cover" />
                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all cursor-pointer">
                      <el-icon class="text-white text-2xl"><Edit /></el-icon>
                    </div>
                  </div>
                  <div v-else class="w-full sm:w-60 aspect-video border-2 border-dashed border-zinc-200 rounded-lg flex flex-col items-center justify-center text-zinc-400 hover:border-blue-400 transition-all cursor-pointer bg-zinc-50">
                    <el-icon size="24"><Plus /></el-icon>
                    <span class="text-xs mt-2 font-medium">点击上传封面图</span>
                  </div>
                </el-upload>
                
                <div class="flex-1 flex flex-col items-center sm:items-start text-center sm:text-left">
                  <p class="text-[12px] text-zinc-400 leading-relaxed mb-4">
                    建议尺寸 1200x630px。<br/>
                    更换预览图将自动同步 SEO 路径，无需手动保存文字。
                  </p>
                  <el-button 
                    v-if="siteForm.ogImage" 
                    type="danger" 
                    link 
                    :icon="Delete" 
                    @click="handleImageRemove"
                    :disabled="imageLoading"
                  >
                    物理删除文件并重置
                  </el-button>
                </div>
              </div>
            </el-form-item>

            <el-form-item label="SEO 描述 (Description)">
              <el-input v-model="siteForm.description" type="textarea" :rows="3" maxlength="200" show-word-limit />
            </el-form-item>

            <el-form-item label="关键词 (Keywords)">
              <el-input v-model="siteForm.keywords" @blur="sanitizeKeywords" placeholder="英文逗号分隔" />
              <div class="flex gap-2 mt-3 flex-wrap">
                <el-tag v-for="tag in computedKeywords" :key="tag" size="small" type="info" class="rounded-md">{{ tag }}</el-tag>
              </div>
            </el-form-item>

            <div class="mt-8 pt-6 border-t border-zinc-100 flex justify-center sm:justify-end">
              <el-button type="primary" :loading="savingSite" @click="saveSiteConfig" class="w-full sm:w-auto px-10 font-bold">保存文本配置</el-button>
            </div>
          </el-form>
        </div>
      </el-tab-pane>

      <el-tab-pane label="页面编辑" name="pages">
        <div class="p-2 sm:p-6 flex flex-col gap-5">
          <div class="flex flex-col sm:flex-row items-center gap-4 bg-zinc-50 p-4 rounded-lg border border-zinc-100">
            <span class="text-sm font-bold text-zinc-600">编辑目标:</span>
            <el-radio-group v-model="currentSlug" size="small" class="flex flex-wrap justify-center">
                <el-radio-button value="about">关于我</el-radio-button>
                <el-radio-button value="privacy">隐私政策</el-radio-button>
                <el-radio-button value="guidelines">用户守则</el-radio-button>
            </el-radio-group>
          </div>
          <div class="editor-container rounded-xl border overflow-hidden" v-loading="pageLoading">
            <md-editor v-model="pageContent" preview-theme="github" class="h-112.5 sm:h-150!" />
          </div>
          <div class="flex justify-center sm:justify-end pt-2">
            <el-button type="primary" size="large" :loading="savingPage" @click="savePageContent" class="w-full sm:w-auto px-12 font-bold shadow-lg">发布更新</el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, Delete } from '@element-plus/icons-vue'
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { getSiteConfig, updateSiteConfig, getPageData, updatePageData, uploadImage, deleteImage } from '@/api/system'

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
  baseUrl: '' // 站点基础 URL
})

// 自动恢复快照
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
  if (siteForm.keywords) siteForm.keywords = siteForm.keywords.replace(/，/g, ',')
}

// --- 核心方法 ---

/**
 * 原子化同步配置
 */
const syncSeoConfig = async () => {
  try {
    // 逻辑自洽：发送前移除 URL 末尾可能的斜杠
    if (siteForm.baseUrl) {
      siteForm.baseUrl = siteForm.baseUrl.replace(/\/+$/, '');
    }
    const payload = JSON.parse(JSON.stringify(siteForm));
    await updateSiteConfig(payload);
  } catch (err) {
    siteForm.ogImage = previousOgImage.value;
    ElMessage.warning('配置同步至服务器失败，预览已回滚');
    throw err;
  }
}

// 处理图片上传
const handleImageAction = async (options: any) => {
  imageLoading.value = true;
  previousOgImage.value = siteForm.ogImage;
  
  try {
    const res: any = await uploadImage(options.file);
    const data = res.data || res;
    
    siteForm.ogImage = data.relativeUrl || data.url;
    
    await nextTick();
    await syncSeoConfig();
    
    ElMessage.success('预览图已同步更新');
  } catch (err) {
    console.error("Image Upload sync error:", err);
  } finally {
    imageLoading.value = false;
  }
}

// 处理图片删除
const handleImageRemove = async () => {
  try {
    await ElMessageBox.confirm('彻底删除物理文件并重置封面吗？', '严正警告', { 
      type: 'error',
      confirmButtonClass: 'el-button--danger'
    });
    
    imageLoading.value = true;
    previousOgImage.value = siteForm.ogImage;
    
    await deleteImage(siteForm.ogImage);
    siteForm.ogImage = '';
    
    await nextTick();
    await syncSeoConfig();
    
    ElMessage.success('配置已重置');
  } catch (err) {
  } finally {
    imageLoading.value = false;
  }
}

// 文字配置保存
const saveSiteConfig = async () => {
  if (!siteForm.title) return ElMessage.warning('网站标题不能为空');
  if (!siteForm.baseUrl) return ElMessage.warning('站点基础 URL 不能为空');
  
  savingSite.value = true;
  try {
    await syncSeoConfig();
    ElMessage.success('文字配置保存成功');
  } finally {
    savingSite.value = false;
  }
}

// 初始化加载
const loadSiteConfig = async () => {
  try {
    const res: any = await getSiteConfig();
    const data = res.data || res;
    if (data) {
      siteForm.title = data.title || data.Title || '';
      siteForm.description = data.description || data.Description || '';
      siteForm.keywords = data.keywords || data.Keywords || '';
      siteForm.author = data.author || data.Author || '';
      siteForm.ogImage = data.ogImage || data.OgImage || '';
      siteForm.baseUrl = data.baseUrl || data.BaseUrl || '';
    }
  } catch (err) {}
}

const loadPage = async (slug: string) => {
  pageLoading.value = true;
  try {
    const res: any = await getPageData(slug);
    const data = res.data || res;
    pageContent.value = data?.content || '';
  } finally { pageLoading.value = false; }
}

const savePageContent = async () => {
  try {
    await ElMessageBox.confirm('确定要发布更新吗？', '确认操作', { type: 'warning' });
    savingPage.value = true;
    await updatePageData({ slug: currentSlug.value, content: pageContent.value });
    ElMessage.success('发布成功');
  } catch (err) {} finally { savingPage.value = false; }
}

watch(currentSlug, (val) => loadPage(val), { immediate: true })
onMounted(loadSiteConfig)
</script>

<style scoped>
.settings-container { animation: slide-in-top 0.4s ease-out; }
@keyframes slide-in-top { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

:deep(.el-tabs--border-card) { border-radius: 12px; border: none; }

/* 响应式调整 */
@media (max-width: 640px) {
  :deep(.el-form-item__label) { padding-bottom: 4px; font-weight: 600; }
  .editor-container :deep(.md-editor) { height: 400px !important; }
}
</style>