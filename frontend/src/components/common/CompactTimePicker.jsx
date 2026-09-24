import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Portal } from "solid-js/web"

function pad(value) {
  return String(value).padStart(2, "0")
}

function clampPosition(rect) {
  const width = 264
  const height = 320
  const gap = 10
  const left = Math.min(
    Math.max(gap, rect.left + rect.width / 2 - width / 2),
    Math.max(gap, window.innerWidth - width - gap)
  )
  const belowTop = rect.bottom + gap
  const aboveTop = rect.top - height - gap
  const top =
    belowTop + height <= window.innerHeight - gap || aboveTop < gap
      ? Math.min(belowTop, Math.max(gap, window.innerHeight - height - gap))
      : aboveTop

  return {
    left: `${left}px`,
    top: `${top}px`
  }
}

function parseTime(value) {
  if (!value) return null
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null

  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || "0")
  if (hour > 23 || minute > 59 || second > 59) return null

  return { hour, minute, second }
}

function buildOptions(max, step) {
  const values = []
  for (let value = 0; value <= max; value += step) {
    values.push(pad(value))
  }
  return values
}

function nearestSteppedValue(value, step) {
  if (step <= 1) return value
  return Math.min(59, Math.round(value / step) * step)
}

function nowParts() {
  const now = new Date()
  return {
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds()
  }
}

