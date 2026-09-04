// Tier B distributed-primitive verification against real Redis.
// Simulates multiple Pods via independent tokens + child processes.
process.env.REDIS_URL = 'redis://localhost:6380';
const { initRedis, isRedisConnected, acquireOwnership, renewOwnership, releaseOwnership, withOwnership } = await import('../dist/redis-bus.js');

await initRedis();
if (!isRedisConnected()) { console.error('FAIL: Redis not connected'); process.exit(1); }
console.log('Redis connected');

// Clear any prior test keys.
const { createClient } = await import('redis');
const cleanup = createClient({ url: 'redis://localhost:6380' }); await cleanup.connect();
for (const k of ['deepthink:test:im-leader', 'deepthink:test:task1']) await cleanup.del(k);


let pass = 0, fail = 0;
const check = (c, l) => { if (c) { pass++; console.log('  PASS', l); } else { fail++; console.log('  FAIL', l); } }

console.log('\n== B1 IM-leader CAS: only one token owns the lease ==');
const tokenA = 'podA:1', tokenB = 'podB:1';
const a1 = await acquireOwnership('deepthink:test:im-leader', tokenA, 5000);
check(a1 === true, 'podA acquires lease (first)');
const b1 = await acquireOwnership('deepthink:test:im-leader', tokenB, 5000);
check(b1 === false, 'podB fails to acquire (lease held by podA)');

console.log('\n== B1 renew: owner keeps, non-owner fails ==');
const ra = await renewOwnership('deepthink:test:im-leader', tokenA, 5000);
check(ra === true, 'podA renews successfully');
const rb = await renewOwnership('deepthink:test:im-leader', tokenB, 5000);
check(rb === false, 'podB renew fails (not owner)');

console.log('\n== B1 CAS release: non-owner cannot release ==');
await releaseOwnership('deepthink:test:im-leader', tokenB); // should be no-op
const stillOwnedByA = !(await acquireOwnership('deepthink:test:im-leader', tokenB, 5000));
check(stillOwnedByA, 'podB release was no-op (lease still held by podA)');
await releaseOwnership('deepthink:test:im-leader', tokenA); // owner releases
const b2 = await acquireOwnership('deepthink:test:im-leader', tokenB, 5000);
check(b2 === true, 'podB acquires after podA (owner) releases');

console.log('\n== B1 TTL expiry: lease lapses, another acquires ==');
const TTL_KEY = 'deepthink:test:im-leader-ttl';
await cleanup.del(TTL_KEY);
const aTtl = await acquireOwnership(TTL_KEY, tokenA, 1500); // short TTL
check(aTtl === true, 'podA acquires short-TTL lease');
check(!(await acquireOwnership(TTL_KEY, tokenB, 1500)), 'podB still blocked while podA TTL active');
await new Promise((r) => setTimeout(r, 2200)); // wait for TTL
const b3 = await acquireOwnership(TTL_KEY, tokenB, 5000);
check(b3 === true, 'podB acquires after podA TTL lapsed (failover)');

console.log('\n== B3 withOwnership: only one of N concurrent runs fn ==');
let runs = 0;
const results = await Promise.all([
  withOwnership('deepthink:test:task1', 5000, async () => { runs++; return 'A'; }),
  withOwnership('deepthink:test:task1', 5000, async () => { runs++; return 'B'; }),
  withOwnership('deepthink:test:task1', 5000, async () => { runs++; return 'C'; }),
]);
check(runs === 1, `exactly 1 of 3 concurrent calls ran fn (got ${runs})`);
check(results.filter((r) => r !== undefined).length === 1, 'exactly 1 returned a value, 2 got undefined');

console.log(`\nDistributed-primitive (real Redis): ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
