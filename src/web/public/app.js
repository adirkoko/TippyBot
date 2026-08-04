(() => {
  'use strict'

  // Keep a long-running/mobile tab bounded. Older durable history remains
  // available from the server after a reload or through pagination.
  const MAX_LIVE_RECORDS = 5000
  const THEME_STORAGE_KEY = 'tippybot.theme'
  const ICONS = {
    sun: [
      ['circle', { cx: '12', cy: '12', r: '4' }],
      ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42' }]
    ],
    moon: [['path', { d: 'M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z' }]],
    eye: [
      ['path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z' }],
      ['circle', { cx: '12', cy: '12', r: '2.5' }]
    ],
    eyeOff: [
      ['path', { d: 'm3 3 18 18M10.6 6.1A10.5 10.5 0 0 1 12 6c6 0 9.5 6 9.5 6a15 15 0 0 1-2.1 2.8M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.6M9.9 9.9a3 3 0 0 0 4.2 4.2' }]
    ],
    play: [['path', { d: 'm8 5 11 7-11 7Z' }]],
    stop: [['rect', { x: '6', y: '6', width: '12', height: '12', rx: '2' }]],
    restart: [
      ['path', { d: 'M20 7v5h-5M4 17v-5h5' }],
      ['path', { d: 'M6.1 9a7 7 0 0 1 11.4-2L20 9M4 15l2.5 2a7 7 0 0 0 11.4-2' }]
    ],
    edit: [
      ['path', { d: 'm14.5 5.5 4 4M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10Z' }],
      ['path', { d: 'm13.5 7.5 3 3' }]
    ],
    trash: [['path', { d: 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5' }]]
  }

  setupTheme()
  const page = document.body.dataset.page
  if (page === 'login') setupLoginPage()
  if (page === 'dashboard') setupDashboardPage()
  if (page === 'logs') setupLogsPage()
  if (page === 'bots') setupBotsPage()

  function setupLoginPage() {
    const form = byId('login-form')
    const passwordInput = byId('password')
    const submit = byId('login-submit')
    const error = byId('login-error')
    const toggle = byId('toggle-password')

    toggle.addEventListener('click', () => {
      const visible = passwordInput.type === 'text'
      passwordInput.type = visible ? 'password' : 'text'
      setIconButton(toggle, visible ? 'eye' : 'eyeOff', visible ? 'Show password' : 'Hide password')
      passwordInput.focus()
    })

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      error.textContent = ''
      if (!passwordInput.value) {
        error.textContent = 'Enter a password.'
        passwordInput.focus()
        return
      }

      submit.disabled = true
      submit.textContent = 'Signing in…'
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
          error.textContent = `Too many attempts. Try again in ${seconds} seconds.`
        } else {
          error.textContent = 'Incorrect password.'
        }
      } catch {
        passwordInput.value = ''
        error.textContent = 'The server is currently unavailable.'
      } finally {
        submit.disabled = false
        submit.textContent = 'Sign in'
        passwordInput.focus()
      }
    })
  }

  function setupDashboardPage() {
    const elements = {
      grid: byId('dashboard-grid'),
      empty: byId('dashboard-empty'),
      summary: byId('dashboard-summary'),
      streamState: byId('dashboard-stream-state'),
      logout: byId('logout-button')
    }

    const state = {
      source: undefined,
      stopped: false
    }

    setupLogoutButton(elements.logout)
    window.addEventListener('beforeunload', stopDashboardStream)
    void initializeDashboard()

    async function initializeDashboard() {
      try {
        await refreshDashboard()
      } catch (error) {
        if (isAuthRedirect(error)) return
        elements.grid.setAttribute('aria-busy', 'false')
        elements.summary.textContent = 'Failed to load instance status.'
        setDashboardStreamState('error', 'Connection error')
      }

      if (!state.stopped) openDashboardStream()
    }

    async function refreshDashboard() {
      const response = await apiFetch('/api/dashboard')
      const payload = await parseJson(response)
      const instances = dashboardInstances(payload)
      if (!response.ok || !instances) throw new Error('Invalid dashboard response')
      renderDashboard(instances)
    }

    function openDashboardStream() {
      stopDashboardStream()
      state.stopped = false

      const source = new EventSource('/api/dashboard/stream')
      state.source = source

      source.addEventListener('snapshots', handleSnapshots)
      source.addEventListener('auth-expired', () => {
        stopDashboardStream()
        window.location.replace('/login')
      })
      source.onopen = () => {
        setDashboardStreamState('live', 'Live connection')
      }
      source.onerror = () => {
        if (state.stopped) return
        setDashboardStreamState('error', 'Reconnecting…')
        // EventSource hides the status code of a rejected reconnect. An
        // authenticated request turns an expired session into a clean redirect.
        void apiFetch('/api/dashboard').catch(() => undefined)
      }
    }

    function handleSnapshots(event) {
      try {
        const instances = dashboardInstances(JSON.parse(event.data))
        if (!instances) return
        renderDashboard(instances)
        setDashboardStreamState('live', 'Live connection')
      } catch {
        // Ignore one malformed event. The next full snapshot can recover the UI.
      }
    }

    function stopDashboardStream() {
      state.stopped = true
      if (state.source) state.source.close()
      state.source = undefined
    }

    function renderDashboard(rawInstances) {
      const instances = rawInstances.filter(isDashboardSnapshot)
      const focusedCard = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('.dashboard-card')
        : null
      const focusedInstanceId = focusedCard ? focusedCard.dataset.instanceId : undefined
      const fragment = document.createDocumentFragment()
      for (const instance of instances) fragment.append(createDashboardCard(instance))

      elements.grid.replaceChildren(fragment)
      elements.grid.setAttribute('aria-busy', 'false')
      elements.grid.hidden = instances.length === 0
      elements.empty.hidden = instances.length > 0
      updateDashboardSummary(instances)

      if (focusedInstanceId) {
        const replacement = Array.from(elements.grid.children).find(
          (card) => card.dataset.instanceId === focusedInstanceId
        )
        if (replacement) replacement.focus({ preventScroll: true })
      }
    }

    function createDashboardCard(snapshot) {
      const status = normalizedStatus(snapshot.status)
      const online = status === 'online'
      const card = document.createElement('a')
      card.className = `dashboard-card status-${status}`
      card.href = `/logs?instance=${encodeURIComponent(snapshot.id)}`
      card.dataset.instanceId = snapshot.id
      card.setAttribute('aria-label', `${snapshot.id}, ${statusLabel(status)}. View instance logs`)

      const cardHeader = document.createElement('div')
      cardHeader.className = 'dashboard-card-header'
      const identity = document.createElement('div')
      identity.className = 'instance-identity'
      const heading = document.createElement('h3')
      heading.textContent = snapshot.id
      const username = document.createElement('p')
      username.textContent = snapshot.username
      identity.append(heading, username)
      const badge = span(`status-badge status-${status}`, statusLabel(status))
      cardHeader.append(identity, badge)

      const metrics = document.createElement('dl')
      metrics.className = 'metric-grid'
      metrics.append(
        createMetric('Server', formatEndpoint(snapshot.host, snapshot.port), true),
        createMetric('Uptime', online ? formatDuration(snapshot.uptimeMs) : '—', true),
        createMetric('Ping', online ? formatPing(snapshot.ping) : '—', true),
        createMetric('Position', online ? formatPosition(snapshot.position) : '—', true),
        createMetric('Dimension', online ? displayValue(snapshot.dimension) : '—')
      )

      const vitals = document.createElement('div')
      vitals.className = 'vitals-grid'
      vitals.append(
        createVital('Health', online ? snapshot.health : undefined, 'health'),
        createVital('Food', online ? snapshot.food : undefined, 'food')
      )

      card.append(cardHeader, metrics, vitals, createTaskPanel(snapshot.activeTask))
      if (isLastError(snapshot.lastError)) {
        card.append(createErrorPanel(snapshot.lastError, status === 'errored'))
      }
      return card
    }

    function createMetric(label, value, leftToRight = false) {
      const group = document.createElement('div')
      group.className = 'metric'
      const term = document.createElement('dt')
      term.className = 'metric-label'
      term.textContent = label
      const description = document.createElement('dd')
      description.className = 'metric-value'
      description.textContent = value
      if (leftToRight) description.dir = 'ltr'
      group.append(term, description)
      return group
    }

    function createVital(label, rawValue, kind) {
      const available = Number.isFinite(rawValue)
      const value = available ? Math.min(20, Math.max(0, rawValue)) : 0
      const vital = document.createElement('div')
      vital.className = `vital${available ? '' : ' is-unavailable'}`
      const heading = document.createElement('div')
      heading.className = 'vital-heading'
      const displayedValue = document.createElement('strong')
      displayedValue.className = 'vital-value'
      displayedValue.textContent = available ? formatDecimal(rawValue) : '—'
      heading.append(span('vital-label', label), displayedValue)
      const progress = document.createElement('progress')
      progress.className = `vital-progress ${kind}`
      progress.max = 20
      progress.value = value
      progress.setAttribute('aria-label', available ? `${label}: ${formatDecimal(rawValue)} out of 20` : `${label}: unavailable`)
      vital.append(heading, progress)
      return vital
    }

    function createTaskPanel(task) {
      const panel = document.createElement('section')
      panel.className = 'task-panel'
      panel.setAttribute('aria-label', 'Active task')
      const heading = document.createElement('div')
      heading.className = 'task-heading'
      heading.textContent = 'Active task'
      panel.append(heading)

      if (!isActiveTask(task)) {
        const empty = document.createElement('p')
        empty.textContent = 'No active task'
        panel.append(empty)
        return panel
      }

      const name = document.createElement('p')
      name.className = 'task-name'
      name.textContent = task.name
      const details = document.createElement('p')
      details.className = 'task-details'
      details.textContent = `Requested by: ${task.requestedBy} · Runtime: ${formatDuration(Date.now() - task.startedAt)}`
      panel.append(name, details)
      return panel
    }

    function createErrorPanel(error, prominent) {
      const panel = document.createElement('section')
      panel.className = `error-panel${prominent ? ' is-prominent' : ''}`
      panel.setAttribute('aria-label', 'Last error')
      const heading = document.createElement('div')
      heading.className = 'error-heading'
      heading.textContent = 'Last error'
      const message = document.createElement('p')
      message.className = 'error-message'
      message.textContent = error.message
      const occurredAt = document.createElement('time')
      occurredAt.className = 'error-time'
      occurredAt.textContent = formatDateTime(error.at)
      const date = new Date(error.at)
      if (!Number.isNaN(date.getTime())) occurredAt.dateTime = date.toISOString()
      panel.append(heading, message, occurredAt)
      return panel
    }

    function updateDashboardSummary(instances) {
      const online = instances.filter((instance) => instance.status === 'online').length
      const reconnecting = instances.filter((instance) => instance.status === 'reconnecting').length
      const errored = instances.filter((instance) => instance.status === 'errored').length
      const summary = `${online} online · ${reconnecting} reconnecting · ${errored} errored`
      if (elements.summary.textContent !== summary) elements.summary.textContent = summary
    }

    function setDashboardStreamState(kind, text) {
      if (
        elements.streamState.dataset.state === kind &&
        elements.streamState.dataset.label === text
      ) return

      elements.streamState.dataset.state = kind
      elements.streamState.dataset.label = text
      elements.streamState.className = `stream-state is-${kind}`
      elements.streamState.replaceChildren()
      const dot = document.createElement('span')
      dot.className = 'state-dot'
      dot.setAttribute('aria-hidden', 'true')
      elements.streamState.append(dot, document.createTextNode(text))
    }
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
      void copyRecords(chosen, 'Selected entries copied.')
    })
    elements.copyRecent.addEventListener('click', () => {
      const requested = clampInteger(elements.copyCount.value, 1, 1000, 20)
      elements.copyCount.value = String(requested)
      const recent = filteredRecords().slice(-requested)
      void copyRecords(recent, `${recent.length} recent entries copied.`)
    })
    setupLogoutButton(elements.logout)
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
          option.textContent = 'No instances found'
          elements.instance.append(option)
          elements.instance.disabled = true
          elements.instanceSummary.textContent = 'BotManager does not currently have any active instances.'
          setStreamState('idle', 'No instances')
          return
        }

        elements.instance.disabled = false
        const requested = readRequestedInstance()
        const preferred = requested === null ? readRememberedInstance() : requested
        if (preferred && Array.from(elements.instance.options).some((item) => item.value === preferred)) {
          elements.instance.value = preferred
        }
        await selectInstance(elements.instance.value)
      } catch (error) {
        if (isAuthRedirect(error)) return
        elements.instanceSummary.textContent = 'Failed to load instances.'
        setStreamState('error', 'Connection error')
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
      setStreamState('idle', 'Connecting…')
      openStream(instanceId, generation)

      try {
        const payload = await fetchHistory(instanceId)
        if (generation !== state.generation) return
        mergeInitialHistory(payload.entries)
        state.nextBefore = typeof payload.nextBefore === 'string' ? payload.nextBefore : undefined
        renderAll(true)
      } catch (error) {
        if (generation !== state.generation || isAuthRedirect(error)) return
        showToast('Failed to load log history.')
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
      setButtonLabel(elements.loadOlder, 'Loading…')
      try {
        const payload = await fetchHistory(state.instanceId, state.nextBefore)
        if (generation !== state.generation) return
        const older = payload.entries.filter(isLogEntry).map(createRecord)
        state.records = [...older, ...state.records]
        state.nextBefore = typeof payload.nextBefore === 'string' ? payload.nextBefore : undefined
        renderAll()
      } catch (error) {
        if (!isAuthRedirect(error)) showToast('Failed to load older entries.')
      } finally {
        state.loadingOlder = false
        elements.loadOlder.disabled = false
        setButtonLabel(elements.loadOlder, 'Load older entries')
        updateSummary(filteredRecords())
      }
    }

    function openStream(instanceId, generation) {
      const source = new EventSource(`/api/logs/${encodeURIComponent(instanceId)}/stream`)
      state.source = source
      let hasOpened = false

      source.addEventListener('ready', () => {
        if (generation === state.generation) setStreamState('live', 'Live connection')
      })
      source.addEventListener('auth-expired', () => {
        source.close()
        window.location.replace('/login')
      })
      source.onopen = () => {
        if (generation !== state.generation) return
        setStreamState('live', 'Live connection')
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
        setStreamState('error', 'Reconnecting…')
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
        if (!isAuthRedirect(error)) showToast('Failed to recover missing logs after reconnecting.')
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
      checkbox.setAttribute('aria-label', `Select ${entry.level} entry: ${entry.message}`)
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
        ? `${total} entries`
        : `${visible.length} of ${total} entries`
      elements.empty.hidden = visible.length > 0
      elements.logList.hidden = visible.length === 0
      elements.loadOlder.hidden = !state.nextBefore
    }

    function updateSelectionState(visible) {
      const selectedCount = state.selected.size
      elements.selectionCount.textContent = selectedCount === 0
        ? 'No entries selected'
        : `${selectedCount} entries selected`
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
        showToast('There are no entries to copy.')
        return
      }
      try {
        await writeClipboard(records.map((record) => formatForCopy(record.entry)).join('\n'))
        showToast(successMessage)
      } catch {
        showToast('Copy failed. Allow clipboard access and try again.')
      }
    }

    function showToast(message) {
      elements.toast.textContent = message
      elements.toast.classList.add('is-visible')
      window.clearTimeout(state.toastTimer)
      state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2600)
    }
  }

  function setupBotsPage() {
    const ACTIVE_STATUSES = ['connecting', 'online', 'reconnecting']

    const elements = {
      loading: byId('bots-loading'),
      errorPanel: byId('bots-error'),
      retry: byId('bots-retry'),
      empty: byId('bots-empty'),
      tableWrap: byId('bots-table-wrap'),
      tableBody: byId('bots-table-body'),
      summary: byId('bots-summary'),
      logout: byId('logout-button'),
      addButton: byId('add-bot-button'),
      toast: byId('toast'),
      formDialog: byId('bot-form-dialog'),
      form: byId('bot-form'),
      formClose: byId('bot-form-close'),
      formTitle: byId('bot-form-title'),
      formError: byId('bot-form-error'),
      formId: byId('bot-form-id'),
      formHost: byId('bot-form-host'),
      formPort: byId('bot-form-port'),
      formUsername: byId('bot-form-username'),
      formAuth: byId('bot-form-auth'),
      formAuthWarning: byId('bot-form-auth-warning'),
      formPrefix: byId('bot-form-prefix'),
      formAdmins: byId('bot-form-admins'),
      formProfiles: byId('bot-form-profiles'),
      formAutoConnect: byId('bot-form-auto-connect'),
      formCancel: byId('bot-form-cancel'),
      formSubmit: byId('bot-form-submit'),
      deleteDialog: byId('delete-dialog'),
      deleteDialogId: byId('delete-dialog-id'),
      deleteClose: byId('delete-dialog-close'),
      deleteCancel: byId('delete-dialog-cancel'),
      deleteConfirm: byId('delete-dialog-confirm')
    }

    const state = {
      pendingIds: new Set(),
      editingId: undefined,
      originalAuth: undefined,
      deleteTargetId: undefined,
      formSubmitting: false,
      deleteSubmitting: false,
      toastTimer: undefined
    }

    setupLogoutButton(elements.logout)
    elements.retry.addEventListener('click', () => void loadBots())
    elements.addButton.addEventListener('click', () => openFormDialog())
    elements.formClose.addEventListener('click', () => elements.formDialog.close())
    elements.formCancel.addEventListener('click', () => elements.formDialog.close())
    elements.form.addEventListener('submit', (event) => void handleFormSubmit(event))
    elements.formAuth.addEventListener('change', updateAuthWarning)
    elements.deleteClose.addEventListener('click', () => elements.deleteDialog.close())
    elements.deleteCancel.addEventListener('click', () => elements.deleteDialog.close())
    elements.deleteConfirm.addEventListener('click', () => void handleDeleteConfirm())

    void loadBots()

    async function loadBots() {
      showLoadingState()
      try {
        const response = await apiFetch('/api/bots')
        const payload = await parseJson(response)
        const instances = botInstances(payload)
        if (!response.ok || !instances) throw new Error('Invalid bots response')
        renderBots(instances)
      } catch (error) {
        if (isAuthRedirect(error)) return
        showErrorState()
      }
    }

    function showLoadingState() {
      elements.loading.hidden = false
      elements.errorPanel.hidden = true
      elements.empty.hidden = true
      elements.tableWrap.hidden = true
      elements.summary.textContent = 'Loading instances…'
    }

    function showErrorState() {
      elements.loading.hidden = true
      elements.errorPanel.hidden = false
      elements.empty.hidden = true
      elements.tableWrap.hidden = true
      elements.summary.textContent = 'Failed to load the list.'
    }

    function renderBots(instances) {
      state.instances = instances.filter(isBotSummary)
      elements.loading.hidden = true
      elements.errorPanel.hidden = true

      if (state.instances.length === 0) {
        elements.empty.hidden = false
        elements.tableWrap.hidden = true
        elements.summary.textContent = 'No instances configured.'
        return
      }

      elements.empty.hidden = true
      elements.tableWrap.hidden = false
      elements.summary.textContent = `${state.instances.length} instances`

      const fragment = document.createDocumentFragment()
      for (const instance of state.instances) fragment.append(createBotRow(instance))
      elements.tableBody.replaceChildren(fragment)
    }

    function createBotRow(instance) {
      const status = normalizedStatus(instance.status)
      const busy = state.pendingIds.has(instance.id)
      const row = document.createElement('tr')
      row.className = `bots-row status-${status}`

      const idCell = document.createElement('td')
      idCell.append(span('bots-id', instance.id))
      if (isLastError(instance.lastError)) idCell.append(createErrorNote(instance.lastError))

      const statusCell = document.createElement('td')
      statusCell.append(span(`status-badge status-${status}`, statusLabel(status)))

      const serverCell = document.createElement('td')
      serverCell.dir = 'ltr'
      serverCell.textContent = formatEndpoint(instance.host, instance.port)

      const usernameCell = document.createElement('td')
      usernameCell.textContent = instance.username

      const authCell = document.createElement('td')
      authCell.textContent = instance.auth === 'microsoft' ? 'Microsoft' : 'Offline'

      const autoConnectCell = document.createElement('td')
      autoConnectCell.append(
        span(`bool-badge ${instance.autoConnect ? 'is-yes' : 'is-no'}`, instance.autoConnect ? 'Yes' : 'No')
      )

      const actionsCell = document.createElement('td')
      actionsCell.className = 'bots-actions'
      const isActive = ACTIVE_STATUSES.includes(status)

      actionsCell.append(
        actionButton('Connect', 'play', busy || isActive, () => runInstanceAction(instance.id, 'connect')),
        actionButton('Disconnect', 'stop', busy || !isActive, () => runInstanceAction(instance.id, 'disconnect')),
        actionButton('Restart', 'restart', busy, () => runInstanceAction(instance.id, 'restart')),
        actionButton('Edit', 'edit', busy, () => openFormDialog(instance)),
        actionButton('Delete', 'trash', busy, () => openDeleteDialog(instance), 'danger')
      )

      row.append(idCell, statusCell, serverCell, usernameCell, authCell, autoConnectCell, actionsCell)
      return row
    }

    function actionButton(label, iconName, disabled, onClick, kind) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `icon-button table-action${kind === 'danger' ? ' is-danger' : ''}`
      button.setAttribute('aria-label', label)
      button.title = label
      button.append(createIcon(iconName))
      button.disabled = disabled
      button.addEventListener('click', onClick)
      return button
    }

    function createErrorNote(lastError) {
      // lastError.message is already redacted server-side; this truncation
      // is purely a display concern, not a second safety pass.
      const note = document.createElement('p')
      note.className = 'bots-error-note'
      note.textContent = truncate(lastError.message, 80)
      if (lastError.message.length > 80) note.title = lastError.message
      return note
    }

    // ---- connect / disconnect / restart ----

    async function runInstanceAction(id, action) {
      if (state.pendingIds.has(id)) return
      state.pendingIds.add(id)
      // Immediate visual feedback (disabled row) before the response arrives;
      // loadBots() below re-fetches and re-renders with the real outcome.
      if (state.instances) renderBots(state.instances)

      try {
        const response = await apiFetch(`/api/bots/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        const payload = await parseJson(response)
        if (!response.ok) throw new Error(describeApiError(payload, response.status))
      } catch (error) {
        if (!isAuthRedirect(error)) showToast(error.message || 'The action failed.')
      } finally {
        state.pendingIds.delete(id)
        await loadBots()
      }
    }

    // ---- add / edit form ----

    function openFormDialog(instance) {
      state.editingId = instance ? instance.id : undefined
      state.originalAuth = instance ? instance.auth : undefined
      elements.formError.textContent = ''
      elements.formAuthWarning.hidden = true

      elements.formTitle.textContent = instance ? `Edit instance "${instance.id}"` : 'Add instance'
      elements.formId.value = instance ? instance.id : ''
      elements.formId.disabled = Boolean(instance)
      elements.formHost.value = instance ? instance.host : ''
      elements.formPort.value = instance ? String(instance.port) : ''
      elements.formUsername.value = instance ? instance.username : ''
      elements.formAuth.value = instance ? instance.auth : 'offline'
      elements.formPrefix.value = instance ? instance.commandPrefix || '' : ''
      elements.formAdmins.value = instance && Array.isArray(instance.admins) ? instance.admins.join(', ') : ''
      elements.formProfiles.value = instance && instance.profilesFolder ? instance.profilesFolder : ''
      elements.formAutoConnect.checked = instance ? Boolean(instance.autoConnect) : true

      elements.formDialog.showModal()
      ;(instance ? elements.formHost : elements.formId).focus()
    }

    function updateAuthWarning() {
      const changed = state.originalAuth !== undefined && elements.formAuth.value !== state.originalAuth
      elements.formAuthWarning.hidden = !changed
    }

    async function handleFormSubmit(event) {
      event.preventDefault()
      if (state.formSubmitting) return

      const payload = {
        id: elements.formId.value.trim(),
        host: elements.formHost.value.trim(),
        port: Number(elements.formPort.value),
        username: elements.formUsername.value.trim(),
        auth: elements.formAuth.value,
        commandPrefix: elements.formPrefix.value.trim() || undefined,
        admins: elements.formAdmins.value.split(',').map((name) => name.trim()).filter(Boolean),
        profilesFolder: elements.formProfiles.value.trim() || undefined,
        autoConnect: elements.formAutoConnect.checked
      }

      const isEdit = state.editingId !== undefined
      const url = isEdit ? `/api/bots/${encodeURIComponent(state.editingId)}` : '/api/bots'

      state.formSubmitting = true
      elements.formSubmit.disabled = true
      elements.formSubmit.textContent = 'Saving…'
      elements.formError.textContent = ''

      try {
        const response = await apiFetch(url, {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const body = await parseJson(response)
        if (!response.ok) throw new Error(describeApiError(body, response.status))

        elements.formDialog.close()
        showToast(isEdit ? 'Instance updated.' : 'Instance added.')
        await loadBots()
      } catch (error) {
        if (isAuthRedirect(error)) return
        elements.formError.textContent = error.message || 'Failed to save the instance.'
      } finally {
        state.formSubmitting = false
        elements.formSubmit.disabled = false
        elements.formSubmit.textContent = 'Save'
      }
    }

    // ---- delete ----

    function openDeleteDialog(instance) {
      state.deleteTargetId = instance.id
      elements.deleteDialogId.textContent = instance.id
      elements.deleteConfirm.disabled = false
      setButtonLabel(elements.deleteConfirm, 'Delete')
      elements.deleteDialog.showModal()
    }

    async function handleDeleteConfirm() {
      if (state.deleteSubmitting || !state.deleteTargetId) return
      const id = state.deleteTargetId

      state.deleteSubmitting = true
      elements.deleteConfirm.disabled = true
      setButtonLabel(elements.deleteConfirm, 'Deleting…')

      try {
        const response = await apiFetch(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (!response.ok && response.status !== 204) {
          const body = await parseJson(response)
          throw new Error(describeApiError(body, response.status))
        }
        elements.deleteDialog.close()
        showToast(`Instance "${id}" deleted.`)
      } catch (error) {
        if (!isAuthRedirect(error)) {
          elements.deleteDialog.close()
          showToast(error.message || 'Failed to delete the instance.')
        }
      } finally {
        state.deleteSubmitting = false
        state.deleteTargetId = undefined
        elements.deleteConfirm.disabled = false
        setButtonLabel(elements.deleteConfirm, 'Delete')
        // Refresh even on failure: a 404 here usually means another tab
        // already deleted (or renamed) this instance, and the table must
        // stop showing it rather than leaving a stale, now-illegal row.
        await loadBots()
      }
    }

    // ---- shared helpers ----

    function describeApiError(body, status) {
      if (body && typeof body.error === 'string' && body.error) return body.error
      if (status === 400) return 'The request is invalid.'
      if (status === 404) return 'The instance was not found.'
      if (status === 409) return 'The action is not available in the current state.'
      return 'An error occurred. Try again.'
    }

    function showToast(message) {
      elements.toast.textContent = message
      elements.toast.classList.add('is-visible')
      window.clearTimeout(state.toastTimer)
      state.toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 3200)
    }
  }

  function setupLogoutButton(button) {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      } finally {
        window.location.replace('/login')
      }
    })
  }

  function setupTheme() {
    const root = document.documentElement
    const toggle = byId('theme-toggle')
    const media = window.matchMedia('(prefers-color-scheme: light)')
    let savedTheme

    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      if (stored === 'light' || stored === 'dark') savedTheme = stored
    } catch {
      // Theme selection still works for this page when storage is unavailable.
    }

    applyTheme(savedTheme || (media.matches ? 'light' : 'dark'))

    toggle.addEventListener('click', () => {
      const nextTheme = root.dataset.theme === 'light' ? 'dark' : 'light'
      savedTheme = nextTheme
      try {
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
      } catch {
        // Ignore storage restrictions; the active page still updates.
      }
      applyTheme(nextTheme)
    })

    const followSystemTheme = (event) => {
      if (!savedTheme) applyTheme(event.matches ? 'light' : 'dark')
    }
    if (typeof media.addEventListener === 'function') media.addEventListener('change', followSystemTheme)

    function applyTheme(theme) {
      root.dataset.theme = theme
      const nextTheme = theme === 'light' ? 'dark' : 'light'
      const label = `Switch to ${nextTheme} mode`
      setIconButton(toggle, theme === 'light' ? 'moon' : 'sun', label)
      toggle.setAttribute('aria-pressed', String(theme === 'light'))
      const themeColor = document.querySelector('meta[name="theme-color"]')
      if (themeColor) themeColor.content = theme === 'light' ? '#f3f7f5' : '#0d1113'
    }
  }

  function dashboardInstances(payload) {
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object' && Array.isArray(payload.instances)) {
      return payload.instances
    }
    return null
  }

  function isDashboardSnapshot(value) {
    return Boolean(value) &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.username === 'string' &&
      typeof value.host === 'string' &&
      Number.isFinite(value.port) &&
      typeof value.status === 'string'
  }

  function botInstances(payload) {
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object' && Array.isArray(payload.instances)) {
      return payload.instances
    }
    return null
  }

  function isBotSummary(value) {
    return Boolean(value) &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.host === 'string' &&
      Number.isFinite(value.port) &&
      typeof value.username === 'string' &&
      typeof value.auth === 'string' &&
      typeof value.status === 'string' &&
      typeof value.autoConnect === 'boolean'
  }

  function truncate(text, maxLength) {
    if (typeof text !== 'string') return ''
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  }

  function isActiveTask(value) {
    return Boolean(value) &&
      typeof value === 'object' &&
      typeof value.name === 'string' &&
      typeof value.requestedBy === 'string' &&
      Number.isFinite(value.startedAt)
  }

  function isLastError(value) {
    return Boolean(value) &&
      typeof value === 'object' &&
      typeof value.message === 'string' &&
      Number.isFinite(value.at)
  }

  function normalizedStatus(status) {
    return ['disconnected', 'connecting', 'online', 'reconnecting', 'errored'].includes(status)
      ? status
      : 'unknown'
  }

  function formatEndpoint(host, port) {
    const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `${displayHost}:${port}`
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '—'
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  }

  function formatPing(value) {
    return Number.isFinite(value) ? `${Math.round(value)} ms` : '—'
  }

  function formatPosition(position) {
    if (!position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)) return '—'
    return `${formatCoordinate(position.x)} / ${formatCoordinate(position.y)} / ${formatCoordinate(position.z)}`
  }

  function formatCoordinate(value) {
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value)
  }

  function formatDecimal(value) {
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)
  }

  function formatDateTime(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'short',
      timeStyle: 'medium',
      hour12: false
    }).format(date)
  }

  function displayValue(value) {
    return typeof value === 'string' && value ? value : '—'
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

  function readRequestedInstance() {
    try {
      return new URLSearchParams(window.location.search).get('instance')
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
    return new Intl.DateTimeFormat('en-GB', {
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
      disconnected: 'Disconnected',
      connecting: 'Connecting',
      online: 'Online',
      reconnecting: 'Reconnecting',
      errored: 'Error'
    }
    return labels[status] || 'Unknown status'
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

  function createIcon(name) {
    const definitions = ICONS[name]
    if (!definitions) throw new Error(`Unknown icon: ${name}`)
    const namespace = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(namespace, 'svg')
    svg.classList.add('icon')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    for (const [tag, attributes] of definitions) {
      const element = document.createElementNS(namespace, tag)
      for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value)
      svg.append(element)
    }
    return svg
  }

  function setIconButton(button, iconName, label) {
    button.replaceChildren(createIcon(iconName))
    button.setAttribute('aria-label', label)
    button.title = label
  }

  function setButtonLabel(button, label) {
    const text = button.querySelector('span')
    if (text) text.textContent = label
    else button.textContent = label
  }

  function byId(id) {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Missing element #${id}`)
    return element
  }
})()
