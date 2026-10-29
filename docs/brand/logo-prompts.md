# 寻迹 · Logo 生成提示词

## 当前状态：已定稿（2026-10-27）

毛笔「寻」字形已上线：墨色主体 + 第三横朱砂点睛。
矢量资产见 `web/client/public/brand/`、`web/site/assets/brand/`，favicon 见 `web/client/public/favicon.svg`、`web/site/favicon.svg`。
client 顶栏与登录页用内联 JSX SVG（`web/client/src/components/BrandLogo.jsx`），官网顶栏页脚用内联 `<svg>`。

> 下方提示词保留作历史方案与后续换形参考。要改形时优先走「位图 → 自研矢量化管线」，
> 而不是重新用 AI 出图：几何化的图形（圆点、环、锥形笔画）没有人味，
> 中式 logo 的难点在笔法（提按、起收笔、连带、飞白）。

## 用法

1. 用下面的方向 prompt 出形（每次 4–8 张挑形）
2. 挑中后把图发回，做矢量重绘 → SVG → 三件套（主色 / 单色 / 反白）
3. 落地到官网顶栏页脚、client 顶栏、favicon

**注意**：AI 出的位图不能直接上线。放大到 16px favicon 会糊，必须重绘成 SVG 路径。

## 品牌底料

| 角色 | 色值 |
|---|---|
| 墨（主） | `#2b2822` |
| 朱砂（点缀） | `#b0402f` |
| 宣纸（底） | `#f3efe4` |

设计概念「朱批」：中式校注传统里，先生朱笔旁批，学生在正文上改 —— 对应产品里「AI 在稿纸上批注」这件事。

禁用方向：方形印章框、边框包围（第一版「寻」朱砂印章已被用户否决）、3D 质感、渐变。

## 通用风格约束（每条必拼）

```
flat vector logo, single centered mark, solid fills only, no gradients, no shadows, no 3D, clean silhouette, strong negative space, minimal, logo on plain warm off-white background, high contrast, professional Chinese brand identity
```

## 通用负向词

```
text, letters, words, watermark, 3d render, gradient, drop shadow, glossy, metallic, photo, realistic, cartoon, busy, cluttered, multiple objects, square seal frame, border, rectangle badge, rounded app icon container, stock logo template
```

## 方向 A · 朱批

朱笔在稿纸边缘落下一笔批注，抽象成图形。

```
A minimalist Chinese calligraphy logo mark: a single vermilion red brush stroke (#b0402f) making a swift upward flick that crosses a small ink black (#2b2822) horizontal stroke, as if a red pen annotated a line of manuscript in the margin. Visible brush tip taper, dry brush streaks only inside the stroke shape itself, never as background noise. Flat vector logo, single centered mark, solid fills only, on plain warm off-white paper (#f3efe4), clean silhouette, strong negative space, refined modern Chinese publishing house identity
```

## 方向 B · 墨迹

```
Minimalist Chinese calligraphy logo: one continuous brush stroke in ink black (#2b2822) that begins thick and wet then dries into a thin slightly frayed tail, arcing gently upward, the trace a brush leaves on rice paper. One small vermilion red (#b0402f) ink drop at the head of the stroke. Flat vector logo, solid fills only, single centered mark on plain warm off-white (#f3efe4), clean silhouette, no gradients, no shadow, no 3D, generous negative space, refined editorial identity
```

## 方向 C · 单字化「寻」

```
Minimalist logo mark derived from the single Chinese character 寻, reduced to three essential brush strokes and rearranged into a compact vertical glyph, ink black (#2b2822) with one vermilion red (#b0402f) accent stroke, calligraphic brush terminals, recognizably brush written but geometrically simplified. Flat vector, solid fills, single centered mark on plain warm off-white (#f3efe4), absolutely no square seal frame, no enclosing border, clean negative space, modern Chinese brand identity
```

## 方向 D · 毛笔字标「寻迹」

负向词要**去掉** `text, letters, words`，否则出不来汉字。

```
Chinese calligraphy wordmark of the two characters 寻迹 in expressive semi cursive running script, genuine brush texture: thick to thin pressure variation, visible starting stops and hooks, slight dry brush streaks, natural asymmetry, ink black (#2b2822) on plain warm off-white rice paper (#f3efe4). Two characters side by side, left to right, generous spacing, no frame, no seal, no red stamp, no other marks. Elegant, literary, high resolution calligraphy
```

## 短版（一句话）

```
minimalist Chinese calligraphy logo, single vermilion brush stroke over ink black mark, rice paper background, flat vector, solid color, no text, no frame, no shadow
```

## 第一轮：纯剪影挑形

先别上色，用这个把形状挑对：

```
solid black silhouette of a single Chinese brush stroke logo, pure flat black on white, no color, no detail, shape study, centered
```

## 技术参数

| 项 | 值 |
|---|---|
| 尺寸 | 1:1，1024×1024 |
| 迭代 | 30–50 |
| Guidance | 6.5–8 |
| 每次出图 | 4–8 张 |

## 落地检查清单

- [ ] 主色版（墨 + 朱砂）
- [ ] 单色版（全墨，给 favicon / 单色印刷）
- [ ] 反白版（深色背景用纸色）
- [ ] 16px favicon 下仍可辨
- [ ] 深浅主题各验证一次
- [ ] SVG 路径，无位图依赖