export function CompactTimePicker(props) {
  const [isOpen, setIsOpen] = createSignal(false)
  const [position, setPosition] = createSignal({ left: "0px", top: "0px" })
  const [focusedOption, setFocusedOption] = createSignal({
    column: "hour",
    value: "00"
  })
  const [draft, setDraft] = createSignal(parseTime(props.value) || nowParts())

  let triggerRef
  let popoverRef

  const secondStep = createMemo(() => Math.max(1, Number(props.step || 60)))
  const minuteStep = createMemo(() =>
    secondStep() >= 60 ? Math.max(1, Math.min(60, secondStep() / 60)) : 1
  )
  const minuteOptions = createMemo(() => buildOptions(59, minuteStep()))
  const secondOptions = createMemo(() =>
    buildOptions(59, Math.max(1, Math.min(60, secondStep())))
  )
  const hourOptions = Array.from({ length: 24 }, (_, index) => pad(index))

  const selected = createMemo(() => parseTime(props.value))

  const formatValue = (parts = draft()) => {
    const hour = pad(parts.hour)
    const minute = pad(nearestSteppedValue(parts.minute, minuteStep()))
    const second = pad(
      nearestSteppedValue(parts.second || 0, Math.min(60, secondStep()))
    )
    return props.includeSeconds
      ? `${hour}:${minute}:${second}`
      : `${hour}:${minute}`
  }

  const displayValue = () => {
    const parts = selected()
    if (!parts) return "--:--"
    return formatValue(parts)
  }

  const syncPosition = () => {
    if (!triggerRef) return
    setPosition(clampPosition(triggerRef.getBoundingClientRect()))
  }

  const closePicker = () => {
    setIsOpen(false)
    triggerRef?.focus()
    props.onClose?.()
  }

  const focusOption = (column, value) => {
    setFocusedOption({ column, value })
    requestAnimationFrame(() => {
      const target = popoverRef?.querySelector(
        `[data-time-column="${column}"][data-time-value="${value}"]`
      )
      target?.focus()
      target?.scrollIntoView({ block: "nearest" })
    })
  }

  const openPicker = () => {
    if (props.disabled) return
    const current = selected() || nowParts()
    const normalized = {
      hour: current.hour,
      minute: nearestSteppedValue(current.minute, minuteStep()),
      second: nearestSteppedValue(
        current.second || 0,
        Math.min(60, secondStep())
      )
    }
    setDraft(normalized)
    setIsOpen(true)
    syncPosition()
    requestAnimationFrame(() => focusOption("hour", pad(normalized.hour)))
    props.onOpen?.()
  }

  const togglePicker = () => {
    if (props.disabled) return
    if (isOpen()) {
      closePicker()
      return
    }
    openPicker()
  }

  const selectPart = (column, value) => {
    const numberValue = Number(value)
    const next = { ...draft(), [column]: numberValue }
    setDraft(next)
    props.onChange?.(formatValue(next))
    focusOption(column, value)
  }

  const selectNow = () => {
    const current = nowParts()
    const normalized = {
      hour: current.hour,
      minute: nearestSteppedValue(current.minute, minuteStep()),
      second: nearestSteppedValue(current.second, Math.min(60, secondStep()))
    }
    setDraft(normalized)
    props.onChange?.(formatValue(normalized))
    closePicker()
  }

  const clearValue = () => {
    props.onChange?.("")
    closePicker()
  }

  const moveFocus = (column, options, amount) => {
    const focused = focusedOption()
    const currentValue =
      focused.column === column
        ? focused.value
        : column === "hour"
          ? pad(draft().hour)
          : column === "minute"
            ? pad(draft().minute)
            : pad(draft().second || 0)
    const index = Math.max(0, options.indexOf(currentValue))
    const nextIndex = (index + amount + options.length) % options.length
    focusOption(column, options[nextIndex])
  }

  const handleOptionKeyDown = (event, column, options, value) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveFocus(column, options, 1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      moveFocus(column, options, -1)
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      selectPart(column, value)
    }
  }

  createEffect(() => {
    if (!isOpen()) return

    const handlePointerDown = (event) => {
      const target = event.target
      if (triggerRef?.contains(target) || popoverRef?.contains(target)) return
      setIsOpen(false)
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") closePicker()
    }

    const handleReposition = () => syncPosition()

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)
    window.addEventListener("resize", handleReposition)
    window.addEventListener("scroll", handleReposition, true)

    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("resize", handleReposition)
      window.removeEventListener("scroll", handleReposition, true)
    }
  })

  const renderTrigger = () =>
    props.renderTrigger?.({
      ref: (el) => {
        triggerRef = el
      },
      onClick: (event) => {
        event.stopPropagation()
        togglePicker()
      },
      ariaExpanded: isOpen(),
      disabled: props.disabled,
      displayValue: displayValue()
    })

  const renderColumn = (column, label, options) => (
    <div class="compact-time-picker__column" role="listbox" aria-label={label}>
      <div class="compact-time-picker__column-label">{label}</div>
      <For each={options}>
        {(option) => (
          <button
            type="button"
            class="compact-time-picker__option"
            classList={{
              "compact-time-picker__option--selected":
                (column === "hour" && option === pad(draft().hour)) ||
                (column === "minute" && option === pad(draft().minute)) ||
                (column === "second" && option === pad(draft().second || 0)),
              "compact-time-picker__option--focused":
                focusedOption().column === column &&
                focusedOption().value === option
            }}
            data-time-column={column}
            data-time-value={option}
            role="option"
            aria-selected={
              (column === "hour" && option === pad(draft().hour)) ||
              (column === "minute" && option === pad(draft().minute)) ||
              (column === "second" && option === pad(draft().second || 0))
            }
            onClick={() => selectPart(column, option)}
            onKeyDown={(event) =>
              handleOptionKeyDown(event, column, options, option)
            }
          >
            {option}
          </button>
        )}
      </For>
    </div>
  )

  return (
    <>
      {renderTrigger()}
      <Show when={isOpen()}>
        <Portal>
          <div
            ref={popoverRef}
            class="compact-time-picker"
            role="dialog"
            aria-label={props.ariaLabel || "Choose time"}
            style={position()}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="compact-time-picker__header" aria-live="polite">
              {displayValue()}
            </div>
            <div class="compact-time-picker__columns">
              {renderColumn("hour", "Hour", hourOptions)}
              {renderColumn("minute", "Minute", minuteOptions())}
              <Show when={props.includeSeconds}>
                {renderColumn("second", "Second", secondOptions())}
              </Show>
            </div>
            <div class="compact-time-picker__footer">
              <button
                type="button"
                class="compact-time-picker__action"
                onClick={selectNow}
              >
                Now
              </button>
              <Show when={props.allowClear}>
                <button
                  type="button"
                  class="compact-time-picker__action compact-time-picker__action--subtle"
                  onClick={clearValue}
                >
                  Clear
                </button>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
