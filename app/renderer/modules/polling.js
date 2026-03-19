// polling.js — Centralized polling coordinator

export class PollingCoordinator {
  constructor() {
    this._tasks = new Map();
    this._tick = null;
  }

  /**
   * Register a polling task.
   * @param {string} name - unique task name
   * @param {Function} fn - async function to call
   * @param {number} intervalMs - minimum interval between calls
   * @param {object} [opts] - { condition: () => boolean, immediate: boolean }
   */
  register(name, fn, intervalMs, opts = {}) {
    this._tasks.set(name, {
      fn,
      intervalMs,
      condition: opts.condition || (() => true),
      lastRun: opts.immediate ? 0 : Date.now(),
      running: false,
      paused: false,
    });
  }

  start() {
    if (this._tick) return;
    this._tick = setInterval(() => this._runDue(), 1000);
  }

  stop() {
    clearInterval(this._tick);
    this._tick = null;
  }

  pause(name) {
    const task = this._tasks.get(name);
    if (task) task.paused = true;
  }

  resume(name) {
    const task = this._tasks.get(name);
    if (task) task.paused = false;
  }

  _runDue() {
    const now = Date.now();
    for (const [name, task] of this._tasks) {
      if (task.paused || task.running) continue;
      if (now - task.lastRun < task.intervalMs) continue;
      if (!task.condition()) continue;
      task.running = true;
      task.lastRun = now;
      Promise.resolve(task.fn()).catch(err => {
        console.error(`[Polling] ${name} error:`, err.message);
      }).finally(() => {
        task.running = false;
      });
    }
  }
}
