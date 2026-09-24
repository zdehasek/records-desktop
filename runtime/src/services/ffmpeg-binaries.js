import { requireMediaTool, toolCommand } from "../../media-tools.js"

export function ffmpegPath() {
  return toolCommand(requireMediaTool("ffmpeg"))
}

export function ffprobePath() {
  return toolCommand(requireMediaTool("ffprobe"))
}
