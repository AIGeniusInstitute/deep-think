import { describe, expect, test } from 'vitest';
import {
  isPrivateHostname,
  validateSafeHttpsUrl,
  validateSafeHttpsUrlWithDns,
} from '../src/url-safety.js';

describe('isPrivateHostname', () => {
  describe('IPv4 private ranges', () => {
    test.each([
      ['127.0.0.1', true, '127.0.0.0/8 loopback'],
      ['127.255.255.254', true, '127/8 boundary'],
      ['10.0.0.1', true, '10/8 RFC 1918'],
      ['10.255.255.254', true, '10/8 boundary'],
      ['172.16.0.1', true, '172.16/12 RFC 1918'],
      ['172.31.255.254', true, '172.31 boundary'],
      ['172.15.0.1', false, 'just below 172.16/12'],
      ['172.32.0.1', false, 'just above 172.31'],
      ['192.168.0.1', true, '192.168/16'],
      ['192.168.255.254', true, '192.168 boundary'],
      ['169.254.169.254', true, 'AWS / GCP cloud-metadata'],
      ['169.254.0.1', true, '169.254/16 link-local'],
      ['0.0.0.0', true, '0/8'],
      ['8.8.8.8', false, 'Google DNS'],
      ['1.1.1.1', false, 'Cloudflare DNS'],
      ['203.0.113.1', false, 'TEST-NET (not actually private but routable)'],
      // --- 100.64.0.0/10 CGNAT（本次补齐，之前全部放行） ---
      ['100.100.100.200', true, '阿里云 ECS 元数据服务'],
      ['100.100.2.136', true, '阿里云内网 DNS'],
      ['100.64.0.1', true, 'CGNAT 下边界'],
      ['100.127.255.254', true, 'CGNAT 上边界'],
      ['100.63.255.254', false, 'just below 100.64/10'],
      ['100.128.0.1', false, 'just above 100.127'],
      // --- 其余保留段（本次补齐） ---
      ['192.0.0.8', true, '192.0.0.0/24 IETF 协议专用'],
      ['192.0.1.1', false, 'just outside 192.0.0.0/24'],
      ['198.18.0.1', true, '198.18.0.0/15 基准测试'],
      ['198.19.255.254', true, '198.18/15 上边界'],
      ['198.20.0.1', false, 'just above 198.18/15'],
      ['224.0.0.1', true, '组播下边界'],
      ['239.255.255.255', true, '组播上边界'],
      ['240.0.0.1', true, '保留段'],
      ['255.255.255.255', true, '广播地址'],
      ['223.255.255.254', false, 'just below 224/4，仍是公网'],
    ])('%s → %s (%s)', (host, expected) => {
      expect(isPrivateHostname(host)).toBe(expected);
    });
  });

  describe('IPv6 private / link-local / ULA', () => {
    test.each([
      ['::1', true, 'IPv6 loopback'],
      ['::', true, 'unspecified'],
      // fe80::/10 covers fe80 through febf — was previously broken (only fe80 matched)
      ['fe80::1', true, 'fe80 link-local'],
      ['fe81::1', true, 'fe81 link-local (R3 fix: previously bypassed)'],
      ['fe9f::1', true, 'fe9f link-local'],
      ['fea0::1', true, 'fea0 link-local'],
      ['feaf::1', true, 'feaf link-local'],
      ['febf::1', true, 'febf link-local boundary'],
      ['fec0::1', false, 'fec0 outside fe80::/10'],
      // fc00::/7 covers both fc and fd halves
      ['fc00::1', true, 'fc00 ULA (R3 fix: previously only fd checked)'],
      ['fd00::1', true, 'fd00 ULA'],
      ['fdff:ffff::1', true, 'fdff ULA'],
      ['2001:db8::1', false, 'documentation prefix, treated as public'],
      ['2606:4700:4700::1111', false, 'Cloudflare public DNS'],
    ])('%s → %s (%s)', (host, expected) => {
      expect(isPrivateHostname(host)).toBe(expected);
    });
  });

  describe('IPv4-mapped / IPv4-compatible / 6to4 IPv6 forms', () => {
    test.each([
      ['::ffff:127.0.0.1', true, 'IPv4-mapped dotted form, loopback'],
      ['::ffff:7f00:1', true, 'IPv4-mapped hex form, loopback (R3 fix)'],
      ['::ffff:a9fe:a9fe', true, 'IPv4-mapped hex form, AWS metadata 169.254.169.254 (R3 fix)'],
      ['::ffff:0a00:1', true, 'IPv4-mapped hex form, 10.0.0.1 (R3 fix)'],
      ['::ffff:c0a8:1', true, 'IPv4-mapped hex form, 192.168.0.1'],
      ['::ffff:100.100.100.200', true, 'IPv4-mapped 阿里云元数据（本次补齐）'],
      ['::ffff:6464:64c8', true, 'IPv4-mapped hex 形式的 100.100.100.200'],
      ['::ffff:8.8.8.8', false, 'IPv4-mapped public IP'],
      ['::ffff:0808:808', false, 'IPv4-mapped hex form, 8.8.8.8 public'],
      // 6to4 (2002:abcd:efgh::/16): second + third hextets encode IPv4
      ['2002:7f00:1::', true, '6to4 encoding 127.0.0.0 (R3 fix)'],
      ['2002:a9fe:a9fe::', true, '6to4 encoding 169.254.169.254 (R3 fix)'],
      ['2002:0808:808::', false, '6to4 encoding 8.8.8.8 public'],
    ])('%s → %s (%s)', (host, expected) => {
      expect(isPrivateHostname(host)).toBe(expected);
    });
  });

  describe('localhost variants', () => {
    test.each([
      ['localhost', true],
      ['localhost.', true, 'trailing-dot FQDN (R3 fix: previously bypassed endsWith check)'],
      ['foo.localhost', true],
      ['foo.localhost.', true, 'trailing-dot subdomain'],
      ['', true, 'empty fail-closed'],
    ])('%s → %s', (host, expected) => {
      expect(isPrivateHostname(host)).toBe(expected);
    });
  });

  describe('public hostnames', () => {
    test.each([
      ['example.com', false],
      ['google.com', false],
      ['raw.githubusercontent.com', false],
    ])('%s → false (public)', (host) => {
      expect(isPrivateHostname(host)).toBe(false);
    });
  });
});

