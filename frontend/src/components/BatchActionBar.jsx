import { useApp } from "../context/AppContext.jsx"
import { useConfirm } from "../context/ConfirmContext.jsx"
import { useSelection } from "../context/SelectionContext.jsx"
import { useFolderPicker } from "../hooks/useFolderPicker.js"
import { FolderPickerOverlay } from "./common/OverlayMenus.jsx"
import { Show } from "solid-js"

export function BatchActionBar() {
  const { selecting, selectedIds, count, clear, selectMany } = useSelection()
  const {
    state,
    batchSetMessageVisibility,
    batchDeleteMessages,
    createPhotoGif,
    photoGifAvailable,
    folders,
    dotFilesVisible
  } = useApp()
  const confirmDialog = useConfirm()
  const folderPicker = useFolderPicker()

  const currentDayMessageIds = () => state.messages.map((msg) => msg.id)

  const canCreateGif = () => {
    if (!photoGifAvailable()) return false
    const ids = [...selectedIds()]
    if (ids.length < 2) return false
    return ids.every((id) => {
      const msg = state.messages.find((m) => m.id === id)
      const attachments = state.attachmentsByMessage[id] || []
      return (
        msg?.message_type === "photo" &&
        attachments.some((attachment) =>
          attachment.mime_type?.startsWith("image/")
        )
      )
    })
  }

  const handleCreateGif = async () => {
    const ids = [...selectedIds()]
    try {
      await createPhotoGif(ids)
      clear()
    } catch (error) {
      window.alert(`GIF creation failed: ${error.message || error}`)
    }
  }

  const handleMakeVisible = async () => {
    const ids = [...selectedIds()]
    await batchSetMessageVisibility(ids, "visible")
    clear()
  }

  const handleBatchDelete = async () => {
    const ids = [...selectedIds()]
    if (!(await confirmDialog(`Move ${ids.length} item(s) to Trash?`))) return
    await batchDeleteMessages(ids)
    clear()
  }

  const handleMoveToFolder = (e) => {
    folderPicker.open(e.clientX, e.clientY, null, null)
  }

  const handleSelectAll = () => {
    selectMany(currentDayMessageIds())
  }

  const handleFolderSelect = async (folder) => {
    const ids = [...selectedIds()]
    await batchSetMessageVisibility(ids, folder)
    clear()
  }

  return (
    <Show when={selecting() && count() > 0}>
      <div class="batch-bar">
        <span class="batch-bar__count">{count()} selected</span>
        <div class="batch-bar__actions">
          <button class="batch-bar__btn" onClick={handleSelectAll}>
            Select all
          </button>
          <button class="batch-bar__btn" onClick={handleMakeVisible}>
            Make visible
          </button>
          <button
            class="batch-bar__btn batch-bar__btn--primary"
            onClick={handleMoveToFolder}
          >
            Move to NSFW...
          </button>
          <Show when={canCreateGif()}>
            <button
              class="batch-bar__btn batch-bar__btn--primary"
              onClick={handleCreateGif}
            >
              Create GIF
            </button>
          </Show>
          <button
            class="batch-bar__btn batch-bar__btn--danger"
            onClick={handleBatchDelete}
          >
            Move to Trash
          </button>
          <button class="batch-bar__btn batch-bar__btn--ghost" onClick={clear}>
            Cancel
          </button>
        </div>
      </div>
      <FolderPickerOverlay
        state={{
          ...folderPicker,
          position: () => {
            const position = folderPicker.position()
            return { x: position.x, y: position.y - 200 }
          }
        }}
        folders={folders()}
        dotFilesVisible={dotFilesVisible()}
        onSelect={handleFolderSelect}
      />
    </Show>
  )
}
