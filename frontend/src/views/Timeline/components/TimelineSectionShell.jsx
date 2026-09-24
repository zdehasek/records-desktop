import { Show } from "solid-js"

export function TimelineSectionShell(props) {
  const section = () => props.section?.() || { id: "", count: 0, items: [] }
  const hasItems = () => section().items.length > 0
  const shouldShow = () => props.alwaysShow || hasItems()

  return (
    <Show when={shouldShow()}>
      <section
        class="day-section"
        data-section={section().id}
        data-count={section().count}
      >
        <div class="day-section__header">
          {props.headerActions}
          <div class="day-section__divider" aria-hidden="true" />
        </div>

        <div class={props.itemsClass} classList={props.itemsClassList}>
          {props.children}
        </div>
      </section>
    </Show>
  )
}
