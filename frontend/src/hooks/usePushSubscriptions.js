import { onCleanup, onMount } from "solid-js"

export function usePushSubscriptions(subscriptions) {
  onMount(() => {
    for (const [listener, handler] of subscriptions) {
      if (typeof listener !== "function") continue
      const off = listener(handler)
      if (typeof off === "function") onCleanup(off)
    }
  })
}
