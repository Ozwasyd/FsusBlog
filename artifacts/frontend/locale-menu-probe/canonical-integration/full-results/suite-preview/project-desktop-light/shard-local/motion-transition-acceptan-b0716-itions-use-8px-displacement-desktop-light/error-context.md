# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: motion-transition-acceptance.spec.ts >> list transitions use <=8px displacement
- Location: vue/tests/visual/motion-transition-acceptance.spec.ts:50:5

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
- generic [ref=e3]:
  - generic [ref=e4]:
    - heading "FsusUI 组件预览" [level=1] [ref=e5]
    - paragraph [ref=e6]: v2.2-STABLE
    - generic "Demo sections" [ref=e7]:
      - button "Basic" [ref=e8] [cursor=pointer]
      - button "Form" [ref=e9] [cursor=pointer]
      - button "Data" [ref=e10] [cursor=pointer]
      - button "Navigation" [ref=e11] [cursor=pointer]
      - button "Feedback" [ref=e12] [cursor=pointer]
      - button "Others" [ref=e13] [cursor=pointer]
      - button "Icons" [ref=e14] [cursor=pointer]
      - 'button "Issue #1" [ref=e15] [cursor=pointer]'
      - button "Markdown Stress" [ref=e16] [cursor=pointer]
  - generic [ref=e17]:
    - generic [ref=e19]:
      - heading "Basic" [level=2] [ref=e20]
      - generic [ref=e21]:
        - heading "Button & ButtonGroup" [level=3] [ref=e22]
        - generic [ref=e23]:
          - button "Default" [ref=e25] [cursor=pointer]:
            - generic [ref=e26]: Default
          - button "Primary" [ref=e28] [cursor=pointer]:
            - generic [ref=e29]: Primary
          - button "Success" [ref=e31] [cursor=pointer]:
            - generic [ref=e32]: Success
          - button "Info" [ref=e34] [cursor=pointer]:
            - generic [ref=e35]: Info
          - button "Warning" [ref=e37] [cursor=pointer]:
            - generic [ref=e38]: Warning
          - button "Danger" [ref=e40] [cursor=pointer]:
            - generic [ref=e41]: Danger
          - button "Disabled" [disabled] [ref=e43]:
            - generic [ref=e44]: Disabled
          - generic [ref=e46]:
            - button "Prev" [ref=e47] [cursor=pointer]:
              - img [ref=e49]
              - generic [ref=e51]: Prev
            - button "Next" [ref=e52] [cursor=pointer]:
              - generic [ref=e53]:
                - text: Next
                - img [ref=e55]
      - generic [ref=e57]:
        - heading "Link" [level=3] [ref=e58]
        - generic [ref=e59]:
          - generic [ref=e62] [cursor=pointer]: Default
          - generic [ref=e65] [cursor=pointer]: Primary
          - generic [ref=e68] [cursor=pointer]: Success
          - generic [ref=e71] [cursor=pointer]: Warning
          - generic [ref=e74] [cursor=pointer]: Danger
          - generic [ref=e77] [cursor=pointer]: Info
      - generic [ref=e78]:
        - heading "Text" [level=3] [ref=e79]
        - generic [ref=e80]:
          - generic [ref=e82]: Default
          - generic [ref=e84]: Primary
          - generic [ref=e86]: Success
          - generic [ref=e88]: Warning
          - generic [ref=e90]: Danger
          - generic [ref=e92]: Info
          - generic [ref=e94]: Truncated text content
      - generic [ref=e95]:
        - heading "Real font weights · 真实字重" [level=3] [ref=e96]
        - generic [ref=e97]:
          - generic [ref=e98]: Latin 400 · 中文正文
          - generic [ref=e99]: Latin 500 · 中文强调
          - generic [ref=e100]: Latin 700 · 中文标题
      - generic [ref=e101]:
        - heading "Icon" [level=3] [ref=e102]
        - generic [ref=e103]:
          - img [ref=e106]
          - img [ref=e110]
      - generic [ref=e113]:
        - heading "Layout (Row/Col)" [level=3] [ref=e114]
        - generic [ref=e115]:
          - generic [ref=e117]: "6"
          - generic [ref=e119]: "6"
          - generic [ref=e121]: "6"
          - generic [ref=e123]: "6"
      - generic [ref=e124]:
        - heading "Container (Header/Aside/Main/Footer)" [level=3] [ref=e125]
        - generic [ref=e126]:
          - generic [ref=e127]: Header
          - generic [ref=e128]:
            - complementary [ref=e129]: Aside
            - main [ref=e130]: Main
          - generic [ref=e131]: Footer
      - generic [ref=e132]:
        - heading "Space" [level=3] [ref=e133]
        - generic [ref=e134]:
          - button "保存草稿" [ref=e136] [cursor=pointer]:
            - generic [ref=e137]: 保存草稿
          - button "发布文章" [ref=e139] [cursor=pointer]:
            - generic [ref=e140]: 发布文章
          - button "移入归档" [ref=e142] [cursor=pointer]:
            - generic [ref=e143]: 移入归档
      - generic [ref=e144]:
        - heading "Scrollbar" [level=3] [ref=e145]
        - generic [ref=e148]:
          - generic [ref=e149]: "1"
          - generic [ref=e150]: "2"
          - generic [ref=e151]: "3"
          - generic [ref=e152]: "4"
          - generic [ref=e153]: "5"
          - generic [ref=e154]: "6"
          - generic [ref=e155]: "7"
          - generic [ref=e156]: "8"
          - generic [ref=e157]: "9"
          - generic [ref=e158]: "10"
      - generic [ref=e159]:
        - heading "ConfigProvider" [level=3] [ref=e160]
        - button "Provider Child" [ref=e161] [cursor=pointer]:
          - generic [ref=e162]: Provider Child
      - generic [ref=e163]:
        - heading "Affix" [level=3] [ref=e164]
        - button "Affix top 20px" [ref=e167] [cursor=pointer]:
          - generic [ref=e168]: Affix top 20px
      - heading "Watermark" [level=3] [ref=e170]
      - generic [ref=e173]:
        - heading "Divider" [level=3] [ref=e174]
        - text: Top
        - separator [ref=e175]:
          - generic [ref=e176]: Text
        - text: Bottom
      - generic [ref=e177]:
        - heading "VisuallyHidden" [level=3] [ref=e178]
        - generic [ref=e179]: Hidden Text
        - text: Text visible next to hidden one
    - generic [ref=e181]:
      - heading "Form" [level=2] [ref=e182]
      - generic [ref=e183]:
        - generic [ref=e184]:
          - heading "Publish an editorial update" [level=3] [ref=e185]
          - paragraph [ref=e186]: Complete the release details, review validation guidance, and attach the approved cover asset.
          - generic "Fixture language" [ref=e187]:
            - button "English" [pressed] [ref=e188] [cursor=pointer]
            - button "简体中文" [ref=e189] [cursor=pointer]
        - generic [ref=e190]:
          - generic [ref=e191]:
            - heading "Release details" [level=4] [ref=e192]
            - generic [ref=e193]:
              - generic [ref=e194]: Public title
              - generic [ref=e195]:
                - textbox "Public title" [ref=e198]:
                  - /placeholder: Summarize the update for readers
                - paragraph [ref=e199]: Use the same title shown in the release timeline.
            - generic [ref=e200]:
              - generic [ref=e201]: Audience
              - generic [ref=e202]:
                - generic [ref=e206] [cursor=pointer]:
                  - combobox "Audience" [ref=e207]
                  - img [ref=e210]
                - paragraph [ref=e212]: This setting also controls search indexing.
            - generic [ref=e213]:
              - generic [ref=e214]: Release summary for readers, reviewers, and support responders
              - generic [ref=e215]:
                - textbox "Release summary for readers, reviewers, and support responders" [ref=e217]:
                  - /placeholder: Explain what changed and what readers should do next
                - paragraph [ref=e218]: Add a concrete next step before requesting approval.
                - paragraph [ref=e219]: Explain the customer impact, the rollout boundary, and the exact recovery action a reader should take if the updated workflow is unavailable.
          - generic [ref=e220]:
            - heading "Schedule" [level=4] [ref=e221]
            - generic [ref=e222]:
              - generic [ref=e223]:
                - generic [ref=e224]: Review limit
                - generic [ref=e225]:
                  - generic [ref=e226]:
                    - button "el.inputNumber.decrease" [ref=e227] [cursor=pointer]:
                      - img [ref=e229]
                    - button "el.inputNumber.increase" [ref=e231] [cursor=pointer]:
                      - img [ref=e233]
                    - spinbutton "Review limit" [ref=e237]: "5"
                  - paragraph [ref=e238]: Days before review expires.
              - generic [ref=e239]:
                - generic [ref=e240]: Publish date
                - generic [ref=e241]:
                  - combobox [ref=e242]:
                    - generic [ref=e243]:
                      - img [ref=e246]
                      - textbox "Publish date" [ref=e248]:
                        - /placeholder: Choose a date
                        - text: 2026-10-08
                  - paragraph [ref=e249]: Displayed in Asia/Shanghai.
              - generic [ref=e250]:
                - generic [ref=e251]: Time zone
                - generic [ref=e252]:
                  - generic [ref=e256] [cursor=pointer]:
                    - combobox "Time zone" [ref=e257]: Asia/Shanghai (UTC+8)
                    - img [ref=e260]
                  - paragraph [ref=e262]: Used by scheduled publishing.
          - generic [ref=e263]:
            - heading "Review window" [level=4] [ref=e264]
            - button "Toggle start-date validation example" [ref=e265] [cursor=pointer]:
              - generic [ref=e266]: Toggle start-date validation example
            - generic [ref=e267]:
              - generic [ref=e268]:
                - generic [ref=e269]: Starts
                - generic [ref=e270]:
                  - combobox [ref=e271]:
                    - generic [ref=e272]:
                      - img [ref=e275]
                      - textbox "Starts" [ref=e277]:
                        - /placeholder: Start date
                        - text: 2026-10-08
                  - paragraph [ref=e278]: Reviewers receive access.
              - generic [ref=e279]:
                - generic [ref=e280]: Ends
                - generic [ref=e281]:
                  - combobox [ref=e282]:
                    - generic [ref=e283]:
                      - img [ref=e286]
                      - textbox "Ends" [ref=e288]:
                        - /placeholder: End date
                        - text: 2026-10-09
                  - paragraph [ref=e289]: Open feedback becomes read-only.
          - generic [ref=e290]:
            - heading "Approved cover asset" [level=4] [ref=e291]
            - group "Cover image" [ref=e292]:
              - generic [ref=e293]: Cover image
              - generic [ref=e295]:
                - generic [ref=e297] [cursor=pointer]:
                  - generic [ref=e298]: Drop the approved image here or choose a local file.
                  - paragraph [ref=e299]: PNG or JPEG, up to 2 MB. The editorial crop is 16:9.
                - paragraph [ref=e300]: The current draft still needs an approved cover image.
                - list
          - generic [ref=e301]:
            - heading "Read-only and processing states" [level=4] [ref=e302]
            - generic [ref=e303]:
              - generic [ref=e304]: Release owner
              - generic [ref=e305]:
                - textbox "Release owner" [disabled] [ref=e308]: Editorial operations
                - paragraph [ref=e309]: Ownership changes require administrator approval.
            - group "Approval controls" [ref=e310]:
              - generic [ref=e311]: Approval controls
              - generic [ref=e312]:
                - generic [ref=e313] [cursor=pointer]:
                  - generic [ref=e314]:
                    - checkbox "Require editor approval before publishing" [checked]
                  - generic [ref=e316]: Require editor approval before publishing
                - generic [ref=e317]:
                  - switch [checked]
                  - generic [ref=e319] [cursor=pointer]: Do not notify
                  - generic [ref=e323] [cursor=pointer]: Notify reviewers
                - radiogroup "radio-group" [ref=e324]:
                  - generic [ref=e325] [cursor=pointer]:
                    - radio "Approval required" [checked] [ref=e327]
                    - generic [ref=e329]: Approval required
                  - generic [ref=e330] [cursor=pointer]:
                    - radio "Advisory review" [ref=e332]
                    - generic [ref=e334]: Advisory review
            - button "Checking release policy" [disabled]:
              - generic:
                - generic:
                  - img
              - generic: Checking release policy
      - generic [ref=e335]:
        - generic [ref=e336]:
          - heading "Dark form state authority matrix" [level=3] [ref=e337]
          - paragraph [ref=e338]: Compare readable guidance, secondary state text, and structural borders without changing control geometry.
        - generic [ref=e339]:
          - generic [ref=e340]:
            - heading "Input" [level=4] [ref=e341]
            - generic [ref=e342]:
              - generic [ref=e343]:
                - generic [ref=e344]: Input · default
                - textbox [ref=e347]
                - paragraph [ref=e348]: Required release guidance remains readable.
              - generic [ref=e349]:
                - generic [ref=e350]: Input · hover
                - textbox [ref=e353]
                - paragraph [ref=e354]: Required release guidance remains readable.
              - generic [ref=e355]:
                - generic [ref=e356]: Input · focus
                - textbox [ref=e359]
                - paragraph [ref=e360]: Required release guidance remains readable.
              - generic [ref=e361]:
                - generic [ref=e362]: Input · filled
                - textbox [ref=e365]: Release brief ready
                - paragraph [ref=e366]: Required release guidance remains readable.
              - generic [ref=e367]:
                - generic [ref=e368]: Input · placeholder
                - textbox "Enter release brief" [ref=e371]
                - paragraph [ref=e372]: Required release guidance remains readable.
              - generic [ref=e373]:
                - generic [ref=e374]: Input · disabled
                - textbox [disabled] [ref=e377]: Release brief ready
                - paragraph [ref=e378]: Required release guidance remains readable.
              - generic [ref=e379]:
                - generic [ref=e380]: Input · invalid
                - textbox [ref=e383]
                - paragraph [ref=e384]: Resolve this value before publishing.
          - generic [ref=e385]:
            - heading "Textarea" [level=4] [ref=e386]
            - generic [ref=e387]:
              - generic [ref=e388]:
                - generic [ref=e389]: Textarea · default
                - textbox [ref=e391]
                - paragraph [ref=e392]: Required release guidance remains readable.
              - generic [ref=e393]:
                - generic [ref=e394]: Textarea · hover
                - textbox [ref=e396]
                - paragraph [ref=e397]: Required release guidance remains readable.
              - generic [ref=e398]:
                - generic [ref=e399]: Textarea · focus
                - textbox [ref=e401]
                - paragraph [ref=e402]: Required release guidance remains readable.
              - generic [ref=e403]:
                - generic [ref=e404]: Textarea · filled
                - textbox [ref=e406]: Explain the reader-facing change.
                - paragraph [ref=e407]: Required release guidance remains readable.
              - generic [ref=e408]:
                - generic [ref=e409]: Textarea · placeholder
                - textbox "Add release guidance" [ref=e411]
                - paragraph [ref=e412]: Required release guidance remains readable.
              - generic [ref=e413]:
                - generic [ref=e414]: Textarea · disabled
                - textbox [disabled] [ref=e416]: Explain the reader-facing change.
                - paragraph [ref=e417]: Required release guidance remains readable.
              - generic [ref=e418]:
                - generic [ref=e419]: Textarea · invalid
                - textbox [ref=e421]
                - paragraph [ref=e422]: Resolve this value before publishing.
          - generic [ref=e423]:
            - heading "Select" [level=4] [ref=e424]
            - generic [ref=e425]:
              - generic [ref=e426]:
                - generic [ref=e427]: Select · default
                - generic [ref=e431] [cursor=pointer]:
                  - combobox "请选择" [ref=e432]
                  - img [ref=e435]
                - paragraph [ref=e437]: Required release guidance remains readable.
              - generic [ref=e438]:
                - generic [ref=e439]: Select · hover
                - generic [ref=e443] [cursor=pointer]:
                  - combobox "请选择" [ref=e444]
                  - img [ref=e447]
                - paragraph [ref=e449]: Required release guidance remains readable.
              - generic [ref=e450]:
                - generic [ref=e451]: Select · focus
                - generic [ref=e455] [cursor=pointer]:
                  - combobox "请选择" [ref=e456]
                  - img [ref=e459]
                - paragraph [ref=e461]: Required release guidance remains readable.
              - generic [ref=e462]:
                - generic [ref=e463]: Select · filled
                - generic [ref=e467] [cursor=pointer]:
                  - combobox "请选择" [ref=e468]: Signed-in members
                  - img [ref=e471]
                - paragraph [ref=e473]: Required release guidance remains readable.
              - generic [ref=e474]:
                - generic [ref=e475]: Select · placeholder
                - generic [ref=e479] [cursor=pointer]:
                  - combobox "Choose an audience" [ref=e480]
                  - img [ref=e483]
                - paragraph [ref=e485]: Required release guidance remains readable.
              - generic [ref=e486]:
                - generic [ref=e487]: Select · disabled
                - generic [ref=e491]:
                  - combobox "请选择" [disabled] [ref=e492]: Signed-in members
                  - img [ref=e495]
                - paragraph [ref=e497]: Required release guidance remains readable.
              - generic [ref=e498]:
                - generic [ref=e499]: Select · invalid
                - generic [ref=e503] [cursor=pointer]:
                  - combobox "请选择" [ref=e504]
                  - img [ref=e507]
                - paragraph [ref=e509]: Resolve this value before publishing.
          - generic [ref=e510]:
            - heading "Select V2" [level=4] [ref=e511]
            - generic [ref=e512]:
              - generic [ref=e513]:
                - generic [ref=e514]: Select V2 · default
                - generic [ref=e516] [cursor=pointer]:
                  - combobox [ref=e518]
                  - img [ref=e521]
                - paragraph [ref=e523]: Required release guidance remains readable.
              - generic [ref=e524]:
                - generic [ref=e525]: Select V2 · hover
                - generic [ref=e527] [cursor=pointer]:
                  - combobox [ref=e529]
                  - img [ref=e532]
                - paragraph [ref=e534]: Required release guidance remains readable.
              - generic [ref=e535]:
                - generic [ref=e536]: Select V2 · focus
                - generic [ref=e538] [cursor=pointer]:
                  - combobox [ref=e540]
                  - img [ref=e543]
                - paragraph [ref=e545]: Required release guidance remains readable.
              - generic [ref=e546]:
                - generic [ref=e547]: Select V2 · filled
                - generic [ref=e549] [cursor=pointer]:
                  - combobox [ref=e551]
                  - generic [ref=e552]: Editorial approval
                  - img [ref=e555]
                - paragraph [ref=e557]: Required release guidance remains readable.
              - generic [ref=e558]:
                - generic [ref=e559]: Select V2 · placeholder
                - generic [ref=e561] [cursor=pointer]:
                  - combobox [ref=e563]
                  - img [ref=e566]
                - paragraph [ref=e568]: Required release guidance remains readable.
              - generic [ref=e569]:
                - generic [ref=e570]: Select V2 · disabled
                - generic [ref=e572]:
                  - combobox [disabled] [ref=e574]
                  - generic [ref=e575]: Editorial approval
                  - img [ref=e578]
                - paragraph [ref=e580]: Required release guidance remains readable.
              - generic [ref=e581]:
                - generic [ref=e582]: Select V2 · invalid
                - generic [ref=e584] [cursor=pointer]:
                  - combobox [ref=e586]
                  - img [ref=e589]
                - paragraph [ref=e591]: Resolve this value before publishing.
          - generic [ref=e592]:
            - heading "Date Picker" [level=4] [ref=e593]
            - generic [ref=e594]:
              - generic [ref=e595]:
                - generic [ref=e596]: Date Picker · default
                - combobox [ref=e597]:
                  - generic [ref=e598]:
                    - img [ref=e601]
                    - textbox [ref=e603]
                - paragraph [ref=e604]: Required release guidance remains readable.
              - generic [ref=e605]:
                - generic [ref=e606]: Date Picker · hover
                - combobox [ref=e607]:
                  - generic [ref=e608]:
                    - img [ref=e611]
                    - textbox [ref=e613]
                - paragraph [ref=e614]: Required release guidance remains readable.
              - generic [ref=e615]:
                - generic [ref=e616]: Date Picker · focus
                - combobox [ref=e617]:
                  - generic [ref=e618]:
                    - img [ref=e621]
                    - textbox [ref=e623]
                - paragraph [ref=e624]: Required release guidance remains readable.
              - generic [ref=e625]:
                - generic [ref=e626]: Date Picker · filled
                - combobox [ref=e627]:
                  - generic [ref=e628]:
                    - img [ref=e631]
                    - textbox [ref=e633]: 2026-07-24
                - paragraph [ref=e634]: Required release guidance remains readable.
              - generic [ref=e635]:
                - generic [ref=e636]: Date Picker · placeholder
                - combobox [ref=e637]:
                  - generic [ref=e638]:
                    - img [ref=e641]
                    - textbox "Choose a date" [ref=e643]
                - paragraph [ref=e644]: Required release guidance remains readable.
              - generic [ref=e645]:
                - generic [ref=e646]: Date Picker · disabled
                - combobox [ref=e647]:
                  - generic [ref=e648]:
                    - img [ref=e651]
                    - textbox [disabled] [ref=e653]: 2026-07-24
                - paragraph [ref=e654]: Required release guidance remains readable.
              - generic [ref=e655]:
                - generic [ref=e656]: Date Picker · invalid
                - combobox [ref=e657]:
                  - generic [ref=e658]:
                    - img [ref=e661]
                    - textbox [ref=e663]
                - paragraph [ref=e664]: Resolve this value before publishing.
          - generic [ref=e665]:
            - heading "Time Picker" [level=4] [ref=e666]
            - generic [ref=e667]:
              - generic [ref=e668]:
                - generic [ref=e669]: Time Picker · default
                - combobox [ref=e670]:
                  - generic [ref=e671]:
                    - img [ref=e674]
                    - textbox [ref=e678]
                - paragraph [ref=e679]: Required release guidance remains readable.
              - generic [ref=e680]:
                - generic [ref=e681]: Time Picker · hover
                - combobox [ref=e682]:
                  - generic [ref=e683]:
                    - img [ref=e686]
                    - textbox [ref=e690]
                - paragraph [ref=e691]: Required release guidance remains readable.
              - generic [ref=e692]:
                - generic [ref=e693]: Time Picker · focus
                - combobox [ref=e694]:
                  - generic [ref=e695]:
                    - img [ref=e698]
                    - textbox [ref=e702]
                - paragraph [ref=e703]: Required release guidance remains readable.
              - generic [ref=e704]:
                - generic [ref=e705]: Time Picker · filled
                - combobox [ref=e706]:
                  - generic [ref=e707]:
                    - img [ref=e710]
                    - textbox [ref=e714]: 09:00:00
                - paragraph [ref=e715]: Required release guidance remains readable.
              - generic [ref=e716]:
                - generic [ref=e717]: Time Picker · placeholder
                - combobox [ref=e718]:
                  - generic [ref=e719]:
                    - img [ref=e722]
                    - textbox "Choose a time" [ref=e726]
                - paragraph [ref=e727]: Required release guidance remains readable.
              - generic [ref=e728]:
                - generic [ref=e729]: Time Picker · disabled
                - combobox [ref=e730]:
                  - generic [ref=e731]:
                    - img [ref=e734]
                    - textbox [disabled] [ref=e738]: 09:00:00
                - paragraph [ref=e739]: Required release guidance remains readable.
              - generic [ref=e740]:
                - generic [ref=e741]: Time Picker · invalid
                - combobox [ref=e742]:
                  - generic [ref=e743]:
                    - img [ref=e746]
                    - textbox [ref=e750]
                - paragraph [ref=e751]: Resolve this value before publishing.
          - generic [ref=e752]:
            - heading "Time Select" [level=4] [ref=e753]
            - generic [ref=e754]:
              - generic [ref=e755]:
                - generic [ref=e756]: Time Select · default
                - generic [ref=e760] [cursor=pointer]:
                  - img [ref=e763]
                  - combobox "请选择" [ref=e767]
                  - img [ref=e770]
                - paragraph [ref=e772]: Required release guidance remains readable.
              - generic [ref=e773]:
                - generic [ref=e774]: Time Select · hover
                - generic [ref=e778] [cursor=pointer]:
                  - img [ref=e781]
                  - combobox "请选择" [ref=e785]
                  - img [ref=e788]
                - paragraph [ref=e790]: Required release guidance remains readable.
              - generic [ref=e791]:
                - generic [ref=e792]: Time Select · focus
                - generic [ref=e796] [cursor=pointer]:
                  - img [ref=e799]
                  - combobox "请选择" [ref=e803]
                  - img [ref=e806]
                - paragraph [ref=e808]: Required release guidance remains readable.
              - generic [ref=e809]:
                - generic [ref=e810]: Time Select · filled
                - generic [ref=e814] [cursor=pointer]:
                  - img [ref=e817]
                  - combobox "请选择" [ref=e821]: 09:00
                  - img [ref=e824]
                - paragraph [ref=e826]: Required release guidance remains readable.
              - generic [ref=e827]:
                - generic [ref=e828]: Time Select · placeholder
                - generic [ref=e832] [cursor=pointer]:
                  - img [ref=e835]
                  - combobox "Choose a release slot" [ref=e839]
                  - img [ref=e842]
                - paragraph [ref=e844]: Required release guidance remains readable.
              - generic [ref=e845]:
                - generic [ref=e846]: Time Select · disabled
                - generic [ref=e850]:
                  - img [ref=e853]
                  - combobox "请选择" [disabled] [ref=e857]: 09:00
                  - img [ref=e860]
                - paragraph [ref=e862]: Required release guidance remains readable.
              - generic [ref=e863]:
                - generic [ref=e864]: Time Select · invalid
                - generic [ref=e868] [cursor=pointer]:
                  - img [ref=e871]
                  - combobox "请选择" [ref=e875]
                  - img [ref=e878]
                - paragraph [ref=e880]: Resolve this value before publishing.
          - generic [ref=e881]:
            - heading "Input Number" [level=4] [ref=e882]
            - generic [ref=e883]:
              - generic [ref=e884]:
                - generic [ref=e885]: Input Number · default
                - generic [ref=e886]:
                  - button "el.inputNumber.decrease" [ref=e887] [cursor=pointer]:
                    - img [ref=e889]
                  - button "el.inputNumber.increase" [ref=e891] [cursor=pointer]:
                    - img [ref=e893]
                  - spinbutton [ref=e897]
                - paragraph [ref=e898]: Required release guidance remains readable.
              - generic [ref=e899]:
                - generic [ref=e900]: Input Number · hover
                - generic [ref=e901]:
                  - button "el.inputNumber.decrease" [ref=e902] [cursor=pointer]:
                    - img [ref=e904]
                  - button "el.inputNumber.increase" [ref=e906] [cursor=pointer]:
                    - img [ref=e908]
                  - spinbutton [ref=e912]
                - paragraph [ref=e913]: Required release guidance remains readable.
              - generic [ref=e914]:
                - generic [ref=e915]: Input Number · focus
                - generic [ref=e916]:
                  - button "el.inputNumber.decrease" [ref=e917] [cursor=pointer]:
                    - img [ref=e919]
                  - button "el.inputNumber.increase" [ref=e921] [cursor=pointer]:
                    - img [ref=e923]
                  - spinbutton [ref=e927]
                - paragraph [ref=e928]: Required release guidance remains readable.
              - generic [ref=e929]:
                - generic [ref=e930]: Input Number · filled
                - generic [ref=e931]:
                  - button "el.inputNumber.decrease" [ref=e932] [cursor=pointer]:
                    - img [ref=e934]
                  - button "el.inputNumber.increase" [ref=e936] [cursor=pointer]:
                    - img [ref=e938]
                  - spinbutton [ref=e942]: "7"
                - paragraph [ref=e943]: Required release guidance remains readable.
              - generic [ref=e944]:
                - generic [ref=e945]: Input Number · placeholder
                - generic [ref=e946]:
                  - button "el.inputNumber.decrease" [ref=e947] [cursor=pointer]:
                    - img [ref=e949]
                  - button "el.inputNumber.increase" [ref=e951] [cursor=pointer]:
                    - img [ref=e953]
                  - spinbutton [ref=e957]
                - paragraph [ref=e958]: Required release guidance remains readable.
              - generic [ref=e959]:
                - generic [ref=e960]: Input Number · disabled
                - generic [ref=e961]:
                  - button "el.inputNumber.decrease" [ref=e962] [cursor=pointer]:
                    - img [ref=e964]
                  - button "el.inputNumber.increase" [ref=e966] [cursor=pointer]:
                    - img [ref=e968]
                  - spinbutton [disabled] [ref=e972]: "7"
                - paragraph [ref=e973]: Required release guidance remains readable.
              - generic [ref=e974]:
                - generic [ref=e975]: Input Number · invalid
                - generic [ref=e976]:
                  - button "el.inputNumber.decrease" [ref=e977] [cursor=pointer]:
                    - img [ref=e979]
                  - button "el.inputNumber.increase" [ref=e981] [cursor=pointer]:
                    - img [ref=e983]
                  - spinbutton [ref=e987]
                - paragraph [ref=e988]: Resolve this value before publishing.
          - generic [ref=e989]:
            - heading "Cascader" [level=4] [ref=e990]
            - generic [ref=e991]:
              - generic [ref=e992]:
                - generic [ref=e993]: Cascader · default
                - generic [ref=e996]:
                  - textbox "请选择" [ref=e997] [cursor=pointer]
                  - img [ref=e1000]
                - paragraph [ref=e1002]: Required release guidance remains readable.
              - generic [ref=e1003]:
                - generic [ref=e1004]: Cascader · hover
                - generic [ref=e1007]:
                  - textbox "请选择" [ref=e1008] [cursor=pointer]
                  - img [ref=e1011]
                - paragraph [ref=e1013]: Required release guidance remains readable.
              - generic [ref=e1014]:
                - generic [ref=e1015]: Cascader · focus
                - generic [ref=e1018]:
                  - textbox "请选择" [ref=e1019] [cursor=pointer]
                  - img [ref=e1022]
                - paragraph [ref=e1024]: Required release guidance remains readable.
              - generic [ref=e1025]:
                - generic [ref=e1026]: Cascader · filled
                - generic [ref=e1029]:
                  - textbox [ref=e1030] [cursor=pointer]: Editorial / Release
                  - img [ref=e1033]
                - paragraph [ref=e1035]: Required release guidance remains readable.
              - generic [ref=e1036]:
                - generic [ref=e1037]: Cascader · placeholder
                - generic [ref=e1040]:
                  - textbox "Choose a release category" [ref=e1041] [cursor=pointer]
                  - img [ref=e1044]
                - paragraph [ref=e1046]: Required release guidance remains readable.
              - generic [ref=e1047]:
                - generic [ref=e1048]: Cascader · disabled
                - generic [ref=e1051]:
                  - textbox [disabled] [ref=e1052]: Editorial / Release
                  - img [ref=e1055]
                - paragraph [ref=e1057]: Required release guidance remains readable.
              - generic [ref=e1058]:
                - generic [ref=e1059]: Cascader · invalid
                - generic [ref=e1062]:
                  - textbox "请选择" [ref=e1063] [cursor=pointer]
                  - img [ref=e1066]
                - paragraph [ref=e1068]: Resolve this value before publishing.
          - generic [ref=e1069]:
            - heading "Upload" [level=4] [ref=e1070]
            - generic [ref=e1071]:
              - generic [ref=e1072]:
                - generic [ref=e1073]: Upload · default
                - generic [ref=e1074]:
                  - paragraph [ref=e1077] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e1078]: Required release guidance remains readable.
              - generic [ref=e1079]:
                - generic [ref=e1080]: Upload · hover
                - generic [ref=e1081]:
                  - paragraph [ref=e1084] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e1085]: Required release guidance remains readable.
              - generic [ref=e1086]:
                - generic [ref=e1087]: Upload · focus
                - generic [ref=e1088]:
                  - paragraph [ref=e1091] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e1092]: Required release guidance remains readable.
              - generic [ref=e1093]:
                - generic [ref=e1094]: Upload · filled
                - generic [ref=e1095]:
                  - paragraph [ref=e1098] [cursor=pointer]: approved-cover.png
                  - list
                - paragraph [ref=e1099]: Required release guidance remains readable.
              - generic [ref=e1100]:
                - generic [ref=e1101]: Upload · placeholder
                - generic [ref=e1102]:
                  - paragraph [ref=e1105] [cursor=pointer]: Choose an approved cover
                  - list
                - paragraph [ref=e1106]: Required release guidance remains readable.
              - generic [ref=e1107]:
                - generic [ref=e1108]: Upload · disabled
                - generic [ref=e1109]:
                  - paragraph [ref=e1112] [cursor=pointer]: approved-cover.png
                  - list
                - paragraph [ref=e1113]: Required release guidance remains readable.
              - generic [ref=e1114]:
                - generic [ref=e1115]: Upload · invalid
                - generic [ref=e1116]:
                  - paragraph [ref=e1119] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e1120]: Resolve this value before publishing.
      - generic [ref=e1121]:
        - heading "Radio & RadioButton" [level=3] [ref=e1122]
        - generic [ref=e1123]:
          - radiogroup "radio-group" [ref=e1125]:
            - generic [ref=e1126] [cursor=pointer]:
              - radio "公开" [checked] [ref=e1128]
              - generic [ref=e1130]: 公开
            - generic [ref=e1131] [cursor=pointer]:
              - radio "仅自己可见" [ref=e1133]
              - generic [ref=e1135]: 仅自己可见
          - radiogroup "radio-group" [ref=e1137]:
            - generic [ref=e1138]:
              - radio "公开" [checked] [ref=e1139]
              - generic [ref=e1140] [cursor=pointer]: 公开
            - generic [ref=e1141]:
              - radio "仅自己可见" [ref=e1142]
              - generic [ref=e1143] [cursor=pointer]: 仅自己可见
      - generic [ref=e1144]:
        - heading "Checkbox & CheckboxButton" [level=3] [ref=e1145]
        - generic [ref=e1146]:
          - generic [ref=e1148] [cursor=pointer]:
            - generic [ref=e1149]:
              - checkbox "Checkbox" [checked]
            - generic [ref=e1151]: Checkbox
          - group "checkbox-group" [ref=e1153]:
            - generic [ref=e1154] [cursor=pointer]:
              - generic [ref=e1155]:
                - checkbox "推送到首页" [checked]
              - generic [ref=e1157]: 推送到首页
            - generic [ref=e1158] [cursor=pointer]:
              - generic [ref=e1159]:
                - checkbox "保持普通"
              - generic [ref=e1161]: 保持普通
          - group "checkbox-group" [ref=e1163]:
            - generic [ref=e1164]:
              - checkbox "推送到首页" [checked] [ref=e1165]
              - generic [ref=e1166] [cursor=pointer]: 推送到首页
            - generic [ref=e1167]:
              - checkbox "保持普通" [ref=e1168]
              - generic [ref=e1169] [cursor=pointer]: 保持普通
      - generic [ref=e1170]:
        - heading "Input" [level=3] [ref=e1171]
        - generic [ref=e1172]:
          - textbox "输入文章标题" [ref=e1176]
          - textbox "写下摘要或更新说明" [ref=e1179]
      - generic [ref=e1180]:
        - heading "InputNumber" [level=3] [ref=e1181]
        - generic [ref=e1182]:
          - generic [ref=e1184]:
            - button "el.inputNumber.decrease" [ref=e1185]:
              - img [ref=e1187]
            - button "el.inputNumber.increase" [ref=e1189] [cursor=pointer]:
              - img [ref=e1191]
            - spinbutton [ref=e1195]: "1"
          - generic [ref=e1197]:
            - button "el.inputNumber.decrease" [ref=e1198]:
              - img [ref=e1200]
            - button "el.inputNumber.increase" [ref=e1202] [cursor=pointer]:
              - img [ref=e1204]
            - spinbutton [ref=e1208]: "1"
          - generic [ref=e1210]:
            - button "el.inputNumber.decrease" [ref=e1211]:
              - img [ref=e1213]
            - button "el.inputNumber.increase" [ref=e1215] [cursor=pointer]:
              - img [ref=e1217]
            - spinbutton [ref=e1221]: "1"
          - generic [ref=e1223]:
            - button "el.inputNumber.decrease" [ref=e1224]:
              - img [ref=e1226]
            - button "el.inputNumber.increase" [ref=e1228] [cursor=pointer]:
              - img [ref=e1230]
            - spinbutton [ref=e1234]: "1"
          - generic [ref=e1236]:
            - button "el.inputNumber.decrease" [ref=e1237]:
              - img [ref=e1239]
            - button "el.inputNumber.increase" [ref=e1241] [cursor=pointer]:
              - img [ref=e1243]
            - spinbutton [ref=e1247]: "1"
          - generic [ref=e1249]:
            - button "el.inputNumber.decrease" [ref=e1250]:
              - img [ref=e1252]
            - button "el.inputNumber.increase" [ref=e1254] [cursor=pointer]:
              - img [ref=e1256]
            - spinbutton [ref=e1260]: "1"
          - generic [ref=e1262]:
            - button "el.inputNumber.decrease" [ref=e1263]:
              - img [ref=e1265]
            - button "el.inputNumber.increase" [ref=e1267] [cursor=pointer]:
              - img [ref=e1269]
            - spinbutton [disabled] [ref=e1273]: "1"
      - generic [ref=e1274]:
        - heading "Select & Option & OptionGroup" [level=3] [ref=e1275]
        - generic [ref=e1279] [cursor=pointer]:
          - combobox "选择可见范围" [ref=e1280]
          - img [ref=e1283]
      - generic [ref=e1285]:
        - heading "SelectV2" [level=3] [ref=e1286]
        - generic [ref=e1288] [cursor=pointer]:
          - combobox [ref=e1290]
          - img [ref=e1293]
      - generic [ref=e1295]:
        - heading "Cascader & CascaderPanel" [level=3] [ref=e1296]
        - generic [ref=e1297]:
          - generic [ref=e1301]:
            - textbox "选择分类" [ref=e1302] [cursor=pointer]
            - img [ref=e1305]
          - menu [ref=e1311]:
            - menuitem "Guide" [ref=e1312] [cursor=pointer]:
              - generic [ref=e1313]: Guide
              - img [ref=e1315]
      - generic [ref=e1317]:
        - heading "Switch" [level=3] [ref=e1318]
        - generic [ref=e1319]:
          - switch [checked]
          - generic [ref=e1321] [cursor=pointer]: Close
          - generic [ref=e1325] [cursor=pointer]: Open
      - generic [ref=e1326]:
        - heading "Slider" [level=3] [ref=e1327]
        - slider "el.slider.defaultLabel" [ref=e1331] [cursor=pointer]
      - generic [ref=e1333]:
        - heading "TimePicker / TimeSelect" [level=3] [ref=e1334]
        - generic [ref=e1335]:
          - combobox [ref=e1337]:
            - generic [ref=e1338]:
              - img [ref=e1341]
              - textbox "选择发布时间" [ref=e1345]
          - generic [ref=e1350] [cursor=pointer]:
            - img [ref=e1353]
            - combobox "选择推送时段" [ref=e1357]
            - img [ref=e1360]
      - generic [ref=e1362]:
        - heading "DatePicker" [level=3] [ref=e1363]
        - generic [ref=e1364]:
          - combobox [ref=e1366]:
            - generic [ref=e1367]:
              - img [ref=e1370]
              - textbox "选择日期" [ref=e1372]: 2026-10-08
          - generic [ref=e1374]:
            - img [ref=e1376]
            - textbox "开始日期" [ref=e1378]: 2026-10-08
            - generic [ref=e1379]: 至
            - textbox "结束日期" [ref=e1380]: 2026-10-08
      - generic [ref=e1381]:
        - heading "Upload" [level=3] [ref=e1382]
        - generic [ref=e1383]:
          - button "上传封面" [ref=e1385] [cursor=pointer]:
            - generic [ref=e1386]: 上传封面
          - generic [ref=e1387]: 支持 jpg/png，单个文件 ≤ 500KB
          - list
      - generic [ref=e1388]:
        - heading "Rate" [level=3] [ref=e1389]
        - slider "rating" [ref=e1390]:
          - img [ref=e1393] [cursor=pointer]
          - img [ref=e1397] [cursor=pointer]
          - img [ref=e1401] [cursor=pointer]
          - generic [ref=e1404] [cursor=pointer]:
            - img [ref=e1405]
            - img [ref=e1408]
          - img [ref=e1412] [cursor=pointer]
      - generic [ref=e1414]:
        - heading "ColorPicker" [level=3] [ref=e1415]
        - button "el.colorpicker.defaultLabel" [ref=e1416]
      - generic [ref=e1420]:
        - heading "Transfer" [level=3] [ref=e1421]
        - generic [ref=e1423]:
          - generic [ref=e1424]:
            - paragraph [ref=e1425]:
              - generic [ref=e1426] [cursor=pointer]:
                - generic [ref=e1427]:
                  - checkbox "列表 1 0/15"
                - generic [ref=e1429]:
                  - text: 列表 1
                  - generic [ref=e1430]: 0/15
            - group "checkbox-group" [ref=e1432]:
              - generic [ref=e1433]:
                - generic [ref=e1434] [cursor=pointer]:
                  - checkbox "同步成员权限" [disabled]
                - generic "同步成员权限" [ref=e1437]
              - generic [ref=e1438] [cursor=pointer]:
                - generic [ref=e1439]:
                  - checkbox "发布前校对"
                - generic "发布前校对" [ref=e1442]
              - generic [ref=e1443] [cursor=pointer]:
                - generic [ref=e1444]:
                  - checkbox "更新封面图"
                - generic "更新封面图" [ref=e1447]
              - generic [ref=e1448] [cursor=pointer]:
                - generic [ref=e1449]:
                  - checkbox "复核评论设置"
                - generic "复核评论设置" [ref=e1452]
              - generic [ref=e1453]:
                - generic [ref=e1454] [cursor=pointer]:
                  - checkbox "写入审计记录" [disabled]
                - generic "写入审计记录" [ref=e1457]
              - generic [ref=e1458] [cursor=pointer]:
                - generic [ref=e1459]:
                  - checkbox "刷新搜索索引"
                - generic "刷新搜索索引" [ref=e1462]
              - generic [ref=e1463] [cursor=pointer]:
                - generic [ref=e1464]:
                  - checkbox "生成分享摘要"
                - generic "生成分享摘要" [ref=e1467]
              - generic [ref=e1468] [cursor=pointer]:
                - generic [ref=e1469]:
                  - checkbox "同步首页推荐"
                - generic "同步首页推荐" [ref=e1472]
              - generic [ref=e1473]:
                - generic [ref=e1474] [cursor=pointer]:
                  - checkbox "校验附件大小" [disabled]
                - generic "校验附件大小" [ref=e1477]
              - generic [ref=e1478] [cursor=pointer]:
                - generic [ref=e1479]:
                  - checkbox "通知协作者"
                - generic "通知协作者" [ref=e1482]
              - generic [ref=e1483] [cursor=pointer]:
                - generic [ref=e1484]:
                  - checkbox "归档过期草稿"
                - generic "归档过期草稿" [ref=e1487]
              - generic [ref=e1488] [cursor=pointer]:
                - generic [ref=e1489]:
                  - checkbox "检查外链状态"
                - generic "检查外链状态" [ref=e1492]
              - generic [ref=e1493]:
                - generic [ref=e1494] [cursor=pointer]:
                  - checkbox "更新标签分组" [disabled]
                - generic "更新标签分组" [ref=e1497]
              - generic [ref=e1498] [cursor=pointer]:
                - generic [ref=e1499]:
                  - checkbox "预热公开缓存"
                - generic "预热公开缓存" [ref=e1502]
              - generic [ref=e1503] [cursor=pointer]:
                - generic [ref=e1504]:
                  - checkbox "记录发布说明"
                - generic "记录发布说明" [ref=e1507]
          - generic [ref=e1508]:
            - button "列表 2 → 列表 1" [disabled] [ref=e1509]:
              - img [ref=e1512]
            - button "列表 1 → 列表 2" [disabled] [ref=e1514]:
              - img [ref=e1517]
          - generic [ref=e1519]:
            - paragraph [ref=e1520]:
              - generic [ref=e1521] [cursor=pointer]:
                - generic [ref=e1522]:
                  - checkbox "列表 2 0/0"
                - generic [ref=e1524]:
                  - text: 列表 2
                  - generic [ref=e1525]: 0/0
            - paragraph [ref=e1527]: 无数据
      - generic [ref=e1528]:
        - heading "Form & FormItem" [level=3] [ref=e1529]
        - generic [ref=e1530]:
          - generic [ref=e1531]:
            - generic [ref=e1532]: 文章标题
            - textbox "文章标题" [ref=e1536]
          - generic [ref=e1537]:
            - generic [ref=e1538]: 可见范围
            - generic [ref=e1544] [cursor=pointer]:
              - combobox "可见范围" [ref=e1545]
              - img [ref=e1548]
      - generic [ref=e1550]:
        - heading "Autocomplete" [level=3] [ref=e1551]
        - combobox [ref=e1552]:
          - textbox [ref=e1555]
      - generic [ref=e1556]:
        - heading "TreeSelect" [level=3] [ref=e1557]
        - generic [ref=e1562] [cursor=pointer]:
          - combobox "请选择" [ref=e1563]: Level one 1
          - img [ref=e1566]
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test'
  2   | import type { Page } from '@playwright/test'
  3   | import { attachPageDiagnostics } from '../support/page-diagnostics'
  4   | import { collectCssRules } from '../support/css-scan'
  5   | import { buildVisualUrl } from '../../../scripts/visual-variant.mjs'
  6   | 
  7   | const diagnostics = new WeakMap<Page, string[]>()
  8   | 
  9   | const stabilizePage = async (page: Page) => {
  10  |   await page.addStyleTag({
  11  |     content: `*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;animation-delay:0s!important;scroll-behavior:auto!important}`,
  12  |   })
  13  | }
  14  | 
  15  | test.beforeEach(async ({ page }) => {
  16  |   diagnostics.set(page, attachPageDiagnostics(page))
  17  |   await page.emulateMedia({ reducedMotion: 'reduce' })
  18  | })
  19  | 
  20  | test.afterEach(async ({ page }) => {
> 21  |   expect(diagnostics.get(page) ?? []).toEqual([])
      |                                       ^ Error: expect(received).toEqual(expected) // deep equality
  22  | })
  23  | 
  24  | // Check compiled CSS for all zoom-in-* transitions
  25  | test('zoom-in transitions use opacity+translate, no axis scale', async ({ page }, testInfo) => {
  26  |   await page.goto(buildVisualUrl('', testInfo.project.name), { waitUntil: 'domcontentloaded' })
  27  |   await stabilizePage(page)
  28  | 
  29  |   // Selector-scoped gate: evaluate each rule against its own selector and
  30  |   // declarations, not joined whole-sheet text (cross-rule joins false-positive
  31  |   // on unrelated rules in the same stylesheet).
  32  |   const rules = await collectCssRules(page)
  33  |   const violations: string[] = []
  34  |   for (const rule of rules) {
  35  |     const selector = rule.selectorText
  36  |     const css = rule.cssText
  37  |     if ((selector.includes('zoom-in') || selector.includes('el-zoom-in')) && /scale[XY]\(0\)/.test(css))
  38  |       violations.push('axis scale-to-zero found')
  39  |     if ((selector.includes('zoom-in') || selector.includes('el-zoom-in')) && /scale\(0\.45\)/.test(css))
  40  |       violations.push('scale(0.45) found')
  41  |     if (selector.includes('list-enter-from') && /translateY\(-30px\)/.test(css))
  42  |       violations.push('30px list displacement found')
  43  |     if (selector.includes('zoom-in-center') && /scaleX/.test(css))
  44  |       violations.push('fade-linear axis compression found')
  45  |   }
  46  |   expect(violations).toEqual([])
  47  | })
  48  | 
  49  | // List displacement <= 8px
  50  | test('list transitions use <=8px displacement', async ({ page }, testInfo) => {
  51  |   await page.goto(buildVisualUrl('', testInfo.project.name), { waitUntil: 'domcontentloaded' })
  52  |   await stabilizePage(page)
  53  | 
  54  |   const rules = await collectCssRules(page)
  55  |   const displacements: string[] = []
  56  |   for (const rule of rules) {
  57  |     if (
  58  |       rule.selectorText.includes('list-enter-from') ||
  59  |       rule.selectorText.includes('list-leave-to')
  60  |     ) {
  61  |       const m = rule.cssText.match(/translateY\((-?\d+)px\)/g)
  62  |       if (m) displacements.push(...m)
  63  |     }
  64  |   }
  65  |   for (const d of displacements) {
  66  |     const px = parseInt(d.match(/(-?\d+)/)?.[1] ?? '0')
  67  |     expect(Math.abs(px)).toBeLessThanOrEqual(8)
  68  |   }
  69  | })
  70  | 
  71  | // Overlay transitions have scale >= 0.98
  72  | test('zoom-in overlay transitions have scale >= 0.98', async ({ page }, testInfo) => {
  73  |   await page.goto(buildVisualUrl('', testInfo.project.name), { waitUntil: 'domcontentloaded' })
  74  |   await stabilizePage(page)
  75  | 
  76  |   const rules = await collectCssRules(page)
  77  |   const scales: string[] = []
  78  |   for (const rule of rules) {
  79  |     if (
  80  |       rule.selectorText.includes('zoom-in-bottom-enter-from') ||
  81  |       rule.selectorText.includes('zoom-in-left-enter-from')
  82  |     ) {
  83  |       const m = rule.cssText.match(/scale\(([0-9.]+)\)/g)
  84  |       if (m) scales.push(...m)
  85  |     }
  86  |   }
  87  |   for (const sc of scales) {
  88  |     const val = parseFloat(sc.match(/\(([0-9.]+)\)/)?.[1] ?? '0')
  89  |     expect(val).toBeGreaterThanOrEqual(0.98)
  90  |   }
  91  | })
  92  | 
  93  | // No legacy 500ms motion
  94  | test('no transition uses 500ms', async ({ page }, testInfo) => {
  95  |   await page.goto(buildVisualUrl('', testInfo.project.name), { waitUntil: 'domcontentloaded' })
  96  |   await stabilizePage(page)
  97  | 
  98  |   const rules = await collectCssRules(page)
  99  |   const has500ms = rules.some((rule) =>
  100 |     /transition-duration:\s*500ms/.test(rule.cssText),
  101 |   )
  102 |   expect(has500ms).toBe(false)
  103 | })
  104 | 
  105 | // Legacy alias registry: scss compiles
  106 | test('motion scss compiles without error', async () => {
  107 |   const { resolve } = await import('node:path')
  108 |   const { compile } = await import('sass')
  109 |   const result = compile(resolve(process.cwd(), 'vue/packages/theme-chalk/src/fsus.scss'), {
  110 |     loadPaths: [resolve(process.cwd(), 'vue/packages/theme-chalk/src')],
  111 |   })
  112 |   expect(result.css).toBeTruthy()
  113 |   expect(result.css).toContain('transition')
  114 | })
  115 | 
```