(() => {
  'use strict'

  // Keep a long-running/mobile tab bounded. Older durable history remains
  // available from the server after a reload or through pagination.
  const MAX_LIVE_RECORDS = 5000

  const page = document.body.dataset.page
  if (page === 'login') setupLoginPage()
  if (page === 'logs') setupLogsPage()

  function setupLoginPage() {
    const form = byId('login-form')
    const passwordInput = byId('password')
    const submit = byId('login-submit')
    const error = byId('login-error')
    const toggle = byId('toggle-password')

    toggle.addEventListener('click', () => {
      const visible = passwordInput.type === 'text'
      passwordInput.type = visible ? 'password' : 'text'
      toggle.textContent = visible ? 'הצגה' : 'הסתרה'
      passwordInput.focus()
    })

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      error.textContent = ''
      if (!passwordInput.value) {
        error.textContent = 'יש להזין סיסמה.'
        passwordInput.focus()
        return
      }

      submit.disabled = true
      submit.textContent = 'מתחבר…'
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: passwordInput.value })
        })
        // Do not retain the submitted password in the page after the request.
        passwordInput.value = ''
        const payload = await parseJson(response)
        if (response.ok) {
          window.location.replace('/')
          return
        }

        if (response.status === 429) {
          const seconds = Math.max(1, Math.ceil(Number(payload.retryAfterMs || 0) / 1000))
          error.textContent = `בוצעו ניסיונות רבים מדי. אפשר לנסות שוב בעוד ${seconds} שניות.`
        } else {
          error.textContent = 'הסיסמה שגויה.'
        }
      } catch {
        passwordInput.value = ''
        error.textContent = 'לא ניתן להגיע לשרת כרגע.'
      } finally {
        submit.disabled = false
        submit.textContent = 'כניסה'
        passwordInput.focus()
      }
    })
  }

  function setupLogsPage() {
    const elements = {
      instance: byId('instance-select'),
      instanceSummary: byId('instance-summary'),
      streamState: byId('stream-state'),
      logList: byId('log-list'),
      empty: byId('empty-state'),
      resultCount: byId('result-count'),
      loadOlder: byId('load-older'),
      search: byId('search-input'),
      clearSearch: byId('clear-search'),
      levelFilters: byId('level-filters'),
      categoryFilters: byId('category-filters'),
      selectVisible: byId('select-visible'),
      selectionCount: byId('selection-count'),
      copySelected: byId('copy-selected'),
      copyCount: byId('copy-count'),
      copyRecent: byId('copy-recent'),
      logout: byId('logout-button'),
      toast: byId('toast')
    }

    const state = {
      records: [],
      selected: new Set(),
      nextBefore: undefined,
      source: undefined,
      generation: 0,
      nextClientId: 1,
      instanceId: '',
      loadingOlder: false,
      toastTimer: undefined
    }

    elements.instance.addEventListener('change', () => {
      void selectInstance(elements.instance.value)
    })
    elements.search.addEventListener('input', renderAll)
    elements.clearSearch.addEventListener('click', () => {
      elements.search.value = ''
      elements.search.focus()
      renderAll()
    })
    elements.levelFilters.addEventListener('change', renderAll)
    elements.categoryFilters.addEventListener('change', renderAll)
    elements.loadOlder.addEventListener('click', () => void loadOlder())
    elements.selectVisible.addEventListener('change', () => {
      for (const record of filteredRecords()) {
        if (elements.selectVisible.checked) state.selected.add(record.clientId)
        else state.selected.delete(record.clientId)
      }
      renderAll()
    })
    elements.copySelected.addEventListener('click', () => {
      const chosen = state.records.filter((record) => state.selected.has(record.clientId))
      void copyRecords(chosen, 'הרשומות שנבחרו הועתקו.')
    })
    elements.copyRecent.addEventListener('click', () => {
      const requested = clampInteger(elements.copyCount.value, 1, 1000, 20)
      elements.copyCount.value = String(requested)
      const recent = filteredRecords().slice(-requested)
      void copyRecords(recent, `${recent.length} הרשומות האחרונות הועתקו.`)
    })
    elements.logout.addEventListener('click', async () => {
      elements.logout.disabled = true
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      } finally {
        window.location.replace('/login')
      }
    })
    window.addEventListener('beforeunload', closeStream)

    void loadInstances()

    async function loadInstances() {
      try {
        const response = await apiFetch('/api/instances')
        const payload = await parseJson(response)
        if (!response.ok || !Array.isArray(payload.instances)) throw new Error('Invalid response')

        elements.instance.replaceChildren()
        for (const instance of payload.instances) {
          if (!instance || typeof instance.id !== 'string') continue
          const option = document.createElement('option')
          option.value = instance.id
          option.textContent = `${instance.id} · ${statusLabel(instance.status)}`
          option.dataset.status = typeof instance.status === 'string' ? instance.status : ''
          option.dataset.username = typeof instance.username === 'string' ? instance.username : ''
          elements.instance.append(option)
        }

        if (elements.instance.options.length === 0) {
          const option = document.createElement('option')
          option.value = ''
          option.textContent = 'לא נמצאו מופעים'
          elements.instance.append(option)
          elements.instance.disabled = true
          elements.instanceSummary.textContent = 'BotManager לא מחזיק כרגע מופעים פעילים.'
          setStreamState('idle', 'אין מופעים')
          return
        }

        elements.instance.disabled = false
        const remembered = readRememberedInstance()
        if (remembered && Array.from(elements.instance.options).some((item) => item.value === remembered)) {
          elements.instance.value = remembered
        }
        await selectInstance(elements.instance.value)
      } catch (error) {
        if (isAuthRedirect(error)) return
        elements.instanceSummary.textContent = 'טעינת המופעים נכשלה.'
        setStreamState('error', 'שגיאת חיבור')
      }
    }

    async function selectInstance(instanceId) {
      closeStream()
      state.generation += 1
      const generation = state.generation
      state.instanceId = instanceId
      state.records = []
      state.selected.clear()
      state.nextBefore = undefined
      renderAll()
      if (!instanceId) return

      rememberInstance(instanceId)
      updateInstanceSummary()
      setStreamState('idle', 'מתחבר…')
      openStream(instanceId, generation)

      try {
        const payload = await fetchHistory(instanceId)
        if (generation !== state.generation) return
        mergeInitialHistory(payload.entries)
        state.nextBefore = typeof payload.nextBefore === 'string' ? payload.nextBefore : undefined
        renderAll(true)
      } catch (error) {
        if (generation !== state.generation || isAuthRedirect(error)) return
        showToast('טעינת היסטוריית הלוגים נכשלה.')
        renderAll()
      }
    }

    async function fetchHistory(instanceId, before, limit = 200) {
      const query = new URLSearchParams({ limit: String(limit) })
      if (before) query.set('before', before)
      const response = await apiFetch(`/api/logs/${encodeURIComponent(instanceId)}?${query}`)
      const payload = await parseJson(response)
      if (!response.ok || !Array.isArray(payload.entries)) throw new Error('History request failed')
      return payload
    }

    async function loadOlder() {
      if (!state.instanceId || !state.nextBefore || state.loadingOlder) return
      const generation = state.generation
      state.loadingOlder = true
      elements.loadOlder.disabled = true
      elements.loadOlder.textContent = 'טוען…'
      try {
        const payload = await fetchHistory(state.instanceId, state.nextBefore)
        if (generation !== state.generation) return
        const older = payload.entries.filter(isLogEntry).map(createRecord)
        state.records = [...older, ...state.records]
        state.nextBefore = typeof payload.nextBefore === 'string' ? payload.nextBefore : undefined
        renderAll()
      } catch (error) {
        if (!isAuthRedirect(error)) showToast('טעינת רשומות ישנות נכשלה.')
      } finally {
        state.loadingOlder = false
        elements.loadOlder.disabled = false
        elements.loadOlder.textContent = 'טעינת רשומות ישנות'
        updateSummary(filteredRecords())
      }
    }

    function openStream(instanceId, generation) {
      const source = new EventSource(`/api/logs/${encodeURIComponent(instanceId)}/stream`)
      state.source = source
      let hasOpened = false

      source.addEventListener('ready', () => {
        if (generation === state.generation) setStreamState('live', 'מחובר בזמן אמת')
      })
      source.addEventListener('auth-expired', () => {
        source.close()
        window.location.replace('/login')
      })
      source.onopen = () => {
        if (generation !== state.generation) return
        setStreamState('live', 'מחובר בזמן אמת')
        if (hasOpened) void reconcileAfterReconnect(instanceId, generation)
        hasOpened = true
      }
      source.onmessage = (event) => {
        if (generation !== state.generation) return
        try {
          const entry = JSON.parse(event.data)
          if (!isLogEntry(entry)) return
          appendLiveRecord(createRecord(entry))
        } catch {
          // Ignore malformed events; a later valid event can still be rendered.
        }
      }
      source.onerror = () => {
        if (generation !== state.generation) return
        setStreamState('error', 'מתחבר מחדש…')
        // EventSource does not expose the HTTP status from a rejected reconnect.
        // A small authenticated request prevents an expired session from
        // retrying a 401 response forever.
        void apiFetch('/api/instances').catch(() => undefined)
      }
    }

    function closeStream() {
      if (state.source) state.source.close()
      state.source = undefined
    }

    function appendLiveRecord(record) {
      const listWasNearBottom = isNearBottom(elements.logList)
      state.records.push(record)
      if (trimLiveRecords()) {
        renderAll()
        if (listWasNearBottom) elements.logList.scrollTop = elements.logList.scrollHeight
        return
      }
      if (matchesFilters(record)) {
        elements.logList.append(createLogRow(record))
        if (listWasNearBottom) elements.logList.scrollTop = elements.logList.scrollHeight
      }
      const visible = filteredRecords()
      updateSummary(visible)
      updateSelectionState(visible)
    }

    async function reconcileAfterReconnect(instanceId, generation) {
      try {
        const payload = await fetchHistory(instanceId, undefined, 1000)
        if (generation !== state.generation) return
        const recent = payload.entries.filter(isLogEntry).map(createRecord)
        state.records = mergeUnique(state.records, recent).sort((left, right) => {
          const timeDiff = Date.parse(left.entry.timestamp) - Date.parse(right.entry.timestamp)
          return Number.isNaN(timeDiff) || timeDiff === 0
            ? left.clientId - right.clientId
            : timeDiff
        })
        trimLiveRecords()
        renderAll()
      } catch (error) {
        if (!isAuthRedirect(error)) showToast('השלמת פער הלוגים לאחר החיבור מחדש נכשלה.')
      }
    }

    function trimLiveRecords() {
      const overflow = state.records.length - MAX_LIVE_RECORDS
      if (overflow <= 0) return false
      const removed = state.records.splice(0, overflow)
      for (const record of removed) state.selected.delete(record.clientId)
      return true
    }

    function mergeInitialHistory(entries) {
      const history = entries.filter(isLogEntry).map(createRecord)
      state.records = mergeUnique(history, state.records)
    }

    function mergeUnique(first, second) {
      const overlap = new Map()
      for (const record of first) {
        const signature = entrySignature(record.entry)
        overlap.set(signature, (overlap.get(signature) || 0) + 1)
      }
      const merged = [...first]
      for (const record of second) {
        const signature = entrySignature(record.entry)
        const remaining = overlap.get(signature) || 0
        if (remaining > 0) {
          overlap.set(signature, remaining - 1)
          continue
        }
        merged.push(record)
      }
      return merged
    }

    function createRecord(entry) {
      const clientId = state.nextClientId
      state.nextClientId += 1
      return {
        clientId,
        entry,
        searchText: `${entry.level} ${entry.category} ${entry.message} ${safeStringify(entry.meta)}`.toLocaleLowerCase()
      }
    }

    function renderAll(scrollToEnd = false) {
      const visible = filteredRecords()
      const fragment = document.createDocumentFragment()
      for (const record of visible) fragment.append(createLogRow(record))
      elements.logList.replaceChildren(fragment)
      updateSummary(visible)
      updateSelectionState(visible)
      if (scrollToEnd) elements.logList.scrollTop = elements.logList.scrollHeight
    }

    function createLogRow(record) {
      const entry = record.entry
      const row = document.createElement('article')
      row.className = `log-row${state.selected.has(record.clientId) ? ' is-selected' : ''}`
      row.dataset.clientId = String(record.clientId)

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = state.selected.has(record.clientId)
      checkbox.setAttribute('aria-label', `בחירת רשומת ${entry.level}: ${entry.message}`)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(record.clientId)
        else state.selected.delete(record.clientId)
        row.classList.toggle('is-selected', checkbox.checked)
        updateSelectionState(filteredRecords())
      })

      const time = span('log-time', formatTimestamp(entry.timestamp))
      time.title = entry.timestamp
      const level = span(`log-level ${entry.level}`, entry.level.toUpperCase())
      const category = span('log-category', entry.category)
      const message = span('log-message', entry.message)
      row.append(checkbox, time, level, category, message)

      if (entry.meta && Object.keys(entry.meta).length > 0) {
        const meta = document.createElement('pre')
        meta.className = 'log-meta'
        meta.textContent = safeStringify(entry.meta)
        row.append(meta)
      }
      return row
    }

    function filteredRecords() {
      const filter = currentFilter()
      return state.records.filter((record) => matchesFilter(record, filter))
    }

    function matchesFilters(record) {
      return matchesFilter(record, currentFilter())
    }

    function currentFilter() {
      return {
        levels: checkedValues(elements.levelFilters),
        categories: checkedValues(elements.categoryFilters),
        query: elements.search.value.trim().toLocaleLowerCase()
      }
    }

    function matchesFilter(record, filter) {
      return filter.levels.has(record.entry.level) &&
        filter.categories.has(record.entry.category) &&
        (!filter.query || record.searchText.includes(filter.query))
    }

    function updateSummary(visible) {
      const total = state.records.length
      elements.resultCount.textContent = total === visible.length
        ? `${total} רשומות`
        : `${visible.length} מתוך ${total} רשומות`
      elements.empty.hidden = visible.length > 0
      elements.logList.hidden = visible.length === 0
      elements.loadOlder.hidden = !state.nextBefore
    }

    function updateSelectionState(visible) {
      const selectedCount = state.selected.size
      elements.selectionCount.textContent = selectedCount === 0
        ? 'לא נבחרו רשומות'
        : `${selectedCount} רשומות נבחרו`
      elements.copySelected.disabled = selectedCount === 0
      const selectedVisible = visible.filter((record) => state.selected.has(record.clientId)).length
      elements.selectVisible.checked = visible.length > 0 && selectedVisible === visible.length
      elements.selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visible.length
    }

    function updateInstanceSummary() {
      const selected = elements.instance.selectedOptions[0]
      if (!selected) return
      const username = selected.dataset.username
      const status = statusLabel(selected.dataset.status)
      elements.instanceSummary.textContent = username ? `${username} · ${status}` : status
    }

    function setStreamState(kind, text) {
      elements.streamState.className = `stream-state is-${kind}`
      elements.streamState.innerHTML = ''
      const dot = document.createElement('span')
      dot.className = 'state-dot'
      dot.setAttribute('aria-hidden', 'true')
      elements.streamState.append(dot, document.createTextNode(text))
    }

    async function copyRecords(records, successMessage) {
      if (records.length === 0) {
        showToast('אין רשומות להעתקה.')
        return
      }
      try {
        await writeClipboard(records.map((record) => formatForCopy(record.entry)).join('\n'))
        showToast(successMessage)
      } catch {
        showToast('ההעתקה נכשלה. יש לאפשר גישה ללוח ההעתקה.')
      }
    }

    function showToast(message) {
      elements.toast.textContent = message
      elements.toast.classList.add('is-visible')
      window.clearTimeout(state.toastTimer)
      state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2600)
    }
  }

  async function apiFetch(url, init) {
    const response = await fetch(url, { credentials: 'same-origin', ...init })
    if (response.status === 401) {
      window.location.replace('/login')
      const error = new Error('Authentication required')
      error.authRedirect = true
      throw error
    }
    return response
  }

  function isAuthRedirect(error) {
    return Boolean(error && error.authRedirect)
  }

  function readRememberedInstance() {
    try {
      return sessionStorage.getItem('tippybot.instance')
    } catch {
      return null
    }
  }

  function rememberInstance(instanceId) {
    try {
      sessionStorage.setItem('tippybot.instance', instanceId)
    } catch {
      // Storage can be disabled by browser privacy settings; selection still works.
    }
  }

  function isLogEntry(value) {
    return Boolean(value) &&
      typeof value === 'object' &&
      typeof value.timestamp === 'string' &&
      typeof value.level === 'string' &&
      typeof value.category === 'string' &&
      typeof value.message === 'string'
  }

  function checkedValues(container) {
    return new Set(Array.from(container.querySelectorAll('input:checked'), (input) => input.value))
  }

  function formatTimestamp(timestamp) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return timestamp
    return new Intl.DateTimeFormat('he-IL', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date)
  }

  function formatForCopy(entry) {
    const meta = entry.meta && Object.keys(entry.meta).length > 0 ? ` ${safeStringify(entry.meta)}` : ''
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${meta}`
  }

  function safeStringify(value) {
    if (value === undefined) return ''
    try {
      return JSON.stringify(value)
    } catch {
      return '[unserializable]'
    }
  }

  function entrySignature(entry) {
    return `${entry.timestamp}\u0000${entry.level}\u0000${entry.category}\u0000${entry.message}\u0000${safeStringify(entry.meta)}`
  }

  function statusLabel(status) {
    const labels = {
      connecting: 'מתחבר',
      online: 'מחובר',
      reconnecting: 'מתחבר מחדש',
      errored: 'שגיאה'
    }
    return labels[status] || 'מצב לא ידוע'
  }

  function clampInteger(raw, minimum, maximum, fallback) {
    const number = Number(raw)
    if (!Number.isInteger(number)) return fallback
    return Math.min(maximum, Math.max(minimum, number))
  }

  function isNearBottom(element) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 80
  }

  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return
    }

    // LAN deployments often use plain HTTP, where the modern Clipboard API is
    // unavailable. Keep a contained legacy fallback for those browsers.
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.className = 'clipboard-fallback'
    document.body.append(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('Copy command was rejected')
  }

  async function parseJson(response) {
    try {
      return await response.json()
    } catch {
      return {}
    }
  }

  function span(className, text) {
    const element = document.createElement('span')
    element.className = className
    element.textContent = text
    return element
  }

  function byId(id) {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Missing element #${id}`)
    return element
  }
})()
