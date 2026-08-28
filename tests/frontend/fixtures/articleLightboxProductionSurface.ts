import { createApp, defineComponent, h, nextTick, onMounted, ref } from 'vue'

import '@/assets/main.css'
import ArticleImageLightbox from '@/components/article/ArticleImageLightbox.vue'
import { useArticleImageLightbox } from '@/composables/article/useArticleImageLightbox'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { activateLocaleRuntime } from '@/locales'

const host = document.getElementById('app')
if (!host) {
  throw new Error('article_lightbox_production_surface_host_missing')
}

await activateLocaleRuntime('zh-CN', ['common', 'article'])

const ProductionArticleLightboxSurface = defineComponent({
  name: 'ProductionArticleLightboxSurface',
  setup() {
    const contentRoot = ref<HTMLElement | null>(null)
    const {
      images,
      activeIndex,
      open,
      refresh,
      close,
      next,
      previous
    } = useArticleImageLightbox(contentRoot)

    onMounted(async () => {
      await nextTick()
      await refresh()
      document.documentElement.dataset.articleLightboxProductionSurfaceReady = 'true'
    })

    return () => h('main', {
      class: 'public-article-detail',
      'data-fsus-reading-layout': '',
      'data-fsus-surface': 'reading'
    }, [
      h('article', {
        ref: contentRoot,
        class: 'markdown-body markdown-body--article',
        'data-article-lightbox-production-content': ''
      }, [
        h('img', {
          src: '/fixtures/acceptance-cover-primary.svg',
          alt: 'First geometry image'
        }),
        h('p', 'Deterministic article body images exercise the production lightbox surface.'),
        h('img', {
          src: '/fixtures/acceptance-cover-focus.svg',
          alt: 'Second geometry image'
        })
      ]),
      h(ArticleImageLightbox, {
        open: open.value,
        images: images.value,
        activeIndex: activeIndex.value,
        onClose: close,
        onNext: next,
        onPrevious: previous
      })
    ])
  }
})

const app = createApp(ProductionArticleLightboxSurface)
provideFsusUiAppContext(app)
app.mount(host)
