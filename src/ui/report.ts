/**
 * The post-drive report.
 *
 * Modelled on the sheet a candidate is handed at the end of a driving test: a
 * result, the grounds for it in the marking guidelines' own terms, a tally
 * under each heading, and the individual faults in the order they happened.
 *
 * The thing a report cannot normally do is answer "what did I actually do
 * wrong?". Because the drive is recorded as input rather than as video, every
 * fault here is a seekable moment: pick one and the simulation replays the
 * seconds leading up to it, in the car, from the driver's own seat.
 */

import type { RecordedDrive } from '../sim/recorder'
import type { RulesEngine } from '../rules/engine'
import { ALL_ASPECTS, type Fault, type Verdict } from '../rules/types'

export interface ReportHooks {
  /** Replay the drive, starting a few seconds before this moment. */
  replayFrom(seconds: number): void
  /** Close the report and go back to driving. */
  close(): void
  /** Throw the drive away and start again from the beginning. */
  restart(): void
}

/** How far before a fault the replay starts, so there is context to see. */
const LEAD_IN_SECONDS = 6

function clock(t: number): string {
  const minutes = Math.floor(t / 60)
  const seconds = Math.floor(t % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export class Report {
  private readonly map: HTMLCanvasElement
  private readonly body: HTMLElement
  private drive: RecordedDrive | null = null
  private faults: Fault[] = []
  private selected = -1
  isOpen = false

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: ReportHooks,
  ) {
    root.innerHTML = `
      <div class="report-sheet">
        <div class="report-body" data-body></div>
        <div class="report-side">
          <canvas data-map width="420" height="420"></canvas>
          <p class="report-note" data-note></p>
        </div>
      </div>
    `
    this.body = root.querySelector('[data-body]')!
    this.map = root.querySelector('[data-map]')!

    this.map.addEventListener('click', (e) => this.onMapClick(e))
    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const action = target.closest('[data-action]')?.getAttribute('data-action')
      if (action === 'close') this.hooks.close()
      if (action === 'restart') this.hooks.restart()
      if (action === 'replay-all') this.hooks.replayFrom(0)

      const row = target.closest('[data-fault]')
      if (row) {
        const index = Number(row.getAttribute('data-fault'))
        this.select(index)
        const fault = this.faults[index]
        if (fault) this.hooks.replayFrom(Math.max(0, fault.t - LEAD_IN_SECONDS))
      }
    })
  }

  show(rules: RulesEngine, drive: RecordedDrive | null): void {
    this.drive = drive
    this.faults = [...rules.faults]
    this.selected = -1
    this.render(rules.verdict(), rules, drive)
    this.root.hidden = false
    this.isOpen = true
  }

  hide(): void {
    this.root.hidden = true
    this.isOpen = false
  }

  private render(verdict: Verdict, rules: RulesEngine, drive: RecordedDrive | null): void {
    const minutes = drive ? (drive.steps * drive.dt) / 60 : 0
    const distanceKm = drive ? this.routeLength(drive) / 1000 : 0

    const rows = ALL_ASPECTS.map((aspect) => {
      const tally = rules.tallyFor(aspect)
      const g2 = tally?.grade2 ?? 0
      const g3 = tally?.grade3 ?? 0
      const worst = Math.max(...[...(tally?.byRule.values() ?? [0])])
      const flagged = g3 > 0 || g2 >= 6 || worst >= 4
      return `
        <tr class="${flagged ? 'flagged' : g2 > 0 ? 'marked' : ''}">
          <th>${aspect}</th>
          <td>${g2 || ''}</td>
          <td>${g3 || ''}</td>
        </tr>`
    }).join('')

    const faultRows = this.faults.length
      ? this.faults
          .map(
            (fault, i) => `
        <li class="report-fault grade-${fault.grade}" data-fault="${i}">
          <span class="chip">G${fault.grade}</span>
          <div>
            <strong>${fault.message}</strong>
            <em>${fault.aspect}${fault.reference ? ` · ${fault.reference}` : ''}</em>
          </div>
          <span class="at">${clock(fault.t)}<small>${Math.round(fault.speedKmh)} km/h</small></span>
        </li>`,
          )
          .join('')
      : '<li class="report-empty">No faults recorded.</li>'

    this.body.innerHTML = `
      <header class="report-head ${verdict.passed ? 'pass' : 'fail'}">
        <div>
          <span class="report-result">${verdict.passed ? 'Passed' : 'Failed'}</span>
          <span class="report-meta">${minutes.toFixed(1)} min · ${distanceKm.toFixed(2)} km ·
            ${verdict.grade2} grade 2 · ${verdict.grade3} grade 3</span>
        </div>
        <div class="report-actions">
          <button data-action="replay-all">Replay drive</button>
          <button data-action="restart">Drive again</button>
          <button data-action="close" class="primary">Back to the car</button>
        </div>
      </header>

      ${
        verdict.passed
          ? ''
          : `<ul class="report-reasons">${verdict.reasons
              .map((r) => `<li>${r}</li>`)
              .join('')}</ul>`
      }

      <div class="report-columns">
        <section>
          <h3>Marking sheet</h3>
          <table class="report-table">
            <thead><tr><th>Aspect</th><th>G2</th><th>G3</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="report-small">
            A test is failed by one Grade 3, four of the same Grade 2 under one
            aspect, six Grade 2 under one aspect, or nine Grade 2 overall.
          </p>
        </section>
        <section>
          <h3>Faults in order</h3>
          <ol class="report-faults">${faultRows}</ol>
          ${this.faults.length ? '<p class="report-small">Pick a fault to replay the moment it happened.</p>' : ''}
        </section>
      </div>
    `

    this.drawMap()
  }

  private select(index: number): void {
    this.selected = index
    for (const el of this.root.querySelectorAll('[data-fault]')) {
      el.classList.toggle('selected', Number(el.getAttribute('data-fault')) === index)
    }
    this.drawMap()
  }

  private routeLength(drive: RecordedDrive): number {
    let total = 0
    for (let i = 1; i < drive.path.length; i++) {
      const a = drive.path[i - 1]!
      const b = drive.path[i]!
      total += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    return total
  }

  /** World-to-canvas transform for the route, fitted to whatever was driven. */
  private mapTransform(drive: RecordedDrive): { scale: number; ox: number; oy: number } | null {
    if (drive.path.length < 2) return null
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [x, y] of drive.path) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    const pad = 30
    const w = this.map.width - pad * 2
    const h = this.map.height - pad * 2
    const scale = Math.min(w / Math.max(maxX - minX, 1), h / Math.max(maxY - minY, 1))
    return {
      scale,
      ox: pad + (w - (maxX - minX) * scale) / 2 - minX * scale,
      // Canvas y grows downward; the sim's grows north.
      oy: pad + (h - (maxY - minY) * scale) / 2 + maxY * scale,
    }
  }

  private drawMap(): void {
    const ctx = this.map.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, this.map.width, this.map.height)

    const note = this.root.querySelector('[data-note]') as HTMLElement | null
    const drive = this.drive
    const t = drive ? this.mapTransform(drive) : null
    if (!drive || !t) {
      if (note) note.textContent = 'No route recorded.'
      return
    }
    if (note) {
      note.textContent =
        this.selected >= 0
          ? `Fault ${this.selected + 1} of ${this.faults.length}, at ${clock(this.faults[this.selected]!.t)}.`
          : 'The route driven. Faults are marked where they happened.'
    }

    const px = (x: number): number => x * t.scale + t.ox
    const py = (y: number): number => t.oy - y * t.scale

    ctx.lineWidth = 2.5
    ctx.strokeStyle = 'rgba(111, 208, 140, 0.75)'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    drive.path.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(px(x), py(y))
      else ctx.lineTo(px(x), py(y))
    })
    ctx.stroke()

    // Where the drive began.
    const start = drive.path[0]!
    ctx.fillStyle = '#e9eef5'
    ctx.beginPath()
    ctx.arc(px(start[0]), py(start[1]), 4, 0, Math.PI * 2)
    ctx.fill()

    this.faults.forEach((fault, i) => {
      const chosen = i === this.selected
      ctx.beginPath()
      ctx.arc(px(fault.x), py(fault.y), chosen ? 9 : 6, 0, Math.PI * 2)
      ctx.fillStyle = fault.grade === 3 ? '#ff5d4d' : fault.grade === 2 ? '#ffa51f' : '#9aa7b6'
      ctx.fill()
      if (chosen) {
        ctx.lineWidth = 2
        ctx.strokeStyle = '#e9eef5'
        ctx.stroke()
      }
    })
  }

  /** Clicking a marker on the map selects the same fault the list would. */
  private onMapClick(e: MouseEvent): void {
    const drive = this.drive
    const t = drive ? this.mapTransform(drive) : null
    if (!drive || !t) return

    const rect = this.map.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * this.map.width
    const y = ((e.clientY - rect.top) / rect.height) * this.map.height

    let nearest = -1
    let bestDistance = 14
    this.faults.forEach((fault, i) => {
      const d = Math.hypot(fault.x * t.scale + t.ox - x, t.oy - fault.y * t.scale - y)
      if (d < bestDistance) {
        bestDistance = d
        nearest = i
      }
    })

    if (nearest >= 0) {
      this.select(nearest)
      this.root
        .querySelector(`[data-fault="${nearest}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      this.hooks.replayFrom(Math.max(0, this.faults[nearest]!.t - LEAD_IN_SECONDS))
    }
  }
}
