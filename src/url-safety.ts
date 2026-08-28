// SSRF 安全工具：URL 校验 + 内网/loopback hostname 识别。
//
// 在多处需要拒绝用户提交的 URL（init_git_url、skills install URL 等）指向内网
// 或 cloud-metadata 的场景下复用，避免每个调用点各自实现一份正则。

import net from 'net';
import { lookup } from 'node:dns/promises';

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local — covers AWS/GCP/Azure/华为云 cloud-metadata
  // 169.254.169.254 与腾讯云 169.254.0.23)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0
  if (a === 0) return true;
  // 100.64.0.0/10 (RFC 6598 CGNAT)。这一段看上去像公网地址，但它是
  // 运营商 / 云厂商的内部共享地址段，且阿里云 ECS 把元数据服务
  // 放在 100.100.100.200、内网 DNS 放在 100.100.2.136/138。不封这段
  // 等于在阿里云上完全不防 metadata SSRF。
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 (RFC 6890 IETF 协议专用，含 192.0.0.8 dummy address)
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 198.18.0.0/15 (RFC 2544 基准测试专用)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含 255.255.255.255 广播）
  if (a >= 224) return true;
  return false;
}

/**
 * 检查 hostname 是否为内网 / 非公网可路由地址（SSRF 防护）。
 * 拒绝 127.x、10.x、172.16-31.x、192.168.x、169.254.x、100.64-127.x (CGNAT)、
 * 192.0.0.x、198.18-19.x、224.x 以上（组播 + 保留 + 广播）、
 * ::1、fc00::/7、fe80::/10 等。
 *
 * 注意：本函数只做**字面量**判定。传入域名时永远返回 false —— 域名的
 * A/AAAA 记录可以指向内网。需要覆盖这条路径请用
 * `validateSafeHttpsUrlWithDns()`。
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  // 去除 IPv6 方括号 + 去除 FQDN trailing dot（new URL('https://localhost./')
  // 把 hostname 留成 'localhost.'，原始 endsWith('.localhost') 不命中）
  const stripped = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const lower = stripped.toLowerCase();
  // localhost 变体（已剥离 trailing dot）
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  if (net.isIPv6(stripped)) {
    if (lower === '::1' || lower === '::') return true;
    // fc00::/7 (unique local) 整段 + fe80::/10 (link-local)。fc00 / fd00 都算
    // ULA。fe80::/10 的 high 10 bits = 1111111010，所以第二字节范围 0x80-0xbf —
    // 即第二个 hex 字符是 8/9/a/b。原实现 startsWith('fe80') 漏了 fe81…febf。
    if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    // ::ffff:127.0.0.1 (dotted form) — 直接复用 IPv4 判定
    if (lower.startsWith('::ffff:') && lower.includes('.')) {
      const ipv4Part = lower.slice(7);
      return isPrivateIPv4(ipv4Part);
    }
    // ::ffff:7f00:1 (hex form) — Node URL 解析后会规范化成这种形态。
    // 把后两组 16-bit hex 拼回 IPv4 dotted decimals 再判一次。
    {
      const m = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const a = parseInt(m[1], 16);
        const b = parseInt(m[2], 16);
        const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
        return isPrivateIPv4(dotted);
      }
    }
    // ::a.b.c.d (IPv4-compatible, 已 deprecated 但 Node 仍解析)
    {
      const m = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const a = parseInt(m[1], 16);
        const b = parseInt(m[2], 16);
        if (a !== 0 && a !== 0xffff) {
          const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
          if (isPrivateIPv4(dotted)) return true;
        }
      }
    }
    // 6to4 (2002:abcd:efgh::/16) — encode IPv4 in second/third hextet
    if (lower.startsWith('2002:')) {
      const m = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
      if (m) {
        const a = parseInt(m[1], 16);
        const b = parseInt(m[2], 16);
        const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
        if (isPrivateIPv4(dotted)) return true;
      }
    }
    return false;
  }

  if (net.isIPv4(stripped)) {
    return isPrivateIPv4(stripped);
  }

  return false;
}

/**
 * 安全 URL 校验：HTTPS-only + 拒绝指向内网 hostname。
 * 返回 null = 通过；返回 string = 拒绝原因。
 */
export function validateSafeHttpsUrl(
  raw: string,
  opts?: { maxLength?: number; allowHttp?: boolean },
): string | null {
  const maxLength = opts?.maxLength ?? 2000;
  if (!raw || raw.length > maxLength) return `URL too long (max ${maxLength})`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (opts?.allowHttp) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Only http(s) URLs are allowed';
    }
  } else if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are allowed';
  }
  if (isPrivateHostname(parsed.hostname)) {
    return `Hostname not allowed (private/link-local): ${parsed.hostname}`;
  }
  return null;
}

// --- DNS 解析校验 -----------------------------------------------------------
//
// 本节的 API 有意与上游 happyclaw（github.com/riba2534/happyclaw，MIT）的
// src/url-safety.ts 保持一致：相同函数名、相同签名、相同的「抛异常而非返回
// reason 字符串」语义。DeepThink 是 happyclaw 的 fork，对齐后这个文件在后续
// 同步上游时不会冲突，也便于将来一并接入上游的 safe-git-proxy —— 它在连接期
// 把 socket 钉到刚校验过的 IP，才是 DNS rebinding 的真正收口。
//
// 相对上游的唯一增量是可选的第三个参数 lookupFn（用于单测注入）。它是可选的，
// 不改变上游任何调用点的签名。上游这两个函数目前没有测试覆盖，本文件补上。

export interface ResolvedPublicAddress {
  address: string;
  family: 4 | 6;
}

/** 注入用（单测）。默认走 node:dns/promises 的 lookup。 */
export type DnsLookupFn = (
  hostname: string,
) => Promise<ResolvedPublicAddress[]>;

const defaultLookup: DnsLookupFn = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

/**
 * 解析并校验 hostname 的每一个地址，返回调用方可以直接连接、无需二次解析的
 * 确切 IP 列表 —— 这是收口 DNS rebinding TOCTOU 窗口所需的连接期原语。
 *
 * 解析失败、无记录、或任一地址落在内网/link-local 都会抛出 Error。抛异常而不
 * 是返回字符串，是为了让调用方漏判时直接中断后续网络请求，而不是静默放行。
 */
export async function resolvePublicAddresses(
  hostname: string,
  label = 'Hostname',
  lookupFn: DnsLookupFn = defaultLookup,
): Promise<ResolvedPublicAddress[]> {
  // new URL('https://[::1]/').hostname 会保留方括号，dns.lookup 不认；
  // 同时去掉 FQDN 结尾的点。
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  let addresses: ResolvedPublicAddress[];
  try {
    addresses = await lookupFn(normalized);
  } catch {
    throw new Error(`${label} could not be resolved`);
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateHostname(address))
  ) {
    throw new Error(`${label} resolves to a private or link-local address`);
  }
  return addresses;
}

/**
 * 只校验不取地址的薄封装。调用方应先用 validateSafeHttpsUrl() /
 * isPrivateHostname() 做字面量校验（更快，且填内网字面 IP 时不依赖网络即可拒绝）。
 */
export async function assertResolvesToPublicAddress(
  hostname: string,
  label = 'Hostname',
  lookupFn: DnsLookupFn = defaultLookup,
): Promise<void> {
  await resolvePublicAddresses(hostname, label, lookupFn);
}
