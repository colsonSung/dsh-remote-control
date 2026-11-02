/**
 * The room of one shared conversation.
 *
 * A share is a room: the guests are in it together, each of them may have a
 * file open, and at most one of them may hold a file for editing. The room
 * keeps the guests, the locks and the sinks of the open event streams, and
 * it hands every change to all of them.
 *
 * The room lives in the Host: the Host serves the event stream of every
 * guest, so it is already the one place where the guests of a share meet.
 */

/**
 * One guest of a room.
 *
 * @typedef {object} RoomGuest
 * @property {string} id the guest's own id, chosen by the guest
 * @property {string} name the name the guest shows
 * @property {string} file the file the guest has open, if any
 * @property {boolean} editing whether the guest holds the file for editing
 * @property {number} since when the guest joined, in milliseconds
 */

/**
 * @param {string} shareId
 * @returns {{ id: string, guests: Map<string, RoomGuest>, sinks: Set<(frame: string) => void>, locks: Map<string, string> }}
 */
function createRoom(shareId) {
  return { id: shareId, guests: new Map(), sinks: new Set(), locks: new Map() }
}

/**
 * The rooms of every share.
 *
 * @returns {{ room: (shareId: string) => any, drop: (shareId: string) => void, size: () => number }}
 */
export function createShareRooms() {
  /** @type {Map<string, ReturnType<typeof createRoom>>} */
  const rooms = new Map()

  const room = (shareId) => {
    let found = rooms.get(shareId)
    if (found === undefined) {
      found = createRoom(shareId)
      rooms.set(shareId, found)
    }
    return found
  }

  /**
   * The view of a room that goes to the guests.
   *
   * @param {ReturnType<typeof createRoom>} room
   * @returns {{ guests: RoomGuest[], locks: { path: string, guest: string }[] }}
   */
  const view = (room) => ({
    guests: [...room.guests.values()].map((guest) => ({
      id: guest.id,
      name: guest.name,
      file: guest.file,
      editing: guest.editing,
      since: guest.since,
      seen: guest.seen,
    })),
    locks: [...room.locks.entries()].map(([path, guest]) => ({ path, guest })),
  })

  /**
   * Hand one frame to every guest of the room.
   *
   * @param {ReturnType<typeof createRoom>} room
   * @param {any} frame
   */
  const broadcast = (room, frame) => {
    if (room.sinks.size === 0) return
    const line = `data: ${JSON.stringify(frame)}\n\n`
    for (const sink of room.sinks) {
      try {
        sink(line)
      } catch (error) {
        // A guest that is gone takes its sink with it; the others carry on.
      }
    }
  }

  return {
    room,

    /**
     * Forget the guests that stopped saying anything.
     *
     * A guest that closes its tab cannot say goodbye, so the room keeps a
     * time on every guest and frees what a silent guest held.
     *
     * @param {string} shareId
     * @param {number} olderThan how long a guest may be silent, in milliseconds
     * @returns {number} how many guests were forgotten
     */
    sweep(shareId, olderThan) {
      const found = room(shareId)
      const now = Date.now()
      let forgotten = 0
      for (const [id, guest] of found.guests) {
        if (now - guest.seen < olderThan) continue
        if (guest.editing && found.locks.get(guest.file) === id) found.locks.delete(guest.file)
        found.guests.delete(id)
        forgotten += 1
      }
      if (forgotten > 0) broadcast(found, { kind: 'presence', ...view(found) })
      if (found.guests.size === 0 && found.sinks.size === 0) rooms.delete(shareId)
      return forgotten
    },

    /**
     * A guest joins the room.
     *
     * @param {string} shareId
     * @param {{ id: string, name?: string }} guest
     * @returns {RoomGuest}
     */
    join(shareId, guest) {
      const found = room(shareId)
      const id = String(guest.id ?? '').slice(0, 64)
      const name = String(guest.name ?? '').trim().slice(0, 40)
      const entry = found.guests.get(id)
      if (entry === undefined) {
        found.guests.set(id, {
          id,
          name: name.length > 0 ? name : `guest-${id.slice(0, 4)}`,
          file: '',
          editing: false,
          since: Date.now(),
          seen: Date.now(),
        })
      } else if (name.length > 0) {
        entry.name = name
      }
      return found.guests.get(id)
    },

    /**
     * A guest says what it is looking at.
     *
     * @param {string} shareId
     * @param {string} guestId
     * @param {{ file?: string, editing?: boolean, name?: string }} patch
     * @returns {RoomGuest | undefined}
     */
    update(shareId, guestId, patch) {
      const found = room(shareId)
      const entry = found.guests.get(guestId)
      if (entry === undefined) return undefined
      if (typeof patch.name === 'string' && patch.name.trim().length > 0) {
        entry.name = patch.name.trim().slice(0, 40)
      }
      if (typeof patch.file === 'string') {
        const file = patch.file.slice(0, 512)
        if (file !== entry.file) {
          // A guest that lets a file go does not hold it any more.
          if (entry.editing && found.locks.get(entry.file) === guestId) found.locks.delete(entry.file)
          entry.file = file
          entry.editing = false
        }
      }
      if (typeof patch.editing === 'boolean') {
        entry.editing = patch.editing === true && entry.file.length > 0
      }
      entry.seen = Date.now()
      return entry
    },

    /**
     * A guest leaves the room.
     *
     * @param {string} shareId
     * @param {string} guestId
     */
    leave(shareId, guestId) {
      const found = room(shareId)
      const entry = found.guests.get(guestId)
      if (entry === undefined) return
      if (entry.editing && found.locks.get(entry.file) === guestId) found.locks.delete(entry.file)
      found.guests.delete(guestId)
      if (found.guests.size === 0 && found.sinks.size === 0) {
        rooms.delete(shareId)
        return
      }
      broadcast(found, { kind: 'presence', ...view(found) })
    },

    /**
     * The room as the guests see it.
     *
     * @param {string} shareId
     * @returns {{ guests: RoomGuest[], locks: { path: string, guest: string }[] }}
     */
    view(shareId) {
      return view(room(shareId))
    },

    /**
     * Hand a frame to every guest of the room.
     *
     * @param {string} shareId
     * @param {any} frame
     */
    broadcast(shareId, frame) {
      broadcast(room(shareId), frame)
    },

    /**
     * A guest takes a file for editing.
     *
     * @param {string} shareId
     * @param {string} guestId
     * @param {string} path
     * @returns {{ ok: true } | { ok: false, guest: string }}
     */
    lock(shareId, guestId, path) {
      const found = room(shareId)
      const holder = found.locks.get(path)
      if (holder !== undefined && holder !== guestId) {
        const other = found.guests.get(holder)
        return { ok: false, guest: other === undefined ? holder : other.name }
      }
      found.locks.set(path, guestId)
      const entry = found.guests.get(guestId)
      if (entry !== undefined) {
        entry.file = path
        entry.editing = true
      }
      return { ok: true }
    },

    /**
     * A guest lets a file go.
     *
     * @param {string} shareId
     * @param {string} guestId
     * @param {string} path
     */
    unlock(shareId, guestId, path) {
      const found = room(shareId)
      if (found.locks.get(path) === guestId) found.locks.delete(path)
      const entry = found.guests.get(guestId)
      if (entry !== undefined && entry.file === path) entry.editing = false
    },

    /**
     * Which guest holds a file for editing.
     *
     * @param {string} shareId
     * @param {string} path
     * @returns {string | undefined} the id of the holder
     */
    holderId(shareId, path) {
      return room(shareId).locks.get(path)
    },

    /**
     * Who holds a file for editing.
     *
     * @param {string} shareId
     * @param {string} path
     * @returns {string | undefined} the name of the holder
     */
    holder(shareId, path) {
      const found = room(shareId)
      const guestId = found.locks.get(path)
      if (guestId === undefined) return undefined
      const entry = found.guests.get(guestId)
      return entry === undefined ? undefined : entry.name
    },

    /**
     * Listen to the room.
     *
     * @param {string} shareId
     * @param {(line: string) => void} sink receives the frames of the room
     * @returns {() => void} the way to stop listening
     */
    subscribe(shareId, sink) {
      const found = room(shareId)
      found.sinks.add(sink)
      return () => {
        found.sinks.delete(sink)
        if (found.guests.size === 0 && found.sinks.size === 0) rooms.delete(shareId)
      }
    },

    /**
     * Forget a share that is gone.
     *
     * @param {string} shareId
     */
    drop(shareId) {
      rooms.delete(shareId)
    },

    size() {
      return rooms.size
    },
  }
}
