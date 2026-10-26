// SSRF 防护的两种强度：严格（默认）/ 宽松。宽松只放行「公网 + 内网混合返回」的域名。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { ssrfBlocked, setSsrpMode, currentSsrpMode, assertPublicUrl } = await import('../src/core/net.js')
const { normalize } = await import('../src/core/config.js')

// 本机代理 DNS 的真实形态：公网 A + IPv6 ULA
const MIXED = ['28.0.0.162', 'fdfe:dcba:9876::96']
const PUBLIC_ONLY = ['28.0.0.162']
const PRIVATE_ONLY = ['192.168.1.10']
const LOOPBACK = ['127.0.0.1']
const METADATA = ['169.254.169.254']

test('配置：默认严格，只接受 strict / loose', () => {
  assert.equal(normalize({}).security.ssrfMode, 'strict')
  assert.equal(normalize({ security: { ssrfMode: 'loose' } }).security.ssrfMode, 'loose')
  assert.equal(normalize({ security: { ssrfMode: '随便写' } }).security.ssrfMode, 'strict')
  assert.equal(normalize({ security: null }).security.ssrfMode, 'strict')
})

test('严格模式：只要有一个内网地址就拒绝', () => {
  assert.equal(ssrfBlocked(MIXED, 'strict'), true, '公网 + ULA → 拒绝')
  assert.equal(ssrfBlocked(PUBLIC_ONLY, 'strict'), false)
  assert.equal(ssrfBlocked(PRIVATE_ONLY, 'strict'), true)
  assert.equal(ssrfBlocked(LOOPBACK, 'strict'), true)
  assert.equal(ssrfBlocked(METADATA, 'strict'), true)
  assert.equal(ssrfBlocked([], 'strict'), true, '解析不出来也拒绝')
})

test('宽松模式：全部是内网才拒绝', () => {
  assert.equal(ssrfBlocked(MIXED, 'loose'), false, '公网 + ULA → 放行（这是它存在的理由）')
  assert.equal(ssrfBlocked(PUBLIC_ONLY, 'loose'), false)
  assert.equal(ssrfBlocked(PRIVATE_ONLY, 'loose'), true)
  assert.equal(ssrfBlocked(LOOPBACK, 'loose'), true)
  assert.equal(ssrfBlocked([], 'loose'), true)
  // 关键：纯内网目标在宽松模式下依然拦得住
  assert.equal(ssrfBlocked(['10.0.0.5'], 'loose'), true)
  assert.equal(ssrfBlocked(['::1'], 'loose'), true)
})

test('注入的模式会生效（面板切换后不用重启）', () => {
  assert.equal(currentSsrpMode(), 'strict', '默认严格')
  assert.equal(ssrfBlocked(MIXED), true)

  setSsrpMode(() => 'loose')
  assert.equal(currentSsrpMode(), 'loose')
  assert.equal(ssrfBlocked(MIXED), false, '切成宽松后，同一个混合结果放行')

  setSsrpMode(() => 'strict')
  assert.equal(currentSsrpMode(), 'strict')
  assert.equal(ssrfBlocked(MIXED), true, '切回严格又拦住')

  setSsrpMode(() => '乱写的值')
  assert.equal(currentSsrpMode(), 'strict', '非 loose 一律当严格')
  setSsrpMode(null)
})

test('两种模式下，字面内网地址都还是拒绝', async () => {
  for (const mode of ['strict', 'loose']) {
    setSsrpMode(() => mode)
    for (const url of ['http://127.0.0.1/x', 'http://192.168.1.10/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://localhost/x', 'file:///etc/passwd']) {
      await assert.rejects(() => assertPublicUrl(url), `${mode} 模式下 ${url} 应该被拦`)
    }
  }
  setSsrpMode(null)
})
