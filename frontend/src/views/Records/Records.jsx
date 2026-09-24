import { Lightbox } from "../../components/common/Lightbox.jsx"
import {
  ContextMenuOverlay,
  FolderPickerOverlay
} from "../../components/common/OverlayMenus.jsx"
import { ResizableSidebarLayout } from "../../components/layout/ResizableSidebarLayout.jsx"
import { useApp } from "../../context/AppContext.jsx"
import { useConfirm } from "../../context/ConfirmContext.jsx"
import { useApi } from "../../context/PlatformContext.jsx"
import { useSelection } from "../../context/SelectionContext.jsx"
import { useContextMenu } from "../../hooks/useContextMenu.js"
import { useFolderPicker } from "../../hooks/useFolderPicker.js"
import { useLightbox } from "../../hooks/useLightbox.js"
import { usePushSubscriptions } from "../../hooks/usePushSubscriptions.js"
import { goToTimeline } from "../../lib/composables/lightbox-helpers.js"
import {
  formatDate,
  formatMonthYear,
  monthKeyFromDate
} from "../../lib/formatters/date-utils.js"
import { buildVisibilityMenuItems } from "../../lib/visibility-menu.js"
import { DuplicateGroupCard } from "./components/DuplicateGroupCard.jsx"
import { MissingDateRecordCard } from "./components/MissingDateRecordCard.jsx"
import { MissingRecordCard } from "./components/MissingRecordCard.jsx"
import { RecordCard } from "./components/RecordCard.jsx"
import { RecordsNamesSidebar } from "./components/RecordsNamesSidebar.jsx"
import { RecordsSidebar } from "./components/RecordsSidebar.jsx"
import {
  buildRows,
  MONTH_HEADER_HEIGHT,
  YEAR_HEADER_HEIGHT
} from "./lib/helpers.js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch
} from "solid-js"

function filteredRecordsItems(filters, sources) {
  if (filters.duplicated) {
    const groups = new Map(
      sources.duplicates.map((group) => [group.checksum, group])
    )
    return [...groups].map(([checksum, group]) => ({
      type: "duplicate-group",
      id: `dup:${checksum}`,
      data: group,
      date: group.members[0]?.dayDate || null,
      created_at: group.members[0]?.createdAt || new Date().toISOString()
    }))
  }
  if (filters.missing) {
    return sources.missing.map((row) => ({
      type: "missing-photo",
      id: `missing:${row.attachmentId}`,
      data: row,
      date: row.dayDate,
      created_at: row.createdAt || new Date().toISOString()
    }))
  }
  if (filters.missingDate) {
    return sources.missingDate.map((row) => ({
      type: "missing-date-photo",
      id: `missing-date:${row.attachmentId}`,
      data: row,
      date: row.dayDate,
      created_at: row.createdAt || new Date().toISOString()
    }))
  }
  return sources.photos.map((photo) => ({
    type: "photo",
    id: `photo:${photo.id}`,
    data: photo,
    date: photo.day_date,
    created_at: photo.created_at
  }))
}

function buildRecordsItems(filters, sources) {
  return filteredRecordsItems(filters, sources).sort((left, right) => {
    if (left.date !== right.date) return left.date > right.date ? -1 : 1
    return new Date(right.created_at) - new Date(left.created_at)
  })
}

