# FLUX_Go

基于 Tauri、React 和 TypeScript 的桌面图像生成与编辑工作台，通过 BFL 或 OpenRouter 使用 FLUX.3 Image，支持多张参考图、包围盒编辑、图片导出和本地历史。

## 启动

安装 Bun、Rust 及 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，然后运行：

```sh
bun install
bun run app:dev
```

## 使用

在设置中选择提供商并配置 API Key，可手动填写或指定环境变量（默认 `BFL_API_KEY` / `OPENROUTER_API_KEY`）。输入提示词，按需添加参考图、绘制包围盒并调整输出参数，然后生成图片。结果可保存、复制或继续编辑，也可从历史记录恢复方案。
