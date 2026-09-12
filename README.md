# DSH WorkBuddy Dual (双轨版)

同时将 **WorkBuddy 国内版（CN）** 与 **WorkBuddy 海外版（Global）** 模型无缝接入 DeepSeek Harness，实现双轨并发、免配置使用。

## 核心特性

- **双轨并发 (Dual Provider)**：同时向 DSH 注册两个独立的提供商：
  - `workbuddy-cn`：对应国内版（中国大陆），包含 `Deepseek-V4.1-Flash` (x0.03 独家优惠)、`Hy3` (x0.00 限时免费)、`GLM-5.3` (可调思考强度) 等模型。
  - `workbuddy-global`：对应海外版（Global），包含 `Deepseek-V4.1-Flash` (x0.00 免积分)、`GPT-6-Astra`、`GPT-5.5`、`Gemini-3.5-Flash` 等模型。
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
