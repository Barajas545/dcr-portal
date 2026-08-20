export class CommandStack {
  #past = [];
  #future = [];
  #limit;

  constructor(limit = 100) {
    this.#limit = limit;
  }

  execute(current, command) {
    const next = command.apply(current);
    this.#past.push({ command, before: current });
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future = [];
    return next;
  }

  undo(current) {
    const entry = this.#past.pop();
    if (!entry) return current;
    this.#future.push({ command: entry.command, before: current });
    return entry.before;
  }

  redo(current) {
    const entry = this.#future.pop();
    if (!entry) return current;
    const next = entry.command.apply(current);
    this.#past.push({ command: entry.command, before: current });
    return next;
  }

  get canUndo() { return this.#past.length > 0; }
  get canRedo() { return this.#future.length > 0; }
}

export function replaceDocument(nextDocument, label = 'Update project') {
  return { label, apply: () => nextDocument };
}
