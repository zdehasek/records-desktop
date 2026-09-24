import { usePushSubscriptions } from "../hooks/usePushSubscriptions.js"
import { initializePlatformApi } from "../lib/api.js"
import { createSimpleContext } from "../lib/create-context.jsx"
import { today } from "../lib/formatters/date-utils.js"
import { useApi } from "./PlatformContext.jsx"
import {
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"

const AppCtx = createSimpleContext("App")
export const AppProvider = AppCtx.Provider
export const useApp = AppCtx.use

const DEFAULT_SETTINGS = {}

export function AppWrapper(props) {
  const api = useApi()
  const initialToday = today()
  const [state, setState] = createStore({
    selectedDate: initialToday,
    currentDayId: null,
    days: [],
    messages: [],
    attachmentsByMessage: {},
    memoryDays: [],
    memoryLoading: false,
    isLoading: true,
    view: "timeline",
    thumbWarmup: null, // null = not started, { done, total } = in progress
    microWarmup: null, // null = not started, { done, total } = in progress
    photoImport: null, // null or active scan and import progress
    photoImportResult: null,
    yearViewYear: Number(initialToday.slice(0, 4))
  })

  // Derived accessor — single source of truth for the current day.
  // Looks up by ID in state.days (always fresh from DB after any mutation).
  const currentDay = () =>
    state.days.find((d) => d.id === state.currentDayId) ||
    state.memoryDays.find((d) => d.id === state.currentDayId) ||
    null

  // --- Data signals (plain, outside the store to avoid proxy overhead) ---
  const [allPhotos, setAllPhotos] = createSignal([])
  const [geoPhotos, setGeoPhotos] = createSignal([])
  const [noGpsPhotos, setNoGpsPhotos] = createSignal([])
  const [settings, setSettings] = createSignal({ ...DEFAULT_SETTINGS })
  const [capabilities, setCapabilities] = createSignal({
    ...api.capabilities
  })
  const [thumbnailRebuildRunning, setThumbnailRebuildRunning] =
    createSignal(false)
  const photoGifAvailable = () => Boolean(capabilities().photoGif)
  const [onboardingOpen, setOnboardingOpen] = createSignal(false)
  const [onboardingRequired, setOnboardingRequired] = createSignal(false)
  const [mediaFolders, setMediaFolders] = createSignal([])
  const [mediaFolderHint, setMediaFolderHint] = createSignal(null)
  const [essentialSetupBusy, setEssentialSetupBusy] = createSignal(false)
  const [essentialSetupError, setEssentialSetupError] = createSignal(null)

  // NSFW mode is persisted in the file-backed preferences.
  // "hidden" = excluded from queries, "blurred" = shown but blurred, "visible" = shown normally
  const [nsfwMode, _setNsfwMode] = createSignal("blurred")
  const showNsfw = () => nsfwMode() !== "hidden"
  const blurNsfw = () => nsfwMode() === "blurred"
  const setNsfwMode = async (mode) => {
    const previous = nsfwMode()
    try {
      _setNsfwMode(mode)
      await api.settings.set("nsfw_mode", mode)
      setSettings((prev) => ({ ...prev, nsfw_mode: mode }))
      return null
    } catch (err) {
      _setNsfwMode(previous)
      console.error("[app] setNsfwMode failed:", err)
      return err
    }
  }

  // Dot-files visibility — session-only, never persisted
  const [dotFilesVisible, setDotFilesVisible] = createSignal(false)

  // Combined opts for all data queries
  const visOpts = () => ({
    nsfwMode: nsfwMode(),
    dotFilesVisible: dotFilesVisible()
  })

  // Generic loader factory — replaces try/catch boilerplate for simple
  // "fetch → set" functions. `apiFn` receives any args forwarded by the
  // returned async function. On error it logs and resets to `defaultVal`.
  const createLoader =
    (label, apiFn, setter, defaultVal = []) =>
    async (...args) => {
      try {
        setter(await apiFn(...args))
      } catch (err) {
        console.error(`[${label}] Failed to load:`, err)
        setter(defaultVal)
      }
    }

  // Folder data for gallery
  const [folders, setFolders] = createSignal([])
  const [folderPhotos, setFolderPhotos] = createSignal([])

  // Navigation history for back button
  const [navHistory, setNavHistory] = createSignal([])
  const [isRestoringNav, setIsRestoringNav] = createSignal(false)
  const [pendingScrollRestore, setPendingScrollRestore] = createSignal(null)

  // Signal to request Timeline scroll to top (used by BottomNav "Today" re-tap)
  const [scrollToTopTick, setScrollToTopTick] = createSignal(0)
  const scrollTimelineToTop = () => setScrollToTopTick((t) => t + 1)
  const [contentRefreshTick, setContentRefreshTick] = createSignal(0)
  const requestContentRefresh = () => setContentRefreshTick((tick) => tick + 1)
  const [memoryStoryRequestTick, setMemoryStoryRequestTick] = createSignal(0)
  const requestMemoryStory = () => {
    setView("onThisDay")
    setMemoryStoryRequestTick((tick) => tick + 1)
  }

  // Cache scrollTop on every scroll event so pushHistory() can read it
  // reliably. Direct reads from the DOM inside click handlers are unreliable
  // because the browser's focus-scroll (auto-scrolling to bring the clicked
  // button into view) fires before the JS click handler runs.
  let cachedScrollTop = 0
  let scrollCacheEl = null
  const scrollCacheHandler = () => {
    cachedScrollTop = scrollCacheEl ? scrollCacheEl.scrollTop : 0
  }

  const initScrollCache = () => {
    const el = document.getElementById("calendar-scroll")
    if (el === scrollCacheEl) return // already listening
    // Detach old listener
    if (scrollCacheEl) {
      scrollCacheEl.removeEventListener("scroll", scrollCacheHandler)
    }
    scrollCacheEl = el
    if (el) {
      cachedScrollTop = el.scrollTop
      el.addEventListener("scroll", scrollCacheHandler, { passive: true })
    } else {
      cachedScrollTop = 0
    }
  }

  const captureScrollTop = () => {
    if (state.view === "timeline") return cachedScrollTop
    return 0
  }

  const pushHistory = () => {
    if (isRestoringNav()) return
    const entry = {
      view: state.view,
      currentDayId: state.currentDayId,
      selectedDate: state.selectedDate,
      scrollTop: captureScrollTop()
    }
    setNavHistory((prev) => {
      const next = [...prev, entry]
      return next.length > 50 ? next.slice(-50) : next
    })
  }

  const canGoBack = () => navHistory().length > 0

  const goBack = () => {
    const stack = navHistory()
    if (stack.length === 0) return

    const entry = stack[stack.length - 1]
    setNavHistory((prev) => prev.slice(0, -1))

    // Set pendingScrollRestore BEFORE the batch so that when SolidJS
    // synchronously remounts Timeline during the batch, its onMount
    // can read the pending value.
    if (entry.view === "timeline" && entry.scrollTop > 0) {
      setPendingScrollRestore(entry.scrollTop)
    }

    setIsRestoringNav(true)
    batch(() => {
      setState("currentDayId", entry.currentDayId)
      setState("selectedDate", entry.selectedDate)
      setState("view", entry.view)
    })
    // Defer reset so effects triggered by the batch still see isRestoringNav=true
    queueMicrotask(() => setIsRestoringNav(false))
  }

  const refreshDays = async ({ preserveSelection = false } = {}) => {
    try {
      const contentDays = await api.days.listWithContent({
        ...visOpts(),
        autoPhoto: settings().auto_photo_in_week_overview === "true"
      })
      const todayIsoVal = today()

      setState("days", reconcile(contentDays))

      // When called from a background import, preserve the user's current
      // day selection to avoid disrupting Photos/Map/Timeline navigation.
      if (preserveSelection && state.currentDayId) {
        // If the current day disappeared from the content list (all content
        // deleted), ensure it's still accessible via the derived currentDay()
        if (!contentDays.some((d) => d.id === state.currentDayId)) {
          const day = await api.days.get(state.currentDayId)
          if (day) {
            setState("days", (prev) => [day, ...prev])
          }
        }
        // Return earliest date for callers that need it
        return contentDays.length
          ? contentDays[contentDays.length - 1].date
          : null
      }

      const todayInList = contentDays.find((d) => d.date === todayIsoVal)
      if (!todayInList) {
        const todayDay = await api.days.ensure(todayIsoVal)
        batch(() => {
          // Guard: a concurrent refreshDays call may have already prepended today
          const alreadyInStore = state.days.some((d) => d.date === todayIsoVal)
          if (!alreadyInStore) {
            setState("days", (days) => [todayDay, ...days])
          }
          setState("currentDayId", todayDay.id)
          setState("selectedDate", todayDay.date)
        })
      } else {
        batch(() => {
          setState("currentDayId", todayInList.id)
          setState("selectedDate", todayInList.date)
        })
      }

      // Return earliest date (last in DESC-sorted list) for memory days
      return contentDays.length
        ? contentDays[contentDays.length - 1].date
        : null
    } catch (err) {
      console.error("[app] refreshDays failed:", err)
      return null
    }
  }

  let messagesRequestId = 0
  const refreshMessages = async (requestedDayId = state.currentDayId) => {
    if (!requestedDayId) return
    const requestId = ++messagesRequestId
    try {
      const [msgs, atts] = await Promise.all([
        api.messages.list(requestedDayId, visOpts()),
        api.attachments.list(requestedDayId, visOpts())
      ])
      if (
        requestId !== messagesRequestId ||
        state.currentDayId !== requestedDayId
      ) {
        return
      }
      const byMsg = {}
      for (const att of atts) {
        if (!byMsg[att.message_id]) byMsg[att.message_id] = []
        byMsg[att.message_id].push(att)
      }
      batch(() => {
        setState("messages", reconcile(msgs))
        setState("attachmentsByMessage", reconcile(byMsg))
      })
    } catch (err) {
      console.error("[app] refreshMessages failed:", err)
    }
  }

  const [todayIso, setTodayIso] = createSignal(today())
  let memoryRequestId = 0

  const refreshMemoryDays = async ({ clearExisting = false } = {}) => {
    const requestId = ++memoryRequestId
    batch(() => {
      setState("memoryLoading", true)
      if (clearExisting) setState("memoryDays", [])
    })
    try {
      const memories = await api.days.memory(todayIso(), {
        ...visOpts(),
        autoPhoto: settings().auto_photo_in_week_overview === "true"
      })
      if (requestId === memoryRequestId) {
        setState("memoryDays", reconcile(memories))
      }
    } catch (err) {
      console.error("[memory]", err)
    } finally {
      if (requestId === memoryRequestId) setState("memoryLoading", false)
    }
  }

  const selectDay = (dayOrId, date) => {
    const dayId = typeof dayOrId === "object" ? dayOrId.id : dayOrId
    const dayDate = typeof dayOrId === "object" ? dayOrId.date : date
    if (dayId === state.currentDayId && state.view === "timeline") return
    pushHistory()
    batch(() => {
      if (
        typeof dayOrId === "object" &&
        dayOrId?.id &&
        !state.days.some((d) => d.id === dayOrId.id) &&
        !state.memoryDays.some((d) => d.id === dayOrId.id)
      ) {
        setState("days", (days) => [dayOrId, ...days])
      }
      setState("currentDayId", dayId)
      setState("selectedDate", dayDate)
      setState("view", "timeline")
    })
  }

  const goToToday = async () => {
    const todayDate = today()
    // If already on today's timeline, just scroll to top to reveal memory cards
    if (state.selectedDate === todayDate && state.view === "timeline") {
      scrollTimelineToTop()
      return
    }
    pushHistory()
    try {
      const day = await api.days.ensure(todayDate)
      // Ensure today is in the days list so currentDay() can resolve it
      if (!state.days.some((d) => d.id === day.id)) {
        setState("days", (prev) => [day, ...prev])
      }
      batch(() => {
        setState("currentDayId", day.id)
        setState("selectedDate", day.date)
        setState("view", "timeline")
      })
      await Promise.all([preserveDays(), refreshMemoryDays()])
    } catch (err) {
      console.error("[app] goToToday failed:", err)
    }
  }

  // Factory for mutations: call API, then run refresh functions in parallel.
  // refreshFns is a thunk (function returning an array) so that references
  // to other const-declared helpers are resolved lazily — avoids TDZ errors
  // when the production bundler reorders declarations.
  const mutation =
    (label, apiFn, refreshFns, afterRefresh) =>
    async (...args) => {
      try {
        await apiFn(...args)
        await Promise.all(refreshFns().map((fn) => fn()))
        afterRefresh?.()
      } catch (err) {
        console.error(`[app] ${label} failed:`, err)
      }
    }

  const preserveDays = () => refreshDays({ preserveSelection: true })

  const updateMessage = async (id, content, metadata = undefined) => {
    try {
      await api.attachments.update(id, {
        content,
        ...(metadata !== undefined && {
          important: Boolean(metadata?.important),
          noteColor: metadata?.note_style?.color || null
        })
      })
      await Promise.all([refreshMessages(), preserveDays()])
    } catch (err) {
      console.error("[app] updateMessage failed:", err)
      throw err
    }
  }

  const updatePhotoCaption = async (id, content) => {
    await api.attachments.update(id, { content })
    await Promise.all([refreshMessages(), preserveDays()])
  }

  const updateMessageNoteColor = mutation(
    "updateMessageNoteColor",
    (message, color) =>
      api.attachments.update(message.id, { noteColor: color }),
    () => [refreshMessages, preserveDays]
  )

  const updateMessageImportant = mutation(
    "updateMessageImportant",
    (message, important) => api.attachments.update(message.id, { important }),
    () => [refreshMessages, preserveDays, refreshMemoryDays]
  )

  const loadMemoryStoryItems = async () => {
    return api.days.storyItems(todayIso(), {
      ...visOpts(),
      autoPhoto: settings().auto_photo_in_week_overview === "true"
    })
  }

  const updateMessageTimestamp = mutation(
    "updateMessageTimestamp",
    (id, createdAt) => api.attachments.update(id, { createdAt }),
    () => [refreshMessages, preserveDays, refreshMemoryDays]
  )

  const createPhotoGif = async (messageIds) => {
    try {
      const result = await api.photos.createGif(messageIds)
      await refreshAllMedia()
      return result
    } catch (err) {
      console.error("[app] createPhotoGif failed:", err)
      throw err
    }
  }

  const deleteMessage = mutation(
    "deleteMessage",
    (id) => api.messages.delete(id),
    () => [refreshAllMedia]
  )

  const batchDeleteMessages = mutation(
    "batchDeleteMessages",
    (ids) => api.messages.batchDelete(ids),
    () => [refreshAllMedia]
  )

  const loadSettings = async () => {
    try {
      const s = { ...DEFAULT_SETTINGS, ...(await api.settings.all()) }
      setSettings(s)
      if (s.onboarding_completed !== "true") {
        setOnboardingRequired(true)
        setOnboardingOpen(true)
      }
      // Restore persisted NSFW mode (use _setNsfwMode to avoid re-saving)
      if (
        s.nsfw_mode &&
        ["hidden", "blurred", "visible"].includes(s.nsfw_mode)
      ) {
        _setNsfwMode(s.nsfw_mode)
      }
    } catch (err) {
      console.error("[settings] Failed to load:", err)
    }
  }

  const updateSetting = async (key, value) => {
    try {
      await api.settings.set(key, value)
      setSettings((prev) => ({ ...prev, [key]: value }))
      if (key === "auto_photo_in_week_overview") {
        await Promise.all([
          refreshDays({ preserveSelection: true }),
          refreshMemoryDays()
        ])
      }
      return null
    } catch (err) {
      console.error("[settings] Failed to update:", err)
      return err
    }
  }

  const loadMediaFolders = async () => {
    if (!api.capabilities?.mediaFolders) return
    try {
      setMediaFolders(await api.mediaFolders.list())
    } catch (err) {
      console.error("[settings] Failed to load media folders:", err)
      setEssentialSetupError(err.message || String(err))
    }
  }

  const addMediaFolder = async () => {
    setEssentialSetupBusy(true)
    setEssentialSetupError(null)
    setMediaFolderHint(null)
    try {
      const result = await api.mediaFolders.add()
      if (!result) return null
      if (result.duplicate) {
        setMediaFolderHint("Folder is already being scanned.")
        return result
      }
      await loadMediaFolders()
      return result
    } catch (err) {
      setEssentialSetupError(err.message || String(err))
      return null
    } finally {
      setEssentialSetupBusy(false)
    }
  }

  const removeMediaFolder = async (folderPath) => {
    setEssentialSetupBusy(true)
    setEssentialSetupError(null)
    try {
      await api.mediaFolders.remove(folderPath)
      await Promise.all([
        loadMediaFolders(),
        refreshAllMedia({ preserveSelection: true })
      ])
      requestContentRefresh()
    } catch (err) {
      setEssentialSetupError(err.message || String(err))
    } finally {
      setEssentialSetupBusy(false)
    }
  }

  const toggleMediaFolder = async (folderPath, currentEnabled) => {
    setEssentialSetupBusy(true)
    setEssentialSetupError(null)
    try {
      await api.mediaFolders.toggle(folderPath, !currentEnabled)
      await Promise.all([
        loadMediaFolders(),
        refreshAllMedia({ preserveSelection: true })
      ])
      requestContentRefresh()
    } catch (err) {
      setEssentialSetupError(err.message || String(err))
    } finally {
      setEssentialSetupBusy(false)
    }
  }

  const setDefaultMediaFolder = async (folderPath) => {
    setEssentialSetupBusy(true)
    setEssentialSetupError(null)
    try {
      const folder = await api.mediaFolders.setDefault(folderPath)
      await loadMediaFolders()
      return folder
    } catch (err) {
      setEssentialSetupError(err.message || String(err))
      return null
    } finally {
      setEssentialSetupBusy(false)
    }
  }

  const saveEssentialSetting = async (key, value) => {
    setEssentialSetupError(null)
    const error =
      key === "nsfw_mode"
        ? await setNsfwMode(value)
        : await updateSetting(key, value)
    if (error) setEssentialSetupError(error.message || String(error))
  }

  const openOnboarding = () => {
    setOnboardingRequired(false)
    setOnboardingOpen(true)
    loadMediaFolders()
  }

  const dismissOnboarding = () => {
    if (!onboardingRequired()) setOnboardingOpen(false)
  }

  const completeOnboarding = async () => {
    setEssentialSetupBusy(true)
    setEssentialSetupError(null)
    try {
      const error = await updateSetting("onboarding_completed", "true")
      if (error) throw error
      setOnboardingRequired(false)
      setOnboardingOpen(false)
    } catch (err) {
      setEssentialSetupError(err.message || String(err))
    } finally {
      setEssentialSetupBusy(false)
    }
  }

  const skipOnboarding = async () => {
    await completeOnboarding()
  }

  const loadEssentialSetup = async () => {
    await loadMediaFolders()
  }

  const loadAllPhotos = createLoader(
    "photos",
    () => api.attachments.listAll(visOpts()),
    setAllPhotos
  )

  const loadGeoPhotos = createLoader(
    "geo-photos",
    () => api.attachments.listGeo(visOpts()),
    setGeoPhotos
  )

  const loadNoGpsPhotos = createLoader(
    "no-gps-photos",
    () => api.attachments.listNoGps(visOpts()),
    setNoGpsPhotos
  )

  const loadPhotoCollections = async () => {
    try {
      const photos = await api.attachments.listAll(visOpts())
      setAllPhotos(photos)
      setGeoPhotos(
        photos.filter(
          (photo) => photo.latitude != null && photo.longitude != null
        )
      )
      setNoGpsPhotos(
        photos.filter(
          (photo) => photo.latitude == null || photo.longitude == null
        )
      )
    } catch (err) {
      console.error("[photo-collections] Failed to load:", err)
      setAllPhotos([])
      setGeoPhotos([])
      setNoGpsPhotos([])
    }
  }

  const writeGpsToFile = async (id, latitude, longitude) => {
    try {
      const result = await api.attachments.writeGpsToFile(
        id,
        latitude,
        longitude
      )
      await Promise.all([
        loadGeoPhotos(),
        loadNoGpsPhotos(),
        loadAllPhotos(),
        refreshMessages()
      ])
      return result
    } catch (err) {
      console.error("[app] writeGpsToFile failed:", err)
      throw err
    }
  }

  // Refresh all media-related data in parallel after mutations and imports.
  const refreshAllMedia = async (opts = {}) => {
    await Promise.all([
      refreshMessages(),
      refreshDays(
        opts.preserveSelection !== false ? { preserveSelection: true } : {}
      ),
      refreshMemoryDays({ clearExisting: opts.clearMemoryDays === true }),
      loadPhotoCollections()
    ])
  }

  const loadFolders = createLoader(
    "folders",
    () => api.messages.listFolders(),
    setFolders
  )

  const loadFolderPhotos = createLoader(
    "folder-items",
    () => api.messages.listFolderItems(null),
    setFolderPhotos
  )

  const renameFolder = async (oldName, newName) => {
    try {
      await api.messages.renameFolder(oldName, newName)
      await loadFolders()
      await loadFolderPhotos()
      await refreshMessages()
      await refreshDays({ preserveSelection: true })
    } catch (err) {
      console.error("[rename-folder]", err)
    }
  }

  const regenerateAllThumbnails = async () => {
    if (!api.thumbnails.regenerateAll) {
      return { started: false, reason: "not-available" }
    }

    if (thumbnailRebuildRunning()) {
      return { started: false, reason: "busy" }
    }

    setThumbnailRebuildRunning(true)
    try {
      const result = await api.thumbnails.regenerateAll()
      if (!result?.started) {
        setThumbnailRebuildRunning(false)
      }
      return result
    } catch (err) {
      setThumbnailRebuildRunning(false)
      console.error("[thumbnails] Regenerate all failed:", err)
      return { started: false, reason: err.message }
    }
  }

  // Force-regenerate a single thumbnail (delete cached + recreate from source).
  // Returns { ok, reason? }. The caller should retry the <img> src on success.
  const thumbnailRegenerations = new Map()
  const regenerateThumbnail = (id, variant = "thumb") => {
    if (!api.thumbnails.regenerate) {
      return Promise.resolve({ ok: false, reason: "not-available" })
    }
    const key = `${id}:${variant}`
    if (thumbnailRegenerations.has(key)) return thumbnailRegenerations.get(key)
    const request = api.thumbnails
      .regenerate(id, variant)
      .catch((err) => {
        console.error("[thumbnails] Regenerate failed:", err)
        return { ok: false, reason: err.message }
      })
      .finally(() => thumbnailRegenerations.delete(key))
    thumbnailRegenerations.set(key, request)
    return request
  }

  // onError handler for thumbnail <img> elements.
  // On first failure: requests regeneration from the main process, then
  // retries by appending a cache-busting param. Retry state lives on each
  // image so another visible instance can recover independently.
  const handleThumbnailError = (attachmentId, imgEl) => {
    if (!imgEl) return
    // Immediately hide to prevent broken-image icon flash
    imgEl.style.display = "none"

    const failedSrc = imgEl.src.split("?")[0]
    if (imgEl.dataset.thumbnailRetry === failedSrc) return
    imgEl.dataset.thumbnailRetry = failedSrc
    imgEl.addEventListener(
      "load",
      () => {
        imgEl.style.display = ""
        delete imgEl.dataset.thumbnailRetry
      },
      { once: true }
    )
    const variant = ["thumb", "micro", "year"].find((candidate) =>
      new URL(imgEl.src).pathname.endsWith(`/${candidate}`)
    )
    regenerateThumbnail(attachmentId, variant || "thumb").then((result) => {
      if (
        result.ok &&
        imgEl.isConnected &&
        imgEl.src.split("?")[0] === failedSrc
      ) {
        // Thumbnail regenerated — reload with cache-busting param
        imgEl.src = `${failedSrc}?retry=${Date.now()}`
      }
      // If not ok, leave hidden until a later reactive src change succeeds.
    })
  }

  const setMessageVisibility = mutation(
    "setMessageVisibility",
    (id, visibility) => api.messages.setVisibility(id, visibility),
    () => [refreshAllMedia, loadFolders]
  )

  const batchSetMessageVisibility = mutation(
    "batchSetMessageVisibility",
    (ids, visibility) => api.messages.batchSetVisibility(ids, visibility),
    () => [refreshAllMedia, loadFolders]
  )

  const setView = (view) => {
    if (view === state.view) return
    pushHistory()
    setState("view", view)
  }

  const setSelectedDate = (date) => {
    if (!date || date === state.selectedDate) return
    setState("selectedDate", date)
  }

  const setYearViewYear = (year) => {
    if (!year || year === state.yearViewYear) return
    setState("yearViewYear", year)
  }

  const isTypingTarget = (target) =>
    ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) ||
    target?.isContentEditable

  const handleAltKey = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      goBack()
      return
    }
    const viewMap = {
      1: "timeline",
      2: "photos",
      3: "map",
      4: "settings",
      5: "onThisDay"
    }
    if (viewMap[e.key]) {
      e.preventDefault()
      setView(viewMap[e.key])
    }
  }

  const handleGlobalKeyDown = (e) => {
    if (isTypingTarget(e.target)) return

    if (e.ctrlKey && e.key === ".") {
      e.preventDefault()
      setDotFilesVisible((v) => !v)
    }
    handleAltKey(e)
  }

  onMount(() => {
    // Ctrl+. toggles dot-file visibility; Alt+1..9 switches views.
    window.addEventListener("keydown", handleGlobalKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleGlobalKeyDown))
  })

  onMount(() => {
    initializePlatformApi()
      .then((initializedApi) =>
        setCapabilities({ ...initializedApi.capabilities })
      )
      .catch((error) =>
        console.error("[platform] Capability detection failed:", error)
      )
  })

  onMount(async () => {
    const t0 = performance.now()
    const lap = (label) => {
      const ms = (performance.now() - t0).toFixed(0)
      api.log("info", "renderer-startup", `+${ms}ms  ${label}`)
    }

    try {
      // Settings must load first — nsfwMode affects visibility filtering
      // in refreshDays/refreshMemoryDays via visOpts().
      await loadSettings()
      await loadEssentialSetup()
      lap("settings loaded")
      const memoryLoad = refreshMemoryDays()
      await refreshDays()
      lap("days loaded")

      // These are not needed for the first timeline paint. Loading them after
      // unblocking the UI keeps app startup responsive on large databases.
      queueMicrotask(() => {
        memoryLoad
          .then(() => lap("memory days loaded"))
          .catch((err) => console.error("[memory] Startup load failed:", err))
        loadFolders()
          .then(() => lap("folders loaded"))
          .catch((err) => console.error("[folders] Startup load failed:", err))
      })
    } catch (err) {
      console.error("[app] Startup failed:", err)
    } finally {
      setState("isLoading", false)
      lap("render unblocked (isLoading=false)")
    }

    // Detect date changes (midnight rollover, sleep/wake)
    let lastDate = todayIso()
    const checkDateChange = () => {
      const now = today()
      if (now !== lastDate) {
        lastDate = now
        setTodayIso(now)
        refreshDays({ preserveSelection: true })
        refreshMemoryDays()
      }
    }
    const dateCheckInterval = setInterval(checkDateChange, 60000)
    // Also check immediately when the window regains focus or visibility,
    // since setInterval is unreliable across sleep/wake cycles
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkDateChange()
    }
    const onFocus = () => checkDateChange()
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("focus", onFocus)
    onCleanup(() => {
      clearInterval(dateCheckInterval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", onFocus)
    })

    // Progress listeners for thumbnail generation and photo import
  })

  const progressFinished = (data) =>
    data.complete === true ||
    (data.complete !== false && (data.total === 0 || data.done >= data.total))

  const progressHandler = (storeKey) => (data) => {
    if (progressFinished(data)) {
      setState(storeKey, null)
      if (storeKey === "thumbWarmup") {
        setThumbnailRebuildRunning(false)
      }
    } else {
      setState(storeKey, {
        ...data,
        ...(storeKey === "photoImport" && {
          startedAt:
            data.startedAt ?? state.photoImport?.startedAt ?? Date.now(),
          startedDone:
            data.startedDone ?? state.photoImport?.startedDone ?? data.done
        })
      })
    }
  }

  let photoImportRefreshTimer = null
  let photoImportRefreshRunning = false
  let photoImportFinalRefreshPending = false

  const refreshVisibleImportContent = async (final = false) => {
    if (photoImportRefreshRunning) {
      if (final) photoImportFinalRefreshPending = true
      return
    }
    photoImportRefreshRunning = true
    try {
      if (state.view === "timeline") {
        await Promise.all([
          refreshMessages(),
          ...(final ? [preserveDays(), refreshMemoryDays()] : [])
        ])
      } else if (state.view === "week" || state.view === "year") {
        requestContentRefresh()
      } else if (state.view === "photos") {
        await loadAllPhotos()
      } else if (state.view === "map") {
        await Promise.all([loadAllPhotos(), loadGeoPhotos(), loadNoGpsPhotos()])
      }
    } finally {
      photoImportRefreshRunning = false
      if (photoImportFinalRefreshPending) {
        photoImportFinalRefreshPending = false
        queueMicrotask(() =>
          refreshVisibleImportContent(true).catch((err) =>
            console.error("[photo-import] Final refresh failed:", err)
          )
        )
      }
    }
  }

  const handlePhotoImportProgress = (data) => {
    progressHandler("photoImport")(data)

    if (progressFinished(data)) {
      if (data.total > 0) setState("photoImportResult", data)
      if (data.error) console.error(`[photo-import] ${data.error}`)
      if (photoImportRefreshTimer) clearTimeout(photoImportRefreshTimer)
      photoImportRefreshTimer = null
      refreshVisibleImportContent(true).catch((err) =>
        console.error("[photo-import] Final refresh failed:", err)
      )
      return
    }

    setState("photoImportResult", null)

    if (!photoImportRefreshTimer && !photoImportRefreshRunning) {
      photoImportRefreshTimer = setTimeout(() => {
        photoImportRefreshTimer = null
        refreshVisibleImportContent().catch((err) =>
          console.error("[photo-import] Refresh failed:", err)
        )
      }, 1000)
    }
  }

  onCleanup(() => {
    if (photoImportRefreshTimer) clearTimeout(photoImportRefreshTimer)
  })

  usePushSubscriptions([
    [
      api.on.photosImported,
      async () => {
        await Promise.all([refreshAllMedia(), loadFolders()])
      }
    ],
    [api.on.thumbnailsProgress, progressHandler("thumbWarmup")],
    [api.on.thumbnailsMicroProgress, progressHandler("microWarmup")],
    [api.on.photosImportProgress, handlePhotoImportProgress]
  ])

  createEffect(
    on(
      () => state.currentDayId,
      async (dayId) => {
        if (!dayId) return
        batch(() => {
          setState("messages", [])
          setState("attachmentsByMessage", {})
        })
        // Ensure the day is in state.days so currentDay() can resolve it.
        // This handles cases where selectDay is called from memory days,
        // records, etc. with a day not in the main list.
        if (
          !state.days.some((d) => d.id === dayId) &&
          !state.memoryDays.some((d) => d.id === dayId)
        ) {
          const day = await api.days.get(dayId)
          if (day) {
            setState("days", (prev) => [day, ...prev])
          }
        }
        if (state.currentDayId !== dayId) return
        await refreshMessages(dayId)
      },
      { defer: true }
    )
  )

  // Re-fetch everything when crossing hidden↔non-hidden boundary
  // (switching blurred↔visible does NOT re-fetch — same SQL results)
  // Guard: skip during initial load — loadSettings restores nsfwMode which
  // would trigger a redundant (and racy) refreshDays before onMount finishes.
  createEffect(
    on(
      () => showNsfw(),
      async (showingNsfw) => {
        const clearMemoryDays = !showingNsfw
        if (state.isLoading) {
          if (
            clearMemoryDays &&
            (state.memoryLoading || state.memoryDays.length > 0)
          ) {
            await refreshMemoryDays({ clearExisting: true })
          }
          return
        }
        await Promise.all([refreshAllMedia({ clearMemoryDays }), loadFolders()])
      },
      { defer: true }
    )
  )

  // Re-fetch when dot-files visibility toggles (Ctrl+.)
  createEffect(
    on(
      () => dotFilesVisible(),
      async (visible) => {
        const clearMemoryDays = !visible
        if (state.isLoading) {
          if (
            clearMemoryDays &&
            (state.memoryLoading || state.memoryDays.length > 0)
          ) {
            await refreshMemoryDays({ clearExisting: true })
          }
          return
        }
        await Promise.all([refreshAllMedia({ clearMemoryDays }), loadFolders()])
      },
      { defer: true }
    )
  )

  // Memory days are always relative to today — load once on mount

  return (
    <AppProvider
      value={{
        state,
        currentDay,
        todayIso,
        allPhotos,
        geoPhotos,
        noGpsPhotos,
        settings,
        capabilities,
        selectDay,
        goToToday,
        refreshMessages,
        refreshDays,
        refreshMemoryDays,
        refreshAllMedia,
        updateMessage,
        updatePhotoCaption,
        updateMessageNoteColor,
        updateMessageImportant,
        updateMessageTimestamp,
        deleteMessage,
        batchDeleteMessages,
        loadSettings,
        updateSetting,
        loadAllPhotos,
        loadGeoPhotos,
        loadNoGpsPhotos,
        writeGpsToFile,
        loadMemoryStoryItems,
        memoryStoryRequestTick,
        requestMemoryStory,
        setSelectedDate,
        setYearViewYear,
        setView,
        onboardingOpen,
        onboardingRequired,
        openOnboarding,
        dismissOnboarding,
        completeOnboarding,
        skipOnboarding,
        mediaFolders,
        mediaFolderHint,
        loadMediaFolders,
        addMediaFolder,
        removeMediaFolder,
        toggleMediaFolder,
        setDefaultMediaFolder,
        saveEssentialSetting,
        essentialSetupBusy,
        essentialSetupError,
        goBack,
        canGoBack,
        pendingScrollRestore,
        setPendingScrollRestore,
        initScrollCache,
        scrollToTopTick,
        scrollTimelineToTop,
        contentRefreshTick,
        requestContentRefresh,
        nsfwMode,
        setNsfwMode,
        showNsfw,
        blurNsfw,
        dotFilesVisible,
        folders,
        loadFolders,
        folderPhotos,
        loadFolderPhotos,
        renameFolder,
        setMessageVisibility,
        batchSetMessageVisibility,
        createPhotoGif,
        photoGifAvailable,

        thumbWarmup: () => state.thumbWarmup,
        photoImportResult: () => state.photoImportResult,

        getAttachmentUrl: (id) => `${api.attachments.url(id)}?v=2`,
        getThumbnailUrl: (id, revision) =>
          `${api.attachments.thumbnailUrl(id)}?v=3${
            revision == null ? "" : `&rev=${encodeURIComponent(revision)}`
          }`,
        getMicroThumbnailUrl: (id) =>
          `${api.attachments.microThumbnailUrl(id)}?v=2`,
        getYearThumbnailUrl: (id) =>
          `${api.attachments.yearThumbnailUrl(id)}?v=1`,
        openAttachment: (id) => api.attachments.open(id),
        regenerateThumbnail,
        regenerateAllThumbnails,
        thumbnailRebuildRunning,
        handleThumbnailError
      }}
    >
      {props.children}
    </AppProvider>
  )
}
