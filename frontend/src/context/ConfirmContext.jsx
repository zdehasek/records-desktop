import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"

import { createSimpleContext } from "../lib/create-context.jsx"

const ConfirmContext = createSimpleContext("Confirm")
const DEFAULT_ACTIONS = [
  {
    label: "OK",
    value: true,
    primary: true
  },
  {
    label: "Cancel",
    value: false
  }
]

export function ConfirmProvider(props) {
  const [dialog, setDialog] = createSignal(null)
  const [inputValue, setInputValue] = createSignal("")

  let resolver = null

  const close = (value) => {
    resolver?.(value)
    resolver = null
    setDialog(null)
  }

  const confirm = (message, options = {}) =>
    new Promise((resolve) => {
      resolver?.(false)
      resolver = resolve
      setInputValue("")
      setDialog({
        message,
        inputLabel: options.inputLabel,
        inputMatch: options.inputMatch,
        actions: options.actions || [
          { ...DEFAULT_ACTIONS[0], label: options.confirmText || "OK" },
          { ...DEFAULT_ACTIONS[1], label: options.cancelText || "Cancel" }
        ]
      })
    })

  const inputMatches = () => {
    const match = dialog()?.inputMatch
    return !match || inputValue().trim() === match
  }

  const actionDisabled = (action) => action?.primary && !inputMatches()

  createEffect(() => {
    if (!dialog()) return

    const handleKeyDown = (event) => {
      if (event.key === "Escape") close(false)
      if (event.key === "Enter") {
        const primary = dialog().actions.find((action) => action.primary)
        if (!actionDisabled(primary)) close(primary?.value ?? true)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    requestAnimationFrame(() => {
      const input = document.querySelector(".confirm-dialog__input")
      const primary = document.querySelector(".confirm-dialog__button--primary")
      ;(input || primary)?.focus()
    })
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown))
  })

  onCleanup(() => resolver?.(false))

  return (
    <ConfirmContext.Provider value={confirm}>
      {props.children}
      <Show when={dialog()}>
        {(active) => (
          <Portal>
            <div class="confirm-dialog">
              <button
                class="confirm-dialog__backdrop"
                type="button"
                aria-label="Cancel confirmation"
                onClick={() => close(false)}
              />
              <section
                class="confirm-dialog__panel"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-message"
              >
                <p id="confirm-dialog-message" class="confirm-dialog__message">
                  {active().message}
                </p>
                <Show when={active().inputMatch}>
                  <label class="confirm-dialog__field">
                    <span class="confirm-dialog__label">
                      {active().inputLabel ||
                        `Type ${active().inputMatch} to confirm.`}
                    </span>
                    <input
                      class="confirm-dialog__input"
                      value={inputValue()}
                      onInput={(event) =>
                        setInputValue(event.currentTarget.value)
                      }
                    />
                  </label>
                </Show>
                <div class="confirm-dialog__actions">
                  <For each={active().actions}>
                    {(action) => (
                      <button
                        class="confirm-dialog__button"
                        classList={{
                          "confirm-dialog__button--primary": action.primary,
                          "confirm-dialog__button--danger": action.danger,
                          "confirm-dialog__button--cancel": action.cancel
                        }}
                        type="button"
                        disabled={actionDisabled(action)}
                        onClick={() => close(action.value)}
                      >
                        {action.label}
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </div>
          </Portal>
        )}
      </Show>
    </ConfirmContext.Provider>
  )
}

export const useConfirm = ConfirmContext.use
