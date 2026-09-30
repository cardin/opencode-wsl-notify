#!/usr/bin/env node
import assert from "node:assert/strict"
import plugin from "../dist/tui.js"

const state = { shown: false }
const toasts = []
const context = {
  storage: {
    store(key, options) {
      assert.equal(key, "deprecation-notice-v1")
      assert.deepEqual(options.initial, { shown: false })
      return [state, async (mutate) => mutate(state)]
    },
  },
  ui: { toast: { show: (toast) => toasts.push(toast) } },
}

await plugin.setup(context)
assert.equal(toasts.length, 1)
assert.match(toasts[0].message, /@mohak34\/opencode-notifier/)
assert.equal(toasts[0].variant, "warning")
assert.equal(state.shown, true)

await plugin.setup(context)
assert.equal(toasts.length, 1, "notice is shown once across TUI restarts")

console.log("TUI deprecation notice checks passed.")
