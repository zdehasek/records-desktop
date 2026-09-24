import { dateToIso } from "../../lib/formatters/date-utils.js"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Portal } from "solid-js/web"

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"]

function parseIsoDate(value) {
  if (!value) return null
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addDays(date, amount) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1)
}

function moveToMonth(date, amount) {
  const targetYear = date.getFullYear()
  const targetMonth = date.getMonth() + amount
  const maxDay = new Date(targetYear, targetMonth + 1, 0).getDate()
  return new Date(targetYear, targetMonth, Math.min(date.getDate(), maxDay))
}

function sameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

function clampPosition(rect) {
  const width = 296
  const height = 356
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

function buildMonthGrid(viewDate) {
  const firstDay = startOfMonth(viewDate)
  const gridStart = addDays(firstDay, -firstDay.getDay())
  const weeks = []

  for (let week = 0; week < 6; week += 1) {
    const row = []
    for (let day = 0; day < 7; day += 1) {
      row.push(addDays(gridStart, week * 7 + day))
    }
    weeks.push(row)
  }

  return weeks
}

function isDisabled(date, minDate, maxDate) {
  const iso = dateToIso(date)
  if (minDate && iso < minDate) return true
  if (maxDate && iso > maxDate) return true
  return false
}

export function CompactDatePicker(props) {
  const todayIso = dateToIso(new Date())
  const selectedDate = createMemo(() => parseIsoDate(props.value))
  const selectedIso = createMemo(() => props.value || "")
  const [isOpen, setIsOpen] = createSignal(false)
  const [viewDate, setViewDate] = createSignal(selectedDate() || new Date())
  const [focusedIso, setFocusedIso] = createSignal(selectedIso() || todayIso)
  const [position, setPosition] = createSignal({ left: "0px", top: "0px" })

  let triggerRef
  let popoverRef

  const monthLabel = createMemo(() => {
    return viewDate().toLocaleDateString("en-US", {
      month: "long",
      year: "numeric"
    })
  })

  const monthGrid = createMemo(() => buildMonthGrid(viewDate()))
  const dayIndicators = (iso) => props.getDayIndicators?.(iso) || []

  const syncPosition = () => {
    if (!triggerRef) return
    setPosition(clampPosition(triggerRef.getBoundingClientRect()))
  }

  const closePicker = () => {
    setIsOpen(false)
    triggerRef?.focus()
    props.onClose?.()
  }

  const focusDate = (iso) => {
    setFocusedIso(iso)
    requestAnimationFrame(() => {
      const target = popoverRef?.querySelector(`[data-date="${iso}"]`)
      target?.focus()
    })
  }

  const openPicker = () => {
    const initialDate = selectedDate() || new Date()
    const initialIso = selectedIso() || dateToIso(initialDate)
    setViewDate(startOfMonth(initialDate))
    setFocusedIso(initialIso)
    setIsOpen(true)
    syncPosition()
    requestAnimationFrame(() => focusDate(initialIso))
    props.onOpen?.()
  }

  const togglePicker = () => {
    if (isOpen()) {
      closePicker()
      return
    }
    openPicker()
  }

  const handleSelect = (iso) => {
    props.onChange?.(iso)
    if (props.closeOnSelect !== false) closePicker()
  }

  const moveFocus = (amount) => {
    const current = parseIsoDate(focusedIso()) || selectedDate() || new Date()
    const next = addDays(current, amount)
    const nextIso = dateToIso(next)
    setViewDate(startOfMonth(next))
    focusDate(nextIso)
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
      disabled: props.disabled
    })

  return (
    <>
      {renderTrigger()}
      <Show when={isOpen()}>
        <Portal>
          <div
            ref={popoverRef}
            class="compact-date-picker"
            role="dialog"
            aria-label={props.ariaLabel || "Choose date"}
            style={position()}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="compact-date-picker__header">
              <button
                class="compact-date-picker__nav-btn"
                onClick={() => setViewDate((current) => addMonths(current, -1))}
                aria-label="Previous month"
                type="button"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>

              <div class="compact-date-picker__month" aria-live="polite">
                {monthLabel()}
              </div>

              <button
                class="compact-date-picker__nav-btn"
                onClick={() => setViewDate((current) => addMonths(current, 1))}
                aria-label="Next month"
                type="button"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
            </div>

            <div class="compact-date-picker__weekdays" aria-hidden="true">
              <For each={WEEKDAY_LABELS}>
                {(label) => (
                  <span class="compact-date-picker__weekday">{label}</span>
                )}
              </For>
            </div>

            <div class="compact-date-picker__grid" role="grid">
              <For each={monthGrid()}>
                {(week) => (
                  <div class="compact-date-picker__week" role="row">
                    <For each={week}>
                      {(date) => {
                        const iso = dateToIso(date)
                        const outside = !sameMonth(date, viewDate())
                        const disabled = isDisabled(
                          date,
                          props.minDate,
                          props.maxDate
                        )
                        return (
                          <button
                            class="compact-date-picker__day"
                            classList={{
                              "compact-date-picker__day--selected":
                                iso === selectedIso(),
                              "compact-date-picker__day--today":
                                iso === todayIso,
                              "compact-date-picker__day--outside": outside,
                              "compact-date-picker__day--focused":
                                iso === focusedIso()
                            }}
                            type="button"
                            role="gridcell"
                            aria-selected={iso === selectedIso()}
                            aria-current={iso === todayIso ? "date" : undefined}
                            data-date={iso}
                            disabled={disabled}
                            tabIndex={iso === focusedIso() ? 0 : -1}
                            onFocus={() => setFocusedIso(iso)}
                            onClick={() => handleSelect(iso)}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowLeft") {
                                event.preventDefault()
                                moveFocus(-1)
                              } else if (event.key === "ArrowRight") {
                                event.preventDefault()
                                moveFocus(1)
                              } else if (event.key === "ArrowUp") {
                                event.preventDefault()
                                moveFocus(-7)
                              } else if (event.key === "ArrowDown") {
                                event.preventDefault()
                                moveFocus(7)
                              } else if (event.key === "PageUp") {
                                event.preventDefault()
                                const next = moveToMonth(date, -1)
                                setViewDate(startOfMonth(next))
                                focusDate(dateToIso(next))
                              } else if (event.key === "PageDown") {
                                event.preventDefault()
                                const next = moveToMonth(date, 1)
                                setViewDate(startOfMonth(next))
                                focusDate(dateToIso(next))
                              } else if (event.key === "Home") {
                                event.preventDefault()
                                moveFocus(-date.getDay())
                              } else if (event.key === "End") {
                                event.preventDefault()
                                moveFocus(6 - date.getDay())
                              } else if (
                                event.key === "Enter" ||
                                event.key === " "
                              ) {
                                event.preventDefault()
                                handleSelect(iso)
                              }
                            }}
                          >
                            <span class="compact-date-picker__day-number">
                              {date.getDate()}
                            </span>
                            <Show when={dayIndicators(iso).length > 0}>
                              <span class="compact-date-picker__day-dots">
                                <For each={dayIndicators(iso).slice(0, 3)}>
                                  {(color) => (
                                    <span
                                      class="compact-date-picker__day-dot"
                                      style={{
                                        "--compact-date-picker-dot": color
                                      }}
                                    />
                                  )}
                                </For>
                              </span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>

            <div class="compact-date-picker__footer">
              <Show when={props.allowClear}>
                <button
                  class="compact-date-picker__action compact-date-picker__action--subtle"
                  type="button"
                  onClick={() => {
                    props.onChange?.("")
                    closePicker()
                  }}
                >
                  Clear
                </button>
              </Show>

              <button
                class="compact-date-picker__action"
                type="button"
                onClick={() => handleSelect(todayIso)}
              >
                Today
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
