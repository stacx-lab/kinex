import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui"
import type { KinexRuntime } from "@kinex/core"

function hasChildren(component: Component): component is Component & { children: Component[] } {
  return "children" in component && Array.isArray(component.children)
}

// Pi 0.87 mounts the footer container last in both terminal modes. Capture its
// existing component through the public TUI tree: setFooter's factory otherwise
// exposes only data, not the built-in renderer. Keep that renderer (and its live
// session/settings) rather than duplicating Pi's directory, model or usage logic.
function footerComponent(tui: TUI): Component {
  const container = tui.children.at(-1)
  if (!container || !hasChildren(container) || !container.children[0])
    throw new Error("Pi footer component is unavailable")
  return container.children[0]
}

export function kinexFooter(footer: Component, state: () => { recording?: string; time?: string }): Component {
  return {
    invalidate: () => footer.invalidate(),
    render(width) {
      const lines = [...footer.render(width)]
      if (width < 1) return lines
      const { recording, time } = state()
      if (time && lines[1] !== undefined) {
        const available = width - visibleWidth(time) - 1
        // Let Pi lay out tokens, cost, context and model in the remaining space.
        lines[1] = available > 0 ? `${time} ${footer.render(available)[1] ?? ""}` : truncateToWidth(time, width)
      }
      if (recording && lines[0]) {
        const label = truncateToWidth(`rec: ${recording}`, Math.min(width, Math.max(4, Math.floor(width / 2))))
        const directory = truncateToWidth(lines[0], Math.max(0, width - visibleWidth(label) - 2))
        const padding = " ".repeat(Math.max(0, width - visibleWidth(directory) - visibleWidth(label)))
        lines[0] = `${directory}${padding}\x1b[31m${label}\x1b[39m`
      }
      return lines
    },
  }
}

export function footerIndicator(time: () => string) {
  let generation = 0
  let unsubscribe: (() => void) | undefined
  let context: ExtensionContext | undefined
  let recordingName: string | undefined
  let installed = false
  let redraw: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const clear = () => {
    generation++
    clearInterval(timer)
    timer = undefined
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
    refresh(active: boolean) {
      if (!active) { clearInterval(timer); timer = undefined }
      else if (!timer && redraw) { timer = setInterval(redraw, 1000); timer.unref() }
      redraw?.()
    },
    async bind(runtime: KinexRuntime, ctx: ExtensionContext) {
      clear()
      if (!ctx.hasUI) return
      context = ctx
      let footer: Component | undefined
      // This zero-height widget only supplies the TUI handle; remove it before
      // rendering, so the footer never adds an editor/widget row.
      ctx.ui.setWidget("kinex-footer", tui => {
        footer = footerComponent(tui)
        return { invalidate() {}, render: () => [] }
      }, { placement: "belowEditor" })
      ctx.ui.setWidget("kinex-footer", undefined)
      if (footer) {
        const base = footer
        ctx.ui.setFooter((tui, theme) => {
          redraw = () => tui.requestRender()
          return kinexFooter(base, () => ({ recording: recordingName, time: theme.fg("dim", `time ${time()}`) }))
        })
        installed = true
      }
      const refresh = async () => {
        const current = ++generation
        try {
          const recording = await runtime.recording.status()
          if (current !== generation) return
          recordingName = recording && recording.status !== "stopped"
            ? stripTerminalSequences(recording.name).replace(/[\r\n\t]/g, " ") : undefined
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
