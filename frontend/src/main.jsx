import { render } from "solid-js/web"
import { App } from "./App.jsx"
import { getOptionalPlatformApi, initializePlatformApi } from "./lib/api.js"

// Bundled fonts — no external network requests.
// Inter: UI font (weights 400–900)
import "@fontsource/inter/latin-400.css"
import "@fontsource/inter/latin-ext-400.css"
import "@fontsource/inter/latin-500.css"
import "@fontsource/inter/latin-ext-500.css"
import "@fontsource/inter/latin-600.css"
import "@fontsource/inter/latin-ext-600.css"
import "@fontsource/inter/latin-700.css"
import "@fontsource/inter/latin-ext-700.css"
import "@fontsource/inter/latin-800.css"
import "@fontsource/inter/latin-ext-800.css"
import "@fontsource/inter/latin-900.css"
import "@fontsource/inter/latin-ext-900.css"
// Caveat: handwriting font (weights 400–700)
import "@fontsource/caveat/latin-400.css"
import "@fontsource/caveat/latin-ext-400.css"
import "@fontsource/caveat/latin-500.css"
import "@fontsource/caveat/latin-ext-500.css"
import "@fontsource/caveat/latin-600.css"
import "@fontsource/caveat/latin-ext-600.css"
import "@fontsource/caveat/latin-700.css"
import "@fontsource/caveat/latin-ext-700.css"

import "./css/reset.css"
import "./css/tokens.css"
import "./css/base.css"
import "./css/components/index.css"

document.documentElement.classList.add("dark")
document.documentElement.classList.remove("light")
document.documentElement.style.colorScheme = "dark"

// Global error handlers — forward to main process log file
window.addEventListener("error", (event) => {
  const msg = event.error?.stack || event.message || "Unknown error"
  getOptionalPlatformApi()?.log?.("error", "renderer", `Uncaught: ${msg}`)
})

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason
  const msg = reason?.stack || reason?.message || String(reason)
  getOptionalPlatformApi()?.log?.(
    "error",
    "renderer",
    `Unhandled rejection: ${msg}`
  )
})

const root = document.getElementById("root")
render(() => <App />, root)
initializePlatformApi()
  .then((api) => {
    const profile = api.capabilities?.profile
    if (profile?.name) document.title = `Records - ${profile.name}`
  })
  .catch((error) =>
    console.error("[platform] Capability detection failed:", error)
  )
