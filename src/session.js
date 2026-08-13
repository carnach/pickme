import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const ICONS = ['🐵', '🦊', '🐼', '🐸', '🐧', '🐙', '🦄', '🐝', '🦋', '🐳'];
const DEVICE_KEY_STORAGE = 'pickme:device-key';
const DEVICE_ICON_STORAGE = 'pickme:device-icon';
const SESSION_STORAGE = 'pickme:session';
const HOST_WAIT_MS = 3000;
const HOST_PROBE_MS = 800;
const MAX_PASSCODE_ATTEMPTS = 5;
const IDLE_ROUND_STATE = { status: 'idle', mode: 'F', winnerCount: 1, startedAt: null, result: null };

let client = null;

export function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return null;
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  }
  return client;
}

function randomId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function getDeviceIdentity() {
  let deviceKey = sessionStorage.getItem(DEVICE_KEY_STORAGE);
  if (!deviceKey) {
    deviceKey = randomId();
    sessionStorage.setItem(DEVICE_KEY_STORAGE, deviceKey);
  }

  let icon = sessionStorage.getItem(DEVICE_ICON_STORAGE);
  if (!icon) {
    icon = ICONS[Math.floor(Math.random() * ICONS.length)];
    sessionStorage.setItem(DEVICE_ICON_STORAGE, icon);
  }

  return { deviceKey, icon };
}

function randomPasscode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function channelName(passcode) {
  return `pickme-session-${passcode}`;
}

function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredSession(value) {
  if (value) {
    sessionStorage.setItem(SESSION_STORAGE, JSON.stringify(value));
  } else {
    sessionStorage.removeItem(SESSION_STORAGE);
  }
}

function cleanPresenceEntry(entry) {
  const { presence_ref: _ref, ...rest } = entry;
  return rest;
}

function presenceStateToParticipants(state) {
  const participants = new Map();
  Object.entries(state).forEach(([key, metas]) => {
    if (!metas.length) return;
    participants.set(key, cleanPresenceEntry(metas[metas.length - 1]));
  });
  return participants;
}

