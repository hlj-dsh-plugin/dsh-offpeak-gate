# @dsh-external/offpeak-gate

低峰期闸门：会话级开关，开启后在 DeepSeek **高峰时段**阻塞 LLM 请求、排队等待，**低峰自动放行**，节省峰谷差价（低峰约 5 折）。

## 安装

```bash
dsh plugin --profile web add github:hlj-dsh-plugin/dsh-offpeak-gate
```

## 背景

DeepSeek 官方峰谷定价（2026-08-17 起）：
- 高峰：09:00–12:00、14:00–18:00（北京时区；周末/节假日视为低峰）
- 低峰：其余时间，价格约为高峰的 5 折

本插件把"非紧急对话挪到低峰跑"自动化：高峰期 agent 不调 LLM（阻塞在请求前），低峰边界一到自动继续。

## 产品形态（已定稿）

- **会话级开关**：每个会话独立，默认关；页面会话头部 ☀️/🌙 按钮一键切换。
- **阻塞语义**：方案 A —— 在 `agent/request` 瀑布钩子里等待到低峰再放行。等待期间用户新消息进 inbox 排队（消息已在会话日志中，不会丢），低峰到达后同一轮继续、随后处理排队消息。
- **子代理继承**：子会话通过 `header.forkedFrom` 链继承父会话开关。
- **排队等低峰**：高峰期间新消息不打扰用户，状态条显示倒计时；**立即发送**按钮可一键放行（可打断正在进行的等待）。

## 页面 UI

- 会话标题栏：☀️/🌙 低峰开关（开启时高亮，☀️=高峰、🌙=低峰）。
- 输入框上方状态条（开启后显示）：
  - 等待中：`⏳ 高峰等待中，距低峰还有 2h 13m` + [立即发送]
  - 高峰未等待：`高峰时段：LLM 请求将阻塞到低峰自动放行 · 恢复 18:00`
  - 低峰：`低峰时段，请求正常发送（5 折计费）`

## 配置（profile 行 / 设置页）

```yaml
- id: offpeak-gate
  name: "@dsh-external/offpeak-gate"
  config:
    timeZone: Asia/Shanghai        # IANA 时区
    peakWindows: [[9, 12], [14, 18]]  # 高峰窗口 [起, 止) 小时
    weekendsOffpeak: true          # 周末全天低峰
    chunkMs: 600000                # 等待分片（Node timer 上限保护）
    maxWaitMinutes: 0              # 单次最长等待；0 = 不限
    routePath: /offpeak-gate/api   # 控制路由
```

## 实现要点

- 阻塞点：`agent/request` 瀑布（每个 LLM 请求前必经）；分片 + AbortSignal 可取消等待，不依赖工具超时策略。
- 持久化：开关**不写会话日志**（插件自有事件类型会让不认识该词汇的 harness 拒绝读取整份会话日志），改为经 settings 的 `modes` 字段按会话 id 持久化（重启后仍生效；fork 出的子会话沿 `header.forkedFrom` 继承）。
- 状态：等待中/已就绪为进程内状态（`waitStates`），仅驱动页面状态条，不落日志；重启后自然清空。
- 控制路由：loopback-only `GET /offpeak-gate/api?session=<id>`（状态）/ `POST {op:"mode"|"force"}`。
- 客户端：`conversation.session.header.actions`（开关）+ `conversation.input.dock`（状态条）两个槽位，10s 轮询 + 操作后立即刷新。

## 已知限制

- 等待不跨进程：进程重启后正在进行的等待丢失，会话恢复后重新建立（不丢消息）。
- 阻塞期间 agent 状态为 running（页面以状态条提示等待原因）。
- **放行粒度 = 本轮（turn）**：点"立即发送"后，当前这一轮的所有后续 LLM 请求（含工具调用之间的请求）都不再阻塞；下一条新消息开新轮时恢复阻塞。想完全放开请关闭低峰模式。
- force 只作用于当前会话；子代理若在等待中，需在其自身会话触发（v1 不做级联）。
