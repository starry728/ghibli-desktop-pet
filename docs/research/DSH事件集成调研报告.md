# DSH 事件集成调研报告

**调研对象**：DeepSeek Harness `@deepseek-ai/dsh` v0.2.0-rc.2
**安装目录（只读）**：`C:\Users\<你的用户名>\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
**用户数据目录**：`C:\Users\<你的用户名>\.dsh\`
**调研方式**：直接读取包内 `README.md` / `lib/types/*.d.ts` / `lib/*.js`，并**实际解码真实会话日志**（zstd 多帧）取得原始事件行。
**DHS 目录未被修改**（已验证 `cordis.yml` 仍为 223 字节 / mtime 2026-10-09T09:27:46）。

---

## 0. 结论速览（TL;DR）

| 问题 | 答案 |
|---|---|
| 有官方 hooks 机制吗？ | **有，但是「Claude Code / Codex hooks.json 兼容桥」**，且**默认不挂载**。事件点含 `Stop`（回合将结束）与 `PreToolUse`，但官方明确列出的 23/30 不支持事件里**包含 `PermissionRequest` 和 `Notification`** —— 所以 hooks **不能**用来观察「需要批准」。 |
| 有官方插件系统吗？ | **有**。Cordis 插件框架（Koishi 作者的作品），`cordis.yml` 就是 profile 的插件加载树。插件可监听 `session/event`（每个会话事件）、`approval/request`（审批瀑布）、`agent/turn-stopping`（回合将停）。 |
| 有官方进程外协议吗？ | **有，ACP**（Agent Client Protocol）。`dsh --profile acp` 起一个 stdio JSON-RPC 服务。回合完成 = `session/prompt` 响应返回 `stopReason`；审批 = 服务端发 `session/request_permission` 请求。 |
| 有 notify / webhook / onTaskComplete 配置吗？ | **没有**出站通知机制。`dsh-webhook` 是**入站单向**的（外部事件 → 新建会话），不支持反过来。CLI 也没有 `hooks`/`notify`/`events` 子命令（`dsh hooks` 会被当成 profile 名，报 `profile "hooks" does not exist`）。 |
| 会话文件里有这两类事件吗？ | **有，而且字段清晰、可直接判定**。`turn/end`（含 `reason.kind:"completed"`）与 `approval/asked` / `approval/decided` 配对。 |
| 能只靠轮询文件可靠识别吗？ | **能，而且相当可靠** —— 已用「zstd 帧边界」证明 `approval/asked` 在被批准前就已独立落盘。但有 3 个必须处理的坑（见 §2.5）。 |

**最推荐**：轮询会话日志（§4 方案 A）+ 可选叠加 Cordis 插件（方案 B）。

---

## 1. 官方机制逐项排查

### 1.1 CLI 层：没有 hooks / notify / events 子命令

入口来自 `@deepseek-ai/dsh/package.json`：`"bin": { "dsh": "lib/bin.js" }`。
`node .../@deepseek-ai/dsh/lib/bin.js --help` 的真实输出（节选）：

```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  initialize a new custom profile from a shipped profile template
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and patches without mounting
  --dump-default-config          print the profile tree without its user layer or --patch overlays and exit

Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

**只有两个顶层形态**：`dsh [--profile] <name>` 和 `dsh plugin`。
`dsh hooks --help` 的报错证明没有子命令：

```
Error: dsh: profile "hooks" does not exist; create it with 'dsh plugin --profile hooks add <package>'
```

（`dsh web --help` 会**重写** `~/.dsh/profiles/web/cordis.yml`；本沙箱已拒绝该写操作，文件未被改动。）

### 1.2 有：Cordis 插件系统（进程内，真正的扩展点）

`C:\Users\<你的用户名>\.dsh\profiles\web\cordis.yml`（**自动生成，不要手改**，223 字节）：

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

`C:\Users\<你的用户名>\.dsh\profiles\web\cordis.patch.yml`（**用户补丁层，343 字节**）：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
```

`C:\Users\<你的用户名>\.dsh\profiles\web\package.json`：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

即：**profile = bundle 叠加 + 用户 patch 层**。要挂任何钩子/插件，就在这里加 `- insert:` 行。

**可用的 Cordis 事件（真正的进程内钩子）**，来自 `dsh-session/lib/types/index.d.ts:64` 与 `dsh-agent/lib/types/runtime-types.d.ts:387`：

```ts
// @deepseek-ai/dsh-session
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;   // @mode emit
// 以及同处的 'session/flush' —— 并行持久化检查点（"durability checkpoint"）

// @deepseek-ai/dsh-agent
'agent/turn-stopping'(this: Scoped<Agent>, payload: {
    agent: Agent; turn: number; signal: AbortSignal;
}): Promise<void> | void;                                                              // @mode serial

// @deepseek-ai/dsh-user-approval/lib/types/types.d.ts:81
'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent,
                   next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;   // @mode waterfall
```

`ctx.on('session/event', ...)` 在整个代码库里有 **35 处**使用（`dsh-acp`、`dsh-session-persistence-jsonl`、`dsh-api-session-controller`、`dsh-token-meter`……），这是事实标准的事件订阅方式。

官方还自带写插件的技能文档：
`...\dsh-agent-preset\skills\` 下有 `cordis-plugin-development`、`editing-cordis-compositions`、`cordis-composition-reference`。

### 1.3 有：ACP —— 唯一官方「进程外」协议

`...\dsh-acp\README.md`（`kind: package-reference`）摘要原文：

> `dsh-acp` lets trusted programs automate persistent DeepSeek Harness agents through the standard ACP ... Run `pnpm dsh --profile acp` to start the server.

协议契约表（README.md L62-74 原文，节选）：

| Call | What you get |
|---|---|
| `session/prompt` | Ordered text, resource links, and supported images, one prompt at a time per session; **settlement follows Agent idle and ordered update delivery.** |
| `session/update` | Committed assistant messages and thoughts, generic tool lifecycle, configuration changes, and context usage, serialized per session. |
| `session/request_permission` | **A permission prompt with one-shot allow/reject choices; your client can answer automatically.** |

**回合完成 → stopReason 的精确映射**（`...\dsh-acp\lib\index.js:539`，逐字）：

```js
function turnEndToStopReason(reason) {
  case "completed":  return "end_turn";
  case "max-tokens": return "max_tokens";
  case "aborted":    return "end_turn";
  case "interrupted":return "cancelled";
  case "error":      return "end_turn";
  default:           return "end_turn";
}
```

**审批请求的精确报文**（`...\dsh-acp\lib\index.js:1116-1138`，逐字）：

```js
ctx.on("approval/request", (request, next) => {
    const record = ownedRecord(request.agent);
    if (record === void 0 || request.callId === void 0) return next();
    const callId = request.callId;
    return record.drainUpdates().then(() => {
        const params = {
            sessionId: record.agent.session.id,
            toolCall: { toolCallId: callId },
            options: [{
                optionId: "allow-once",
                name: "Allow once",
                kind: "allow_once"
            }, {
                optionId: "reject-once",
                name: "Reject",
                kind: "reject_once"
            }]
        };
        return conn.request(methods.client.session.requestPermission, params);
    }).then(({ outcome }) => {
        if (outcome.outcome === "cancelled") return "cancelled";
        return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
    });
});
```

`session/update` 的判别值（`lib/index.js`）：`agent_thought_chunk`(567) / `agent_message_chunk`(578) / `tool_call`(594) / `tool_call_update`(619) / `usage_update`(632) / `config_option_update`(777)。

启动 profile：`...\dsh-acp-app\README.md` 确认 `dsh --profile acp`，**stdout 专用于 ACP JSON-RPC**（"Stdout is reserved for newline-delimited ACP JSON-RPC frames"）。

**另一条进程外路线**：`dsh --profile headless --json`（`...\dsh-headless\README.md`）输出 NDJSON：
`session` → `status` / `text` / `thinking` / `tool_call` / `tool_result` → `turn_end` → `final`（失败时 `error`）。退出码 0=完成，1=中止/出错。
但这是**一次性子进程**，不能观察你正在跑的 `dsh web`。

### 1.4 有：Claude Code / Codex hooks 兼容桥（**默认未挂载**）

`...\dsh-hooks-claude-code\README.md` —— 注意 `kind: package-reference`，且其 Summary 说明：

> `dsh-hooks-claude-code` runs command hooks from your existing Claude Code `hooks.json` or settings file during agent runs, without requiring a rewrite.

支持的事件点与能力（README.md L56-64 原文）：

| Your hook | When it runs | What it can do |
|---|---|---|
| `SessionStart` | when a session starts | attach context the model sees in that session |
| `UserPromptSubmit` | when the agent receives a prompt | block the prompt, or attach extra context |
| `PreToolUse` | before a tool runs | block the tool, **or ask for approval before it runs** |
| `PostToolUse` | after a tool runs | block the result with feedback, or attach extra context |
| **`Stop`** | **when the run is about to stop** | **force another step with a reason** |
| `SubagentStart` | when a subagent starts | attach context to a still-running subagent (in-process only) |
| `SubagentStop` | when a subagent ends | observe only — cannot block or add context |

配置形态（README.md L36-42）：

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

**关键局限**（README.md L174 原文，逐字）：
> **Unsupported hook events (23 of Claude Code's current 30)** — `Setup`, `InstructionsLoaded`, `UserPromptExpansion`, `MessageDisplay`, **`PermissionRequest`**, `PostToolUseFailure`, `PostToolBatch`, **`PermissionDenied`**, **`Notification`**, `TaskCreated`, **`TaskCompleted`**, `StopFailure`, …

且 L182：
> Only shell-form command handlers run. `http`, `mcp_tool`, `prompt`, and `agent` handlers are skipped …

**结论**：`Stop` 钩子可用作「回合结束回调」（执行一条 shell 命令），但 **`PermissionRequest` / `PermissionDenied` / `Notification` / `TaskCompleted` 都不支持** —— 所以这套桥**无法用于感知「需要用户批准」**。

**而且它没有挂载**：`...\dsh-web-app\cordis.patch.yml`（web profile 的完整组合，含 `ui-approval`、`ui-user-questions`、`session-controller` 等全部行）中**没有任何 hooks 行**；`dsh-base\cordis.patch.yml` 里也没有。必须自己加。

### 1.5 有 webhook —— 但是**入站单向**，不能用于「通知外部」

`...\dsh-webhook\README.md` Summary 原文：
> `dsh-webhook` provides the Host `ctx.webhookRuntime`: a registry for trusted programmatic webhook rules plus the one built-in action, **creating an ordinary root Session inside a Web Workspace**.

即：外部事件 → 触发 DSH 新建会话。反向（DSH 完成 → 通知外部）**没有**。README 的 Known Limitations 明确：
> **No completion result** — HTTP acceptance and rule settlement do not report Agent success, idle, or output.
> **Process-local fire-and-forget only** — a crash loses rule calls that have not admitted a prompt; there is no queue, replay, or retry.

### 1.6 配置文件盘点：没有可挂命令钩子的通用配置

`C:\Users\<你的用户名>\.dsh\` 顶层**只有**：

```
attachments/            cache/            llm-deepseek/       profiles/
sessions/               storages/
.anonymous-user-id      (37 B)
.credentials.yaml       (223 B, 顶层键: version:/records:/refs:)
```

- **没有** `config.json` / `config.yml` / `settings.json`（已用 `Get-ChildItem -Recurse -Filter "config*"` 与 `-Filter "*settings*"` 验证，均无结果）。
- 唯一用户可编辑的配置就是 `profiles/<name>/cordis.patch.yml` + `package.json`。
- `storages/` 是 storage hub（`dsh-base\cordis.patch.yml:171`：`root: !!js dshHomePath('storages')`），落盘规则见 `dsh-storage-json`：整单元文件 `<root>/<name>.json`，逐记录 `<dir>/<table>/<key>.json`。当前只有 `workspace.json` 和 `session_projcache/sessions/*.json`。设置域名为 `'settings'`（`dsh-settings\lib\types\index.js:192` `super(ownerContext, 'settings')`），所以若改过设置会出现 `storages/settings.json` —— **当前不存在**。

> 因此：**想挂命令钩子，唯一的路是 Cordis patch（§4 方案 B）或 ACP（方案 C），没有"配置文件里写个命令"这种选项。**

---

## 2. 会话文件里的两类事件（真实样例）

### 2.1 文件布局与格式

```
C:\Users\<你的用户名>\.dsh\sessions\<workspace-slug>\<sessionId>\session.v4.jsonl.zstd
```

真实清单（`Get-ChildItem -Recurse`）：

```
C:\Users\<你的用户名>\.dsh\sessions\--D-myAIprojects-try_deepseekharness-DesktopPet--\
    session-<已隐去>\session.v4.jsonl.zstd    (917,255 B)  ← Web 主会话
    <id-已隐去>\session.v4.jsonl.zstd            (405,287 B)  ← 子 agent 会话
    <id-已隐去>\session.v4.jsonl.zstd            (164,705 B)  ← 子 agent 会话（本次调研自身）
C:\Users\<你的用户名>\.dsh\sessions\--D-Document-deepseek-harness-default-workspace--\
    session-<已隐去>\session.v4.jsonl.zstd    (338 B)
C:\Users\<你的用户名>\.dsh\sessions\--D-myVscodeProjects-myML-ml-from-scratch--\
    session-<已隐去>\session.v4.jsonl.zstd    (342 B)
```

**格式：Zstandard 压缩的 JSONL，但是「多帧追加」（append-only multi-frame）**，不是单帧。

- 魔数 `28 B5 2F FD`；`bf9fb936` 实测 **253 个候选帧全部解码成功**，`session-7f4c23a1` **628/628 成功**。
- 每帧 1~7 个事件（多数 1~3），即**每次 flush 一帧**。
- ⚠️ **坑（我实际踩到）**：`zlib.zstdDecompressSync(整个文件)` 只返回**第一帧**（只解出 304 字节 / 1 行）。必须按帧魔数切分后逐帧解。Node v24.20.0 有 `zlib.zstdDecompressSync`。

每行是一个 `{type, seq, time, data}` 信封，`seq` 从 0 连续递增，`time` 是 Unix epoch 毫秒。

### 2.2 「任务完成」样例

会话头（`session-7f4c23a1...`，第 1 行）：

```json
{"type":"session","version":4,"id":"session-<已隐去>","createdAt":1791530942693,"cwd":"<项目目录>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

**文件**：`C:\Users\<你的用户名>\.dsh\sessions\--D-myAIprojects-try_deepseekharness-DesktopPet--\session-<已隐去>\session.v4.jsonl.zstd`

```json
{"type":"turn/start","seq":4,"time":1791532411282,"data":{"turn":1}}
{"type":"turn/end","seq":883,"time":1791534068115,"data":{"turn":1,"reason":{"kind":"completed"}}}
{"type":"turn/start","seq":885,"time":1791534582596,"data":{"turn":2}}
```

（该会话读到 979 个事件、9 个 `user/message`；turn 2 当时仍开着 → **「打开中的 turn」= 有 `turn/start` 但无配对 `turn/end`**。）

同样的形状在子会话 `bf9fb936`（**文件**：`...\sessions\--D-myAIprojects-try_deepseekharness-DesktopPet--\<id-已隐去>\session.v4.jsonl.zstd`）里完整出现了两个回合：

```json
{"type":"turn/start","seq":4,"time":1791532773402,"data":{"turn":1}}
{"type":"turn/end","seq":226,"time":1791532967312,"data":{"turn":1,"reason":{"kind":"completed"}}}
{"type":"session/end-seed","seq":227,"time":1791532983998,"data":{}}
{"type":"turn/start","seq":229,"time":1791532984009,"data":{"turn":2}}
{"type":"turn/end","seq":426,"time":1791533245845,"data":{"turn":2,"reason":{"kind":"completed"}}}
```

**`TurnEndReason` 完整取值表**（`dsh-session\lib\types\types.d.ts:165-210`，权威）：

| `reason.kind` | 含义 |
|---|---|
| `completed` | 正常完成 |
| `aborted` | 取消打断（`reason` 另带 `{kind:'user'\|'parent'\|'hook'\|'disposed'\|'legacy'}`） |
| `blocked` | 被拦截（例如 UserPromptSubmit hook 拒绝） |
| `error` | 失败（`error` 为结构化 `LlmFailure`） |
| `max-tokens` | 至少一个 step 撞到输出上限 |
| `interrupted` | 崩溃后被补写的收尾标记（loop 不会实时发） |
| `forked` | fork 播种时关闭的边界 turn |

### 2.3 「需要用户批准」样例（**同一文件** `session-7f4c23a1...`）

策略事件：

```json
{"type":"permission/preset","seq":0,"time":1791530942700,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":1,"time":1791530942700,"data":{"mode":"workspace-write"}}
{"type":"approval/policy","seq":2,"time":1791530942701,"data":{"policy":"ask"}}
```

**审批请求 / 决议的完整 7 对**（真实原文，`reason` 为模型写的中文说明）：

```json
{"type":"approval/asked","seq":34,"time":1791532422434,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_hEtVV5QgqahG2S3VWj7U6812","reason":"escalate sandbox to danger-full-access: 沙箱在给工作区 <项目目录> 授权时被 Windows 文件权限挡住，需要免沙箱运行一次该修复脚本：…"}}
{"type":"approval/decided","seq":35,"time":1791532424015,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}

{"type":"approval/asked","seq":553,"time":1791533275131,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_ET_1HqT34YIufnbUPds8hPw8078","reason":"escalate sandbox to danger-full-access: 无头浏览器需要命名管道做进程间通信，沙箱会拦截，…"}}
{"type":"approval/decided","seq":554,"time":1791533394367,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}

{"type":"approval/asked","seq":579,"time":1791533413768,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_ET_WfTaNmNVqHZGzb4ssCrC2676","reason":"escalate sandbox to danger-full-access: 无头浏览器依赖命名管道做进程间通信，被沙箱拦截。修复了一个界面 bug 后需要重新截图…"}}
{"type":"approval/decided","seq":580,"time":1791533477426,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}

{"type":"approval/asked","seq":673,"time":1791533566282,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_ET_6HGHqUIo4xhfSgf36rRG9771","reason":"…请允许我运行这条 Chrome 命令，在真实浏览器里执行刚写的挂件拖动自检页…"}}
{"type":"approval/decided","seq":674,"time":1791533569348,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}

{"type":"approval/asked","seq":699,"time":1791533583140,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_ET_bu5Nyv16UAmkVuZzH4sR6857","reason":"…需要再运行一次这条 Chrome 命令来读取挂件拖动自检页的诊断输出…"}}
{"type":"approval/decided","seq":700,"time":1791533594458,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}

{"type":"approval/asked","seq":713,"time":1791533601528,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_ET_VAhIFAHgHdGW2bnpuqvw7280","reason":"escalate sandbox to danger-full-access: 无头浏览器需要命名管道，沙箱会拦截。…"}}
{"type":"approval/decided","seq":714,"time":1791533853340,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}

{"type":"approval/asked","seq":779,"time":1791533896197,"data":{"id":"<id-已隐去>","toolName":"pwsh","callId":"call_00_ET_epVOb0MSKHiip1Omu36A4794","reason":"…请允许我运行这条 Chrome 命令，为已完成的项目拍最后一组界面截图…"}}
{"type":"approval/decided","seq":780,"time":1791533998253,"data":{"id":"<id-已隐去>","outcome":"allowed-once"}}
```

**契约（`dsh-user-approval\lib\types\types.d.ts`，权威）**：

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
// 'approval/asked':   { id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string }
// 'approval/decided': { id: ApprovalRequestId; outcome: ApprovalOutcome }
export type ApprovalPolicy = 'ask' | 'never';     // APPROVAL_POLICIES = ["ask","never"]
```

`'approval/asked'` 追加逻辑（`dsh-user-approval\lib\index.js:128-144`，逐字，注意 **asked 先落，await 之后才 decided**）：

```js
async request(req) {
    const session = req.agent.session;
    if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: ...");
    const id = ApprovalRequestId(randomUUID());
    session.append("approval/asked", {
        id, toolName: req.toolName,
        ...req.callId !== void 0 ? { callId: req.callId } : {},
        ...req.reason !== void 0 ? { reason: req.reason } : {}
    });
    const outcome = await this.decide(req, session);     // ← 这里在等人类
    session.append("approval/decided", { id, outcome });
    return outcome;
}
```

### 2.4 落盘时机 —— 用 zstd 帧边界证明「待批准确实已落盘」

这是本报告最关键的一条实证。逐帧打印 `session-7f4c23a1...` 的帧边界，**每一对审批都落在相邻但不同的两个帧里**：

```
FRAME #1   (byte 190,   3 events, seq 0..2):      permission/preset, sandbox/mode, approval/policy
FRAME #17  (byte 29057, 1 event,  seq 34..34):    approval/asked      <<<<
FRAME #18  (byte 29608, 1 event,  seq 35..35):    approval/decided    <<<<
FRAME #350 (byte 588988,1 event,  seq 553..553):  approval/asked      <<<<
FRAME #351 (byte 589530,1 event,  seq 554..554):  approval/decided    <<<<
FRAME #368 (byte 603847,1 event,  seq 579..579):  approval/asked      <<<<
FRAME #369 (byte 604314,1 event,  seq 580..580):  approval/decided    <<<<
FRAME #431 (byte 682433,1 event,  seq 673..673):  approval/asked      <<<<
FRAME #432 (byte 682938,1 event,  seq 674..674):  approval/decided    <<<<
FRAME #449 (byte 696373,1 event,  seq 699..699):  approval/asked      <<<<
FRAME #450 (byte 696839,1 event,  seq 700..700):  approval/decided    <<<<
FRAME #459 (byte 703143,1 event,  seq 713..713):  approval/asked      <<<<
FRAME #460 (byte 703616,1 event,  seq 714..714):  approval/decided    <<<<
FRAME #502 (byte 741069,1 event,  seq 779..779):  approval/asked      <<<<
FRAME #503 (byte 741592,1 event,  seq 780..780):  approval/decided    <<<<
```

对应的等待时长（decided.time − asked.time）：

| turn | id | 等待 |
|---|---|---|
| 1 | 587f1bec… | 1.6 s |
| 1 | cd723e7a… | **119.2 s** |
| 1 | dbdf558e… | 63.7 s |
| 1 | 685c2dc0… | 3.1 s |
| 1 | 8a8fd2bd… | 11.3 s |
| 1 | 1123e81e… | **251.8 s** |
| 1 | 25ea58c9… | 102.1 s |

→ **`approval/asked` 会作为独立 zstd 帧立刻落盘，在被批准前 1.6~252 秒一直是可读的。**

另有一条独立证据（对**我自己的实时会话** `1bf612cb...` 做 10 秒观测）：最后一个事件是 `tool/call seq=297`，读取时刻距它的 `time` 仅 **442 ms**，且该 tool 正在执行 —— 说明 append 后很快就 flush。

同时 `dsh-session-checkpoint-policy\README.md` 给出机制解释（逐字）：
> Three barriers are checkpointed. The model request is flushed before the adapter stream is constructed … **A top-level tool call is flushed before the tool body runs** … At each `agent/pre-step` boundary, everything the preceding step committed … is flushed before the next request is derived.

以及 `dsh-session\lib\types\types.d.ts:265-272` 的备注：
> The loop does not await a flush at turn boundaries: `dsh-session-checkpoint-policy` owns the per-request durability checkpoint, and consumers that read storage after `whenIdle()` flush themselves.

⚠️ 含义：**`session/flush` 才是保证点**。审批路径恰好被 flush（实测），但理论上后端存在 batching window（checkpoint-policy README 说 "events still inside the backend's batching window or an outstanding write can be lost"）。实测结果让人放心。

### 2.5 只靠轮询能不能可靠判定？—— **能**，判定规则如下

#### ✅ 结论
**能，而且对这两类事件都可靠。** 但必须处理下面 4 个坑。

#### ⚠️ 坑 1：`turn/end` 是**每回合**都发，不是「整个任务完成」
`session-7f4c23a1` 里 turn 1 `completed`（seq 883）之后，用户在 seq 885 又开了 turn 2。所以「任务完成」这个语义要你自己定义：
- 想「每次助手答完就提醒」→ 直接用 `turn/end`。
- 想「整个任务真的结束了」→ 需要额外启发式（例如该 turn 的最后一个 `assistant/message` 不含 tool-call，或结合 `goal/change` 的 `phase`）。
（对本项目而言「每次答完念一句台词」大概率就是 `turn/end`，与用户需求一致。）

#### ⚠️ 坑 2：**子 agent 会话也会发 `turn/end`**
`bf9fb936` 与 `1bf612cb` 各自是独立目录、独立日志，各自有完整 `turn/start`/`turn/end`。它们的 `session` 头可区分：

```json
{"type":"session","version":4,"id":"<id-已隐去>","parentSession":"session-<已隐去>","isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

**规则**：只看 `origin` 不存在且 `delegationDepth` 不存在或为 0 的会话 = 顶层会话。（子 agent 的 `approval/policy` 还常是 `{"policy":"never","source":"delegation"}`。）

#### ⚠️ 坑 3：必须**逐帧**解码 zstd，且容忍末帧不完整
- 不能 `zstdDecompressSync(整文件)`（只出第一帧 —— 我实测只得到 304 字节）。
- 按 `0xFD2FB528`（LE）切帧逐个解；**正在被写入的最后一帧会解码失败，必须捕获异常、下轮重试**，不要跳过后续。

#### ⚠️ 坑 4：Windows 上没有可探测的写锁文件
`dsh-session-persistence-jsonl\lib\types\lease.d.ts` 原文：
> POSIX takes a non-blocking `flock(2)` via native system support on `session.lock` beside the log, and **Windows holds a named kernel semaphore derived from that path — never a file lock or handle**, so readers, searches, and directory removal proceed freely while the lock is held.
> Readers never touch the lock.

→ Windows 上**无法用锁文件判断会话是否活着**；用文件 mtime 新鲜度代替。好消息是「readers never touch the lock」，**边写边读是安全的**。

#### 📋 推荐判定规则（伪代码）

```
全局状态：{ [sessionId]: { byteOffset, lastSeq, seenAskIds:Set, seenDecidedIds:Set, emittedTurnEnds:Set } }

每 500ms ~ 1s 轮询：
for 每个 C:\Users\<你的用户名>\.dsh\sessions\*\*\session.v4.jsonl.zstd:
    if 文件 mtime 未变 → continue
    读到 EOF（容忍末帧解码失败，offset 不推进到坏帧）
    逐帧解码新增字节 → events[]

    # 只看顶层会话
    if 首行 session.origin == "subagent" or (delegationDepth ?? 0) > 0 → 仅记录 offset，不通知

    # ---- (1) 任务/回合作完成 ----
    for e in events where e.type == "turn/end":
        key = sessionId + ":" + e.seq
        if key in emittedTurnEnds → skip
        emittedTurnEnds.add(key)
        触发通知( kind = e.data.reason.kind )      # completed / aborted / blocked / error / max-tokens
        # 只有 kind=="completed" 才报「完成」，其余报「异常结束」

    # ---- (2) 待批准的请求 ----
    for e in events where e.type == "approval/asked":     seenAskIds.add(e.data.id); 记录 e
    for e in events where e.type == "approval/decided":   seenDecidedIds.add(e.data.id)
    pending = seenAskIds - seenDecidedIds
    for id in pending (新增的):
        触发通知("需要批准", toolName, reason, callId)

    # ---- (3) 可选：待回答的 ask_user_question ----
    openCalls    = { e.data.callId : e  for e.type=="tool/call" }
    answeredCalls= { e.data.message.toolCallId for e.type=="tool/result" }
    for callId in openCalls - answeredCalls where openCalls[callId].name == "ask_user_question":
        触发通知("有提问待回答")

    # ---- (4) 可选：回合是否仍在进行 ----
    inFlight = max(turn of turn/start) 而该 turn 没有 turn/end
```

**去重主键建议用 `(sessionId, seq)`** —— `seq` 连续递增，天然幂等。
**注意 `approval/policy == "never"` 的会话根本不会产生 `approval/asked`**（那些需要批准的操作会被直接自动拒绝，模型会看到 `NEVER_SENTENCE`）。

---

## 3. 审批请求的存储位置

### 3.1 没有独立的待办文件 / 队列

- **`storages/` 里没有审批队列。** 实测 `C:\Users\<你的用户名>\.dsh\storages\` 只有：
  - `workspace.json`（1483 B，storage hub 单元 `workspace`，含 workspaceIds / workspaces 表）
  - `session_projcache\sessions\<sessionId>.json`（4~49 KB）
- **`session_projcache` 是派生的投影缓存，不含审批/回合状态。** 实测 `session-7f4c23a1-….json` 顶层是 `{version:7, record:{identity, rows}}`，`rows` 的键为：
  `title`、`titleInput`、`llmRetry`、`sandboxMode`、`goal`、`tokenUsage`、`contextPressure`、`contextBreakdown` …
  —— **没有 `approval*`、没有 `turn*`**。所以虽然它是**明文 JSON**（比 zstd 易读），但**不能**用于这两类事件。
- **没有任何 sqlite / db 文件**（`session-query-sqlite` 在 web profile 里被显式设为 `path: ':memory:'`, `openAt: never`，见 `dsh-web-app\cordis.patch.yml`）。

### 3.2 它到底存在哪

| 载体 | 位置 | 生命周期 |
|---|---|---|
| **内存态** | `ApprovalService` 的 pending table（`dsh-user-approval`） | 进程内，立即消失 |
| **落盘审计对** | 会话日志的 `approval/asked` + `approval/decided` | **durable，唯一持久记录** |
| **不变式守卫** | `dsh-user-approval\lib\invariant.js:202-215` 强制 asked/decided 成对且**必须在同一个未结束回合内** | — |

不变式原文（`lib/invariant.js`，逐字）：
```js
if (event.type === "approval/asked") {
    if (trace.openTurn === null) fail("approval/asked appended outside any open turn");
    if (event.data.toolName.length === 0) fail("approval/asked toolName must be non-empty");
    if (trace.pending.has(event.data.id)) fail(`approval/asked repeated open id ${...}`);
}
if (event.type === "approval/decided") {
    if (trace.openTurn === null) fail("approval/decided appended outside any open turn");
    if (!trace.pending.has(event.data.id)) fail(`approval/decided has no matching approval/asked for id ${...}`);
    if (!APPROVAL_OUTCOMES.includes(event.data.outcome)) fail(`approval/decided carries unknown outcome ${...}`);
}
```

→ **「有待批准」= 日志里存在一个 `approval/asked` 的 `id`，尚未被同 `id` 的 `approval/decided` 收尾。** 这是唯一权威判定。

### 3.3 界面里的两样东西分别是什么

| UI 文案 | 来源 |
|---|---|
| `Approval policy: ask` | 会话日志的 `approval/policy` 事件（`{"policy":"ask"}`）。值来自 permission preset：`dsh-permission-presets\lib\types\index.js:115-121` 定义了 `'workspace-write': { sandbox:'workspace-write', approval:'ask', … }` 与 `'danger-full-access': { sandbox:'danger-full-access', approval:'never', … }`。渲染它的客户端插件是 `@deepseek-ai/dsh-client-ui-permission-presets`（web profile 行 id `ui-permission`）。 |
| `ask_user_question` | `@deepseek-ai/dsh-tool-ask-user` 提供的**工具**（在 `request/header` 的 tools 数组里可见），服务由 `@deepseek-ai/dsh-user-questions` 提供（`dsh-base\cordis.patch.yml:71-72`）。 |

**Permission preset 相关取值**（`dsh-permission-presets`）：
- `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`
- 保留名：`auto`（`AUTO_PRESET`，live 注册，`sandbox: 'danger-full-access'` + `approval: 'never'`）、`custom`（`CUSTOM_PRESET`，派生态）
- 不变式：`permission/preset` 若 `!== "auto"` 必须在 `ctx.permissionPresets.names` 里

### 3.4 关于 `ask_user_question`（第三类「需要用户」）

**关键发现：`dsh-user-questions` 不写任何专属会话事件。**
`KNOWN_SESSION_EVENT_TYPES`（`dsh-session\lib\types\known-event-types.js`，59 个类型，逐字核对）里**没有** `question/*`。
`dsh-user-questions\README.md` 说明其投影是派生的：
> The `userQuestions` projection derives durable questions from **the tool call, its result, and the eventual reply**; Client claims are not persisted.

→ **判定「有待回答的提问」= 存在 `tool/call` 且 `data.name == "ask_user_question"`，没有同 `data.callId` 的 `tool/result`。**

⚠️ 未验证的边界：README 提到 `askTimed()` 会让 agent 继续干活而问题仍可回答，此时工具可能**已返回 pending 的 `tool/result`** —— 那种情况下这条规则会漏报。我手上没有真实的 `ask_user_question` 调用样例（本次会话未触发），**这一点标记为「已读文档、未见实证」**。

### 3.5 附：`hook/*` 事件也已进目录

`known-event-types.js` 里有 `'hook/invoked'` 与 `'hook/result'`（`dsh-hook-protocol\lib\types\events.d.ts` 定义），形如 `{turn, point, dialect, handlerId, matcher?}` / `{turn, point, handlerId, decision, exitCode?, stderrSummary?, durationMs}`。**只有当 hooks 桥被挂载后才会出现** —— 当前 web profile 没挂。它们也**只在回合内**（"turn-enclosed"）产生，`SessionStart` 不写记录。

---

## 4. 总结建议：最可靠的集成方案（按推荐度排序）

> 你的场景：外部桌面宠物程序要在 **DSH 完成任务** 时念台词、在 **出现待批准请求** 时播语音。

### 🥇 方案 A（**首选**）：轮询会话日志 JSONL(zstd)

**监听什么**
- `C:\Users\<你的用户名>\.dsh\sessions\*\*\session.v4.jsonl.zstd`（建议 glob，别去推导 workspace slug）
- 只读**新增字节**：记住每会话的 `byteOffset`（对齐到帧边界）+ `lastSeq`

**怎么判定**
- 完成：新增 `turn/end` → 通知（`reason.kind`）
- 待批准：`approval/asked` 的 `id` 集合 − `approval/decided` 的 `id` 集合 ≠ ∅
- 去重：`(sessionId, seq)`；过滤 `origin == "subagent"`
- 解码：按 `0xFD2FB528` 逐帧 `zlib.zstdDecompressSync`（Node ≥22.15 / 本机 v24.20.0 可用），容忍末帧失败

**优点**
- ✅ **零改造、不动 DSH、不装任何东西**（本会话已验证可行性）
- ✅ 实测可靠：`approval/asked` 独立落盘，最长 252 s 窗口可被观测
- ✅ 有权威事件契约与不变式保证（asked/decided 必须成对、必须在同一回合）
- ✅ 能同时覆盖子 agent 与顶层会话

**局限**
- ⚠️ 轮询延迟（建议 500 ms~1 s）；不是推送
- ⚠️ `turn/end` 是**每回合**而非「整个任务」；「任务真完成」需自己加启发式
- ⚠️ 仅能看到**已落盘**事件；理论上存在 batching window（实测审批路径总是已 flush）
- ⚠️ DSH 若升级到 session format v5，`session.v4.jsonl.zstd` 文件名/字段会变 —— 需做版本探测
- ⚠️ 看不到「agent 正在思考」的中间态（只有已提交事件）

**建议实现要点**：用 mtime 做快速跳过；解析首行 `session` 头缓存会话分类；把 `turn/end` 与 pending approval 状态持久化，避免重启后重复播报。

---

### 🥈 方案 B（**要真·实时就选它**）：写一个 Cordis 插件挂进 web profile

**监听什么**
在 `C:\Users\<你的用户名>\.dsh\profiles\web\cordis.patch.yml` 里 `- insert:` 一行自己的插件（或直接用现成的桥），插件内：

```ts
ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/end' && event.data.reason.kind === 'completed') notifyDone(session, event)
  if (event.type === 'approval/asked') notifyPendingApproval(session, event)
  if (event.type === 'approval/decided') clearPendingApproval(session, event)
})
// 或者更语义化的两个钩子：
ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => { /* 回合将停 */ })
ctx.on('approval/request', (req, next) => { /* 审批瀑布：可观察、甚至可代答 */ })
```

**优点**
- ✅ **真正的进程内推送**，零延迟、零轮询、零解码
- ✅ `approval/request` 是 waterfall，理论上**不仅能观察，还能代替人类作答**（ACP 就是这么做的）
- ✅ 官方支持：自带 `cordis-plugin-development` 技能文档

**局限**
- ⚠️ 要写插件并装进 profile（需 pnpm/网络；**本会话装不了**）
- ⚠️ 改 profile 后必须**重启 `dsh web`**（且会重写 `cordis.yml`）
- ⚠️ 插件崩溃/异常可能影响 DSH 主进程；须 `try/catch` 包住所有回调
- ⚠️ DSH 升级可能破坏内部 API 兼容（`session/event` 载荷未承诺稳定）
- ⚠️ 官方明确说「bespoke behavior 用原生 Cordis 插件，不用 hooks 协议」—— 所以别绕 hooks

---

### 🥉 方案 C：接 ACP（官方进程外协议，适合做「控制面」）

**监听什么**
`dsh --profile acp`（stdio JSON-RPC）→ 客户端 `initialize` → `session/prompt`。
- **回合完成** = `session/prompt` 的**响应**返回，`{ stopReason }`，取值由 `turnEndToStopReason` 决定：`end_turn` / `max_tokens` / `cancelled`
- **需要批准** = 服务端主动发 `session/request_permission` 请求，`options: [{optionId:"allow-once",kind:"allow_once"},{optionId:"reject-once",kind:"reject_once"}]`，**客户端可自动应答**
- 过程信息 = `session/update` 通知（`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `usage_update` / `config_option_update`）

