import { createApp, h } from 'vue'
import { ElPublicShell } from '@element-plus/components/public-shell'
import '@ozwasyd/element-plus/dist/public-shell-critical.css'
import '@ozwasyd/element-plus/dist/el-fsus-theme.css'

const navItems = [
  { key: 'home', label: 'Home', href: '#home' },
  { key: 'archive', label: 'Archive', href: '#archive' },
]

const Harness = {
  render() {
    return h(
      ElPublicShell,
      {
        activeNav: 'home',
        brand: 'FsusUI harness',
        mobileNavLabel: 'Harness navigation',
        mobileNavMenuLabel: 'Menu',
        mobileNavMode: 'menu',
        navItems,
        showSearch: false,
      },
      {
        default: () => h('main', { id: 'harness-content' }, 'isolated public-shell component'),
        'mobile-menu-actions': () => h('button', { type: 'button' }, 'Harness action'),
      },
    )
  },
}

createApp(Harness).mount('#harness')
document.documentElement.dataset.fsusuiHarness = 'ElPublicShell'
