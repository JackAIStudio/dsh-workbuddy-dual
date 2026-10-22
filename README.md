# DSH WorkBuddy Dual (双轨版)

同时将 **WorkBuddy 国内版（CN）** 与 **WorkBuddy 海外版（Global）** 模型无缝接入 DeepSeek Harness，实现双轨并发、免配置使用。

## 核心特性

- **双轨并发 (Dual Provider)**：同时向 DSH 注册两个独立的提供商：
  - `workbuddy-cn`：对应国内版（中国大陆），模型目录由 `/v3/config` 动态下发（当前 31 个模型，含 `Kimi-K3`、`GLM-5.3`、`DeepSeek-V4.1-Flash` 等）。
  - `workbuddy-global`：对应海外版（Global），目录同样动态下发（当前 29 个模型，含 `GPT-6-Astra`、`GPT-5.6-Sol`、`Gemini-3.5-Flash` 等）。
- **思考强度可选 (Thinking Levels)**：按目录下发的 `supportedEfforts` 在 DSH 模型选择器里暴露可选档位（低 / 中 / 高 / 超高 / 极致）。
  - 目录只给单个 `effort` 默认值、没给档位列表的模型（例如 `Kimi-K3`、`DeepSeek-V4.1-Flash`、`MiniMax-M3`、`Gemini-3.5-Flash`），按模型家族补一套客户端档位，不再退化成"只有 off"。实测国内版 31 个模型里 27 个可选强度。
  - `canDisableThinking: false` 的模型不提供"关闭思考"，避免选到无效档位。
- **自动双凭证发现 (Zero Configuration)**：
  - 自动探测并读取本地已登录凭据：
    - 国内版：`CodeBuddyExtension/.../auth/workbuddy-desktop.info`
    - 海外版：`CodeBuddyExtension/.../auth/workbuddy-desktop-ai.info`
  - 零配置，只要电脑上登录过对应客户端即可直接识别。
- **独立自动保活与刷新**：
  - 两套账号分别维护独立的 `accessToken`、`refreshToken` 和自动刷新机制，互不干扰。
- **Web 设置双看板**：
  - 在 DSH 设置的“插件”面板中提供双卡片概览，直观对比两端的登录账号昵称、剩余积分和限免模型。
- **模型自选与双轨开关**：
  - “WorkBuddy 双轨”设置页新增「要显示哪些模型」：每条轨可以单独启用或关闭；显示范围可选「全部模型」或「只显示勾选」。
  - 勾选后只有选中的模型会出现在 DSH 的模型选择器、子代理选模目录和 loopback `/v1/models` 中，其余模型仍可被已建会话继续解析，不会被硬删。
  - 第一次使用时默认仍是「全部模型」；升级不会突然清空模型列表。选择保存在 `$DSH_HOME/.workbuddy-dual-models.json`，与账号凭据分开。
  - 模型清单支持搜索、全选、清空，保存后立即刷新，无需重载窗口。
- **轻量本地 Loopback 分流**：
  - 单个本地 Loopback 代理网关，自动识别请求前缀并分发至对应的腾讯云国内或海外 APISIX 网关。
- **国内版渠道校验兼容（11128）**：
  - 国内网关会对 system 提示词做渠道校验：提示词里带着别家 Harness 的品牌串时，请求在模型调用前就被拒绝，返回 `400 / 11128 Illegal API invocation from an unapproved channel`。典型现象是所有模型都发不出消息，但用一个简单 system 提示词却能通。
  - Loopback 在转发前只改写 system 消息里的这一处品牌串（`DeepSeek Harness` → `DeepSeek-Harness`），语义不变，用户自己的消息内容不动。
  - 该问题与请求头、工具表、模型、账号额度、推理档位都无关；换哪个模型都会同样被拦。
- **长会话请求体积防护（413 / 图片自动卸载）**：
  - 两个网关都在约 16 MB 处拒收整个请求体，但报错会伪装成别的问题：国内版返回 `400 / 11133 Invalid request parameters`，海外版返回裸 `500`，都不提体积。
  - 插件把 `maxRequestImageBytes` 设在网关上限以下（约束见 [`src/budget.ts`](./src/budget.ts)），所以长会话在撑爆网关**之前**就会拿到 `IMAGE_OFFLOAD_REQUIRED`，由 DSH 内置的 `dsh-compaction-image-offload` 把最老的截图换成占位符并自动重试。历史越长越会丢旧图，但会话能继续跑下去。
  - Loopback 自身仍保留一道兜底：超过 24 MiB 的请求体直接返回 `413 / request_too_large`，并带上实际字节数，不再伪装成 500。
  - 请求体超过 12 MiB 会写一行尺寸日志；上游在体积临界点拒绝时，日志里会把状态码和字节数配对打印，便于下次一眼定位。

## 安装方式

```bash
dsh plugin --profile web add github:JackAIStudio/dsh-workbuddy-dual
```

开发机改源码时用本地路径（host 侧 import 了 `@deepseek-ai/*`，必须 `file:`，不要 `link:`）：

```bash
dsh plugin --profile web add file:$HOME/Documents/dshspace/plugins/dsh-workbuddy-dual
```

安装后**重启一次 `dsh web`**（或点击 Web 界面左下角的重启按钮）即可生效。

## 诊断命令

```bash
dsh plugin --profile web exec dsh-workbuddy-dual status
dsh plugin --profile web exec dsh-workbuddy-dual doctor
```

## 许可证

[MIT](./LICENSE)
