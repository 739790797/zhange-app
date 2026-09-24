# 战鸽助手

Windows 桌面助手，登录 [战鸽](https://zhange.space) 账号后使用。主菜单有战鸽酒馆和逃离塔科夫。

塔科夫里可以综合搜索、看实时地图、管理任务、开私人房间和队友同步任务进度，也可以把地图做成覆盖层。妙妙工具里有屏幕色彩、健身计时、游戏目录绑定和历史任务回填。日志监控会在游戏运行时读取本机日志，用来切图、识别 PVP / PVE、提示战局开始，并把任务状态写回账号。

日志原文留在本机。历史同步和实时监控只把解析出的任务状态发给战鸽。

覆盖层快捷键默认是 `M`，并且只在自己还留在房间里时生效。在输入框里打字时不会触发。调节屏幕色彩和健身计时需要管理员权限，程序清单里已经声明。

配置写在 `%APPDATA%\space.zhange.app\`：

| 文件 | 内容 |
| --- | --- |
| `session.json` | 登录会话 |
| `paths.json` | 截图目录、日志目录 |
| `overlay.json` | 地图覆盖层 |
| `miaomiao.json` | 视觉方案和健身延迟 |

```bash
npm install
npm run tauri dev
```

也可以双击 `start.bat`。

推送 `v*` 标签后，GitHub Actions 会打出 `zhange-app-x64.exe` 和 `zhange-app-x86.exe`，并挂到同名 Release。在 Actions 页手动运行 `build` 时，用 `src-tauri/tauri.conf.json` 里的版本号发布。
