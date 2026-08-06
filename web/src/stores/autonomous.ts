import { create } from 'zustand';
import { apiFetch } from '../api/client';

interface AutonomousState {
  /** per-chat cache of "is this chat in autonomous mode" */
  chatEnabled: Record<string, boolean>;
  /** admin-only: all chats with autonomous enabled */
  allEnabled: Record<string, boolean>;
  loading: boolean;
  error: string | null;

  loadChat: (chatJid: string) => Promise<void>;
  toggleChat: (chatJid: string, enabled: boolean) => Promise<boolean>;
  loadAll: () => Promise<void>;
}

export const useAutonomousStore = create<AutonomousState>((set) => ({
  chatEnabled: {},
  allEnabled: {},
  loading: false,
  error: null,

  loadChat: async (chatJid) => {
    try {
      const data = await apiFetch<{ chat_jid: string; enabled: boolean }>(
        `/api/config/autonomous?chat_jid=${encodeURIComponent(chatJid)}`,
      );
      set((s) => ({ chatEnabled: { ...s.chatEnabled, [chatJid]: data.enabled } }));
    } catch (err) {
      // default off
      set((s) => ({ chatEnabled: { ...s.chatEnabled, [chatJid]: false } }));
      void err;
    }
  },

  toggleChat: async (chatJid, enabled) => {
    try {
      await apiFetch('/api/config/autonomous', {
        method: 'PUT',
        body: JSON.stringify({ chat_jid: chatJid, enabled }),
      });
      set((s) => ({ chatEnabled: { ...s.chatEnabled, [chatJid]: enabled } }));
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Toggle failed' });
      return false;
    }
  },

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch<{ groups: Record<string, boolean> }>(
        '/api/config/autonomous/all',
      );
      set({ allEnabled: data.groups || {}, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Load failed' });
    }
  },
}));
