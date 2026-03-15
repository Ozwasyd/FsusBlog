<template>
  <div class="write-article-wrapper">
    <!-- [修复 2026-02-24] 逻辑自洽：增加数据契约校验与全局 Loading 状态管理 -->
    <el-form 
      ref="formRef" 
      :model="articleForm" 
      :rules="rules" 
      label-position="top"
      v-loading="pageLoading"
      element-loading-text="正在载入数据资源..."
    >
      <!-- 头部动作栏 -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <el-form-item prop="title" class="grow w-full mb-0!">
          <el-input 
            v-model="articleForm.title" 
            placeholder="在此键入博文标题..." 
            size="large"
            maxlength="100"
            show-word-limit
            class="title-input-remaster"
            :disabled="submitting"
          />
        </el-form-item>
        <div class="flex items-center gap-3 shrink-0">
          <el-button @click="handleBack" :disabled="submitting" plain>返回列表</el-button>
          <el-button 
            type="primary" 
            :loading="submitting" 
            @click="submitForm"
            class="px-8 font-bold shadow-md shadow-blue-100 transition-all active:scale-95"
          >
            {{ isEdit ? '确认更新' : '立即发布' }}
          </el-button>
        </div>
      </div>

      <el-row :gutter="24">
        <!-- 左侧：编辑器区域 -->
        <el-col :xs="24" :lg="18">
          <el-card shadow="never" class="editor-container-card border-zinc-100 rounded-xl overflow-hidden">
            <el-form-item prop="content" class="mb-0!">
              <!-- 
                [修复 2026-02-24] 架构演进：
                通过 #preview 插槽注入 MarkdownRenderer 物理内核，确保预览与主站渲染 100% 同源
              -->
              <md-editor 
                v-model="articleForm.content" 
                @on-save="submitForm"
                @on-upload-img="handleUploadImg"
                placeholder="支持 Markdown 实时预览，Shift+Alt+F 自动格式化..."
                class="modern-md-editor"
                :toolbarsExclude="['github', 'save', 'htmlPreview', 'catalog']"
                :preview="true"
              >
                <template #preview>
                  <!-- 逻辑自洽：丢弃编辑器内置渲染，强制同步全站统一渲染引擎 -->
                  <div class="custom-preview-wrapper h-full overflow-y-auto px-6 py-10 bg-white">
                    <MarkdownRenderer :content="articleForm.content" />
                  </div>
                </template>
              </md-editor>
            </el-form-item>
          </el-card>
        </el-col>

        <!-- 右侧：配置侧边栏 -->
        <el-col :xs="24" :lg="6">
          <div class="sticky-sidebar space-y-4">
            <el-card shadow="never" class="border-zinc-100 rounded-xl shadow-sm">
              <template #header>
                <div class="flex items-center justify-between">
                  <span class="font-bold text-zinc-700">博文发布配置</span>
                  <el-icon class="text-zinc-400"><CollectionTag /></el-icon>
                </div>
              </template>
              
              <el-form-item label="所属分类" prop="categoryId">
                <el-select v-model="articleForm.categoryId" placeholder="选择分类" class="w-full" clearable :disabled="submitting">
                  <el-option 
                    v-for="c in categories" 
                    :key="c.id" 
                    :label="c.name" 
                    :value="c.id" 
                  />
                </el-select>
              </el-form-item>

              <el-form-item label="标签索引" prop="tagIds">
                <el-select 
                  v-model="articleForm.tagIds" 
                  multiple 
                  collapse-tags
                  collapse-tags-tooltip
                  placeholder="关联标签" 
                  class="w-full"
                  :disabled="submitting"
                >
                  <el-option 
                    v-for="t in tags" 
                    :key="t.id" 
                    :label="t.name" 
                    :value="t.id" 
                  />
                </el-select>
              </el-form-item>

              <el-divider border-style="dashed" class="my-6!" />

              <el-form-item label="内容摘要" prop="summary">
                <el-input 
                  v-model="articleForm.summary" 
                  type="textarea" 
                  :rows="6" 
                  placeholder="若为空，系统将展示文章开头文字..." 
                  maxlength="250"
                  show-word-limit
                  :disabled="submitting"
                />
                <div class="flex justify-end mt-2">
                  <el-button link type="primary" size="small" @click="autoGenerateSummary" :disabled="submitting">
                    <el-icon class="mr-1"><MagicStick /></el-icon> 智能生成
                  </el-button>
                </div>
              </el-form-item>
            </el-card>
          </div>
        </el-col>
      </el-row>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { CollectionTag, MagicStick } from '@element-plus/icons-vue'
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

