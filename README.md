# qoder-daily-claim

自动领取 Qoder CN 权益中心「每天领 100 Credits」。

以 Qoder skill 形式分发：安装后可由 agent 直接调用，也可以在 Windows 上创建计划任务，每天自动领取。脚本零第三方依赖，只使用 Node.js 内置模块。

- 官方活动说明：<https://docs.qoder.cn/events/100credits>

## 特性

- 读取本机 Qoder CN 登录态，调用官方活动接口领取可领的 Credits
- 幂等：重复调用返回 `replayed: true`，不会重复发放
- 今日已领取检测：成功领取后在 skill 目录的 `checkin-logs/` 写入记录，同一天再次运行直接跳过
- 自动筛选 `CLAIM_BENEFIT` + `CREDITS` + `CLAIMABLE` 且处于活动窗口内的活动
- 领取后查询奖励状态复核 `amount` / `grantId`
- 日志与最近一次运行状态本地留存，便于排障
- 新版本提醒：每天最多检查一次 GitHub Release，发现新版本时提示更新
- Windows 计划任务支持 `StartWhenAvailable`，错过时间会补跑

## 安全边界

- 只读本机 Qoder CN 的登录态文件；令牌只在运行时解密到内存，**不打印、不写入仓库、不上传**
- 只调用 Qoder 官方接口（活动列表、领取、奖励状态）
- 不主动刷新令牌：外部刷新会轮换令牌并可能导致桌面端掉线；过期后请在客户端重新登录
- 仅适用于个人账号；企业订阅账号不参与该活动
- 登录态依赖 Windows DPAPI，计划任务必须与 Qoder CN 使用同一个 Windows 用户运行

## 前置条件

1. Windows 10/11
2. Node.js 18+（需要内置 `fetch`）
3. 已安装并登录 Qoder CN 桌面端

## 安装

### 方式一：一键安装（推荐）

在仓库根目录执行，默认同时安装 skill 和每日计划任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

也可以直接从 GitHub 运行，无需先克隆仓库：

```powershell
$tmp = Join-Path $env:TEMP 'qoder-install.ps1'
irm https://raw.githubusercontent.com/875778261/qoder-daily-claim/main/install.ps1 -OutFile $tmp
powershell -NoProfile -ExecutionPolicy Bypass -File $tmp
```

常用参数：

```powershell
# 只安装 skill，不创建计划任务
.\install.ps1 -InstallTask:$false

# 自定义任务名和运行时间（本地时间，建议避开 10:00 整点）
.\install.ps1 -At 10:10 -TaskName QoderAutoCheckin

# 计划任务静默运行，不保留控制台窗口（默认保留窗口）
.\install.ps1 -NoWindow

# 卸载 skill 和计划任务
.\install.ps1 -Uninstall
```

安装目标为 `%USERPROFILE%\.qoder-cn\skills\qoder-daily-claim`。

### 方式二：手动复制

```powershell
Copy-Item -Recurse -Force .\skills\qoder-daily-claim "$env:USERPROFILE\.qoder-cn\skills\"
```

### 方式三：Release 压缩包

从 Releases 下载 `qoder-daily-claim.zip` 或 `qoder-daily-claim.skill`，用 Qoder 的本地 skill 安装入口安装，或解压到 `%USERPROFILE%\.qoder-cn\skills\`。

## 使用

```powershell
$script = "$env:USERPROFILE\.qoder-cn\skills\qoder-daily-claim\scripts\claim.js"

# 只查看活动状态，不领取
node $script --dry-run

# 领取今天可领的 Credits
node $script

# 对已领取活动再次调用，验证幂等（可选）
node $script --force
```

如果 Qoder 自动探测不到数据目录，可显式指定：

```powershell
node $script --data-dir "D:\path\to\qoder-data"
# 或设置环境变量 QODER_DATA_DIR
```

默认情况下，成功领取后会在 skill 目录的 `checkin-logs/` 写入当天记录（如 `2026-11-02.json`），同一天再次运行会直接跳过，不再请求接口。`--dry-run` 与 `--force` 会忽略本地记录：

```powershell
# 查看真实活动状态（忽略本地记录）
node $script --dry-run

# 强制重新检查 / 重放领取（忽略本地记录）
node $script --force

# 自定义记录目录
node $script --checkin-dir "D:\path\to\checkin-logs"
# 或设置环境变量 QODER_CHECKIN_DIR
```

退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功：已领取、今日已领过、或暂无可领活动 |
| 1 | 接口或网络错误 |
| 2 | 登录态缺失/过期，需要重新登录 Qoder CN |

安装为 skill 后，也可以在 agent 中使用 `/qoder-daily-claim` 触发。

## 计划任务

安装脚本会在每天 **10:05**（本地时间）创建计划任务，错开 10:00 的开放瞬间。

```powershell
# 查看上次运行结果
Get-ScheduledTaskInfo -TaskName QoderAutoCheckin

