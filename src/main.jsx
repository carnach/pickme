import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { createRoot } from 'react-dom/client';
import { toDataURL as qrToDataURL } from 'qrcode';
import { useSession } from './session.js';
import './styles.css';

const APP_URL = 'https://pickme.mnky.uk/';
const CONTROL_SIZE = 96;
const ROUND_MS = 3000;
const FINGER_SELECTION_BOUNDS = { min: 1, max: 10 };
const GROUP_SELECTION_BOUNDS = { min: 2, max: 5 };
const NUMBER_STEP_DISTANCE = 78;
const MODE_TOGGLE_DISTANCE = 84;
const MODE_TOGGLE_HYSTERESIS = 22;
const GROUP_COLORS = ['#22c55e', '#f97316', '#38bdf8', '#e879f9', '#fde047', '#a78bfa', '#fb7185', '#14b8a6'];
const FINGER_COLORS = ['#f97316', '#22c55e', '#38bdf8', '#e879f9', '#fde047', '#a78bfa', '#fb7185', '#14b8a6', '#f43f5e', '#84cc16'];
const HELP_PAGE_ORDER = ['share', 'session', 'instructions', 'install'];
const HELP_PAGE_LABEL = {
  share: 'Share PickMe',
  instructions: 'Back to PickMe help',
  install: 'Home Screen help',
  session: 'Play together',
};
const HELP_DIALOG_LABEL = {
  share: 'Share PickMe',
  instructions: 'PickMe help',
  install: 'Save PickMe to your Home Screen',
  session: 'Play together across phones',
};
const SESSION_ERROR_MESSAGE = {
  'not-found': 'Session not found. Check the code.',
  'host-left': 'Host left — session ended.',
  'start-failed': "Couldn't start a session. Try again.",
  'invalid-code': 'Enter a 4-digit code.',
  unavailable: "Shared sessions aren't configured for this app.",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function selectionBounds(mode) {
  return mode === 'G' ? GROUP_SELECTION_BOUNDS : FINGER_SELECTION_BOUNDS;
}

function clampSelectionCount(value, mode) {
  const { min, max } = selectionBounds(mode);
  return clamp(value, min, max);
}

function isTopLeft(point) {
  return point.clientX <= CONTROL_SIZE && point.clientY <= CONTROL_SIZE;
}

function isTopRight(point) {
  return window.innerWidth - point.clientX <= CONTROL_SIZE && point.clientY <= CONTROL_SIZE;
}

function randomPick(items, count) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled.slice(0, count);
}

function createGroups(items, groupCount) {
  const count = Math.min(groupCount, items.length);
  const groups = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    fingers: [],
  }));

  randomPick(items, items.length).forEach((finger, index) => {
    groups[index % count].fingers.push(finger);
  });

  return groups;
}

function nextFingerLabel(fingers) {
  const used = new Set(fingers.map((finger) => finger.label).filter(Boolean));

  for (let label = 1; label <= FINGER_SELECTION_BOUNDS.max + 10; label += 1) {
    if (!used.has(label)) {
      return label;
    }
  }

  return used.size + 1;
}

function withFingerColors(winners) {
  return winners.map((winner) =>
    winner.label != null ? { ...winner, color: FINGER_COLORS[(winner.label - 1) % FINGER_COLORS.length] } : winner
  );
}

function byLabelThenRemote(a, b) {
  return (a.label ?? Infinity) - (b.label ?? Infinity);
}

