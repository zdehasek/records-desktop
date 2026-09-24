import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property string appUrl: ""
  property string activeProfile: ""
  property string activeProfileName: ""
  property string pendingRoute: ""
  property string backendErrorMessage: ""
  property string launcherErrorMessage: ""
  property string launcherStderr: ""
  property string queuedLauncherRoute: ""
  property var memoryPreview: []
  property bool memoryPreviewLoading: false
  property string memoryPreviewError: ""

  function localPath(relativePath) {
    var value = Qt.resolvedUrl(relativePath).toString()
    return decodeURIComponent(value.replace(/^file:\/\//, ""))
  }

  function launch(route) {
    var target = route || "today"
    if (appUrl === "") {
      pendingRoute = target
      return "starting"
    }

    pendingRoute = ""
    launcherErrorMessage = ""
    if (launcher.running) {
      queuedLauncherRoute = target
      return "queued"
    }
    launcher.command = [
      "/usr/bin/node",
      root.localPath("runtime/launch.js"),
      appUrl,
      target,
      activeProfile
    ]
    launcher.running = true
    return "ok"
  }

  function localDate() {
    var now = new Date()
    var month = String(now.getMonth() + 1).padStart(2, "0")
    var day = String(now.getDate()).padStart(2, "0")
    return now.getFullYear() + "-" + month + "-" + day
  }

  function requestMemoryPreview(settings) {
    var request = new XMLHttpRequest()
    request.onreadystatechange = function() {
      if (request.readyState !== XMLHttpRequest.DONE) return
      memoryPreviewLoading = false
      if (request.status < 200 || request.status >= 300) {
        memoryPreviewError = "Could not load memories"
        return
      }
      try {
        var payload = JSON.parse(request.responseText)
        memoryPreview = payload.result || []
      } catch (error) {
        memoryPreviewError = "Could not read memories"
      }
    }
    request.open("POST", appUrl + "rpc")
    request.setRequestHeader("Content-Type", "application/json")
    request.send(JSON.stringify({
      method: "days:memory",
      args: [localDate(), {
        nsfwMode: settings.nsfw_mode || "blurred",
        dotFilesVisible: false,
        autoPhoto: settings.auto_photo_in_week_overview === "true"
      }]
    }))
  }

  function refreshMemoryPreview() {
    if (appUrl === "" || memoryPreviewLoading) return
    memoryPreviewLoading = true
    memoryPreviewError = ""
    var request = new XMLHttpRequest()
    request.onreadystatechange = function() {
      if (request.readyState !== XMLHttpRequest.DONE) return
      if (request.status < 200 || request.status >= 300) {
        memoryPreviewLoading = false
        memoryPreviewError = "Could not load settings"
        return
      }
      try {
        var payload = JSON.parse(request.responseText)
        root.requestMemoryPreview(payload.result || {})
      } catch (error) {
        memoryPreviewLoading = false
        memoryPreviewError = "Could not read settings"
      }
    }
    request.open("POST", appUrl + "rpc")
    request.setRequestHeader("Content-Type", "application/json")
    request.send(JSON.stringify({ method: "settings:all", args: [] }))
  }

  function memoryThumbnailUrl(attachmentId) {
    return attachmentId && appUrl !== ""
      ? appUrl + "media/" + attachmentId + "/micro"
      : ""
  }

  Timer {
    id: backendRestart
    interval: 1000
    repeat: false
    onTriggered: if (!backend.running) backend.running = true
  }

  Process {
    id: launcher
    stderr: SplitParser {
      onRead: function(line) {
        root.launcherStderr = String(line)
        root.launcherErrorMessage = root.launcherStderr
        console.warn("Records launcher:", line)
      }
    }
    onStarted: root.launcherStderr = ""
    onExited: function(exitCode) {
      if (exitCode !== 0 && root.launcherStderr === "")
        root.launcherErrorMessage = "Records launcher exited with code " + exitCode
      if (root.queuedLauncherRoute !== "") {
        var route = root.queuedLauncherRoute
        root.queuedLauncherRoute = ""
        root.launch(route)
      }
    }
  }

  Process {
    id: backend
    command: [
      "/usr/bin/node",
      "--no-warnings",
      root.localPath("runtime/bootstrap.js")
    ]
    running: true
    stdout: SplitParser {
      onRead: function(line) {
        var prefix = "RECORDS_READY "
        var value = String(line)
        if (value.indexOf(prefix) !== 0) return
        try {
          var message = JSON.parse(value.slice(prefix.length))
          if (message.url) {
            root.appUrl = String(message.url)
            root.activeProfile = String(message.profile.id)
            root.activeProfileName = String(message.profile.name)
            root.backendErrorMessage = ""
            root.refreshMemoryPreview()
            if (root.pendingRoute !== "") root.launch(root.pendingRoute)
          }
        } catch (error) {
          root.backendErrorMessage = "Records backend returned invalid startup data"
          console.warn(root.backendErrorMessage)
        }
      }
    }
    stderr: SplitParser {
      onRead: function(line) {
        root.backendErrorMessage = String(line)
        console.warn("Records backend:", line)
      }
    }
    onExited: function(exitCode) {
      root.appUrl = ""
      root.backendErrorMessage = "Records backend exited with code " + exitCode
      console.warn(root.backendErrorMessage)
      backendRestart.restart()
    }
  }

  IpcHandler {
    target: "records"

    function open(route: string): string {
      return root.launch(route || "today")
    }

    function status(): string {
      if (root.launcherErrorMessage !== "") return root.launcherErrorMessage
      if (root.backendErrorMessage !== "") return root.backendErrorMessage
      return root.appUrl !== "" ? "ready" : "starting"
    }

    function ping(): string { return "ok" }
  }
}
