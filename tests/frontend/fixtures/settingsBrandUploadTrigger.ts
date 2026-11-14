import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import ElementPlus, { ElUpload, type UploadRequestOptions } from '@ozwasyd/element-plus'
import { Plus } from '@/fsusui/icons'

import '@/assets/main.css'
import BrandAssetUploadField from '@/components/admin/settings/BrandAssetUploadField.vue'
import {
  fsusUiSourceMode,
  inspectSettingsUploadSurface
} from '../support/settingsBrandUploadTriggerDom'

const PREVIEW_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const fixtureHost = document.getElementById('settings-brand-upload-trigger-fixture')
if (!fixtureHost) {
  throw new Error('settings_brand_upload_trigger_fixture_host_missing')
}

document.body.className = 'account-shell'
document.documentElement.dataset.fsusuiSource = fsusUiSourceMode()
fixtureHost.style.width = 'min(calc(100% - 2rem), 64rem)'
fixtureHost.style.margin = '1.5rem auto'
const fixtureStyle = document.createElement('style')
fixtureStyle.textContent = `
  .settings-og-image-upload:focus-within .image-replace-overlay { opacity: 1; }
  .settings-icon-set-trigger {
    display: inline-flex;
    min-height: 2rem;
    align-items: center;
    justify-content: center;
    padding-inline: 0.75rem;
    border: 1px solid var(--fsusblog-panel-border-strong);
    border-radius: var(--fsus-radius-popover);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
    font-size: 12px;
    font-weight: 700;
  }
`
document.head.append(fixtureStyle)

const selections = reactive<Record<string, string[]>>({})
const failedPreviewUrl = ref('/__missing-brand-preview__.png')

const recordUpload = (surface: string) => (options: UploadRequestOptions) => {
  selections[surface] ??= []
  selections[surface].push(options.file.name)
  options.onSuccess?.({})
  return new XMLHttpRequest()
}

const ProbeUpload = defineComponent({
  props: {
    surface: { type: String, required: true },
    nestedButton: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h(ElUpload, {
      action: '#',
      showFileList: false,
      disabled: props.disabled,
      accept: 'image/png',
      httpRequest: recordUpload(props.surface),
      'data-settings-upload-surface': props.surface,
      'data-upload-state': props.disabled ? 'disabled' : 'empty'
    }, () => props.nestedButton
      ? h('button', { type: 'button' }, '选择文件')
      : h('span', '选择文件'))
  }
})

const OgImageUpload = defineComponent({
  props: {
    surface: { type: String, required: true },
    preview: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    uploading: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h(ElUpload, {
      class: 'settings-og-image-upload w-full max-w-xs',
      action: '#',
      mediaField: true,
      mediaAspectRatio: '16 / 9',
      showFileList: false,
      accept: 'image/*',
      disabled: props.disabled || props.uploading,
      httpRequest: recordUpload(props.surface),
      'data-settings-upload-surface': props.surface,
      'data-upload-state': props.disabled ? 'disabled' : props.uploading ? 'uploading' : props.preview ? 'preview' : 'empty'
    }, () => h('div', {
      class: 'group relative min-w-0 overflow-hidden rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border-strong)] bg-[var(--fsusblog-page-bg)]'
    }, [
      props.preview
        ? h('img', { src: PREVIEW_PNG, alt: '当前社交媒体预览图，点击更换', class: 'w-full h-full object-cover' })
        : h('div', { class: 'h-full min-h-12 w-full flex flex-col items-center justify-center' }, [
          h('span', '上传预览图')
        ]),
      props.preview
        ? h('div', { class: 'image-replace-overlay absolute inset-0 opacity-0 group-hover:opacity-100 flex items-center justify-center' }, [
          h('span', '点击更换')
        ])
        : null
    ]))
  }
})

const IconSetUpload = defineComponent({
  props: {
    surface: { type: String, required: true },
    disabled: { type: Boolean, default: false },
    uploading: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h(ElUpload, {
      class: 'settings-icon-set-upload',
      action: '#',
      showFileList: false,
      accept: 'image/png,image/jpeg,image/webp',
      disabled: props.disabled || props.uploading,
      httpRequest: recordUpload(props.surface),
      'data-settings-upload-surface': props.surface,
      'data-upload-state': props.disabled ? 'disabled' : props.uploading ? 'uploading' : 'empty'
    }, () => h('span', { class: 'settings-icon-set-trigger' }, props.uploading ? '正在生成图标组' : '从图片生成图标组'))
  }
})

