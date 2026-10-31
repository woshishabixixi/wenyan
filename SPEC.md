# SPEC — 文言文生词 · 间隔复习 PWA

> 单一契约文件。三个执行任务（A 应用本体 / B 内置词库 / C PWA 外壳）都按本文件实现，不得擅自改契约；
> 若发现契约本身有缺陷，停止实现并在报告里写明，不要自行改口径。

## 0. 硬约束

- 产物目录：`wenyan-srs/`（相对工作区根）。除本目录外不得修改任何文件。
- 纯静态：HTML + 原生 ES Modules + JSON。**禁止**任何构建步骤、包管理器依赖、框架、CDN 外链。
- 所有路径使用**相对路径**（必须能在 GitHub Pages 子路径 `/repo/` 下工作）。
- 目标浏览器：iOS Safari 16+ / Android Chrome 110+。禁止使用 iOS 不支持的 API 组合。
- 中文界面，简体。视觉风格接近扇贝：浅色背景、大字词条、底部两个大按钮。
- 无账号、无网络请求、无埋点。所有数据只在本机 IndexedDB。

## 1. 文件布局（各任务的领地，越界即违约）

```
wenyan-srs/
  SPEC.md                    (调度方)
  index.html                 (A)
  styles.css                 (A)
  app.js                     (A)
  srs.js                     (A)
  db.js                      (A)
  tests/srs.test.mjs         (A)
  data/deck.builtin.json     (B)
  tools/validate-deck.mjs    (B)
  manifest.webmanifest       (C)
  sw.js                      (C)
  icons/icon-192.png         (C)
  icons/icon-512.png         (C)
  icons/icon-maskable-512.png(C)
  tools/serve.mjs            (C)
  README.md                  (C)
```

## 2. 卡片数据模型（唯一真源）

内置词库种子文件 `data/deck.builtin.json`：

```json
{
  "version": 1,
  "name": "文言文高频词",
  "generatedAt": "2026-10-31",
  "cards": [
    {
      "id": "zou-001",
      "word": "走",
      "pinyin": "zǒu",
      "tags": ["实词", "一词多义"],
      "senses": [
        {
          "pos": "动",
          "def": "跑；逃跑",
          "example": { "text": "弃甲曳兵而走", "source": "《寡人之于国也》", "translation": "丢弃盔甲拖着兵器逃跑" }
        }
      ]
    }
  ]
}
```

字段规则：
- `id`：全局唯一，`[a-z0-9-]+`，建议 `<pinyin-slug>-` + 序号。
- `word`：非空，1–8 字符，**全库不得重复**。
- `pinyin`：带声调拼音；无把握可留空字符串（不得瞎填）。
- `tags`：字符串数组，取值建议：`实词` `虚词` `通假` `古今异义` `词类活用` `一词多义` `高频`。
- `senses`：**至少 1 条**；`def` 非空；`example` 可缺省，但**必须有出处`source`或整条缺省**，不得编造出处。
- 内容是复习材料，**释义准确优先于数量**。宁少勿错。

运行时卡片状态（IndexedDB，由 A 定义，不外泄到 deck 文件）：

```js
{ id, word, pinyin, tags, senses,           // 来自词库，只读副本
  origin: "builtin" | "custom",
  bucket: "active" | "mastered",            // mastered = 用户删除/标记已掌握
  state: "new" | "learning" | "review" | "relearning",
  step: 0,                                   // learning 阶梯下标
  ef: 2.5,                                   // 易度因子，下限 1.3
  interval: 0,                               // 天（可为小数）
  due: 0,                                    // epoch ms
  reps: 0, lapses: 0, lastGrade: null, lastReviewAt: 0,
  createdAt: 0, masteredAt: 0 }
```

## 3. 调度算法（A 实现于 srs.js，纯函数）

三档评分：`0 = 不认识`、`1 = 模糊`、`2 = 认识`。

学习阶梯 `LEARNING_STEPS = [10 / 1440, 1]`（10 分钟、1 天），毕业间隔 3 天。

- 评分 2（认识）
  - `new/learning`：`step+1`；若超出阶梯末位 → `state="review"`，`interval=3`，`due=now+3d`
  - `review`：`interval = min(interval * ef, 365)`，下限 1 天，`ef = min(ef + 0.1, 3.0)`
  - `relearning`：同 `learning`
- 评分 1（模糊）
  - 停留当前阶梯；`due = now + max(10min, interval*1.2 天)`；`ef = max(ef - 0.15, 1.3)`
  - `review` 态：`interval = max(interval * 1.2, 0.5)`
- 评分 0（不认识）
  - `step = 0`，`state="relearning"`（原为 review 时）否则 `"learning"`，`due = now + 10min`
  - 原为 `review`：`lapses+1`，`ef = max(ef - 0.2, 1.3)`，`interval = 1`
