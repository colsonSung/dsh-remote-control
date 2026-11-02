/**
 * The queue of a shared conversation.
 *
 * The queue keeps the messages of the guests itself and hands the Host one
 * message at a time, so that the Host never has more than one message
 * waiting and never folds several of them into the running turn.
 *
 * Run with: `node --test tests/share-queue.test.js`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createShareQueues, SHARE_QUEUE_TEXT_LIMIT } from '../src/share-queue.js'

/**
 * A session the test drives by hand.
 *
 * The queue opens a follower of the session when the first message is queued,
 * and the test hands the frames of the session to it one by one.
 */
function createSession() {
  const frames = []
  let wake = null
  let opens = 0
  let aborts = 0

  /**
   * Let the follower go on.
   */
  const kick = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }

  /**
   * Hand one frame to the follower.
   *
   * @param {any} frame
   */
  const push = (frame) => {
    frames.push(frame)
    kick()
  }

  /**
   * The follower of the queue.
   *
   * @param {any} request
   * @param {AbortSignal} signal
   */
  const follow = async (request, signal) => {
    opens += 1
    signal.addEventListener('abort', () => {
      aborts += 1
      kick()
    }, { once: true })
    return (async function* () {
      while (!signal.aborted) {
        if (frames.length > 0) {
          yield frames.shift()
          continue
        }
        await new Promise((resolve) => { wake = resolve })
      }
    })()
  }

  return { follow, push, opens: () => opens, aborts: () => aborts }
}

/**
 * A frame that opens a turn.
 *
 * @param {number} turn
 * @returns {any}
 */
function turnStart(turn) {
  return {
    type: 'event',
    event: { type: 'turn/start', seq: turn * 10, time: turn * 10, data: { turn } },
  }
}

/**
 * A frame that closes a turn.
 *
 * @param {number} turn
 * @returns {any}
 */
function turnEnd(turn) {
  return {
    type: 'event',
    event: { type: 'turn/end', seq: turn * 10 + 5, time: turn * 10 + 5, data: { turn, reason: 'done' } },
  }
}

/**
 * A frame that carries the words of a guest into the log.
 *
 * The Host writes the words of a message into the log when it takes the
 * message, and that is how the queue knows that the message is not waiting in
 * the Host any more.
 *
 * @param {string} text the words of the guest
 * @returns {any}
 */
function recorded(text) {
  return {
    type: 'event',
    event: {
      type: 'user/message',
      seq: 100,
      time: 100,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    },
  }
}

/**
 * A frame that carries the whole log.
 *
 * The follower of a session always opens with such a frame, and the queue
 * reads the turns out of it before it says anything.
 *
 * @param {any[]} frames the frames of the log
 * @returns {any}
 */
function snapshot(frames) {
  return {
    type: 'snapshot',
    cursor: 1,
    records: frames.map((frame) => ({ type: 'event', event: frame.event })),
    hasMore: false,
  }
}

/**
 * Let the queue do what it has to do.
 *
 * @param {number} [times] how many turns of the event loop to wait
 */
async function settle(times = 10) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Wait until the queue has done what the test expects.
 *
 * @param {() => boolean} predicate
 * @param {string} message what the queue was to do
 */
async function until(predicate, message) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

test('a message that is queued while the agent is busy waits for the turn to end', async () => {
  const session = createSession()
  const prompts = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: () => {},
  })
  try {
    // The agent is working: the turn 1 started and has not ended.
    session.push(snapshot([turnStart(1)]))
    const queued = queues.enqueue(
      { id: 's_1', sessionId: 'session-1' },
      { text: 'Ada 的第一条：请总结一下当前的进展', from: 'Ada' },
    )
    assert.match(queued.id, /^q[0-9a-f]{8}$/, 'the message has a short id')
    assert.equal(queued.position, 1, 'the message is the first one in the queue')
    await settle()
    assert.equal(prompts.length, 0, 'the message is not handed over while the agent is busy')
    // The turn ends: the message goes to the Host.
    session.push(turnEnd(1))
    await until(() => prompts.length === 1, 'the message goes to the Host after the turn')
    assert.equal(prompts[0].text, 'Ada 的第一条：请总结一下当前的进展', 'the words arrive whole')
    // The Host writes the words into the log: the message is taken, and the
    // queue is empty again.
    session.push(recorded('Ada 的第一条：请总结一下当前的进展'))
    await until(() => queues.state('s_1') === undefined, 'the queue is empty again')
  } finally {
    queues.dispose()
  }
})

