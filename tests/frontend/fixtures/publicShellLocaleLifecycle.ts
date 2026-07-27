import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h, nextTick, ref } from 'vue'
import '@/assets/main.css'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { isSupportedLocale, requestLocale, type SupportedLocale } from '@/locales'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'

type FixturePhase = 'aot' | 'hydrated' | 'spa'
type FixtureSession = 'anonymous' | 'user'

const params = new URL(window.location.href).searchParams
const localeValue = params.get('locale')
if (!isSupportedLocale(localeValue)) {
  throw new Error('public_shell_locale_fixture_requires_explicit_locale')
}
const fixtureLocale: SupportedLocale = localeValue
const session: FixtureSession = params.get('session') === 'user' ? 'user' : 'anonymous'
const phase = ref<FixturePhase>('aot')

await requestLocale(fixtureLocale)
document.documentElement.lang = fixtureLocale
document.body.className = 'public-shell-locale-fixture'

const host = document.getElementById('public-shell-locale-fixture')
if (!host) {
  throw new Error('public_shell_locale_fixture_host_missing')
}

const Root = defineComponent({
  name: 'PublicShellLocaleLifecycleFixture',
  setup() {
    return () => {
      const shellState = createPublicShellViewState({
        hydrationKind: phase.value === 'spa' ? 'About' : 'Home',
        siteTitle: 'FsusBlog',
        isRuntimeAuthResolved: true,
        isLoggedIn: session === 'user',
        isAdmin: false,
        spaSearch: phase.value === 'spa',
      })
      return h(PublicBlogLayoutShell, {
        ...shellState,
        spaNavigation: phase.value === 'spa',
      }, {
        default: () => h('main', {
          id: 'fixture-content',
          'data-fixture-phase': phase.value,
        }, phase.value),
      })
    }
  },
})

const serverApp = createSSRApp(Root)
provideFsusUiAppContext(serverApp)
host.innerHTML = await renderToString(serverApp)
let hydrated = false

const fixtureWindow = window as Window & {
  __advancePublicShellPhase?: (next: FixturePhase) => Promise<void>
}
fixtureWindow.__advancePublicShellPhase = async (next) => {
  if (next !== 'aot' && !hydrated) {
    const hydrationApp = createSSRApp(Root)
    provideFsusUiAppContext(hydrationApp)
    hydrationApp.mount(host)
    hydrated = true
    await nextTick()
  }
  phase.value = next
  await nextTick()
}

document.documentElement.dataset.publicShellLocaleFixtureReady = 'true'