**优点**
- ✅ **唯一官方、有契约、跨进程**的方案；语义最干净（有明确的 `stopReason` 与 `request_permission`）
- ✅ 审批可以程序化自动批准/拒绝

**局限**
- ⚠️ **它接管会话，不是观察你正在跑的 `dsh web`** —— 必须换成 ACP 模式的独立进程
- ⚠️ 官方是 "automation-only"：**没有** presentation / plan / todo / 标题 / 终端 / elicitation（README 明确 "intentionally exposes only the standard ACP v1 surface"）
- ⚠️ 无 outbound 通知：你必须自己当客户端并保持连接
- ⚠️ 需要 ACP SDK 客户端代码
- 若你的宠物想「旁听现有 Web 会话」→ 此方案不适用；若是「把任务交给 DSH 并等结果」→ 此方案最优

---

### ❌ 不推荐：Claude Code hooks 桥（`Stop` / `PreToolUse`）
`Stop` 确实能在回合将停时跑一条命令（看起来像「完成回调」），但：
- `PermissionRequest` / `PermissionDenied` / `Notification` / `TaskCompleted` **明确不支持** → **无法感知「需要批准」**，直接构不成本需求
- 配置在**进程启动时读一次**、不支持 live reload；命令钩子是**串行阻塞**的，拖慢每一回合
- 默认未挂载，要自己改 profile
- `transcript_path` 永远是空字符串（README 明确），会话日志是 zstd，钩子脚本读不到

