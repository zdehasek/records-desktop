import { createContext, useContext } from "solid-js"

export function createSimpleContext(name) {
  const ctx = createContext()
  return {
    Provider: (props) => (
      <ctx.Provider value={props.value}>{props.children}</ctx.Provider>
    ),
    use: () => {
      const value = useContext(ctx)
      if (value === undefined) throw new Error(`${name} context not found`)
      return value
    }
  }
}
