# Qoder CN 每日领取协议参考

验证环境：Qoder CN 0.5.1（Windows），验证日期 2026-11-02。

## 接口

| 动作 | 方法与路径 |
| --- | --- |
| 活动列表 | `GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns` |
| 领取 | `POST https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/{campaignId}/claim` |
| 奖励状态 | `GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/{campaignId}/reward` |

必需请求头：

```text
Authorization: Bearer <accessToken>
Cosy-ClientType: 10
Accept: application/json
```

说明：活动列表在缺少 `Cosy-ClientType` 时会返回空数组；补齐后返回真实活动。机器身份头（`X-Machine-Id` 等）在本机实测不是必需，但客户端本身会携带。

## 登录态

Windows 上 Qoder CN 的数据目录通常为：

```text
%APPDATA%\com.qodercn.app.stable
```

部分安装会把该目录重定向（软链接）到其他磁盘，脚本默认按 `realpath` 解析。若自动探测失败，可用 `--data-dir` 或环境变量 `QODER_DATA_DIR` 显式指定。

关键文件：

- `auth.v1.dat`：Chromium `v10` 格式（`v10` + 12 字节 nonce + 密文 + 16 字节 GCM tag）。
- `Local State`：`os_crypt.encrypted_key`，base64 解码后去掉 `DPAPI` 前缀，用 `CryptUnprotectData`（CurrentUser）得到 32 字节 AES 密钥。

解密后的登录态包含：

```json
{
  "schemaVersion": 1,
  "authenticationContext": "[\"https://qoder.cn\",\"https://openapi.qoder.com.cn\",\"<clientId>\",\"prod\"]",
  "token": "<accessToken>",
  "refreshToken": "<refreshToken>",
  "expiresAt": "<ISO 时间>",
  "refreshTokenExpiresAt": "<ISO 时间>",
  "user": { "id": "...", "name": "...", "email": "", "phone": "", "avatarUrl": "..." }
}
```

注意：

- 令牌只在解密后用于请求头，不落盘、不打印。
- 不要主动调用刷新接口：令牌轮换会让桌面端当前会话失效。过期后让用户在客户端重新登录。
- 计划任务必须与客户端同一 Windows 用户，DPAPI 才能解密。

## 活动筛选与领取

活动列表返回 `campaigns[]`。只处理同时满足以下条件的活动：

- `actionType === "CLAIM_BENEFIT"`
- `benefit.kind === "CREDITS"`
- `claimStatus === "CLAIMABLE"`
- 当前时间在 `startAt` 与 `endAt` 之间（Unix 秒）

领取响应示例：

```json
{
  "grantId": "<grantId>",
  "status": "CLAIMED",
  "replayed": true,
  "benefit": { "kind": "CREDITS", "amount": 100, "validity": { "mode": "RELATIVE_DAYS", "days": 30 } },
  "campaignId": "<campaignId>",
  "campaignKey": "<campaignKey>"
}
```

- `replayed: true` 表示本次是幂等重放，之前已领取，不会重复发放。
- 领取后可用 `/reward` 复核 `status`、`amount`、`grantId`。

## 活动规则（官方）

- 每天 10:00（UTC+8）开放新一轮，至次日 10:00 前可领。
- 每账号每轮 100 通用 Credits，每轮限领一次；错过不补，未领不累计。
- 每笔奖励自领取之日起 30 天有效，可跨天保留。
- 企业订阅账号（团队版、企业标准版、企业专属版）不适用。
- 官方说明：https://docs.qoder.cn/events/100credits

## 客户端内部线索（维护用）

- 活动页：`https://openapi.qoder.com.cn/growth-page/activity-iframe`
- 活动页脚本会通过桌面端桥接发起 `campaign:apiRequest`，最终落到上面的 claim 接口。
- 客户端日志关键字：`[Campaign] 活动 Surface`、`account.getQuotaUsage`、`/sash/api/v2/me/usage`。
- 如果接口变更，优先检查活动页脚本中的 `/sash/api/v1/me/campaigns` 与其 claim 路径。
