# 项目说明

LutriUI 是基于 Tauri、React、TypeScript 和 Rust 的桌面图像生成与编辑工作台，支持 FLUX.3 Image、GPT Image 2.5、Qwen Image、Gemini Image（Nano Banana 2.1 / 2 / Pro）和 Seedream 5.0（Pro / Lite / Flash）。供应商包括 OpenRouter、BFL、Comfy、Runware、Google、火山方舟与 BytePlus，各路由能力独立，计划开源。

使用说明见 [README.md](README.md)，模型能力、API 差异与模块边界见 [docs/architecture.md](docs/architecture.md)。FLUX 官方文档：[FLUX.3 Image](https://docs.bfl.ai/flux_3/flux3_image_overview)。其他路由的文档来源记录在 `shared/model-catalog.json`。

# 开发约定

`shared/model-catalog.json` 是前后端共用的模型契约。`src/models/` 负责校验与请求编译，`src/workspaces/` 负责各家族交互，`src-tauri/src/provider/` 负责鉴权、原生请求和结果处理。新增能力时核对对应供应商文档，同步目录、前后端映射及文档。

- 明确区分生成新画面、编辑主图和参考用途。编辑主图排在请求第一位；重排时同步精确图片标签，避免将已有蒙版作用于另一张图片。参考用途编译为提示词，不添加供应商未支持的字段。
- 各家族草稿独立保存，模型与供应商切回后恢复各自参数。请求只发送当前路由支持的字段；旧草稿迁移保留原请求语义，草稿损坏时保留原文件。
- 保持控件简洁、术语统一，返回和关闭入口持续可见。说明文字只解释必要约束；动画遵循系统减少动态效果的偏好。模型图标使用 `public/` 中的现有素材并适配明暗主题。
- 生成使用不可变快照，避免重复提交；进度只展示本地阶段和供应商实际报告的状态。结果继续编辑、参数切换及画布操作应可撤销。

# 验证

使用 Bun 管理前端。运行 `bun run app:dev` 启动桌面应用，`bun run dev` 仅用于界面预览。按改动范围运行 `bun test`、`bun run build` 和 `cargo test --manifest-path src-tauri/Cargo.toml`；需要检查桌面构建时运行 `bun run tauri build --no-bundle`。验证报告区分自动测试、模拟请求、真实 API 调用与桌面实测。