describe('validateSafeHttpsUrl', () => {
  test('rejects http:// (HTTPS-only by default)', () => {
    expect(validateSafeHttpsUrl('http://example.com/')).toMatch(/HTTPS/);
  });

  test('accepts http:// when allowHttp=true', () => {
    expect(validateSafeHttpsUrl('http://example.com/', { allowHttp: true })).toBeNull();
  });

  test('rejects javascript: and data: URLs (not parseable as http(s))', () => {
    expect(validateSafeHttpsUrl('javascript:alert(1)')).not.toBeNull();
    expect(validateSafeHttpsUrl('data:text/plain,hello')).not.toBeNull();
  });

  test('rejects malformed URLs', () => {
    expect(validateSafeHttpsUrl('not a url')).toBe('Not a valid URL');
  });

  test('rejects URLs longer than maxLength', () => {
    const long = 'https://example.com/' + 'a'.repeat(2100);
    expect(validateSafeHttpsUrl(long)).toMatch(/too long/);
  });

  test('rejects HTTPS to private hostnames', () => {
    expect(validateSafeHttpsUrl('https://localhost/')).toMatch(/private/);
    expect(validateSafeHttpsUrl('https://127.0.0.1/')).toMatch(/private/);
    expect(validateSafeHttpsUrl('https://[::1]/')).toMatch(/private/);
    expect(validateSafeHttpsUrl('https://169.254.169.254/latest/meta-data/')).toMatch(/private/);
  });

  test('rejects HTTPS to IPv4-mapped hex IPv6 (R3 fix)', () => {
    // new URL('https://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'
    expect(validateSafeHttpsUrl('https://[::ffff:a9fe:a9fe]/')).toMatch(/private/);
  });

  test('rejects HTTPS to 6to4 with private IPv4 (R3 fix)', () => {
    expect(validateSafeHttpsUrl('https://[2002:7f00:1::]/')).toMatch(/private/);
  });

  test('rejects HTTPS to fc00::/7 ULA', () => {
    expect(validateSafeHttpsUrl('https://[fc00::1]/')).toMatch(/private/);
    expect(validateSafeHttpsUrl('https://[fd00::1]/')).toMatch(/private/);
  });

  test('rejects HTTPS to entire fe80::/10 link-local range', () => {
    expect(validateSafeHttpsUrl('https://[fe80::1]/')).toMatch(/private/);
    expect(validateSafeHttpsUrl('https://[fea0::1]/')).toMatch(/private/);
    expect(validateSafeHttpsUrl('https://[febf::1]/')).toMatch(/private/);
  });

  test('rejects trailing-dot localhost', () => {
    expect(validateSafeHttpsUrl('https://localhost./')).toMatch(/private/);
  });

  test('accepts public HTTPS URLs', () => {
    expect(validateSafeHttpsUrl('https://github.com/owner/repo.git')).toBeNull();
    expect(validateSafeHttpsUrl('https://npm.example.com/pkg.tgz')).toBeNull();
  });
});