test('two messages are handed to the Host one after the other', async () => {
  const session = createSession()
  const prompts = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: () => {},
  })
  try {
    // The log is read first: the agent is idle and the session says so.
    session.push(snapshot([]))
    const share = { id: 's_2', sessionId: 'session-2' }
    queues.enqueue(share, { text: 'one' })
    const second = queues.enqueue(share, { text: 'two' })
    assert.equal(second.position, 2, 'the second message waits behind the first')
    await until(() => prompts.length === 1, 'the first message goes to the Host')
    assert.equal(prompts[0].text, 'one')
    // The agent takes the first message: the second one still waits.
    session.push(turnStart(1))
    session.push(recorded('one'))
    await until(() => queues.state('s_2')?.working?.text === 'one', 'the first message is worked on')
    await settle()
    assert.equal(prompts.length, 1, 'the second message waits for the turn to end')
    // The turn ends: the second message goes to the Host.
    session.push(turnEnd(1))
    await until(() => prompts.length === 2, 'the second message goes to the Host')
    assert.equal(prompts[1].text, 'two')
  } finally {
    queues.dispose()
  }
})

test('the frame of the queue tells the guests what waits', async () => {
  const session = createSession()
  const changes = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async () => {},
    onChange: (shareId, frame) => changes.push({ shareId, frame }),
    now: () => 1000,
  })
  try {
    session.push(snapshot([]))
    const share = { id: 's_3', sessionId: 'session-3' }
    const queued = queues.enqueue(share, { text: 'hello', from: 'Ada' })
    const first = changes.at(-1)
    assert.equal(first.shareId, 's_3', 'the frame belongs to the share')
    assert.equal(first.frame.kind, 'queue')
    assert.equal(first.frame.working, null, 'nothing is worked on yet')
    assert.equal(first.frame.waiting.length, 1)
    assert.equal(first.frame.waiting[0].id, queued.id, 'the message carries the id the guest was given')
    assert.equal(first.frame.waiting[0].text, 'hello')
    assert.equal(first.frame.waiting[0].from, 'Ada')
    assert.equal(first.frame.waiting[0].at, 1000)
    assert.deepEqual(queues.state('s_3'), first.frame, 'the state of the queue is the same frame')
    // The message is worked on: the frame says so.
    await until(() => queues.state('s_3')?.working !== null, 'the message is worked on')
    const working = queues.state('s_3')
    assert.equal(working.working.id, queued.id)
    assert.equal(working.working.text, 'hello')
    assert.equal(working.waiting.length, 0, 'the message left the waiting list')
  } finally {
    queues.dispose()
  }
})

test('a message the agent never takes is dropped and the queue moves on', async () => {
  const session = createSession()
  const prompts = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: () => {},
    takeTimeout: 40,
  })
  try {
    session.push(snapshot([]))
    const share = { id: 's_4', sessionId: 'session-4' }
    queues.enqueue(share, { text: 'one' })
    queues.enqueue(share, { text: 'two' })
    await until(() => prompts.length === 1, 'the first message goes to the Host')
    // The agent never takes it: the queue gives up on it and moves on.
    await until(() => prompts.length === 2, 'the queue moves on to the second message')
    assert.equal(prompts[0].text, 'one')
    assert.equal(prompts[1].text, 'two')
    const frame = queues.state('s_4')
    assert.equal(frame.working.text, 'two', 'the second message is the one that is worked on')
    assert.equal(frame.waiting.length, 0, 'the message that was dropped left the queue')
  } finally {
    queues.dispose()
  }
})

