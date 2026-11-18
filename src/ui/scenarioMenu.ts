/**
 * The scenario picker, and the brief that stays on screen once one is running.
 *
 * The brief matters as much as the setup. A driver who is told "give way to
 * anyone coming from your right" before they arrive at the roundabout is being
 * taught; one who is only told afterwards that they failed to is being tested.
 * This is a trainer, so it does both, in that order.
 */

import type { Scenario } from '../scenarios/scenarios'

export interface ScenarioMenuHooks {
  start(scenario: Scenario): void
  /** Leave the scenario and go back to the ordinary town drive. */
  freeDrive(): void
  close(): void
}

export class ScenarioMenu {
  private readonly list: HTMLElement
  isOpen = false

  constructor(
    private readonly root: HTMLElement,
    private readonly brief: HTMLElement,
    private readonly scenarios: Scenario[],
    private readonly hooks: ScenarioMenuHooks,
  ) {
    root.innerHTML = `
      <div class="scenario-sheet">
        <header>
          <div>
            <h2>Practice</h2>
            <p>One situation, set up the same way every time.</p>
          </div>
          <div class="scenario-actions">
            <button data-free>Free drive</button>
            <button data-close class="primary">Close</button>
          </div>
        </header>
        <ol data-list></ol>
      </div>
    `
    this.list = root.querySelector('[data-list]')!

    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-close]')) return this.hooks.close()
      if (target.closest('[data-free]')) return this.hooks.freeDrive()

      const row = target.closest('[data-scenario]')
      if (!row) return
      const scenario = this.scenarios.find(
        (s) => s.id === row.getAttribute('data-scenario'),
      )
      if (scenario) this.hooks.start(scenario)
    })

    this.render()
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.scenarios.map((scenario, i) => {
        const li = document.createElement('li')
        li.className = 'scenario-row'
        li.setAttribute('data-scenario', scenario.id)
        li.innerHTML = `
          <span class="scenario-number">${i + 1}</span>
          <div>
            <strong>${scenario.title}</strong>
            <p>${scenario.brief}</p>
            <em>${scenario.reference}</em>
          </div>
        `
        return li
      }),
    )
  }

  toggle(): boolean {
    this.isOpen = !this.isOpen
    this.root.hidden = !this.isOpen
    return this.isOpen
  }

  hide(): void {
    this.isOpen = false
    this.root.hidden = true
  }

  /** Show the brief for a running scenario, or clear it for a free drive. */
  showBrief(scenario: Scenario | null): void {
    if (!scenario) {
      this.brief.hidden = true
      return
    }
    this.brief.hidden = false
    this.brief.innerHTML =
      `<strong>${scenario.title}</strong>` +
      `<span>${scenario.brief}</span>` +
      `<em>${scenario.reference}</em>`
  }

  /** Pick by number key, as printed beside each row. */
  at(index: number): Scenario | undefined {
    return this.scenarios[index]
  }
}
