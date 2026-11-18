export interface FieldSpec<T> {
  key: keyof T & string
  label: string
  min: number
  max: number
  step: number
  unit: string
}

interface Section<T extends Record<string, number>> {
  title: string
  target: T
  defaults: T
  fields: FieldSpec<T>[]
  storageKey: string
  note?: (target: T) => string
  noteEl?: HTMLElement
  inputs: Map<string, { input: HTMLInputElement; readout: HTMLElement; field: FieldSpec<T> }>
}

/**
 * Live tuning panel. The point of a feel spike is that the numbers get dialled
 * in by driving, not by arithmetic — so everything that affects how the car
 * feels is adjustable mid-drive, persisted locally, and exportable so a tuned
 * set can be promoted to the new defaults.
 */
export class Tuner {
  // Sections are heterogeneous, so they are stored loosely and only ever
  // touched through the typed closures created in addSection().
  private readonly sections: Section<never>[] = []
  private readonly sectionsEl: HTMLElement

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: () => void,
  ) {
    this.root.innerHTML = `
      <header>
        <strong>Tuning</strong>
        <span class="tuner-hint">T to hide</span>
      </header>
      <div class="tuner-sections"></div>
      <footer>
        <div class="tuner-actions">
          <button data-reset>Reset all</button>
          <button data-copy>Copy JSON</button>
        </div>
      </footer>
    `
    this.sectionsEl = this.root.querySelector('.tuner-sections')!

    this.root.querySelector('[data-reset]')!.addEventListener('click', () => {
      for (const s of this.sections as unknown as Section<Record<string, number>>[]) {
        Object.assign(s.target, s.defaults)
        this.persist(s)
        this.sync(s)
      }
      this.onChange()
    })

    this.root.querySelector('[data-copy]')!.addEventListener('click', async (e) => {
      const button = e.currentTarget as HTMLButtonElement
      const payload: Record<string, unknown> = {}
      for (const s of this.sections as unknown as Section<Record<string, number>>[]) {
        payload[s.storageKey] = s.target
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
        button.textContent = 'Copied'
      } catch {
        button.textContent = 'Copy failed'
      }
      setTimeout(() => (button.textContent = 'Copy JSON'), 1400)
    })
  }

  /** Restore a saved parameter set, falling back to the defaults field by field. */
  static load<T extends Record<string, number>>(storageKey: string, defaults: T): T {
    const params = { ...defaults }
    try {
      const raw = localStorage.getItem(`ids.p0.${storageKey}`)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<T>
        for (const key of Object.keys(defaults) as Array<keyof T>) {
          const v = saved[key]
          if (typeof v === 'number' && Number.isFinite(v)) params[key] = v as T[keyof T]
        }
      }
    } catch {
      // Corrupt or blocked storage must never stop the car from driving.
    }
    return params
  }

  addSection<T extends Record<string, number>>(
    title: string,
    storageKey: string,
    target: T,
    defaults: T,
    fields: FieldSpec<T>[],
    note?: (target: T) => string,
  ): void {
    const section: Section<T> = {
      title,
      target,
      defaults: { ...defaults },
      fields,
      storageKey,
      inputs: new Map(),
      ...(note ? { note } : {}),
    }

    const el = document.createElement('section')
    el.className = 'tuner-section'
    el.innerHTML = `<h4>${title}</h4><div class="tuner-rows"></div>`
    const rows = el.querySelector('.tuner-rows')!

    for (const field of fields) {
      const row = document.createElement('label')
      row.className = 'tuner-row'
      row.innerHTML = `<span>${field.label}</span><input type="range" /><em></em>`
      const input = row.querySelector('input')!
      const readout = row.querySelector('em')!
      input.min = String(field.min)
      input.max = String(field.max)
      input.step = String(field.step)
      input.value = String(target[field.key])
      readout.textContent = `${target[field.key]} ${field.unit}`
      input.addEventListener('input', () => {
        target[field.key] = Number(input.value) as T[typeof field.key]
        readout.textContent = `${Number(input.value)} ${field.unit}`
        this.persist(section)
        this.refreshNote(section)
        this.onChange()
      })
      section.inputs.set(field.key, { input, readout, field })
      rows.append(row)
    }

    if (note) {
      const noteEl = document.createElement('p')
      noteEl.className = 'tuner-note'
      el.append(noteEl)
      section.noteEl = noteEl
    }

    this.sectionsEl.append(el)
    this.sections.push(section as unknown as Section<never>)
    this.refreshNote(section)
  }

  private persist<T extends Record<string, number>>(s: Section<T>): void {
    try {
      localStorage.setItem(`ids.p0.${s.storageKey}`, JSON.stringify(s.target))
    } catch {
      /* ignore */
    }
  }

  private sync<T extends Record<string, number>>(s: Section<T>): void {
    for (const [key, { input, readout, field }] of s.inputs) {
      const value = s.target[key as keyof T]
      input.value = String(value)
      readout.textContent = `${value} ${field.unit}`
    }
    this.refreshNote(s)
  }

  private refreshNote<T extends Record<string, number>>(s: Section<T>): void {
    if (s.note && s.noteEl) s.noteEl.textContent = s.note(s.target)
  }

  toggle(): boolean {
    this.root.hidden = !this.root.hidden
    return !this.root.hidden
  }
}