function App() {
  const session = useSession();
  const [fingers, setFingers] = useState([]);
  const [winnerCount, setWinnerCount] = useState(1);
  const [mode, setMode] = useState('F');
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpPage, setHelpPage] = useState('instructions');
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [selection, setSelection] = useState(null);
  const [controlOffset, setControlOffset] = useState({ x: 0, y: 0 });
  const [roundStartedAt, setRoundStartedAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [codeDigits, setCodeDigits] = useState(['', '', '', '']);
  const controlPointerId = useRef(null);
  const startAdjustX = useRef(0);
  const startAdjustY = useRef(0);
  const startMode = useRef('F');
  const toggledThisDrag = useRef(false);
  const selectionRef = useRef(null);
  const helpSwipeStart = useRef(null);
  const codeBoxRefs = useRef([]);
  const participantsRef = useRef(session.participants);
  const fingersRef = useRef(fingers);
  const poolKeysRef = useRef(new Set());
  const roundSignatureRef = useRef(null);

  const activeFingers = useMemo(() => fingers.filter((finger) => finger.kind === 'pick'), [fingers]);
  const isAuthority = !session.active || session.role === 'host';

  const virtualPool = useMemo(() => {
    const local = activeFingers.map((finger) => ({ deviceKey: session.deviceKey, fingerId: String(finger.id) }));
    if (!session.active) {
      return local;
    }
    const remote = [];
    session.participants.forEach((participant, key) => {
      if (key === session.deviceKey) return;
      (participant.fingerIds || []).forEach((fingerId) => remote.push({ deviceKey: key, fingerId }));
    });
    return [...local, ...remote];
  }, [activeFingers, session.active, session.participants, session.deviceKey]);

  const remoteActiveFingers = useMemo(() => {
    if (!session.active) return [];
    const list = [];
    session.participants.forEach((participant, key) => {
      if (key === session.deviceKey) return;
      (participant.fingerIds || []).forEach((fingerId) => {
        list.push({ key: `${key}:${fingerId}`, icon: participant.icon });
      });
    });
    return list;
  }, [session.active, session.participants, session.deviceKey]);

  const allParticipantsTouching = useMemo(() => {
    if (!session.active) return true;
    if (session.participants.size === 0) return false;
    return Array.from(session.participants.values()).every((participant) => (participant.fingerIds || []).length > 0);
  }, [session.active, session.participants]);

  const localFingerIdSignature = useMemo(() => activeFingers.map((finger) => String(finger.id)).join(','), [activeFingers]);
  const progress = roundStartedAt ? clamp((now - roundStartedAt) / ROUND_MS, 0, 1) : 0;
  const nextHelpPage = HELP_PAGE_ORDER[(HELP_PAGE_ORDER.indexOf(helpPage) + 1) % HELP_PAGE_ORDER.length];

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    participantsRef.current = session.participants;
  }, [session.participants]);

  useEffect(() => {
    fingersRef.current = fingers;
  }, [fingers]);

  useEffect(() => {
    let animationFrame = 0;

    const tick = () => {
      setNow(Date.now());
      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!isAuthority) return;
    if (virtualPool.length > 1 && allParticipantsTouching && !selection) {
      setRoundStartedAt((startedAt) => startedAt ?? Date.now());
      return;
    }

    setRoundStartedAt(null);
  }, [isAuthority, virtualPool.length, allParticipantsTouching, selection]);

  useEffect(() => {
    const keys = new Set(virtualPool.map((entry) => `${entry.deviceKey}:${entry.fingerId}`));
    const prevKeys = poolKeysRef.current;
    const hasNewKey = [...keys].some((key) => !prevKeys.has(key));
    poolKeysRef.current = keys;

    if (isAuthority && hasNewKey && roundStartedAt && !selection) {
      setRoundStartedAt(Date.now());
    }
  }, [virtualPool, isAuthority, roundStartedAt, selection]);

  useEffect(() => {
    if (!isAuthority || !roundStartedAt || virtualPool.length < 2 || selection) {
      return;
    }

    const remaining = Math.max(0, ROUND_MS - (Date.now() - roundStartedAt));
    const timer = window.setTimeout(() => {
      const remoteEntries = [];
      participantsRef.current.forEach((participant, key) => {
        if (key === session.deviceKey) return;
        (participant.fingerIds || []).forEach((fingerId) => {
          remoteEntries.push({ deviceKey: key, fingerId, isLocal: false });
        });
      });

      setFingers((currentFingers) => {
        const localPickers = currentFingers.filter((finger) => finger.kind === 'pick');
        const localEntries = localPickers.map((finger) => ({
          deviceKey: session.deviceKey,
          fingerId: String(finger.id),
          isLocal: true,
          x: finger.x,
          y: finger.y,
          label: finger.label,
        }));
        const pool = [...localEntries, ...remoteEntries];
        const resolveEntry = (entry) =>
          entry.isLocal ? entry : { ...entry, icon: participantsRef.current.get(entry.deviceKey)?.icon ?? '❔' };

        if (mode === 'G') {
          const groups = createGroups(pool, winnerCount);
          setSelection({
            type: 'group',
            count: groups.length,
            total: pool.length,
            groups: groups.map((group) => ({ id: group.id, members: group.fingers.map(resolveEntry) })),
          });
        } else {
          const count = Math.min(winnerCount, pool.length);
          const winners = withFingerColors(randomPick(pool, count).map(resolveEntry)).sort(byLabelThenRemote);
          setSelection({ type: 'finger', count, total: pool.length, winners });
        }

        return [];
      });
      setRoundStartedAt(null);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [isAuthority, roundStartedAt, virtualPool.length, selection, winnerCount, mode, session.deviceKey]);

  useEffect(() => {
    if (!session.active) return;

    const fingerIds = localFingerIdSignature ? localFingerIdSignature.split(',') : [];

    if (!isAuthority) {
      session.publishState({ fingerIds });
      return;
    }

    const roundState = selection
      ? {
          status: 'result',
          mode,
          winnerCount,
          startedAt: null,
          result:
            selection.type === 'finger'
              ? { type: 'finger', winners: selection.winners.map(({ deviceKey, fingerId }) => ({ deviceKey, fingerId })) }
              : {
                  type: 'group',
                  groups: selection.groups.map((group) => ({
                    id: group.id,
                    members: group.members.map(({ deviceKey, fingerId }) => ({ deviceKey, fingerId })),
                  })),
                },
        }
      : roundStartedAt
      ? { status: 'counting', mode, winnerCount, startedAt: roundStartedAt, result: null }
      : { status: 'idle', mode, winnerCount, startedAt: null, result: null };

    session.publishState({ fingerIds, roundState });
  }, [isAuthority, session.active, session.publishState, localFingerIdSignature, selection, roundStartedAt, mode, winnerCount]);

  useEffect(() => {
    if (isAuthority) return;

    const host = Array.from(session.participants.values()).find((participant) => participant.role === 'host');
    const roundState = host?.roundState;
    if (!roundState) return;

    const signature = JSON.stringify(roundState);
    if (signature === roundSignatureRef.current) return;
    roundSignatureRef.current = signature;

    const resolveMirroredEntry = ({ deviceKey, fingerId }) => {
      if (deviceKey === session.deviceKey) {
        const finger = fingersRef.current.find((candidate) => String(candidate.id) === fingerId);
        if (finger) {
          return { deviceKey, fingerId, x: finger.x, y: finger.y, label: finger.label };
        }
        return { deviceKey, fingerId, icon: session.ownIcon };
      }
      const participant = session.participants.get(deviceKey);
      return { deviceKey, fingerId, icon: participant?.icon ?? '❔' };
    };

    if (roundState.status === 'counting') {
      setSelection(null);
      setRoundStartedAt(roundState.startedAt);
    } else if (roundState.status === 'result' && roundState.result) {
      setRoundStartedAt(null);
      if (roundState.result.type === 'finger') {
        setSelection({
          type: 'finger',
          count: roundState.result.winners.length,
          total: null,
          winners: withFingerColors(roundState.result.winners.map(resolveMirroredEntry)).sort(byLabelThenRemote),
        });
      } else {
        setSelection({
          type: 'group',
          count: roundState.result.groups.length,
          total: null,
          groups: roundState.result.groups.map((group) => ({
            id: group.id,
            members: group.members.map(resolveMirroredEntry),
          })),
        });
      }
    } else {
      setRoundStartedAt(null);
    }
  }, [isAuthority, session.participants, session.deviceKey, session.ownIcon]);

  useEffect(() => {
    // Skip in dev — a cached service worker would otherwise keep serving a
    // stale bundle from a prior local session regardless of new edits.
    if (import.meta.env.DEV) return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    qrToDataURL(APP_URL, { margin: 1, width: 220 })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const resetRound = () => {
    setFingers([]);
    setRoundStartedAt(null);
    setSelection(null);
  };

  const openHelp = () => {
    setHelpPage('instructions');
    setHelpOpen(true);
  };

  const closeHelp = () => {
    setHelpOpen(false);
    setHelpPage('instructions');
    setCopied(false);
  };

  const handleHelpPointerDown = (event) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    helpSwipeStart.current = {
      x: event.clientX,
      y: event.clientY,
    };
  };

  const navigateHelpFromSwipe = (event) => {
    if (!helpSwipeStart.current) {
      return false;
    }

    const horizontalDistance = event.clientX - helpSwipeStart.current.x;
    const verticalDistance = event.clientY - helpSwipeStart.current.y;

    if (Math.abs(horizontalDistance) < 56 || Math.abs(horizontalDistance) < Math.abs(verticalDistance) * 1.25) {
      return false;
    }

    helpSwipeStart.current = null;

    const currentIndex = HELP_PAGE_ORDER.indexOf(helpPage);
    const nextIndex = horizontalDistance < 0 ? currentIndex + 1 : currentIndex - 1;

    if (nextIndex < 0 || nextIndex >= HELP_PAGE_ORDER.length) {
      return false;
    }

    setHelpPage(HELP_PAGE_ORDER[nextIndex]);

    return true;
  };

  const handleHelpPointerMove = (event) => {
    event.stopPropagation();
    navigateHelpFromSwipe(event);
  };

  const handleHelpPointerUp = (event) => {
    event.stopPropagation();
    navigateHelpFromSwipe(event);
    helpSwipeStart.current = null;
  };

  const handleHelpPointerCancel = (event) => {
    event.stopPropagation();
    helpSwipeStart.current = null;
  };

  const copyAppUrl = async () => {
    try {
      await navigator.clipboard.writeText(APP_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const joinCodeValue = codeDigits.join('');

  const handleJoinSubmit = (event) => {
    event.preventDefault();
    session.joinSession(joinCodeValue);
  };

  const handleCodeDigitChange = (index, rawValue) => {
    const digit = rawValue.replace(/\D/g, '').slice(-1);
    setCodeDigits((current) => {
      const next = [...current];
      next[index] = digit;
      return next;
    });
    if (digit && index < codeDigits.length - 1) {
      codeBoxRefs.current[index + 1]?.focus();
    }
  };

  const handleCodeDigitKeyDown = (index, event) => {
    if (event.key === 'Backspace' && !codeDigits[index] && index > 0) {
      codeBoxRefs.current[index - 1]?.focus();
    }
  };

  const handleCodePaste = (event) => {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, codeDigits.length);
    if (!pasted) return;
    event.preventDefault();
    setCodeDigits((current) => {
      const next = [...current];
      for (let index = 0; index < next.length; index += 1) {
        next[index] = pasted[index] ?? '';
      }
      return next;
    });
    codeBoxRefs.current[Math.min(pasted.length, codeDigits.length - 1)]?.focus();
  };

  const updateFinger = (event, kind) => {
    setFingers((current) => {
      const existing = current.findIndex((finger) => finger.id === event.pointerId);
      if (existing === -1) {
        const point = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          kind,
          label: kind === 'pick' ? nextFingerLabel(current) : null,
        };

        return [...current, point];
      }

      const next = [...current];
      next[existing] = {
        ...next[existing],
        x: event.clientX,
        y: event.clientY,
        kind,
      };
      return next;
    });
  };

  const handlePointerDown = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);

    if (selectionRef.current) {
      resetRound();
    }

    if (isTopRight(event)) {
      openHelp();
      updateFinger(event, 'control');
      return;
    }

    if (isTopLeft(event)) {
      controlPointerId.current = event.pointerId;
      startAdjustX.current = event.clientX;
      startAdjustY.current = event.clientY;
      startMode.current = mode;
      toggledThisDrag.current = false;
      setWinnerCount(selectionBounds(mode).min);
      setAdjusting(true);
      updateFinger(event, 'control');
      return;
    }

    if (isAuthority) {
      setRoundStartedAt((startedAt) => (virtualPool.length >= 1 && allParticipantsTouching ? Date.now() : startedAt));
    }
    updateFinger(event, 'pick');
  };

  const handlePointerMove = (event) => {
    if (event.pointerId === controlPointerId.current) {
      const horizontalDistance = Math.max(0, event.clientX - startAdjustX.current);
      const distance = Math.max(0, event.clientY - startAdjustY.current);
      const shouldToggle = horizontalDistance >= MODE_TOGGLE_DISTANCE && horizontalDistance > distance * 0.8;
      const shouldReleaseToggle = horizontalDistance < MODE_TOGGLE_DISTANCE - MODE_TOGGLE_HYSTERESIS;
      const toggledMode = startMode.current === 'F' ? 'G' : 'F';
      const nextMode =
        (shouldToggle || toggledThisDrag.current) && !shouldReleaseToggle ? toggledMode : startMode.current;
      const count = clampSelectionCount(selectionBounds(nextMode).min + Math.floor(distance / NUMBER_STEP_DISTANCE), nextMode);

      setWinnerCount(count);
      if (shouldToggle && !toggledThisDrag.current) {
        setMode(nextMode);
        toggledThisDrag.current = true;
      } else if (shouldReleaseToggle && toggledThisDrag.current) {
        setMode(startMode.current);
        toggledThisDrag.current = false;
      }
      setControlOffset({
        x: Math.min(horizontalDistance, 96),
        y: Math.min(distance, 220),
      });
      updateFinger(event, 'control');
      return;
    }

    setFingers((current) =>
      current.map((finger) =>
        finger.id === event.pointerId ? { ...finger, x: event.clientX, y: event.clientY } : finger
      )
    );
  };

  const handlePointerEnd = (event) => {
    if (event.pointerId === controlPointerId.current) {
      controlPointerId.current = null;
      toggledThisDrag.current = false;
      setAdjusting(false);
      setControlOffset({ x: 0, y: 0 });
    }

    setFingers((current) => current.filter((finger) => finger.id !== event.pointerId));
  };

  const pulseDuration = `${1.8 - progress * 1.35}s`;
  const statusVariant = adjusting
    ? 'mode'
    : roundStartedAt
    ? 'countdown'
    : session.active && virtualPool.length > 0 && !allParticipantsTouching
    ? 'waiting'
    : session.active
    ? 'code'
    : 'idle';

  return (
    <main
      className="app"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div
        className="corner corner-left mode-dot"
        data-dragging={adjusting ? 'true' : 'false'}
        data-mode={mode}
        aria-hidden="true"
        style={{
          transform: `translate(${controlOffset.x}px, ${controlOffset.y}px)`,
        }}
      >
        <span>{winnerCount}{mode}</span>
      </div>
      <button className="corner corner-right help-dot" type="button" onClick={openHelp} aria-label="Open help">
        ?
      </button>

      <div className="status" data-variant={statusVariant} aria-live="polite">
        {statusVariant === 'mode' && `${winnerCount}${mode}`}
        {statusVariant === 'countdown' && `${Math.ceil((1 - progress) * 3)}`}
        {statusVariant === 'waiting' && <span className="status-waiting">Waiting for everyone…</span>}
        {statusVariant === 'code' && (
          <>
            <span className="status-code">{session.passcode}</span>
            <span className="status-connected">
              {session.participants.size} {session.participants.size === 1 ? 'person' : 'people'} joined
            </span>
          </>
        )}
      </div>

      {session.active && remoteActiveFingers.length > 0 && (
        <div className="remote-finger-cluster" aria-hidden="true">
          {remoteActiveFingers.map((entry) => (
            <span className="remote-finger-badge" key={entry.key}>
              {entry.icon}
            </span>
          ))}
        </div>
      )}

      {activeFingers.map((finger, index) => (
        <div
          className="finger-ring"
          key={finger.id}
          style={{
            left: finger.x,
            top: finger.y,
            animationDuration: pulseDuration,
            '--ring-color': mode === 'G' ? '#f8fafc' : FINGER_COLORS[((finger.label ?? index + 1) - 1) % FINGER_COLORS.length],
            '--ring-glow':
              mode === 'G'
                ? 'rgba(248, 250, 252, 0.46)'
                : `${FINGER_COLORS[((finger.label ?? index + 1) - 1) % FINGER_COLORS.length]}88`,
            '--ring-fill':
              mode === 'G'
                ? 'rgba(248, 250, 252, 0.08)'
                : `${FINGER_COLORS[((finger.label ?? index + 1) - 1) % FINGER_COLORS.length]}22`,
          }}
        >
          <span>{finger.label ?? index + 1}</span>
        </div>
      ))}

      {selection?.type === 'finger' && (
        <button className="finger-result" type="button" onClick={resetRound}>
          {selection.winners.map((winner) =>
            winner.x !== undefined ? (
              <span
                className="finger-ring chosen-ring"
                key={`${winner.deviceKey}:${winner.fingerId}`}
                style={{
                  left: winner.x,
                  top: winner.y,
                  '--ring-color': winner.color,
                  '--ring-glow': `${winner.color}88`,
                  '--ring-fill': `${winner.color}22`,
                }}
              >
                <span>{winner.label}</span>
              </span>
            ) : (
              <span className="remote-winner-chip" key={`${winner.deviceKey}:${winner.fingerId}`}>
                {winner.icon}
              </span>
            )
          )}
          <small>Tap to choose again</small>
        </button>
      )}

      {selection?.type === 'group' && (
        <button className="group-result" type="button" onClick={resetRound}>
          {selection.groups.flatMap((group) => {
            const color = GROUP_COLORS[(group.id - 1) % GROUP_COLORS.length];
            return group.members.map((member) =>
              member.x !== undefined ? (
                <span
                  className="finger-ring group-ring"
                  key={`${member.deviceKey}:${member.fingerId}`}
                  style={{
                    left: member.x,
                    top: member.y,
                    '--ring-color': color,
                    '--ring-glow': `${color}88`,
                    '--ring-fill': `${color}22`,
                  }}
                >
                  <span>{group.id}</span>
                </span>
              ) : (
                <span
                  className="remote-winner-chip"
                  key={`${member.deviceKey}:${member.fingerId}`}
                  style={{ borderColor: color }}
                >
                  {member.icon}
                </span>
              )
            );
          })}
          <small>Tap to choose again</small>
        </button>
      )}

      {helpOpen && (
        <section
          className="help"
          aria-modal="true"
          role="dialog"
          aria-label={HELP_DIALOG_LABEL[helpPage]}
          onPointerDown={handleHelpPointerDown}
          onPointerMove={handleHelpPointerMove}
          onPointerUp={handleHelpPointerUp}
          onPointerCancel={handleHelpPointerCancel}
        >
          <div className="help-panel">
            <button className="close" type="button" onClick={closeHelp} aria-label="Close help">
              ×
            </button>

            <div className="help-pages">
              <div className="help-page share-page" data-active={helpPage === 'share'} aria-hidden={helpPage !== 'share'}>
                <h1>Share PickMe</h1>
                <p className="share-url">{APP_URL}</p>
                {qrDataUrl && <img className="share-qr" src={qrDataUrl} alt="QR code for the PickMe app URL" />}
                <button className="share-action" type="button" onClick={copyAppUrl}>
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
              </div>

              <div
                className="help-page"
                data-active={helpPage === 'instructions'}
                aria-hidden={helpPage !== 'instructions'}
              >
                <h1 className="help-title">
                  <span>PickMe</span>
                  <img src="/icons/monkey-union-jack.svg" alt="Monkey" />
                </h1>
                <p>Place fingers on the open screen. Rings pulse while everyone is touching.</p>
                <p>With F mode, the app randomly leaves the chosen finger numbers after three seconds.</p>
                <p>With G mode, everyone is split into random, even groups shown by color.</p>
                <p>Press the control dot to reset the count. Drag it down to increase the number, or right to switch between F and G.</p>
                <p>PickMe supports up to 10 fingers, but your phone or browser may detect fewer simultaneous touches.</p>
              </div>

              <div
                className="help-page install-page"
                data-active={helpPage === 'install'}
                aria-hidden={helpPage !== 'install'}
              >
                <h1>Save to your Home Screen</h1>
                <p className="install-intro">
                  PickMe will appear alongside your other apps and open in its own window.
                </p>

                <section className="install-guide" aria-labelledby="ios-install-title">
                  <h2 id="ios-install-title">iPhone or iPad</h2>
                  <ol>
                    <li>Open <strong>pickme.mnky.uk</strong> in Safari.</li>
                    <li>Tap Share—the square with an upward arrow. If it is hidden, tap More (…) and then Share.</li>
                    <li>Scroll down and tap <strong>Add to Home Screen</strong>. If it is missing, tap Edit Actions and add it.</li>
                    <li>Turn on <strong>Open as Web App</strong>, then tap <strong>Add</strong>.</li>
                  </ol>
                </section>

                <section className="install-guide" aria-labelledby="android-install-title">
                  <h2 id="android-install-title">Android</h2>
                  <ol>
                    <li>Open <strong>pickme.mnky.uk</strong> in Chrome.</li>
                    <li>Tap More (⋮) beside the address bar.</li>
                    <li>Tap <strong>Add to home screen</strong>, then <strong>Install</strong>.</li>
                    <li>Follow the instructions. PickMe will then appear on your Home Screen.</li>
                  </ol>
                </section>
              </div>

              <div
                className="help-page session-page"
                data-active={helpPage === 'session'}
                aria-hidden={helpPage !== 'session'}
              >
                <h1>Play together</h1>

                {!session.active && (
                  <>
                    <p>Start a session to merge fingers from separate phones into one shared pick.</p>
                    <button className="share-action" type="button" onClick={session.startSession}>
                      Start a session
                    </button>

                    <p className="session-join-label">Or join with a passcode</p>
                    <form className="session-join-form" onSubmit={handleJoinSubmit}>
                      <div className="session-code-boxes" onPaste={handleCodePaste}>
                        {codeDigits.map((digit, index) => (
                          <input
                            // eslint-disable-next-line react/no-array-index-key
                            key={index}
                            ref={(element) => {
                              codeBoxRefs.current[index] = element;
                            }}
                            className="session-code-box"
                            type="tel"
                            inputMode="numeric"
                            maxLength={1}
                            value={digit}
                            onChange={(event) => handleCodeDigitChange(index, event.target.value)}
                            onKeyDown={(event) => handleCodeDigitKeyDown(index, event)}
                            aria-label={`Passcode digit ${index + 1}`}
                          />
                        ))}
                      </div>
                      <button className="share-action" type="submit" disabled={joinCodeValue.length !== 4}>
                        Join
                      </button>
                    </form>

                    {session.status === 'connecting' && <p className="session-status">Connecting…</p>}
                    {session.error && <p className="session-status">{SESSION_ERROR_MESSAGE[session.error]}</p>}
                  </>
                )}

                {session.active && (
                  <div className="session-active">
                    <div className="session-own-icon" aria-hidden="true">{session.ownIcon}</div>
                    <p className="session-passcode">{session.passcode}</p>
                    <p className="session-role">{session.role === 'host' ? 'You are hosting' : 'Connected'}</p>
                    <p className="session-connected-count">
                      {session.participants.size} {session.participants.size === 1 ? 'person' : 'people'} joined
                    </p>
                    {session.reconnecting && <p className="session-status">Reconnecting…</p>}

                    <ul className="session-participant-list">
                      {Array.from(session.participants.values()).map((participant) => (
                        <li className="session-participant" key={participant.deviceKey}>
                          <span className="session-participant-icon" aria-hidden="true">{participant.icon}</span>
                          <span className="session-participant-role">
                            {participant.deviceKey === session.deviceKey
                              ? 'You'
                              : participant.role === 'host'
                              ? 'Host'
                              : 'Guest'}
                          </span>
                          <span
                            className="session-participant-touching"
                            data-touching={(participant.fingerIds || []).length > 0}
                          >
                            {(participant.fingerIds || []).length}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <button className="share-action" type="button" onClick={session.leaveSession}>
                      {session.role === 'host' ? 'End session' : 'Leave session'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <button
              className="help-page-cue"
              type="button"
              onClick={() => setHelpPage(nextHelpPage)}
              aria-label={nextHelpPage === 'instructions' ? 'Back to PickMe help' : `Open ${HELP_PAGE_LABEL[nextHelpPage]}`}
            >
              <span>{HELP_PAGE_LABEL[nextHelpPage]}</span>
              <span className="help-pagination" aria-hidden="true">
                {HELP_PAGE_ORDER.map((page) => (
                  <span className="help-pagination-dot" key={page} data-active={helpPage === page} />
                ))}
              </span>
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <>
    <App />
    <Analytics />
  </>
);
