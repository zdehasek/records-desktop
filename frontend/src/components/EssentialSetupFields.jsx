import { useApp } from "../context/AppContext.jsx"
import { NSFW_HINTS, NSFW_MODES } from "../views/Settings/lib/helpers.js"
import { For, Show } from "solid-js"

const WEEK_START_OPTIONS = [
  { value: "monday", label: "Monday" },
  { value: "sunday", label: "Sunday" },
  { value: "saturday", label: "Saturday" }
]

export function SegmentedSetting(props) {
  return (
    <div class="settings-panel__field">
      <div class="settings-panel__field--row">
        <label class="settings-panel__label">{props.label}</label>
        <div
          class="settings-panel__segmented"
          role="group"
          aria-label={props.label}
        >
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                class="settings-panel__segmented-btn"
                classList={{
                  "settings-panel__segmented-btn--active":
                    props.value() === option.value
                }}
                aria-pressed={props.value() === option.value}
                disabled={props.disabled?.()}
                onClick={() => props.onChange(option.value)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={props.hint}>
        <span class="settings-panel__hint">{props.hint}</span>
      </Show>
    </div>
  )
}

export function NsfwSetupField() {
  const { nsfwMode, saveEssentialSetting, essentialSetupBusy } = useApp()

  return (
    <SegmentedSetting
      label="NSFW media"
      options={NSFW_MODES}
      value={nsfwMode}
      disabled={essentialSetupBusy}
      onChange={(value) => saveEssentialSetting("nsfw_mode", value)}
      hint={NSFW_HINTS[nsfwMode()]}
    />
  )
}

export function PreferenceSetupFields() {
  const { settings, saveEssentialSetting, essentialSetupBusy } = useApp()

  return (
    <>
      <SegmentedSetting
        label="Week starts"
        options={WEEK_START_OPTIONS}
        value={() => settings().week_start_day || "monday"}
        disabled={essentialSetupBusy}
        onChange={(value) => saveEssentialSetting("week_start_day", value)}
      />
    </>
  )
}
