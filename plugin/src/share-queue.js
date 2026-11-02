/**
 * The queue of a shared conversation.
 *
 * A guest of a share may write while the agent is working, and the Host takes
 * every message it is given at once: the messages that wait in the Host are
 * folded into the running turn, and the Host records them cut — see
 * `docs/bugs/2026-11-02-queued-user-prompts-are-truncated.md`. The plugin
 * therefore keeps the queue itself and hands the Host one message at a time,
 * so the Host never has more than one message waiting, and the guests can see
 * where their words stand.
 *
 * The queue watches the shared session for the boundaries of the turns — the
 * Host writes `turn/start` and `turn/end` into the log — and it keeps the
 * number of the turn the log stands at and the number of the turn that ended
 * last: the agent is busy while the first is the greater of the two. The
 * numbers are what make it safe when the snapshot of the session is cut in the
 * middle of a turn: every event of a turn carries the number of the turn, so
 * a turn whose `turn/start` the cut left out is still seen in the events of
 * it.
 *
 * The module knows nothing of the Host's own delivery: the service passes its
 * own `prompt` and its own `follow`, and the module only decides *when* a
 * message is handed over.
 */

import { randomBytes } from 'node:crypto'

import { isHostContext, textOfContent } from './share-data.js'

/**
 * How many characters of a message the queue shows.
 *
 * The words themselves are never cut — the Host has to get them whole — but
 * the bar of the guests only has room for so much.
 */
export const SHARE_QUEUE_TEXT_LIMIT = 200

/**
 * How long the Host may take a message before the queue gives up on it.
 *
 * A guest waits for an answer, not for ever: a message that the agent never
 * takes leaves the queue instead of holding the ones behind it.
 */
export const SHARE_QUEUE_TAKE_TIMEOUT = 60_000

/**
 * How many messages of the session the queue reads at once.
 */
export const SHARE_QUEUE_MAX_MESSAGES = 200

/**
 * One message that waits in the queue.
 *
 * @typedef {object} QueueItem
 * @property {string} id the id of the message, unique in the module
 * @property {string} text the words of the guest, whole
 * @property {string} from the name of the guest who wrote them
 * @property {number} at when the guest wrote them, in milliseconds
 * @property {any[]} [parts] the upload that came with the words
 * @property {number} [mark] the turn the log stood at when the message went
 * @property {boolean} [recorded] whether the Host wrote the words into the log
 * @property {number} [attempts] how often the message has been said
 * @property {AbortController} [abort] the delivery of the message, while it runs
 */

/**
 * The queue of one share.
 *
 * @typedef {object} ShareQueue
 * @property {string} id the id of the share
 * @property {any} share the record of the share
 * @property {QueueItem[]} items the messages that wait to be handed over
 * @property {QueueItem | null} working the message the agent works on now
 * @property {number} lastStarted the turn that started last
 * @property {number} lastEnded the turn that ended last
 * @property {number} highest the turn the log speaks of
 * @property {boolean} ready whether the queue has read the log
 * @property {boolean} watching whether the follower of the session is open
 * @property {boolean} closed whether the queue is done
 * @property {Set<() => void>} waiters the ones that wait for the turn state
 * @property {Promise<void> | undefined} runner the loop that hands messages over
 * @property {AbortController | undefined} abort the follower of the session
 */

/**
 * The queues of every share.
 *
 * @param {object} options
 * @param {(request: any, signal: AbortSignal) => Promise<any>} options.follow the follower of a session
 * @param {(share: any, item: QueueItem, signal: AbortSignal) => Promise<void>} options.prompt the delivery of one message
 * @param {(shareId: string, frame: any) => void} [options.onChange] called every time the queue changes
 * @param {(message: string, extra?: any) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.takeTimeout] how long the Host may take a message
 * @returns {{ enqueue: (share: any, item: any) => { id: string, position: number }, state: (shareId: string) => any, drop: (shareId: string) => void, dispose: () => void }}
 */
