import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import {
  ElButton,
  ElCheckbox,
  ElDatePicker,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSkeleton,
  ElSkeletonItem,
  ElSwitch
} from '@ozwasyd/element-plus'
import '@/assets/main.css'
import './article-editor-production-fixture.css'
import { ArticlePublishStatus } from '@/api/article'
import ArticleWriteCommandBar from '@/components/admin/article/ArticleWriteCommandBar.vue'
import ArticleWriteInspectorShell from '@/components/admin/article/ArticleWriteInspectorShell.vue'
import ArticleWriteSidebar from '@/components/admin/article/ArticleWriteSidebar.vue'
import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue'
import { focusFirstArticleValidationError } from '@/components/admin/article/articleEditorAccessibility'
import MarkdownEditorAdapter from '@/components/ui/MarkdownEditorAdapter.vue'
import {
  useArticleWriteInspector,
  type ArticleWriteInspectorView
} from '@/composables/useArticleWriteInspector'
import contract from './article-editor-production-contract.json'

type FixtureState = 'empty' | 'loading' | 'error' | 'success' | 'partial'
type FixtureSurface = 'title' | 'editor' | 'command' | 'inspector'
const inspectorViews = contract.inspectorViews as ArticleWriteInspectorView[]
const fixtureStates = contract.states as FixtureState[]

