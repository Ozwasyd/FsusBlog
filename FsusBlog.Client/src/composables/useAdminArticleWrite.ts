import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import {
  getArticleById,
  createArticle,
  getArticles,
  updateArticle,
  uploadArticleAotBundle,
  type ArticleDetail,
  type ArticleWriteRequest
} from '@/api/article'
import { getCategories, type CategoryItem } from '@/api/category'
import { getTags, type TagItem } from '@/api/tag'
import { getPageData } from '@/api/system'
import { uploadImage } from '@/api/system'
import { useAbortableTask } from '@/composables/useAbortableTask'
import type { AxiosRequestConfig } from 'axios'
import { getErrorMessage, isAbortError } from '@/utils/errors'
import { useSiteStore } from '@/store/site'
import { buildFilterPublicAotEntry, buildPublicHydrationBundle } from '@/helpers/publicAotBundle'

interface ArticleParams {
  title: string
  content: string
  summary: string
  categoryId: number | undefined
  tagIds: number[]
}

export function useAdminArticleWrite() {
  const route = useRoute()
  const router = useRouter()
  const siteStore = useSiteStore()
  const formRef = ref<FormInstance>()

  const pageLoading = ref(false)
  const submitting = ref(false)
  const categories = shallowRef<CategoryItem[]>([])
  const tags = shallowRef<TagItem[]>([])
  const originalCreateTime = ref('')

  const isEdit = computed(() => !!route.query.id)
  const submitButtonText = computed(() => (isEdit.value ? '确认更新' : '立即发布'))
  const submitConfirmContent = computed(() =>
    isEdit.value ? '确认要更新此博文版本吗？' : '确认要立即发布此博文吗？'
  )

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

  const initTask = useAbortableTask()
  const submitTask = useAbortableTask()
  const uploadTask = useAbortableTask()

  const buildSignalConfig = (signal: AbortSignal): AxiosRequestConfig => ({ signal })
  const isCancelError = (error: unknown): boolean => error === 'cancel'

  const buildAotBundle = async (articleId: number, signal?: AbortSignal): Promise<ArticleWriteRequest['aotBundle']> => {
    const category = categories.value.find((item) => item.id === articleForm.categoryId)
    const selectedTags = tags.value.filter((item) => articleForm.tagIds.includes(item.id))
    const requestConfig = signal ? buildSignalConfig(signal) : undefined
    const allCategories = [...categories.value]
    const allTags = [...tags.value]

    const filterTasks: Array<Promise<{ kind: 'category' | 'tag'; id: number; name: string; list: Awaited<ReturnType<typeof getArticles>> }>> = [
      ...allCategories.map((item) =>
        getArticles({ page: 1, size: 10, categoryId: item.id }, requestConfig).then((list) => ({
          kind: 'category' as const,
          id: item.id,
          name: item.name,
          list
        }))
      ),
      ...allTags.map((item) =>
        getArticles({ page: 1, size: 10, tagId: item.id }, requestConfig).then((list) => ({
          kind: 'tag' as const,
          id: item.id,
          name: item.name,
          list
        }))
      )
    ]

    const [homeResult, aboutResult, archiveResult, ...filterResults] = await Promise.allSettled([
      getArticles({ page: 1, size: 8 }, requestConfig),
      getPageData('about', requestConfig),
      getArticles({ page: 1, size: 200 }, requestConfig),
      ...filterTasks
    ])

    const homeResponse = homeResult.status === 'fulfilled' ? homeResult.value : undefined
    const aboutContent = aboutResult.status === 'fulfilled' ? (aboutResult.value?.content ?? '') : ''
    const archiveItems = archiveResult.status === 'fulfilled' ? archiveResult.value.items : []

    const bundle = await buildPublicHydrationBundle({
      articleId,
      title: articleForm.title,
      content: articleForm.content,
      summary: articleForm.summary,
      createTime: originalCreateTime.value || undefined,
      categoryId: articleForm.categoryId,
      categoryName: category?.name ?? '未分类',
      tags: selectedTags,
      siteTitle: siteStore.siteInfo.title,
      baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
        ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
        : undefined,
      homeResponse,
      includeAbout: true,
      about: {
        content: aboutContent,
        siteTitle: siteStore.siteInfo.title,
        title: '关于',
        baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
          ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
          : undefined
      },
      includeArchive: true,
      archive: {
        articles: archiveItems.map((item) => ({
          id: item.id,
          title: item.title,
          createTime: item.createTime
        })),
        siteTitle: siteStore.siteInfo.title,
        title: '归档',
        baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
          ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
          : undefined
      }
    })

    for (const result of filterResults) {
      if (result.status !== 'fulfilled') {
        continue
      }

      const filter = result.value
      const routeKey = filter.kind === 'category'
        ? `category:${filter.id}`
        : `tag:${filter.id}`
      const title = filter.kind === 'category'
        ? `分类：${filter.name}`
        : `标签：${filter.name}`

      bundle.entries.push(await buildFilterPublicAotEntry({
        routeKey,
        pageIndex: 1,
        pageSize: 10,
        total: filter.list.total,
        articles: filter.list.items.map((item) => ({
          id: item.id,
          title: item.title,
          summary: item.summary,
          createTime: item.createTime
        })),
        siteTitle: siteStore.siteInfo.title,
        title,
        baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
          ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
          : undefined
      }))
    }

    return bundle
  }

  const handleUploadImg = async (files: File[], callback: (urls: string[]) => void) => {
    if (files.length > 10) {
      ElMessage.warning('单次上传资源文件不得超过 10 个')
      return
    }

    try {
      await uploadTask.run(async (signal) => {
        const config = buildSignalConfig(signal)
        const uploadTasks = files.map((file) => uploadImage(file, config))
        const res = await Promise.all(uploadTasks)
        callback(res.map((item) => item.url))
        ElMessage.success(`成功同步 ${files.length} 张资源图片`)
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        ElMessage.error(getErrorMessage(error, '图片存储服务不可用'))
      }
    }
  }

  const initData = async () => {
    pageLoading.value = true
    try {
      await initTask.run(async (signal) => {
        const [catRes, tagRes] = await Promise.all([
          getCategories(buildSignalConfig(signal)),
          getTags(buildSignalConfig(signal))
        ])

        if (signal.aborted) {
          return
        }

        categories.value = catRes || []
        tags.value = tagRes || []

        if (!isEdit.value) {
          return
        }

        const id = Number(route.query.id)
        if (!Number.isFinite(id)) {
          return
        }

        const data = await getArticleById(id, buildSignalConfig(signal)) as ArticleDetail
        if (!data || signal.aborted) {
          return
        }

        articleForm.title = data.title || ''
        articleForm.content = data.content || ''
        articleForm.summary = data.summary || ''
        articleForm.categoryId = data.category?.id ? Number(data.category.id) : undefined
        articleForm.tagIds = Array.isArray(data.tags) ? data.tags.map((item) => Number(item.id)) : []
        originalCreateTime.value = data.createTime || ''
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        ElMessage.error('无法同步远程配置资源')
        console.error('[Write Init Error]', error)
      }
    } finally {
      pageLoading.value = false
    }
  }

  const submitForm = async () => {
    if (!formRef.value || submitting.value) {
      return
    }

    try {
      await formRef.value.validate()
      await ElMessageBox.confirm(submitConfirmContent.value, '发布确认', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'info'
      })

      submitting.value = true
      await submitTask.run(async (signal) => {
        const id = Number(route.query.id)
        const config: AxiosRequestConfig = { signal }
        const articlePayload: ArticleWriteRequest = {
          title: articleForm.title,
          content: articleForm.content,
          summary: articleForm.summary,
          categoryId: articleForm.categoryId,
          tagIds: [...articleForm.tagIds]
        }

        if (isEdit.value) {
          await updateArticle(id, articlePayload, config)
          if (Number.isFinite(id)) {
            const bundle = await buildAotBundle(id, signal)
            await uploadArticleAotBundle(id, bundle, config)
          }
          ElMessage.success('博文已成功修订')
        } else {
          const result = await createArticle(articlePayload, config)
          const createdId = Number(result?.id)
          if (Number.isFinite(createdId) && createdId > 0) {
            const bundle = await buildAotBundle(createdId, signal)
            await uploadArticleAotBundle(createdId, bundle, config)
          }
          ElMessage.success('博文已上线发布')
        }

        articleForm.content = ''
        await router.push('/admin/article/list')
      })
    } catch (error: unknown) {
      if (!isAbortError(error) && !isCancelError(error)) {
        console.error('[Article Submit] Critical Error:', error)
      }
    } finally {
      submitting.value = false
    }
  }

  const autoGenerateSummary = () => {
    if (!articleForm.content) {
      ElMessage.warning('博文正文为空')
      return
    }

    const cleanStr = articleForm.content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/(!\[.*?\]\(.*?\))|(\[.*?\]\(.*?\))/g, '')
      .replace(/[#*`>|\-]/g, '')
      .replace(/(\r\n|\n|\r)/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 180)

    articleForm.summary = cleanStr + (cleanStr.length >= 180 ? '...' : '')
    ElMessage.success('摘要提取算法执行成功')
  }

  const handleBack = async () => {
    if (articleForm.content.length > 50) {
      await ElMessageBox.confirm('正文已有改动，确定要放弃本次创作吗？', '离开确认', {
        type: 'warning',
        confirmButtonText: '丢弃并离开',
        cancelButtonText: '继续写'
      }).then(() => {
        void router.back()
      }).catch(() => undefined)
      return
    }

    void router.back()
  }

  onMounted(() => {
    void initData()
  })

  onUnmounted(() => {
    initTask.cancel()
    submitTask.cancel()
    uploadTask.cancel()
    articleForm.title = ''
    articleForm.content = ''
    articleForm.summary = ''
    originalCreateTime.value = ''
  })

  return {
    formRef,
    pageLoading,
    submitting,
    categories,
    tags,
    isEdit,
    submitButtonText,
    articleForm,
    rules,
    handleUploadImg,
    submitForm,
    autoGenerateSummary,
    handleBack
  }
}
