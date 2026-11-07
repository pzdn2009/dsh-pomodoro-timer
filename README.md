# 番茄时钟 · Pomodoro timer

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的悬浮番茄计时器插件。它注册在 `shell.overlay`（窗口级浮层）里，因此切换会话、打开设置面板、切换主题时都不会被卸载。

- 专注 25 分钟 → 短休息 5 分钟，每完成 4 个专注进入一次长休息 15 分钟
- 圆环进度、今日完成数、阶段提示
- 每个阶段结束自动播放 **2 分钟轻音乐**（WebAudio 实时合成，仓库里没有音频文件，也不依赖外部音源），可随时停止
- 时长可调（专注 5–120 分钟，休息 1–60 分钟），可开关「自动开始下一段」与提示音
- 计时基于绝对截止时间，后台标签页节流、刷新页面、重启应用都不影响准确性；状态保存在 `localStorage`
- 只使用宿主主题 token，自动跟随浅色/深色主题；中英文随界面语言切换

## 安装

需要已经装好 DeepSeek Harness（插件面向 `dsh 0.2.x` 的插件 manifest 与 slot API）。

```sh
git clone https://github.com/pzdn2009/dsh-pomodoro-timer.git ~/dsh-pomodoro-timer
```

然后在 Harness 的对话里让 agent 用绝对路径安装这个目录，例如：

> 用 plugin_manager 安装 `/Users/<you>/dsh-pomodoro-timer`

安装成功后窗口右下角会出现番茄色胶囊；没有出现就刷新一次页面。

## 使用

- 窗口**右上角**的胶囊显示剩余时间，点击展开计时卡片（卡片向下展开，不会盖住胶囊）。
- 卡片里的按钮：开始 / 暂停 / 继续、重置当前阶段、跳到下一阶段。
- 阶段结束时弹出提示条并播放 2 分钟轻音乐，胶囊下方会出现「轻音乐播放中 · 停止」的横条；「自动开始下一段」打开时直接进入下一段。
- 卡片头部进入设置：调整专注与休息时长，开关自动开始和阶段结束的轻音乐。
- 按 `Esc` 收起卡片。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 清单：`dsh.bundle.patch` 与 `dsh.client`（`platform: web`, `immediately: true`） |
| `cordis.patch.yml` | 插入 `pomodoro-timer` 插件行 |
| `index.js` | Host 半边（空 `apply`，计时器完全运行在浏览器中） |
| `client.js` | 计时器状态机、`shell.overlay` 槽注册、React 组件与样式、WebAudio 轻音乐合成 |
| `locale/en.json`、`locale/zh.json` | 插件管理器读取的标题与描述 |
| `icon.svg` | 原创图标 |

样式只使用宿主主题 token（`--dsw-alias-*`），界面文字通过 `ctx.locale` 注册的中英文字典渲染。包本身没有任何运行时依赖，也不包含 Harness 源码。

## 开发

改完 `client.js` 后重新安装同一目录即可生效：

1. 让 agent 重新执行 `plugin_manager` 的 `install_bundle`，目标仍是这个目录；
2. 若界面没有变化，刷新页面。

## 许可

MIT，见 [LICENSE](LICENSE)。
