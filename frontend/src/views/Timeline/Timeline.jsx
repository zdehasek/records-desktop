import { useApp } from "../../context/AppContext.jsx"
import { useConfirm } from "../../context/ConfirmContext.jsx"
import { useSelection } from "../../context/SelectionContext.jsx"
import { useContextMenu } from "../../hooks/useContextMenu.js"
import { useFolderPicker } from "../../hooks/useFolderPicker.js"
import { buildVisibilityMenuItems } from "../../lib/visibility-menu.js"
import { FilmStrip } from "./components/FilmStrip.jsx"
import { MemoryCards } from "./components/MemoryCards.jsx"
import { PhotoButton } from "./components/PhotoButton.jsx"
import { TimelineMediaSection } from "./components/TimelineMediaSection.jsx"
import { TimelineOverlays } from "./components/TimelineOverlays.jsx"
import { buildDaySections } from "./day-sections.js"
import { createEffect, createMemo, createSignal, on, onMount } from "solid-js"

export function Timeline() {
  const {
    state,
    currentDay,
    refreshDays,
    refreshMessages,
    deleteMessage,
    getAttachmentUrl,
    getThumbnailUrl,
    setMessageVisibility,
    blurNsfw,
    folders,
    dotFilesVisible,
    loadAllPhotos,
    loadGeoPhotos,
    pendingScrollRestore,
    setPendingScrollRestore,
    initScrollCache,
    scrollToTopTick,
    handleThumbnailError,
    updateMessageNoteColor,
    updateMessageImportant,
    contentRefreshTick
  } = useApp()
  const { selecting, setSelecting, toggle, isSelected } = useSelection()
  const confirmDialog = useConfirm()
  const contextMenu = useContextMenu()
  const folderPicker = useFolderPicker()

  const [revealedId, setRevealedId] = createSignal(null)
  let dayScrollRef
  const daySections = createMemo(() =>
    buildDaySections({
      messages: state.messages,
      attachmentsByMessage: state.attachmentsByMessage
    })
  )

  const totalItems = createMemo(() =>
    daySections().reduce((sum, section) => sum + section.count, 0)
  )
  const hasEntryBody = createMemo(() => totalItems() > 0)

  createEffect(
    on(
      () => state.currentDayId,
      () => {
        setRevealedId(null)
      },
      { defer: true }
    )
  )

  const restoreScroll = () => {
    const scrollTop = pendingScrollRestore()
    if (scrollTop == null) return false

    requestAnimationFrame(() => {
      if (dayScrollRef) dayScrollRef.scrollTop = scrollTop
      setPendingScrollRestore(null)
    })
    return true
  }

  const handleDelete = async (id) => {
    if (await confirmDialog("Move this item to Trash?")) {
      await deleteMessage(id)
    }
  }

  const closeAllMenus = () => {
    contextMenu.close()
    folderPicker.close()
  }

  const handleMessageContextMenu = (e, msg) => {
    e.preventDefault()
    const visibility = msg.visibility || "visible"
    const select = () => {
      setSelecting(true)
      toggle(msg.id)
    }
    contextMenu.open(
      e.clientX,
      e.clientY,
      buildVisibilityMenuItems({
        visibility,
        onVisible: () => setMessageVisibility(msg.id, "visible"),
        onMoveToFolder: () =>
          folderPicker.open(e.clientX, e.clientY, msg.id, visibility),
        middleItems: [],
        onSelect: select,
        onDelete: () => handleDelete(msg.id)
      })
    )
  }

  createEffect(
    on(
      () => totalItems(),
      () => {
        restoreScroll()
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => state.currentDayId,
      () => {
        if (pendingScrollRestore() != null) return
        requestAnimationFrame(() => {
          if (dayScrollRef) dayScrollRef.scrollTop = 0
        })
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => contentRefreshTick(),
      async () => {
        await refreshDays({ preserveSelection: true })
        await refreshMessages()
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      () => scrollToTopTick(),
      () => {
        if (dayScrollRef) dayScrollRef.scrollTop = 0
      },
      { defer: true }
    )
  )

  onMount(() => {
    initScrollCache()
    if (!restoreScroll()) {
      requestAnimationFrame(() => {
        if (dayScrollRef) dayScrollRef.scrollTop = 0
      })
    }
  })

  return (
    <div id="main_content">
      <div
        class="calendar-view day-view"
        data-daylight-target="scrollContainer"
      >
        <FilmStrip />
        <div
          ref={dayScrollRef}
          class="calendar-view__day day-view__day"
          id="calendar-scroll"
          onMouseDown={closeAllMenus}
          tabIndex="0"
        >
          <MemoryCards />

          <div
            class="day-view__content"
            classList={{ "day-view__content--empty": !hasEntryBody() }}
          >
            <div class="day-view__sections">
              <TimelineMediaSection
                section={() =>
                  daySections().find((section) => section.id === "media") || {
                    id: "media",
                    count: 0,
                    items: []
                  }
                }
                messages={() => state.messages}
                attachmentsByMessage={state.attachmentsByMessage}
                currentDayId={() => state.currentDayId}
                currentDay={currentDay}
                selectedDate={() => state.selectedDate}
                selecting={selecting}
                isSelected={isSelected}
                blurNsfw={blurNsfw}
                revealedId={revealedId}
                setRevealedId={setRevealedId}
                getThumbnailUrl={getThumbnailUrl}
                getAttachmentUrl={getAttachmentUrl}
                handleThumbnailError={handleThumbnailError}
                onContextMenu={handleMessageContextMenu}
                toggle={toggle}
                updateMessageImportant={updateMessageImportant}
                updateMessageNoteColor={updateMessageNoteColor}
                setMessageVisibility={setMessageVisibility}
                folders={folders}
                dotFilesVisible={dotFilesVisible}
                onAttachmentUpdated={() => {
                  refreshDays({ preserveSelection: true })
                  refreshMessages()
                  loadAllPhotos()
                  loadGeoPhotos()
                }}
                alwaysShow
                headerActions={<PhotoButton />}
              />
            </div>
          </div>
        </div>
      </div>

      <TimelineOverlays
        folders={folders}
        dotFilesVisible={dotFilesVisible}
        setMessageVisibility={setMessageVisibility}
        contextMenu={contextMenu}
        folderPicker={folderPicker}
      />
    </div>
  )
}