### ❌ 不推荐：Web API / WebSocket（`/api/remote.mux`）
技术上可行但脆弱：需要浏览器 cookie 认证 —— 启动 token 只印在 `dsh web` 的 URL 里（`GET /?token=...` 换 cookie），cookie 用 `$DSH_HOME/.credentials.yaml` 里 `client-connection/browser-session` 记录的密钥签名（见 `dsh-client-connection\README.md` L39-41；实测 `http://127.0.0.1:3080/api` 无 cookie 返回 **401**）。这是 UI 内部私有协议（Typert Remote），无稳定性承诺。

---

### 组合建议（针对本项目）

```
主力：方案 A（轮询会话日志）
  ├─ turn/end(completed) → 念台词
  └─ pending approval/asked → 播「您有新的请求请批准~」
备选增强：等有网络/可装包时，升级为方案 B（Cordis 插件）拿实时性
```

方案 A 现在就能落地，且我已用真实的 7 对审批 + 2 个回合的原始数据验证过判据成立。

---

## 5. 未验证 / 风险清单（诚实标注）

1. **`ask_user_question` 的 pending 形态**：规则（开着的 `tool/call`）是**从文档推得**，我手上没有真实调用样例；`askTimed` 返回 pending `tool/result` 的情况会漏报。
2. **batching window**：`approval/asked` 实测总是被 flush，但 checkpoint-policy README 承认存在「未落盘的 batching 窗口」。极端情况下（进程在 ask 后立即被强杀）可能丢。
3. **`session/flush` 的精确触发时机**没有逐行追（只读了 checkpoint-policy 的 README 与 lease 的类型定义）。
4. **ACP 未实跑**（需要换 profile 启动 + ACP SDK 客户端，且本会话不应启动替代服务器）。ACP 的字段全部来自 README + `dsh-acp\lib\index.js` 的逐字代码，未做端到端验证。
5. **web profile 的实际组合树**由 `dsh --dump-config` 才能打印，但该操作会重写 `~/.dsh/profiles/web/cordis.yml`，**我刻意没有执行**；我的结论基于 `dsh-base\cordis.patch.yml` + `dsh-web-app\cordis.patch.yml` 两个文件的直接阅读。
6. **设置持久化位置**：`dsh-settings` 的 storage domain 名是 `'settings'`，推测会落在 `~/.dsh/storages/settings.json`，但该文件**不存在**（无用户覆写），未经实证。

