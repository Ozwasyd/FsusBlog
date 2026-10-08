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
        - rowgroup [ref=e23]:
          - row "标题 发布日期 作者 状态 分类 阅读量 标识符 可见范围 操作" [ref=e24]:
            - columnheader [ref=e25]:
              - generic [ref=e28] [cursor=pointer]:
                - checkbox
            - columnheader "标题" [ref=e30]:
              - generic [ref=e31]: 标题
            - columnheader "发布日期" [ref=e32]:
              - generic [ref=e33]: 发布日期
            - columnheader "作者" [ref=e34]:
              - generic [ref=e35]: 作者
            - columnheader "状态" [ref=e36]:
              - generic [ref=e37]: 状态
            - columnheader "分类" [ref=e38]:
              - generic [ref=e39]: 分类
            - columnheader "阅读量" [ref=e40]:
              - generic [ref=e41]: 阅读量
            - columnheader "标识符" [ref=e42]:
              - generic [ref=e43]: 标识符
            - columnheader "可见范围" [ref=e44]:
              - generic [ref=e45]: 可见范围
            - columnheader "操作" [ref=e46]:
              - generic [ref=e47]: 操作
      - table [ref=e52]:
        - rowgroup [ref=e64]:
          - row "Tom 2016-05-03 青砚 已发布 研究笔记 12840 research-note-2016-05-03-long-identifier No. 189, Grove St, Los Angeles 打开" [ref=e65]:
            - cell [ref=e66]:
              - generic [ref=e69] [cursor=pointer]:
                - checkbox
            - cell "Tom" [ref=e71]:
              - generic [ref=e72]: Tom
            - cell "2016-05-03" [ref=e73]:
              - generic [ref=e74]: 2016-05-03
            - cell "青砚" [ref=e75]:
              - generic [ref=e76]: 青砚
            - cell "已发布" [ref=e77]:
              - generic [ref=e78]: 已发布
            - cell "研究笔记" [ref=e79]:
              - generic [ref=e80]: 研究笔记
            - cell "12840" [ref=e81]:
              - generic [ref=e82]: "12840"
            - cell "research-note-2016-05-03-long-identifier" [ref=e83]:
              - generic [ref=e84]: research-note-2016-05-03-long-identifier
            - cell "No. 189, Grove St, Los Angeles" [ref=e85]:
              - generic [ref=e86]: No. 189, Grove St, Los Angeles
            - cell "打开" [ref=e87]:
              - button "打开" [ref=e89] [cursor=pointer]:
                - generic [ref=e90]: 打开
          - row "John 2016-05-02 Lin 草稿 随笔 320 draft-2016-05-02 No. 189, Grove St, Los Angeles 打开" [ref=e91]:
            - cell [ref=e92]:
              - generic [ref=e95] [cursor=pointer]:
                - checkbox
            - cell "John" [ref=e97]:
              - generic [ref=e98]: John
            - cell "2016-05-02" [ref=e99]:
              - generic [ref=e100]: 2016-05-02
            - cell "Lin" [ref=e101]:
              - generic [ref=e102]: Lin
            - cell "草稿" [ref=e103]:
              - generic [ref=e104]: 草稿
            - cell "随笔" [ref=e105]:
              - generic [ref=e106]: 随笔
            - cell "320" [ref=e107]:
              - generic [ref=e108]: "320"
            - cell "draft-2016-05-02" [ref=e109]:
              - generic [ref=e110]: draft-2016-05-02
            - cell "No. 189, Grove St, Los Angeles" [ref=e111]:
              - generic [ref=e112]: No. 189, Grove St, Los Angeles
            - cell "打开" [ref=e113]:
              - button "打开" [ref=e115] [cursor=pointer]:
                - generic [ref=e116]: 打开
    - generic [ref=e120]:
      - table [ref=e122]:
        - rowgroup [ref=e127]:
          - row "标题 标识符 可见范围" [ref=e128]:
            - columnheader "标题" [ref=e129]:
              - generic [ref=e130]: 标题
            - columnheader "标识符" [ref=e131]:
              - generic [ref=e132]: 标识符
            - columnheader "可见范围" [ref=e133]:
              - generic [ref=e134]: 可见范围
      - region "横向浏览文章字段" [ref=e135]:
        - table [ref=e139]:
          - rowgroup [ref=e144]:
            - row "Tom research-note-2016-05-03-long-identifier No. 189, Grove St, Los Angeles" [ref=e145]:
              - cell "Tom" [ref=e146]:
                - generic [ref=e147]: Tom
              - cell "research-note-2016-05-03-long-identifier" [ref=e148]:
                - generic [ref=e149]: research-note-2016-05-03-long-identifier
              - cell "No. 189, Grove St, Los Angeles" [ref=e150]:
                - generic [ref=e151]: No. 189, Grove St, Los Angeles
  - generic [ref=e152]:
    - heading "TableV2 & AutoResizer" [level=3] [ref=e153]
    - table [ref=e157]:
      - rowgroup [ref=e158]:
        - generic [ref=e160]:
          - row "Tom-0 id-0" [ref=e161]:
            - cell "Tom-0" [ref=e162]:
              - generic "Tom-0" [ref=e163]
            - cell "id-0" [ref=e164]:
              - generic "id-0" [ref=e165]
          - row "Tom-1 id-1" [ref=e166]:
            - cell "Tom-1" [ref=e167]:
              - generic "Tom-1" [ref=e168]
            - cell "id-1" [ref=e169]:
              - generic "id-1" [ref=e170]
          - row "Tom-2 id-2" [ref=e171]:
            - cell "Tom-2" [ref=e172]:
              - generic "Tom-2" [ref=e173]
            - cell "id-2" [ref=e174]:
              - generic "id-2" [ref=e175]
          - row "Tom-3 id-3" [ref=e176]:
            - cell "Tom-3" [ref=e177]:
              - generic "Tom-3" [ref=e178]
            - cell "id-3" [ref=e179]:
              - generic "id-3" [ref=e180]
          - row "Tom-4 id-4" [ref=e181]:
            - cell "Tom-4" [ref=e182]:
              - generic "Tom-4" [ref=e183]
            - cell "id-4" [ref=e184]:
              - generic "id-4" [ref=e185]
          - row "Tom-5 id-5" [ref=e186]:
            - cell "Tom-5" [ref=e187]:
              - generic "Tom-5" [ref=e188]
            - cell "id-5" [ref=e189]:
              - generic "id-5" [ref=e190]
          - row "Tom-6 id-6" [ref=e191]:
            - cell "Tom-6" [ref=e192]:
              - generic "Tom-6" [ref=e193]
            - cell "id-6" [ref=e194]:
              - generic "id-6" [ref=e195]
      - rowgroup [ref=e197]:
        - row "Name ID" [ref=e199]:
          - columnheader "Name" [ref=e200]:
            - generic "Name" [ref=e201]
          - columnheader "ID" [ref=e202]:
            - generic "ID" [ref=e203]
  - generic [ref=e204]:
    - heading "Tag / CheckTag" [level=3] [ref=e205]
    - generic [ref=e206]:
      - generic [ref=e208]: 文章
      - generic [ref=e210]: 已发布
      - generic [ref=e212]: 技术笔记
      - generic [ref=e214]: 待复核
      - generic [ref=e216]: 高风险
      - checkbox "已同步" [checked] [ref=e218] [cursor=pointer]
  - generic [ref=e219]:
    - heading "Progress" [level=3] [ref=e220]
    - generic [ref=e221]:
      - progressbar [ref=e223]:
        - generic [ref=e224]: 50%
      - progressbar [ref=e226]:
        - img [ref=e229]
      - progressbar [ref=e233]:
        - img [ref=e236]
      - progressbar [ref=e240]:
        - img [ref=e242]
        - generic [ref=e245]: 25%
  - generic [ref=e246]:
    - heading "Tree" [level=3] [ref=e247]
    - tree [ref=e248]:
      - treeitem "Level one 1" [ref=e249]:
        - generic [ref=e250] [cursor=pointer]:
          - img [ref=e252]
          - generic [ref=e255]:
            - checkbox
          - generic [ref=e257]: Level one 1
  - generic [ref=e258]:
    - heading "TreeV2" [level=3] [ref=e259]
    - tree [ref=e261]:
      - generic [ref=e264]:
        - treeitem "Node 0" [ref=e265]:
          - generic [ref=e267] [cursor=pointer]: Node 0
        - treeitem "Node 1" [ref=e268]:
          - generic [ref=e270] [cursor=pointer]: Node 1
        - treeitem "Node 2" [ref=e271]:
          - generic [ref=e273] [cursor=pointer]: Node 2
        - treeitem "Node 3" [ref=e274]:
          - generic [ref=e276] [cursor=pointer]: Node 3
        - treeitem "Node 4" [ref=e277]:
          - generic [ref=e279] [cursor=pointer]: Node 4
        - treeitem "Node 5" [ref=e280]:
          - generic [ref=e282] [cursor=pointer]: Node 5
        - treeitem "Node 6" [ref=e283]:
          - generic [ref=e285] [cursor=pointer]: Node 6
  - generic [ref=e287]:
    - heading "Pagination" [level=3] [ref=e288]
    - generic [ref=e289]:
      - navigation "文章分页" [ref=e290]:
        - button "上一页" [ref=e291] [cursor=pointer]:
          - generic:
            - img
        - list [ref=e293]:
          - listitem "第 1 页" [ref=e294] [cursor=pointer]: "1"
          - listitem "向前 5 页" [ref=e295] [cursor=pointer]:
            - img
          - listitem "第 3 页" [ref=e296] [cursor=pointer]: "3"
          - listitem "第 4 页" [ref=e297] [cursor=pointer]: "4"
          - listitem "第 5 页" [ref=e298]: "5"
          - listitem "第 6 页" [ref=e299] [cursor=pointer]: "6"
          - listitem "第 7 页" [ref=e300] [cursor=pointer]: "7"
          - listitem "向后 5 页" [ref=e301] [cursor=pointer]:
            - img
          - listitem "第 100 页" [ref=e302] [cursor=pointer]: "100"
        - button "下一页" [ref=e303] [cursor=pointer]:
          - generic:
            - img
      - generic [ref=e304]:
        - generic [ref=e305]: 共 1000 条
        - generic [ref=e306]:
          - generic [ref=e307]: 前往
          - spinbutton "页" [ref=e310]: "5"
          - generic [ref=e311]: 页
  - generic [ref=e312]:
    - heading "Badge" [level=3] [ref=e313]
    - generic [ref=e314]:
      - generic [ref=e316]:
        - button "Comments" [ref=e317] [cursor=pointer]:
          - generic [ref=e318]: Comments
        - superscript [ref=e319]: "12"
      - generic [ref=e321]:
        - button "Share article" [ref=e322] [cursor=pointer]:
          - img [ref=e324]
          - generic [ref=e326]: Share article
        - superscript [ref=e327]
  - generic [ref=e328]:
    - heading "Avatar" [level=3] [ref=e329]
    - generic [ref=e336]: User
  - generic [ref=e337]:
    - heading "Skeleton & SkeletonItem" [level=3] [ref=e338]
    - img [ref=e341]
  - generic [ref=e348]:
    - heading "Empty" [level=3] [ref=e349]
    - generic [ref=e350]:
      - img [ref=e352]
      - generic [ref=e357]: 暂无文章
  - generic [ref=e358]:
    - heading "Descriptions & DescriptionsItem" [level=3] [ref=e359]
    - generic [ref=e360]:
      - generic [ref=e362]: 用户资料
      - table [ref=e365]:
        - rowgroup [ref=e366]:
          - row "笔名 青砚 联系电话 18100000000 所在地 苏州" [ref=e367]:
            - cell "笔名" [ref=e368]
            - cell "青砚" [ref=e369]
            - cell "联系电话" [ref=e370]
            - cell "18100000000" [ref=e371]
            - cell "所在地" [ref=e372]
            - cell "苏州" [ref=e373]
          - row "标签 写作 地址 江苏省苏州市吴中区吴中大道 1188 号 主页 https://example.com/authors/青砚/research-notes-and-publications" [ref=e374]:
            - cell "标签" [ref=e375]
            - cell "写作" [ref=e376]:
              - generic [ref=e377]: 写作
            - cell "地址" [ref=e378]
            - cell "江苏省苏州市吴中区吴中大道 1188 号" [ref=e379]
            - cell "主页" [ref=e380]
            - cell "https://example.com/authors/青砚/research-notes-and-publications" [ref=e381]
          - row "备注" [ref=e382]:
            - cell "备注" [ref=e383]
            - cell [ref=e384]
  - generic [ref=e385]:
    - heading "Descriptions spacing matrix" [level=3] [ref=e386]
    - generic [ref=e387]:
      - generic [ref=e389]:
        - generic [ref=e391]: bordered large
        - table [ref=e394]:
          - rowgroup [ref=e395]:
            - row "笔名 青砚 所在地 苏州" [ref=e396]:
              - cell "笔名" [ref=e397]
              - cell "青砚" [ref=e398]
              - cell "所在地" [ref=e399]
              - cell "苏州" [ref=e400]
            - row "主页 https://example.com/authors/qingyan" [ref=e401]:
              - cell "主页" [ref=e402]
              - cell "https://example.com/authors/qingyan" [ref=e403]
      - generic [ref=e405]:
        - generic [ref=e407]: bordered default
        - table [ref=e410]:
          - rowgroup [ref=e411]:
            - row "笔名 青砚 所在地 苏州" [ref=e412]:
              - cell "笔名" [ref=e413]
              - cell "青砚" [ref=e414]
              - cell "所在地" [ref=e415]
              - cell "苏州" [ref=e416]
            - row "地址 江苏省苏州市吴中区吴中大道 1188 号" [ref=e417]:
              - cell "地址" [ref=e418]
              - cell "江苏省苏州市吴中区吴中大道 1188 号" [ref=e419]
      - generic [ref=e421]:
        - generic [ref=e423]: bordered small
        - table [ref=e426]:
          - rowgroup [ref=e427]:
            - row "笔名 青砚 所在地 苏州" [ref=e428]:
              - cell "笔名" [ref=e429]
              - cell "青砚" [ref=e430]
              - cell "所在地" [ref=e431]
              - cell "苏州" [ref=e432]
      - generic [ref=e434]:
        - generic [ref=e436]: non-bordered default
        - table [ref=e439]:
          - rowgroup [ref=e440]:
            - row "笔名青砚 所在地苏州" [ref=e441]:
              - cell "笔名青砚" [ref=e442]
              - cell "所在地苏州" [ref=e443]
      - generic [ref=e445]:
        - generic [ref=e447]: bordered vertical
        - table [ref=e450]:
          - rowgroup [ref=e451]:
            - row "笔名 备注" [ref=e452]:
              - columnheader "笔名" [ref=e453]
              - columnheader "备注" [ref=e454]
            - row "青砚 长备注：研究笔记、出版记录与公开主页摘要。" [ref=e455]:
              - cell "青砚" [ref=e456]
              - cell "长备注：研究笔记、出版记录与公开主页摘要。" [ref=e457]
      - generic [ref=e459]:
        - generic [ref=e461]: responsive stack
        - generic "Description fields" [ref=e463]:
          - generic [ref=e464]:
            - term [ref=e465]: 笔名
            - definition [ref=e466]: 青砚
          - generic [ref=e467]:
            - term [ref=e468]: 所在地
            - definition [ref=e469]: 苏州
  - generic [ref=e470]:
    - heading "Result" [level=3] [ref=e471]
    - generic [ref=e472]:
      - img [ref=e474]
      - generic [ref=e476]: 已发布
      - generic [ref=e477]: 读者将看到最新版本
      - button "返回文章列表" [ref=e479] [cursor=pointer]:
        - generic [ref=e480]: 返回文章列表
  - generic [ref=e481]:
    - heading "Statistic / Countdown" [level=3] [ref=e482]
    - generic [ref=e483]:
      - generic [ref=e485]:
        - generic [ref=e486]: 今日活跃读者
        - generic [ref=e487]: 268,500
      - generic [ref=e489]:
        - generic [ref=e490]: 距定时发布
        - generic [ref=e491]: 47:59:58
  - generic [ref=e492]:
    - heading "Timeline & TimelineItem" [level=3] [ref=e493]
    - list [ref=e494]:
      - listitem [ref=e495]:
        - generic [ref=e498]:
          - generic [ref=e499]: 2018/4/12
          - generic [ref=e500]: 更新封面图
      - listitem [ref=e501]:
        - generic [ref=e503]:
          - generic [ref=e504]: 2018/4/3
          - generic [ref=e505]: 校对摘要
  - generic [ref=e506]:
    - heading "Calendar" [level=3] [ref=e507]
    - generic [ref=e508]:
      - generic [ref=e509]:
        - generic [ref=e510]: 2026年10月
        - generic [ref=e512]:
          - button "上个月" [ref=e513] [cursor=pointer]:
            - generic [ref=e515]: 上个月
          - button "今天" [ref=e516] [cursor=pointer]:
            - generic [ref=e517]: 今天
          - button "下个月" [ref=e518] [cursor=pointer]:
            - generic [ref=e520]: 下个月
      - table [ref=e522]:
        - rowgroup [ref=e523]:
          - columnheader "一" [ref=e524]
          - columnheader "二" [ref=e525]
          - columnheader "三" [ref=e526]
          - columnheader "四" [ref=e527]
          - columnheader "五" [ref=e528]
          - columnheader "六" [ref=e529]
          - columnheader "日" [ref=e530]
        - rowgroup [ref=e531]:
          - row "28 29 30 1 2 3 4" [ref=e532]:
            - cell "28" [ref=e533]:
              - generic [ref=e534]: "28"
            - cell "29" [ref=e535]:
              - generic [ref=e536]: "29"
            - cell "30" [ref=e537]:
              - generic [ref=e538]: "30"
            - cell "1" [ref=e539]:
              - generic [ref=e540]: "1"
            - cell "2" [ref=e541]:
              - generic [ref=e542]: "2"
            - cell "3" [ref=e543]:
              - generic [ref=e544]: "3"
            - cell "4" [ref=e545]:
              - generic [ref=e546]: "4"
          - row "5 6 7 8 9 10 11" [ref=e547]:
            - cell "5" [ref=e548]:
              - generic [ref=e549]: "5"
            - cell "6" [ref=e550]:
              - generic [ref=e551]: "6"
            - cell "7" [ref=e552]:
              - generic [ref=e553]: "7"
            - cell "8" [ref=e554]:
              - generic [ref=e555]: "8"
            - cell "9" [ref=e556]:
              - generic [ref=e557]: "9"
            - cell "10" [ref=e558]:
              - generic [ref=e559]: "10"
            - cell "11" [ref=e560]:
              - generic [ref=e561]: "11"
          - row "12 13 14 15 16 17 18" [ref=e562]:
            - cell "12" [ref=e563]:
              - generic [ref=e564]: "12"
            - cell "13" [ref=e565]:
              - generic [ref=e566]: "13"
            - cell "14" [ref=e567]:
              - generic [ref=e568]: "14"
            - cell "15" [ref=e569]:
              - generic [ref=e570]: "15"
            - cell "16" [ref=e571]:
              - generic [ref=e572]: "16"
            - cell "17" [ref=e573]:
              - generic [ref=e574]: "17"
            - cell "18" [ref=e575]:
              - generic [ref=e576]: "18"
          - row "19 20 21 22 23 24 25" [ref=e577]:
            - cell "19" [ref=e578]:
              - generic [ref=e579]: "19"
            - cell "20" [ref=e580]:
              - generic [ref=e581]: "20"
            - cell "21" [ref=e582]:
              - generic [ref=e583]: "21"
            - cell "22" [ref=e584]:
              - generic [ref=e585]: "22"
            - cell "23" [ref=e586]:
              - generic [ref=e587]: "23"
            - cell "24" [ref=e588]:
              - generic [ref=e589]: "24"
            - cell "25" [ref=e590]:
              - generic [ref=e591]: "25"
          - row "26 27 28 29 30 31 1" [ref=e592]:
            - cell "26" [ref=e593]:
              - generic [ref=e594]: "26"
            - cell "27" [ref=e595]:
              - generic [ref=e596]: "27"
            - cell "28" [ref=e597]:
              - generic [ref=e598]: "28"
            - cell "29" [ref=e599]:
              - generic [ref=e600]: "29"
            - cell "30" [ref=e601]:
              - generic [ref=e602]: "30"
            - cell "31" [ref=e603]:
              - generic [ref=e604]: "31"
            - cell "1" [ref=e605]:
              - generic [ref=e606]: "1"
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