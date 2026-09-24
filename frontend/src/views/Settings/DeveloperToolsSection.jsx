export function DeveloperToolsSection(props) {
  return (
    <div class="settings-view__card">
      <label class="settings-panel__section-title">Developer Tools</label>
      <div class="settings-panel__field">
        <button
          class="btn btn--sm"
          onClick={() => {
            props.api.toggleDevTools()
          }}
        >
          Toggle Developer Tools
        </button>
        <span class="settings-panel__hint">
          Open browser DevTools for debugging (F12)
        </span>
      </div>
    </div>
  )
}