test('the text of a message is cut for the guests and whole for the Host', async () => {
  const session = createSession()
  const prompts = []
  const changes = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: (shareId, frame) => changes.push(frame),
  })
  try {
    session.push(snapshot([]))
    const words = 'x'.repeat(SHARE_QUEUE_TEXT_LIMIT + 100)
    queues.enqueue({ id: 's_5', sessionId: 'session-5' }, { text: words })
    const shown = changes.at(-1).waiting[0].text
    assert.equal(shown.length, SHARE_QUEUE_TEXT_LIMIT + 1, 'the text is cut and says so')
    assert.match(shown, /…$/, 'the cut is marked')
    await until(() => prompts.length === 1, 'the message goes to the Host')
    assert.equal(prompts[0].text, words, 'the Host gets the whole message')
  } finally {
    queues.dispose()
  }
})

test('dispose() stops the watchers', async () => {
  const session = createSession()
  const prompts = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: () => {},
  })
  const share = { id: 's_6', sessionId: 'session-6' }
  session.push(snapshot([]))
  queues.enqueue(share, { text: 'one' })
  await until(() => session.opens() === 1, 'the queue follows the session')
  queues.dispose()
  await until(() => session.aborts() === 1, 'the follower of the session is closed')
  assert.equal(queues.state('s_6'), undefined, 'the queue is gone')
  const delivered = prompts.length
  await settle()
  assert.equal(prompts.length, delivered, 'no message goes to the Host after the queue is gone')
})

test('drop() forgets the queue of a share', async () => {
  const session = createSession()
  const prompts = []
  const changes = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: (shareId, frame) => changes.push({ shareId, frame }),
  })
  try {
    const share = { id: 's_7', sessionId: 'session-7' }
    session.push(snapshot([]))
    queues.enqueue(share, { text: 'one' })
    queues.enqueue(share, { text: 'two' })
    await until(() => session.opens() === 1, 'the queue follows the session')
    queues.drop('s_7')
    const last = changes.at(-1)
    assert.equal(last.shareId, 's_7')
    assert.deepEqual(last.frame, { kind: 'queue', working: null, waiting: [] }, 'the guests see an empty queue')
    assert.equal(queues.state('s_7'), undefined, 'the queue is gone')
    await until(() => session.aborts() === 1, 'the follower of the session is closed')
    const delivered = prompts.length
    await settle()
    assert.equal(prompts.length, delivered, 'the messages that wait are not said to the agent')
  } finally {
    queues.dispose()
  }
})

test('a message of the owner does not pass for the message of a guest', async () => {
  const session = createSession()
  const prompts = []
  const queues = createShareQueues({
    follow: session.follow,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: () => {},
    takeTimeout: 60,
  })
  try {
    session.push(snapshot([]))
    const share = { id: 's_8', sessionId: 'session-8' }
    queues.enqueue(share, { text: 'mine' })
    queues.enqueue(share, { text: 'the next one' })
    await until(() => prompts.length === 1, 'the first message goes to the Host')
    // The owner sends a message of its own and the Host takes that one first:
    // the turn that ends is not the turn that took our message.
    session.push(turnStart(1))
    session.push(recorded('a word of the owner'))
    session.push(turnEnd(1))
    await settle(20)
    assert.equal(prompts.length, 1, 'the second message waits: the first one is not taken yet')
    // The Host takes our message: the second one goes out.
    session.push(turnStart(2))
    session.push(recorded('mine'))
    session.push(turnEnd(2))
    await until(() => prompts.length === 2, 'the second message goes to the Host')
    assert.equal(prompts[1].text, 'the next one')
  } finally {
    queues.dispose()
  }
})

test('the message goes to the Host when the session cannot be followed', async () => {
  const prompts = []
  const queues = createShareQueues({
    // A Host that does not answer the follower: the queue may not wait for
    // ever, and the message is worth more than the state of the agent.
    follow: async () => undefined,
    prompt: async (share, item) => { prompts.push(item) },
    onChange: () => {},
  })
  try {
    queues.enqueue({ id: 's_9', sessionId: 'session-9' }, { text: 'hello' })
    await until(() => prompts.length === 1, 'the message goes to the Host')
    assert.equal(prompts[0].text, 'hello')
  } finally {
    queues.dispose()
  }
})
