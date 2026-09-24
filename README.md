# 战鸽助手

Windows 桌面壳。用系统 WebView 打开战鸽数据，默认站点是 `https://zhange.space`，可在左侧「站点」里改成其它地址（只保留协议和主机，例如本机开发的 `http://127.0.0.1:5173`）。

页面地址会带上 `embed=assistant`。本机能力挂在 `window.zhangeAssistant` 上：塔科夫截图/日志目录，以及屏幕伽马和明暗。游戏进行中用 `Ctrl+Alt+G` 切换，退出助手时恢复原来的伽马。

本机能力目前只对 `zhange.space` 和本机 `localhost` / `127.0.0.1` 开放。换到其它域名时仍能浏览，但页面里调不到读盘和伽马。

```bash
npm install
npm run tauri dev
```
