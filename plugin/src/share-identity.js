/**
 * The identity of a guest of a share.
 *
 * A guest of a shared conversation is a person: the owner of the conversation
 * sees who is in the room and who is writing, and a person is told apart by a
 * name and a colour, not by an id.
 *
 * The colour of a guest is the same everywhere it is shown: the dot of the
 * guest in the room, the cursor of the guest in a document it edits together
 * with the others, and the face of the guest in the header of the owner. One
 * guest therefore looks the same in all of them.
 *
 * The palette is written here and nowhere else: the page of the guest carries
 * it into the browser, because the browser half of the page cannot import a
 * module of the Host.
 */

/**
 * The colours of the guests.
 *
 * The colours are dark enough to carry white text on them, and they are far
 * enough apart to tell two guests apart at a glance.
 */
export const GUEST_COLORS = [
  '#4176e6',
  '#7a3fb8',
  '#1a7f45',
  '#b5561a',
  '#0f8a8a',
  '#c0392b',
]

/**
 * The colour of one guest.
 *
 * The colour follows the id of the guest, so it is the same in every window
 * and on every device the guest opens.
 *
 * @param {string} id
 * @returns {string} the colour, as the page writes it
 */
export function guestColor(id) {
  const text = String(id ?? '')
  let sum = 0
  for (let index = 0; index < text.length; index += 1) sum += text.charCodeAt(index)
  return GUEST_COLORS[sum % GUEST_COLORS.length]
}

/**
 * The letter that stands for one guest.
 *
 * A guest without a name still gets a face: the sign of a question mark is
 * better than an empty circle.
 *
 * @param {string} name
 * @returns {string} one character
 */
export function guestInitial(name) {
  const text = String(name ?? '').trim()
  if (text.length === 0) return '?'
  return text.slice(0, 1).toUpperCase()
}
