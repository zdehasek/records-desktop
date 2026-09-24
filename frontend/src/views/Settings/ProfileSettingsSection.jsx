import { useConfirm } from "../../context/ConfirmContext.jsx"
import { useApi } from "../../context/PlatformContext.jsx"
import { createSignal, For, onMount, Show } from "solid-js"

export function ProfileSettingsSection() {
  const api = useApi()
  const confirm = useConfirm()
  const [profileState, setProfileState] = createSignal({
    active: api.capabilities?.profile,
    profiles: []
  })
  const [creating, setCreating] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [switching, setSwitching] = createSignal(false)
  const [error, setError] = createSignal("")
  const [name, setName] = createSignal("")

  const load = async () => {
    try {
      setProfileState(await api.profiles.list())
    } catch (currentError) {
      setError(currentError.message)
    }
  }

  onMount(() => {
    load()
  })

  const create = async (event) => {
    event.preventDefault()
    if (!name().trim()) {
      setError("Choose a profile name.")
      return
    }
    setBusy(true)
    setError("")
    try {
      await api.profiles.create({
        name: name().trim()
      })
      setName("")
      setCreating(false)
      await load()
    } catch (currentError) {
      setError(currentError.message)
    } finally {
      setBusy(false)
    }
  }

  const switchProfile = async (profile) => {
    if (profile.id === profileState().active?.id || switching()) return
    const accepted = await confirm(
      `Switch from ${profileState().active?.name || "the current profile"} to ${profile.name}? Records will restart using the selected profile.`,
      { confirmText: "Switch profile" }
    )
    if (!accepted) return
    setError("")
    setSwitching(true)
    try {
      await api.profiles.switch(profile.id)
    } catch (currentError) {
      setSwitching(false)
      setError(currentError.message)
    }
  }

  return (
    <div class="settings-view__card profile-settings">
      <div class="profile-settings__heading">
        <div>
          <label class="settings-panel__section-title">Profiles</label>
          <p class="settings-panel__hint">
            Each profile has separate configuration, data, caches, and browser
            state.
          </p>
        </div>
        <span class="settings-panel__badge">
          {profileState().active?.name || "Loading"}
        </span>
      </div>

      <Show
        when={!switching()}
        fallback={
          <div class="profile-settings__switching" role="status">
            Switching profiles. Records will reopen when the new profile is
            ready.
          </div>
        }
      >
        <div class="profile-settings__list">
          <For each={profileState().profiles}>
            {(profile) => (
              <button
                type="button"
                class="profile-settings__profile"
                classList={{
                  "profile-settings__profile--active":
                    profile.id === profileState().active?.id
                }}
                disabled={busy()}
                onClick={() => switchProfile(profile)}
              >
                <span>{profile.name}</span>
                <small>
                  {profile.id === profileState().active?.id
                    ? "Active"
                    : "Switch"}
                </small>
              </button>
            )}
          </For>
        </div>

        <Show
          when={creating()}
          fallback={
            <button
              type="button"
              class="btn btn--sm"
              onClick={() => setCreating(true)}
            >
              Create profile
            </button>
          }
        >
          <form class="profile-settings__form" onSubmit={create}>
            <label class="settings-panel__field">
              <span class="settings-panel__label">Profile name</span>
              <input
                class="settings-panel__input"
                value={name()}
                maxlength="64"
                placeholder="Demo"
                disabled={busy()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <div class="profile-settings__actions">
              <button class="btn btn--sm" disabled={busy()}>
                {busy() ? "Creating..." : "Create profile"}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                disabled={busy()}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </Show>

      <Show when={error()}>
        <p
          class="settings-panel__hint settings-panel__hint--error"
          role="alert"
        >
          {error()}
        </p>
      </Show>
    </div>
  )
}