function Records() {
  const {
    state,
    allPhotos,
    loadAllPhotos,
    loadGeoPhotos,
    getAttachmentUrl,
    selectDay,
    setView,
    setMessageVisibility,
    deleteMessage,
    nsfwMode,
    blurNsfw,
    folders,
    dotFilesVisible
  } = useApp()

  const { setSelecting, toggle } = useSelection()
  const api = useApi()
  const confirmDialog = useConfirm()

  const contextMenu = useContextMenu()
  const folderPicker = useFolderPicker()
  const [revealedId, setRevealedId] = createSignal(null)

  const [filters, setFilters] = createSignal(
    (() => {
      const saved = localStorage.getItem("records-filters")
      if (saved) {
        try {
          const parsed = JSON.parse(saved)
          return {
            duplicated: parsed.duplicated || false,
            missing: parsed.missing || false,
            missingDate: parsed.missingDate || false
          }
        } catch {
          localStorage.removeItem("records-filters")
        }
      }
      return {
        duplicated: false,
        missing: false,
        missingDate: false
      }
    })()
  )
  const [activeMonth, setActiveMonth] = createSignal(null)
  const [columns, setColumns] = createSignal(4)
  const [loading, setLoading] = createSignal(true)
  const [sidebarMode, setSidebarMode] = createSignal("date")
  const [highlightId, setHighlightId] = createSignal(null)
  const [titleQuery, setTitleQuery] = createSignal("")
  const [duplicates, setDuplicates] = createSignal([])
  const [missingItems, setMissingItems] = createSignal([])
  const [missingDateItems, setMissingDateItems] = createSignal([])
  const [removingMessageIds, setRemovingMessageIds] = createSignal(new Set())
  const [removingAllMissing, setRemovingAllMissing] = createSignal(false)

  let scrollContainerRef

  // Persist filter state
  createEffect(
    on(
      () => filters(),
      (f) => {
        localStorage.setItem("records-filters", JSON.stringify(f))
      },
      { defer: true }
    )
  )

  // Load duplicates from backend
  const loadDuplicates = async () => {
    const groups = await api.attachments.listDuplicateGroups()
    setDuplicates(groups)
  }

  const loadMissing = async () => {
    // Missing imported files should always be visible here so stale rows can
    // be cleaned up even if they live in hidden folders.
    const rows = await api.attachments.listMissingImported()
    setMissingItems(rows)
  }

  const loadMissingDate = async () => {
    const opts = {
      nsfwMode: nsfwMode(),
      dotFilesVisible: dotFilesVisible()
    }
    const rows = await api.attachments.listMissingDateTimeOriginal(opts)
    setMissingDateItems(rows)
  }

  // Load data on mount — fetch photos and duplicates in parallel
  onMount(async () => {
    setLoading(true)
    await Promise.all([loadAllPhotos(), loadDuplicates()])
    setLoading(false)
    updateColumns()
  })

  // Reload duplicates when filter is toggled on
  createEffect(
    on(
      () => filters().duplicated,
      async (isDuplicated) => {
        if (isDuplicated) {
          await loadDuplicates()
        }
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => filters().missing,
      async (isMissing) => {
        if (isMissing) {
          await loadMissing()
        }
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => filters().missingDate,
      async (isMissingDate) => {
        if (isMissingDate) {
          await loadMissingDate()
        }
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => [nsfwMode(), dotFilesVisible()],
      () => {
        setRevealedId(null)
        if (filters().missing) {
          loadMissing()
        }
        if (filters().missingDate) {
          loadMissingDate()
        }
      },
      { defer: true }
    )
  )

  // Items memo — mixed records feed
  const allItems = createMemo(() =>
    buildRecordsItems(filters(), {
      duplicates: duplicates(),
      missing: missingItems(),
      missingDate: missingDateItems(),
      photos: allPhotos()
    })
  )

  createEffect(
    on(
      () => [
        filters(),
        sidebarMode(),
        titleQuery(),
        allItems()
          .map((item) => `${item.type}:${item.id}`)
          .join("|")
      ],
      () => setRevealedId(null),
      { defer: true }
    )
  )

  // Count unique duplicate checksums for the "Duplicated" pill badge
  const duplicateCount = createMemo(() => {
    return duplicates().length
  })

  const missingCount = createMemo(() => missingItems().length)
  const missingDateCount = createMemo(() => missingDateItems().length)

  usePushSubscriptions([[api.on.photosImported, loadDuplicates]])

  // Derive month keys for sidebar from current records set
  const allMonthKeys = createMemo(() => {
    const seen = new Map()
    for (const item of allItems()) {
      const key = monthKeyFromDate(item.date)
      if (key && !seen.has(key)) {
        seen.set(key, {
          key,
          label: formatMonthYear(key),
          year: key.slice(0, 4)
        })
      }
    }
    return [...seen.values()]
  })

  // Build row model
  const rowModel = createMemo(() => buildRows(allItems(), columns()))
  const rows = () => rowModel().rows
  const monthToRow = () => rowModel().monthToRow

  // Column count from container width
  const updateColumns = () => {
    if (!scrollContainerRef) return
    setColumns(scrollContainerRef.clientWidth >= 1024 ? 4 : 3)
  }

  // Item row height from container width
  const itemRowHeight = () => {
    if (!scrollContainerRef) return 220
    const containerWidth = scrollContainerRef.clientWidth
    const gridMaxWidth = 900
    const padding = containerWidth >= 640 ? 32 : 16
    const availableWidth = Math.min(containerWidth, gridMaxWidth) - padding * 2
    const cols = columns()
    const gap = containerWidth >= 640 ? 4 : 2
    const itemSize = (availableWidth - gap * (cols - 1)) / cols
    return Math.round(itemSize) + gap
  }

  const estimateSize = (index) => {
    const row = rows()[index]
    if (!row) return 220
    if (row.type === "year-header") return YEAR_HEADER_HEIGHT
    if (row.type === "month-header") return MONTH_HEADER_HEIGHT
    // Special full-width rows are taller than the grid cards
    if (
      row.type === "item-row" &&
      row.items.length > 0 &&
      (row.items[0].type === "duplicate-group" ||
        row.items[0].type === "missing-photo" ||
        row.items[0].type === "missing-date-photo")
    )
      return 340
    return itemRowHeight()
  }

  const virtualizer = createVirtualizer({
    get count() {
      return rows().length
    },
    getScrollElement: () => scrollContainerRef ?? null,
    estimateSize,
    overscan: 8
  })

  // Observe container resize for column count
  onMount(() => {
    if (!scrollContainerRef) return
    const ro = new ResizeObserver(() => updateColumns())
    ro.observe(scrollContainerRef)
    onCleanup(() => ro.disconnect())
  })

  // Derive active month from visible virtual rows
  createEffect(() => {
    const items = virtualizer.getVirtualItems()
    if (!items.length) return
    const allRows = rows()
    for (const item of items) {
      const row = allRows[item.index]
      if (row && row.type === "month-header") {
        setActiveMonth(row.key)
        return
      }
    }
    for (const item of items) {
      const row = allRows[item.index]
      if (row && row.type === "item-row" && row.items.length > 0) {
        const key = monthKeyFromDate(row.items[0].date)
        if (key) {
          setActiveMonth(key)
          return
        }
      }
    }
  })

  const scrollToMonth = (monthKey) => {
    const rowIndex = monthToRow().get(monthKey)
    if (rowIndex != null) {
      virtualizer.scrollToIndex(rowIndex, {
        align: "start",
        behavior: "smooth"
      })
    }
  }

  const scrollToItem = (targetItem) => {
    const allRows = rows()
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i]
      if (row.type !== "item-row") continue
      if (row.items.some((it) => it.id === targetItem.id)) {
        virtualizer.scrollToIndex(i, {
          align: "center",
          behavior: "smooth"
        })
        setHighlightId(targetItem.id)
        setTimeout(() => setHighlightId(null), 1500)
        return
      }
    }
  }

  // Photo/video items only for Lightbox navigation.
  const mediaItems = createMemo(() => {
    const items = allItems()
    const result = []
    for (const item of items) {
      if (item.type === "photo") {
        result.push(item)
      } else if (item.type === "missing-date-photo") {
        result.push({
          type: "photo",
          id: `photo:${item.data.attachmentId}`,
          data: {
            id: item.data.attachmentId,
            file_name: item.data.fileName,
            mime_type: item.data.mimeType,
            message_id: item.data.messageId,
            visibility: item.data.visibility
          },
          date: item.data.dayDate,
          created_at: item.data.createdAt
        })
      }
    }
    return result
  })

  const lightbox = useLightbox(mediaItems, { getId: (item) => item.data.id })

  const handleGoToDay = async (item) => {
    await goToTimeline({
      dayDate: item.date,
      dayId: item.data.day_id || undefined,
      state,
      api,
      selectDay,
      setView
    })
  }

  const handleRecordContextMenu = (e, item) => {
    e.preventDefault()
    const msgId = item.data.message_id
    if (msgId == null) return
    const vis = item.data.visibility || "visible"
    const select = () => {
      setSelecting(true)
      toggle(msgId)
    }
    contextMenu.open(
      e.clientX,
      e.clientY,
      buildVisibilityMenuItems({
        visibility: vis,
        onVisible: () => setMessageVisibility(msgId, "visible"),
        onMoveToFolder: () =>
          folderPicker.open(e.clientX, e.clientY, msgId, vis),
        onSelect: select,
        onDelete: () => moveToTrash(msgId, "this item")
      })
    )
  }

  async function moveToTrash(msgId, label) {
    if (!(await confirmDialog(`Move ${label} to Trash?`))) return false
    await deleteMessage(msgId)
    return true
  }

  const handleDuplicateDeleteImported = async (msgId) => {
    if (await moveToTrash(msgId, "this duplicate")) await loadDuplicates()
  }

  const handleDuplicateSetDefault = (checksum, attachmentId) => {
    api.attachments
      .setDuplicateCanonical(checksum, attachmentId)
      .then(() => loadDuplicates())
  }

  const isMessageRemoving = (msgId) => removingMessageIds().has(msgId)

  const handleMissingRemove = async (msgId) => {
    if (!msgId || isMessageRemoving(msgId) || removingAllMissing()) return

    setRemovingMessageIds((prev) => {
      const next = new Set(prev)
      next.add(msgId)
      return next
    })

    try {
      await deleteMessage(msgId)
      await loadMissing()
    } finally {
      setRemovingMessageIds((prev) => {
        const next = new Set(prev)
        next.delete(msgId)
        return next
      })
    }
  }

  const handleMissingRemoveAll = async () => {
    if (removingAllMissing()) return

    const attachmentCount = missingItems().length
    if (!attachmentCount) return

    if (
      !(await confirmDialog(
        `Purge ${attachmentCount} stale missing attachment(s)?`
      ))
    ) {
      return
    }

    setRemovingAllMissing(true)
    try {
      await api.attachments.purgeMissingImported()
      await Promise.all([loadAllPhotos(), loadGeoPhotos()])
      await loadMissing()
    } finally {
      setRemovingAllMissing(false)
      setRemovingMessageIds(new Set())
    }
  }

  const RecordsOverlays = () => (
    <>
      <Show when={lightbox.isOpen() && lightbox.currentItem()}>
        <Lightbox
          photoId={lightbox.currentItem().data.id}
          url={getAttachmentUrl(lightbox.currentItem().data.id)}
          alt={lightbox.currentItem().data.file_name || "Photo"}
          mimeType={lightbox.currentItem().data.mime_type}
          date={formatDate(lightbox.currentItem().date)}
          counter={lightbox.counterText()}
          hasPrev={lightbox.hasPrev()}
          hasNext={lightbox.hasNext()}
          onClose={lightbox.close}
          onPrev={lightbox.prev}
          onNext={lightbox.next}
          visibility={lightbox.currentItem().data.visibility}
          blurNsfw={blurNsfw()}
          folders={folders()}
          dotFilesVisible={dotFilesVisible()}
          onVisibilityChange={(vis) =>
            setMessageVisibility(lightbox.currentItem().data.message_id, vis)
          }
          onAttachmentUpdated={() => {
            loadAllPhotos()
            loadGeoPhotos()
          }}
          onDelete={async () => {
            const item = lightbox.currentItem()
            if (!item) return
            if (!(await moveToTrash(item.data.message_id, "this photo"))) return
            lightbox.close()
          }}
          onGoToTimeline={() => {
            const item = lightbox.currentItem()
            if (item) {
              lightbox.close()
              handleGoToDay(item)
            }
          }}
        />
      </Show>
      <ContextMenuOverlay state={contextMenu} />
      <FolderPickerOverlay
        state={folderPicker}
        folders={folders()}
        dotFilesVisible={dotFilesVisible()}
        onSelect={(folder) =>
          setMessageVisibility(folderPicker.messageId(), folder)
        }
      />
    </>
  )

  return (
    <ResizableSidebarLayout
      class="records-layout"
      contentClass="records"
      contentRef={(el) => {
        scrollContainerRef = el
      }}
      storageKey="records-sidebar-width"
      defaultWidth={180}
      minWidth={140}
      maxWidth={420}
      sidebar={
        <div class="records-sidebar-container">
          <div class="records-sidebar__tabs">
            <button
              class="records-sidebar__tab"
              classList={{
                "records-sidebar__tab--active": sidebarMode() === "date"
              }}
              onClick={() => setSidebarMode("date")}
              title="Browse by month"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </button>
            <button
              class="records-sidebar__tab"
              classList={{
                "records-sidebar__tab--active": sidebarMode() === "title"
              }}
              onClick={() => setSidebarMode("title")}
              title="Browse by title"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
                />
              </svg>
            </button>
          </div>
          <Show when={sidebarMode() === "date"}>
            <RecordsSidebar
              months={allMonthKeys()}
              activeMonth={activeMonth()}
              onMonthClick={scrollToMonth}
            />
          </Show>
          <Show when={sidebarMode() === "title"}>
            <RecordsNamesSidebar
              items={allItems()}
              onNameClick={scrollToItem}
              searchQuery={titleQuery()}
              onSearchChange={setTitleQuery}
              searchPlaceholder="Search title"
              emptyText="No matching titles"
            />
          </Show>
        </div>
      }
    >
      <div class="records-content">
        <div class="records-filters">
          <button
            class="records-filters__pill"
            classList={{
              "records-filters__pill--active": filters().duplicated
            }}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                duplicated: !f.duplicated,
                missing: false,
                missingDate: false
              }))
            }
          >
            Duplicated ({duplicateCount()})
          </button>
          <button
            class="records-filters__pill"
            classList={{
              "records-filters__pill--active": filters().missing
            }}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                missing: !f.missing,
                duplicated: false,
                missingDate: false
              }))
            }
          >
            Not found pictures ({missingCount()})
          </button>
          <Show when={filters().missing && missingCount() > 0}>
            <button
              class="records-filters__pill records-filters__pill--danger"
              disabled={removingAllMissing()}
              onClick={handleMissingRemoveAll}
            >
              {removingAllMissing() ? "Purging..." : "Purge stale"}
            </button>
          </Show>
          <button
            class="records-filters__pill"
            classList={{
              "records-filters__pill--active": filters().missingDate
            }}
            onClick={() =>
              setFilters((f) => ({
                ...f,
                missingDate: !f.missingDate,
                duplicated: false,
                missing: false
              }))
            }
          >
            No EXIF date ({missingDateCount()})
          </button>
        </div>
        <Show when={loading()}>
          <div class="records__loading">
            <div class="records__loading-grid">
              <For each={Array(columns() * 3)}>
                {() => <div class="records__loading-card" />}
              </For>
            </div>
          </div>
        </Show>
        <Show
          when={!loading() && allItems().length > 0}
          fallback={
            <Show when={!loading()}>
              <div class="records__empty">
                <p class="records__empty-text">
                  {filters().missing
                    ? "No missing pictures found"
                    : filters().missingDate
                      ? "No photos with missing EXIF date found"
                      : "No photos or videos yet"}
                </p>
              </div>
            </Show>
          }
        >
          <div
            class="records__virtual-container"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative"
            }}
          >
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const row = () => rows()[virtualRow.index]
                return (
                  <div
                    class="records__virtual-row"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                  >
                    <Show when={row()}>
                      {(r) => (
                        <Switch>
                          <Match when={r().type === "year-header"}>
                            <div class="records__year-header">
                              <span class="records__year-label">
                                {r().year}
                              </span>
                            </div>
                          </Match>
                          <Match when={r().type === "month-header"}>
                            <div
                              class="records__section-header"
                              data-month-key={r().key}
                            >
                              {r().label}
                            </div>
                          </Match>
                          <Match when={r().type === "item-row"}>
                            <div class="records__item-row">
                              <For each={r().items}>
                                {(item) => {
                                  if (item.type === "duplicate-group") {
                                    return (
                                      <DuplicateGroupCard
                                        item={item}
                                        onDeleteImported={
                                          handleDuplicateDeleteImported
                                        }
                                        onSetDefault={handleDuplicateSetDefault}
                                      />
                                    )
                                  }
                                  if (item.type === "missing-photo") {
                                    return (
                                      <MissingRecordCard
                                        item={item}
                                        removing={
                                          isMessageRemoving(
                                            item.data.messageId
                                          ) || removingAllMissing()
                                        }
                                        onRemove={handleMissingRemove}
                                      />
                                    )
                                  }
                                  if (item.type === "missing-date-photo") {
                                    return (
                                      <MissingDateRecordCard
                                        item={item}
                                        onOpen={(attachmentId) => {
                                          if (attachmentId != null) {
                                            lightbox.open(attachmentId)
                                          }
                                        }}
                                      />
                                    )
                                  }
                                  const handleCardClick = () => {
                                    if (
                                      item.type === "photo" ||
                                      item.type === "missing-date-photo"
                                    ) {
                                      lightbox.open(item.data.id)
                                      return
                                    }
                                    handleGoToDay(item)
                                  }
                                  return (
                                    <RecordCard
                                      item={item}
                                      onClick={handleCardClick}
                                      highlightId={highlightId()}
                                      onContextMenu={handleRecordContextMenu}
                                      revealedId={revealedId()}
                                      onReveal={setRevealedId}
                                    />
                                  )
                                }}
                              </For>
                              <For
                                each={Array.from({
                                  length: Math.max(
                                    columns() - r().items.length,
                                    0
                                  )
                                })}
                              >
                                {() => (
                                  <div class="records__item records__item--spacer" />
                                )}
                              </For>
                            </div>
                          </Match>
                        </Switch>
                      )}
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
      <RecordsOverlays />
    </ResizableSidebarLayout>
  )
}

export default Records
