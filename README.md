# FLUX_Go

基于 Tauri、React 和 TypeScript 的桌面图像生成与编辑工作台，支持 FLUX.3 Image、GPT Image 2.5（Flare / Sunburst）和 Qwen Image（3.0 / 3.0 Pro）。可通过 OpenRouter、BFL、Comfy 或 Runware 调用供应商支持的模型，提供独立工作区、参考图、区域编辑或蒙版、图片导出和本地历史。

## 启动

安装 Bun、Rust 及 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，然后运行：

```sh
bun install
bun run app:dev
```

## 使用

在设置中配置 API Key，可手动填写或指定环境变量，默认名称为 `OPENROUTER_API_KEY`、`BFL_API_KEY`、`COMFY_API_KEY`、`RUNWARE_API_KEY`。手动密钥保存到系统凭据存储。

在顶部选择模型家族，再选择模型版本与提供商。FLUX 使用参考图和区域画布；GPT Image 使用质量、尺寸、背景与可选蒙版；Qwen 使用有序参考图、文字指令和生成控制。控件与输入上限随路由变化，BFL 仅支持 FLUX，Comfy 使用 Comfy Router 与 Comfy Credits。

各家族草稿分别保存。生成结果可以逐张查看、保存、复制或继续编辑，历史可恢复模型、供应商、参数、参考图和蒙版。`bun run dev` 可预览界面；调用 API、读取本地文件和保存历史需要桌面应用。

提示词在左侧编辑，参考素材统一放在右侧。GPT 蒙版支持矩形、画笔、橡皮和 PNG 导入，画笔与橡皮半径可在 1–256 原图像素之间调整。Comfy 在生成前显示 Credits 预估，结果与历史显示 API 返回的实际 Credits；未返回时明确标注。
