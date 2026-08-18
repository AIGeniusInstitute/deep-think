// SSRF 安全工具：URL 校验 + 内网/loopback hostname 识别。
//
// 在多处需要拒绝用户提交的 URL（init_git_url、skills install URL 等）指向内网
// 或 cloud-metadata 的场景下复用，避免每个调用点各自实现一份正则。

import net from 'net';
import dns from 'dns';

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

/**
 * DNS 解析函数签名，返回该 hostname 的全部 A / AAAA 地址。抽成参数是为了
 * 让单测不依赖真实网络。
 */
export type DnsLookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: DnsLookupFn = async (hostname) => {
  const records = await dns.promises.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return records.map((r) => r.address);
};

/**
 * 安全 URL 校验（含 DNS 解析）：在 `validateSafeHttpsUrl` 的字面量校验之上，
 * 再把 hostname 解析成 IP 并逐条判定，堵住"域名 A 记录指向内网"这条绕过路径
 * （例如攻击者把 evil.example.com 解析到 169.254.169.254 / 100.100.100.200）。
 *
 * 返回 null = 通过；返回 string = 拒绝原因。
 *
 * 两点必须说清楚，避免过度承诺：
 *
 *  1. **fail-closed**：DNS 解析失败 / 无记录一律拒绝。无法证明目标是公网，
 *     就不放行。若部署在只有 HTTP(S)_PROXY 出网、本机无 DNS 的环境里，
 *     这里会拒绝，需要给容器配可用的 resolver。
 *  2. **不能根治 DNS rebinding**：真正发起请求的是下游的 `npx` / `git`，
 *     它们会各自重新解析一次域名（TOCTOU）。本校验把攻击面从"填个域名就行"
 *     收窄到"必须在校验与取用之间精确翻转 DNS 应答"，是纵深防御的一层，
 *     不是唯一一层。彻底封堵需要在出站连接层面（socket 级 IP 校验 / 出网
 *     代理白名单）处理。
 */
export async function validateSafeHttpsUrlWithDns(
  raw: string,
  opts?: {
    maxLength?: number;
    allowHttp?: boolean;
    /** 注入用（单测）。默认走 dns.promises.lookup。 */
    lookup?: DnsLookupFn;
  },
): Promise<string | null> {
  const lexical = validateSafeHttpsUrl(raw, opts);
  if (lexical) return lexical;

  // validateSafeHttpsUrl 已经保证这里可以解析成功
  const hostname = new URL(raw).hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');

  // 字面量 IP 已由 validateSafeHttpsUrl 判过，无需再解析一次
  if (net.isIP(hostname)) return null;

  let addresses: string[];
  try {
    addresses = await (opts?.lookup ?? defaultLookup)(hostname);
  } catch {
    return `DNS resolution failed for ${hostname}`;
  }
  if (addresses.length === 0) {
    return `DNS resolution returned no records for ${hostname}`;
  }
  for (const addr of addresses) {
    if (isPrivateHostname(addr)) {
      return `Hostname resolves to a private/internal address (${hostname} -> ${addr})`;
    }
  }
  return null;
}