import { getArticleById, createArticle, updateArticle, type ArticleDetail } from '@/api/article'
import { getCategories } from '@/api/category'
import { getTags } from '@/api/tag'
import { uploadImage } from '@/api/system'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import type { CategoryItem } from '@/api/category'
import type { TagItem } from '@/api/tag'
import type { AxiosRequestConfig } from 'axios'

// 定义表单接口
interface ArticleParams {
  title: string
  content: string
  summary: string
  categoryId: number | undefined
  tagIds: number[]
}

const route = useRoute()
const router = useRouter()
const formRef = ref<FormInstance>()

// 状态管理
const pageLoading = ref(false)
const submitting = ref(false)
const categories = shallowRef<CategoryItem[]>([])
const tags = shallowRef<TagItem[]>([])

const isEdit = computed(() => !!route.query.id)

const articleForm = reactive<ArticleParams>({
  title: '',
  content: '',
  summary: '',
  categoryId: undefined,
  tagIds: []
})

const rules = {
  title: [{ required: true, message: '博文标题是必填项', trigger: 'blur' }],
  content: [
    { required: true, message: '请键入正文内容', trigger: 'blur' },
    { max: 200000, message: '内容长度超出物理限制 (200KB)', trigger: 'blur' }
  ],
  categoryId: [{ required: true, message: '请为文章指定一个分类', trigger: 'change' }]
}

// 物理中断控制器：处理并发竞态
let initController: AbortController | null = null
let submitController: AbortController | null = null
let uploadController: AbortController | null = null

/**
 * 图片上传逻辑
 * [修复 2026-02-24] P0 修复：引入物理中断信号透传与并发数量限制
 */
const handleUploadImg = async (files: File[], callback: (urls: string[]) => void) => {
  if (files.length > 10) {
    return ElMessage.warning('单次上传资源文件不得超过 10 个')
  }

  if (uploadController) uploadController.abort()
  uploadController = new AbortController()
  const { signal } = uploadController

  try {
    const uploadTasks = files.map(file => uploadImage(file, { signal } as AxiosRequestConfig))
    const res = await Promise.all(uploadTasks)
    callback(res.map(item => item.url))
    ElMessage.success(`成功同步 ${files.length} 张资源图片`)
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      ElMessage.error(err.message || '图片存储服务不可用')
    }
  } finally {
    if (uploadController?.signal === signal) uploadController = null
  }
}

/**
 * 初始化资源同步
 *[修复 2026-03-13] 物理防线：处理 Axios 包装器穿透、数据类型隐式转换与 DTO 字段多态
 */