# 立即运行一次
Start-ScheduledTask -TaskName QoderAutoCheckin

# 查看任务详情
schtasks /query /tn QoderAutoCheckin /v /fo LIST
```

任务设置为 `StartWhenAvailable`：如果触发时电脑关机或休眠，开机后会补跑。领取记录固定写入 skill 根目录下的 `checkin-logs/`，与计划任务的工作目录无关。

默认情况下，任务会在独立控制台窗口中运行，结束后窗口保留，按 **ESC** 关闭窗口，便于确认当天是否已经执行。领取结果会直接显示在窗口里；计划任务自身的“上次结果”只表示是否成功启动。若不需要窗口，安装时加 `-NoWindow`。

## 日志与状态

- 领取记录：`<skill目录>/checkin-logs/YYYY-MM-DD.json`（活动日按北京时间 10:00 切换）
- 日志：`%LOCALAPPDATA%\qoder-daily-claim\logs\claim-YYYY-MM-DD.log`
- 状态：`%LOCALAPPDATA%\qoder-daily-claim\state.json`

状态文件记录最近一次运行时间、账号、活动结果与 `grantId`，不包含令牌。领取记录同样只包含账号、活动、金额与 `grantId`。

## 版本提醒

每次运行后最多检查一次 GitHub Release（24 小时缓存，2 秒超时，失败静默），发现新版本时在结果下方提示：

```text
发现新版本 v1.2.0（当前 v1.1.1）。

想更新时，复制下面这段发给 agent：
请把 qoder-daily-claim 更新到 v1.2.0：从官方仓库 https://github.com/875778261/qoder-daily-claim/archive/refs/tags/v1.2.0.zip 下载，解压后在其根目录运行 powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1；安装脚本会覆盖安装到全局 skill 目录并重建计划任务。完成后按安装脚本输出的目录确认 VERSION 为 1.2.0，并用 node 运行该目录下的 scripts\claim.js --dry-run 验证。
```

只读 GitHub 公开接口，不发送账号或令牌。设置环境变量 `QODER_NO_UPDATE_CHECK=1` 可关闭检查；检查结果缓存在 `%LOCALAPPDATA%\qoder-daily-claim\update-check.json`。

更新提示由当前安装的旧版本生成，因此只依赖两个稳定契约：仓库根目录的 `install.ps1`，以及 tag 源码包包含完整的 skill 和安装脚本。安装路径、计划任务名由新版本的 `install.ps1` 决定，提示里不再写死；未来如果 skill 改名或迁移目录，由新版本安装脚本负责。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 退出码 2 / 登录态已过期 | 打开 Qoder CN 客户端重新登录，再运行脚本 |
| 活动数量为 0 | 确认请求带 `Cosy-ClientType: 10`；确认账号是个人账号 |
| 401/403 | 登录态失效，重新登录 Qoder CN |
| `DPAPI 解密失败` | 计划任务与客户端不是同一 Windows 用户；用当前用户重新安装任务 |
| 今天已经领过 | 正常。有本地记录时直接跳过；无记录时接口返回 `replayed: true` |
| 想重新检查或重领 | 加 `--force`，或删除 `checkin-logs/<活动日>.json` |
| 10:05 未执行 | 检查电脑是否开机；`StartWhenAvailable` 会在开机后补跑 |
| 找不到登录态 | 用 `--data-dir` 或环境变量 `QODER_DATA_DIR` 指向 Qoder CN 数据目录 |

接口、请求头、登录态格式与活动筛选规则见 [skills/qoder-daily-claim/references/protocol.md](skills/qoder-daily-claim/references/protocol.md)。

## 打包与发布

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

输出到 `dist/`：

- `qoder-daily-claim.zip`
- `qoder-daily-claim.skill`（内容相同，便于 Qoder 安装入口识别）
- 两个文件的 SHA256 一并打印

发布新版本：

1. 更新 `skills/qoder-daily-claim/VERSION`
2. 打 tag 并推送（release workflow 会校验 `VERSION` 与 tag 一致，不一致会直接失败）：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

推送 `v*` tag 后，GitHub Actions 会自动运行打包脚本并创建 Release、上传两个安装包。

## 项目结构

```text
.
├── install.ps1                      # 一键安装 / 卸载
├── scripts/
│   └── package.ps1                  # 打包脚本
├── skills/
│   └── qoder-daily-claim/
│       ├── SKILL.md                 # skill 定义
│       ├── VERSION                  # 当前 skill 版本
│       ├── references/
│       │   └── protocol.md          # 接口与登录态说明
│       └── scripts/
│           ├── claim.js             # 领取逻辑
│           ├── install-task.ps1     # 计划任务安装 / 卸载
│           └── update-check.js      # GitHub Release 版本检查
└── .github/workflows/release.yml    # tag 触发自动发布
```

## License

[MIT](LICENSE)
