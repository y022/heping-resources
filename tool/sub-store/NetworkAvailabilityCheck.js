/**
 * 节点测活(适配 Surge/Loon 版)
 *
 * 参数
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [url] 检测的 URL
 * - [ua] 请求头 User-Agent
 * - [status] 合法的状态码的正则表达式 默认 204
 * - [method] 请求方法 默认 head
 * - [max_latency] 最大延迟(单位: 毫秒). 超过此延迟的节点视为不可用 默认不限制
 * - [show_latency] 显示延迟 默认不显示
 * - [include_unsupported_proxy] 包含官方/商店版不支持的协议
 * - [keep_incompatible] 保留当前客户端不兼容的协议
 */

async function operator(proxies = [], targetPlatform, env) {
    const $ = $substore
    const {isLoon, isSurge} = $.env
    if (!isLoon && !isSurge) throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)')

    // ── 配置 ──
    const C = {
        method: $arguments.method || 'head',
        keepIncompatible: $arguments.keep_incompatible,
        includeUnsupported: $arguments.include_unsupported_proxy,
        maxLatency: parseFloat($arguments.max_latency || 0),
        showLatency: $arguments.show_latency,
        validStatus: new RegExp($arguments.status || '204'),
        timeout: parseFloat($arguments.timeout || 5000),
        retries: parseFloat($arguments.retries ?? 1),
        retryDelay: parseFloat($arguments.retry_delay ?? 1000),
        concurrency: parseInt($arguments.concurrency || 10),
        target: isLoon ? 'Loon' : 'Surge',
    }

    function safeDecode(raw, fallback) {
        if (!raw) return fallback
        try {
            return decodeURIComponent(raw)
        } catch {
            return raw
        }
    }

    const url = safeDecode($arguments.url,
        'http://connectivitycheck.platform.hicloud.com/generate_204')
    const ua = safeDecode($arguments.ua,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1')
    const validProxies = []

    // ── HTTP 请求(带重试) ──
    async function request(node) {
        let lastError
        for (let i = 0; i <= C.retries; i++) {
            try {
                return await $.http[C.method]({
                    method: C.method,
                    headers: {'User-Agent': ua},
                    url,
                    'policy-descriptor': node,
                    node,
                    timeout: C.timeout,
                })
            } catch (e) {
                lastError = e
                if (i < C.retries) await $.wait(C.retryDelay * (i + 1))
            }
        }
        throw lastError
    }

    // ── 单节点检测 ──
    async function check(proxy) {
        try {
            const node = ProxyUtils.produce([proxy], C.target, undefined, {
                'include-unsupported-proxy': C.includeUnsupported,
            })

            if (!node) {
                if (C.keepIncompatible) validProxies.push(proxy)
                return
            }

            const t0 = Date.now()
            const res = await request(node)
            const latency = Date.now() - t0
            const status = parseInt(res.status || res.statusCode || 200)
            $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)

            if (C.validStatus.test(status) && (!C.maxLatency || latency <= C.maxLatency)) {
                validProxies.push({
                    ...proxy,
                    name: `${C.showLatency ? `[${latency}] ` : ''}${proxy.name}`,
                    _latency: latency,
                })
            } else {
                const reason = !C.validStatus.test(status)
                    ? `状态码 ${status} 不匹配`
                    : `延迟 ${latency}ms 超过限制 ${C.maxLatency}ms`
                $.info(`[${proxy.name}] ${reason}`)
            }
        } catch (e) {
            $.error(`[${proxy.name}] ${e.message ?? e}`)
        }
    }

    // ── 并发执行 ──
    const tasks = proxies.map(p => () => check(p))
    const limit = Math.min(C.concurrency, tasks.length)
    let cursor = 0

    await Promise.all(
        Array.from({length: limit}, async () => {
            while (cursor < tasks.length) await tasks[cursor++]()
        })
    )

    return validProxies
}
