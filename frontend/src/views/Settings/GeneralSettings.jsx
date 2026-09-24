import {
  NsfwSetupField,
  PreferenceSetupFields
} from "../../components/EssentialSetupFields.jsx"
import { For, Show } from "solid-js"

export function GeneralSettings(props) {
  return (
    <div class="settings-view__card">
      <label class="settings-panel__section-title">General</label>

      <div class="settings-panel__field settings-panel__field--row">
        <div>
          <label class="settings-panel__label">Onboarding</label>
          <span class="settings-panel__hint">
            Review first-run setup and core workflows.
          </span>
        </div>
        <button class="btn btn--sm" onClick={props.openOnboarding}>
          Run onboarding again
        </button>
      </div>

      <PreferenceSetupFields />
      <NsfwSetupField />

      <div class="settings-panel__field">
        <div class="settings-panel__field--row">
          <label class="settings-panel__label">Week Overview Photos</label>
          <div
            class="settings-panel__segmented"
            role="group"
            aria-label="Week Overview Photos"
          >
            <For
              each={[
                { value: "false", label: "Off" },
                { value: "true", label: "On" }
              ]}
            >
              {(option) => (
                <button
                  type="button"
                  class="settings-panel__segmented-btn"
                  classList={{
                    "settings-panel__segmented-btn--active":
                      (props.settings()?.auto_photo_in_week_overview ||
                        "false") === option.value
                  }}
                  aria-pressed={
                    (props.settings()?.auto_photo_in_week_overview ||
                      "false") === option.value
                  }
                  onClick={() =>
                    props.updateSetting(
                      "auto_photo_in_week_overview",
                      option.value
                    )
                  }
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <span class="settings-panel__hint">
          Auto-pick a photo for days without a set photo of the day
        </span>
      </div>

      <div class="settings-panel__field settings-panel__field--row">
        <div>
          <label class="settings-panel__label">On This Day reminders</label>
          <span class="settings-panel__hint">
            Show a private notification only on days with memories.
          </span>
        </div>
        <div class="settings-panel__segmented">
          <For
            each={[
              { value: "false", label: "Off" },
              { value: "true", label: "On" }
            ]}
          >
            {(opt) => (
              <button
                class="settings-panel__segmented-btn"
                classList={{
                  "settings-panel__segmented-btn--active":
                    (props.settings()?.on_this_day_notifications || "true") ===
                    opt.value
                }}
                onClick={() =>
                  props.updateSetting("on_this_day_notifications", opt.value)
                }
              >
                {opt.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show
        when={
          (props.settings()?.on_this_day_notifications || "true") !== "false"
        }
      >
        <div class="settings-panel__field settings-panel__field--row">
          <div>
            <label class="settings-panel__label" for="on-this-day-time">
              Reminder time
            </label>
            <span class="settings-panel__hint">Uses your local time.</span>
          </div>
          <input
            id="on-this-day-time"
            class="settings-panel__input settings-panel__time-input"
            type="time"
            value={props.settings()?.on_this_day_notification_time || "09:00"}
            onChange={(event) =>
              props.updateSetting(
                "on_this_day_notification_time",
                event.currentTarget.value
              )
            }
          />
        </div>
      </Show>

      <div class="settings-panel__field settings-panel__gallery-btns">
        <button
          class="btn btn--sm settings-panel__nsfw-gallery-btn"
          onClick={() => props.setShowGallery(true)}
        >
          NSFW Gallery
        </button>
      </div>
    </div>
  )
}
