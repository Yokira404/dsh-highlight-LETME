**语言:** [English](README.md) | [简体中文](README.zh.md)
# 【插件】自动标注LetMe（dsh-plugin-letme-annotator）

一个 DSH Desktop / DeepSeek Harness 客户端插件：当助手思考过程（Think / 思考块）里出现 **let me** 时，自动在 **Think** 标签右侧标出一个红色提示 **“出现了 let me”**，并把思考文本中**每一处** `let me` 出现的位置用红色精确标出。

- 大小写不敏感：`let me`、`Let me`、`LET ME` 都会被识别。
- 同一个思考块里出现多次时显示精确计数：`出现了 let me ×2`（计数 = 该条 Think 完整思考文本中的实际出现次数）。
- **位置标注**：折叠时，可见摘要行中命中的词会被标红；展开后，完整思考正文中每一处命中都会被标红（基于 CSS Custom Highlight API；不支持时退化为整行左侧红条）。
- 思考是流式输出的：一旦流式内容中出现 `let me`，徽标立刻出现；如果内容被改写、不再包含 `let me`，徽标自动消失。
- 折叠状态下也能检测（依据会话数据而非仅凭 DOM 摘要文本），并带 DOM 文本兜底。

<img width="614" height="202" alt="屏幕截图 2026-08-20 174445" src="https://github.com/user-attachments/assets/d63b9119-5059-4760-8953-5e727e74d91d" />


## 安装（本机已自动安装）

本插件已经装入桌面配置文件（`~/.dsh/profiles/desktop`）：

1. 包目录通过 junction 链接到 `~/.dsh/profiles/node_modules/dsh-plugin-letme-annotator`（目标为本目录下的 `autoHighlight_LetMe` 文件夹）；
2. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 已加入 `dsh-plugin-letme-annotator`。

**重启 DSH Desktop 后生效**（关闭应用窗口后重新打开）。重启后，在任意会话里让模型思考，一旦思考中出现 “let me”，Think 标签右侧就会显示红色“出现了 let me”，且正文中每一处 let me 都会被标红。

## 手动安装（其他机器 / 复现）

把 `autoHighlight_LetMe` 目录作为一个 npm 包安装到桌面 profile：

```powershell
# 1. 把包链接进 profile 的依赖图（示例，路径按实际情况调整）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-plugin-letme-annotator" `
  -Target "C:\path\to\this\plugin\autoHighlight_LetMe"

# 2. 在 profile 清单里声明该 bundle
#    编辑 ~/.dsh/profiles/desktop/package.json，
#    把 "dsh-plugin-letme-annotator" 加入 dsh.profile.bundles 数组。
```

然后重启 DSH Desktop。也可在插件管理中禁用/启用（该 bundle 是可变的，可被禁用）。

## 卸载

1. 从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 移除 `dsh-plugin-letme-annotator`；
2. 删除 `~/.dsh/profiles/node_modules/dsh-plugin-letme-annotator` junction；
3. 重启 DSH Desktop。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/client.js` | 浏览器侧 bundle（lazy-CJS factory 格式，`dsh.client` 入口），实现全部标注逻辑 |
| `lib/index.js` | Host 侧加载入口（无操作，纯浏览器插件） |
| `cordis.patch.yml` | Loader patch：把本包组合为 profile 的一个 loader 条目 |
| `package.json` | `dsh.client`（platform: web）与 `dsh.bundle.patch` 声明 |
| `test/smoke.mjs` | 浏览器逻辑冒烟测试（stub DOM + 会话快照；假 DOM 会像真实浏览器一样通知 MutationObserver，覆盖卡死回归） |
| `test/compose-check.mjs` | 校验 loader patch 可被 dsh-app-boot 正确组合 |
| `test/repro-loop.mjs` | 独立复现脚本：验证协调循环能正常收敛 |

## 工作原理

- 数据源：当前会话快照中每个聊天节点的 `reasoning` 块（完整思考文本，折叠时也能拿到），匹配 `\blet me\b`（不区分大小写）。每个节点只计数一次，徽标数字与真实出现次数一致。
- 标注：在 Think 行（`[data-variant="think"]`）披露行的 **Think 标题之后**插入红色徽标 `<span class="letme-annotator-badge">出现了 let me[ ×N]</span>`；同时用 CSS Custom Highlight 把每一处命中位置标红（摘要行和展开后的正文）。
- 同步：订阅会话快照变更、会话列表变更，并用 `MutationObserver` 监听 DOM 变化（微任务合并去抖），任何一侧变化都会重新协调徽标；协调是幂等的（状态没变就不碰 DOM，避免自我触发的无限循环）；插件卸载时全部清理。

## 自定义

想改匹配词或提示文案，编辑 `lib/client.js` 顶部的常量：

```js
const PATTERNS = [/\blet me\b/giu];   // 匹配模式
const BADGE_LABEL = "出现了 let me";  // 徽标文案
```

改完保存并重启 DSH Desktop 生效。