export function createShareQueues(options) {
  const follow = options?.follow
  const prompt = options?.prompt
  const onChange = typeof options?.onChange === 'function' ? options.onChange : () => {}
  const log = typeof options?.log === 'function' ? options.log : () => {}
  const now = typeof options?.now === 'function' ? options.now : () => Date.now()
  const takeTimeout = typeof options?.takeTimeout === 'number' ? options.takeTimeout : SHARE_QUEUE_TAKE_TIMEOUT

  /** @type {Map<string, ShareQueue>} */
  const queues = new Map()
  /** @type {Set<string>} */
  const usedIds = new Set()
  let counter = 0

  /**
   * The id of a message of the queue.
   *
   * @returns {string} 'q' and eight lowercase hex characters
   */
  const newId = () => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = `q${randomBytes(4).toString('hex')}`
      if (usedIds.has(id)) continue
      usedIds.add(id)
      return id
    }
    // The ids are random, and sixteen tries are more than enough. The way
    // out is here anyway, because the queue must not hand out an id twice.
    let id = ''
    do {
      counter += 1
      id = `q${counter.toString(16).padStart(8, '0')}`
    } while (usedIds.has(id))
    usedIds.add(id)
    return id
  }

  /**
   * The text of a message, as the guests see it.
   *
   * @param {string} text
   * @returns {string}
   */
  const clip = (text) => {
    const value = typeof text === 'string' ? text : String(text ?? '')
    if (value.length <= SHARE_QUEUE_TEXT_LIMIT) return value
    return `${value.slice(0, SHARE_QUEUE_TEXT_LIMIT)}…`
  }

  /**
   * The number of the turn an event belongs to.
   *
   * @param {any} event
   * @returns {number | undefined}
   */
  const turnOf = (event) => {
    const turn = event?.data?.turn
    return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
  }

  /**
   * Is the agent working on something?
   *
   * The last turn that started and the last turn that ended are the two
   * numbers the queue keeps. The turn that started is the greater of the two
   * while the agent is busy.
   *
   * @param {ShareQueue} queue
   * @returns {boolean}
   */
  const isBusy = (queue) => queue.highest > queue.lastEnded

  /**
   * May the queue hand a message over now?
   *
   * The queue waits for the log before it says anything: without the log the
   * agent's state is unknown, and a message that goes to a busy session is
   * exactly what the queue is for.
   *
   * A follower that is gone is the one case where the queue hands the message
   * over without knowing: a message that waits for ever is worse than one
   * that goes to the Host's own queue, where the Host holds it and takes it
   * when it is free.
   *
   * @param {ShareQueue} queue
   * @returns {boolean}
   */
  const isIdle = (queue) => {
    if (!queue.watching) return true
    return queue.ready && !isBusy(queue)
  }

  /**
   * Has the Host taken the message?
   *
   * The Host takes a message when it writes it into the log. The turn that
   * takes it is not the proof: a message of the owner that waits in the Host
   * before ours would open a turn of its own, and the queue would think that
   * our message is finished while it is still waiting in the Host.
   *
   * @param {ShareQueue} queue
   * @param {QueueItem} item
   * @returns {boolean}
   */
  const taken = (queue, item) => item.recorded === true

  /**
   * Wait until the queue says so.
   *
   * The wait holds a timer of its own when it is given a timeout, and the
   * `release` of the promise lets it go when the answer is not wanted any
   * more.
   *
   * @param {ShareQueue} queue
   * @param {() => boolean} predicate what the queue has to say
   * @param {number} [timeoutMs] how long to wait, if at all
   * @returns {Promise<boolean> & { release: () => void }} whether the queue said so
   */
  function waitFor(queue, predicate, timeoutMs) {
    let release = () => {}
    const promise = new Promise((resolve) => {
      let timer = null
      /**
       * @param {boolean} value
       */
      const settle = (value) => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        queue.waiters.delete(entry)
        resolve(value)
      }
      const entry = () => {
        if (queue.closed) {
          settle(false)
          return
        }
        if (!predicate()) return
        settle(true)
      }
      release = () => settle(false)
      if (queue.closed) {
        settle(false)
        return
      }
      if (predicate()) {
        settle(true)
        return
      }
      queue.waiters.add(entry)
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => settle(false), timeoutMs)
        // The timeout is a matter of the background: it must not hold the
        // host up when nothing else is going on.
        timer.unref?.()
      }
    })
    promise.release = release
    return promise
  }

  /**
   * Tell the ones that wait that the queue has something new to say.
   *
   * @param {ShareQueue} queue
   */
  function wake(queue) {
    for (const entry of [...queue.waiters]) entry()
  }

  /**
   * The queue as the guests see it.
   *
   * @param {ShareQueue} queue
   * @returns {{ kind: string, working: any, waiting: any[] }}
   */
  function frameOf(queue) {
    return {
      kind: 'queue',
      working: queue.working === null ? null : viewOf(queue.working),
      waiting: queue.items.map(viewOf),
    }
  }

  /**
   * One message of the queue, as the guests see it.
   *
   * @param {QueueItem} item
   * @returns {{ id: string, text: string, from: string, at: number }}
   */
  function viewOf(item) {
    return { id: item.id, text: clip(item.text), from: item.from, at: item.at }
  }

  /**
   * Tell the service that the queue has changed.
   *
   * @param {ShareQueue} queue
   */
  function notify(queue) {
    onChange(queue.id, frameOf(queue))
  }

  /**
   * The Host wrote a message into the log: the message of the queue it
   * belongs to has been taken.
   *
   * The message that is worked on is looked at first: it is the one the Host
   * was given last, and the words of one guest may be the words of another.
   *
   * @param {ShareQueue} queue
   * @param {string} text the words the Host recorded
   */
  function markTaken(queue, text) {
    const matches = (item) => item.text === text || item.text.startsWith(text)
    if (queue.working !== null && queue.working.recorded !== true && matches(queue.working)) {
      queue.working.recorded = true
      return
    }
    for (const item of queue.items) {
      if (item.recorded === true) continue
      if (!matches(item)) continue
      item.recorded = true
      break
    }
  }

  /**
   * Read the boundaries of the turns out of one frame of the session.
   *
   * A snapshot carries the records of the log, and every other frame carries
   * one event. Every event of a turn carries the number of the turn, so a
   * turn that the cut of the snapshot left out is still seen in the events of
   * it.
   *
   * @param {ShareQueue} queue
   * @param {any} frame
   */
  function readFrame(queue, frame) {
    const events = frame?.type === 'snapshot'
      ? (frame.records ?? []).map((record) => record?.event).filter((event) => event !== undefined)
      : (frame?.type === 'event' ? [frame.event] : [])
    for (const event of events) {
      // The words of a guest: the Host writes them into the log when it takes
      // the message, and that is how the queue knows that the message is not
      // waiting in the Host any more.
      if (event?.type === 'user/message' && !isHostContext(event.data)) {
        const text = textOfContent(event.data?.content).trim()
        if (text.length > 0) markTaken(queue, text)
      }
      const turn = turnOf(event)
      if (turn === undefined) continue
      if (turn > queue.highest) queue.highest = turn
      if (event.type === 'turn/start' && turn > queue.lastStarted) queue.lastStarted = turn
      if (event.type === 'turn/end' && turn > queue.lastEnded) queue.lastEnded = turn
    }
    queue.ready = true
    wake(queue)
  }

  /**
   * Watch the session of a share.
   *
   * The follower ends when the queue is empty, and a follower that throws
   * ends as well: the queue does not spin on a session it cannot read.
   *
   * @param {ShareQueue} queue
   * @param {AbortController} controller
   */
  async function watch(queue, controller) {
    try {
      if (typeof follow !== 'function') {
        log('share: the queue cannot follow the session', { sessionId: queue.share?.sessionId })
        return
      }
      const frames = await follow(
        {
          address: { kind: 'session', sessionId: queue.share?.sessionId },
          maxMessages: SHARE_QUEUE_MAX_MESSAGES,
        },
        controller.signal,
      )
      if (frames === undefined || typeof frames[Symbol.asyncIterator] !== 'function') {
        log('share: the session does not answer the queue', { sessionId: queue.share?.sessionId })
        return
      }
      for await (const frame of frames) {
        if (queue.closed) break
        readFrame(queue, frame)
      }
      if (!queue.closed) {
        log('share: the queue lost the session', { sessionId: queue.share?.sessionId })
      }
    } catch (error) {
      if (!queue.closed) {
        log('share: the queue lost the session', { sessionId: queue.share?.sessionId, error: String(error) })
      }
    } finally {
      queue.watching = false
      if (queue.abort === controller) queue.abort = undefined
      wake(queue)
    }
  }

  /**
   * Open the follower of a share.
   *
   * The follower is opened when the first message is queued, and it is closed
   * when the queue is empty and nothing is in flight.
   *
   * @param {ShareQueue} queue
   */
  function open(queue) {
    if (queue.closed || queue.watching) return
    queue.watching = true
    // The log is read again: what the old follower knew is no longer enough.
    queue.ready = false
    const controller = new AbortController()
    queue.abort = controller
    void watch(queue, controller)
  }

  /**
   * Hand one message to the Host.
   *
   * @param {ShareQueue} queue
   * @param {QueueItem} item
   * @returns {Promise<'delivered' | 'refused'>}
   */
  async function deliver(queue, item) {
    const controller = new AbortController()
    item.abort = controller
    try {
      if (typeof prompt !== 'function') throw new Error('the host cannot deliver a message to a session')
      await prompt(queue.share, item, controller.signal)
      return 'delivered'
    } catch (error) {
      log('share: the message was refused', { id: item.id, error: String(error) })
      return 'refused'
    } finally {
      item.abort = undefined
    }
  }

  /**
   * Hand the message to the Host and wait for the answer of the Host.
   *
   * The Host answers when it has taken the message into its inbox. A Host
   * that does not answer is given up on: a guest waits for an answer, not for
   * ever.
   *
   * @param {ShareQueue} queue
   * @param {QueueItem} item
   * @returns {Promise<'delivered' | 'refused'>}
   */
  async function deliverWithPatience(queue, item) {
    let timer = null
    const outcome = await Promise.race([
      deliver(queue, item),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('slow'), takeTimeout)
        // The timeout is a matter of the background: it must not hold the
        // host up when nothing else is going on.
        timer.unref?.()
      }),
    ])
    if (timer !== null) clearTimeout(timer)
    if (outcome !== 'slow') return outcome
    // A delivery that is still running is let go: the Host had its chance.
    item.abort?.abort()
    log('share: the host did not answer', { id: item.id })
    return 'refused'
  }

  /**
   * Wait until the Host has written the message into the log.
   *
   * The wait is given up on when the agent is idle and the words are still not
   * in the log: the Host has the message in its inbox and does not take it,
   * which happens when the turn of the owner is cancelled and the inbox is
   * cleared with it.
   *
   * @param {ShareQueue} queue
   * @param {QueueItem} item
   * @returns {Promise<boolean>} whether the Host took the message
   */
  async function waitTaken(queue, item) {
    while (!queue.closed) {
      if (taken(queue, item)) return true
      // Without a follower the log cannot be read: the Host has the message,
      // and the queue must not wait for a proof it cannot get.
      if (!queue.watching) return true
      const settled = await waitFor(queue, () => taken(queue, item), takeTimeout)
      if (settled) return true
      if (queue.closed) return false
      // The agent is working: the message is taken when the turn ends.
      if (isBusy(queue)) continue
      return false
    }
    return false
  }

  /**
   * Work on one message: hand it over, and wait for the Host to take it.
   *
   * The Host takes a message when it writes it into the log, and the turn
   * that takes it ends on its own — a cancelled turn ends as well. A message
   * the Host does not take is let go, the way the Host lets go of the
   * messages a cancelled turn took with it: a guest waits for an answer and
   * not for ever.
   *
   * @param {ShareQueue} queue
   * @param {QueueItem} item
   */
  async function work(queue, item) {
    while (!queue.closed) {
      const outcome = await deliverWithPatience(queue, item)
      if (outcome !== 'delivered') break
      const hasIt = await waitTaken(queue, item)
      if (hasIt) {
        // The turn of the message ends on its own.
        await waitFor(queue, () => !isBusy(queue) || !queue.watching)
        break
      }
      if (queue.closed) break
      log('share: the agent did not take the message', { id: item.id })
      break
    }
    queue.working = null
    notify(queue)
  }

  /**
   * The loop that hands the messages of a share over, one after the other.
   *
   * @param {ShareQueue} queue
   */
  async function run(queue) {
    try {
      while (!queue.closed) {
        if (queue.working !== null) {
          await work(queue, queue.working)
          continue
        }
        if (queue.items.length === 0) break
        // The agent has to be idle: a message that goes to a busy session is
        // folded into the running turn, and that is what the queue is for.
        const idle = await waitFor(queue, () => isIdle(queue))
        if (!idle || !isIdle(queue)) continue
        if (queue.items.length === 0) continue
        const item = queue.items.shift()
        item.mark = queue.highest
        queue.working = item
        notify(queue)
        await work(queue, item)
      }
    } finally {
      queue.runner = undefined
      if (!queue.closed && queue.items.length > 0) start(queue)
      if (!queue.closed && queue.items.length === 0 && queue.working === null) close(queue)
    }
  }

  /**
   * Start the loop of a share, if it is not already running.
   *
   * @param {ShareQueue} queue
   */
  function start(queue) {
    if (queue.closed) return
    if (queue.runner !== undefined) return
    queue.runner = run(queue)
  }

  /**
   * Close a share whose queue is empty.
   *
   * @param {ShareQueue} queue
   */
  function close(queue) {
    queue.abort?.abort()
    queue.abort = undefined
    queues.delete(queue.id)
  }

  return {
    /**
     * Put a message of a guest into the queue.
     *
     * The message waits until the agent is free, and the Host is given one
     * message at a time.
     *
     * @param {any} share the share the message belongs to
     * @param {{ text: string, parts?: any[], from?: string, at?: number }} item the message of the guest
     * @returns {{ id: string, position: number }} the id of the message and its place in the queue
     */
    enqueue(share, item) {
      const id = String(share?.id ?? '')
      let queue = queues.get(id)
      if (queue === undefined) {
        queue = {
          id,
          share,
          items: [],
          working: null,
          lastStarted: 0,
          lastEnded: 0,
          highest: 0,
          ready: false,
          watching: false,
          closed: false,
          waiters: new Set(),
          runner: undefined,
          abort: undefined,
        }
        queues.set(id, queue)
      }
      const entry = {
        ...(item ?? {}),
        id: newId(),
        text: typeof item?.text === 'string' ? item.text : String(item?.text ?? ''),
        from: String(item?.from ?? ''),
        at: typeof item?.at === 'number' ? item.at : now(),
        // Whether the Host has written the words into the log, and how often
        // the message has been said.
        recorded: false,
        attempts: 0,
      }
      queue.items.push(entry)
      notify(queue)
      open(queue)
      start(queue)
      return { id: entry.id, position: queue.items.length }
    },

    /**
     * Forget the queue of a share.
     *
     * The share is gone, so the messages that wait are not said to the agent
     * and the follower of the session is closed. The guests are told once, so
     * the bar of the share goes away with it.
     *
     * @param {string} shareId
     */
    drop(shareId) {
      const id = String(shareId ?? '')
      const queue = queues.get(id)
      if (queue === undefined) return
      queue.closed = true
      queue.abort?.abort()
      queue.abort = undefined
      queue.working?.abort?.abort()
      wake(queue)
      queues.delete(id)
      onChange(id, { kind: 'queue', working: null, waiting: [] })
    },

    /**
     * The queue of a share, as the guests see it.
     *
     * @param {string} shareId
     * @returns {{ kind: string, working: any, waiting: any[] } | undefined} nothing when the share has no queue
     */
    state(shareId) {
      const queue = queues.get(String(shareId ?? ''))
      if (queue === undefined) return undefined
      return frameOf(queue)
    },

    /**
     * Let go of every queue.
     *
     * The followers of the sessions are closed, the deliveries that are still
     * running are cancelled, and the messages that wait are forgotten.
     */
    dispose() {
      for (const queue of queues.values()) {
        queue.closed = true
        queue.abort?.abort()
        queue.abort = undefined
        queue.working?.abort?.abort()
        wake(queue)
      }
      queues.clear()
    },
  }
}
