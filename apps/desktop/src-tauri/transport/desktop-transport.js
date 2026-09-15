/**
 * Renderer transport hooks for the Tauri desktop shell.
 *
 * The shell injects this script as a window initialization script, so it runs
 * before the document's own scripts: unary RPC and
 * Gateway streams then travel over the shell's private framed carrier instead of
 * the loopback HTTP and WebSocket transports a served page uses. `ownsHost`
 * declares that the page owns the Host, so the privileged surface is reachable
 * without a loopback authority.
 *
 * Assets and index injections still load over the `dsh-app` protocol, which is
 * why no bundle transport is provided. The global is defined without a setter,
 * so the transport the Host injects for an Electron-family parent cannot replace
 * it with one whose streams would have to cross a non-streaming URI scheme.
 */
;(function () {
  /**
   * Tauri's IPC internals; resolved on use, because an initialization script may
   * run before the runtime installs them.
   * @returns {object} the Tauri IPC internals.
   */
  function internals() {
    const value = globalThis.__TAURI_INTERNALS__
    if (value === undefined) throw new Error('desktop transport: Tauri IPC is unavailable')
    return value
  }

  const STREAM_PATH = '/.dsh/remote-stream'
  const STREAM_HEADER = 'x-dsh-stream'

  /** One Host response channel: an id plus the callback Rust delivers frames to. */
  function createChannel(handler) {
    return {
      id: internals().transformCallback(handler),
      toJSON() { return '__CHANNEL__:' + String(this.id) },
    }
  }

  /** Request bytes for a body the carrier can send in one payload. */
  async function toBytes(body) {
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
    if (typeof body === 'string') return new TextEncoder().encode(body)
    return null
  }

  /**
   * One Host request: open a stream, forward the body, and answer with a
   * Response whose body streams as the frames arrive.
   * @param {URL|string} input - request URL; the Host routes on its path.
   * @param {RequestInit} [init] - method, headers, body, and abort signal.
   * @returns {Promise<Response>} the Host response.
   */
  async function request(input, init) {
    const options = init === undefined ? {} : init
    const target = new URL(String(input), globalThis.location.href)
    const method = (options.method === undefined ? 'GET' : options.method).toUpperCase()
    const headers = []
    new Headers(options.headers === undefined ? undefined : options.headers).forEach((value, name) => {
      headers.push([name, value])
    })
    const body = options.body === undefined ? null : options.body
    const hasBody = body !== null && method !== 'GET' && method !== 'HEAD'

    let streamId
    let controller
    let settleStart
    let failStart
    const started = new Promise((resolve, reject) => { settleStart = resolve; failStart = reject })
    const stream = new ReadableStream({
      start(value) { controller = value },
      cancel() {
        if (streamId === undefined) return
        internals().invoke('dsh_request_cancel', { streamId: streamId }).catch(() => undefined)
      },
    })

    const onFrame = (frame) => {
      if (frame instanceof ArrayBuffer) {
        controller.enqueue(new Uint8Array(frame))
        return
      }
      switch (frame.kind) {
        case 'start':
          settleStart(new Response(frame.hasBody ? stream : null, {
            status: frame.status,
            headers: frame.headers,
          }))
          return
        case 'end':
          controller.close()
          return
        case 'error':
          // A failure before the metadata has no Response to fail yet.
          if (controller === undefined) failStart(new Error(frame.message))
          else controller.error(new Error(frame.message))
          return
        default:
          return
      }
    }

    try {
      streamId = await internals().invoke('dsh_request_start', {
        args: { url: target.toString(), method: method, headers: headers, hasBody: hasBody },
        onFrame: createChannel(onFrame),
      })
    } catch (error) {
      failStart(error instanceof Error ? error : new Error(String(error)))
      throw error
    }

    if (options.signal !== undefined) {
      const abort = () => {
        internals().invoke('dsh_request_cancel', { streamId: streamId }).catch(() => undefined)
        controller.error(new DOMException('The request was aborted', 'AbortError'))
      }
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }

    if (hasBody) {
      const bodyHeaders = { headers: { [STREAM_HEADER]: String(streamId) } }
      try {
        const bytes = await toBytes(body)
        if (bytes !== null) {
          await internals().invoke('dsh_request_body', bytes, bodyHeaders)
        } else {
          const reader = body.getReader()
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            await internals().invoke('dsh_request_body', next.value, bodyHeaders)
          }
        }
        await internals().invoke('dsh_request_end', { streamId: streamId })
      } catch (error) {
        internals().invoke('dsh_request_cancel', { streamId: streamId }).catch(() => undefined)
        controller.error(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    }

    return started
  }

  /**
   * Decoded Gateway stream over the same carrier: the Host answers the stream
   * endpoint with newline-delimited JSON.
   * @param {string} endpoint - Gateway endpoint name.
   * @param {unknown} payload - endpoint payload.
   * @param {AbortSignal} signal - cancels the stream.
   * @returns {AsyncIterable<unknown>} decoded stream values.
   */
  async function* openStream(endpoint, payload, signal) {
    const response = await request(STREAM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: endpoint, payload: payload }),
      signal: signal,
    })
    if (!response.ok || response.body === null) {
      throw new Error('desktop stream transport failed: HTTP ' + String(response.status))
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    for (;;) {
      const next = await reader.read()
      pending += decoder.decode(next.value === undefined ? new Uint8Array() : next.value, { stream: !next.done })
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line !== '') yield JSON.parse(line)
      }
      if (next.done) break
    }
    if (pending !== '') yield JSON.parse(pending)
  }

  Object.defineProperty(globalThis, '__DSH_TRANSPORT__', {
    value: { ownsHost: true, fetch: request, openStream: openStream },
    writable: false,
    configurable: false,
    enumerable: true,
  })
})()
