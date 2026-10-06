# FLUX_Go

基于 Tauri、React 和 TypeScript 的桌面图像生成与编辑工作台。支持 FLUX.3 Image、GPT Image 2.5（Flare / Sunburst）和 Qwen Image（3.0 / 3.0 Pro），通过 OpenRouter、BFL、Comfy 或 Runware 调用对应模型。

## 启动

安装 Bun、Rust 及 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，然后运行：

```sh
bun install
bun run app:dev
```

## 使用

在设置中配置供应商 API Key，选择模型与供应商，再选择生成新画面或编辑图片。编辑时指定主图，其余素材可作为风格、主体或构图参考。

- FLUX 支持区域构图与编辑；GPT Image 支持部分供应商的蒙版编辑；Qwen 支持多图参考与文字指令。
- 参数随模型与供应商变化，切回时恢复原设置；各模型家族分别保存草稿和新建默认值。
- 结果可预览、导出或继续编辑，本地历史可恢复生成配方。

`bun run dev` 仅预览界面；完整功能请运行桌面应用。模型能力与 API 差异见[架构说明](docs/architecture.md)。
