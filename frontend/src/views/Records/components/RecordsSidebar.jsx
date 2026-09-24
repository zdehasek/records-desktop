import { createEffect, createSignal, For, on, onMount, Show } from "solid-js"

const SHORT_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
]

export function RecordsSidebar(props) {
  const yearGroups = () => {
    const groups = new Map()
    for (const m of props.months) {
      if (!groups.has(m.year)) groups.set(m.year, [])
      groups.get(m.year).push(m)
    }
    return [...groups.entries()]
  }

  const [expandedYears, setExpandedYears] = createSignal(new Set())

  // Auto-expand the year of the active month
  createEffect(
    on(
      () => props.activeMonth,
      (active) => {
        if (active) {
          const year = active.slice(0, 4)
          setExpandedYears((prev) => {
            if (prev.has(year)) return prev
            const next = new Set(prev)
            next.add(year)
            return next
          })
        }
      },
      { defer: true }
    )
  )

  // Expand all years on initial load
  onMount(() => {
    const years = new Set()
    for (const m of props.months) {
      years.add(m.year)
    }
    setExpandedYears(years)
  })

  const toggleYear = (year) => {
    setExpandedYears((prev) => {
      const next = new Set(prev)
      if (next.has(year)) next.delete(year)
      else next.add(year)
      return next
    })
  }

  return (
    <nav class="records-sidebar">
      <For each={yearGroups()}>
        {([year, months]) => (
          <div class="records-sidebar__year-group">
            <button
              class="records-sidebar__year"
              classList={{
                "records-sidebar__year--expanded": expandedYears().has(year)
              }}
              onClick={() => toggleYear(year)}
            >
              <svg
                class="records-sidebar__chevron"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 2l4 4-4 4"
                />
              </svg>
              {year}
            </button>
            <Show when={expandedYears().has(year)}>
              <div class="records-sidebar__months">
                <For each={months}>
                  {(m) => (
                    <button
                      class="records-sidebar__month"
                      classList={{
                        "records-sidebar__month--active":
                          props.activeMonth === m.key
                      }}
                      onClick={() => props.onMonthClick(m.key)}
                    >
                      <span class="records-sidebar__month-label">
                        {SHORT_MONTH_NAMES[parseInt(m.key.slice(5, 7), 10) - 1]}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </nav>
  )
}
