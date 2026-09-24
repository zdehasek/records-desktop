import { useApp } from "../context/AppContext.jsx"
import { MediaFoldersSection } from "../views/Settings/MediaFoldersSection.jsx"
import {
  NsfwSetupField,
  PreferenceSetupFields
} from "./EssentialSetupFields.jsx"
import { onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"

export function OnboardingModal() {
  const {
    onboardingRequired,
    dismissOnboarding,
    completeOnboarding,
    skipOnboarding,
    mediaFolders,
    mediaFolderHint,
    addMediaFolder,
    removeMediaFolder,
    toggleMediaFolder,
    setDefaultMediaFolder,
    essentialSetupBusy,
    essentialSetupError
  } = useApp()
  let panel
  const previouslyFocused = document.activeElement

  const close = () => {
    if (!onboardingRequired()) dismissOnboarding()
  }

  const focusable = () => [
    ...(panel?.querySelectorAll(
      "button:not(:disabled), select:not(:disabled)"
    ) || [])
  ]

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      if (!onboardingRequired()) {
        event.preventDefault()
        close()
      }
      return
    }
    if (event.key !== "Tab") return
    const controls = focusable()
    if (!controls.length) return
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown, true)
    requestAnimationFrame(() => panel?.querySelector("button, select")?.focus())
  })

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown, true)
    previouslyFocused?.focus?.()
  })

  return (
    <Portal>
      <div class="onboarding">
        <div class="onboarding__backdrop" aria-hidden="true" />
        <section
          ref={panel}
          class="onboarding__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
        >
          <header class="onboarding__header">
            <div>
              <span class="onboarding__eyebrow">Welcome</span>
              <h2 id="onboarding-title" class="onboarding__title">
                Set Up Records
              </h2>
            </div>
            <Show when={!onboardingRequired()}>
              <button
                type="button"
                class="onboarding__close"
                aria-label="Close onboarding"
                onClick={close}
              >
                ×
              </button>
            </Show>
          </header>

          <div class="onboarding__body">
            <div class="onboarding__intro">
              Choose folders to scan and star the one Records should use when
              you add photos or videos. You can change these choices later in
              Settings.
            </div>
            <div class="onboarding__setup-grid">
              <div class="onboarding__section">
                <MediaFoldersSection
                  embedded
                  mediaFolders={mediaFolders}
                  mediaFolderHint={mediaFolderHint}
                  handleAdd={addMediaFolder}
                  handleRemove={removeMediaFolder}
                  handleToggle={toggleMediaFolder}
                  handleSetDefault={setDefaultMediaFolder}
                  disabled={essentialSetupBusy}
                />
              </div>
              <div class="onboarding__section onboarding__form-grid">
                <NsfwSetupField />
                <PreferenceSetupFields />
              </div>
            </div>

            <Show when={essentialSetupError()}>
              <p class="onboarding__error" role="alert">
                {essentialSetupError()}
              </p>
            </Show>
          </div>

          <footer class="onboarding__footer">
            <span class="onboarding__footer-note">Local-first by default</span>
            <div class="onboarding__actions">
              <Show when={onboardingRequired()}>
                <button
                  type="button"
                  class="btn btn--sm btn--ghost"
                  disabled={essentialSetupBusy()}
                  onClick={skipOnboarding}
                >
                  Skip setup
                </button>
              </Show>
              <button
                type="button"
                class="btn btn--sm onboarding__primary"
                disabled={essentialSetupBusy()}
                onClick={completeOnboarding}
              >
                {essentialSetupBusy() ? "Saving..." : "Finish"}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Portal>
  )
}
