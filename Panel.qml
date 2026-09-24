import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "io.github.zdehasek.records"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property var recordsService: root.bar?.shell?.serviceFor(root.moduleName)

  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { if (root.opened) close(); else open() }

  onOpenedChanged: if (root.opened && root.recordsService)
    root.recordsService.refreshMemoryPreview()

  function closeForPopoutSwitch() {
    root.popoutSwitchClosing = true
    close()
    Qt.callLater(function() { root.popoutSwitchClosing = false })
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function launch(route) {
    Quickshell.execDetached(["omarchy-shell", "records", "open", route])
    close()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        Text {
          text: "On This Day"
          color: root.barForeground
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.heading
          font.bold: true
        }

        Text {
          width: parent.width
          text: "See what happened around this day in the past."
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          visible: !root.recordsService || root.recordsService.appUrl === "" || (root.recordsService.memoryPreviewLoading && root.recordsService.memoryPreview.length === 0)
          width: parent.width
          text: root.recordsService && root.recordsService.appUrl !== "" ? "Looking through your memories..." : "Records is starting..."
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.recordsService && root.recordsService.appUrl !== "" && !root.recordsService.memoryPreviewLoading && root.recordsService.memoryPreview.length === 0
          width: parent.width
          text: root.recordsService && root.recordsService.memoryPreviewError !== ""
            ? root.recordsService.memoryPreviewError
            : "No memories for today yet."
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Row {
          visible: root.recordsService && root.recordsService.memoryPreview.length > 0
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: root.recordsService ? root.recordsService.memoryPreview.slice(0, 3) : []

            Rectangle {
              required property var modelData
              width: (content.width - Style.space(12)) / 3
              height: width
              radius: Style.cornerRadius
              color: Qt.darker(root.barBackground, 1.08)
              border.width: 1
              border.color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.2)
              clip: true

              Image {
                anchors.fill: parent
                visible: Boolean(modelData.photo_attachment_id)
                source: root.recordsService && modelData.photo_attachment_id
                  ? root.recordsService.memoryThumbnailUrl(modelData.photo_attachment_id)
                  : ""
                asynchronous: true
                cache: false
                fillMode: Image.PreserveAspectCrop
                sourceSize.width: width
                sourceSize.height: height
                opacity: 0.72
              }

              Text {
                anchors.centerIn: parent
                text: modelData.label
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
                style: Text.Outline
                styleColor: Qt.rgba(0, 0, 0, 0.65)
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.launch("on-this-day")
              }
            }
          }
        }

        Button {
          width: content.width
          text: "Open Records"
          bordered: true
          onClicked: root.launch("today")
        }

        Button {
          visible: root.recordsService && root.recordsService.memoryPreview.length > 0
          width: content.width
          text: "Play memories"
          bordered: true
          onClicked: root.launch("on-this-day-story")
        }
      }
    }
  }
}
