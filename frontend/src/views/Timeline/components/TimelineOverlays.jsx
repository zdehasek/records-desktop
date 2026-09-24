import {
  ContextMenuOverlay,
  FolderPickerOverlay
} from "../../../components/common/OverlayMenus.jsx"

export function TimelineOverlays(props) {
  return (
    <>
      <ContextMenuOverlay state={props.contextMenu} />
      <FolderPickerOverlay
        state={props.folderPicker}
        folders={props.folders()}
        dotFilesVisible={props.dotFilesVisible()}
        onSelect={(folder) =>
          props.setMessageVisibility(props.folderPicker.messageId(), folder)
        }
      />
    </>
  )
}
