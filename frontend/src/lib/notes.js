// Shared notes per exercise — "V-handle, seat on 4" — written once and seen by the whole team.
//
// Kept out of the profile's state blob on purpose: the note is about the equipment, so it
// belongs to everyone, and a copy synced into one person's backup would go stale the moment
// someone else corrected it. This is a small live cache of the team's notes instead.
import { create } from 'zustand'
import { api } from './api.js'
import { teamsAvailable } from './team-api.js'
import { useStore } from '../store/useStore.js'

export const useNotes = create((set, get) => ({
  notes: {},
  loaded: false,
  async load() {
    if (!teamsAvailable(useStore.getState().user)) return
    try { set({ notes: (await api('/api/team/notes')).notes || {}, loaded: true }) }
    catch { /* offline — keep whatever is on screen */ }
  },
  async save(exId, text) {
    const { notes } = await api('/api/team/notes', { method: 'POST', body: JSON.stringify({ exId, text }) })
    set({ notes: notes || {} })
  }
}))

/** Whether notes can be shown at all: they live on the server, so guests have none. */
export const notesAvailable = () => teamsAvailable(useStore.getState().user)