export async function mountArticleEditorProductionFixture(): Promise<void> {
  const params = new URL(window.location.href).searchParams
  const requestedTitle = params.get('title') as keyof typeof contract.titles | null
  const titleKey = requestedTitle && requestedTitle in contract.titles ? requestedTitle : 'empty'
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const requestedSurface = params.get('surface') as FixtureSurface | null
  const surface: FixtureSurface = ['editor', 'command', 'inspector'].includes(requestedSurface ?? '')
    ? requestedSurface as FixtureSurface
    : 'title'
  const requestedState = params.get('state') as FixtureState | null
  const fixtureState = fixtureStates.includes(requestedState ?? 'success')
    ? requestedState as FixtureState
    : 'success'
  const requestedView = params.get('view') as ArticleWriteInspectorView | null
  const initialInspector = inspectorViews.includes(requestedView ?? 'publish')
    ? requestedView
    : null

  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.dataset.themeMode = theme
  document.documentElement.dataset.themeResolved = theme
  document.body.className = 'account-shell'

  const fixtureHost = document.getElementById('article-editor-production-fixture')
  if (!fixtureHost) {
    throw new Error('article_editor_production_fixture_host_missing')
  }

  const revisionItems = Array.from(
    { length: contract.largeContent.revisions },
    (_, index) => `v${contract.largeContent.revisions - index} · 修订 ${index + 1} · 已保存`
  )
  const assetItems = Array.from(
    { length: contract.largeContent.assets },
    (_, index) => `article-asset-${String(index + 1).padStart(4, '0')}.webp`
  )
  const issueItems = Array.from(
    { length: contract.largeContent.issues },
    (_, index) => `检查项 ${index + 1}：补充第 ${index + 1} 节的来源或上下文。`
  )
  const rightsParagraphs = Array.from(
    { length: contract.largeContent.rightsParagraphs },
    (_, index) => `版权条款 ${index + 1}：署名、摘录、代码复制与证明绑定沿用本文设置，长文本必须在检查器内部滚动。`
  )

  const EditorIdentitySentinel = defineComponent({
    name: 'EditorIdentitySentinel',
    setup() {
      return () => h('article', {
        class: 'article-editor-production-fixture__editor-sentinel',
        'data-editor-instance': 'article-editor-instance-1803',
        'data-editor-content': '正文保持不变',
        'data-editor-selection': 'anchor:18-focus:18',
        'data-editor-history': 'undo:7-redo:2',
        tabindex: '0'
      }, [
        h('p', {
          'data-document-wrap-signature': 'true'
        }, '固定正文列必须在打开发布、版权、检查、预览、版本和资源检查器时保持同一行宽与换行签名。This mixed paragraph is deliberately long enough to wrap across several stable lines.'),
        h('p', '编辑器实例、正文、选区、撤销历史与滚动位置都由这个 sentinel 直接证明。')
      ])
    }
  })

  const app = createApp({
    setup() {
      const title = ref(contract.titles[titleKey])
      const content = ref('先写下可以验证的正文，再检查预览。')
      const state = ref<FixtureState>(fixtureState)
      const editorState = ref<'editing' | 'saving' | 'saved' | 'failed' | 'published'>('editing')
      const actionCounts = reactive({ back: 0, saveDraft: 0, submit: 0 })
      const loadCounts = reactive<Record<ArticleWriteInspectorView, number>>({
        publish: 0,
        rights: 0,
        check: 0,
        preview: 0,
        versions: 0,
        resources: 0
      })
      const statusByState = {
        editing: '自动保存已就绪',
        saving: '正在保存',
        saved: '已保存',
        failed: '保存失败，请重试',
        published: '发布完成'
      } as const
      const form = reactive({
        title: contract.titles.mixed,
        content: '用于验证检查器生命周期的正文。',
        summary: '一段保留业务语义的 fixture 摘要。',
        coverImageUrl: '',
        categoryId: 1 as number | undefined,
        tagIds: [1],
        status: ArticlePublishStatus.Draft,
        scheduledPublishAt: '2026-08-01T09:30:00'
      })
      const inspector = useArticleWriteInspector({
        initialInspector,
        loadView: Object.fromEntries(inspectorViews.map((view) => [
          view,
          () => {
            loadCounts[view] += 1
          }
        ])) as Partial<Record<ArticleWriteInspectorView, () => void>>
      })

      const openInspector = (
        view: ArticleWriteInspectorView,
        trigger?: HTMLElement | null
      ): void => {
        void inspector.open(view, trigger)
      }

      Object.assign(window, {
        __articleEditorFixtureSetState: (nextState: typeof editorState.value) => {
          editorState.value = nextState
        },
        __articleEditorFixtureSetInspectorState: (nextState: FixtureState) => {
          state.value = nextState
        },
        __articleEditorFixtureOpenInspector: (view: ArticleWriteInspectorView) => {
          openInspector(view)
        },
        __articleEditorFixtureCloseInspector: () => {
          inspector.close()
        },
        __articleEditorFixtureActionCounts: actionCounts,
        __articleEditorFixtureLoadCounts: loadCounts
      })

      const renderState = (
        view: ArticleWriteInspectorView,
        successContent: () => ReturnType<typeof h>
      ) => {
        if (state.value === 'loading') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'loading',
            'aria-busy': 'true'
          }, '正在载入检查器内容…')
        }
        if (state.value === 'error') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'error',
            role: 'alert'
          }, `${view} 暂时不可用，请重试。`)
        }
        if (state.value === 'empty') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'empty'
          }, `${view} 暂无内容。`)
        }
        if (state.value === 'partial') {
          return h('div', {
            class: 'article-editor-production-fixture__state',
            'data-fixture-state': 'partial'
          }, [
            h('p', '部分内容已载入，其余内容可重试。'),
            successContent()
          ])
        }
        return h('div', {
          class: 'article-editor-production-fixture__state',
          'data-fixture-state': 'success'
        }, [successContent()])
      }

      const renderList = (
        view: 'versions' | 'resources' | 'check',
        items: string[]
      ) => h('section', {
        class: 'article-editor-production-fixture__large-list',
        'data-large-list': view
      }, [
        h('h2', `${view} · ${items.length}`),
        h('ol', items.map((item) => h('li', { key: item }, item)))
      ])

      const renderInspector = () => h('div', {
        class: 'write-workspace article-editor-production-fixture__inspector-surface'
      }, [
        h(ArticleWriteCommandBar, {
          pageTitle: '编辑文章',
          articleStateText: '草稿',
          statusText: '已保存',
          statusTone: 'quiet',
          criticalStatusText: '120 项发布检查需处理',
          criticalStatusTarget: 'check',
          primaryActionText: '更新文章',
          showSaveDraft: true,
          onOpenInspector: openInspector
        }),
        h(ElForm, {
          model: form,
          class: 'write-validation-form article-editor-production-fixture__inspector-form'
        }, () => [
          h('section', {
            class: 'article-editor-production-fixture__document-column',
            'data-editor-document-column': 'stable',
            'data-route-state': '/manage/write/fixture',
            'data-draft-state': 'draft-1803'
          }, [
            h('h1', '编辑文章'),
            h(EditorIdentitySentinel)
          ]),
          h(ArticleWriteInspectorShell, {
            activeInspector: inspector.activeInspector.value,
            registerTriggerElement: inspector.registerTrigger,
            registerScrollElement: inspector.registerScrollContainer,
            onActivate: openInspector,
            onSwitch: inspector.switchTo,
            onClose: inspector.close,
            onClosed: inspector.restoreFocus,
            onScroll: inspector.updateScroll
          }, {
            publish: () => h(ArticleWriteSidebar, {
              form,
              categories: [{ id: 1, name: '工程', articleCount: 12 }],
              tags: [{ id: 1, name: '契约', articleCount: 8 }],
              submitting: false,
              quickCreatingCategory: false,
              quickCreatingTag: false
            }),
            rights: () => renderState('rights', () => h('section', {
              class: 'article-editor-production-fixture__long-rights'
            }, rightsParagraphs.map((paragraph) => h('p', { key: paragraph }, paragraph)))),
            check: () => renderState('check', () => renderList(
              'check',
              state.value === 'partial' ? issueItems.slice(0, 12) : issueItems
            )),
            preview: () => renderState('preview', () => h('article', [
              h('h2', '阅读预览'),
              h('p', '预览沿用正文阅读列，不改变编辑器实例。')
            ])),
            versions: () => renderState('versions', () => renderList(
              'versions',
              state.value === 'partial' ? revisionItems.slice(0, 10) : revisionItems
            )),
            resources: () => renderState('resources', () => renderList(
              'resources',
              state.value === 'partial' ? assetItems.slice(0, 25) : assetItems
            ))
          })
        ])
      ])

      const renderEditor = () => h('section', {
        class: 'article-editor-production-fixture__editor-component',
        'aria-label': '正文编辑器'
      }, [
        h(MarkdownEditorAdapter, {
          modelValue: content.value,
          statusText: statusByState[editorState.value],
          statusTone: editorState.value === 'failed' ? 'danger' : 'quiet',
          previewComponent: {
            props: ['content'],
            render() {
              return h('article', { 'data-fixture-preview': 'true' }, String(this.content))
            }
          },
          'onUpdate:modelValue': (value: string) => {
            content.value = value
          }
        })
      ])

      const renderCommand = () => h('div', {
        class: 'write-workspace article-editor-production-fixture__command-surface'
      }, [
        h(ArticleWriteCommandBar, {
          pageTitle: '编辑文章',
          articleStateText: editorState.value === 'published' ? '已发布' : '草稿',
          statusText: statusByState[editorState.value],
          statusTone: editorState.value === 'failed' ? 'danger' : 'quiet',
          criticalStatusText: editorState.value === 'failed' ? '保存冲突需处理' : '',
          criticalStatusTarget: editorState.value === 'failed' ? 'publish' : null,
          primaryActionText: '更新文章',
          showSaveDraft: true,
          onBack: () => {
            actionCounts.back += 1
          },
          onSaveDraft: () => {
            actionCounts.saveDraft += 1
          },
          onSubmit: () => {
            actionCounts.submit += 1
            focusFirstArticleValidationError(fixtureHost)
          }
        }),
        h('form', { class: 'write-validation-form' }, [
          h('div', { class: 'article-validation-field' }, [
            h('label', { for: 'fixture-invalid-title' }, '缺失标题'),
            h('input', {
              id: 'fixture-invalid-title',
              'aria-invalid': 'true',
              value: ''
            })
          ])
        ]),
        h('div', {
          class: 'article-editor-production-fixture__command-canvas',
          role: 'textbox',
          'aria-label': '命令栏下方正文',
          tabindex: '0'
        }, [
          h('span', { 'data-fixture-last-line': 'true' }, '正文最后一行必须保持可达。')
        ])
      ])

      return () => h('main', {
        class: 'article-editor-production-fixture',
        'aria-label': '文章编辑器 production fixture'
      }, surface === 'editor' ? [renderEditor()] : surface === 'command' ? [renderCommand()] : surface === 'inspector' ? [renderInspector()] : [
        h('header', { class: 'article-editor-production-fixture__task' }, [
          h('div', [
            h('h1', '撰写文章'),
            h('p', '草稿 · 已保存')
          ]),
          h('button', { type: 'button' }, '发布')
        ]),
        h(ElForm, { model: { title: title.value } }, () => [
          h('section', { class: 'article-editor-production-fixture__title', 'aria-label': '文章标题' }, [
            h(ArticleWriteTitleField, {
              modelValue: title.value,
              'onUpdate:modelValue': (value: string) => {
                title.value = value
              }
            })
          ]),
          h('section', { class: 'article-editor-production-fixture__editor', 'aria-label': '正文编辑器' }, [
            h('div', { class: 'article-editor-production-fixture__toolbar', role: 'toolbar' }, [
              h('button', { type: 'button' }, '正文'),
              h('button', { type: 'button' }, '分屏'),
              h('button', { type: 'button' }, '预览')
            ]),
            h('div', {
              class: 'article-editor-production-fixture__canvas',
              contenteditable: 'true',
              role: 'textbox',
              'aria-label': '正文'
            }, '从这里开始写正文。')
          ])
        ])
      ])
    }
  })

  for (const [name, component] of Object.entries({
    ElButton,
    ElCheckbox,
    ElDatePicker,
    ElForm,
    ElFormItem,
    ElInput,
    ElInputNumber,
    ElOption,
    ElRadioButton,
    ElRadioGroup,
    ElSelect,
    ElSkeleton,
    ElSkeletonItem,
    ElSwitch
  })) {
    app.component(name, component)
  }
  app.mount(fixtureHost)

  await nextTick()
  Object.assign(window, {
    __articleEditorFixtureEditorNode: document.querySelector('[data-editor-instance]')
  })
  document.documentElement.dataset.articleEditorFixtureReady = 'true'
}
