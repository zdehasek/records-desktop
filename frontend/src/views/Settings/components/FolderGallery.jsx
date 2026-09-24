import { Lightbox } from "../../../components/common/Lightbox.jsx"
import { FolderPickerOverlay } from "../../../components/common/OverlayMenus.jsx"
import { useApp } from "../../../context/AppContext.jsx"
import { useConfirm } from "../../../context/ConfirmContext.jsx"
import { useApi } from "../../../context/PlatformContext.jsx"
import { useSelection } from "../../../context/SelectionContext.jsx"
import { useFolderPicker } from "../../../hooks/useFolderPicker.js"
import {
  createLightboxNav,
  goToTimeline
} from "../../../lib/composables/lightbox-helpers.js"
import { formatDate } from "../../../lib/formatters/date-utils.js"
import {
  isDotFolder,
  isUserFolder
} from "../../../lib/formatters/visibility-utils.js"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"

export function FolderGallery(props) {
  const {
    state,
    folders,
    loadFolders,
    folderPhotos,
    loadFolderPhotos,
    dotFilesVisible,
    setMessageVisibility,
    deleteMessage,
    renameFolder,
    getAttachmentUrl,
    getThumbnailUrl,
    loadAllPhotos,
    loadGeoPhotos,
    selectDay,
    setView,
    handleThumbnailError
  } = useApp()
  const api = useApi()
  const confirmDialog = useConfirm()
  const { selecting, setSelecting, toggle, isSelected } = useSelection()

  const [selectedFolder, setSelectedFolder] = createSignal(null)
  const folderPicker = useFolderPicker()
  const [editing, setEditing] = createSignal(false)
  const [editValue, setEditValue] = createSignal("")

  const visibleFolders = () => {
    if (dotFilesVisible()) return folders().filter(isUserFolder)
    return folders().filter((f) => isUserFolder(f) && !isDotFolder(f))
  }

  const photoCounts = createMemo(() => {
    const counts = {}
    for (const p of folderPhotos()) {
      const f = p.folder || "?"
      counts[f] = (counts[f] || 0) + 1
    }
    return counts
  })

  const filteredPhotos = () => {
    const sel = selectedFolder()
    if (!sel) return []
    return folderPhotos().filter((p) => p.folder === sel)
  }

  const mediaItems = createMemo(() =>
    filteredPhotos().filter(
      (p) =>
        p.mime_type?.startsWith("image/") || p.mime_type?.startsWith("video/")
    )
  )

  const lightbox = createLightboxNav(mediaItems)

  onMount(async () => {
    await loadFolders()
    await loadFolderPhotos()
  })

  const handleMakeVisible = async (e, photo) => {
    e.stopPropagation()
    const idx = lightbox.index()
    await setMessageVisibility(photo.message_id, "visible")
    await loadFolderPhotos()
    await loadFolders()
    if (idx >= 0 && idx >= mediaItems().length) {
      lightbox.close()
    }
  }

  const handleMoveToFolder = (e, photo) => {
    e.stopPropagation()
    folderPicker.open(e.clientX, e.clientY, photo.message_id, photo.folder)
  }

  const handleBack = () => {
    setSelectedFolder(null)
    lightbox.close()
    setEditing(false)
  }

  const startRename = () => {
    setEditValue(selectedFolder())
    setEditing(true)
  }

  const commitRename = async () => {
    const newName = editValue().trim()
    const oldName = selectedFolder()
    setEditing(false)
    if (!newName || newName === oldName) return
    await renameFolder(oldName, newName)
    setSelectedFolder(newName)
  }

  const cancelRename = () => {
    setEditing(false)
  }

  return (
    <div class="nsfw-gallery">
      <div class="nsfw-gallery__header">
        <Show when={selectedFolder()}>
          <button
            class="nsfw-gallery__back"
            onClick={handleBack}
            aria-label={`Back to ${props.title || "Folders"}`}
          >
            <svg
              width="20"
              height="20"
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
        </Show>
        <Show
          when={editing()}
          fallback={
            <h3
              class="nsfw-gallery__title"
              onDblClick={() => selectedFolder() && startRename()}
            >
              {selectedFolder() || props.title || "Folders"}
            </h3>
          }
        >
          <input
            class="nsfw-gallery__title-input"
            value={editValue()}
            onInput={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename()
              if (e.key === "Escape") cancelRename()
            }}
            onBlur={commitRename}
            ref={(el) => setTimeout(() => el.select(), 0)}
          />
        </Show>
        <Show when={selectedFolder() && !editing()}>
          <button
            class="nsfw-gallery__rename"
            onClick={startRename}
            aria-label="Rename folder"
            title="Rename folder"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
              />
            </svg>
          </button>
        </Show>
        <button
          class="nsfw-gallery__close"
          onClick={props.onClose}
          aria-label="Close gallery"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <Show
        when={selectedFolder()}
        fallback={
          <Show
            when={visibleFolders().length > 0}
            fallback={
              <div class="nsfw-gallery__empty">
                <p>{props.emptyTitle || "No folders yet."}</p>
                <p>
                  {props.emptyHint ||
                    'Right-click any message and use "Move to NSFW" to create one.'}
                </p>
              </div>
            }
          >
            <div class="nsfw-gallery__folder-list">
              <div class="tile-grid tile-grid--auto">
                <For each={visibleFolders()}>
                  {(folder) => (
                    <button
                      class="tile-grid__item"
                      classList={{
                        "nsfw-gallery__folder-item--dot": isDotFolder(folder)
                      }}
                      onClick={() => setSelectedFolder(folder)}
                    >
                      <Show when={photoCounts()[folder]}>
                        <span class="tile-grid__badge">
                          {photoCounts()[folder]}
                        </span>
                      </Show>
                      <span class="tile-grid__icon">
                        <svg
                          width="28"
                          height="28"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
                        </svg>
                      </span>
                      <span class="tile-grid__label">{folder}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        }
      >
        <Show
          when={filteredPhotos().length > 0}
          fallback={
            <div class="nsfw-gallery__empty">
              <p>No items in this folder.</p>
              <p>
                {props.emptyHint ||
                  'Right-click any message and use "Move to NSFW" to add items here.'}
              </p>
            </div>
          }
        >
          <div class="nsfw-gallery__grid">
            <For each={filteredPhotos()}>
              {(photo) => {
                const isImage = () => photo.mime_type?.startsWith("image/")
                const isVideo = () => photo.mime_type?.startsWith("video/")
                const isMediaItem = () => isImage() || isVideo()

                return (
                  <div
                    class="nsfw-gallery__item"
                    classList={{
                      "nsfw-gallery__item--selecting": selecting()
                    }}
                    onClick={() => {
                      if (selecting()) {
                        toggle(photo.message_id || photo.id)
                        return
                      }
                      if (isMediaItem()) {
                        const mediaIdx = mediaItems().findIndex(
                          (m) => m.attachment_id === photo.attachment_id
                        )
                        if (mediaIdx >= 0) lightbox.open(mediaIdx)
                      }
                    }}
                  >
                    <Show when={isMediaItem() && photo.attachment_id}>
                      <img
                        class="nsfw-gallery__thumb"
                        src={getThumbnailUrl(photo.attachment_id)}
                        alt={photo.file_name || "Photo"}
                        loading="lazy"
                        onError={(e) =>
                          handleThumbnailError(
                            photo.attachment_id,
                            e.currentTarget
                          )
                        }
                      />
                    </Show>
                    <Show when={selecting()}>
                      <div
                        class="select-check"
                        classList={{
                          "select-check--active": isSelected(
                            photo.message_id || photo.id
                          )
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </div>
                    </Show>
                    <Show when={isVideo()}>
                      <div class="nsfw-gallery__play-icon">
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="white"
                          opacity="0.9"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </Show>
                    <div class="nsfw-gallery__date">
                      {photo.day_date ? formatDate(photo.day_date) : ""}
                    </div>
                    <div class="nsfw-gallery__actions">
                      <button
                        class="nsfw-gallery__action-btn"
                        title="Make Visible"
                        onClick={(e) => handleMakeVisible(e, photo)}
                      >
                        Visible
                      </button>
                      <button
                        class="nsfw-gallery__action-btn nsfw-gallery__action-btn--move"
                        title="Move to another folder"
                        onClick={(e) => handleMoveToFolder(e, photo)}
                      >
                        Move
                      </button>
                      <button
                        class="nsfw-gallery__action-btn"
                        title="Select"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelecting(true)
                          toggle(photo.message_id || photo.id)
                        }}
                      >
                        Select
                      </button>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={lightbox.index() >= 0 && lightbox.current()}>
        <Lightbox
          photoId={lightbox.current().attachment_id}
          url={getAttachmentUrl(lightbox.current().attachment_id)}
          alt={lightbox.current().file_name || "Photo"}
          mimeType={lightbox.current().mime_type}
          date={
            lightbox.current().day_date
              ? formatDate(lightbox.current().day_date)
              : ""
          }
          counter={`${lightbox.index() + 1} / ${mediaItems().length}`}
          hasPrev={lightbox.index() > 0}
          hasNext={lightbox.index() < mediaItems().length - 1}
          onClose={lightbox.close}
          onPrev={lightbox.prev}
          onNext={lightbox.next}
          visibility={lightbox.current().folder}
          blurNsfw={false}
          folders={folders()}
          dotFilesVisible={dotFilesVisible()}
          onVisibilityChange={async (vis) => {
            await setMessageVisibility(lightbox.current().message_id, vis)
            await loadFolderPhotos()
            await loadFolders()
          }}
          onAttachmentUpdated={async () => {
            await loadFolderPhotos()
            await loadFolders()
          }}
          onDelete={async () => {
            const photo = lightbox.current()
            if (!photo) return
            if (!(await confirmDialog("Move this photo to Trash?"))) return
            deleteMessage(photo.message_id)
            lightbox.close()
            loadFolderPhotos()
            loadFolders()
            loadAllPhotos()
            loadGeoPhotos()
          }}
          onGoToTimeline={() => {
            const photo = lightbox.current()
            if (!photo) return
            lightbox.close()
            goToTimeline({
              dayDate: photo.day_date,
              state,
              api,
              selectDay,
              setView
            })
          }}
        />
      </Show>

      <FolderPickerOverlay
        state={folderPicker}
        folders={folders()}
        dotFilesVisible={dotFilesVisible()}
        onSelect={async (folder) => {
          await setMessageVisibility(folderPicker.messageId(), folder)
          await loadFolderPhotos()
          await loadFolders()
        }}
      />
    </div>
  )
}
