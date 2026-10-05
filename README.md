# FLUX_Go

基于 Tauri、React 和 TypeScript 的桌面图像生成与编辑工作台，支持通过 BFL 或 OpenRouter 使用 FLUX.3 Image。

支持多张参考图、包围盒布局与区域编辑、结果导出、本地历史和草稿恢复。计划扩展更多模型家族。

## 开发与打包

准备 Bun 和 Rust。Windows 需要 MSVC 工具链和 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要 WebKitGTK 等系统依赖，见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/)。

```sh
bun install
bun run app:dev
```

运行 `bun run app:build` 打包。Tauri 自动合并当前系统的 `tauri.windows.conf.json`、`tauri.macos.conf.json` 或 `tauri.linux.conf.json`。程序和安装包位于 `src-tauri/target/release/`。

| 平台 | 打包格式 |
| --- | --- |
| Windows x64 | NSIS `.exe` 安装包 |
| macOS Apple Silicon / Intel | `.app`、`.dmg` |
| Linux x64 | `.deb`、`.AppImage` |

## GitHub Actions 打包

提交并推送 `.github/workflows/build.yml` 和平台配置后，在 GitHub 仓库的 **Actions → Build desktop packages → Run workflow** 手动启动。工作流会分别构建上述四种架构；完成后，在该次运行页面的 **Artifacts** 下载对应平台的压缩包。工作流不创建 GitHub Release。

CI 固定使用 Bun 1.4.2，通过 `bun.lock` 和 `src-tauri/Cargo.lock` 锁定依赖；修改依赖时需同步提交锁文件。构建不需要 BFL 或 OpenRouter API Key，使用应用时再在设置中配置。

macOS 当前使用 ad-hoc 签名，仅用于下载验收，没有 Apple Developer ID 签名或公证。Windows 当前没有代码签名。正式分发时需另行配置签名，见 [macOS 签名说明](https://v2.tauri.app/distribute/sign/macos/) 和 [Windows 签名说明](https://v2.tauri.app/distribute/sign/windows/)。打包成功后仍需在目标系统验证 API Key 存储、文件选择、图片保存和历史记录。

## 使用

在设置中配置提供商 API Key，输入提示词，按需添加参考图和编辑区域，然后生成图片。结果可以另存为、复制或继续编辑。

手动填写的密钥保存在系统凭据存储中；也可使用 `BFL_API_KEY` 或 `OPENROUTER_API_KEY` 环境变量。
