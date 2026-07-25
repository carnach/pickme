import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { createRoot } from 'react-dom/client';
import { toDataURL as qrToDataURL } from 'qrcode';
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

  for (let label = 1; label <= FINGER_SELECTION_BOUNDS.max + 10; label += 1) {
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
  const [helpPage, setHelpPage] = useState('instructions');
  const [shareOpen, setShareOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [selection, setSelection] = useState(null);
  const [controlOffset, setControlOffset] = useState({ x: 0, y: 0 });
  const [roundStartedAt, setRoundStartedAt] = useState(null);
  const [now, setNow] = useState(() => performance.now());
  const controlPointerId = useRef(null);
  const startAdjustX = useRef(0);
  const startAdjustY = useRef(0);
  const startMode = useRef('F');
  const toggledThisDrag = useRef(false);
  const selectionRef = useRef(null);
  const helpSwipeStart = useRef(null);

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

  const openHelp = () => {
    setHelpPage('instructions');
    setHelpOpen(true);
  };

  const closeHelp = () => {
    setHelpOpen(false);
    setHelpPage('instructions');
    setShareOpen(false);
    setQrDataUrl(null);
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

    if (horizontalDistance < 0 && helpPage === 'instructions') {
      setHelpPage('install');
    } else if (horizontalDistance > 0 && helpPage === 'install') {
      setHelpPage('instructions');
    }

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

  const toggleQrCode = async () => {
    if (qrDataUrl) {
      setQrDataUrl(null);
      return;
    }

    try {
      const dataUrl = await qrToDataURL(APP_URL, { margin: 1, width: 220 });
      setQrDataUrl(dataUrl);
    } catch {
      setQrDataUrl(null);
    }
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

    setRoundStartedAt((startedAt) => (activeFingers.length >= 1 ? performance.now() : startedAt));
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
          aria-label={helpPage === 'instructions' ? 'PickMe help' : 'Save PickMe to your Home Screen'}
          onPointerDown={handleHelpPointerDown}
          onPointerMove={handleHelpPointerMove}
          onPointerUp={handleHelpPointerUp}
          onPointerCancel={handleHelpPointerCancel}
        >
          <div className="help-panel">
            <button className="close" type="button" onClick={closeHelp} aria-label="Close help">
              ×
            </button>

            {helpPage === 'instructions' && (
              <div className="help-page">
                <h1 className="help-title">
                  <span>PickMe</span>
                  <img src="/icons/monkey-union-jack.svg" alt="Monkey" />
                </h1>
                <p>Place fingers on the open screen. Rings pulse while everyone is touching.</p>
                <p>With F mode, the app randomly leaves the chosen finger numbers after three seconds.</p>
                <p>With G mode, everyone is split into random, even groups shown by color.</p>
                <p>Press the control dot to reset the count. Drag it down to increase the number, or right to switch between F and G.</p>
                <p>PickMe supports up to 10 fingers, but your phone or browser may detect fewer simultaneous touches.</p>

                {!shareOpen && (
                  <button className="share-toggle" type="button" onClick={() => setShareOpen(true)}>
                    Share PickMe
                  </button>
                )}

                {shareOpen && (
                  <div className="share-panel">
                    <p className="share-url">{APP_URL}</p>
                    <div className="share-actions">
                      <button className="share-action" type="button" onClick={copyAppUrl}>
                        {copied ? 'Copied!' : 'Copy link'}
                      </button>
                      <button className="share-action" type="button" onClick={toggleQrCode}>
                        {qrDataUrl ? 'Hide QR code' : 'Show QR code'}
                      </button>
                    </div>
                    {qrDataUrl && <img className="share-qr" src={qrDataUrl} alt="QR code for the PickMe app URL" />}
                  </div>
                )}

              </div>
            )}

            {helpPage === 'install' && (
              <div className="help-page install-page">
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
            )}

            <button
              className="help-page-cue"
              type="button"
              onClick={() => setHelpPage(helpPage === 'instructions' ? 'install' : 'instructions')}
              aria-label={helpPage === 'instructions' ? 'Open Home Screen help' : 'Back to PickMe help'}
            >
              <span>{helpPage === 'instructions' ? 'Home Screen help' : 'Back to PickMe help'}</span>
              <span className="help-pagination" aria-hidden="true">
                <span className="help-pagination-dot" data-active={helpPage === 'instructions'} />
                <span className="help-pagination-dot" data-active={helpPage === 'install'} />
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
