import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show
} from "solid-js"

const MOBILE_BREAKPOINT = 767

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function loadStoredWidth(storageKey, fallback) {
  if (!storageKey) return fallback
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export function ResizableSidebarLayout(props) {
  const minWidth = () => props.minWidth ?? 140
  const maxWidth = () => props.maxWidth ?? 420
  const defaultWidth = () => props.defaultWidth ?? 180
  const showSidebar = () => {
    const value =
      typeof props.showSidebar === "function"
        ? props.showSidebar()
        : props.showSidebar
    return value !== false
  }

  const [sidebarWidth, setSidebarWidth] = createSignal(defaultWidth())
  const [isDesktop, setIsDesktop] = createSignal(true)
  const [isResizing, setIsResizing] = createSignal(false)

  const clampWidth = (width) => {
    const viewportMax = Math.floor(window.innerWidth * 0.45)
    const hardMax = Math.min(maxWidth(), viewportMax)
    return clamp(width, minWidth(), hardMax)
  }

  const syncDesktop = () => {
    setIsDesktop(window.innerWidth > MOBILE_BREAKPOINT)
    setSidebarWidth((prev) => clampWidth(prev))
  }

  onMount(() => {
    const initial = loadStoredWidth(props.storageKey, defaultWidth())
    setSidebarWidth(clampWidth(initial))
    syncDesktop()
    window.addEventListener("resize", syncDesktop)
    onCleanup(() => window.removeEventListener("resize", syncDesktop))
  })

  createEffect(
    on(
      () => sidebarWidth(),
      (value) => {
        if (!props.storageKey) return
        localStorage.setItem(props.storageKey, String(Math.round(value)))
      },
      { defer: true }
    )
  )

  createEffect(() => {
    document.body.classList.toggle("resizable-layout--resizing", isResizing())
    onCleanup(() => {
      document.body.classList.remove("resizable-layout--resizing")
    })
  })

  const startResize = (e) => {
    if (!isDesktop() || !showSidebar()) return
    e.preventDefault()

    const startX = e.clientX
    const startWidth = sidebarWidth()
    setIsResizing(true)

    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX
      setSidebarWidth(clampWidth(startWidth + delta))
    }

    const onEnd = () => {
      setIsResizing(false)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onEnd)
      window.removeEventListener("pointercancel", onEnd)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onEnd)
    window.addEventListener("pointercancel", onEnd)
  }

  const resizeByKeyboard = (e) => {
    if (!isDesktop() || !showSidebar()) return
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    const delta = e.key === "ArrowRight" ? 12 : -12
    setSidebarWidth((prev) => clampWidth(prev + delta))
  }

  return (
    <div class={`resizable-layout ${props.class || ""}`.trim()}>
      <Show when={showSidebar()}>
        <aside
          class={`resizable-layout__sidebar ${props.sidebarClass || ""}`.trim()}
          style={{ width: `${Math.round(sidebarWidth())}px` }}
        >
          {props.sidebar}
        </aside>
        <div
          class="resizable-layout__divider"
          role="separator"
          aria-orientation="vertical"
          tabIndex="0"
          aria-valuemin={minWidth()}
          aria-valuemax={maxWidth()}
          aria-valuenow={Math.round(sidebarWidth())}
          onPointerDown={startResize}
          onKeyDown={resizeByKeyboard}
        />
      </Show>
      <section
        class={`resizable-layout__content ${props.contentClass || ""}`.trim()}
        ref={(el) => {
          if (typeof props.contentRef === "function") props.contentRef(el)
        }}
      >
        {props.children}
      </section>
    </div>
  )
}
