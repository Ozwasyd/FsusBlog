import '@/assets/main.css'
import './public-article-reading-layout-fixture.css'

const params = new URL(window.location.href).searchParams
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'public-article-reading-layout-fixture-body'

const host = document.getElementById('public-article-reading-layout-fixture')
if (!host) {
  throw new Error('public_article_reading_layout_fixture_host_missing')
}

host.innerHTML = `
  <main
    class="public-article-detail"
    data-fsus-reading-layout
    data-fsus-surface="reading"
    aria-label="文章阅读布局 fixture"
  >
    <div data-fsus-reading-bleed data-reading-case="cover">
      <img src="/fixtures/acceptance-cover-primary.svg" alt="Cover fixture">
    </div>

    <p data-reading-case="content-reference">
      正文基线用于验证 content grid line；它必须保持稳定的安全边距与可读行长。
    </p>

    <figure data-reading-case="figure">
      <img src="/fixtures/acceptance-cover-focus.svg" alt="普通 figure fixture">
      <figcaption>普通 figure caption</figcaption>
    </figure>

    <figure data-fsus-reading-bleed data-reading-case="wide-figure">
      <img src="/fixtures/acceptance-cover-hot.svg" alt="Wide figure fixture">
      <figcaption>Wide figure caption aligns to the content line</figcaption>
    </figure>

    <pre data-fsus-reading-bleed data-reading-case="wide-code"><code>const readingLayout = 'named-grid-lines'</code></pre>

    <button
      type="button"
      data-fsus-reading-bleed
      data-reading-case="lightbox-trigger"
      aria-label="打开图片预览"
    >
      <img src="/fixtures/acceptance-cover-focus.svg" alt="">
    </button>

    <section data-reading-case="no-media" aria-label="无媒体文章">
      <h2>无媒体内容</h2>
      <p>没有媒体时仍然沿 content line 排版。</p>
    </section>
  </main>
`

host.querySelector<HTMLElement>('[data-reading-case="lightbox-trigger"]')
  ?.addEventListener('click', () =>
  {
    document.documentElement.dataset.fixtureLightboxOpen = 'true'
  })

document.documentElement.dataset.publicArticleReadingLayoutFixtureReady = 'true'
