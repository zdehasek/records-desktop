export default {
  content: ["frontend/src/**/*.{html,js,jsx}", "tests/**/*.{js,mjs}"],
  css: ["frontend/src/css/**/*.css"],
  safelist: {
    standard: [
      "is-open",
      "is-visible",
      /^cm-/,
      /^maplibregl-/,
      /^hljs-/,
      /--active$/,
      /--disabled$/,
      /--dragging$/,
      /--empty$/,
      /--error$/,
      /--focus$/,
      /--focused$/,
      /--hidden$/,
      /--loading$/,
      /--memory$/,
      /--open$/,
      /--pending$/,
      /--revealed$/,
      /--selected$/
    ],
    deep: [/^cm-/, /^maplibregl-/]
  }
}
