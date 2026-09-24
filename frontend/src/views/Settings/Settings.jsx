import { useApp } from "../../context/AppContext.jsx"
import { useApi } from "../../context/PlatformContext.jsx"
import { FolderGallery } from "./components/FolderGallery.jsx"
import { DeveloperToolsSection } from "./DeveloperToolsSection.jsx"
import { GeneralSettings } from "./GeneralSettings.jsx"
import { ThumbnailToolsSection } from "./ThumbnailToolsSection.jsx"
import { ProfileSettingsSection } from "./ProfileSettingsSection.jsx"
import { MediaFoldersSection } from "./MediaFoldersSection.jsx"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

export default function Settings() {
  const {
    thumbWarmup,
    photoImportResult,
    settings,
    capabilities,
    updateSetting,
    goBack,
    regenerateAllThumbnails,
    thumbnailRebuildRunning,
    openOnboarding,
    mediaFolders,
    mediaFolderHint,
    addMediaFolder,
    removeMediaFolder,
    toggleMediaFolder,
    setDefaultMediaFolder,
    essentialSetupBusy,
    essentialSetupError
  } = useApp()
  const api = useApi()
  const missingSystemPackages = () => capabilities().missingSystemPackages || []
  const missingOptionalSystemPackages = () =>
    capabilities().missingOptionalSystemPackages || []
  const isOmarchy = () => api.platform.kind === "omarchy"
  const [showGallery, setShowGallery] = createSignal(false)

  const handleRegenerateAllThumbnails = async () => {
    const result = await regenerateAllThumbnails()
    if (!result?.started && result?.reason && result.reason !== "busy") {
      console.error("[settings] Thumbnail regenerate failed:", result.reason)
    }
  }

  // ESC to go back
  const handleKeydown = (e) => {
    if (e.key === "Escape") {
      if (showGallery()) {
        setShowGallery(false)
        return
      }
      goBack()
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  return (
    <>
      <div class="settings-view">
        <div class="settings-view__header">
          <button type="button" class="settings-view__back" onClick={goBack}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M15 19l-7-7 7-7" />
            </svg>
            Back
            <span class="settings-view__esc-hint">ESC</span>
          </button>
          <h1 class="settings-view__title">Settings</h1>
          <span class="settings-view__profile">
            {capabilities().profile?.name}
          </span>
        </div>

        <div class="settings-view__body">
          <div class="settings-view__grid">
            <div class="settings-view__column">
              <ProfileSettingsSection />
              <GeneralSettings
                settings={settings}
                updateSetting={updateSetting}
                setShowGallery={setShowGallery}
                openOnboarding={openOnboarding}
              />

              <Show when={capabilities().thumbnails}>
                <ThumbnailToolsSection
                  thumbWarmup={thumbWarmup}
                  thumbnailRebuildRunning={thumbnailRebuildRunning}
                  handleRegenerateAllThumbnails={handleRegenerateAllThumbnails}
                />
              </Show>

              <Show when={capabilities().developerTools}>
                <DeveloperToolsSection api={api} />
              </Show>
            </div>

            <div class="settings-view__column">
              <Show
                when={
                  missingSystemPackages().length > 0 ||
                  missingOptionalSystemPackages().length > 0
                }
              >
                <div
                  class="settings-view__card"
                  classList={{
                    "settings-view__card--warning":
                      missingSystemPackages().length > 0
                  }}
                >
                  <label class="settings-panel__section-title">
                    {missingSystemPackages().length > 0
                      ? "System dependencies missing"
                      : "Optional system tool unavailable"}
                  </label>
                  <Show when={missingSystemPackages().length > 0}>
                    <p class="settings-panel__hint">
                      Some Records features are unavailable because these
                      dependencies could not be found:{" "}
                      {missingSystemPackages().join(", ")}.
                    </p>
                    <Show when={isOmarchy()}>
                      <code class="settings-panel__command">
                        omarchy pkg add {missingSystemPackages().join(" ")}
                      </code>
                    </Show>
                  </Show>
                  <Show when={missingOptionalSystemPackages().length > 0}>
                    <p class="settings-panel__hint">
                      ExifTool is unavailable, so Records cannot write GPS edits
                      and captions into image files.
                    </p>
                    <Show when={isOmarchy()}>
                      <code class="settings-panel__command">
                        omarchy pkg add perl-image-exiftool
                      </code>
                    </Show>
                  </Show>
                  <p class="settings-panel__hint">
                    {isOmarchy()
                      ? "Restart Records after installing system packages."
                      : "Reinstall Records if bundled media tools are unavailable."}
                  </p>
                </div>
              </Show>

              <Show when={capabilities().mediaFolders}>
                <MediaFoldersSection
                  mediaFolders={mediaFolders}
                  mediaFolderHint={mediaFolderHint}
                  scanSummary={photoImportResult}
                  handleAdd={addMediaFolder}
                  handleRemove={removeMediaFolder}
                  handleToggle={toggleMediaFolder}
                  handleSetDefault={setDefaultMediaFolder}
                  disabled={essentialSetupBusy}
                />
              </Show>

              <Show when={essentialSetupError()}>
                <span
                  class="settings-panel__hint settings-panel__hint--error"
                  role="alert"
                >
                  {essentialSetupError()}
                </span>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <Show when={showGallery()}>
        <FolderGallery onClose={() => setShowGallery(false)} />
      </Show>
    </>
  )
}
