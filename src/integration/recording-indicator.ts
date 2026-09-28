import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui"
import type { KinexRuntime } from "@kinex/core"

function hasChildren(component: Component): component is Component & { children: Component[] } {
  return "children" in component && Array.isArray(component.children)
}

// Pi 0.86 mounts the footer container last in both terminal modes. Capture its
// existing component through the public TUI tree: setFooter's factory otherwise
// exposes only data, not the built-in renderer. Keep that renderer (and its live
// session/settings) rather than duplicating Pi's directory, model or usage logic.
function footerComponent(tui: TUI): Component {
  const container = tui.children.at(-1)
  if (!container || !hasChildren(container) || !container.children[0])
    throw new Error("Pi footer component is unavailable")
  return container.children[0]
}

export function recordingFooter(footer: Component, name: () => string | undefined): Component {
  return {
    invalidate: () => footer.invalidate(),
    render(width) {
      const lines = footer.render(width)
      const recording = name()
      if (!recording || !lines[0] || width < 1) return lines
      // Leave room for the directory on narrow terminals, keeping the REC label.
      const label = truncateToWidth(`rec: ${recording}`, Math.min(width, Math.max(4, Math.floor(width / 2))))
      const directory = truncateToWidth(lines[0], Math.max(0, width - visibleWidth(label) - 2))
      const padding = " ".repeat(Math.max(0, width - visibleWidth(directory) - visibleWidth(label)))
      return [`${directory}${padding}\x1b[31m${label}\x1b[39m`, ...lines.slice(1)]
    },
  }
}

export function recordingIndicator() {
  let generation = 0
  let unsubscribe: (() => void) | undefined
  let context: ExtensionContext | undefined
  let recordingName: string | undefined
  let installed = false
  let redraw: (() => void) | undefined
  const clear = () => {
    generation++
    unsubscribe?.()
    unsubscribe = undefined
    if (installed) context?.ui.setFooter(undefined)
    installed = false
    recordingName = undefined
    redraw = undefined
    context = undefined
  }
  return {
    clear,
    async bind(runtime: KinexRuntime, ctx: ExtensionContext) {
      clear()
      if (!ctx.hasUI) return
      context = ctx
      let footer: Component | undefined
      // This zero-height widget only supplies the TUI handle; remove it before
      // rendering, so the recorder never adds an editor/widget row.
      ctx.ui.setWidget("kinex-recording", tui => {
        footer = footerComponent(tui)
        return { invalidate() {}, render: () => [] }
      }, { placement: "belowEditor" })
      ctx.ui.setWidget("kinex-recording", undefined)
      const refresh = async () => {
        const current = ++generation
        try {
          const recording = await runtime.recording.status()
          if (current !== generation) return
          recordingName = recording && recording.status !== "stopped"
            ? stripTerminalSequences(recording.name).replace(/[\r\n\t]/g, " ") : undefined
          if (!installed && recordingName && footer) {
            const base = footer
            ctx.ui.setFooter(tui => {
              redraw = () => tui.requestRender()
              return recordingFooter(base, () => recordingName)
            })
            installed = true
          }
          redraw?.()
        } catch (error) {
          if (current === generation) ctx.ui.notify(String(error), "error")
        }
      }
      unsubscribe = runtime.subscribe(event => {
        if (event.type === "recording.changed") void refresh()
      })
      await refresh()
    },
  }
}
