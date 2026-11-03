import { chromium } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const demo = await readFile('vue/packages/demo-app/src/demo-state.ts', 'utf8')
const upload = await readFile('vue/packages/demo-app/src/sections/UploadVisualSection.vue', 'utf8')
const urls = [...demo.matchAll(/https:\/\/cube\.elemecdn\.com[^'\s]+/g)].map(x => x[0])
const local = upload.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/)[0]
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const failed = []
page.on('requestfailed', r => failed.push({url: r.url(), error: r.failure()?.errorText}))
const results = []
try {
 for (const url of [...urls,local]) {
  await page.setContent('<img alt="image diagnostic" src="'+url+'">')
  results.push(await page.locator('img').evaluate(async img => {
   try { await img.decode(); return { resource: img.src.startsWith('data:') ? 'existing Upload fixture data PNG' : img.src, decoded: true, width: img.naturalWidth, height: img.naturalHeight } }
   catch { return { resource: img.src, decoded: false, width: img.naturalWidth, height: img.naturalHeight } }
  }))
 }
 const receipt = { createdAt: new Date().toISOString(), qualification: false, purpose: 'network diagnosis only; no canonical capture assertion replaced', securityOverrides: [], routingOverrides: [], browser: browser.version(), existingLocalFixtureOwner: 'vue/packages/demo-app/src/sections/UploadVisualSection.vue', existingLocalFixtureSha256: createHash('sha256').update(upload).digest('hex'), results, failed }
 await writeFile('/tmp/chain-830-canonical-evidence/cdn-diagnostic.json', JSON.stringify(receipt,null,2)+'\n')
 if (results.slice(0,2).some(x=>x.decoded) || !results[2].decoded || failed.length!==2 || failed.some(x=>x.error!=='net::ERR_CERT_AUTHORITY_INVALID')) throw Error('unexpected network/control result')
 console.log('Two actual CDN certificate failures reproduced; existing canonical local PNG decodes; no TLS or routing overrides')
} finally { await context.close(); await browser.close() }
