import { ContextMenu } from "./ContextMenu.jsx"
import { FolderPicker } from "./FolderPicker.jsx"
import { Show } from "solid-js"

export function ContextMenuOverlay(props) {
  return (
    <Show when={props.state.isOpen()}>
      <ContextMenu
        x={props.state.position().x}
        y={props.state.position().y}
        items={props.state.items()}
        onClose={props.state.close}
      />
    </Show>
  )
}

export function FolderPickerOverlay(props) {
  return (
    <Show when={props.state.isOpen()}>
      <FolderPicker
        x={props.state.position().x}
        y={props.state.position().y}
        currentVisibility={props.state.currentVisibility()}
        folders={props.folders}
        dotFilesVisible={props.dotFilesVisible}
        onSelect={props.onSelect}
        onClose={props.state.close}
      />
    </Show>
  )
}
