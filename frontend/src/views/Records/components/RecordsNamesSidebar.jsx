import { createMemo, createSignal, For, onMount, Show } from "solid-js"

const PhotoIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
    />
  </svg>
)

function stripHtmlTags(html) {
  if (!html) return ""
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function getItemName(item) {
  if (item.type === "photo") {
    const caption = stripHtmlTags(item.data.message_content)
    return caption || null
  }
  return null
}

function TypeIcon(props) {
  return (
    <span class="records-sidebar__name-icon">
      <Show when={props.type === "photo"}>
        <PhotoIcon />
      </Show>
    </span>
  )
}

export function RecordsNamesSidebar(props) {
  const [expandedYears, setExpandedYears] = createSignal(new Set())

  const resolveName = (item) => {
    if (props.getItemName) return props.getItemName(item)
    return getItemName(item)
  }

  const resolveType = (item) => {
    if (props.getItemType) return props.getItemType(item)
    return item.type
  }

  const resolveDate = (item) => {
    if (props.getItemDate) return props.getItemDate(item)
    if (item.date) return item.date
    return item.data?.day_date || null
  }

  const normalizedQuery = createMemo(() =>
    (props.searchQuery || "").trim().toLowerCase()
  )

  const namedItems = createMemo(() => {
    return props.items.filter((item) => {
      const name = resolveName(item)
      return name && name.trim().length > 0
    })
  })

  const filteredItems = createMemo(() => {
    const query = normalizedQuery()
    if (!query) return namedItems()
    return namedItems().filter((item) =>
      resolveName(item).toLowerCase().includes(query)
    )
  })

  const yearGroups = createMemo(() => {
    const groups = new Map()
    for (const item of filteredItems()) {
      const date = resolveDate(item)
      const year = date?.slice(0, 4)
      if (!year) continue
      if (!groups.has(year)) groups.set(year, [])
      groups.get(year).push(item)
    }
    return [...groups.entries()]
  })

  // Expand all years on mount
  onMount(() => {
    const years = new Set()
    for (const [year] of yearGroups()) {
      years.add(year)
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
    <nav class="records-sidebar records-sidebar--names">
      <Show when={props.onSearchChange}>
        <div class="records-sidebar__search-wrap">
          <input
            type="search"
            class="records-sidebar__search"
            placeholder={props.searchPlaceholder || "Search titles"}
            value={props.searchQuery || ""}
            onInput={(e) => props.onSearchChange(e.currentTarget.value)}
          />
        </div>
      </Show>
      <Show
        when={yearGroups().length > 0}
        fallback={
          <div class="records-sidebar__empty">
            {props.emptyText || "No named entries yet"}
          </div>
        }
      >
        <For each={yearGroups()}>
          {([year, items]) => (
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
                <div class="records-sidebar__names">
                  <For each={items}>
                    {(item) => (
                      <button
                        class="records-sidebar__name-item"
                        title={resolveName(item)}
                        onClick={() => props.onNameClick(item)}
                      >
                        <TypeIcon type={resolveType(item)} />
                        <span class="records-sidebar__name-text">
                          {resolveName(item)}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </nav>
  )
}
