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
- **轻量本地 Loopback 分流**：
  - 单个本地 Loopback 代理网关，自动识别请求前缀并分发至对应的腾讯云国内或海外 APISIX 网关。

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
