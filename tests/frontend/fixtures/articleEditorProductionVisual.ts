import { createApp, h, nextTick, ref } from 'vue'
import {
  ElForm,
  ElFormItem,
  ElInput
} from '@ozwasyd/element-plus'
import '@/assets/main.css'
import './article-editor-production-fixture.css'
import ArticleWriteTitleField from '@/components/admin/article/ArticleWriteTitleField.vue'
import contract from './article-editor-production-contract.json'

const params = new URL(window.location.href).searchParams
const requestedTitle = params.get('title') as keyof typeof contract.titles | null
const titleKey = requestedTitle && requestedTitle in contract.titles ? requestedTitle : 'empty'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

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
    return () => h('main', {
      class: 'article-editor-production-fixture',
      'aria-label': '文章编辑器 production fixture'
    }, [
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
app.mount(fixtureHost)

await nextTick()
document.documentElement.dataset.articleEditorFixtureReady = 'true'
