/** A one-time migration notice in the OpenCode V2 terminal client. */
import type { Plugin } from "@opencode/plugin/tui"

export default {
  id: "opencode-wsl-notify.deprecation",

  async setup(context) {
    const [notice, updateNotice] = context.storage.store("deprecation-notice-v1", {
      initial: { shown: false },
    })
    if (notice.shown) return

    await updateNotice((draft) => {
      draft.shown = true
    })
    context.ui.toast.show({
      title: "opencode-wsl-notify is deprecated",
      message: "Switch to @mohak34/opencode-notifier (OpenCode V2, multi-platform).",
      variant: "warning",
      duration: 10000,
    })
  },
} satisfies Plugin.Definition
