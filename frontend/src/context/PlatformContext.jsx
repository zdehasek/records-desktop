import { createSimpleContext } from "../lib/create-context.jsx"

const PlatformCtx = createSimpleContext("Platform")
export const PlatformProvider = PlatformCtx.Provider
export const useApi = PlatformCtx.use
