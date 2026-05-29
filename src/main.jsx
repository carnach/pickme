import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const CONTROL_SIZE = 96;
const ROUND_MS = 3000;
const MIN_WINNERS = 1;
const MAX_WINNERS = 10;
const NUMBER_STEP_DISTANCE = 78;
const MODE_TOGGLE_DISTANCE = 84;
const MODE_TOGGLE_HYSTERESIS = 22;
const GROUP_COLORS = ['#22c55e', '#f97316', '#38bdf8', '#e879f9', '#fde047', '#a78bfa', '#fb7185', '#14b8a6'];
const FINGER_COLORS = ['#f97316', '#22c55e', '#38bdf8', '#e879f9', '#fde047', '#a78bfa', '#fb7185', '#14b8a6', '#f43f5e', '#84cc16'];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
    color: GROUP_COLORS[index % GROUP_COLORS.length],
    fingers: [],
  }));

  randomPick(items, items.length).forEach((finger, index) => {
    groups[index % count].fingers.push(finger);
  });

  return groups;
}

function nextFingerLabel(fingers) {
  const used = new Set(fingers.map((finger) => finger.label).filter(Boolean));

  for (let label = 1; label <= MAX_WINNERS + 10; label += 1) {
    if (!used.has(label)) {
      return label;
    }
  }

  return used.size + 1;
}

function App() {
  const [fingers, setFingers] = useState([]);
  const [winnerCount, setWinnerCount] = useState(1);
  const [mode, setMode] = useState('F');
  const [helpOpen, setHelpOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [selection, setSelection] = useState(null);
  const [controlOffset, setControlOffset] = useState({ x: 0, y: 0 });
  const [roundStartedAt, setRoundStartedAt] = useState(null);
  const [now, setNow] = useState(() => performance.now());
  const controlPointerId = useRef(null);
  const startAdjustX = useRef(0);
  const startAdjustY = useRef(0);
  const startWinnerCount = useRef(1);
  const startMode = useRef('F');
  const toggledThisDrag = useRef(false);
  const selectionRef = useRef(null);

  const activeFingers = useMemo(() => fingers.filter((finger) => finger.kind === 'pick'), [fingers]);
  const progress = roundStartedAt && activeFingers.length > 1 ? clamp((now - roundStartedAt) / ROUND_MS, 0, 1) : 0;

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    let animationFrame = 0;

    const tick = (time) => {
      setNow(time);
      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (activeFingers.length > 1 && !selection) {
      setRoundStartedAt((startedAt) => startedAt ?? performance.now());
      return;
    }

    setRoundStartedAt(null);
  }, [activeFingers.length, selection]);

  useEffect(() => {
    if (!roundStartedAt || activeFingers.length < 2 || selection) {
      return;
    }

    const remaining = Math.max(0, ROUND_MS - (performance.now() - roundStartedAt));
    const timer = window.setTimeout(() => {
      setFingers((currentFingers) => {
        const currentPickers = currentFingers.filter((finger) => finger.kind === 'pick');
        if (mode === 'G') {
          const groups = createGroups(currentPickers, winnerCount);
          setSelection({
            type: 'group',
            count: groups.length,
            groups,
            total: currentPickers.length,
          });
        } else {
          const count = Math.min(winnerCount, currentPickers.length);
          const winners = randomPick(currentPickers, count);
          setSelection({
            type: 'finger',
            count,
            winners: winners
              .map((winner) => ({
                ...winner,
                color: FINGER_COLORS[(winner.label - 1) % FINGER_COLORS.length],
              }))
              .sort((a, b) => a.label - b.label),
            total: currentPickers.length,
          });
        }
        return [];
      });
      setRoundStartedAt(null);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [roundStartedAt, activeFingers.length, selection, winnerCount, mode]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  const resetRound = () => {
    setFingers([]);
    setRoundStartedAt(null);
    setSelection(null);
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
      setHelpOpen(true);
      updateFinger(event, 'control');
      return;
    }

    if (isTopLeft(event)) {
      controlPointerId.current = event.pointerId;
      startAdjustX.current = event.clientX;
      startAdjustY.current = event.clientY;
      startWinnerCount.current = MIN_WINNERS;
      startMode.current = mode;
      toggledThisDrag.current = false;
      setWinnerCount(MIN_WINNERS);
      setAdjusting(true);
      updateFinger(event, 'control');
      return;
    }

    setRoundStartedAt((startedAt) => (activeFingers.length >= 1 ? performance.now() : startedAt));
    updateFinger(event, 'pick');
  };

  const handlePointerMove = (event) => {
    if (event.pointerId === controlPointerId.current) {
      const horizontalDistance = Math.max(0, event.clientX - startAdjustX.current);
      const distance = Math.max(0, event.clientY - startAdjustY.current);
      const count = clamp(startWinnerCount.current + Math.floor(distance / NUMBER_STEP_DISTANCE), MIN_WINNERS, MAX_WINNERS);
      const shouldToggle = horizontalDistance >= MODE_TOGGLE_DISTANCE && horizontalDistance > distance * 0.8;
      const shouldReleaseToggle = horizontalDistance < MODE_TOGGLE_DISTANCE - MODE_TOGGLE_HYSTERESIS;
      setWinnerCount(count);
      if (shouldToggle && !toggledThisDrag.current) {
        setMode(startMode.current === 'F' ? 'G' : 'F');
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
      <button className="corner corner-right help-dot" type="button" onClick={() => setHelpOpen(true)} aria-label="Open help">
        ?
      </button>

      <div className="status" aria-live="polite">
        {adjusting ? `${winnerCount}${mode}` : activeFingers.length > 1 ? `${Math.ceil((1 - progress) * 3)}` : ''}
      </div>

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
          {selection.winners.map((winner) => (
            <span
              className="finger-ring chosen-ring"
              key={winner.id}
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
          ))}
          <small>Tap to choose again</small>
        </button>
      )}

      {selection?.type === 'group' && (
        <button className="group-result" type="button" onClick={resetRound}>
          {selection.groups.flatMap((group) =>
            group.fingers.map((finger) => (
              <span
                className="finger-ring group-ring"
                key={finger.id}
                style={{
                  left: finger.x,
                  top: finger.y,
                  '--ring-color': group.color,
                  '--ring-glow': `${group.color}88`,
                  '--ring-fill': `${group.color}22`,
                }}
              >
                <span>{group.id}</span>
              </span>
            ))
          )}
          <small>Tap to choose again</small>
        </button>
      )}

      {helpOpen && (
        <section
          className="help"
          aria-modal="true"
          role="dialog"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerCancel={(event) => event.stopPropagation()}
        >
          <div className="help-panel">
            <button className="close" type="button" onClick={() => setHelpOpen(false)} aria-label="Close help">
              ×
            </button>
            <h1>PickMe</h1>
            <p>Place fingers on the open screen. Rings pulse while everyone is touching.</p>
            <p>With F mode, the app randomly leaves the chosen finger numbers after three seconds.</p>
            <p>With G mode, everyone is split into random, even groups shown by color.</p>
            <p>Press the green dot to reset to 1. Drag it down to increase the number, or right to switch between F and G.</p>
            <p>PickMe supports up to 10 fingers, but your phone or browser may detect fewer simultaneous touches.</p>
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
