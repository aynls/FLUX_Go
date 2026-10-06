# LutriUI

基于 Tauri、React 和 TypeScript 的桌面图像生成与编辑工作台。支持 FLUX.3 Image、GPT Image 2.5、Qwen Image、Gemini Image（Nano Banana 2 / Pro）和 Seedream 5.0（Pro / Lite / Flash），通过 OpenRouter、BFL、Comfy、Runware 或各家官方 API 调用。

![alt text](image.png)

## 启动

支持 Windows x64、Linux x64 和 Apple Silicon Mac。

安装 Bun、Rust 及 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，然后运行：

```sh
bun install
bun run app:dev
```

## 使用

在设置中配置供应商 API Key，然后从顶部选择“生成”或“编辑”工作区，再选择模型与供应商。两个任务分别保存提示词、素材、参数和撤销记录，切换不会覆盖另一边的工作。

“生成”用于创建新画面，参考图可选；FLUX 可在构图画布中安排区域。

“编辑”先添加一张主图，再描述修改内容，其余素材可作为风格、主体或构图参考。

- FLUX 支持区域构图与编辑；GPT Image 支持部分供应商的蒙版编辑；Qwen、Gemini Image 和 Seedream 支持多图参考与文字指令。
- Google 官方使用 Gemini API Key；Seedream 官方分为火山方舟（国内）与 BytePlus（国际），密钥分别配置和保存。
- FLUX 使用鼠标右键拖拽新建包围盒，也可从已有框内部开始画新框；左键用于选择、移动和拖动手柄缩放已有框。按住空格后左键拖拽可平移视角，滚轮可缩放。
- 参数随模型与供应商变化，切回时恢复原设置；各模型家族分别保存草稿和新建默认值。
- 结果可预览、导出或继续编辑，本地历史可恢复生成配方。

`bun run dev` 仅预览界面；完整功能请运行桌面应用。模型能力与 API 差异见[架构说明](docs/architecture.md)。
