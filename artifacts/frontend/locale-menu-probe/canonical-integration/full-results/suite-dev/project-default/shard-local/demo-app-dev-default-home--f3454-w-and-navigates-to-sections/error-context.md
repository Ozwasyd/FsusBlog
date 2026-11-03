# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: demo-app-dev.spec.ts >> default home mounts only the virtual window and navigates to sections
- Location: vue/tests/demo-app-dev/demo-app-dev.spec.ts:251:5

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
      - button "Data" [active] [ref=e10] [cursor=pointer]
      - button "Navigation" [ref=e11] [cursor=pointer]
      - button "Feedback" [ref=e12] [cursor=pointer]
      - button "Others" [ref=e13] [cursor=pointer]
      - button "Icons" [ref=e14] [cursor=pointer]
      - 'button "Issue #1" [ref=e15] [cursor=pointer]'
      - button "Markdown Stress" [ref=e16] [cursor=pointer]
  - generic [ref=e17]:
    - generic [ref=e19]:
      - heading "Form" [level=2] [ref=e20]
      - generic [ref=e21]:
        - generic [ref=e22]:
          - heading "Publish an editorial update" [level=3] [ref=e23]
          - paragraph [ref=e24]: Complete the release details, review validation guidance, and attach the approved cover asset.
          - generic "Fixture language" [ref=e25]:
            - button "English" [pressed] [ref=e26] [cursor=pointer]
            - button "简体中文" [ref=e27] [cursor=pointer]
        - generic [ref=e28]:
          - generic [ref=e29]:
            - heading "Release details" [level=4] [ref=e30]
            - generic [ref=e31]:
              - generic [ref=e32]: Public title
              - generic [ref=e33]:
                - textbox "Public title" [ref=e36]:
                  - /placeholder: Summarize the update for readers
                - paragraph [ref=e37]: Use the same title shown in the release timeline.
            - generic [ref=e38]:
              - generic [ref=e39]: Audience
              - generic [ref=e40]:
                - generic [ref=e44] [cursor=pointer]:
                  - combobox "Audience" [ref=e45]
                  - img [ref=e48]
                - paragraph [ref=e50]: This setting also controls search indexing.
            - generic [ref=e51]:
              - generic [ref=e52]: Release summary for readers, reviewers, and support responders
              - generic [ref=e53]:
                - textbox "Release summary for readers, reviewers, and support responders" [ref=e55]:
                  - /placeholder: Explain what changed and what readers should do next
                - paragraph [ref=e56]: Add a concrete next step before requesting approval.
                - paragraph [ref=e57]: Explain the customer impact, the rollout boundary, and the exact recovery action a reader should take if the updated workflow is unavailable.
          - generic [ref=e58]:
            - heading "Schedule" [level=4] [ref=e59]
            - generic [ref=e60]:
              - generic [ref=e61]:
                - generic [ref=e62]: Review limit
                - generic [ref=e63]:
                  - generic [ref=e64]:
                    - button "el.inputNumber.decrease" [ref=e65] [cursor=pointer]:
                      - img [ref=e67]
                    - button "el.inputNumber.increase" [ref=e69] [cursor=pointer]:
                      - img [ref=e71]
                    - spinbutton "Review limit" [ref=e75]: "5"
                  - paragraph [ref=e76]: Days before review expires.
              - generic [ref=e77]:
                - generic [ref=e78]: Publish date
                - generic [ref=e79]:
                  - combobox [ref=e80]:
                    - generic [ref=e81]:
                      - img [ref=e84]
                      - textbox "Publish date" [ref=e86]:
                        - /placeholder: Choose a date
                        - text: 2026-10-08
                  - paragraph [ref=e87]: Displayed in Asia/Shanghai.
              - generic [ref=e88]:
                - generic [ref=e89]: Time zone
                - generic [ref=e90]:
                  - generic [ref=e94] [cursor=pointer]:
                    - combobox "Time zone" [ref=e95]: Asia/Shanghai (UTC+8)
                    - img [ref=e98]
                  - paragraph [ref=e100]: Used by scheduled publishing.
          - generic [ref=e101]:
            - heading "Review window" [level=4] [ref=e102]
            - button "Toggle start-date validation example" [ref=e103] [cursor=pointer]:
              - generic [ref=e104]: Toggle start-date validation example
            - generic [ref=e105]:
              - generic [ref=e106]:
                - generic [ref=e107]: Starts
                - generic [ref=e108]:
                  - combobox [ref=e109]:
                    - generic [ref=e110]:
                      - img [ref=e113]
                      - textbox "Starts" [ref=e115]:
                        - /placeholder: Start date
                        - text: 2026-10-08
                  - paragraph [ref=e116]: Reviewers receive access.
              - generic [ref=e117]:
                - generic [ref=e118]: Ends
                - generic [ref=e119]:
                  - combobox [ref=e120]:
                    - generic [ref=e121]:
                      - img [ref=e124]
                      - textbox "Ends" [ref=e126]:
                        - /placeholder: End date
                        - text: 2026-10-09
                  - paragraph [ref=e127]: Open feedback becomes read-only.
          - generic [ref=e128]:
            - heading "Approved cover asset" [level=4] [ref=e129]
            - group "Cover image" [ref=e130]:
              - generic [ref=e131]: Cover image
              - generic [ref=e133]:
                - generic [ref=e135] [cursor=pointer]:
                  - generic [ref=e136]: Drop the approved image here or choose a local file.
                  - paragraph [ref=e137]: PNG or JPEG, up to 2 MB. The editorial crop is 16:9.
                - paragraph [ref=e138]: The current draft still needs an approved cover image.
                - list
          - generic [ref=e139]:
            - heading "Read-only and processing states" [level=4] [ref=e140]
            - generic [ref=e141]:
              - generic [ref=e142]: Release owner
              - generic [ref=e143]:
                - textbox "Release owner" [disabled] [ref=e146]: Editorial operations
                - paragraph [ref=e147]: Ownership changes require administrator approval.
            - group "Approval controls" [ref=e148]:
              - generic [ref=e149]: Approval controls
              - generic [ref=e150]:
                - generic [ref=e151] [cursor=pointer]:
                  - generic [ref=e152]:
                    - checkbox "Require editor approval before publishing" [checked]
                  - generic [ref=e154]: Require editor approval before publishing
                - generic [ref=e155]:
                  - switch [checked]
                  - generic [ref=e157] [cursor=pointer]: Do not notify
                  - generic [ref=e161] [cursor=pointer]: Notify reviewers
                - radiogroup "radio-group" [ref=e162]:
                  - generic [ref=e163] [cursor=pointer]:
                    - radio "Approval required" [checked] [ref=e165]
                    - generic [ref=e167]: Approval required
                  - generic [ref=e168] [cursor=pointer]:
                    - radio "Advisory review" [ref=e170]
                    - generic [ref=e172]: Advisory review
            - button "Checking release policy" [disabled]:
              - generic:
                - generic:
                  - img
              - generic: Checking release policy
      - generic [ref=e173]:
        - generic [ref=e174]:
          - heading "Dark form state authority matrix" [level=3] [ref=e175]
          - paragraph [ref=e176]: Compare readable guidance, secondary state text, and structural borders without changing control geometry.
        - generic [ref=e177]:
          - generic [ref=e178]:
            - heading "Input" [level=4] [ref=e179]
            - generic [ref=e180]:
              - generic [ref=e181]:
                - generic [ref=e182]: Input · default
                - textbox [ref=e185]
                - paragraph [ref=e186]: Required release guidance remains readable.
              - generic [ref=e187]:
                - generic [ref=e188]: Input · hover
                - textbox [ref=e191]
                - paragraph [ref=e192]: Required release guidance remains readable.
              - generic [ref=e193]:
                - generic [ref=e194]: Input · focus
                - textbox [ref=e197]
                - paragraph [ref=e198]: Required release guidance remains readable.
              - generic [ref=e199]:
                - generic [ref=e200]: Input · filled
                - textbox [ref=e203]: Release brief ready
                - paragraph [ref=e204]: Required release guidance remains readable.
              - generic [ref=e205]:
                - generic [ref=e206]: Input · placeholder
                - textbox "Enter release brief" [ref=e209]
                - paragraph [ref=e210]: Required release guidance remains readable.
              - generic [ref=e211]:
                - generic [ref=e212]: Input · disabled
                - textbox [disabled] [ref=e215]: Release brief ready
                - paragraph [ref=e216]: Required release guidance remains readable.
              - generic [ref=e217]:
                - generic [ref=e218]: Input · invalid
                - textbox [ref=e221]
                - paragraph [ref=e222]: Resolve this value before publishing.
          - generic [ref=e223]:
            - heading "Textarea" [level=4] [ref=e224]
            - generic [ref=e225]:
              - generic [ref=e226]:
                - generic [ref=e227]: Textarea · default
                - textbox [ref=e229]
                - paragraph [ref=e230]: Required release guidance remains readable.
              - generic [ref=e231]:
                - generic [ref=e232]: Textarea · hover
                - textbox [ref=e234]
                - paragraph [ref=e235]: Required release guidance remains readable.
              - generic [ref=e236]:
                - generic [ref=e237]: Textarea · focus
                - textbox [ref=e239]
                - paragraph [ref=e240]: Required release guidance remains readable.
              - generic [ref=e241]:
                - generic [ref=e242]: Textarea · filled
                - textbox [ref=e244]: Explain the reader-facing change.
                - paragraph [ref=e245]: Required release guidance remains readable.
              - generic [ref=e246]:
                - generic [ref=e247]: Textarea · placeholder
                - textbox "Add release guidance" [ref=e249]
                - paragraph [ref=e250]: Required release guidance remains readable.
              - generic [ref=e251]:
                - generic [ref=e252]: Textarea · disabled
                - textbox [disabled] [ref=e254]: Explain the reader-facing change.
                - paragraph [ref=e255]: Required release guidance remains readable.
              - generic [ref=e256]:
                - generic [ref=e257]: Textarea · invalid
                - textbox [ref=e259]
                - paragraph [ref=e260]: Resolve this value before publishing.
          - generic [ref=e261]:
            - heading "Select" [level=4] [ref=e262]
            - generic [ref=e263]:
              - generic [ref=e264]:
                - generic [ref=e265]: Select · default
                - generic [ref=e269] [cursor=pointer]:
                  - combobox "请选择" [ref=e270]
                  - img [ref=e273]
                - paragraph [ref=e275]: Required release guidance remains readable.
              - generic [ref=e276]:
                - generic [ref=e277]: Select · hover
                - generic [ref=e281] [cursor=pointer]:
                  - combobox "请选择" [ref=e282]
                  - img [ref=e285]
                - paragraph [ref=e287]: Required release guidance remains readable.
              - generic [ref=e288]:
                - generic [ref=e289]: Select · focus
                - generic [ref=e293] [cursor=pointer]:
                  - combobox "请选择" [ref=e294]
                  - img [ref=e297]
                - paragraph [ref=e299]: Required release guidance remains readable.
              - generic [ref=e300]:
                - generic [ref=e301]: Select · filled
                - generic [ref=e305] [cursor=pointer]:
                  - combobox "请选择" [ref=e306]: Signed-in members
                  - img [ref=e309]
                - paragraph [ref=e311]: Required release guidance remains readable.
              - generic [ref=e312]:
                - generic [ref=e313]: Select · placeholder
                - generic [ref=e317] [cursor=pointer]:
                  - combobox "Choose an audience" [ref=e318]
                  - img [ref=e321]
                - paragraph [ref=e323]: Required release guidance remains readable.
              - generic [ref=e324]:
                - generic [ref=e325]: Select · disabled
                - generic [ref=e329]:
                  - combobox "请选择" [disabled] [ref=e330]: Signed-in members
                  - img [ref=e333]
                - paragraph [ref=e335]: Required release guidance remains readable.
              - generic [ref=e336]:
                - generic [ref=e337]: Select · invalid
                - generic [ref=e341] [cursor=pointer]:
                  - combobox "请选择" [ref=e342]
                  - img [ref=e345]
                - paragraph [ref=e347]: Resolve this value before publishing.
          - generic [ref=e348]:
            - heading "Select V2" [level=4] [ref=e349]
            - generic [ref=e350]:
              - generic [ref=e351]:
                - generic [ref=e352]: Select V2 · default
                - generic [ref=e354] [cursor=pointer]:
                  - combobox [ref=e356]
                  - img [ref=e359]
                - paragraph [ref=e361]: Required release guidance remains readable.
              - generic [ref=e362]:
                - generic [ref=e363]: Select V2 · hover
                - generic [ref=e365] [cursor=pointer]:
                  - combobox [ref=e367]
                  - img [ref=e370]
                - paragraph [ref=e372]: Required release guidance remains readable.
              - generic [ref=e373]:
                - generic [ref=e374]: Select V2 · focus
                - generic [ref=e376] [cursor=pointer]:
                  - combobox [ref=e378]
                  - img [ref=e381]
                - paragraph [ref=e383]: Required release guidance remains readable.
              - generic [ref=e384]:
                - generic [ref=e385]: Select V2 · filled
                - generic [ref=e387] [cursor=pointer]:
                  - combobox [ref=e389]
                  - generic [ref=e390]: Editorial approval
                  - img [ref=e393]
                - paragraph [ref=e395]: Required release guidance remains readable.
              - generic [ref=e396]:
                - generic [ref=e397]: Select V2 · placeholder
                - generic [ref=e399] [cursor=pointer]:
                  - combobox [ref=e401]
                  - img [ref=e404]
                - paragraph [ref=e406]: Required release guidance remains readable.
              - generic [ref=e407]:
                - generic [ref=e408]: Select V2 · disabled
                - generic [ref=e410]:
                  - combobox [disabled] [ref=e412]
                  - generic [ref=e413]: Editorial approval
                  - img [ref=e416]
                - paragraph [ref=e418]: Required release guidance remains readable.
              - generic [ref=e419]:
                - generic [ref=e420]: Select V2 · invalid
                - generic [ref=e422] [cursor=pointer]:
                  - combobox [ref=e424]
                  - img [ref=e427]
                - paragraph [ref=e429]: Resolve this value before publishing.
          - generic [ref=e430]:
            - heading "Date Picker" [level=4] [ref=e431]
            - generic [ref=e432]:
              - generic [ref=e433]:
                - generic [ref=e434]: Date Picker · default
                - combobox [ref=e435]:
                  - generic [ref=e436]:
                    - img [ref=e439]
                    - textbox [ref=e441]
                - paragraph [ref=e442]: Required release guidance remains readable.
              - generic [ref=e443]:
                - generic [ref=e444]: Date Picker · hover
                - combobox [ref=e445]:
                  - generic [ref=e446]:
                    - img [ref=e449]
                    - textbox [ref=e451]
                - paragraph [ref=e452]: Required release guidance remains readable.
              - generic [ref=e453]:
                - generic [ref=e454]: Date Picker · focus
                - combobox [ref=e455]:
                  - generic [ref=e456]:
                    - img [ref=e459]
                    - textbox [ref=e461]
                - paragraph [ref=e462]: Required release guidance remains readable.
              - generic [ref=e463]:
                - generic [ref=e464]: Date Picker · filled
                - combobox [ref=e465]:
                  - generic [ref=e466]:
                    - img [ref=e469]
                    - textbox [ref=e471]: 2026-07-24
                - paragraph [ref=e472]: Required release guidance remains readable.
              - generic [ref=e473]:
                - generic [ref=e474]: Date Picker · placeholder
                - combobox [ref=e475]:
                  - generic [ref=e476]:
                    - img [ref=e479]
                    - textbox "Choose a date" [ref=e481]
                - paragraph [ref=e482]: Required release guidance remains readable.
              - generic [ref=e483]:
                - generic [ref=e484]: Date Picker · disabled
                - combobox [ref=e485]:
                  - generic [ref=e486]:
                    - img [ref=e489]
                    - textbox [disabled] [ref=e491]: 2026-07-24
                - paragraph [ref=e492]: Required release guidance remains readable.
              - generic [ref=e493]:
                - generic [ref=e494]: Date Picker · invalid
                - combobox [ref=e495]:
                  - generic [ref=e496]:
                    - img [ref=e499]
                    - textbox [ref=e501]
                - paragraph [ref=e502]: Resolve this value before publishing.
          - generic [ref=e503]:
            - heading "Time Picker" [level=4] [ref=e504]
            - generic [ref=e505]:
              - generic [ref=e506]:
                - generic [ref=e507]: Time Picker · default
                - combobox [ref=e508]:
                  - generic [ref=e509]:
                    - img [ref=e512]
                    - textbox [ref=e516]
                - paragraph [ref=e517]: Required release guidance remains readable.
              - generic [ref=e518]:
                - generic [ref=e519]: Time Picker · hover
                - combobox [ref=e520]:
                  - generic [ref=e521]:
                    - img [ref=e524]
                    - textbox [ref=e528]
                - paragraph [ref=e529]: Required release guidance remains readable.
              - generic [ref=e530]:
                - generic [ref=e531]: Time Picker · focus
                - combobox [ref=e532]:
                  - generic [ref=e533]:
                    - img [ref=e536]
                    - textbox [ref=e540]
                - paragraph [ref=e541]: Required release guidance remains readable.
              - generic [ref=e542]:
                - generic [ref=e543]: Time Picker · filled
                - combobox [ref=e544]:
                  - generic [ref=e545]:
                    - img [ref=e548]
                    - textbox [ref=e552]: 09:00:00
                - paragraph [ref=e553]: Required release guidance remains readable.
              - generic [ref=e554]:
                - generic [ref=e555]: Time Picker · placeholder
                - combobox [ref=e556]:
                  - generic [ref=e557]:
                    - img [ref=e560]
                    - textbox "Choose a time" [ref=e564]
                - paragraph [ref=e565]: Required release guidance remains readable.
              - generic [ref=e566]:
                - generic [ref=e567]: Time Picker · disabled
                - combobox [ref=e568]:
                  - generic [ref=e569]:
                    - img [ref=e572]
                    - textbox [disabled] [ref=e576]: 09:00:00
                - paragraph [ref=e577]: Required release guidance remains readable.
              - generic [ref=e578]:
                - generic [ref=e579]: Time Picker · invalid
                - combobox [ref=e580]:
                  - generic [ref=e581]:
                    - img [ref=e584]
                    - textbox [ref=e588]
                - paragraph [ref=e589]: Resolve this value before publishing.
          - generic [ref=e590]:
            - heading "Time Select" [level=4] [ref=e591]
            - generic [ref=e592]:
              - generic [ref=e593]:
                - generic [ref=e594]: Time Select · default
                - generic [ref=e598] [cursor=pointer]:
                  - img [ref=e601]
                  - combobox "请选择" [ref=e605]
                  - img [ref=e608]
                - paragraph [ref=e610]: Required release guidance remains readable.
              - generic [ref=e611]:
                - generic [ref=e612]: Time Select · hover
                - generic [ref=e616] [cursor=pointer]:
                  - img [ref=e619]
                  - combobox "请选择" [ref=e623]
                  - img [ref=e626]
                - paragraph [ref=e628]: Required release guidance remains readable.
              - generic [ref=e629]:
                - generic [ref=e630]: Time Select · focus
                - generic [ref=e634] [cursor=pointer]:
                  - img [ref=e637]
                  - combobox "请选择" [ref=e641]
                  - img [ref=e644]
                - paragraph [ref=e646]: Required release guidance remains readable.
              - generic [ref=e647]:
                - generic [ref=e648]: Time Select · filled
                - generic [ref=e652] [cursor=pointer]:
                  - img [ref=e655]
                  - combobox "请选择" [ref=e659]: 09:00
                  - img [ref=e662]
                - paragraph [ref=e664]: Required release guidance remains readable.
              - generic [ref=e665]:
                - generic [ref=e666]: Time Select · placeholder
                - generic [ref=e670] [cursor=pointer]:
                  - img [ref=e673]
                  - combobox "Choose a release slot" [ref=e677]
                  - img [ref=e680]
                - paragraph [ref=e682]: Required release guidance remains readable.
              - generic [ref=e683]:
                - generic [ref=e684]: Time Select · disabled
                - generic [ref=e688]:
                  - img [ref=e691]
                  - combobox "请选择" [disabled] [ref=e695]: 09:00
                  - img [ref=e698]
                - paragraph [ref=e700]: Required release guidance remains readable.
              - generic [ref=e701]:
                - generic [ref=e702]: Time Select · invalid
                - generic [ref=e706] [cursor=pointer]:
                  - img [ref=e709]
                  - combobox "请选择" [ref=e713]
                  - img [ref=e716]
                - paragraph [ref=e718]: Resolve this value before publishing.
          - generic [ref=e719]:
            - heading "Input Number" [level=4] [ref=e720]
            - generic [ref=e721]:
              - generic [ref=e722]:
                - generic [ref=e723]: Input Number · default
                - generic [ref=e724]:
                  - button "el.inputNumber.decrease" [ref=e725] [cursor=pointer]:
                    - img [ref=e727]
                  - button "el.inputNumber.increase" [ref=e729] [cursor=pointer]:
                    - img [ref=e731]
                  - spinbutton [ref=e735]
                - paragraph [ref=e736]: Required release guidance remains readable.
              - generic [ref=e737]:
                - generic [ref=e738]: Input Number · hover
                - generic [ref=e739]:
                  - button "el.inputNumber.decrease" [ref=e740] [cursor=pointer]:
                    - img [ref=e742]
                  - button "el.inputNumber.increase" [ref=e744] [cursor=pointer]:
                    - img [ref=e746]
                  - spinbutton [ref=e750]
                - paragraph [ref=e751]: Required release guidance remains readable.
              - generic [ref=e752]:
                - generic [ref=e753]: Input Number · focus
                - generic [ref=e754]:
                  - button "el.inputNumber.decrease" [ref=e755] [cursor=pointer]:
                    - img [ref=e757]
                  - button "el.inputNumber.increase" [ref=e759] [cursor=pointer]:
                    - img [ref=e761]
                  - spinbutton [ref=e765]
                - paragraph [ref=e766]: Required release guidance remains readable.
              - generic [ref=e767]:
                - generic [ref=e768]: Input Number · filled
                - generic [ref=e769]:
                  - button "el.inputNumber.decrease" [ref=e770] [cursor=pointer]:
                    - img [ref=e772]
                  - button "el.inputNumber.increase" [ref=e774] [cursor=pointer]:
                    - img [ref=e776]
                  - spinbutton [ref=e780]: "7"
                - paragraph [ref=e781]: Required release guidance remains readable.
              - generic [ref=e782]:
                - generic [ref=e783]: Input Number · placeholder
                - generic [ref=e784]:
                  - button "el.inputNumber.decrease" [ref=e785] [cursor=pointer]:
                    - img [ref=e787]
                  - button "el.inputNumber.increase" [ref=e789] [cursor=pointer]:
                    - img [ref=e791]
                  - spinbutton [ref=e795]
                - paragraph [ref=e796]: Required release guidance remains readable.
              - generic [ref=e797]:
                - generic [ref=e798]: Input Number · disabled
                - generic [ref=e799]:
                  - button "el.inputNumber.decrease" [ref=e800] [cursor=pointer]:
                    - img [ref=e802]
                  - button "el.inputNumber.increase" [ref=e804] [cursor=pointer]:
                    - img [ref=e806]
                  - spinbutton [disabled] [ref=e810]: "7"
                - paragraph [ref=e811]: Required release guidance remains readable.
              - generic [ref=e812]:
                - generic [ref=e813]: Input Number · invalid
                - generic [ref=e814]:
                  - button "el.inputNumber.decrease" [ref=e815] [cursor=pointer]:
                    - img [ref=e817]
                  - button "el.inputNumber.increase" [ref=e819] [cursor=pointer]:
                    - img [ref=e821]
                  - spinbutton [ref=e825]
                - paragraph [ref=e826]: Resolve this value before publishing.
          - generic [ref=e827]:
            - heading "Cascader" [level=4] [ref=e828]
            - generic [ref=e829]:
              - generic [ref=e830]:
                - generic [ref=e831]: Cascader · default
                - generic [ref=e834]:
                  - textbox "请选择" [ref=e835] [cursor=pointer]
                  - img [ref=e838]
                - paragraph [ref=e840]: Required release guidance remains readable.
              - generic [ref=e841]:
                - generic [ref=e842]: Cascader · hover
                - generic [ref=e845]:
                  - textbox "请选择" [ref=e846] [cursor=pointer]
                  - img [ref=e849]
                - paragraph [ref=e851]: Required release guidance remains readable.
              - generic [ref=e852]:
                - generic [ref=e853]: Cascader · focus
                - generic [ref=e856]:
                  - textbox "请选择" [ref=e857] [cursor=pointer]
                  - img [ref=e860]
                - paragraph [ref=e862]: Required release guidance remains readable.
              - generic [ref=e863]:
                - generic [ref=e864]: Cascader · filled
                - generic [ref=e867]:
                  - textbox [ref=e868] [cursor=pointer]: Editorial / Release
                  - img [ref=e871]
                - paragraph [ref=e873]: Required release guidance remains readable.
              - generic [ref=e874]:
                - generic [ref=e875]: Cascader · placeholder
                - generic [ref=e878]:
                  - textbox "Choose a release category" [ref=e879] [cursor=pointer]
                  - img [ref=e882]
                - paragraph [ref=e884]: Required release guidance remains readable.
              - generic [ref=e885]:
                - generic [ref=e886]: Cascader · disabled
                - generic [ref=e889]:
                  - textbox [disabled] [ref=e890]: Editorial / Release
                  - img [ref=e893]
                - paragraph [ref=e895]: Required release guidance remains readable.
              - generic [ref=e896]:
                - generic [ref=e897]: Cascader · invalid
                - generic [ref=e900]:
                  - textbox "请选择" [ref=e901] [cursor=pointer]
                  - img [ref=e904]
                - paragraph [ref=e906]: Resolve this value before publishing.
          - generic [ref=e907]:
            - heading "Upload" [level=4] [ref=e908]
            - generic [ref=e909]:
              - generic [ref=e910]:
                - generic [ref=e911]: Upload · default
                - generic [ref=e912]:
                  - paragraph [ref=e915] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e916]: Required release guidance remains readable.
              - generic [ref=e917]:
                - generic [ref=e918]: Upload · hover
                - generic [ref=e919]:
                  - paragraph [ref=e922] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e923]: Required release guidance remains readable.
              - generic [ref=e924]:
                - generic [ref=e925]: Upload · focus
                - generic [ref=e926]:
                  - paragraph [ref=e929] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e930]: Required release guidance remains readable.
              - generic [ref=e931]:
                - generic [ref=e932]: Upload · filled
                - generic [ref=e933]:
                  - paragraph [ref=e936] [cursor=pointer]: approved-cover.png
                  - list
                - paragraph [ref=e937]: Required release guidance remains readable.
              - generic [ref=e938]:
                - generic [ref=e939]: Upload · placeholder
                - generic [ref=e940]:
                  - paragraph [ref=e943] [cursor=pointer]: Choose an approved cover
                  - list
                - paragraph [ref=e944]: Required release guidance remains readable.
              - generic [ref=e945]:
                - generic [ref=e946]: Upload · disabled
                - generic [ref=e947]:
                  - paragraph [ref=e950] [cursor=pointer]: approved-cover.png
                  - list
                - paragraph [ref=e951]: Required release guidance remains readable.
              - generic [ref=e952]:
                - generic [ref=e953]: Upload · invalid
                - generic [ref=e954]:
                  - paragraph [ref=e957] [cursor=pointer]: Drop a cover or browse
                  - list
                - paragraph [ref=e958]: Resolve this value before publishing.
      - generic [ref=e959]:
        - heading "Radio & RadioButton" [level=3] [ref=e960]
        - generic [ref=e961]:
          - radiogroup "radio-group" [ref=e963]:
            - generic [ref=e964] [cursor=pointer]:
              - radio "公开" [checked] [ref=e966]
              - generic [ref=e968]: 公开
            - generic [ref=e969] [cursor=pointer]:
              - radio "仅自己可见" [ref=e971]
              - generic [ref=e973]: 仅自己可见
          - radiogroup "radio-group" [ref=e975]:
            - generic [ref=e976]:
              - radio "公开" [checked] [ref=e977]
              - generic [ref=e978] [cursor=pointer]: 公开
            - generic [ref=e979]:
              - radio "仅自己可见" [ref=e980]
              - generic [ref=e981] [cursor=pointer]: 仅自己可见
      - generic [ref=e982]:
        - heading "Checkbox & CheckboxButton" [level=3] [ref=e983]
        - generic [ref=e984]:
          - generic [ref=e986] [cursor=pointer]:
            - generic [ref=e987]:
              - checkbox "Checkbox" [checked]
            - generic [ref=e989]: Checkbox
          - group "checkbox-group" [ref=e991]:
            - generic [ref=e992] [cursor=pointer]:
              - generic [ref=e993]:
                - checkbox "推送到首页" [checked]
              - generic [ref=e995]: 推送到首页
            - generic [ref=e996] [cursor=pointer]:
              - generic [ref=e997]:
                - checkbox "保持普通"
              - generic [ref=e999]: 保持普通
          - group "checkbox-group" [ref=e1001]:
            - generic [ref=e1002]:
              - checkbox "推送到首页" [checked] [ref=e1003]
              - generic [ref=e1004] [cursor=pointer]: 推送到首页
            - generic [ref=e1005]:
              - checkbox "保持普通" [ref=e1006]
              - generic [ref=e1007] [cursor=pointer]: 保持普通
      - generic [ref=e1008]:
        - heading "Input" [level=3] [ref=e1009]
        - generic [ref=e1010]:
          - textbox "输入文章标题" [ref=e1014]
          - textbox "写下摘要或更新说明" [ref=e1017]
      - generic [ref=e1018]:
        - heading "InputNumber" [level=3] [ref=e1019]
        - generic [ref=e1020]:
          - generic [ref=e1022]:
            - button "el.inputNumber.decrease" [ref=e1023]:
              - img [ref=e1025]
            - button "el.inputNumber.increase" [ref=e1027] [cursor=pointer]:
              - img [ref=e1029]
            - spinbutton [ref=e1033]: "1"
          - generic [ref=e1035]:
            - button "el.inputNumber.decrease" [ref=e1036]:
              - img [ref=e1038]
            - button "el.inputNumber.increase" [ref=e1040] [cursor=pointer]:
              - img [ref=e1042]
            - spinbutton [ref=e1046]: "1"
          - generic [ref=e1048]:
            - button "el.inputNumber.decrease" [ref=e1049]:
              - img [ref=e1051]
            - button "el.inputNumber.increase" [ref=e1053] [cursor=pointer]:
              - img [ref=e1055]
            - spinbutton [ref=e1059]: "1"
          - generic [ref=e1061]:
            - button "el.inputNumber.decrease" [ref=e1062]:
              - img [ref=e1064]
            - button "el.inputNumber.increase" [ref=e1066] [cursor=pointer]:
              - img [ref=e1068]
            - spinbutton [ref=e1072]: "1"
          - generic [ref=e1074]:
            - button "el.inputNumber.decrease" [ref=e1075]:
              - img [ref=e1077]
            - button "el.inputNumber.increase" [ref=e1079] [cursor=pointer]:
              - img [ref=e1081]
            - spinbutton [ref=e1085]: "1"
          - generic [ref=e1087]:
            - button "el.inputNumber.decrease" [ref=e1088]:
              - img [ref=e1090]
            - button "el.inputNumber.increase" [ref=e1092] [cursor=pointer]:
              - img [ref=e1094]
            - spinbutton [ref=e1098]: "1"
          - generic [ref=e1100]:
            - button "el.inputNumber.decrease" [ref=e1101]:
              - img [ref=e1103]
            - button "el.inputNumber.increase" [ref=e1105] [cursor=pointer]:
              - img [ref=e1107]
            - spinbutton [disabled] [ref=e1111]: "1"
      - generic [ref=e1112]:
        - heading "Select & Option & OptionGroup" [level=3] [ref=e1113]
        - generic [ref=e1117] [cursor=pointer]:
          - combobox "选择可见范围" [ref=e1118]
          - img [ref=e1121]
      - generic [ref=e1123]:
        - heading "SelectV2" [level=3] [ref=e1124]
        - generic [ref=e1126] [cursor=pointer]:
          - combobox [ref=e1128]
          - img [ref=e1131]
      - generic [ref=e1133]:
        - heading "Cascader & CascaderPanel" [level=3] [ref=e1134]
        - generic [ref=e1135]:
          - generic [ref=e1139]:
            - textbox "选择分类" [ref=e1140] [cursor=pointer]
            - img [ref=e1143]
          - menu [ref=e1149]:
            - menuitem "Guide" [ref=e1150] [cursor=pointer]:
              - generic [ref=e1151]: Guide
              - img [ref=e1153]
      - generic [ref=e1155]:
        - heading "Switch" [level=3] [ref=e1156]
        - generic [ref=e1157]:
          - switch [checked]
          - generic [ref=e1159] [cursor=pointer]: Close
          - generic [ref=e1163] [cursor=pointer]: Open
      - generic [ref=e1164]:
        - heading "Slider" [level=3] [ref=e1165]
        - slider "el.slider.defaultLabel" [ref=e1169] [cursor=pointer]
      - generic [ref=e1171]:
        - heading "TimePicker / TimeSelect" [level=3] [ref=e1172]
        - generic [ref=e1173]:
          - combobox [ref=e1175]:
            - generic [ref=e1176]:
              - img [ref=e1179]
              - textbox "选择发布时间" [ref=e1183]
          - generic [ref=e1188] [cursor=pointer]:
            - img [ref=e1191]
            - combobox "选择推送时段" [ref=e1195]
            - img [ref=e1198]
      - generic [ref=e1200]:
        - heading "DatePicker" [level=3] [ref=e1201]
        - generic [ref=e1202]:
          - combobox [ref=e1204]:
            - generic [ref=e1205]:
              - img [ref=e1208]
              - textbox "选择日期" [ref=e1210]: 2026-10-08
          - generic [ref=e1212]:
            - img [ref=e1214]
            - textbox "开始日期" [ref=e1216]: 2026-10-08
            - generic [ref=e1217]: 至
            - textbox "结束日期" [ref=e1218]: 2026-10-08
      - generic [ref=e1219]:
        - heading "Upload" [level=3] [ref=e1220]
        - generic [ref=e1221]:
          - button "上传封面" [ref=e1223] [cursor=pointer]:
            - generic [ref=e1224]: 上传封面
          - generic [ref=e1225]: 支持 jpg/png，单个文件 ≤ 500KB
          - list
      - generic [ref=e1226]:
        - heading "Rate" [level=3] [ref=e1227]
        - slider "rating" [ref=e1228]:
          - img [ref=e1231] [cursor=pointer]
          - img [ref=e1235] [cursor=pointer]
          - img [ref=e1239] [cursor=pointer]
          - generic [ref=e1242] [cursor=pointer]:
            - img [ref=e1243]
            - img [ref=e1246]
          - img [ref=e1250] [cursor=pointer]
      - generic [ref=e1252]:
        - heading "ColorPicker" [level=3] [ref=e1253]
        - button "el.colorpicker.defaultLabel" [ref=e1254]
      - generic [ref=e1258]:
        - heading "Transfer" [level=3] [ref=e1259]
        - generic [ref=e1261]:
          - generic [ref=e1262]:
            - paragraph [ref=e1263]:
              - generic [ref=e1264] [cursor=pointer]:
                - generic [ref=e1265]:
                  - checkbox "列表 1 0/15"
                - generic [ref=e1267]:
                  - text: 列表 1
                  - generic [ref=e1268]: 0/15
            - group "checkbox-group" [ref=e1270]:
              - generic [ref=e1271]:
                - generic [ref=e1272] [cursor=pointer]:
                  - checkbox "同步成员权限" [disabled]
                - generic "同步成员权限" [ref=e1275]
              - generic [ref=e1276] [cursor=pointer]:
                - generic [ref=e1277]:
                  - checkbox "发布前校对"
                - generic "发布前校对" [ref=e1280]
              - generic [ref=e1281] [cursor=pointer]:
                - generic [ref=e1282]:
                  - checkbox "更新封面图"
                - generic "更新封面图" [ref=e1285]
              - generic [ref=e1286] [cursor=pointer]:
                - generic [ref=e1287]:
                  - checkbox "复核评论设置"
                - generic "复核评论设置" [ref=e1290]
              - generic [ref=e1291]:
                - generic [ref=e1292] [cursor=pointer]:
                  - checkbox "写入审计记录" [disabled]
                - generic "写入审计记录" [ref=e1295]
              - generic [ref=e1296] [cursor=pointer]:
                - generic [ref=e1297]:
                  - checkbox "刷新搜索索引"
                - generic "刷新搜索索引" [ref=e1300]
              - generic [ref=e1301] [cursor=pointer]:
                - generic [ref=e1302]:
                  - checkbox "生成分享摘要"
                - generic "生成分享摘要" [ref=e1305]
              - generic [ref=e1306] [cursor=pointer]:
                - generic [ref=e1307]:
                  - checkbox "同步首页推荐"
                - generic "同步首页推荐" [ref=e1310]
              - generic [ref=e1311]:
                - generic [ref=e1312] [cursor=pointer]:
                  - checkbox "校验附件大小" [disabled]
                - generic "校验附件大小" [ref=e1315]
              - generic [ref=e1316] [cursor=pointer]:
                - generic [ref=e1317]:
                  - checkbox "通知协作者"
                - generic "通知协作者" [ref=e1320]
              - generic [ref=e1321] [cursor=pointer]:
                - generic [ref=e1322]:
                  - checkbox "归档过期草稿"
                - generic "归档过期草稿" [ref=e1325]
              - generic [ref=e1326] [cursor=pointer]:
                - generic [ref=e1327]:
                  - checkbox "检查外链状态"
                - generic "检查外链状态" [ref=e1330]
              - generic [ref=e1331]:
                - generic [ref=e1332] [cursor=pointer]:
                  - checkbox "更新标签分组" [disabled]
                - generic "更新标签分组" [ref=e1335]
              - generic [ref=e1336] [cursor=pointer]:
                - generic [ref=e1337]:
                  - checkbox "预热公开缓存"
                - generic "预热公开缓存" [ref=e1340]
              - generic [ref=e1341] [cursor=pointer]:
                - generic [ref=e1342]:
                  - checkbox "记录发布说明"
                - generic "记录发布说明" [ref=e1345]
          - generic [ref=e1346]:
            - button "列表 2 → 列表 1" [disabled] [ref=e1347]:
              - img [ref=e1350]
            - button "列表 1 → 列表 2" [disabled] [ref=e1352]:
              - img [ref=e1355]
          - generic [ref=e1357]:
            - paragraph [ref=e1358]:
              - generic [ref=e1359] [cursor=pointer]:
                - generic [ref=e1360]:
                  - checkbox "列表 2 0/0"
                - generic [ref=e1362]:
                  - text: 列表 2
                  - generic [ref=e1363]: 0/0
            - paragraph [ref=e1365]: 无数据
      - generic [ref=e1366]:
        - heading "Form & FormItem" [level=3] [ref=e1367]
        - generic [ref=e1368]:
          - generic [ref=e1369]:
            - generic [ref=e1370]: 文章标题
            - textbox "文章标题" [ref=e1374]
          - generic [ref=e1375]:
            - generic [ref=e1376]: 可见范围
            - generic [ref=e1382] [cursor=pointer]:
              - combobox "可见范围" [ref=e1383]
              - img [ref=e1386]
      - generic [ref=e1388]:
        - heading "Autocomplete" [level=3] [ref=e1389]
        - combobox [ref=e1390]:
          - textbox [ref=e1393]
      - generic [ref=e1394]:
        - heading "TreeSelect" [level=3] [ref=e1395]
        - generic [ref=e1400] [cursor=pointer]:
          - combobox "请选择" [ref=e1401]: Level one 1
          - img [ref=e1404]
    - generic [ref=e1407]:
      - heading "Data" [level=2] [ref=e1408]
      - generic [ref=e1409]:
        - heading "Table & TableColumn" [level=3] [ref=e1410]
        - generic [ref=e1412]:
          - table [ref=e1414]:
            - rowgroup [ref=e1426]:
              - row "标题 发布日期 作者 状态 分类 阅读量 标识符 可见范围 操作" [ref=e1427]:
                - columnheader [ref=e1428]:
                  - generic [ref=e1431] [cursor=pointer]:
                    - checkbox
                - columnheader "标题" [ref=e1433]:
                  - generic [ref=e1434]: 标题
                - columnheader "发布日期" [ref=e1435]:
                  - generic [ref=e1436]: 发布日期
                - columnheader "作者" [ref=e1437]:
                  - generic [ref=e1438]: 作者
                - columnheader "状态" [ref=e1439]:
                  - generic [ref=e1440]: 状态
                - columnheader "分类" [ref=e1441]:
                  - generic [ref=e1442]: 分类
                - columnheader "阅读量" [ref=e1443]:
                  - generic [ref=e1444]: 阅读量
                - columnheader "标识符" [ref=e1445]:
                  - generic [ref=e1446]: 标识符
                - columnheader "可见范围" [ref=e1447]:
                  - generic [ref=e1448]: 可见范围
                - columnheader "操作" [ref=e1449]:
                  - generic [ref=e1450]: 操作
          - region "Scrollable data table" [ref=e1451]:
            - table [ref=e1455]:
              - rowgroup [ref=e1467]:
                - row "Tom 2016-05-03 青砚 已发布 研究笔记 12840 research-note-2016-05-03-long-identifier No. 189, Grove St, Los Angeles 打开" [ref=e1468]:
                  - cell [ref=e1469]:
                    - generic [ref=e1472] [cursor=pointer]:
                      - checkbox
                  - cell "Tom" [ref=e1474]:
                    - generic [ref=e1475]: Tom
                  - cell "2016-05-03" [ref=e1476]:
                    - generic [ref=e1477]: 2016-05-03
                  - cell "青砚" [ref=e1478]:
                    - generic [ref=e1479]: 青砚
                  - cell "已发布" [ref=e1480]:
                    - generic [ref=e1481]: 已发布
                  - cell "研究笔记" [ref=e1482]:
                    - generic [ref=e1483]: 研究笔记
                  - cell "12840" [ref=e1484]:
                    - generic [ref=e1485]: "12840"
                  - cell "research-note-2016-05-03-long-identifier" [ref=e1486]:
                    - generic [ref=e1487]: research-note-2016-05-03-long-identifier
                  - cell "No. 189, Grove St, Los Angeles" [ref=e1488]:
                    - generic [ref=e1489]: No. 189, Grove St, Los Angeles
                  - cell "打开" [ref=e1490]:
                    - button "打开" [ref=e1492] [cursor=pointer]:
                      - generic [ref=e1493]: 打开
                - row "John 2016-05-02 Lin 草稿 随笔 320 draft-2016-05-02 No. 189, Grove St, Los Angeles 打开" [ref=e1494]:
                  - cell [ref=e1495]:
                    - generic [ref=e1498] [cursor=pointer]:
                      - checkbox
                  - cell "John" [ref=e1500]:
                    - generic [ref=e1501]: John
                  - cell "2016-05-02" [ref=e1502]:
                    - generic [ref=e1503]: 2016-05-02
                  - cell "Lin" [ref=e1504]:
                    - generic [ref=e1505]: Lin
                  - cell "草稿" [ref=e1506]:
                    - generic [ref=e1507]: 草稿
                  - cell "随笔" [ref=e1508]:
                    - generic [ref=e1509]: 随笔
                  - cell "320" [ref=e1510]:
                    - generic [ref=e1511]: "320"
                  - cell "draft-2016-05-02" [ref=e1512]:
                    - generic [ref=e1513]: draft-2016-05-02
                  - cell "No. 189, Grove St, Los Angeles" [ref=e1514]:
                    - generic [ref=e1515]: No. 189, Grove St, Los Angeles
                  - cell "打开" [ref=e1516]:
                    - button "打开" [ref=e1518] [cursor=pointer]:
                      - generic [ref=e1519]: 打开
        - generic [ref=e1523]:
          - table [ref=e1525]:
            - rowgroup [ref=e1530]:
              - row "标题 标识符 可见范围" [ref=e1531]:
                - columnheader "标题" [ref=e1532]:
                  - generic [ref=e1533]: 标题
                - columnheader "标识符" [ref=e1534]:
                  - generic [ref=e1535]: 标识符
                - columnheader "可见范围" [ref=e1536]:
                  - generic [ref=e1537]: 可见范围
          - region "横向浏览文章字段" [ref=e1538]:
            - table [ref=e1542]:
              - rowgroup [ref=e1547]:
                - row "Tom research-note-2016-05-03-long-identifier No. 189, Grove St, Los Angeles" [ref=e1548]:
                  - cell "Tom" [ref=e1549]:
                    - generic [ref=e1550]: Tom
                  - cell "research-note-2016-05-03-long-identifier" [ref=e1551]:
                    - generic [ref=e1552]: research-note-2016-05-03-long-identifier
                  - cell "No. 189, Grove St, Los Angeles" [ref=e1553]:
                    - generic [ref=e1554]: No. 189, Grove St, Los Angeles
      - generic [ref=e1555]:
        - heading "TableV2 & AutoResizer" [level=3] [ref=e1556]
        - table [ref=e1560]:
          - rowgroup [ref=e1561]:
            - generic [ref=e1563]:
              - row "Tom-0 id-0" [ref=e1564]:
                - cell "Tom-0" [ref=e1565]:
                  - generic "Tom-0" [ref=e1566]
                - cell "id-0" [ref=e1567]:
                  - generic "id-0" [ref=e1568]
              - row "Tom-1 id-1" [ref=e1569]:
                - cell "Tom-1" [ref=e1570]:
                  - generic "Tom-1" [ref=e1571]
                - cell "id-1" [ref=e1572]:
                  - generic "id-1" [ref=e1573]
              - row "Tom-2 id-2" [ref=e1574]:
                - cell "Tom-2" [ref=e1575]:
                  - generic "Tom-2" [ref=e1576]
                - cell "id-2" [ref=e1577]:
                  - generic "id-2" [ref=e1578]
              - row "Tom-3 id-3" [ref=e1579]:
                - cell "Tom-3" [ref=e1580]:
                  - generic "Tom-3" [ref=e1581]
                - cell "id-3" [ref=e1582]:
                  - generic "id-3" [ref=e1583]
              - row "Tom-4 id-4" [ref=e1584]:
                - cell "Tom-4" [ref=e1585]:
                  - generic "Tom-4" [ref=e1586]
                - cell "id-4" [ref=e1587]:
                  - generic "id-4" [ref=e1588]
              - row "Tom-5 id-5" [ref=e1589]:
                - cell "Tom-5" [ref=e1590]:
                  - generic "Tom-5" [ref=e1591]
                - cell "id-5" [ref=e1592]:
                  - generic "id-5" [ref=e1593]
              - row "Tom-6 id-6" [ref=e1594]:
                - cell "Tom-6" [ref=e1595]:
                  - generic "Tom-6" [ref=e1596]
                - cell "id-6" [ref=e1597]:
                  - generic "id-6" [ref=e1598]
          - rowgroup [ref=e1600]:
            - row "Name ID" [ref=e1602]:
              - columnheader "Name" [ref=e1603]:
                - generic "Name" [ref=e1604]
              - columnheader "ID" [ref=e1605]:
                - generic "ID" [ref=e1606]
      - generic [ref=e1607]:
        - heading "Tag / CheckTag" [level=3] [ref=e1608]
        - generic [ref=e1609]:
          - generic [ref=e1611]: 文章
          - generic [ref=e1613]: 已发布
          - generic [ref=e1615]: 技术笔记
          - generic [ref=e1617]: 待复核
          - generic [ref=e1619]: 高风险
          - checkbox "已同步" [checked] [ref=e1621] [cursor=pointer]
      - generic [ref=e1622]:
        - heading "Progress" [level=3] [ref=e1623]
        - generic [ref=e1624]:
          - progressbar [ref=e1626]:
            - generic [ref=e1627]: 50%
          - progressbar [ref=e1629]:
            - img [ref=e1632]
          - progressbar [ref=e1636]:
            - img [ref=e1639]
          - progressbar [ref=e1643]:
            - img [ref=e1645]
            - generic [ref=e1648]: 25%
      - generic [ref=e1649]:
        - heading "Tree" [level=3] [ref=e1650]
        - tree [ref=e1651]:
          - treeitem "Level one 1" [ref=e1652]:
            - generic [ref=e1653] [cursor=pointer]:
              - img [ref=e1655]
              - generic [ref=e1658]:
                - checkbox
              - generic [ref=e1660]: Level one 1
      - generic [ref=e1661]:
        - heading "TreeV2" [level=3] [ref=e1662]
        - tree [ref=e1664]:
          - generic [ref=e1667]:
            - treeitem "Node 0" [ref=e1668]:
              - generic [ref=e1670] [cursor=pointer]: Node 0
            - treeitem "Node 1" [ref=e1671]:
              - generic [ref=e1673] [cursor=pointer]: Node 1
            - treeitem "Node 2" [ref=e1674]:
              - generic [ref=e1676] [cursor=pointer]: Node 2
            - treeitem "Node 3" [ref=e1677]:
              - generic [ref=e1679] [cursor=pointer]: Node 3
            - treeitem "Node 4" [ref=e1680]:
              - generic [ref=e1682] [cursor=pointer]: Node 4
            - treeitem "Node 5" [ref=e1683]:
              - generic [ref=e1685] [cursor=pointer]: Node 5
            - treeitem "Node 6" [ref=e1686]:
              - generic [ref=e1688] [cursor=pointer]: Node 6
      - generic [ref=e1690]:
        - heading "Pagination" [level=3] [ref=e1691]
        - generic [ref=e1692]:
          - navigation "文章分页" [ref=e1693]:
            - button "上一页" [ref=e1694] [cursor=pointer]:
              - generic:
                - img
            - list [ref=e1696]:
              - listitem "第 1 页" [ref=e1697] [cursor=pointer]: "1"
              - listitem "向前 5 页" [ref=e1698] [cursor=pointer]:
                - img
              - listitem "第 3 页" [ref=e1699] [cursor=pointer]: "3"
              - listitem "第 4 页" [ref=e1700] [cursor=pointer]: "4"
              - listitem "第 5 页" [ref=e1701]: "5"
              - listitem "第 6 页" [ref=e1702] [cursor=pointer]: "6"
              - listitem "第 7 页" [ref=e1703] [cursor=pointer]: "7"
              - listitem "向后 5 页" [ref=e1704] [cursor=pointer]:
                - img
              - listitem "第 100 页" [ref=e1705] [cursor=pointer]: "100"
            - button "下一页" [ref=e1706] [cursor=pointer]:
              - generic:
                - img
          - generic [ref=e1707]:
            - generic [ref=e1708]: 共 1000 条
            - generic [ref=e1709]:
              - generic [ref=e1710]: 前往
              - spinbutton "页" [ref=e1713]: "5"
              - generic [ref=e1714]: 页
      - generic [ref=e1715]:
        - heading "Badge" [level=3] [ref=e1716]
        - generic [ref=e1717]:
          - generic [ref=e1719]:
            - button "Comments" [ref=e1720] [cursor=pointer]:
              - generic [ref=e1721]: Comments
            - superscript [ref=e1722]: "12"
          - generic [ref=e1724]:
            - button "Share article" [ref=e1725] [cursor=pointer]:
              - img [ref=e1727]
              - generic [ref=e1729]: Share article
            - superscript [ref=e1730]
      - generic [ref=e1731]:
        - heading "Avatar" [level=3] [ref=e1732]
        - generic [ref=e1739]: User
      - generic [ref=e1740]:
        - heading "Skeleton & SkeletonItem" [level=3] [ref=e1741]
        - img [ref=e1744]
      - generic [ref=e1751]:
        - heading "Empty" [level=3] [ref=e1752]
        - generic [ref=e1753]:
          - img [ref=e1755]
          - generic [ref=e1760]: 暂无文章
      - generic [ref=e1761]:
        - heading "Descriptions & DescriptionsItem" [level=3] [ref=e1762]
        - generic [ref=e1763]:
          - generic [ref=e1765]: 用户资料
          - table [ref=e1768]:
            - rowgroup [ref=e1769]:
              - row "笔名 青砚 联系电话 18100000000 所在地 苏州" [ref=e1770]:
                - cell "笔名" [ref=e1771]
                - cell "青砚" [ref=e1772]
                - cell "联系电话" [ref=e1773]
                - cell "18100000000" [ref=e1774]
                - cell "所在地" [ref=e1775]
                - cell "苏州" [ref=e1776]
              - row "标签 写作 地址 江苏省苏州市吴中区吴中大道 1188 号 主页 https://example.com/authors/青砚/research-notes-and-publications" [ref=e1777]:
                - cell "标签" [ref=e1778]
                - cell "写作" [ref=e1779]:
                  - generic [ref=e1780]: 写作
                - cell "地址" [ref=e1781]
                - cell "江苏省苏州市吴中区吴中大道 1188 号" [ref=e1782]
                - cell "主页" [ref=e1783]
                - cell "https://example.com/authors/青砚/research-notes-and-publications" [ref=e1784]
              - row "备注" [ref=e1785]:
                - cell "备注" [ref=e1786]
                - cell [ref=e1787]
      - generic [ref=e1788]:
        - heading "Descriptions spacing matrix" [level=3] [ref=e1789]
        - generic [ref=e1790]:
          - generic [ref=e1792]:
            - generic [ref=e1794]: bordered large
            - table [ref=e1797]:
              - rowgroup [ref=e1798]:
                - row "笔名 青砚 所在地 苏州" [ref=e1799]:
                  - cell "笔名" [ref=e1800]
                  - cell "青砚" [ref=e1801]
                  - cell "所在地" [ref=e1802]
                  - cell "苏州" [ref=e1803]
                - row "主页 https://example.com/authors/qingyan" [ref=e1804]:
                  - cell "主页" [ref=e1805]
                  - cell "https://example.com/authors/qingyan" [ref=e1806]
          - generic [ref=e1808]:
            - generic [ref=e1810]: bordered default
            - table [ref=e1813]:
              - rowgroup [ref=e1814]:
                - row "笔名 青砚 所在地 苏州" [ref=e1815]:
                  - cell "笔名" [ref=e1816]
                  - cell "青砚" [ref=e1817]
                  - cell "所在地" [ref=e1818]
                  - cell "苏州" [ref=e1819]
                - row "地址 江苏省苏州市吴中区吴中大道 1188 号" [ref=e1820]:
                  - cell "地址" [ref=e1821]
                  - cell "江苏省苏州市吴中区吴中大道 1188 号" [ref=e1822]
          - generic [ref=e1824]:
            - generic [ref=e1826]: bordered small
            - table [ref=e1829]:
              - rowgroup [ref=e1830]:
                - row "笔名 青砚 所在地 苏州" [ref=e1831]:
                  - cell "笔名" [ref=e1832]
                  - cell "青砚" [ref=e1833]
                  - cell "所在地" [ref=e1834]
                  - cell "苏州" [ref=e1835]
          - generic [ref=e1837]:
            - generic [ref=e1839]: non-bordered default
            - table [ref=e1842]:
              - rowgroup [ref=e1843]:
                - row "笔名青砚 所在地苏州" [ref=e1844]:
                  - cell "笔名青砚" [ref=e1845]
                  - cell "所在地苏州" [ref=e1846]
          - generic [ref=e1848]:
            - generic [ref=e1850]: bordered vertical
            - table [ref=e1853]:
              - rowgroup [ref=e1854]:
                - row "笔名 备注" [ref=e1855]:
                  - columnheader "笔名" [ref=e1856]
                  - columnheader "备注" [ref=e1857]
                - row "青砚 长备注：研究笔记、出版记录与公开主页摘要。" [ref=e1858]:
                  - cell "青砚" [ref=e1859]
                  - cell "长备注：研究笔记、出版记录与公开主页摘要。" [ref=e1860]
          - generic [ref=e1862]:
            - generic [ref=e1864]: responsive stack
            - generic "Description fields" [ref=e1866]:
              - generic [ref=e1867]:
                - term [ref=e1868]: 笔名
                - definition [ref=e1869]: 青砚
              - generic [ref=e1870]:
                - term [ref=e1871]: 所在地
                - definition [ref=e1872]: 苏州
      - generic [ref=e1873]:
        - heading "Result" [level=3] [ref=e1874]
        - generic [ref=e1875]:
          - img [ref=e1877]
          - generic [ref=e1879]: 已发布
          - generic [ref=e1880]: 读者将看到最新版本
          - button "返回文章列表" [ref=e1882] [cursor=pointer]:
            - generic [ref=e1883]: 返回文章列表
      - generic [ref=e1884]:
        - heading "Statistic / Countdown" [level=3] [ref=e1885]
        - generic [ref=e1886]:
          - generic [ref=e1888]:
            - generic [ref=e1889]: 今日活跃读者
            - generic [ref=e1890]: 268,500
          - generic [ref=e1892]:
            - generic [ref=e1893]: 距定时发布
            - generic [ref=e1894]: 47:59:57
      - generic [ref=e1895]:
        - heading "Timeline & TimelineItem" [level=3] [ref=e1896]
        - list [ref=e1897]:
          - listitem [ref=e1898]:
            - generic [ref=e1901]:
              - generic [ref=e1902]: 2018/4/12
              - generic [ref=e1903]: 更新封面图
          - listitem [ref=e1904]:
            - generic [ref=e1906]:
              - generic [ref=e1907]: 2018/4/3
              - generic [ref=e1908]: 校对摘要
      - generic [ref=e1909]:
        - heading "Calendar" [level=3] [ref=e1910]
        - generic [ref=e1911]:
          - generic [ref=e1912]:
            - generic [ref=e1913]: 2026年10月
            - generic [ref=e1915]:
              - button "上个月" [ref=e1916] [cursor=pointer]:
                - generic [ref=e1918]: 上个月
              - button "今天" [ref=e1919] [cursor=pointer]:
                - generic [ref=e1920]: 今天
              - button "下个月" [ref=e1921] [cursor=pointer]:
                - generic [ref=e1923]: 下个月
          - table [ref=e1925]:
            - rowgroup [ref=e1926]:
              - columnheader "一" [ref=e1927]
              - columnheader "二" [ref=e1928]
              - columnheader "三" [ref=e1929]
              - columnheader "四" [ref=e1930]
              - columnheader "五" [ref=e1931]
              - columnheader "六" [ref=e1932]
              - columnheader "日" [ref=e1933]
            - rowgroup [ref=e1934]:
              - row "28 29 30 1 2 3 4" [ref=e1935]:
                - cell "28" [ref=e1936]:
                  - generic [ref=e1937]: "28"
                - cell "29" [ref=e1938]:
                  - generic [ref=e1939]: "29"
                - cell "30" [ref=e1940]:
                  - generic [ref=e1941]: "30"
                - cell "1" [ref=e1942]:
                  - generic [ref=e1943]: "1"
                - cell "2" [ref=e1944]:
                  - generic [ref=e1945]: "2"
                - cell "3" [ref=e1946]:
                  - generic [ref=e1947]: "3"
                - cell "4" [ref=e1948]:
                  - generic [ref=e1949]: "4"
              - row "5 6 7 8 9 10 11" [ref=e1950]:
                - cell "5" [ref=e1951]:
                  - generic [ref=e1952]: "5"
                - cell "6" [ref=e1953]:
                  - generic [ref=e1954]: "6"
                - cell "7" [ref=e1955]:
                  - generic [ref=e1956]: "7"
                - cell "8" [ref=e1957]:
                  - generic [ref=e1958]: "8"
                - cell "9" [ref=e1959]:
                  - generic [ref=e1960]: "9"
                - cell "10" [ref=e1961]:
                  - generic [ref=e1962]: "10"
                - cell "11" [ref=e1963]:
                  - generic [ref=e1964]: "11"
              - row "12 13 14 15 16 17 18" [ref=e1965]:
                - cell "12" [ref=e1966]:
                  - generic [ref=e1967]: "12"
                - cell "13" [ref=e1968]:
                  - generic [ref=e1969]: "13"
                - cell "14" [ref=e1970]:
                  - generic [ref=e1971]: "14"
                - cell "15" [ref=e1972]:
                  - generic [ref=e1973]: "15"
                - cell "16" [ref=e1974]:
                  - generic [ref=e1975]: "16"
                - cell "17" [ref=e1976]:
                  - generic [ref=e1977]: "17"
                - cell "18" [ref=e1978]:
                  - generic [ref=e1979]: "18"
              - row "19 20 21 22 23 24 25" [ref=e1980]:
                - cell "19" [ref=e1981]:
                  - generic [ref=e1982]: "19"
                - cell "20" [ref=e1983]:
                  - generic [ref=e1984]: "20"
                - cell "21" [ref=e1985]:
                  - generic [ref=e1986]: "21"
                - cell "22" [ref=e1987]:
                  - generic [ref=e1988]: "22"
                - cell "23" [ref=e1989]:
                  - generic [ref=e1990]: "23"
                - cell "24" [ref=e1991]:
                  - generic [ref=e1992]: "24"
                - cell "25" [ref=e1993]:
                  - generic [ref=e1994]: "25"
              - row "26 27 28 29 30 31 1" [ref=e1995]:
                - cell "26" [ref=e1996]:
                  - generic [ref=e1997]: "26"
                - cell "27" [ref=e1998]:
                  - generic [ref=e1999]: "27"
                - cell "28" [ref=e2000]:
                  - generic [ref=e2001]: "28"
                - cell "29" [ref=e2002]:
                  - generic [ref=e2003]: "29"
                - cell "30" [ref=e2004]:
                  - generic [ref=e2005]: "30"
                - cell "31" [ref=e2006]:
                  - generic [ref=e2007]: "31"
                - cell "1" [ref=e2008]:
                  - generic [ref=e2009]: "1"
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test'
  2   | import type { Page } from '@playwright/test'
  3   | import { attachPageDiagnostics } from '../support/page-diagnostics'
  4   | 
  5   | const diagnostics = new WeakMap<Page, string[]>()
  6   | 
  7   | const demoRoutes = [
  8   |   { name: 'home', path: '/?theme=light' },
  9   |   {
  10  |     name: 'basic',
  11  |     path: '/?visual=basic&theme=light',
  12  |     testId: 'section-basic',
  13  |   },
  14  |   { name: 'form', path: '/?visual=form&theme=light', testId: 'section-form' },
  15  |   { name: 'data', path: '/?visual=data&theme=light', testId: 'section-data' },
  16  |   {
  17  |     name: 'navigation',
  18  |     path: '/?visual=navigation&theme=light',
  19  |     testId: 'section-navigation',
  20  |     openDropdown: true,
  21  |   },
  22  |   {
  23  |     name: 'feedback',
  24  |     path: '/?visual=feedback&theme=light',
  25  |     testId: 'section-feedback',
  26  |   },
  27  |   {
  28  |     name: 'others',
  29  |     path: '/?visual=others&theme=light',
  30  |     testId: 'section-others',
  31  |   },
  32  |   {
  33  |     name: 'icons',
  34  |     path: '/?visual=icons&theme=light',
  35  |     testId: 'section-icons',
  36  |   },
  37  |   {
  38  |     name: 'markdown-stress',
  39  |     path: '/?visual=markdown-stress&theme=light',
  40  |     testId: 'section-markdown-stress',
  41  |   },
  42  | ] as const
  43  | 
  44  | test.beforeEach(async ({ page }) => {
  45  |   diagnostics.set(page, attachPageDiagnostics(page))
  46  |   await page.emulateMedia({ reducedMotion: 'reduce' })
  47  | })
  48  | 
  49  | test.afterEach(async ({ page }) => {
> 50  |   expect(diagnostics.get(page) ?? []).toEqual([])
      |                                       ^ Error: expect(received).toEqual(expected) // deep equality
  51  | })
  52  | 
  53  | type MarkdownScrollSample = {
  54  |   scrollTop: number
  55  |   scrollHeight: number
  56  |   clientHeight: number
  57  |   section: number
  58  | }
  59  | 
  60  | const sampleMarkdownStressScroll = async (
  61  |   page: Page,
  62  |   options: { steps?: number; delta?: number; delayMs?: number } = {},
  63  | ) => {
  64  |   const { steps = 80, delta = 900, delayMs = 8 } = options
  65  | 
  66  |   return page.evaluate(
  67  |     async ({ delta, delayMs, steps }) => {
  68  |       const wrap = document.querySelector<HTMLElement>(
  69  |         '.markdown-stress-scrollbar .el-scrollbar__wrap',
  70  |       )
  71  |       const renderer = document.querySelector<HTMLElement>(
  72  |         '.markdown-stress-renderer',
  73  |       )
  74  | 
  75  |       if (!wrap || !renderer) {
  76  |         throw new Error('Markdown stress scroll internals are missing')
  77  |       }
  78  | 
  79  |       const sectionNumber = (heading: HTMLElement | undefined) =>
  80  |         Number.parseInt(
  81  |           /Stress Section\s+(\d+)/.exec(heading?.textContent || '')?.[1] || '0',
  82  |           10,
  83  |         ) || 0
  84  |       const sectionFromViewport = () => {
  85  |         const headings = Array.from(
  86  |           renderer.querySelectorAll<HTMLElement>('h1,h2,h3'),
  87  |         )
  88  |         const wrapRect = wrap.getBoundingClientRect()
  89  |         const anchorTop = wrapRect.top + 32
  90  |         let bestHeading: HTMLElement | undefined
  91  |         let bestTop = Number.NEGATIVE_INFINITY
  92  | 
  93  |         for (const heading of headings) {
  94  |           const top = heading.getBoundingClientRect().top
  95  |           if (top <= anchorTop && top > bestTop) {
  96  |             bestTop = top
  97  |             bestHeading = heading
  98  |           }
  99  |         }
  100 | 
  101 |         return sectionNumber(bestHeading ?? headings[0])
  102 |       }
  103 | 
  104 |       const waitForFrames = () =>
  105 |         new Promise<void>((resolve) => {
  106 |           requestAnimationFrame(() => resolve())
  107 |         })
  108 |       const wait = (ms: number) =>
  109 |         new Promise<void>((resolve) => setTimeout(resolve, ms))
  110 |       const samples: MarkdownScrollSample[] = []
  111 | 
  112 |       for (let index = 0; index < steps; index += 1) {
  113 |         const maxScrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight)
  114 |         wrap.scrollTop = Math.min(maxScrollTop, wrap.scrollTop + delta)
  115 |         wrap.dispatchEvent(new Event('scroll', { bubbles: true }))
  116 |         await waitForFrames()
  117 |         if (delayMs > 0) await wait(delayMs)
  118 | 
  119 |         samples.push({
  120 |           clientHeight: wrap.clientHeight,
  121 |           scrollHeight: wrap.scrollHeight,
  122 |           scrollTop: wrap.scrollTop,
  123 |           section: sectionFromViewport(),
  124 |         })
  125 |       }
  126 | 
  127 |       return samples
  128 |     },
  129 |     { delta, delayMs, steps },
  130 |   )
  131 | }
  132 | 
  133 | const expectStableForwardMarkdownScroll = (samples: MarkdownScrollSample[]) => {
  134 |   expect(samples.length).toBeGreaterThan(4)
  135 | 
  136 |   const regressions = samples
  137 |     .slice(1)
  138 |     .map((sample, index) => ({
  139 |       previous: samples[index],
  140 |       sample,
  141 |     }))
  142 |     .filter(({ previous, sample }) => {
  143 |       const scrollRegressed = sample.scrollTop < previous.scrollTop - 160
  144 |       const sectionRegressed =
  145 |         sample.section > 0 &&
  146 |         previous.section > 0 &&
  147 |         sample.section < previous.section - 3
  148 | 
  149 |       return scrollRegressed || sectionRegressed
  150 |     })
```