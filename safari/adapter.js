/* Safari Userscripts adapter for Bilibili Evolved
 * - Content side: preload GM storage, then inject the script into page context
 * - Page side: sync GM_* shims backed by a snapshot, writes/xhr bridged via MessageChannel
 * - Falls back to running in content context if page injection is blocked (CSP)
 */
(async () => {
  const token = `be${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

  const values = {}
  try {
    const keys = await GM.listValues()
    const list = await Promise.all(keys.map(k => GM.getValue(k)))
    keys.forEach((k, i) => { values[k] = list[i] })
  } catch (e) {
    console.error('[Bilibili Evolved] failed to load storage', e)
  }

  let info = {}
  try {
    info = JSON.parse(JSON.stringify(GM.info))
  } catch (e) {
    console.error('[Bilibili Evolved] failed to read GM.info', e)
  }

  const channel = new MessageChannel()
  const port = channel.port1
  const handles = new Map()
  let storageChain = Promise.resolve()
  const queueStorage = job => {
    storageChain = storageChain.then(job).catch(e => console.error('[Bilibili Evolved] storage error', e))
  }
  const XHR_FIELDS = [
    'readyState', 'response', 'responseHeaders', 'responseType', 'responseURL', 'finalUrl',
    'status', 'statusText', 'timeout', 'lengthComputable', 'loaded', 'total', 'error',
  ]
  const TERMINAL = ['onload', 'onerror', 'onabort', 'ontimeout']
  const pickResponse = r => {
    const out = {}
    if (!r || typeof r !== 'object') return out
    for (const key of XHR_FIELDS) {
      try {
        const v = r[key]
        if (v !== undefined && typeof v !== 'function') out[key] = v
      } catch (e) { /* ignore inaccessible fields */ }
    }
    try {
      if (typeof r.responseText === 'string') out.responseText = r.responseText
    } catch (e) { /* responseText throws for non-text types */ }
    if (typeof Document !== 'undefined' && out.response instanceof Document) {
      out.response = { __document: new XMLSerializer().serializeToString(out.response) }
    }
    if (out.finalUrl === undefined && out.responseURL !== undefined) out.finalUrl = out.responseURL
    return out
  }
  const postEvent = (id, name, response, upload = false) => {
    try {
      port.postMessage({ type: 'xhrEvent', id, name, upload, response })
    } catch (e) {
      // non-cloneable payload, drop response body
      port.postMessage({ type: 'xhrEvent', id, name, upload, response: { ...response, response: null } })
    }
  }
  port.onmessage = ({ data }) => {
    if (!data || typeof data !== 'object') return
    switch (data.type) {
      case 'set':
        queueStorage(() => GM.setValue(data.key, data.value))
        break
      case 'delete':
        queueStorage(() => GM.deleteValue(data.key))
        break
      case 'xhr': {
        const { id, details, callbacks, uploadCallbacks } = data
        const wanted = new Set(callbacks)
        // Userscripts does not default to GET when method is omitted
        const req = { method: 'GET', ...details }
        for (const name of new Set([...callbacks, ...TERMINAL])) {
          req[name] = r => {
            if (TERMINAL.includes(name)) handles.delete(id)
            postEvent(id, name, pickResponse(r))
            if (TERMINAL.includes(name) && !wanted.has(name)) postEvent(id, '__done', {})
          }
        }
        if (uploadCallbacks.length > 0) {
          req.upload = {}
          for (const name of uploadCallbacks) {
            req.upload[name] = e => postEvent(id, name, pickResponse(e), true)
          }
        }
        try {
          handles.set(id, GM_xmlhttpRequest(req))
        } catch (e) {
          postEvent(id, 'onerror', { error: String(e), status: 0, readyState: 4 })
        }
        break
      }
      case 'abort':
        handles.get(data.id)?.abort?.()
        handles.delete(data.id)
        break
      default:
        break
    }
  }

  const cfg = { token, values, info }
  const marker = `data-${token}`
  let injected = false
  try {
    const script = document.createElement('script')
    script.textContent = `(${bilibiliEvolvedMain})(${JSON.stringify(cfg)});`
    ;(document.head || document.documentElement).appendChild(script)
    script.remove()
    injected = document.documentElement.hasAttribute(marker)
  } catch (e) {
    console.error('[Bilibili Evolved] page injection failed', e)
  }
  if (injected) {
    document.documentElement.removeAttribute(marker)
    window.postMessage({ beSafariToken: token }, '*', [channel.port2])
  } else {
    console.warn('[Bilibili Evolved] page injection blocked, running in content context')
    bilibiliEvolvedMain(cfg, channel.port2)
  }
})()

function bilibiliEvolvedMain(cfg, directPort) {
  document.documentElement.setAttribute(`data-${cfg.token}`, '')
  let port = null
  const outbox = []
  const send = msg => {
    if (port) port.postMessage(msg)
    else outbox.push(msg)
  }
  const pending = new Map()
  const onPortMessage = ({ data }) => {
    if (!data || data.type !== 'xhrEvent') return
    const details = pending.get(data.id)
    if (!details) return
    const response = data.response || {}
    if (response.response && typeof response.response === 'object' && '__document' in response.response) {
      response.response = new DOMParser().parseFromString(response.response.__document, 'text/html')
    }
    if (details.context !== undefined) response.context = details.context
    if (['onload', 'onerror', 'onabort', 'ontimeout', '__done'].includes(data.name)) pending.delete(data.id)
    const target = data.upload ? details.upload : details
    const handler = target?.[data.name]
    if (typeof handler === 'function') {
      try {
        handler.call(details, response)
      } catch (e) {
        console.error(e)
      }
    }
  }
  const attachPort = p => {
    port = p
    port.onmessage = onPortMessage
    outbox.splice(0).forEach(msg => port.postMessage(msg))
  }
  if (directPort) {
    attachPort(directPort)
  } else {
    const onMessage = e => {
      if (e.source !== window || !e.data || e.data.beSafariToken !== cfg.token || !e.ports?.[0]) return
      e.stopImmediatePropagation()
      window.removeEventListener('message', onMessage, true)
      attachPort(e.ports[0])
    }
    window.addEventListener('message', onMessage, true)
  }

  const store = cfg.values || {}
  const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const GM_getValue = (key, defaultValue) => (Object.prototype.hasOwnProperty.call(store, key) ? copy(store[key]) : defaultValue)
  const GM_setValue = (key, value) => {
    const v = copy(value)
    if (v === undefined) return GM_deleteValue(key)
    store[key] = v
    send({ type: 'set', key, value: v })
  }
  const GM_deleteValue = key => {
    delete store[key]
    send({ type: 'delete', key })
  }
  const GM_listValues = () => Object.keys(store)
  // Userscripts has no updater hook for this adapted build, keep scriptUpdateURL empty
  const GM_info = { ...cfg.info, scriptUpdateURL: undefined }
  let xhrId = 0
  const GM_xmlhttpRequest = details => {
    const id = ++xhrId
    const plain = {}
    const callbacks = []
    const uploadCallbacks = []
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === 'function') callbacks.push(key)
      else if (key === 'upload' && value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) if (typeof v === 'function') uploadCallbacks.push(k)
      } else if (key !== 'context') plain[key] = value
    }
    pending.set(id, details)
    try {
      send({ type: 'xhr', id, details: plain, callbacks, uploadCallbacks })
    } catch (e) {
      pending.delete(id)
      setTimeout(() => details.onerror?.({ error: String(e), status: 0, readyState: 4 }))
    }
    return {
      abort() {
        if (!pending.has(id)) return
        send({ type: 'abort', id })
        const d = pending.get(id)
        pending.delete(id)
        d.onabort?.({ status: 0, readyState: 4 })
      },
    }
  }
  let menuId = 0
  const GM_registerMenuCommand = () => ++menuId
  const GM_unregisterMenuCommand = () => {}
  const unsafeWindow = window

  // The bundle assigns its own Vue to window.Vue on startup and later reads the bare `Vue`
  // global, but bilibili pages assign their own Vue to window.Vue afterwards, which breaks
  // reactivity in lazily created panels. Capture the bundle's assignment into this local
  // binding (which shadows the global for the bundle and direct-eval'd features) and keep
  // window.Vue untouched for the page.
  let Vue
  try {
    const pageVue = Object.getOwnPropertyDescriptor(window, 'Vue')
    const restore = () => {
      if (pageVue) {
        Object.defineProperty(window, 'Vue', pageVue)
      } else {
        delete window.Vue
      }
    }
    const captureVue = value => {
      Vue = value
      restore()
    }
    Object.defineProperty(window, 'Vue', {
      configurable: true,
      enumerable: pageVue?.enumerable ?? true,
      get: () => (pageVue && ('value' in pageVue ? pageVue.value : pageVue.get?.call(window))),
      set: captureVue,
    })
    // Init runs in microtasks; never leave the trap installed beyond that
    setTimeout(() => {
      if (Object.getOwnPropertyDescriptor(window, 'Vue')?.set === captureVue) {
        restore()
      }
    })
  } catch (e) {
    console.error('[Bilibili Evolved] failed to isolate Vue', e)
  }

  // Keep lodash and `_` private to the bundle: lodash attaches itself to window._ and the
  // bundle defines a non-configurable window._ getter, both of which would leak into the page.
  const pageUnderscore = Object.getOwnPropertyDescriptor(window, '_')
  const restoreUnderscore = () => {
    if (pageUnderscore) {
      Object.defineProperty(window, '_', pageUnderscore)
    } else {
      delete window._
    }
  }
  const lodash = (() => {
    try {
      // shadow AMD/CommonJS globals so lodash always attaches to window._
      ;(function (define, module, exports) {
  /*@@LODASH@@*/
      }).call(window)
      return window._
    } catch (e) {
      console.error('[Bilibili Evolved] failed to load lodash', e)
      return undefined
    } finally {
      restoreUnderscore()
    }
  })()
  const _ = lodash

  // The bundle's synchronous startup runs `Object.defineProperty(window, "_", ...)`; skip only
  // that call while the bundle body executes synchronously.
  const { defineProperty } = Object
  Object.defineProperty = function (target, key, descriptor) {
    if (target === window && key === '_') {
      return target
    }
    return defineProperty.call(this, target, key, descriptor)
  }
  try {
  /*@@MAIN@@*/
  } catch (e) {
    console.error('[Bilibili Evolved] init failed', e)
  } finally {
    Object.defineProperty = defineProperty
  }
}