createApp({
  setup() {
    return () => h('main', { 'aria-label': 'Settings brand upload trigger fixture' }, [
      h('section', { 'data-fixture-case': 'probe-legal' }, [h(ProbeUpload, { surface: 'probe-legal' })]),
      h('section', { 'data-fixture-case': 'probe-nested' }, [h(ProbeUpload, { surface: 'probe-nested', nestedButton: true })]),
      h('section', { 'data-fixture-case': 'brand-empty' }, [
        h(BrandAssetUploadField, {
          label: '站点 Logo',
          modelValue: '',
          targetField: 'siteLogoUrl',
          uploadText: '上传 Logo',
          onUpload: recordUpload('brand:siteLogoUrl')
        })
      ]),
      h('section', { 'data-fixture-case': 'brand-preview' }, [
        h(BrandAssetUploadField, {
          label: '站点 Logo',
          modelValue: '/uploads/logo.png',
          targetField: 'siteLogoDarkUrl',
          previewUrl: PREVIEW_PNG,
          uploadText: '上传 Logo',
          onUpload: recordUpload('brand:siteLogoDarkUrl')
        })
      ]),
      h('section', { 'data-fixture-case': 'brand-failed' }, [
        h(BrandAssetUploadField, {
          label: '站点 Logo',
          modelValue: '/uploads/logo.png',
          targetField: 'adminLogoUrl',
          previewUrl: failedPreviewUrl.value,
          uploadText: '上传 Logo',
          onUpload: recordUpload('brand:adminLogoUrl')
        })
      ]),
      h('section', { 'data-fixture-case': 'brand-disabled' }, [
        h(BrandAssetUploadField, {
          label: '站点 Logo',
          modelValue: '',
          targetField: 'loginLogoUrl',
          disabled: true,
          uploadText: '上传 Logo',
          onUpload: recordUpload('brand:loginLogoUrl')
        })
      ]),
      h('section', { 'data-fixture-case': 'brand-uploading' }, [
        h(BrandAssetUploadField, {
          label: '站点 Logo',
          modelValue: '',
          targetField: 'siteWordmarkUrl',
          uploading: true,
          uploadText: '上传 Logo',
          onUpload: recordUpload('brand:siteWordmarkUrl')
        })
      ]),
      h('section', { 'data-fixture-case': 'og-empty' }, [h(OgImageUpload, { surface: 'og-image' })]),
      h('section', { 'data-fixture-case': 'og-preview' }, [h(OgImageUpload, { surface: 'og-image-preview', preview: true })]),
      h('section', { 'data-fixture-case': 'og-disabled' }, [h(OgImageUpload, { surface: 'og-image-disabled', disabled: true })]),
      h('section', { 'data-fixture-case': 'icon-set' }, [h(IconSetUpload, { surface: 'icon-set' })]),
      h('section', { 'data-fixture-case': 'icon-set-disabled' }, [h(IconSetUpload, { surface: 'icon-set-disabled', disabled: true })]),
      h('section', { 'data-fixture-case': 'icon-set-uploading' }, [h(IconSetUpload, { surface: 'icon-set-uploading', uploading: true })])
    ])
  }
}).use(ElementPlus).mount(fixtureHost)

await nextTick()
await new Promise((resolve) => window.setTimeout(resolve, 50))

Object.assign(window, {
  __settingsBrandUploadProbe: {
    inspect(surface: string) {
      const node = document.querySelector(`[data-settings-upload-surface="${surface}"]`)
      if (!node) {
        throw new Error(`missing surface ${surface}`)
      }
      return inspectSettingsUploadSurface(node)
    },
    inspectCase(caseName: string) {
      const section = document.querySelector(`[data-fixture-case="${caseName}"] [data-settings-upload-surface]`)
      if (!section) {
        throw new Error(`missing fixture case ${caseName}`)
      }
      return inspectSettingsUploadSurface(section)
    },
    selections: () => JSON.parse(JSON.stringify(selections)) as Record<string, string[]>,
    source: fsusUiSourceMode()
  }
})

document.documentElement.dataset.settingsBrandUploadTriggerReady = 'true'