describe('validateSafeHttpsUrlWithDns', () => {
  const lookupTo =
    (...addrs: string[]) =>
    async () =>
      addrs;

  test('字面量公网 IP 直接放行，不发起 DNS 解析', async () => {
    let called = false;
    const reason = await validateSafeHttpsUrlWithDns('https://8.8.8.8/x', {
      lookup: async () => {
        called = true;
        return [];
      },
    });
    expect(reason).toBeNull();
    expect(called).toBe(false);
  });

  test('字面量内网 IP 仍被字面量校验拦下', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://169.254.169.254/', {
      lookup: lookupTo('8.8.8.8'),
    });
    expect(reason).toMatch(/private/);
  });

  test('域名解析到 AWS/GCP 元数据 → 拒绝（核心修复）', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://evil.example.com/pkg.tgz', {
      lookup: lookupTo('169.254.169.254'),
    });
    expect(reason).toMatch(/resolves to a private\/internal address/);
    expect(reason).toContain('169.254.169.254');
  });

  test('域名解析到阿里云元数据 100.100.100.200 → 拒绝', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://evil.example.com/pkg.tgz', {
      lookup: lookupTo('100.100.100.200'),
    });
    expect(reason).toMatch(/resolves to a private\/internal address/);
  });

  test('多条 A 记录中只要有一条是内网就拒绝（防混合应答绕过）', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://evil.example.com/', {
      lookup: lookupTo('93.184.216.34', '10.0.0.5'),
    });
    expect(reason).toMatch(/10\.0\.0\.5/);
  });

  test('AAAA 记录指向 ULA → 拒绝', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://evil.example.com/', {
      lookup: lookupTo('fd00::1'),
    });
    expect(reason).toMatch(/fd00::1/);
  });

  test('全部解析到公网地址 → 放行', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://github.com/o/r.git', {
      lookup: lookupTo('140.82.121.4', '2606:50c0:8000::153'),
    });
    expect(reason).toBeNull();
  });

  test('DNS 解析失败 → fail-closed 拒绝', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://nx.example.com/', {
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(reason).toMatch(/DNS resolution failed/);
  });

  test('DNS 返回空记录 → fail-closed 拒绝', async () => {
    const reason = await validateSafeHttpsUrlWithDns('https://empty.example.com/', {
      lookup: lookupTo(),
    });
    expect(reason).toMatch(/no records/);
  });

  test('trailing-dot FQDN 在解析前被剥掉', async () => {
    let seen = '';
    await validateSafeHttpsUrlWithDns('https://example.com./', {
      lookup: async (h) => {
        seen = h;
        return ['93.184.216.34'];
      },
    });
    expect(seen).toBe('example.com');
  });

  test('沿用字面量校验的协议/长度规则', async () => {
    expect(
      await validateSafeHttpsUrlWithDns('http://example.com/', {
        lookup: lookupTo('93.184.216.34'),
      }),
    ).toMatch(/HTTPS/);
  });
});
