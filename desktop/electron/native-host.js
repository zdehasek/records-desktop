import { validateHostRequest } from "./protocol.js"

const mediaFilters = [
  {
    name: "Photos and videos",
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "heic",
      "heif",
      "tif",
      "tiff",
      "webp",
      "avif",
      "gif",
      "mov",
      "mp4",
      "avi",
      "mkv",
      "webm",
      "m4v"
    ]
  }
]

export function createNativeHost({ dialog, shell, Notification, focusRoute }) {
  return async (value) => {
    const request = validateHostRequest(value)
    if (request.method === "chooseFile") {
      const result = await dialog.showOpenDialog({
        title: "Add photo or video",
        properties: ["openFile"],
        filters: mediaFilters
      })
      return result.canceled ? null : result.filePaths[0] || null
    }
    if (request.method === "chooseFolder") {
      const result = await dialog.showOpenDialog({
        title: "Add media folder",
        properties: ["openDirectory", "createDirectory"]
      })
      return result.canceled ? null : result.filePaths[0] || null
    }

    const [argument] = request.args
    if (request.method === "moveToTrash") {
      await shell.trashItem(argument)
      return true
    }
    if (request.method === "openFile") {
      const error = await shell.openPath(argument)
      if (error) throw new Error(error)
      return true
    }
    if (request.method === "revealFile") {
      shell.showItemInFolder(argument)
      return true
    }

    const notification = new Notification({
      title: argument.title,
      body: argument.body
    })
    notification.on("click", () => focusRoute(argument.route))
    notification.show()
    return true
  }
}
