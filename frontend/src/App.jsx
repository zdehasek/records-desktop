import { BatchActionBar } from "./components/BatchActionBar.jsx"
import { BottomNav } from "./components/BottomNav.jsx"
import { OnboardingModal } from "./components/OnboardingModal.jsx"
import { TopBar } from "./components/TopBar.jsx"
import { AppWrapper, useApp } from "./context/AppContext.jsx"
import { ConfirmProvider } from "./context/ConfirmContext.jsx"
import { PlatformProvider } from "./context/PlatformContext.jsx"
import { SelectionWrapper } from "./context/SelectionContext.jsx"
import { getPlatformApi } from "./lib/api.js"
import { Timeline } from "./views/Timeline/Timeline.jsx"
import {
  createEffect,
  createSignal,
  ErrorBoundary,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch
} from "solid-js"

const mapViewImport = () => import("./views/MapView/MapView.jsx")
const MapView = lazy(mapViewImport)
const OnThisDay = lazy(() => import("./views/OnThisDay/OnThisDay.jsx"))
const Records = lazy(() => import("./views/Records/Records.jsx"))
const Settings = lazy(() => import("./views/Settings/Settings.jsx"))
const Week = lazy(() => import("./views/Week/Week.jsx"))
const Year = lazy(() => import("./views/Year/Year.jsx"))
const routeToView = {
  today: "timeline",
  week: "week",
  year: "year",
  photos: "photos",
  map: "map",
  "on-this-day": "onThisDay",
  settings: "settings"
}
const viewToRoute = Object.fromEntries(
  Object.entries(routeToView).map(([route, view]) => [view, route])
)

// Eagerly preload the MapView chunk so it's cached by the time the user
// clicks "Map". Runs after initial paint via rIC/timeout.
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => mapViewImport(), { timeout: 3000 })
} else {
  setTimeout(() => mapViewImport(), 2000)
}

function AppContent() {
  const {
    state,
    dotFilesVisible,
    onboardingOpen,
    setView,
    requestMemoryStory
  } = useApp()

  onMount(() => {
    const applyRoute = () => {
      const route = window.location.hash.slice(1)
      const view = routeToView[route]
      if (view) setView(view)
      else if (route === "on-this-day-story") {
        requestMemoryStory()
        window.history.replaceState(null, "", "#on-this-day")
      } else {
        setView("timeline")
        window.history.replaceState(null, "", "#today")
      }
    }
    applyRoute()
    window.addEventListener("hashchange", applyRoute)
    onCleanup(() => window.removeEventListener("hashchange", applyRoute))
  })

  createEffect(() => {
    if (window.location.hash === "#on-this-day-story") {
      return
    }
    const route = viewToRoute[state.view] || "today"
    if (window.location.hash !== `#${route}`) {
      window.history.replaceState(null, "", `#${route}`)
    }
  })

  // MapView is kept alive in the DOM (hidden via CSS) so the WebGL context
  // and downloaded tiles persist across view switches. We pre-mount it in
  // the background after startup so the first open is instant.
  const [mapMounted, setMapMounted] = createSignal(false)
  const [weekMounted, setWeekMounted] = createSignal(false)
  const [yearMounted, setYearMounted] = createSignal(false)
  const [recordsMounted, setRecordsMounted] = createSignal(false)
  const [onThisDayMounted, setOnThisDayMounted] = createSignal(false)

  // Mount immediately if user navigates to map before background init fires
  createEffect(
    on(
      () => state.view,
      (view) => {
        if (view === "map") setMapMounted(true)
        if (view === "week") setWeekMounted(true)
        if (view === "year") setYearMounted(true)
        if (view === "photos") setRecordsMounted(true)
        if (view === "onThisDay") setOnThisDayMounted(true)
      }
    )
  )

  // Pre-mount map hidden in the background after startup settles.
  // Deferred 30s so the heavy photo-loading IPC calls (19k+ rows)
  // and WebGL init don't compete with the initial render, thumbnail
  // serving and photo scans, which run in the first
  // 15 seconds. Mounting earlier caused "Application Not Responding"
  // dialogs from the window manager.
  createEffect(
    on(
      () => state.isLoading,
      (loading) => {
        if (!loading && !mapMounted()) {
          const timer = setTimeout(() => setMapMounted(true), 30_000)
          onCleanup(() => clearTimeout(timer))
        }
      },
      { defer: true }
    )
  )

  const isSettings = () => state.view === "settings"
  const isMainView = () =>
    ["timeline", "week", "year", "photos", "map", "onThisDay"].includes(
      state.view
    )

  return (
    <SelectionWrapper>
      <div
        class="app-shell"
        inert={onboardingOpen()}
        aria-hidden={onboardingOpen() ? "true" : undefined}
      >
        <TopBar hidden={isSettings()} />
        <main
          class="app-content"
          classList={{
            "app-content--dotfiles-visible": dotFilesVisible(),
            "app-content--fullscreen": isSettings()
          }}
        >
          <ErrorBoundary
            fallback={(err, reset) => (
              <div class="error-boundary">
                <p class="error-boundary__message">
                  This view encountered an error
                </p>
                <pre class="error-boundary__detail">
                  {err?.message || String(err)}
                </pre>
                <button class="btn btn--sm" onClick={reset}>
                  Try again
                </button>
              </div>
            )}
          >
            {/* MapView is rendered outside the Switch so it stays alive
              across view switches — preserving the WebGL context and
              downloaded tiles. Hidden via CSS when not the active view. */}
            <Show when={mapMounted()}>
              <Suspense>
                <MapView hidden={state.view !== "map"} />
              </Suspense>
            </Show>

            <div
              class="app-view"
              classList={{ "app-view--hidden": state.view !== "timeline" }}
            >
              <Timeline />
            </div>

            <Suspense>
              <Show when={onThisDayMounted()}>
                <div
                  class="app-view"
                  classList={{
                    "app-view--hidden": state.view !== "onThisDay"
                  }}
                >
                  <OnThisDay />
                </div>
              </Show>
              <Show when={weekMounted()}>
                <div
                  class="app-view"
                  classList={{ "app-view--hidden": state.view !== "week" }}
                >
                  <Week />
                </div>
              </Show>
              <Show when={yearMounted()}>
                <div
                  class="app-view"
                  classList={{ "app-view--hidden": state.view !== "year" }}
                >
                  <Year />
                </div>
              </Show>
              <Show when={recordsMounted()}>
                <div
                  class="app-view"
                  classList={{
                    "app-view--hidden": state.view !== "photos"
                  }}
                >
                  <Records />
                </div>
              </Show>
            </Suspense>

            <Show when={!isMainView()}>
              <Suspense>
                <Switch>
                  <Match when={state.view === "settings"}>
                    <Settings />
                  </Match>
                </Switch>
              </Suspense>
            </Show>
          </ErrorBoundary>
        </main>
        <BottomNav hidden={isSettings()} />
        <BatchActionBar />
      </div>
      <Show when={onboardingOpen()}>
        <OnboardingModal />
      </Show>
    </SelectionWrapper>
  )
}

export function App() {
  const api = getPlatformApi()

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div class="error-boundary error-boundary--fatal">
          <h2 class="error-boundary__title">Something went wrong</h2>
          <pre class="error-boundary__detail">
            {err?.message || String(err)}
          </pre>
          <button class="btn" onClick={reset}>
            Try again
          </button>
        </div>
      )}
    >
      <PlatformProvider value={api}>
        <ConfirmProvider>
          <AppWrapper>
            <AppContent />
          </AppWrapper>
        </ConfirmProvider>
      </PlatformProvider>
    </ErrorBoundary>
  )
}