export function useSession() {
  const { deviceKey, icon } = useMemo(() => getDeviceIdentity(), []);
  const [status, setStatus] = useState('idle');
  const [role, setRole] = useState(null);
  const [passcode, setPasscode] = useState(null);
  const [participants, setParticipants] = useState(() => new Map());
  const [error, setError] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);

  const channelRef = useRef(null);
  const roleRef = useRef(null);
  const hostSeenRef = useRef(false);
  const localFingerIdsRef = useRef([]);
  const roundStateRef = useRef(null);
  const joinTimeoutRef = useRef(null);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  const handleConnectionStatus = useCallback((subStatus) => {
    setReconnecting(subStatus !== 'SUBSCRIBED');
  }, []);

  const teardownChannel = useCallback(() => {
    if (joinTimeoutRef.current) {
      window.clearTimeout(joinTimeoutRef.current);
      joinTimeoutRef.current = null;
    }
    const supabase = getSupabaseClient();
    if (channelRef.current && supabase) {
      supabase.removeChannel(channelRef.current);
    }
    channelRef.current = null;
    hostSeenRef.current = false;
  }, []);

  const resetToIdle = useCallback((nextError = null) => {
    teardownChannel();
    setStatus('idle');
    setRole(null);
    setPasscode(null);
    setParticipants(new Map());
    setError(nextError);
    roundStateRef.current = null;
    writeStoredSession(null);
  }, [teardownChannel]);

  const trackSelf = useCallback((overrides = {}) => {
    const channel = channelRef.current;
    if (!channel) return;
    channel.track({
      deviceKey,
      icon,
      role: roleRef.current,
      fingerIds: localFingerIdsRef.current,
      roundState: roleRef.current === 'host' ? roundStateRef.current : null,
      ...overrides,
    });
  }, [deviceKey, icon]);

  const attachPresenceHandlers = useCallback((channel, { onHostSeen, onHostLeft } = {}) => {
    // Presence diffs represent a metadata *update* (e.g. our own finger-touch
    // track() calls) as "leave old meta + join new meta" for the SAME key.
    // Raw 'leave' events are therefore not a reliable "someone actually left"
    // signal. Instead, compare the fully-reconciled participant set between
    // syncs: the host is only considered gone once it's absent from an
    // actual sync snapshot, not from a transient per-update leave diff.
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const nextParticipants = presenceStateToParticipants(state);
      setParticipants(nextParticipants);

      const hasHost = Array.from(nextParticipants.values()).some((p) => p.role === 'host');
      const previouslySeen = hostSeenRef.current;

      if (hasHost) {
        hostSeenRef.current = true;
        if (!previouslySeen) {
          onHostSeen?.();
        }
      } else if (previouslySeen) {
        hostSeenRef.current = false;
        onHostLeft?.();
      }
    });
  }, []);

  const startSession = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setError('unavailable');
      return;
    }

    teardownChannel();
    setStatus('connecting');
    setError(null);

    for (let attempt = 0; attempt < MAX_PASSCODE_ATTEMPTS; attempt += 1) {
      const code = randomPasscode();
      const channel = supabase.channel(channelName(code), {
        config: { presence: { key: deviceKey } },
      });

      // All presence listeners (permanent + this one-time probe) must be
      // registered before subscribe() — Supabase rejects .on() calls made
      // after a channel has already subscribed.
      attachPresenceHandlers(channel, {});

      // eslint-disable-next-line no-await-in-loop
      const hostExists = await new Promise((resolve) => {
        let settled = false;
        channel.on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState();
          const foundHost = Object.entries(state).some(
            ([key, metas]) => key !== deviceKey && metas.some((m) => m.role === 'host')
          );
          if (foundHost && !settled) {
            settled = true;
            resolve(true);
          }
        });
        channel.subscribe((subStatus) => {
          handleConnectionStatus(subStatus);
          if (subStatus === 'SUBSCRIBED') {
            window.setTimeout(() => {
              if (!settled) {
                settled = true;
                resolve(false);
              }
            }, HOST_PROBE_MS);
          }
        });
      });

      if (!hostExists) {
        roleRef.current = 'host';
        channelRef.current = channel;
        hostSeenRef.current = true;
        roundStateRef.current = { ...IDLE_ROUND_STATE };

        setRole('host');
        setPasscode(code);
        setStatus('connected');
        writeStoredSession({ passcode: code, role: 'host' });
        return;
      }

      supabase.removeChannel(channel);
    }

    setStatus('error');
    setError('start-failed');
  }, [attachPresenceHandlers, deviceKey, handleConnectionStatus, teardownChannel]);

  const joinSession = useCallback((code) => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setError('unavailable');
      return;
    }
    if (!/^\d{4}$/.test(code)) {
      setError('invalid-code');
      return;
    }

    teardownChannel();
    setStatus('connecting');
    setError(null);
    roleRef.current = 'guest';
    hostSeenRef.current = false;

    const channel = supabase.channel(channelName(code), {
      config: { presence: { key: deviceKey } },
    });
    channelRef.current = channel;

    attachPresenceHandlers(channel, {
      onHostSeen: () => {
        if (joinTimeoutRef.current) {
          window.clearTimeout(joinTimeoutRef.current);
          joinTimeoutRef.current = null;
        }
        setRole('guest');
        setPasscode(code);
        setStatus('connected');
        writeStoredSession({ passcode: code, role: 'guest' });
      },
      onHostLeft: () => {
        resetToIdle('host-left');
      },
    });

    channel.subscribe((subStatus) => {
      handleConnectionStatus(subStatus);
      if (subStatus !== 'SUBSCRIBED') return;
      joinTimeoutRef.current = window.setTimeout(() => {
        if (!hostSeenRef.current) {
          resetToIdle('not-found');
        }
      }, HOST_WAIT_MS);
    });
  }, [attachPresenceHandlers, deviceKey, handleConnectionStatus, resetToIdle, teardownChannel]);

  const resumeAsHost = useCallback((code) => {
    const supabase = getSupabaseClient();
    if (!supabase) return;

    teardownChannel();
    setStatus('connecting');
    roleRef.current = 'host';
    hostSeenRef.current = true;
    roundStateRef.current = { ...IDLE_ROUND_STATE };

    const channel = supabase.channel(channelName(code), {
      config: { presence: { key: deviceKey } },
    });
    channelRef.current = channel;
    attachPresenceHandlers(channel, {});

    channel.subscribe((subStatus) => {
      handleConnectionStatus(subStatus);
      if (subStatus === 'SUBSCRIBED') {
        setRole('host');
        setPasscode(code);
        setStatus('connected');
        writeStoredSession({ passcode: code, role: 'host' });
      }
    });
  }, [attachPresenceHandlers, deviceKey, handleConnectionStatus, teardownChannel]);

  const leaveSession = useCallback(() => {
    resetToIdle(null);
  }, [resetToIdle]);

  // Coalesced into one presence update per call — a finger change and a
  // round-state change often happen in the same render (e.g. a round
  // finishing clears local fingers *and* publishes the result at once), and
  // Supabase enforces a per-client presence rate limit that two independent
  // track() calls for the same instant can trip.
  const publishState = useCallback(({ fingerIds, roundState } = {}) => {
    if (fingerIds !== undefined) {
      localFingerIdsRef.current = fingerIds;
    }
    if (roundState !== undefined && roleRef.current === 'host') {
      roundStateRef.current = roundState;
    }
    trackSelf();
  }, [trackSelf]);

  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) return;
    if (stored.role === 'guest') {
      joinSession(stored.passcode);
    } else if (stored.role === 'host') {
      resumeAsHost(stored.passcode);
    }
    // Only ever attempt a resume once, on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => teardownChannel(), [teardownChannel]);

  useEffect(() => {
    if (status !== 'connected') {
      setReconnecting(false);
    }
  }, [status]);

  return {
    active: status === 'connected',
    status,
    role,
    passcode,
    ownIcon: icon,
    deviceKey,
    participants,
    error,
    reconnecting,
    startSession,
    joinSession,
    leaveSession,
    publishState,
  };
}
