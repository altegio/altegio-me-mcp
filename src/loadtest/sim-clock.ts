// A discrete-event clock for the tier 1 simulation. The auto-advancing clock
// of the gate tests moves time forward on every sleep, which counts the same
// wait once per waiter when several sleep at once. This one keeps a queue of
// timers: time moves only when `runUntil` or `drain` takes the next timer, so
// two waiters that sleep 100 ms and 300 ms from the same instant wake at +100
// and +300, in that order.
//
// `now` and `sleep` are closures, not methods, because the gate stores them as
// plain options and calls them with its own `this`.

export interface SimClock {
  now: () => number;
  /** Resolves once the simulated time has moved `ms` forward. */
  sleep: (ms: number) => Promise<void>;
  /** Runs `fn` when the simulated time reaches `atMs`. */
  at: (atMs: number, fn: () => void) => void;
  /** Runs every timer due up to and including `untilMs`, then sets the time to it. */
  runUntil: (untilMs: number) => Promise<void>;
  /** Runs timers until none is left. */
  drain: (maxEvents?: number) => Promise<void>;
  /** Timers not yet fired. */
  readonly pending: number;
}

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

function before(a: Timer, b: Timer): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

/** Lets every promise continuation a wake-up started run to the end. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function createSimClock(startMs: number): SimClock {
  let current = startMs;
  let seq = 0;
  // Binary min-heap on (at, seq): a ten-times-peak run holds thousands of timers.
  const heap: Timer[] = [];

  const push = (timer: Timer): void => {
    heap.push(timer);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(heap[index]!, heap[parent]!)) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  };

  const pop = (): Timer => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && before(heap[left]!, heap[smallest]!)) {
          smallest = left;
        }
        if (right < heap.length && before(heap[right]!, heap[smallest]!)) {
          smallest = right;
        }
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
        index = smallest;
      }
    }
    return top;
  };

  const at = (atMs: number, fn: () => void): void => {
    // A timer in the past runs at the current time, never before it.
    push({ at: Math.max(atMs, current), seq: (seq += 1), fn });
  };

  const runUntil = async (untilMs: number): Promise<void> => {
    await flush();
    while (heap.length > 0 && heap[0]!.at <= untilMs) {
      const timer = pop();
      current = Math.max(current, timer.at);
      timer.fn();
      await flush();
    }
    current = Math.max(current, untilMs);
  };

  return {
    now: () => current,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        at(current + Math.max(0, ms), resolve);
      }),
    at,
    runUntil,
    drain: async (maxEvents = 10_000_000): Promise<void> => {
      await flush();
      let events = 0;
      while (heap.length > 0) {
        events += 1;
        if (events > maxEvents) {
          throw new Error('Simulated clock did not run dry');
        }
        const timer = pop();
        current = Math.max(current, timer.at);
        timer.fn();
        await flush();
      }
    },
    get pending(): number {
      return heap.length;
    },
  };
}
