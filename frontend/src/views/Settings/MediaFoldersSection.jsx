import { For, Show } from "solid-js"

const folderLabel = (folder) =>
  folder.path.split("/").filter(Boolean).at(-1) || folder.path

export function MediaFoldersSection(props) {
  return (
    <div class={props.embedded ? "" : "settings-view__card"}>
      <label class="settings-panel__section-title">
        {props.title || "Folders to scan"}
      </label>
      <p class="settings-panel__hint">
        Records scans enabled folders in place. Adding a photo or video copies
        it into records/ inside the starred folder.
      </p>
      <Show when={props.scanSummary?.()?.total > 0}>
        <p class="settings-panel__hint" role="status">
          Last scan: {props.scanSummary().indexed.toLocaleString()} indexed
          {props.scanSummary().skipped > 0
            ? `, ${props.scanSummary().skipped.toLocaleString()} skipped`
            : ""}
          {props.scanSummary().errors > 0
            ? `, ${props.scanSummary().errors.toLocaleString()} errors`
            : ""}
          .
        </p>
      </Show>
      <Show
        when={props.mediaFolders().length > 0}
        fallback={
          <p class="settings-panel__hint">
            No folders configured. Add one to start scanning photos and videos.
          </p>
        }
      >
        <div class="tile-grid media-folders__grid">
          <For each={props.mediaFolders()}>
            {(folder) => {
              const label = () => folderLabel(folder)
              return (
                <div class="tile-grid__item tile-grid__item--card media-folder">
                  <button
                    type="button"
                    class="media-folder__default"
                    classList={{
                      "media-folder__default--active": folder.isDefault
                    }}
                    aria-pressed={folder.isDefault}
                    aria-label={
                      folder.isDefault
                        ? `${label()} is the default folder`
                        : `Set ${label()} as the default folder`
                    }
                    title={
                      folder.isDefault ? "Default for Add" : "Set as default"
                    }
                    disabled={
                      props.disabled?.() ||
                      (!folder.isDefault && (!folder.enabled || !folder.exists))
                    }
                    onClick={() => {
                      if (!folder.isDefault) props.handleSetDefault(folder.path)
                    }}
                  >
                    <span aria-hidden="true">
                      {folder.isDefault ? "★" : "☆"}
                    </span>
                  </button>
                  <div class="media-folder__identity">
                    <span class="tile-grid__icon">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                    </span>
                    <span class="media-folder__name-and-path">
                      <span class="tile-grid__label" title={folder.path}>
                        {label()}
                      </span>
                      <code class="essential-setup__path">{folder.path}</code>
                    </span>
                  </div>
                  <div class="media-folder__meta">
                    <Show when={folder.isDefault}>
                      <span class="media-folder__default-label">
                        Default for Add
                      </span>
                    </Show>
                    <span
                      class="tile-grid__status"
                      classList={{
                        "tile-grid__status--disabled":
                          folder.exists && !folder.enabled,
                        "tile-grid__status--error": !folder.exists
                      }}
                    >
                      {!folder.exists
                        ? "Not found"
                        : folder.enabled
                          ? "Watching"
                          : "Paused"}
                    </span>
                    <span class="media-folder__default-label">
                      {folder.indexedCount.toLocaleString()} indexed
                    </span>
                  </div>
                  <div class="tile-grid__actions">
                    <button
                      type="button"
                      class="btn btn--ghost btn--sm"
                      disabled={props.disabled?.() || folder.isDefault}
                      onClick={() =>
                        props.handleToggle(folder.path, folder.enabled)
                      }
                    >
                      {folder.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      class="btn btn--ghost btn--sm"
                      disabled={props.disabled?.()}
                      onClick={() => props.handleRemove(folder.path)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
      <Show when={props.mediaFolderHint()}>
        <p class="settings-panel__hint">{props.mediaFolderHint()}</p>
      </Show>
      <button
        type="button"
        class="btn btn--sm"
        disabled={props.disabled?.()}
        onClick={props.handleAdd}
      >
        Add Folder
      </button>
    </div>
  )
}
