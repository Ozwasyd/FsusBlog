# Button

A common action button.

## Public Preview

This is a preview public component. See [API stability](../api-stability.md#stability-levels)
for the change policy. Icon-only buttons require `aria-label`,
`aria-labelledby`, or `title`; dangerous actions need text that does not rely
on color alone. Primary colors use `--fsus-button-primary-bg` and
`--fsus-button-primary-text`, while general interaction color uses
`--el-color-primary`; see the [theme token contract](../theme/tokens.md).

`type="text"` is deprecated. When `tag` renders a non-button element, the
consumer must supply equivalent keyboard and disabled semantics.

> See the [Playground](../playground.md) for runnable component examples.

---

## Basic Usage

Use `type`, `plain`, `round`, `dashed`, and `circle` to define the button style.

## Disabled State

Use `disabled` to control whether the button is disabled; it accepts a Boolean.

## Link Button

> **Deprecated:** `type="text"` will be removed in 3.0.0. Use the `link` prop (new API).

## Text Button

Set `text: true` for a text button (no border or background). Set `bg: true` to keep its background visible.

## Icon Buttons

Use `icon` to add an icon; use an icon alone to save space or combine it with text.

## Button Group

Use `<el-button-group>` to combine buttons. Set `direction` to `horizontal` or `vertical`.

## Loading State

Set `loading` to `true` to enter the loading state. Customize the loading icon with the `loading` slot or `loadingIcon` (the slot takes precedence).

## Sizes

Buttons support `large`, `default`, and `small` sizes.

## Custom Colors

Use `color` to customize the button color; FsusUI derives hover and active colors. `color` also applies to `link` and `text` buttons.

> FsusUI's default primary color is **Scholarly Blue `#2A599C`**. On hover, a Primary button switches from Ink Black `#0F0F11` to this color.

---

## Button API

### Button Attributes

| 属性名            | 说明                                              | 类型                                                                     | 默认值    |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------ | --------- |
| size              | 按钮尺寸                                          | `'large' \| 'default' \| 'small'`                                        | —         |
| type              | 按钮类型                                          | `'default' \| 'primary' \| 'success' \| 'warning' \| 'danger' \| 'info'` | —         |
| plain             | 是否为朴素按钮                                    | `boolean`                                                                | `false`   |
| text              | 是否为文字按钮                                    | `boolean`                                                                | `false`   |
| bg                | 文字按钮是否始终显示背景色                        | `boolean`                                                                | `false`   |
| link              | 是否为链接按钮                                    | `boolean`                                                                | `false`   |
| round             | 是否为圆角按钮                                    | `boolean`                                                                | `false`   |
| circle            | 是否为圆形按钮                                    | `boolean`                                                                | `false`   |
| dashed            | 是否为虚线按钮                                    | `boolean`                                                                | `false`   |
| loading           | 是否加载中                                        | `boolean`                                                                | `false`   |
| loading-icon      | 自定义加载图标组件                                | `string \| Component`                                                    | `Loading` |
| disabled          | 是否禁用                                          | `boolean`                                                                | `false`   |
| icon              | 图标组件                                          | `string \| Component`                                                    | —         |
| autofocus         | 原生 `autofocus` 属性                             | `boolean`                                                                | `false`   |
| native-type       | 原生 `type` 属性                                  | `'button' \| 'submit' \| 'reset'`                                        | `button`  |
| auto-insert-space | 两个汉字之间是否自动插入空格（仅 2 个汉字时生效） | `boolean`                                                                | `false`   |
| color             | 自定义按钮颜色，自动计算 hover/active 色          | `string`                                                                 | —         |
| dark              | 暗色模式，将 `color` 自动转换为暗色模式颜色       | `boolean`                                                                | `false`   |
| tag               | 自定义元素标签                                    | `string \| Component`                                                    | `button`  |

### Button Slots

| 插槽名  | 说明               |
| ------- | ------------------ |
| default | 自定义默认内容     |
| loading | 自定义加载图标组件 |
| icon    | 自定义图标组件     |

### Button Exposes

| 名称           | 说明           | 类型                                                                                        |
| -------------- | -------------- | ------------------------------------------------------------------------------------------- |
| ref            | 按钮 HTML 元素 | `Ref<HTMLButtonElement>`                                                                    |
| size           | 按钮尺寸       | `ComputedRef<'' \| 'small' \| 'default' \| 'large'>`                                        |
| type           | 按钮类型       | `ComputedRef<'' \| 'default' \| 'primary' \| 'success' \| 'warning' \| 'info' \| 'danger'>` |
| disabled       | 是否禁用       | `ComputedRef<boolean>`                                                                      |
| shouldAddSpace | 是否添加空格   | `ComputedRef<boolean>`                                                                      |

---

## ButtonGroup API

### ButtonGroup Attributes

| 属性名    | 说明                       | 类型                                                        | 默认值       |
| --------- | -------------------------- | ----------------------------------------------------------- | ------------ |
| size      | 统一设置按钮组中按钮的尺寸 | `'large' \| 'default' \| 'small'`                           | —            |
| type      | 统一设置按钮组中按钮的类型 | `'primary' \| 'success' \| 'warning' \| 'danger' \| 'info'` | —            |
| direction | 排列方向                   | `'horizontal' \| 'vertical'`                                | `horizontal` |

### ButtonGroup Slots

| 插槽名  | 说明             | 子标签 |
| ------- | ---------------- | ------ |
| default | 自定义按钮组内容 | Button |