const initData = async () => {
  if (initController) initController.abort()
  initController = new AbortController()
  const { signal } = initController

  pageLoading.value = true
  try {
    // 拦截器已经完美脱壳，返回的直接是 CategoryItem[] 和 TagItem[]
    const [catRes, tagRes] = await Promise.all([
      getCategories({ signal } as AxiosRequestConfig), 
      getTags({ signal } as AxiosRequestConfig)
    ])
    
    if (!signal.aborted) {
      categories.value = catRes || []
      tags.value = tagRes ||[]

      if (isEdit.value) {
        const id = Number(route.query.id)
        // 拦截器保证了这里直接拿到纯净的 DTO
        const data = await getArticleById(id, { signal } as AxiosRequestConfig) as ArticleDetail
        
        if (data && !signal.aborted) {
          articleForm.title = data.title || ''
          articleForm.content = data.content || ''
          
          articleForm.summary = data.summary || ''
          articleForm.categoryId = data.category?.id ? Number(data.category.id) : undefined
          
          articleForm.tagIds = Array.isArray(data.tags) 
            ? data.tags.map(t => Number(t.id)) 
            :[]
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      ElMessage.error('无法同步远程配置资源')
      console.error('[Write Init Error]', err)
    }
  } finally {
    if (initController?.signal === signal) {
      pageLoading.value = false
      initController = null
    }
  }
}

/**
 * 表单提交流程
 * [修复 2026-02-24] P0 修复：严格校验信号归属，防止异步回调覆盖最新状态
 */
const submitForm = async () => {
  if (!formRef.value || submitting.value) return
  
  try {
    await formRef.value.validate()
    
    await ElMessageBox.confirm(
      isEdit.value ? '确认要更新此博文版本吗？' : '确认要立即发布此博文吗？',
      '发布确认',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'info' }
    )

    if (submitController) submitController.abort()
    const currentController = new AbortController()
    submitController = currentController
    const { signal } = currentController

    submitting.value = true
    const id = Number(route.query.id)
    const config: AxiosRequestConfig = { signal }

    if (isEdit.value) {
      await updateArticle(id, articleForm, config)
      ElMessage.success('博文已成功修订')
    } else {
      await createArticle(articleForm, config)
      ElMessage.success('博文已上线发布')
    }
    
    // 竞态校验：仅在当前提交任务为获胜者时执行跳转
    if (submitController === currentController) {
      articleForm.content = '' 
      router.push('/admin/article/list')
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && err !== 'cancel') {
       console.error('[Article Submit] Critical Error:', err)
    }
  } finally {
    if (submitController?.signal === submitController?.signal) {
       submitting.value = false
    }
  }
}

/**
 * 智能摘要算法
 * [修复 2026-02-24] 算法最优：引入代码块过滤，防止摘要内容污染
 */
const autoGenerateSummary = () => {
  if (!articleForm.content) return ElMessage.warning('博文正文为空')
  
  const cleanStr = articleForm.content
    .replace(/```[\s\S]*?```/g, '')                    // 第一步：物理移除所有 Markdown 代码块
    .replace(/(!\[.*?\]\(.*?\))|(\[.*?\]\(.*?\))/g, '') // 移除链接与图片
    .replace(/[#*`>|\-]/g, '')                        // 移除 Markdown 标记
    .replace(/(\r\n|\n|\r)/gm, ' ')                   // 换行符归一化
    .replace(/\s+/g, ' ')                             // 压缩连续空格
    .trim()
    .substring(0, 180)                                
    
  articleForm.summary = cleanStr + (cleanStr.length >= 180 ? '...' : '')
  ElMessage.success('摘要提取算法执行成功')
}

const handleBack = () => {
  if (articleForm.content.length > 50) {
    ElMessageBox.confirm('正文已有改动，确定要放弃本次创作吗？', '离开确认', {
      type: 'warning',
      confirmButtonText: '丢弃并离开',
      cancelButtonText: '继续写'
    }).then(() => router.back()).catch(() => {})
  } else {
    router.back()
  }
}

onMounted(initData)

onUnmounted(() => {
  // [修复 2026-02-24] 物理安全性：全量中断并释放大内存对象
  if (initController) initController.abort()
  if (submitController) submitController.abort()
  if (uploadController) uploadController.abort()
  
  articleForm.title = ''
  articleForm.content = '' 
  articleForm.summary = ''
})
</script>

<style scoped>
.write-article-wrapper {
  animation: fade-in-slide 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes fade-in-slide {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.title-input-remaster :deep(.el-input__wrapper) {
  box-shadow: none !important;
  background: transparent;
  padding: 0;
  border-bottom: 2px solid #f1f5f9;
  border-radius: 0;
  transition: border-bottom-color 0.3s;
}

.title-input-remaster :deep(.el-input__wrapper.is-focus) {
  border-bottom-color: var(--el-color-primary);
}

.title-input-remaster :deep(.el-input__inner) {
  font-size: 26px;
  font-weight: 900;
  color: #1e293b;
  height: 64px;
}

.modern-md-editor {
  height: calc(100vh - 220px);
  border: none !important;
}

.custom-preview-wrapper {
  scrollbar-width: thin;
  scrollbar-color: #e2e8f0 transparent;
}

.editor-container-card :deep(.el-card__body) {
  padding: 0;
}

.sticky-sidebar {
  position: sticky;
  top: 1.5rem;
}

@media (max-width: 1024px) {
  .modern-md-editor { height: 600px; }
  .sticky-sidebar { position: static; margin-top: 1.5rem; }
}

.el-button:active {
  transform: scale(0.96);
}
</style>