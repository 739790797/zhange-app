# 战鸽助手

Windows 桌面窗口，用来浏览战鸽数据。启动后整窗打开配置里的站点，默认是 `https://zhange.space`。

站点写在应用配置目录的 `config.json` 里，字段是 `site`。只保留协议和主机，例如 `https://zhange.space` 或 `http://127.0.0.1:5173`。

```bash
npm install
npm run tauri dev
```

也可以双击 `start.bat`。
