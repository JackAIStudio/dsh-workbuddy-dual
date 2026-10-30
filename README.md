# DSH WorkBuddy Dual (双轨版)

同时将 **WorkBuddy 国内版（CN）** 与 **WorkBuddy 海外版（Global）** 模型无缝接入 DeepSeek Harness，实现双轨并发、免配置使用。

## 核心特性

- **双轨并发 (Dual Provider)**：同时向 DSH 注册两个独立的提供商：
  - `workbuddy-cn`：对应国内版（中国大陆），模型目录由 `/v3/config` 动态下发（当前 31 个模型，含 `Kimi-K3`、`GLM-5.3`、`DeepSeek-V4.1-Flash` 等）。
  - `workbuddy-global`：对应海外版（Global），目录同样动态下发（当前 29 个模型，含 `GPT-6-Astra`、`GPT-5.6-Sol`、`Gemini-3.5-Flash` 等）。
- **思考强度可选 (Thinking Levels)**：按目录下发的 `supportedEfforts` 在 DSH 模型选择器里暴露可选档位（低 / 中 / 高 / 超高 / 极致）。
  - 目录只给单个 `effort` 默认值、没给档位列表的模型（例如 `Kimi-K3`、`DeepSeek-V4.1-Flash`、`MiniMax-M3`、`Gemini-3.5-Flash`），按模型家族补一套客户端档位，不再退化成"只有 off"。实测国内版 31 个模型里 27 个可选强度。
  - `canDisableThinking: false` 的模型不提供"关闭思考"，避免选到无效档位。
  - **切换模型默认落在最高档**：pi-ai 不携带每个模型的默认档位，DSH 会退回列表第一项（`off` 或 `low`），于是明明有 Max 的模型换过去只剩最低思考。本插件发布每个模型自己最高的可选档位作为默认值，`resolveModel` 与 `prepareCall` 两条元数据路径都覆盖；用户在选择器里手动选过的档位仍然优先。
- **自动双凭证发现 (Zero Configuration)**：
  - 自动探测并读取本地已登录凭据（没有在面板里建账号池时的兜底）：
    - 国内版：`CodeBuddyExtension/.../auth/workbuddy-desktop.info`
    - 海外版：`CodeBuddyExtension/.../auth/workbuddy-desktop-ai.info`
  - 零配置，只要电脑上登录过对应客户端即可直接识别。一旦在面板里选中过账号，就按所选的来。
- **独立自动保活与刷新**：
  - 两套账号分别维护独立的 `accessToken`、`refreshToken` 和自动刷新机制，互不干扰。
- **账号池与自由选号**：
  - 每一端各有自己的账号名单（`$DSH_HOME/.workbuddy-dual-accounts-cn.json` / `-global.json`），不再只有"当前这一份凭据"。
  - 面板里点「用这个」即切号，下一条请求就用新账号；选中的账号优先于 WorkBuddy 客户端登录的号。点「用这个」于客户端登录行可退回客户端登录。
  - 「导入当前登录」把 WorkBuddy 客户端此刻登录的账号加进名单。
  - **面板不再等网络**：账号页先用缓存立刻画出来，余额和 Flash 状态在后台补齐。首次打开约 0.1 秒出界面，全部结果通常 2～3 秒到齐，之后再打开是毫秒级。每个账号的探测并发不超过 3 个；上游失败后退避 20 秒再试，一个失效 token 不会让面板一直转圈。
- **DeepSeek-V4.1-Flash 真实可用性检测**：
  - 每个账号都显示 Flash 能否跑：`✅ 可用`、`⛔ 限流 + 解禁时间`、`⛔ 已封禁`、`⛔ 余额不足`、`⛔ 登录失效`。
  - 检测是真发一次 1 token 的流式请求，所以回答的是"此刻能不能跑"，而不是从余额推断。限流时直接读上游返回的解禁时间，不估算。
  - 面板打开即检测，结果缓存 45 秒；过了上游给的时间就重新检测，不会一直挂着一条已失效的"限流"。检测在后台跑，界面不等它。
  - 面板按“能不能干活”排序：Flash 状态在前，积分退到右侧。一个限流的号可能躺着两千多分却几小时用不上。
- **自动切号（默认开启）**：
  - 以前某个号一限流，整轮对话就停住，得去面板手动点「用这个」。现在请求在发出前就按下面这份顺序挑账号，限流时直接换下一个重发，用户看不到中断。
  - 顺序：**能跑当前模型且有余量的国内账号 → 同样条件的海外账号**。国内优先是因为国内积分可以签到补，海外积分用掉就没了；因此一个 179 分的国内号排在 1398 分的海外号前面，这是刻意的。
  - 同一线路内按「积分多 → 最近最少用」排序。积分未知的新号排在最前，宁可让它试一次，也不让它排在一个快耗尽的号后面。
  - 健康状态压过积分：一个刚 6004 的号即使躺着两千多分也先不碰。冷却按“账号 + 模型”记，Flash 受限不影响同一个号跑 GPT；冷却写到 `$DSH_HOME/.workbuddy-dual-health.json`，重启后仍然生效。
  - **封禁直接作废，不当冷却处理**：`11140 request illegal` 是账号级门禁，没有到点自动恢复这回事。一旦测到封禁，该账号立刻退出调度、不再自动检测、也不会拖住请求等它；面板把它列在「已停用的账号」里，原因写清楚。要恢复只能重新登录或手动点检测。旧版本留下的封禁记录（24 小时冷却、没有标记）升级后同样按永久停用处理。
  - 一个会话粘在同一个号上，不会每轮跳来跳去。粘性是**同线路内**的：国内全部限流时对话落到海外，等国内恢复后自动回到国内，花的是能补的那份积分。
  - 上游把限流塞在 200 响应的第一帧里（业务码 6004），所以 shim 先读第一帧、确认不是限流帧才写响应头。已经吐了一半的流不重放，交给 Harness 的 step 重试；工具调用在模型步结束后才执行，重试不会重复跑工具。
  - 全部账号都在冷却时返回 429，并在消息里写明最早恢复时间，输入不会丢。
  - 只切换账号，**不换模型**。选 Flash 就只发 Flash。只有一端有的模型（Kimi 仅国内、GPT-6-Astra 仅海外）不会跨线。
  - 面板顶部可以直接关掉自动切号，并看到「下一个会走哪个账号」和每个账号的冷却原因。
  - 注意：WorkBuddy Global 的 Flash 有两种计价，`x0.00` 是免费但有额度上限，`x0.03` 那类是花积分、上限更高。调度只按“能不能跑 + 余额 + 线路”排，不替你在免费额度和计费额度之间做取舍。
