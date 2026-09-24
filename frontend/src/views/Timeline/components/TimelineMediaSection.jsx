import { Lightbox } from "../../../components/common/Lightbox.jsx"
import { useLightbox } from "../../../hooks/useLightbox.js"
import { formatDate } from "../../../lib/formatters/date-utils.js"
import {
  findMessageByAttachmentId,
  getTimelineItemKey
} from "../lib/helpers.js"
import { sortAttachmentsOldestFirst } from "../lib/media-sort.js"
import { TimelineMessageCard } from "./TimelineMessageCard.jsx"
import { TimelineSectionShell } from "./TimelineSectionShell.jsx"
import { createEffect, createMemo, For, on, Show } from "solid-js"

function buildDayAttachments(messages, attachmentsByMessage) {
  const allAtts = []
  for (const msg of messages) {
    const atts = sortAttachmentsOldestFirst(attachmentsByMessage[msg.id])
    if (!atts) continue
    for (const att of atts) {
      if (
        att.mime_type?.startsWith("image/") ||
        att.mime_type?.startsWith("video/")
      ) {
        allAtts.push(att)
      }
    }
  }
  return allAtts
}

export function TimelineMediaSection(props) {
  const section = () => props.section?.() || { items: [] }
  const hasItems = () => section().items.length > 0
  const displayItems = createMemo(() => section().items)
  const dayAttachments = createMemo(() =>
    buildDayAttachments(props.messages(), props.attachmentsByMessage)
  )

  const lightbox = useLightbox(() => dayAttachments())

  const activeLightboxList = dayAttachments

  const currentLightboxMessage = createMemo(() => {
    const att = lightbox.currentItem()
    if (!att) return null
    return findMessageByAttachmentId(
      att.id,
      props.messages(),
      props.attachmentsByMessage
    )
  })

  createEffect(
    on(
      () => props.currentDayId(),
      () => {
        lightbox.close()
      },
      { defer: true }
    )
  )

  const closeLightbox = () => {
    lightbox.close()
  }

  const navigateLightbox = (direction) => {
    const items = activeLightboxList()
    const idx = items.findIndex((att) => att.id === lightbox.currentId())
    const nextItem = items[idx + direction]
    if (nextItem) lightbox.open(nextItem.id)
  }

  const lightboxCounter = () => {
    const items = activeLightboxList()
    const currentId = lightbox.currentId()
    const idx = items.findIndex((att) => att.id === currentId)
    if (idx < 0) return ""
    return `${idx + 1} / ${items.length}`
  }

  const renderItem = (item) => {
    const itemKey = getTimelineItemKey(item)

    return (
      <TimelineMessageCard
        msg={item}
        itemKey={itemKey}
        attachments={props.attachmentsByMessage[item.id] || []}
        currentDay={props.currentDay}
        selecting={props.selecting()}
        isSelected={props.isSelected(item.id)}
        blurNsfw={props.blurNsfw()}
        revealedId={props.revealedId()}
        getThumbnailUrl={props.getThumbnailUrl}
        getAttachmentUrl={props.getAttachmentUrl}
        onThumbnailError={props.handleThumbnailError}
        onContextMenu={(e) => props.onContextMenu(e, item)}
        onToggleSelect={() => props.toggle(item.id)}
        onOpenLightbox={lightbox.open}
        onToggleImportant={() =>
          props.updateMessageImportant(item, !item.metadata?.important)
        }
        onUpdateNoteColor={(color) => props.updateMessageNoteColor(item, color)}
        onReveal={() => props.setRevealedId(item.id)}
        onHideReveal={() => props.setRevealedId(null)}
      />
    )
  }

  return (
    <>
      <TimelineSectionShell
        section={section}
        alwaysShow={props.alwaysShow}
        headerActions={props.headerActions}
        itemsClass="day-view__section-items"
        itemsClassList={{ "day-view__section-items--cards": true }}
      >
        <For each={displayItems()}>{renderItem}</For>

        <Show when={!hasItems()}>
          <div class="day-view__empty-state">
            <div class="day-view__empty-orbit" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p class="day-view__empty-kicker">No media</p>
            <h2>No photos or videos yet.</h2>
            <p>Add a photo or video from the control above.</p>
          </div>
        </Show>
      </TimelineSectionShell>

      <Show when={lightbox.isOpen() && lightbox.currentItem()}>
        <Lightbox
          photoId={lightbox.currentItem().id}
          url={props.getAttachmentUrl(lightbox.currentItem().id)}
          alt={lightbox.currentItem().file_name || "Photo"}
          mimeType={lightbox.currentItem().mime_type}
          message={currentLightboxMessage()}
          date={props.selectedDate() ? formatDate(props.selectedDate()) : ""}
          counter={lightboxCounter()}
          hasPrev={lightbox.hasPrev()}
          hasNext={lightbox.hasNext()}
          onClose={closeLightbox}
          onPrev={() => navigateLightbox(-1)}
          onNext={() => navigateLightbox(1)}
          visibility={currentLightboxMessage()?.visibility}
          blurNsfw={props.blurNsfw()}
          folders={props.folders()}
          dotFilesVisible={props.dotFilesVisible()}
          onVisibilityChange={(visibility) => {
            const msg = currentLightboxMessage()
            if (msg) props.setMessageVisibility(msg.id, visibility)
          }}
          onAttachmentUpdated={props.onAttachmentUpdated}
        />
      </Show>
    </>
  )
}
