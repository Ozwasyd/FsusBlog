# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: capture-all.spec.ts >> capture data
- Location: vue/tests/visual/capture-all.spec.ts:67:7

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 6

- Array []
+ Array [
+   "requestfailed: GET https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png net::ERR_CERT_AUTHORITY_INVALID",
+   "console.error: Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID",
+   "requestfailed: GET https://cube.elemecdn.com/9/c2/f0ee8a3c7c9638a54940382568c9dpng.png net::ERR_CERT_AUTHORITY_INVALID",
+   "console.error: Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e4]:
  - heading "Data" [level=2] [ref=e5]
  - generic [ref=e6]:
    - heading "Table & TableColumn" [level=3] [ref=e7]
    - generic [ref=e9]:
      - table [ref=e11]:
        - rowgroup [ref=e16]:
          - row "标题 操作" [ref=e17]:
            - columnheader [ref=e18]:
              - generic [ref=e21] [cursor=pointer]:
                - checkbox
            - columnheader "标题" [ref=e23]:
              - generic [ref=e24]: 标题
            - columnheader "操作" [ref=e25]:
              - generic [ref=e26]: 操作
      - region "Scrollable data table" [ref=e27]:
        - table [ref=e31]:
          - rowgroup [ref=e36]:
            - row "Tom 显示此行全部字段 打开" [ref=e37]:
              - cell [ref=e38]:
                - generic [ref=e41] [cursor=pointer]:
                  - checkbox
              - cell "Tom 显示此行全部字段" [ref=e43]:
                - generic [ref=e44]: Tom
                - button "显示此行全部字段" [ref=e45] [cursor=pointer]:
                  - generic [ref=e46]: +
              - cell "打开" [ref=e47]:
                - button "打开" [ref=e49] [cursor=pointer]:
                  - generic [ref=e50]: 打开
            - row "John 显示此行全部字段 打开" [ref=e51]:
              - cell [ref=e52]:
                - generic [ref=e55] [cursor=pointer]:
                  - checkbox
              - cell "John 显示此行全部字段" [ref=e57]:
                - generic [ref=e58]: John
                - button "显示此行全部字段" [ref=e59] [cursor=pointer]:
                  - generic [ref=e60]: +
              - cell "打开" [ref=e61]:
                - button "打开" [ref=e63] [cursor=pointer]:
                  - generic [ref=e64]: 打开
    - generic [ref=e68]:
      - table [ref=e70]:
        - rowgroup [ref=e75]:
          - row "标题 标识符 可见范围" [ref=e76]:
            - columnheader "标题" [ref=e77]:
              - generic [ref=e78]: 标题
            - columnheader "标识符" [ref=e79]:
              - generic [ref=e80]: 标识符
            - columnheader "可见范围" [ref=e81]:
              - generic [ref=e82]: 可见范围
      - region "横向浏览文章字段" [ref=e83]:
        - table [ref=e87]:
          - rowgroup [ref=e92]:
            - row "Tom research-note-2016-05-03-long-identifier No. 189, Grove St, Los Angeles" [ref=e93]:
              - cell "Tom" [ref=e94]:
                - generic [ref=e95]: Tom
              - cell "research-note-2016-05-03-long-identifier" [ref=e96]:
                - generic [ref=e97]: research-note-2016-05-03-long-identifier
              - cell "No. 189, Grove St, Los Angeles" [ref=e98]:
                - generic [ref=e99]: No. 189, Grove St, Los Angeles
  - generic [ref=e100]:
    - heading "TableV2 & AutoResizer" [level=3] [ref=e101]
    - table [ref=e105]:
      - rowgroup [ref=e106]:
        - generic [ref=e108]:
          - row "Tom-0 id-0" [ref=e109]:
            - cell "Tom-0" [ref=e110]:
              - generic "Tom-0" [ref=e111]
            - cell "id-0" [ref=e112]:
              - generic "id-0" [ref=e113]
          - row "Tom-1 id-1" [ref=e114]:
            - cell "Tom-1" [ref=e115]:
              - generic "Tom-1" [ref=e116]
            - cell "id-1" [ref=e117]:
              - generic "id-1" [ref=e118]
          - row "Tom-2 id-2" [ref=e119]:
            - cell "Tom-2" [ref=e120]:
              - generic "Tom-2" [ref=e121]
            - cell "id-2" [ref=e122]:
              - generic "id-2" [ref=e123]
          - row "Tom-3 id-3" [ref=e124]:
            - cell "Tom-3" [ref=e125]:
              - generic "Tom-3" [ref=e126]
            - cell "id-3" [ref=e127]:
              - generic "id-3" [ref=e128]
          - row "Tom-4 id-4" [ref=e129]:
            - cell "Tom-4" [ref=e130]:
              - generic "Tom-4" [ref=e131]
            - cell "id-4" [ref=e132]:
              - generic "id-4" [ref=e133]
          - row "Tom-5 id-5" [ref=e134]:
            - cell "Tom-5" [ref=e135]:
              - generic "Tom-5" [ref=e136]
            - cell "id-5" [ref=e137]:
              - generic "id-5" [ref=e138]
          - row "Tom-6 id-6" [ref=e139]:
            - cell "Tom-6" [ref=e140]:
              - generic "Tom-6" [ref=e141]
            - cell "id-6" [ref=e142]:
              - generic "id-6" [ref=e143]
      - rowgroup [ref=e145]:
        - row "Name ID" [ref=e147]:
          - columnheader "Name" [ref=e148]:
            - generic "Name" [ref=e149]
          - columnheader "ID" [ref=e150]:
            - generic "ID" [ref=e151]
  - generic [ref=e152]:
    - heading "Tag / CheckTag" [level=3] [ref=e153]
    - generic [ref=e154]:
      - generic [ref=e156]: 文章
      - generic [ref=e158]: 已发布
      - generic [ref=e160]: 技术笔记
      - generic [ref=e162]: 待复核
      - generic [ref=e164]: 高风险
      - checkbox "已同步" [checked] [ref=e166] [cursor=pointer]
  - generic [ref=e167]:
    - heading "Progress" [level=3] [ref=e168]
    - generic [ref=e169]:
      - progressbar [ref=e171]:
        - generic [ref=e172]: 50%
      - progressbar [ref=e174]:
        - img [ref=e177]
      - progressbar [ref=e181]:
        - img [ref=e184]
      - progressbar [ref=e188]:
        - img [ref=e190]
        - generic [ref=e193]: 25%
  - generic [ref=e194]:
    - heading "Tree" [level=3] [ref=e195]
    - tree [ref=e196]:
      - treeitem "Level one 1" [ref=e197]:
        - generic [ref=e198] [cursor=pointer]:
          - img [ref=e200]
          - generic [ref=e203]:
            - checkbox
          - generic [ref=e205]: Level one 1
  - generic [ref=e206]:
    - heading "TreeV2" [level=3] [ref=e207]
    - tree [ref=e209]:
      - generic [ref=e212]:
        - treeitem "Node 0" [ref=e213]:
          - generic [ref=e215] [cursor=pointer]: Node 0
        - treeitem "Node 1" [ref=e216]:
          - generic [ref=e218] [cursor=pointer]: Node 1
        - treeitem "Node 2" [ref=e219]:
          - generic [ref=e221] [cursor=pointer]: Node 2
        - treeitem "Node 3" [ref=e222]:
          - generic [ref=e224] [cursor=pointer]: Node 3
        - treeitem "Node 4" [ref=e225]:
          - generic [ref=e227] [cursor=pointer]: Node 4
        - treeitem "Node 5" [ref=e228]:
          - generic [ref=e230] [cursor=pointer]: Node 5
        - treeitem "Node 6" [ref=e231]:
          - generic [ref=e233] [cursor=pointer]: Node 6
  - generic [ref=e235]:
    - heading "Pagination" [level=3] [ref=e236]
    - generic [ref=e237]:
      - navigation "文章分页" [ref=e238]:
        - button "上一页" [ref=e239] [cursor=pointer]:
          - generic:
            - img
        - list [ref=e241]:
          - listitem "第 1 页" [ref=e242] [cursor=pointer]: "1"
          - listitem "向前 3 页" [ref=e243] [cursor=pointer]:
            - img
          - listitem "第 4 页" [ref=e244] [cursor=pointer]: "4"
          - listitem "第 5 页" [ref=e245]: "5"
          - listitem "第 6 页" [ref=e246] [cursor=pointer]: "6"
          - listitem "向后 3 页" [ref=e247] [cursor=pointer]:
            - img
          - listitem "第 100 页" [ref=e248] [cursor=pointer]: "100"
        - button "下一页" [ref=e249] [cursor=pointer]:
          - generic:
            - img
      - generic [ref=e251]: 共 1000 条
  - generic [ref=e252]:
    - heading "Badge" [level=3] [ref=e253]
    - generic [ref=e254]:
      - generic [ref=e256]:
        - button "Comments" [ref=e257] [cursor=pointer]:
          - generic [ref=e258]: Comments
        - superscript [ref=e259]: "12"
      - generic [ref=e261]:
        - button "Share article" [ref=e262] [cursor=pointer]:
          - img [ref=e264]
          - generic [ref=e266]: Share article
        - superscript [ref=e267]
  - generic [ref=e268]:
    - heading "Avatar" [level=3] [ref=e269]
    - generic [ref=e276]: User
  - generic [ref=e277]:
    - heading "Skeleton & SkeletonItem" [level=3] [ref=e278]
    - img [ref=e281]
  - generic [ref=e288]:
    - heading "Empty" [level=3] [ref=e289]
    - generic [ref=e290]:
      - img [ref=e292]
      - generic [ref=e297]: 暂无文章
  - generic [ref=e298]:
    - heading "Descriptions & DescriptionsItem" [level=3] [ref=e299]
    - generic [ref=e300]:
      - generic [ref=e302]: 用户资料
      - generic "Description fields" [ref=e304]:
        - generic [ref=e305]:
          - term [ref=e306]: 笔名
          - definition [ref=e307]: 青砚
        - generic [ref=e308]:
          - term [ref=e309]: 联系电话
          - definition [ref=e310]: "18100000000"
        - generic [ref=e311]:
          - term [ref=e312]: 所在地
          - definition [ref=e313]: 苏州
        - generic [ref=e314]:
          - term [ref=e315]: 标签
          - definition [ref=e316]:
            - generic [ref=e317]: 写作
        - generic [ref=e318]:
          - term [ref=e319]: 地址
          - definition [ref=e320]: 江苏省苏州市吴中区吴中大道 1188 号
        - generic [ref=e321]:
          - term [ref=e322]: 主页
          - definition [ref=e323]: https://example.com/authors/青砚/research-notes-and-publications
        - generic [ref=e324]:
          - term [ref=e325]: 备注
          - definition
  - generic [ref=e326]:
    - heading "Descriptions spacing matrix" [level=3] [ref=e327]
    - generic [ref=e328]:
      - generic [ref=e330]:
        - generic [ref=e332]: bordered large
        - generic "Description fields" [ref=e334]:
          - generic [ref=e335]:
            - term [ref=e336]: 笔名
            - definition [ref=e337]: 青砚
          - generic [ref=e338]:
            - term [ref=e339]: 所在地
            - definition [ref=e340]: 苏州
          - generic [ref=e341]:
            - term [ref=e342]: 主页
            - definition [ref=e343]: https://example.com/authors/qingyan
      - generic [ref=e345]:
        - generic [ref=e347]: bordered default
        - generic "Description fields" [ref=e349]:
          - generic [ref=e350]:
            - term [ref=e351]: 笔名
            - definition [ref=e352]: 青砚
          - generic [ref=e353]:
            - term [ref=e354]: 所在地
            - definition [ref=e355]: 苏州
          - generic [ref=e356]:
            - term [ref=e357]: 地址
            - definition [ref=e358]: 江苏省苏州市吴中区吴中大道 1188 号
      - generic [ref=e360]:
        - generic [ref=e362]: bordered small
        - generic "Description fields" [ref=e364]:
          - generic [ref=e365]:
            - term [ref=e366]: 笔名
            - definition [ref=e367]: 青砚
          - generic [ref=e368]:
            - term [ref=e369]: 所在地
            - definition [ref=e370]: 苏州
      - generic [ref=e372]:
        - generic [ref=e374]: non-bordered default
        - generic "Description fields" [ref=e376]:
          - generic [ref=e377]:
            - term [ref=e378]: 笔名
            - definition [ref=e379]: 青砚
          - generic [ref=e380]:
            - term [ref=e381]: 所在地
            - definition [ref=e382]: 苏州
      - generic [ref=e384]:
        - generic [ref=e386]: bordered vertical
        - generic "Description fields" [ref=e388]:
          - generic [ref=e389]:
            - term [ref=e390]: 笔名
            - definition [ref=e391]: 青砚
          - generic [ref=e392]:
            - term [ref=e393]: 备注
            - definition [ref=e394]: 长备注：研究笔记、出版记录与公开主页摘要。
      - generic [ref=e396]:
        - generic [ref=e398]: responsive stack
        - generic "Description fields" [ref=e400]:
          - generic [ref=e401]:
            - term [ref=e402]: 笔名
            - definition [ref=e403]: 青砚
          - generic [ref=e404]:
            - term [ref=e405]: 所在地
            - definition [ref=e406]: 苏州
  - generic [ref=e407]:
    - heading "Result" [level=3] [ref=e408]
    - generic [ref=e409]:
      - img [ref=e411]
      - generic [ref=e413]: 已发布
      - generic [ref=e414]: 读者将看到最新版本
      - button "返回文章列表" [ref=e416] [cursor=pointer]:
        - generic [ref=e417]: 返回文章列表
  - generic [ref=e418]:
    - heading "Statistic / Countdown" [level=3] [ref=e419]
    - generic [ref=e420]:
      - generic [ref=e422]:
        - generic [ref=e423]: 今日活跃读者
        - generic [ref=e424]: 268,500
      - generic [ref=e426]:
        - generic [ref=e427]: 距定时发布
        - generic [ref=e428]: 47:59:58
  - generic [ref=e429]:
    - heading "Timeline & TimelineItem" [level=3] [ref=e430]
    - list [ref=e431]:
      - listitem [ref=e432]:
        - generic [ref=e435]:
          - generic [ref=e436]: 2018/4/12
          - generic [ref=e437]: 更新封面图
      - listitem [ref=e438]:
        - generic [ref=e440]:
          - generic [ref=e441]: 2018/4/3
          - generic [ref=e442]: 校对摘要
  - generic [ref=e443]:
    - heading "Calendar" [level=3] [ref=e444]
    - generic [ref=e445]:
      - generic [ref=e446]:
        - generic [ref=e447]: 2026年10月
        - generic [ref=e449]:
          - button "上个月" [ref=e450] [cursor=pointer]:
            - img [ref=e453]
          - button "今天" [ref=e455] [cursor=pointer]:
            - generic [ref=e456]: 今天
          - button "下个月" [ref=e457] [cursor=pointer]:
            - img [ref=e460]
      - table [ref=e463]:
        - rowgroup [ref=e464]:
          - columnheader "一" [ref=e465]
          - columnheader "二" [ref=e466]
          - columnheader "三" [ref=e467]
          - columnheader "四" [ref=e468]
          - columnheader "五" [ref=e469]
          - columnheader "六" [ref=e470]
          - columnheader "日" [ref=e471]
        - rowgroup [ref=e472]:
          - row "28 29 30 1 2 3 4" [ref=e473]:
            - cell "28" [ref=e474]:
              - generic [ref=e475]: "28"
            - cell "29" [ref=e476]:
              - generic [ref=e477]: "29"
            - cell "30" [ref=e478]:
              - generic [ref=e479]: "30"
            - cell "1" [ref=e480]:
              - generic [ref=e481]: "1"
            - cell "2" [ref=e482]:
              - generic [ref=e483]: "2"
            - cell "3" [ref=e484]:
              - generic [ref=e485]: "3"
            - cell "4" [ref=e486]:
              - generic [ref=e487]: "4"
          - row "5 6 7 8 9 10 11" [ref=e488]:
            - cell "5" [ref=e489]:
              - generic [ref=e490]: "5"
            - cell "6" [ref=e491]:
              - generic [ref=e492]: "6"
            - cell "7" [ref=e493]:
              - generic [ref=e494]: "7"
            - cell "8" [ref=e495]:
              - generic [ref=e496]: "8"
            - cell "9" [ref=e497]:
              - generic [ref=e498]: "9"
            - cell "10" [ref=e499]:
              - generic [ref=e500]: "10"
            - cell "11" [ref=e501]:
              - generic [ref=e502]: "11"
          - row "12 13 14 15 16 17 18" [ref=e503]:
            - cell "12" [ref=e504]:
              - generic [ref=e505]: "12"
            - cell "13" [ref=e506]:
              - generic [ref=e507]: "13"
            - cell "14" [ref=e508]:
              - generic [ref=e509]: "14"
            - cell "15" [ref=e510]:
              - generic [ref=e511]: "15"
            - cell "16" [ref=e512]:
              - generic [ref=e513]: "16"
            - cell "17" [ref=e514]:
              - generic [ref=e515]: "17"
            - cell "18" [ref=e516]:
              - generic [ref=e517]: "18"
          - row "19 20 21 22 23 24 25" [ref=e518]:
            - cell "19" [ref=e519]:
              - generic [ref=e520]: "19"
            - cell "20" [ref=e521]:
              - generic [ref=e522]: "20"
            - cell "21" [ref=e523]:
              - generic [ref=e524]: "21"
            - cell "22" [ref=e525]:
              - generic [ref=e526]: "22"
            - cell "23" [ref=e527]:
              - generic [ref=e528]: "23"
            - cell "24" [ref=e529]:
              - generic [ref=e530]: "24"
            - cell "25" [ref=e531]:
              - generic [ref=e532]: "25"
          - row "26 27 28 29 30 31 1" [ref=e533]:
            - cell "26" [ref=e534]:
              - generic [ref=e535]: "26"
            - cell "27" [ref=e536]:
              - generic [ref=e537]: "27"
            - cell "28" [ref=e538]:
              - generic [ref=e539]: "28"
            - cell "29" [ref=e540]:
              - generic [ref=e541]: "29"
            - cell "30" [ref=e542]:
              - generic [ref=e543]: "30"
            - cell "31" [ref=e544]:
              - generic [ref=e545]: "31"
            - cell "1" [ref=e546]:
              - generic [ref=e547]: "1"
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test'
  2  | import type { Page } from '@playwright/test'
  3  | import {
  4  |   buildVisualUrl,
  5  |   resolveVisualVariant,
  6  | } from '../../../scripts/visual-variant.mjs'
  7  | import { createVisualCaptureTestTitle } from '../../../scripts/visual-profiles.mjs'
  8  | import { attachPageDiagnostics } from '../support/page-diagnostics'
  9  | 
  10 | type VisualSection = {
  11 |   name: string
  12 |   testId: string
  13 |   action?: (page: Page) => Promise<void>
  14 | }
  15 | 
  16 | const diagnostics = new WeakMap<Page, string[]>()
  17 | 
  18 | const stabilizePage = async (page: Page) => {
  19 |   await page.addStyleTag({
  20 |     content: `
  21 |       *, *::before, *::after {
  22 |         transition-duration: 0s !important;
  23 |         animation-duration: 0s !important;
  24 |         animation-delay: 0s !important;
  25 |         scroll-behavior: auto !important;
  26 |       }
  27 |     `,
  28 |   })
  29 | }
  30 | 
  31 | test.beforeEach(async ({ page }) => {
  32 |   diagnostics.set(page, attachPageDiagnostics(page))
  33 |   await page.emulateMedia({ reducedMotion: 'reduce' })
  34 | })
  35 | 
  36 | test.afterEach(async ({ page }) => {
> 37 |   expect(diagnostics.get(page) ?? []).toEqual([])
     |                                       ^ Error: expect(received).toEqual(expected) // deep equality
  38 | })
  39 | 
  40 | const sections: VisualSection[] = [
  41 |   { name: 'basic', testId: 'section-basic' },
  42 |   { name: 'form', testId: 'section-form' },
  43 |   { name: 'data', testId: 'section-data' },
  44 |   {
  45 |     name: 'navigation',
  46 |     testId: 'section-navigation',
  47 |     action: async (page) => {
  48 |       await page
  49 |         .locator('.dropdown-trigger-proxy button')
  50 |         .click({ force: true })
  51 |       await page.waitForTimeout(500)
  52 |     },
  53 |   },
  54 |   {
  55 |     name: 'feedback',
  56 |     testId: 'section-feedback',
  57 |     action: async (page) => {
  58 |       await page.getByTestId('open-publish-dialog').click()
  59 |       await page.waitForTimeout(500)
  60 |     },
  61 |   },
  62 |   { name: 'others', testId: 'section-others' },
  63 |   { name: 'icons', testId: 'section-icons' },
  64 | ]
  65 | 
  66 | for (const section of sections) {
  67 |   test(
  68 |     createVisualCaptureTestTitle(section.name),
  69 |     async ({ page }, testInfo) => {
  70 |       const variant = resolveVisualVariant(testInfo.project.name)
  71 |       await page.goto(buildVisualUrl(section.name, testInfo.project.name), {
  72 |         waitUntil: 'domcontentloaded',
  73 |       })
  74 |       await stabilizePage(page)
  75 | 
  76 |       const locator = page.locator(`[data-testid="${section.testId}"]`)
  77 |       await expect(locator).toBeVisible()
  78 | 
  79 |       if (section.action) {
  80 |         await section.action(page)
  81 |       }
  82 | 
  83 |       await page.screenshot({
  84 |         path: testInfo.outputPath(
  85 |           'screenshots',
  86 |           'capture-all',
  87 |           testInfo.project.name,
  88 |           section.name,
  89 |           `${variant.theme}-full-page.png`,
  90 |         ),
  91 |         fullPage: true,
  92 |       })
  93 |     },
  94 |   )
  95 | }
  96 | 
```