- **模型自选与双轨开关**：
  - “WorkBuddy 双轨”设置页新增「要显示哪些模型」：每条轨可以单独启用或关闭；显示范围可选「全部模型」或「只显示勾选」。
  - 勾选后只有选中的模型会出现在 DSH 的模型选择器、子代理选模目录和 loopback `/v1/models` 中，其余模型仍可被已建会话继续解析，不会被硬删。
  - 第一次使用时默认仍是「全部模型」；升级不会突然清空模型列表。选择保存在 `$DSH_HOME/.workbuddy-dual-models.json`，与账号凭据分开。
  - 模型清单支持搜索、全选、清空，保存后立即刷新，无需重载窗口。
- **轻量本地 Loopback 分流**：
  - 单个本地 Loopback 代理网关，自动识别请求前缀并分发至对应的腾讯云国内或海外 APISIX 网关。
- **国内版渠道校验兼容（11128）**：
  - 国内网关会对 system 提示词做渠道校验：命中它的特征后，请求在模型调用前就被拒绝，返回 `400 / 11128 Illegal API invocation from an unapproved channel`。典型现象是所有模型都发不出消息，但用一个简单 system 提示词却能通。
  - 这道校验看过两轮。第一轮认的是别家 Harness 的品牌串（`DeepSeek Harness`），改写成品名连字符形式（`DeepSeek-Harness`）即可绕过；这一轮已不再拦它。
  - 现在的判定看**版式**：整段提示词全部用单空格连接句子时会被拒，句间换成换行则放行，其余字节完全相同。实测同一份 DSH 提示词原样发送 5 次全拦、只改句间分隔后 5 次全通；图片、工具表、推理档位、trace 头都不参与判定。海外版不做这项检查。
  - Loopback 因此在转发前对 **CN** 轨道的 system 文本做两处处理：品牌串归一化，以及把句末标点后半角空格接下一句的位置换成换行。代码块、列表、缩进块和用户消息原样不动，文字一个也不增删。
  - 同一道校验还看**开头是不是别家客户端的身份串**。Claude Code 把 `You are Claude Code, Anthropic's official CLI for Claude.` 作为第一个 system 块发出来，CN 网关同样回 11128，于是 Claude（经 OpenCodex 走 CN 轨道）每一轮都失败。这条只看开头：同一句话前面多一个空格、一个换行或一句别的话就放行。
  - Loopback 对以这句身份声明开头的 system 文本，把 `Claude Code,` 后面的逗号换成破折号。词序和语义不变，只差一个标点；出现在正文中间的同名句子不动，海外轨道也不动。
  - 该问题与请求头、工具表、模型、账号额度、推理档位都无关；换哪个模型都会同样被拦。
- **Kimi 工具 schema 校验兼容（11133）**：
  - 国内网关上的 Kimi 系列（`kimi-k3.1-pro` 等）会严格校验工具参数 schema：只要任何一个工具里出现 `enum` 却没有同级的 `type`，整个请求就被拒成 `400 / 11133 Invalid request parameters`，连模型都没跑到。同一份请求换 `glm-5.3` 能通，海外网关的 Kimi 也能通，所以很容易被当成"这个模型坏了"。
  - `enum` 不带 `type` 本身是合法的 JSON Schema，第三方 MCP server 经常这么写。典型触发者是 `cua-driver` 的 `parse_visual_regions`，它的 `kinds` 参数是 `anyOf[数组, null]`，数组的 `items` 里只有 `enum: ["text", "icon"]`。
  - Loopback 在转发前给每个缺 `type` 的 `enum` 补上它唯一的 JSON 类型（`items`、`anyOf` 里的也算），声明过的 `type` 和类型混杂的 `enum` 一律不动。
- **Web 搜索与网页抓取（原生托管）**：
  - 插件把 WorkBuddy 自己的 `/agenttool/v1/search` 和 `/agenttool/v1/webfetch` 暴露成 `workbuddyNativeSearch` / `workbuddyNativeFetch` 两个服务，配合 [`dsh-web-search-follow`](https://github.com/JackAIStudio/dsh-web-search-follow) ≥ 0.3 使用。
  - 用的是当前轨道**已经登录的那个账号**，不额外配 key、不额外花钱；国内版走国内网关，海外版走海外网关，会话里选哪个轨道就花哪个账号。
  - `web_fetch` 由服务端代抓，因此不受本机 Clash / fake-ip 影响。国内网关自身会按域名策略拒绝一部分站点（例如 `anthropic.com`、`openai.com` 返回 `403 / 15021 domain rejected by via routing policy`），此时换海外版轨道或换域名，插件不会在本机绕过去。
  - 没有装 `dsh-web-search-follow` 时这两个服务只是注册着没人用，不影响原有功能。
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
