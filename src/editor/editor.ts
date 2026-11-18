import type { EdgeSpec, JunctionControl, LaneGraphSpec, NodeSpec } from '../world/laneGraph'
import { DEFAULT_SPEED_LIMITS, LaneGraph } from '../world/laneGraph'
import { GraphDoc, type Selection } from './graphDoc'
import { fromJson, toJson, toTypeScript } from './serialise'
import { PlanView, type CarPose } from './view'

const STORAGE_KEY = 'ids.roadLayout'
/** Where a layout left over from an older built-in town is parked. */
const SUPERSEDED_KEY = 'ids.roadLayout.superseded'

/**
 * Cheap content hash of the built-in town, stored with a saved layout.
 *
 * Without it, anyone who had once opened the editor was pinned forever to the
 * town as it stood that day: the saved copy silently replaced the built-in one
 * at boot, so later additions to Ballyroad never appeared and the simulator
 * looked like it had simply ignored them. Nothing warned about it.
 */
function fingerprint(spec: LaneGraphSpec): string {
  const text = JSON.stringify(spec)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const CATEGORIES: Array<[string, string]> = [
  ['urbanCore', 'Urban core (30)'],
  ['urban', 'Urban (50)'],
  ['ruralLocal', 'Rural local (60)'],
  ['regional', 'Regional (80)'],
  ['nationalSecondary', 'National secondary (80)'],
  ['nationalPrimary', 'National primary (100)'],
  ['motorway', 'Motorway (120)'],
]

const CENTRE_LINES: Array<[string, string]> = [
  ['broken', 'Broken — may cross'],
  ['continuous', 'Continuous — must not cross'],
  ['doubleContinuous', 'Double continuous'],
  ['none', 'None'],
]

export interface EditorHooks {
  /** Push a valid layout into the running simulation. */
  apply(spec: LaneGraphSpec): void
  /** Where the car is, for the plan view. */
  carPose(): CarPose | null
}

/**
 * In-browser road editor.
 *
 * Authoring a town by hand in TypeScript works for a dozen roads and not for a
 * hundred, and a test route needs a lot more than a dozen. The editor exports
 * TypeScript in the same shape as the hand-written town, so a layout stays a
 * reviewable source file rather than becoming opaque saved state.
 */
export class RoadEditor {
  readonly doc: GraphDoc
  private readonly view: PlanView
  private selection: Selection = { kind: 'none' }
  private open = false
  private dragging: 'node' | 'via' | 'pan' | null = null
  private pointer = { x: 0, y: 0 }
  private linkFrom: string | null = null
  private applyQueued = false
  private frameHandle = 0
  /** Fingerprint of the built-in town this editor was opened against. */
  private readonly base: string

  constructor(
    private readonly root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly panel: HTMLElement,
    initial: LaneGraphSpec,
    private readonly hooks: EditorHooks,
  ) {
    this.base = fingerprint(initial)
    this.doc = new GraphDoc(RoadEditor.restore(this.base) ?? initial)
    this.view = new PlanView(canvas)

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('dblclick', this.onDoubleClick)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onResize)
  }

  get isOpen(): boolean {
    return this.open
  }

  /**
   * Push the current layout into the simulation. Called once at boot, because
   * a layout restored from a previous session must replace the built-in town
   * before the first frame rather than only after the next edit.
   */
  syncToSimulation(): void {
    this.afterChange()
  }

  /**
   * A saved layout is only restored when it was built on the town as it stands
   * now. One built on an older town is set aside rather than thrown away, and
   * can still be pasted back in through the editor's JSON box.
   */
  private static restore(base: string): LaneGraphSpec | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return null
      const saved = JSON.parse(raw) as { base?: string; spec?: unknown }
      if (saved.base === base && saved.spec) return fromJson(JSON.stringify(saved.spec))

      localStorage.setItem(SUPERSEDED_KEY, raw)
      localStorage.removeItem(STORAGE_KEY)
      console.info(
        'Road editor: your saved layout was built on an earlier version of the ' +
          'built-in town, so the current town is being used instead. The old ' +
          `layout is kept under localStorage["${SUPERSEDED_KEY}"].`,
      )
      return null
    } catch {
      return null
    }
  }

  private save(): void {
    try {
      const payload = { base: this.base, spec: JSON.parse(toJson(this.doc.toSpec())) }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      /* a blocked or full store must not stop editing */
    }
  }

  toggle(): boolean {
    this.open = !this.open
    this.root.hidden = !this.open
    if (this.open) {
      this.view.resize()
      if (this.view.zoom === 0.55) this.view.frameAll(this.doc)
      this.render()
    } else {
      cancelAnimationFrame(this.frameHandle)
    }
    return this.open
  }

  private onResize = (): void => {
    if (!this.open) return
    this.view.resize()
  }

  // --- Pointer ----------------------------------------------------------

  private localPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private onPointerDown = (e: PointerEvent): void => {
    const p = this.localPoint(e)
    this.pointer = p
    const hit = this.view.hitTest(this.doc, p.x, p.y, this.selection)

    // Shift-click joins the selected node to another one.
    if (e.shiftKey && hit.kind === 'node' && this.selection.kind === 'node') {
      const created = this.doc.addEdge(this.selection.id, hit.id)
      if (created) {
        this.selection = { kind: 'edge', id: created }
        this.afterChange()
      }
      return
    }

    if (hit.kind === 'node' || hit.kind === 'via') {
      this.selection = hit
      this.dragging = hit.kind
      this.doc.beginChange()
      this.canvas.setPointerCapture(e.pointerId)
    } else if (hit.kind === 'edge') {
      this.selection = hit
      this.dragging = 'pan'
    } else {
      this.selection = { kind: 'none' }
      this.dragging = 'pan'
    }
    this.linkFrom = this.selection.kind === 'node' ? this.selection.id : null
    this.renderPanel()
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.open || !this.dragging) return
    const p = this.localPoint(e)
    const dx = p.x - this.pointer.x
    const dy = p.y - this.pointer.y
    this.pointer = p

    if (this.dragging === 'pan') {
      this.view.x -= dx / this.view.zoom
      this.view.y += dy / this.view.zoom
      return
    }

    const world = this.view.toWorld(p.x, p.y)
    if (this.dragging === 'node' && this.selection.kind === 'node') {
      this.doc.moveNode(this.selection.id, world.x, world.y)
    } else if (this.dragging === 'via' && this.selection.kind === 'via') {
      this.doc.moveVia(this.selection.id, this.selection.index, world)
    }
  }

  private onPointerUp = (): void => {
    if (!this.dragging) return
    const wasEditing = this.dragging !== 'pan'
    this.dragging = null
    if (wasEditing) {
      this.doc.commit()
      this.afterChange()
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const p = this.localPoint(e)
    this.view.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  }

  private onDoubleClick = (e: MouseEvent): void => {
    const p = this.localPoint(e)
    const world = this.view.toWorld(p.x, p.y)
    const hit = this.view.hitTest(this.doc, p.x, p.y, this.selection)

    if (hit.kind === 'edge') {
      const index = this.view.insertionIndex(this.doc, hit.id, world)
      this.doc.addVia(hit.id, index, world)
      this.selection = { kind: 'via', id: hit.id, index }
    } else if (hit.kind === 'none') {
      const id = this.doc.addNode(world.x, world.y)
      this.selection = { kind: 'node', id }
    }
    this.afterChange()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.open) return
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    if (typing && e.key !== 'Escape') return

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.doc.redo()
      else this.doc.undo()
      this.selection = { kind: 'none' }
      this.afterChange()
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      this.deleteSelection()
    } else if (e.key.toLowerCase() === 'f') {
      this.view.frameAll(this.doc)
    } else if (e.key === 'Escape') {
      this.selection = { kind: 'none' }
      this.renderPanel()
    }
  }

  private deleteSelection(): void {
    const s = this.selection
    if (s.kind === 'node') this.doc.deleteNode(s.id)
    else if (s.kind === 'edge') this.doc.deleteEdge(s.id)
    else if (s.kind === 'via') this.doc.deleteVia(s.id, s.index)
    else return
    this.selection = { kind: 'none' }
    this.afterChange()
  }

  // --- Applying ---------------------------------------------------------

  private afterChange(): void {
    this.save()
    this.renderPanel()
    if (this.applyQueued) return
    this.applyQueued = true
    queueMicrotask(() => {
      this.applyQueued = false
      // Only push a layout the simulation can actually load.
      if (this.doc.problems().length > 0) return
      try {
        const spec = this.doc.toSpec()
        new LaneGraph(spec)
        this.hooks.apply(spec)
      } catch {
        /* an invalid intermediate state simply is not applied */
      }
    })
  }

  /** Draw loop, running only while the editor is open. */
  render = (): void => {
    if (!this.open) return
    this.view.draw(this.doc, this.selection, this.hooks.carPose(), this.linkFrom)
    this.frameHandle = requestAnimationFrame(this.render)
  }

  // --- Panel ------------------------------------------------------------

  renderPanel(): void {
    const problems = this.doc.problems()
    const sections: string[] = []

    sections.push(`
      <header>
        <strong>Road editor</strong>
        <span class="ed-hint">E to drive</span>
      </header>
      <div class="ed-counts">
        ${this.doc.nodes.length} junctions · ${this.doc.edges.length} roads
      </div>
    `)

    if (this.selection.kind === 'node') {
      sections.push(this.nodeSection(this.doc.node(this.selection.id)))
    } else if (this.selection.kind === 'edge' || this.selection.kind === 'via') {
      sections.push(this.edgeSection(this.doc.edge(this.selection.id)))
    } else {
      sections.push(`<p class="ed-empty">Click a road or junction to edit it.</p>`)
    }

    sections.push(`
      <section class="ed-section">
        <h4>Layout</h4>
        <div class="ed-buttons">
          <button data-act="frame">Fit view</button>
          <button data-act="undo" ${this.doc.canUndo ? '' : 'disabled'}>Undo</button>
          <button data-act="redo" ${this.doc.canRedo ? '' : 'disabled'}>Redo</button>
        </div>
        <div class="ed-buttons">
          <button data-act="copy-ts">Copy TypeScript</button>
          <button data-act="copy-json">Copy JSON</button>
        </div>
        <div class="ed-buttons">
          <button data-act="import">Paste JSON…</button>
          <button data-act="revert">Revert</button>
        </div>
      </section>
    `)

    if (problems.length) {
      sections.push(`
        <section class="ed-section ed-problems">
          <h4>${problems.length} problem${problems.length > 1 ? 's' : ''}</h4>
          <ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>
          <p>The drive keeps the last valid layout until these are fixed.</p>
        </section>
      `)
    }

    sections.push(`
      <section class="ed-section ed-keys">
        <h4>Controls</h4>
        <dl>
          <dt>Drag</dt><dd>Pan, or move the selected point</dd>
          <dt>Wheel</dt><dd>Zoom</dd>
          <dt>Double-click</dt><dd>New junction, or a bend on a road</dd>
          <dt>Shift-click</dt><dd>Join to the selected junction</dd>
          <dt>Delete</dt><dd>Remove the selection</dd>
          <dt>Ctrl+Z</dt><dd>Undo</dd>
          <dt>F</dt><dd>Fit view</dd>
        </dl>
      </section>
    `)

    this.panel.innerHTML = sections.join('')
    this.wirePanel()
  }

  private nodeSection(node: NodeSpec | undefined): string {
    if (!node) return ''
    const control = node.junction?.control
    const kind = node.junction ? control?.kind ?? 'uncontrolled' : 'none'
    const attached = this.doc.edgesAt(node.id)

    let controlRows = ''
    if (kind === 'yield' || kind === 'stop') {
      const named =
        control?.kind === 'yield'
          ? control.yieldEdges
          : control?.kind === 'stop'
            ? control.stopEdges
            : []
      controlRows = `
        <div class="ed-field"><span>${kind === 'stop' ? 'Must stop' : 'Must yield'}</span></div>
        ${attached
          .map(
            (e) => `<label class="ed-check">
              <input type="checkbox" data-control-edge="${e.id}" ${named.includes(e.id) ? 'checked' : ''} />
              <span>${e.id}</span>
            </label>`,
          )
          .join('')}
      `
    } else if (kind === 'signals' && control?.kind === 'signals') {
      controlRows = `
        <div class="ed-field"><span>Phase group</span></div>
        ${attached
          .map((e) => {
            const group = control.groups.findIndex((g) => g.includes(e.id))
            return `<label class="ed-field"><span>${e.id}</span>
              <select data-signal-edge="${e.id}">
                <option value="-1" ${group < 0 ? 'selected' : ''}>—</option>
                <option value="0" ${group === 0 ? 'selected' : ''}>Group 1</option>
                <option value="1" ${group === 1 ? 'selected' : ''}>Group 2</option>
              </select></label>`
          })
          .join('')}
        <label class="ed-field"><span>Green</span>
          <input type="number" data-signal="greenSeconds" value="${control.greenSeconds}" min="4" max="60" step="1" /></label>
        <label class="ed-field"><span>Amber</span>
          <input type="number" data-signal="amberSeconds" value="${control.amberSeconds}" min="1" max="6" step="0.5" /></label>
      `
    }

    return `
      <section class="ed-section">
        <h4>Junction <code>${node.id}</code></h4>
        <label class="ed-field"><span>East</span>
          <input type="number" data-node="x" value="${node.x}" step="1" /></label>
        <label class="ed-field"><span>North</span>
          <input type="number" data-node="y" value="${node.y}" step="1" /></label>
        <label class="ed-field"><span>Control</span>
          <select data-junction-kind>
            <option value="none" ${kind === 'none' ? 'selected' : ''}>Not a junction</option>
            <option value="uncontrolled" ${kind === 'uncontrolled' ? 'selected' : ''}>Uncontrolled</option>
            <option value="yield" ${kind === 'yield' ? 'selected' : ''}>Yield</option>
            <option value="stop" ${kind === 'stop' ? 'selected' : ''}>Stop</option>
            <option value="signals" ${kind === 'signals' ? 'selected' : ''}>Traffic lights</option>
          </select></label>
        ${node.junction ? `<label class="ed-field"><span>Radius</span>
          <input type="number" data-node="radius" value="${node.junction.radius}" min="4" max="40" step="0.5" /></label>` : ''}
        ${controlRows}
        <div class="ed-buttons"><button data-act="delete">Delete junction</button></div>
      </section>
    `
  }

  private edgeSection(edge: EdgeSpec | undefined): string {
    if (!edge) return ''
    const lanes = edge.lanes ?? []
    const width = lanes[0]?.width ?? 3.5
    const oneWay = lanes.length === 1
    const limit = edge.speedLimit ?? ''
    const fallback = DEFAULT_SPEED_LIMITS[edge.category] ?? 50

    return `
      <section class="ed-section">
        <h4>Road <code>${edge.id}</code></h4>
        <p class="ed-sub">${edge.from} → ${edge.to}</p>
        <label class="ed-field"><span>Category</span>
          <select data-edge="category">
            ${CATEGORIES.map(
              ([value, label]) =>
                `<option value="${value}" ${edge.category === value ? 'selected' : ''}>${label}</option>`,
            ).join('')}
          </select></label>
        <label class="ed-field"><span>Limit</span>
          <input type="number" data-edge="speedLimit" value="${limit}" placeholder="${fallback}" min="10" max="130" step="10" /></label>
        <label class="ed-field"><span>Centre line</span>
          <select data-edge="centreLine">
            ${CENTRE_LINES.map(
              ([value, label]) =>
                `<option value="${value}" ${edge.centreLine === value ? 'selected' : ''}>${label}</option>`,
            ).join('')}
          </select></label>
        <label class="ed-field"><span>Lane width</span>
          <input type="number" data-lane="width" value="${width}" min="2.4" max="5" step="0.1" /></label>
        <label class="ed-check"><input type="checkbox" data-lane="oneWay" ${oneWay ? 'checked' : ''} />
          <span>One-way</span></label>
        <p class="ed-sub">${edge.via?.length ?? 0} bend point${(edge.via?.length ?? 0) === 1 ? '' : 's'}</p>
        <div class="ed-buttons"><button data-act="delete">Delete road</button></div>
      </section>
    `
  }

  private wirePanel(): void {
    const panel = this.panel
    const selection = this.selection

    panel.querySelectorAll<HTMLElement>('[data-act]').forEach((button) => {
      button.addEventListener('click', () => this.runAction(button.dataset.act ?? '', button))
    })

    panel.querySelectorAll<HTMLInputElement>('[data-node]').forEach((input) => {
      input.addEventListener('change', () => {
        if (selection.kind !== 'node') return
        const node = this.doc.node(selection.id)
        if (!node) return
        const value = Number(input.value)
        if (!Number.isFinite(value)) return
        if (input.dataset.node === 'radius') {
          this.doc.updateNode(node.id, {
            junction: { ...node.junction!, radius: value },
          })
        } else {
          this.doc.beginChange()
          this.doc.moveNode(
            node.id,
            input.dataset.node === 'x' ? value : node.x,
            input.dataset.node === 'y' ? value : node.y,
          )
          this.doc.commit()
        }
        this.afterChange()
      })
    })

    panel.querySelector<HTMLSelectElement>('[data-junction-kind]')?.addEventListener('change', (e) => {
      if (selection.kind !== 'node') return
      const kind = (e.target as HTMLSelectElement).value
      const node = this.doc.node(selection.id)
      if (!node) return

      if (kind === 'none') {
        this.doc.clearJunction(node.id)
      } else {
        const attached = this.doc.edgesAt(node.id).map((x) => x.id)
        let control: JunctionControl
        if (kind === 'yield') control = { kind: 'yield', yieldEdges: [] }
        else if (kind === 'stop') control = { kind: 'stop', stopEdges: [] }
        else if (kind === 'signals') {
          // Seed two alternating groups so the junction is immediately valid.
          const half = Math.max(1, Math.ceil(attached.length / 2))
          control = {
            kind: 'signals',
            groups: [attached.slice(0, half), attached.slice(half)].filter((g) => g.length > 0),
            greenSeconds: 14,
            amberSeconds: 3,
          }
          if (control.groups.length < 2) control = { kind: 'uncontrolled' }
        } else control = { kind: 'uncontrolled' }

        this.doc.updateNode(node.id, {
          junction: { radius: node.junction?.radius ?? 12, control },
        })
      }
      this.afterChange()
    })

    panel.querySelectorAll<HTMLInputElement>('[data-control-edge]').forEach((box) => {
      box.addEventListener('change', () => {
        if (selection.kind !== 'node') return
        const node = this.doc.node(selection.id)
        const control = node?.junction?.control
        if (!node || !control) return
        const edgeId = box.dataset.controlEdge!

        if (control.kind === 'yield' || control.kind === 'stop') {
          const key = control.kind === 'yield' ? 'yieldEdges' : 'stopEdges'
          const list = new Set(control.kind === 'yield' ? control.yieldEdges : control.stopEdges)
          if (box.checked) list.add(edgeId)
          else list.delete(edgeId)
          this.doc.updateNode(node.id, {
            junction: {
              ...node.junction!,
              control: { kind: control.kind, [key]: [...list] } as JunctionControl,
            },
          })
          this.afterChange()
        }
      })
    })

    panel.querySelectorAll<HTMLSelectElement>('[data-signal-edge]').forEach((select) => {
      select.addEventListener('change', () => {
        if (selection.kind !== 'node') return
        const node = this.doc.node(selection.id)
        const control = node?.junction?.control
        if (!node || control?.kind !== 'signals') return

        const edgeId = select.dataset.signalEdge!
        const target = Number(select.value)
        const groups: string[][] = [
          control.groups[0]?.filter((e) => e !== edgeId) ?? [],
          control.groups[1]?.filter((e) => e !== edgeId) ?? [],
        ]
        if (target === 0 || target === 1) groups[target]!.push(edgeId)

        this.doc.updateNode(node.id, {
          junction: { ...node.junction!, control: { ...control, groups } },
        })
        this.afterChange()
      })
    })

    panel.querySelectorAll<HTMLInputElement>('[data-signal]').forEach((input) => {
      input.addEventListener('change', () => {
        if (selection.kind !== 'node') return
        const node = this.doc.node(selection.id)
        const control = node?.junction?.control
        if (!node || control?.kind !== 'signals') return
        const value = Number(input.value)
        if (!Number.isFinite(value)) return
        this.doc.updateNode(node.id, {
          junction: {
            ...node.junction!,
            control: { ...control, [input.dataset.signal!]: value },
          },
        })
        this.afterChange()
      })
    })

    panel.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-edge]').forEach((field) => {
      field.addEventListener('change', () => {
        if (selection.kind !== 'edge' && selection.kind !== 'via') return
        const key = field.dataset.edge!
        if (key === 'speedLimit') {
          const value = field.value.trim()
          if (value === '') this.doc.clearSpeedLimit(selection.id)
          else this.doc.updateEdge(selection.id, { speedLimit: Number(value) })
        } else {
          this.doc.updateEdge(selection.id, { [key]: field.value } as Partial<EdgeSpec>)
        }
        this.afterChange()
      })
    })

    panel.querySelectorAll<HTMLInputElement>('[data-lane]').forEach((field) => {
      field.addEventListener('change', () => {
        if (selection.kind !== 'edge' && selection.kind !== 'via') return
        const edge = this.doc.edge(selection.id)
        if (!edge) return
        const existing = edge.lanes ?? []
        const widthField = panel.querySelector<HTMLInputElement>('[data-lane="width"]')
        const oneWayField = panel.querySelector<HTMLInputElement>('[data-lane="oneWay"]')
        const width = Number(widthField?.value ?? existing[0]?.width ?? 3.5)
        const oneWay = oneWayField?.checked ?? existing.length === 1

        this.doc.updateEdge(selection.id, {
          lanes: oneWay
            ? [{ direction: 1, width, kind: 'general' }]
            : [
                { direction: 1, width, kind: 'general' },
                { direction: -1, width, kind: 'general' },
              ],
        })
        this.afterChange()
      })
    })
  }

  private async runAction(action: string, button: HTMLElement): Promise<void> {
    switch (action) {
      case 'frame':
        this.view.frameAll(this.doc)
        break
      case 'undo':
        this.doc.undo()
        this.selection = { kind: 'none' }
        this.afterChange()
        break
      case 'redo':
        this.doc.redo()
        this.selection = { kind: 'none' }
        this.afterChange()
        break
      case 'delete':
        this.deleteSelection()
        break
      case 'copy-ts':
      case 'copy-json': {
        const text =
          action === 'copy-ts'
            ? toTypeScript(this.doc.toSpec(), 'BALLYROAD')
            : toJson(this.doc.toSpec())
        const original = button.textContent
        try {
          await navigator.clipboard.writeText(text)
          button.textContent = 'Copied'
        } catch {
          button.textContent = 'Copy failed'
        }
        setTimeout(() => (button.textContent = original), 1400)
        break
      }
      case 'import': {
        const text = prompt('Paste a saved layout (JSON)')
        if (!text) break
        try {
          this.doc.load(fromJson(text))
          this.selection = { kind: 'none' }
          this.view.frameAll(this.doc)
          this.afterChange()
        } catch (error) {
          alert(`Could not load that layout: ${(error as Error).message}`)
        }
        break
      }
      case 'revert': {
        if (!confirm('Discard your edits and go back to the original town?')) break
        try {
          localStorage.removeItem(STORAGE_KEY)
        } catch {
          /* ignore */
        }
        location.reload()
        break
      }
    }
    this.renderPanel()
  }
}
