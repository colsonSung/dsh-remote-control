/**
 * The browser entry of the collaborative editor.
 *
 * The guest page has no build step and no module loader, so the library
 * travels as one file that sets a global. This entry is what the bundle is
 * built from: the document and the awareness (the cursors) that go with it.
 */

import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'

export { Y, Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates }
