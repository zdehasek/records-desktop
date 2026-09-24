import { useApp } from "../context/AppContext.jsx"
import { For } from "solid-js"

export function BottomNav(props) {
  const { state, setView, goToToday } = useApp()

  const tabs = [
    { id: "timeline", label: "Today" },
    { id: "onThisDay", label: "On This Day" },
    { id: "week", label: "Week" },
    { id: "year", label: "Year" },
    { id: "photos", label: "Records" },
    { id: "map", label: "Map" }
  ]

  const handleClick = (tab) => {
    if (tab.id === "timeline") {
      if (state.view === "timeline") {
        goToToday()
      } else {
        setView("timeline")
      }
    } else {
      setView(tab.id)
    }
  }

  return (
    <nav class="bottom-nav" classList={{ "bottom-nav--hidden": props.hidden }}>
      <For each={tabs}>
        {(tab) => (
          <button
            type="button"
            class="bottom-nav__tab"
            classList={{
              "bottom-nav__tab--active": state.view === tab.id
            }}
            aria-selected={state.view === tab.id}
            data-view={tab.id}
            onClick={() => handleClick(tab)}
          >
            {tab.label}
          </button>
        )}
      </For>
    </nav>
  )
}
