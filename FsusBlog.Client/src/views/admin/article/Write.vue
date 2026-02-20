<template>
  <div class="write-article-wrapper">
    <el-form 
      ref="formRef" 
      :model="articleForm" 
      :rules="rules" 
      label-position="top"
      v-loading="pageLoading"
    >
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <el-form-item prop="title" class="grow w-full mb-0!">
          <el-input 
            v-model="articleForm.title" 
            placeholder="在此键入博文标题..." 
            size="large"
            maxlength="100"
            show-word-limit
            class="title-input-remaster"
          />
        </el-form-item>
        <div class="flex items-center gap-3 shrink-0">
          <el-button @click="handleBack" plain>返回列表</el-button>
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
        <el-col :xs="24" :lg="18">
          <el-card shadow="never" class="editor-container-card border-zinc-100 rounded-xl overflow-hidden">
            <el-form-item prop="content" class="mb-0!">
              <md-editor 
                v-model="articleForm.content" 
                @on-save="submitForm"
                @on-upload-img="handleUploadImg"
                placeholder="支持 Markdown 实时预览，Shift+Alt+F 自动格式化..."
                class="modern-md-editor"
                preview-theme="github"
                :toolbarsExclude="['github', 'save', 'htmlPreview']"
              />
            </el-form-item>
          </el-card>
        </el-col>

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
                <el-select v-model="articleForm.categoryId" placeholder="选择分类" class="w-full" clearable>
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
                />
                <div class="flex justify-end mt-2">
                  <el-button link type="primary" size="small" @click="autoGenerateSummary">
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
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { CollectionTag, MagicStick } from '@element-plus/icons-vue'
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

// 导入 API 
import { getArticleById, createArticle, updateArticle } from '@/api/article'
import { getCategories, type CategoryItem } from '@/api/category'
import { getTags, type TagItem } from '@/api/tag'
import { uploadImage } from '@/api/system' 

// 定义符合后端预期的提交参数
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

// 状态机
const pageLoading = ref(false)
const submitting = ref(false)
const categories = ref<CategoryItem[]>([])
const tags = ref<TagItem[]>([])

const isEdit = computed(() => !!route.query.id)

// 初始化文章表单数据
const articleForm = reactive<ArticleParams>({
  title: '',
  content: '',
  summary: '',
  categoryId: undefined,
  tagIds: []
})

const rules = {
  title: [{ required: true, message: '博文标题是必填项', trigger: 'blur' }],
  content: [{ required: true, message: '请键入正文内容', trigger: 'blur' }],
  categoryId: [{ required: true, message: '请为文章指定一个分类', trigger: 'change' }]
}

/**
 * 图片上传处理
 * 采用并行上传模式，提升多图上传时的性能
 */
const handleUploadImg = async (files: File[], callback: (urls: string[]) => void) => {
  try {
    const res = await Promise.all(
      files.map(file => uploadImage(file))
    )
    // 映射后端返回的 URL 数组，调用回调函数插值到编辑器
    const urls = res.map(item => item.url)
    callback(urls)
    ElMessage.success(`成功上传 ${files.length} 张图片`)
  } catch (err: any) {
    ElMessage.error(err.message || '图片上传失败')
  }
}

/**
 * 核心：初始化页面数据
 */
const initData = async () => {
  pageLoading.value = true
  try {
    const [catRes, tagRes] = await Promise.all([getCategories(), getTags()])
    categories.value = catRes
    tags.value = tagRes

    if (isEdit.value) {
      const id = Number(route.query.id)
      const data = await getArticleById(id)
      
      Object.assign(articleForm, {
        title: data.title,
        content: data.content,
        summary: data.summary,
        categoryId: data.categoryId,
        tagIds: data.tags.map(t => t.id)
      })
    }
  } catch (err) {
    ElMessage.error('页面资源同步失败')
  } finally {
    pageLoading.value = false
  }
}

/**
 * 发布或保存逻辑：原子化提交
 */
const submitForm = async () => {
  if (!formRef.value || submitting.value) return
  
  try {
    await formRef.value.validate()
    
    // 🌟 复用标准 ElMessageBox 进行发布确认
    await ElMessageBox.confirm(
      isEdit.value ? '确定要保存对此文章的修改吗？' : '确定要立即发布此文章吗？',
      '操作确认',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'info' }
    )

    submitting.value = true
    const id = Number(route.query.id)
    
    if (isEdit.value) {
      await updateArticle(id, articleForm)
      ElMessage.success('文章修订已存盘')
    } else {
      await createArticle(articleForm)
      ElMessage.success('博文已成功发布')
    }
    
    articleForm.content = '' 
    router.push('/admin/article/list')
  } catch (err) {
    // 拦截取消或验证失败
  } finally {
    submitting.value = false
  }
}

/**
 * 返回拦截：复用标准 ElMessageBox
 */
const handleBack = () => {
  if (articleForm.content.length > 50) {
    ElMessageBox.confirm('正文已有改动，确定要放弃本次创作吗？', '离开确认', {
      type: 'warning',
      confirmButtonText: '确定离开',
      cancelButtonText: '继续写'
    }).then(() => router.back()).catch(() => {})
  } else {
    router.back()
  }
}

/**
 * 智能摘要：正则清洗逻辑
 */
const autoGenerateSummary = () => {
  if (!articleForm.content) return ElMessage.warning('内容为空')
  
  const cleanStr = articleForm.content
    .replace(/(!\[.*?\]\(.*?\))|(\[.*?\]\(.*?\))/g, '')
    .replace(/[#*`>|-]/g, '')
    .replace(/(\r\n|\n|\r)/gm, ' ')
    .trim()
    .substring(0, 150)
    
  articleForm.summary = cleanStr + (cleanStr.length >= 150 ? '...' : '')
  ElMessage.success('摘要已智能生成')
}

onMounted(initData)

onUnmounted(() => {
  articleForm.content = ''
})
</script>

<style scoped>
.write-article-wrapper {
  animation: fade-in-slide 0.4s ease-out;
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
  border-bottom-color: var(--el-color-primary-light-3);
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

.editor-container-card :deep(.el-card__body) {
  padding: 0;
}

.sticky-sidebar {
  position: sticky;
  top: 1.5rem;
}

@media (max-width: 1024px) {
  .modern-md-editor { height: 500px; }
  .sticky-sidebar { position: static; margin-top: 1.5rem; }
}
</style>