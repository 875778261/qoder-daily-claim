---
name: qoder-daily-claim
description: 自动领取 Qoder CN 权益中心「每天领 100 Credits」。读取本机 Qoder CN 登录态，调用官方活动接口领取可领的 Credits，并可用 Windows 计划任务每天自动运行。当用户说 Qoder 自动签到、自动领取 Qoder 积分、领 100 Credits、Qoder 每日打卡、检查 Qoder 领取状态、安装/卸载 Qoder 签到任务时使用。
---

# Qoder 每日领取 100 Credits

在 Windows 上自动完成 Qoder CN「权益中心」的每日 Credits 领取。

## 安全边界

- 只读本机 Qoder CN 的登录态文件，令牌只在运行时解密到内存，**绝不打印、绝不写入仓库、绝不上传**。
- 只调用 Qoder 官方接口：活动列表、领取、奖励状态查询。
- 领取接口是幂等的：重复调用返回 `replayed: true`，不会重复发积分。
- 不主动刷新令牌。外部刷新会轮换令牌并可能导致桌面端掉线；令牌过期时让用户重新登录桌面端。
- 仅适用于个人账号；企业订阅账号不参与该活动。

## 前置条件

1. Windows，且已安装并登录 Qoder CN 桌面端。
2. Node.js 18+（需要内置 `fetch`）。
3. 计划任务必须与 Qoder CN 使用同一个 Windows 用户运行，否则 DPAPI 无法解密登录态。

## 运行

以下命令在 `qoder-daily-claim` 目录下执行。

```bash
# 只查看活动状态，不领取
node scripts/claim.js --dry-run

# 领取今天可领的 Credits
node scripts/claim.js

# 对已领取活动再次调用，验证幂等（可选）
node scripts/claim.js --force
```

退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功：已领取、今日已领过、或暂无可领活动 |
| 1 | 接口或网络错误 |
| 2 | 登录态缺失/过期，需要重新登录 Qoder CN |

### 今日已领取检测

每次成功领取（含接口返回已领取）后，会在 skill 目录的 `checkin-logs/` 下写入一条当天记录，例如 `checkin-logs/2026-11-02.json`。同一天再次运行会直接跳过，不再读取登录态或请求接口。

- 活动日按北京时间 10:00 切换：10:00 前仍视为前一天的轮次。
- `--dry-run` 和 `--force` 会忽略本地记录，强制查询接口。
- 记录目录可用 `--checkin-dir <目录>` 或环境变量 `QODER_CHECKIN_DIR` 修改。
- 记录包含账号、活动、金额与 `grantId`，不包含令牌。
- 想强制重新检查或重领时，运行 `node scripts/claim.js --force`，或删除当天的记录文件。

## 安装/更新定时任务

默认每天 **10:05**（北京时间）运行，错开 10:00 的开放瞬间：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-task.ps1
```

任务会在独立控制台窗口中运行，结束后**保留窗口**，按 **ESC** 关闭窗口，便于确认当天是否执行。若希望静默运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-task.ps1 -NoWindow
```

自定义时间或任务名：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-task.ps1 -At 10:10 -TaskName QoderAutoCheckin
```

立即运行一次：

```powershell
schtasks /run /tn QoderAutoCheckin
```

卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-task.ps1 -Remove
```

任务设置包含 `StartWhenAvailable`：如果 10:05 时电脑关机或休眠，开机后会补跑。领取记录固定写入 skill 根目录下的 `checkin-logs/`，与计划任务的工作目录无关。

## 查看结果

- 领取记录：`<skill目录>/checkin-logs/YYYY-MM-DD.json`（当天成功领取后生成，用于当天跳过判断）
- 日志：`%LOCALAPPDATA%\qoder-daily-claim\logs\claim-YYYY-MM-DD.log`
- 状态：`%LOCALAPPDATA%\qoder-daily-claim\state.json`（最近一次运行结果、活动、grantId）
- 任务历史：`schtasks /query /tn QoderAutoCheckin /v /fo LIST`

## 版本提醒

每次运行后最多检查一次 GitHub Release（24 小时缓存，2 秒超时，失败静默）。发现新版本时，结果下方会提示：

```text
发现新版本 v1.2.0（当前 v1.1.1）。

想更新时，复制下面这段发给 agent：
请把 qoder-daily-claim 更新到 v1.2.0：从官方仓库 https://github.com/875778261/qoder-daily-claim/archive/refs/tags/v1.2.0.zip 下载，解压后在其根目录运行 powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1，覆盖安装到 $env:USERPROFILE\.qoder-cn\skills\qoder-daily-claim 并重建计划任务 QoderAutoCheckin，然后运行 node "$env:USERPROFILE\.qoder-cn\skills\qoder-daily-claim\scripts\claim.js" --dry-run，确认 VERSION 为 1.2.0。
```

只读公开接口，不发送账号或令牌。设置环境变量 `QODER_NO_UPDATE_CHECK=1` 可关闭。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 退出码 2 / 登录态已过期 | 打开 Qoder CN 客户端重新登录，再运行脚本 |
| 活动数量为 0 | 确认请求带 `Cosy-ClientType: 10`；确认账号是个人账号 |
| 401/403 | 登录态失效，重新登录 Qoder CN |
| `DPAPI 解密失败` | 计划任务与客户端不是同一 Windows 用户；用当前用户重新安装任务 |
| 今天已经领过 | 正常。有本地记录时直接跳过；无记录时接口返回 `replayed: true` |
| 想重新检查或重领 | 加 `--force`，或删除 `checkin-logs/<活动日>.json` |
| 10:05 未执行 | 检查电脑是否开机；任务设置为 `StartWhenAvailable` 会在开机后补跑 |

## 协议参考

接口、请求头、登录态格式与活动筛选规则见 [references/protocol.md](references/protocol.md)。

## 安装到全局 skill 目录

把本 `skills/qoder-daily-claim/` 目录整体复制到 Qoder 的用户级 skill 目录，Windows 默认位置：

```powershell
Copy-Item -Recurse -Force .\skills\qoder-daily-claim "$env:USERPROFILE\.qoder-cn\skills\"
```

也可以直接在仓库根目录运行一键安装脚本（支持 `-Uninstall` 卸载）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Mac/Linux 默认位置为 `~/.qoder-cn/skills/qoder-daily-claim/`（脚本本身仅支持 Windows）。

更新后无需重启已创建的计划任务——任务指向全局 skill 目录下的 `claim.js`；若全局目录换过位置，重新执行一次安装脚本即可。
