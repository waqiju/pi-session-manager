/** Optional personal shortcut; not auto-loaded by the garden package. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+g", {
    description: "Open /garden",
    handler: () => {
      // Never send /garden to the model if the garden extension is disabled.
      if (!pi.getCommands().some((command) => command.name === "garden")) return;
      // Explicit command dispatch is required: the default sends literal text.
      // Do not setEditorText()/submit(), which would overwrite the user's draft.
      pi.sendUserMessage("/garden", { expandPromptTemplates: true });
    },
  });
}