- 每次评分都要：`reps+1`、`lastGrade`、`lastReviewAt=now`。
- 导出函数（**签名固定，桌面验收会直接调用**）：
  ```js
  export const GRADES = { AGAIN: 0, HARD: 1, GOOD: 2 };
  export const LEARNING_STEPS_MIN = [10, 1440];
  export function newCardState(now) // → 上表默认值
  export function schedule(state, grade, now) // → 新 state 对象（不修改入参）
  export function isDue(state, now) // → boolean
  export function describeInterval(state) // → 人类可读，如 "10 分钟" / "3 天"
  ```

复习队列（A 实现）：`bucket==="active"` 且 `(state!=="new" && due<=now)` 的卡按 `due` 升序；
新卡取 `bucket==="active" && state==="new"`，每日上限 `dailyNewLimit`（默认 20，设置可改），
按「每 5 张旧卡插 1 张新卡」交错。当日已学新卡数记在 `meta.newDoneDate / meta.newDoneCount`。

## 4. 页面与交互（A 实现）

导航：底部 4 个 tab —— 复习 / 已掌握 / 词库 / 设置。

1) **复习页（默认）**
   - 顶部三格统计：今日待复习 x / 今日新词 y / 连续天数 z（对应扇贝截图布局）。
   - 卡片区先只显示：`word`（超大字号）、`pinyin`、一个小喇叭（可选）；下方提示「回想释义，点击空白处看提示」。
   - 点击卡片任意空白 → 展开 `senses`（词性 + 释义 + 例句 + 出处 + 译文）。
   - 展开后才出现底部三个大按钮：`不认识`（红橙）/ `模糊`（灰蓝）/ `认识`（绿）。未展开时按钮必须不可点（防手滑）。
   - 每张卡还有「太简单 · 移入已掌握」小按钮。
   - 队列空时显示「今天背完了 · 下次复习 时间」。
2) **已掌握页**：列出 `bucket==="mastered"`，每条有「恢复」按钮（恢复为 `review`，`due=now`，`interval=1`）。
3) **词库页**：搜索、列表（词 + 首义项）、新增、编辑、删除（=移入已掌握），
   以及**批量粘贴导入**：文本框，每行一条，格式 `词|拼音|词性|释义|例句|出处`（后三项可省，用 | 分隔；拼音可省留空）。
   导入时按 `word` 去重，冲突则跳过并在结果里报「跳过 N 条重复」。
4) **设置页**：每日新词上限（数字）；导出全部数据（下载 `wenyan-backup-YYYYMMDD.json`）；
   导入备份（选文件，整体覆盖前二次确认）；重置全部数据（二次确认）；显示卡片总数/已掌握数/版本。

## 5. PWA 外壳（C 实现）

- `manifest.webmanifest`：name「文言文生词」、short_name「文言」、`display: standalone`、`start_url: "./"`、`scope: "./"`、
  `theme_color`/`background_color` 与 A 的配色一致（深墨绿 #0f766e 系 / 米白 #faf7f2 系）、192/512 普通图标 + 512 maskable、`lang: "zh-CN"`。
- `sw.js`：预缓存全部应用文件（含 `data/deck.builtin.json`），cache-first 对静态资源、
  navigation 请求 fallback 到 `index.html`；版本号常量 `CACHE_VERSION`，activate 时清理旧缓存。
  **不得**缓存或拦截非本域请求（应用本身不发请求）。
- `icons/*.png`：真实 PNG（192/512 正方形 + 512 maskable 带安全边距），深墨绿底 + 白色「文言」或「文」字，
  由脚本生成（Node 手写 PNG 编码或用 Python/Pillow，二者本机都有；不得引入 npm 依赖）。把生成脚本留在 `tools/make-icons.mjs`。
- `tools/serve.mjs`：零依赖 Node 静态服务器，`node tools/serve.mjs` 默认 `http://127.0.0.1:8787`，
  正确 MIME（html/css/js/json/webmanifest/png），带 `Cache-Control: no-store`，`/index.html` 兜底。
- `README.md`（中文，给非程序员看）：本地预览 → GitHub Pages 部署（含子路径说明）→ Cloudflare Pages 备选 →
  iPhone/安卓「添加到主屏幕」步骤 → 备份与换机。命令必须实测可跑。

## 6. 验收（调度方执行，非执行方自证）

- `node tests/srs.test.mjs` 全绿；
- `node tools/validate-deck.mjs` 报告卡片数 / 重复数 0 / 缺释义 0；
- `node tools/serve.mjs` 起服务，用真实 Chromium 走完整流程：首次进入 → 看词 → 展开 → 点「认识」→ 下一张 →
  刷新页面进度仍在 → 删一张词 → 已掌握页能找回 → 导出 JSON 内容非空；
- Lighthouse 式人工检查：离线（断网刷新）能加载；`manifest` 可被解析。

## 7. 交付纪律

- 只改自己领地的文件；不要 `git init`、不要装依赖、不要跑长时间构建。
- 报告必须含：改了哪些文件（路径 + 字节数）、跑了哪些命令及其关键输出、未完成项与已知风险。
- 遇到契约不足：**不要自行加功能**，在报告里列出「契约缺口 + 你的临时处理」。
