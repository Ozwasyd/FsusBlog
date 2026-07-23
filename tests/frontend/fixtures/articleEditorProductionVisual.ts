import { createApp, h, nextTick, ref } from 'vue'
import {
  ElButton,
  ElForm,
  ElFormItem,
  ElInput,
  ElRadioButton,
  ElRadioGroup,
  ElSkeleton,
  ElSkeletonItem
} from '@ozwasyd/element-plus'
import '@/assets/main.css'
import './article-editor-production-fixture.css'
import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue'
import MarkdownEditorAdapter from '@/components/ui/MarkdownEditorAdapter.vue'
import contract from './article-editor-production-contract.json'

const params = new URL(window.location.href).searchParams
const requestedTitle = params.get('title') as keyof typeof contract.titles | null
const titleKey = requestedTitle && requestedTitle in contract.titles ? requestedTitle : 'empty'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const surface = params.get('surface') === 'editor' ? 'editor' : 'title'

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'account-shell'

const fixtureHost = document.getElementById('article-editor-production-fixture')
if (!fixtureHost) {
  throw new Error('article_editor_production_fixture_host_missing')
}

const app = createApp({
  setup() {
    const title = ref(contract.titles[titleKey])
    const content = ref('先写下可以验证的正文，再检查预览。')
    const editorState = ref<'editing' | 'saving' | 'saved' | 'failed'>('editing')
    const statusByState = {
      editing: '自动保存已就绪',
      saving: '正在保存',
      saved: '已保存',
      failed: '保存失败，请重试'
    } as const

    Object.assign(window, {
      __articleEditorFixtureSetState: (state: typeof editorState.value) => {
        editorState.value = state
      }
    })

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

    return () => h('main', {
      class: 'article-editor-production-fixture',
      'aria-label': '文章编辑器 production fixture'
    }, surface === 'editor' ? [renderEditor()] : [
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

app.component('ElForm', ElForm)
app.component('ElFormItem', ElFormItem)
app.component('ElInput', ElInput)
app.component('ElButton', ElButton)
app.component('ElRadioButton', ElRadioButton)
app.component('ElRadioGroup', ElRadioGroup)
app.component('ElSkeleton', ElSkeleton)
app.component('ElSkeletonItem', ElSkeletonItem)
app.mount(fixtureHost)

await nextTick()
document.documentElement.dataset.articleEditorFixtureReady = 'true'
