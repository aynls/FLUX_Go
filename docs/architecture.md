# 模型、供应商与工作区

LutriUI 将模型契约、工作区和供应商传输分开。新增模型时，先定义它能接收的输入和参数，再配置路由与界面。API Key、HTTP 请求和结果图片处理由 Rust 后端负责。

## 模块边界

| 位置                        | 职责                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `shared/model-catalog.json` | 前后端共用的模型目录：家族、版本、供应商模型编号、参数规则、参考图上限、蒙版能力和文档来源          |
| `src/models/`               | 参数投影、模型校验和请求编译；FLUX 协议位于 `flux/protocol.ts`                                      |
| `src/workspaces/`           | 按家族注册的参数侧栏与工作区；通用控件和素材列表位于 `shared/`                                      |
| `src/app/useWorkspace.ts`   | 草稿、家族切换、撤销、偏好和持久化                                                                  |
| `src/app/generation.ts`     | 输入处理、生成快照、结果和历史材料组装                                                              |
| `src/components/`           | 画布、历史、设置、结果展示等通用交互                                                                |
| `src-tauri/src/models.rs`   | 读取同一模型目录，校验每个付费请求的路由、字段和输入约束                                            |
| `src-tauri/src/provider/`   | 四个供应商的原生请求、鉴权、轮询和结果处理；凭据与共享传输分别位于 `credentials.rs`、`transport.rs` |

`Draft` 保存规范模型编号 `modelId`，供应商原生编号放在路由目录中。`routeSettings` 按模型和供应商保存参数；切回时恢复原设置，新路由会投影共享参数并显示调整摘要。发送时只使用当前路由白名单中的字段。切换到不支持蒙版的路由时，保留蒙版并阻止提交，供用户切回或移除。供应商不会自动切换。

## 已接入的组合

| 系列          | 版本            | 供应商                          |
| ------------- | --------------- | ------------------------------- |
| FLUX.3 Image  | FLUX.3 Image    | OpenRouter、BFL、Comfy、Runware |
| GPT Image 2.5 | Flare、Sunburst | OpenRouter、Comfy、Runware      |
| Qwen Image    | 3.0、3.0 Pro    | OpenRouter、Comfy、Runware      |

目录于 2026-10-06 根据公开 API 资料核对。账户权限、价格与供应商后续变更仍以供应商实际响应为准。

## 工作区与 API 差异

