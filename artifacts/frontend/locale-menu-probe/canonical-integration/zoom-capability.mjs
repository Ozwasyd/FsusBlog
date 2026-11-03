import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
const extension='/tmp/chain-830-realzoom-extension'
const context=await chromium.launchPersistentContext('/tmp/chain-830-realzoom-profile',{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:375,height:900}})
try {
 const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:10000})
 const page=context.pages()[0];await page.goto('http://127.0.0.1:4173')
 const before=await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,cssZoom:getComputedStyle(document.documentElement).zoom}))
 const zoom=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url);await chrome.tabs.setZoomSettings(tab.id,{scope:'per-tab',mode:'automatic'});await chrome.tabs.setZoom(tab.id,2);return chrome.tabs.getZoom(tab.id)},page.url())
 await page.waitForFunction(()=>devicePixelRatio===2)
 const after=await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,cssZoom:getComputedStyle(document.documentElement).zoom}))
 await writeFile('/tmp/chain-830-canonical-evidence/real-zoom-capability.json',JSON.stringify({zoom,before,after,browser:context.browser().version(),qualification:false},null,2)+'\n')
 if(zoom!==2 || after.width>=before.width || after.cssZoom!=='1')throw Error('zoom proof failed')
 console.log('Actual chrome.tabs.getZoom=2; DPR doubles and CSS viewport shrinks; root CSS zoom stays 1')
}finally{await context.close()}