---

## 附录：值得记住的绝对路径

| 用途 | 路径 |
|---|---|
| Web 主会话日志（含 7 对真实审批） | `C:\Users\<你的用户名>\.dsh\sessions\--D-myAIprojects-try_deepseekharness-DesktopPet--\session-<已隐去>\session.v4.jsonl.zstd` |
| 子 agent 会话（含 2 个完整回合） | `C:\Users\<你的用户名>\.dsh\sessions\--D-myAIprojects-try_deepseekharness-DesktopPet--\<id-已隐去>\session.v4.jsonl.zstd` |
| 事件类型总目录（59 个） | `...\@deepseek-ai\dsh-session\lib\types\known-event-types.js` |
| `TurnEndReason` 权威定义 | `...\@deepseek-ai\dsh-session\lib\types\types.d.ts` (L165-210) |
| 审批事件契约 | `...\@deepseek-ai\dsh-user-approval\lib\types\types.d.ts` |
| 审批追加逻辑 | `...\@deepseek-ai\dsh-user-approval\lib\index.js` (L128-144) |
| ACP stopReason 映射 | `...\@deepseek-ai\dsh-acp\lib\index.js` (L539-550) |
| ACP 审批报文 | `...\@deepseek-ai\dsh-acp\lib\index.js` (L1116-1138) |
| hooks 不支持事件清单 | `...\@deepseek-ai\dsh-hooks-claude-code\README.md` (L174) |
| zstd 帧/写锁语义 | `...\@deepseek-ai\dsh-session-persistence-jsonl\lib\types\lease.d.ts` |
| 用户可编辑的插件补丁层 | `C:\Users\<你的用户名>\.dsh\profiles\web\cordis.patch.yml` |