FLUX 工作区保留参考图、来源区域和输出区域。BFL、Comfy 与 OpenRouter 将区域协议附在提示词中；Runware 使用 `settings.boundingBoxes`，单独发送不含区域 JSON 的指令。Runware 的 FLUX 文生图需要至少一个放置区域；指定分辨率和比例时，适配器使用文档中的尺寸表，有参考图且比例为 `auto` 时使用分辨率预设。四个供应商的 FLUX 内容审核容忍度均限制为 0–4，0 最严格。Runware 还开放 PNG/JPEG/WebP 与 20–99 的压缩质量；PNG 不发送压缩质量。[BFL 文档](https://docs.bfl.ai/flux_3/flux3_image_overview)、[Runware 文档](https://runware.ai/docs/models/bfl-flux-3-image)。

GPT Image 工作区使用主图、参考图列表、质量、背景和输出格式。Comfy 与 Runware 支持自定义尺寸和蒙版；OpenRouter 当前路由使用宽高比，暂未开放蒙版和任意尺寸。内部蒙版使用透明 PNG，完全透明区域用于编辑，尺寸与第一张参考图一致；Runware 适配器转换为白色编辑、黑色保留的蒙版。参考图与蒙版按同一比例缩放。尺寸、透明背景与 JPEG 的冲突在提交前校验。[OpenAI 文档](https://developers.openai.com/api/docs/guides/image-generation)、[Comfy schema](https://docs.comfy.org/router-schemas/openai/gpt-image-2.5-flare.json)、[Runware 文档](https://runware.ai/docs/models/openai-gpt-image-2-5-flare)。

Qwen 工作区使用有序参考图和文字指令，支持 3.0 与 3.0 Pro。OpenRouter 路由开放分辨率、宽高比、种子与张数，参考图上限为 4；Comfy 和 Runware 使用像素尺寸、负面提示词和扩写控制，参考图上限为 3。Comfy 将尺寸编码为 `宽*高`；选择自动尺寸时省略该字段，并对 Pro 显示费用区间。Runware 使用独立宽高字段，并开放输出格式与压缩质量。有参考图时只支持 `direct` 扩写，关闭扩写时省略扩写方式。[OpenRouter 路由](https://openrouter.ai/api/v1/images/models/qwen/qwen-image-3/endpoints)、[Comfy schema](https://docs.comfy.org/router-schemas/qwen/qwen-image-3.0.json)、[Runware 文档](https://runware.ai/docs/models/alibaba-qwen-image-3-0)。

## 任务与参考素材

任务模式区分生成新画面与编辑图片。编辑主图始终排在请求的第一位，供自动比例、GPT 蒙版和结果对照使用。指定新主图时，程序同步重排素材并重映射提示词中的精确图片标签；已有蒙版时阻止更换主图，避免把蒙版作用于另一张图片。

参考素材可指定风格、主体、构图或自定义用途。`models/referenceInstructions.ts` 将用途和任务模式编译成生成指令，供应商请求不增加未支持的角色字段。历史配方保存 `intent`、素材用途、用途说明和路由参数。旧草稿的 `baseId` 仅用于显示底图；迁移保留原请求顺序与原提示词，直到用户明确设置任务模式或用途。

FLUX 主图等比显示。移除区域保留虚线标记；选中区域时显示来源素材，并可进入来源区域编辑。来源标记的显示与拖动计入主图留白，发送时仍使用各自独立的来源与输出坐标。构图画布尺寸不承诺 API 返回的精确像素尺寸。

偏好设置将 API 连接、新建默认值、外观和存储分开。每个家族可保存默认模型、供应商及对应参数，仅在新建方案时使用。设置标题、关闭按钮与历史返回入口保持可见。动画只用于状态转换与任务活动提示，遵循减少动态效果的系统偏好。

## 生成与存储

生成先捕获当前草稿快照，处理输入，再提交一次付费请求。OpenRouter 同步返回结果；BFL、Comfy 和 Runware 提交后读取任务状态。Comfy 发送幂等键并遵循 `Retry-After`；Runware 以任务 UUID 轮询，并按图片标识去重。网络失败不会自动重新生成。后端互斥标记与前端提交锁防止重复提交。

`generation-progress` 事件按 `requestId` 关联任务，显示准备、提交、等待、供应商已报告的生成阶段、下载和保存。事件通过 Rust 任务局部回调传递，前端只监听当前请求并在结束时释放监听器。应用不推测未返回的百分比。等待期间可以继续操作其他工作区；关闭应用前提示远程任务可能继续计费，用户可以继续等待或关闭。

多个结果保存在同一历史记录中，可逐张浏览和导出。参考图、输出图片和蒙版保存为本地文件，历史配方保存模型、供应商、参数、区域、参考图顺序与压缩设置。Comfy Credits 单独保留，不当作美元展示。历史保存失败时，结果仍可使用，并可重新保存而不触发生图。

所有工作区共用左侧提示词、中央画布、右侧参考素材的布局。蒙版在原图像素空间绘制，画笔清除 alpha、橡皮恢复不透明像素；每次笔划结束保存一张 PNG，并作为一次撤销操作。矩形和导入蒙版可与笔划叠加。

Comfy 预估独立保存在 `shared/comfy-pricing.json`，记录核验日期与官方来源。FLUX 使用分辨率价格，Qwen 使用输出张数、Pro 面积档位和参考图数量，GPT 使用质量和尺寸的官方预估区间并估算输入费用。预估不作为扣费凭据。实际 Credits 从最终响应头 `X-Comfy-Credits-Used` 读取；上游响应体的 `cost` 不代表 Comfy 扣费，缺少该响应头时显示未返回。[Comfy 响应头说明](https://docs.comfy.org/development/comfy-router/reference#response-headers)。

草稿使用 `WorkspaceSession` 保存三个家族的独立 `Draft`。旧版 schema 2 的 FLUX 草稿迁移到 schema 3；无法识别的版本或损坏内容暂停自动保存，保留原文件。新建方案可恢复保存。

每个家族进一步拆分生成和编辑任务。`taskWorkspaces` 按 `family:intent` 保存独立草稿，`workspaces` 保留各家族最近活动的任务，用于恢复入口和读取此前的单任务会话。撤销记录、结果选择和本会话最近 20 次尝试按相同任务键隔离；结果原图来自请求快照，后台完成只更新发起任务的结果。任务切换属于导航，替换编辑主图属于可撤销修改。重启恢复草稿，完整结果通过本地历史查看。

桌面应用标识与系统凭据命名空间使用 `app.lutriui.desktop`，前端设置键使用 `lutriui-preferences-v2`，导出文件名前缀使用 `lutriui-`。改名后使用新的本地数据目录和凭据，不读取或迁移旧标识下的数据。

## 新增模型或供应商

1. 在 `shared/model-catalog.json` 中添加模型版本、已确认的供应商路由和能力规则。模型编号使用应用内规范编号，供应商编号放入各自路由。
2. 为新的参数扩展 TypeScript `GenerateParams` 和 Rust `GenerateParams`。在模型模块中添加组合约束，在供应商适配器中添加原生字段映射与响应处理。
3. 新增家族时，扩展 `FamilyId`，提供独立工作区，并在 `src/workspaces/index.tsx` 中注册。只有操作语义相同的部分才复用通用控件。
4. 新增供应商时，添加凭据来源、状态与连接检查，在 `provider::dispatch` 中注册适配器，并将相应路由加入目录。
5. 补充模型契约与交互测试。运行 `bun test`、`bun run build`、`cargo test --manifest-path src-tauri/Cargo.toml`，再构建桌面应用。

自动验证覆盖参数投影、路由往返恢复、家族默认值、旧草稿迁移、区域坐标与留白、蒙版转换、多张结果和本地 HTTP 模拟。隔离浏览器使用本地测试替身验证主图切换、用途编译、移除区域、任务阶段、历史大图以及 1024×640 窗口中的固定导航；这些验证不调用付费 API。此前真实调用验证过 Runware Qwen 3.0 和 Comfy GPT Image 2.5 Flare，本轮交互优化未新增付费验证。本机桌面拖拽尚未验证。
