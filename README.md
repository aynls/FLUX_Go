# FLUX_Go

基于 Tauri、React 和 TypeScript 的桌面图像生成与编辑工作台，支持通过 BFL 或 OpenRouter 使用 FLUX.3 Image。

支持多张参考图、包围盒布局与区域编辑、结果导出、本地历史和草稿恢复。计划扩展更多模型家族。

## 开发与打包

准备 Bun、Rust MSVC 工具链和 WebView2。

```sh
bun install
bun run app:dev
```

运行 `bun run app:build` 打包。程序和安装包位于 `src-tauri/target/release/`。

## 使用

在设置中配置提供商 API Key，输入提示词，按需添加参考图和编辑区域，然后生成图片。结果可以另存为、复制或继续编辑。

手动填写的密钥保存在系统凭据存储中；也可使用 `BFL_API_KEY` 或 `OPENROUTER_API_KEY` 环境变量。
