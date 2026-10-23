// The small HTTP vocabulary this plugin's routes share.
//
// Every route here is served by the host's own web server, which carries no request policy of
// its own ("route owners … enforce their own request policy"), so the rules are repeated per
// route on purpose: a bounded JSON body, an explicit content type, and no caching. Extracted
// when the terminal bridge became the second half of the plugin that needs them; keeping two
// copies of a body reader is how one of them quietly grows a different limit.

/** A body past this is not one of this plugin's small requests. */
export const MAX_JSON_BODY_BYTES = 4096

/**
 * Answer with a JSON payload and no cache.
 * @param response - node:http response.
 * @param code - status code.
 * @param payload - JSON-serializable value.
 */
export function answerJson(response, code, payload) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    // A value that was just read or written must describe this moment, not a cached one.
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * One request header, from a node:http request or a fetch-style request object.
 * @param request - node:http request.
 * @param name - lower-case header name.
 * @returns the header value, or '' when it is absent.
 */
export function requestHeader(request, name) {
  const headers = request === undefined || request === null ? undefined : request.headers
  if (headers === undefined || headers === null) return ''
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

/**
 * Whether a request declares a JSON body.
 *
 * A route that WRITES something (`terminal-cwd`, the bridge's own state) requires this: the
 * host's web server answers no CORS preflight, and `application/json` is not a
 * CORS-safelisted request type, so a cross-site page cannot send it without one — while a form
 * or a `no-cors` fetch cannot set it at all. Same-origin callers already send it.
 * @param request - node:http request.
 * @returns true when the content type is JSON (parameters allowed).
 */
export function isJsonRequest(request) {
  return /^application\/json\s*(?:;|$)/i.test(requestHeader(request, 'content-type'))
}

/**
 * Read one bounded JSON object body.
 * @param request - node:http request.
 * @param limit - largest accepted body, in bytes.
 * @returns `{ value }` with the parsed object, or `{ error }` with a readable refusal.
 */
export function readJsonBody(request, limit = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve) => {
    if (request === null || typeof request.on !== 'function') {
      resolve({ error: '读不到请求体' })
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish({ error: `请求体超过 ${limit} 字节` })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        finish({ error: '请求体是空的' })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        finish({ error: '请求体不是合法 JSON' })
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish({ error: '请求体必须是一个 JSON 对象' })
        return
      }
      finish({ value: parsed })
    })
    request.on('error', () => finish({ error: '读取请求体失败' }))
  })
}
