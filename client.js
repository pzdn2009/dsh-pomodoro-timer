/**
 * Pomodoro timer — Client half.
 *
 * Registers a frame-wide floating timer in the `shell.overlay` slot. The timer
 * counts down against a wall-clock deadline so background-tab throttling and
 * window reloads do not distort it, keeps its state in localStorage, and
 * renders with the host theme tokens.
 */

window.__ModuleLoader__.load({
  id: '@local/pomodoro-timer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;

    const NS = 'pomodoro-timer';
    const STORAGE_KEY = 'dsh.pomodoro-timer.v1';
    const TICK_MS = 200;
    const NOTICE_MS = 6000;

    const PHASES = ['focus', 'short', 'long'];
    const PHASE_COLOR = {
      focus: 'var(--dsw-alias-brand-primary)',
      short: 'var(--dsw-alias-state-success-primary)',
      long: 'var(--dsw-alias-state-warn-primary)',
    };
    const DURATION_FIELDS = [
      { key: 'focus', min: 5, max: 120, step: 5 },
      { key: 'short', min: 1, max: 30, step: 1 },
      { key: 'long', min: 5, max: 60, step: 5 },
    ];
    const DEFAULT_SETTINGS = {
      focus: 25,
      short: 5,
      long: 15,
      cycle: 4,
      autoStart: true,
      sound: true,
    };

    /* Two minutes of synthesized ambient music; no audio assets are shipped. */
    const MUSIC_MS = 120000;
    const CHORD_MS = 15000;
    const CHORDS = [
      [48, 55, 64, 71],
      [45, 52, 60, 67],
      [41, 48, 57, 64],
      [43, 50, 59, 64],
    ];
    const ARP_PATTERN = [0, 2, 1, 3, 2, 1, 0, 2, 3, 1, 2, 0];

    const DICT = {
      en: {
        label: 'Pomodoro timer',
        open: 'Open pomodoro timer',
        collapse: 'Collapse timer',
        settings: 'Timer settings',
        back: 'Back to timer',
        focus: 'Focus',
        short: 'Short break',
        long: 'Long break',
        start: 'Start',
        resume: 'Resume',
        pause: 'Pause',
        reset: 'Reset',
        skip: 'Skip',
        today: 'Today {count}',
        durations: 'Durations',
        options: 'Options',
        minutes: '{value} min',
        autoStart: 'Start the next session automatically',
        sound: 'Play two minutes of gentle music at each phase end',
        musicPlaying: 'Gentle music playing',
        stopMusic: 'Stop',
        focusFinished: 'Focus finished — take a break',
        breakFinished: 'Break over — back to focus',
        decrease: 'Decrease',
        increase: 'Increase',
      },
      zh: {
        label: '番茄时钟',
        open: '打开番茄时钟',
        collapse: '收起番茄时钟',
        settings: '计时设置',
        back: '返回计时器',
        focus: '专注',
        short: '短休息',
        long: '长休息',
        start: '开始',
        resume: '继续',
        pause: '暂停',
        reset: '重置',
        skip: '跳过',
        today: '今日 {count} 个',
        durations: '时长',
        options: '选项',
        minutes: '{value} 分钟',
        autoStart: '自动开始下一段',
        sound: '阶段结束时播放 2 分钟轻音乐',
        musicPlaying: '轻音乐播放中',
        stopMusic: '停止',
        focusFinished: '专注结束，休息一下',
        breakFinished: '休息结束，继续专注',
        decrease: '减少',
        increase: '增加',
      },
    };

    /* ---------------------------------------------------------------- state */

    let context = null;
    let store = null;
    let engineTimer = 0;
    let noticeTimer = 0;
    let persistTimer = 0;
    let unsubscribePersist = null;
    let audio = null;
    let musicBus = null;
    let musicScheduler = 0;
    let musicTimer = 0;

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function formatTemplate(template, values) {
      if (!values) return String(template);
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
    }

    function dayKey(date) {
      const d = date || new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function durationMs(phase, settings) {
      const minutes = phase === 'focus' ? settings.focus : phase === 'short' ? settings.short : settings.long;
      return Math.max(1, Math.round(minutes)) * 60000;
    }

    function formatClock(ms) {
      const seconds = Math.max(0, Math.ceil(ms / 1000));
      const minutes = Math.floor(seconds / 60);
      return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get() {
          return state;
        },
        set(patch) {
          state = { ...state, ...patch };
          listeners.forEach((listener) => {
            try {
              listener();
            } catch (error) {
              /* a broken subscriber must not break the timer */
            }
          });
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function loadState() {
      let saved = null;
      if (typeof window !== 'undefined') {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          if (raw) saved = JSON.parse(raw);
        } catch (error) {
          saved = null;
        }
      }

      const settings = { ...DEFAULT_SETTINGS };
      if (saved && saved.settings && typeof saved.settings === 'object') {
        Object.keys(DEFAULT_SETTINGS).forEach((key) => {
          if (typeof saved.settings[key] === typeof DEFAULT_SETTINGS[key]) settings[key] = saved.settings[key];
        });
      }
      DURATION_FIELDS.forEach((field) => {
        settings[field.key] = clamp(Math.round(settings[field.key]), field.min, field.max);
      });

      const phase = saved && PHASES.indexOf(saved.phase) >= 0 ? saved.phase : 'focus';
      const cycleDone = saved && Number.isFinite(saved.cycleDone) ? Math.max(0, Math.floor(saved.cycleDone)) : 0;
      const today = saved && saved.today && saved.today.date === dayKey() && Number.isFinite(saved.today.count)
        ? { date: saved.today.date, count: Math.max(0, Math.floor(saved.today.count)) }
        : { date: dayKey(), count: 0 };

      let remaining = saved && Number.isFinite(saved.remaining) ? saved.remaining : durationMs(phase, settings);
      let running = Boolean(saved && saved.running && Number.isFinite(saved.endsAt));
      let endsAt = running ? saved.endsAt : 0;
      if (running) {
        remaining = endsAt - Date.now();
        if (remaining <= 0) {
          running = false;
          endsAt = 0;
          remaining = durationMs(phase, settings);
        }
      }
      remaining = clamp(remaining, 0, durationMs(phase, settings));
      if (!running && remaining <= 0) remaining = durationMs(phase, settings);

      return {
        phase,
        cycleDone,
        today,
        settings,
        running,
        endsAt,
        remaining,
        expanded: Boolean(saved && saved.expanded),
        view: 'timer',
        notice: null,
        music: false,
      };
    }

    function ensureStore() {
      if (store === null) store = createStore(loadState());
      return store;
    }

    /* ----------------------------------------------------------- persistence */

    function save() {
      if (!store || typeof window === 'undefined') return;
      const s = store.get();
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          settings: s.settings,
          phase: s.phase,
          cycleDone: s.cycleDone,
          running: s.running,
          endsAt: s.endsAt,
          remaining: s.remaining,
          today: s.today,
          expanded: s.expanded,
        }));
      } catch (error) {
        /* storage may be unavailable; the timer keeps working in memory */
      }
    }

    function scheduleSave() {
      if (typeof window === 'undefined') return;
      if (persistTimer) window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => {
        persistTimer = 0;
        save();
      }, 400);
    }

    /* --------------------------------------------------------------- engine */

    function tick() {
      const s = store.get();
      if (!s.running || !s.endsAt) return;
      const left = s.endsAt - Date.now();
      if (left <= 0) {
        completePhase(false);
        return;
      }
      if (Math.ceil(left / 1000) !== Math.ceil(s.remaining / 1000)) store.set({ remaining: left });
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') tick();
    }

    /* --------------------------------------------------------------- audio */

    function midiToFreq(midi) {
      return 440 * Math.pow(2, (midi - 69) / 12);
    }

    function ensureAudio() {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      if (!audio) {
        try {
          audio = new AudioCtor();
        } catch (error) {
          return null;
        }
      }
      if (audio.state === 'suspended' && typeof audio.resume === 'function') {
        Promise.resolve(audio.resume()).catch(() => {});
      }
      return audio;
    }

    function makeReverb(ac) {
      const seconds = 2.6;
      const length = Math.max(1, Math.floor(ac.sampleRate * seconds));
      const buffer = ac.createBuffer(2, length, ac.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i += 1) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.6);
        }
      }
      const convolver = ac.createConvolver();
      convolver.buffer = buffer;
      return convolver;
    }

    function createMusicBus(ac) {
      const bus = ac.createGain();
      bus.gain.value = 0;
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      const dry = ac.createGain();
      dry.gain.value = 0.85;
      const wet = ac.createGain();
      wet.gain.value = 0.4;
      const reverb = makeReverb(ac);
      bus.connect(filter);
      filter.connect(dry);
      dry.connect(ac.destination);
      filter.connect(reverb);
      reverb.connect(wet);
      wet.connect(ac.destination);
      return bus;
    }

    function scheduleNote(ac, bus, midi, at, duration, peak, type, attack) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const rise = attack || 0.03;
      osc.type = type || 'triangle';
      osc.frequency.setValueAtTime(midiToFreq(midi), at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + rise);
      gain.gain.setValueAtTime(peak, at + Math.max(rise, duration - 0.35));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain);
      gain.connect(bus);
      osc.start(at);
      osc.stop(at + duration + 0.1);
    }

    function scheduleChord(ac, bus, index, at, duration) {
      const chord = CHORDS[index % CHORDS.length];
      chord.forEach((midi) => scheduleNote(ac, bus, midi, at, duration, 0.03, 'triangle', 4));
      scheduleNote(ac, bus, chord[0] - 12, at, duration, 0.045, 'sine', 3);
      const step = duration / ARP_PATTERN.length;
      ARP_PATTERN.forEach((tone, position) => {
        scheduleNote(ac, bus, chord[tone] + 12, at + position * step, Math.max(0.9, step * 1.3), 0.05, 'sine', 0.02);
      });
    }

    function startMusic() {
      const ac = ensureAudio();
      if (!ac) return;
      stopMusic(true);

      const bus = createMusicBus(ac);
      musicBus = bus;
      const startedAt = ac.currentTime + 0.2;
      const until = startedAt + MUSIC_MS / 1000;
      try {
        bus.gain.setValueAtTime(0.0001, startedAt);
        bus.gain.linearRampToValueAtTime(0.8, startedAt + 2.5);
        bus.gain.setValueAtTime(0.8, Math.max(startedAt + 2.5, until - 5));
        bus.gain.linearRampToValueAtTime(0.0001, until);
      } catch (error) {
        /* automation support is optional */
      }

      let chordIndex = 0;
      let nextAt = startedAt;
      const scheduleNext = () => {
        const horizon = ac.currentTime + 3;
        while (nextAt < horizon && nextAt < until) {
          scheduleChord(ac, bus, chordIndex, nextAt, CHORD_MS / 1000);
          nextAt += CHORD_MS / 1000;
          chordIndex += 1;
        }
      };
      scheduleNext();
      musicScheduler = window.setInterval(scheduleNext, 800);
      musicTimer = window.setTimeout(() => stopMusic(false), MUSIC_MS + 200);
      store.set({ music: true });
    }

    function stopMusic(instant) {
      if (musicScheduler) {
        window.clearInterval(musicScheduler);
        musicScheduler = 0;
      }
      if (musicTimer) {
        window.clearTimeout(musicTimer);
        musicTimer = 0;
      }
      const bus = musicBus;
      musicBus = null;
      if (bus && audio) {
        try {
          const now = audio.currentTime;
          bus.gain.cancelScheduledValues(now);
          bus.gain.setValueAtTime(Math.max(bus.gain.value, 0.0001), now);
          if (instant === true) bus.gain.setValueAtTime(0.0001, now);
          else bus.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        } catch (error) {
          /* automation support is optional */
        }
        window.setTimeout(() => {
          try {
            bus.disconnect();
          } catch (error) {
            /* already gone */
          }
        }, instant === true ? 40 : 1400);
      }
      if (store && store.get().music) store.set({ music: false });
    }

    function clearNoticeSoon() {
      if (typeof window === 'undefined') return;
      if (noticeTimer) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        noticeTimer = 0;
        store.set({ notice: null });
      }, NOTICE_MS);
    }

    function completePhase(silent) {
      const s = store.get();
      const settings = s.settings;
      let cycleDone = s.cycleDone;
      let phase = 'focus';
      let today = s.today.date === dayKey() ? { ...s.today } : { date: dayKey(), count: 0 };

      if (s.phase === 'focus') {
        cycleDone += 1;
        today.count += 1;
        phase = cycleDone >= settings.cycle ? 'long' : 'short';
      } else {
        if (s.phase === 'long') cycleDone = 0;
        phase = 'focus';
      }

      const total = durationMs(phase, settings);
      const autoStart = settings.autoStart === true;
      store.set({
        phase,
        cycleDone,
        today,
        running: autoStart,
        endsAt: autoStart ? Date.now() + total : 0,
        remaining: total,
        notice: silent ? s.notice : (s.phase === 'focus' ? 'break' : 'focus'),
      });
      if (silent) return;
      clearNoticeSoon();
      if (settings.sound) startMusic();
    }

    /* -------------------------------------------------------------- actions */

    function toggle() {
      const s = store.get();
      if (s.running) {
        store.set({ running: false, endsAt: 0, remaining: clamp(s.endsAt - Date.now(), 0, durationMs(s.phase, s.settings)) });
        return;
      }
      const remaining = s.remaining > 0 ? s.remaining : durationMs(s.phase, s.settings);
      store.set({ running: true, endsAt: Date.now() + remaining, remaining });
    }

    function reset() {
      const s = store.get();
      store.set({ running: false, endsAt: 0, remaining: durationMs(s.phase, s.settings) });
    }

    function skip() {
      const s = store.get();
      let cycleDone = s.cycleDone;
      let phase;
      if (s.phase === 'focus') {
        phase = cycleDone + 1 >= s.settings.cycle ? 'long' : 'short';
      } else {
        if (s.phase === 'long') cycleDone = 0;
        phase = 'focus';
      }
      store.set({
        phase,
        cycleDone,
        running: false,
        endsAt: 0,
        remaining: durationMs(phase, s.settings),
        notice: null,
      });
    }

    function updateSetting(key, value) {
      const s = store.get();
      const settings = { ...s.settings, [key]: value };
      const patch = { settings };
      if (!s.running && PHASES.indexOf(key) >= 0 && key === s.phase) {
        patch.remaining = durationMs(key, settings);
      }
      store.set(patch);
    }

    /* ------------------------------------------------------------- language */

    function translate(key, values) {
      let text = key;
      if (context) {
        const locale = context.get('locale');
        if (locale && typeof locale.bind === 'function') {
          try {
            const translated = locale.bind(NS)(key);
            if (typeof translated === 'string' && translated) text = translated;
          } catch (error) {
            text = key;
          }
        }
      }
      return formatTemplate(text, values);
    }

    function useTranslate() {
      const [, setRevision] = useState(0);
      useEffect(() => {
        if (!context) return undefined;
        const locale = context.get('locale');
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setRevision((value) => value + 1));
      }, []);
    }

    function useStoreValue() {
      const [, setRevision] = useState(0);
      useEffect(() => store.subscribe(() => setRevision((value) => value + 1)), []);
      return store.get();
    }

    /* ---------------------------------------------------------------- icons */

    function icon(size, children) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, children);
    }

    function PlayIcon() {
      return icon(14, h('path', { d: 'M9 5.6v12.8L18.4 12z', fill: 'currentColor', stroke: 'none' }));
    }

    function PauseIcon() {
      return icon(14, [
        h('rect', { key: 'a', x: 7.4, y: 5.6, width: 3.2, height: 12.8, rx: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('rect', { key: 'b', x: 13.4, y: 5.6, width: 3.2, height: 12.8, rx: 1.1, fill: 'currentColor', stroke: 'none' }),
      ]);
    }

    function ResetIcon() {
      return icon(15, [
        h('path', { key: 'a', d: 'M4.4 11.2a7.8 7.8 0 1 1 2.2 6.1' }),
        h('path', { key: 'b', d: 'M4.2 5.4v5.4h5.4' }),
      ]);
    }

    function SkipIcon() {
      return icon(15, [
        h('path', { key: 'a', d: 'M6.2 6.1v11.8L14.4 12z', fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'b', d: 'M17.6 6.1v11.8' }),
      ]);
    }

    function SlidersIcon() {
      return icon(15, [
        h('path', { key: 'a', d: 'M4 7h4.6M13.4 7H20' }),
        h('circle', { key: 'b', cx: 11, cy: 7, r: 2.1 }),
        h('path', { key: 'c', d: 'M4 12h1.9M10.1 12H20' }),
        h('circle', { key: 'd', cx: 8, cy: 12, r: 2.1 }),
        h('path', { key: 'e', d: 'M4 17h8.9M17.1 17H20' }),
        h('circle', { key: 'f', cx: 15, cy: 17, r: 2.1 }),
      ]);
    }

    function ChevronDownIcon() {
      return icon(15, h('path', { d: 'M6.5 9.5l5.5 5.5 5.5-5.5' }));
    }

    function BackIcon() {
      return icon(15, h('path', { d: 'M14.5 6.5L8 12l6.5 5.5' }));
    }

    function TomatoGlyph() {
      return h('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      }, [
        h('circle', { key: 'body', cx: 12, cy: 14, r: 7.6, fill: '#e5484d' }),
        h('path', { key: 'leaf', d: 'M12 6.4c-1.7 0-3-1.1-3-1.1.3 1.5 1.5 2.6 3 2.7 1.5-.1 2.7-1.2 3-2.7 0 0-1.3 1.1-3 1.1z', fill: '#2f9e44' }),
        h('rect', { key: 'stem', x: 11.2, y: 3.7, width: 1.6, height: 3.2, rx: 0.8, fill: '#237a35' }),
        h('ellipse', { key: 'shine', cx: 9.4, cy: 11.4, rx: 1.9, ry: 1.2, fill: '#ffffff', opacity: 0.45, transform: 'rotate(-28 9.4 11.4)' }),
      ]);
    }

    /* ------------------------------------------------------------ component */

    const RING_RADIUS = 52;
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

    function phaseLabel(phase) {
      return phase === 'focus' ? 'focus' : phase === 'short' ? 'short' : 'long';
    }

    function PomodoroWidget() {
      useTranslate();
      const state = useStoreValue();
      const t = translate;

      const settings = state.settings;
      const total = durationMs(state.phase, settings);
      const remaining = state.running && state.endsAt
        ? Math.max(0, state.endsAt - Date.now())
        : state.remaining;
      const color = PHASE_COLOR[state.phase] || PHASE_COLOR.focus;
      const progress = total > 0 ? clamp(1 - remaining / total, 0, 1) : 0;
      const todayCount = state.today.date === dayKey() ? state.today.count : 0;
      const cycle = Math.max(1, settings.cycle);
      const round = state.phase === 'focus'
        ? Math.min(state.cycleDone, cycle - 1) + 1
        : Math.min(state.cycleDone, cycle);
      const collapsed = !state.expanded;

      const root = useMemo(() => h('style', null, CSS), []);

      const notice = state.notice
        ? h('div', { key: 'notice', className: 'pomo-notice', role: 'status' },
          t(state.notice === 'break' ? 'focusFinished' : 'breakFinished'))
        : null;

      const musicChip = state.music
        ? h('div', { key: 'music', className: 'pomo-music', role: 'status' },
          h('span', { className: 'pomo-eq', 'aria-hidden': 'true' },
            h('i', { key: 'a' }), h('i', { key: 'b' }), h('i', { key: 'c' })),
          h('span', { className: 'pomo-music-text' }, t('musicPlaying')),
          h('button', {
            type: 'button',
            className: 'pomo-music-stop',
            title: t('stopMusic'),
            'aria-label': t('stopMusic'),
            onClick: () => stopMusic(false),
          }, t('stopMusic')),
        )
        : null;

      const pill = h('button', {
        key: 'pill',
        type: 'button',
        className: 'pomo-pill',
        title: t('open'),
        'aria-label': `${t('open')} ${formatClock(remaining)}`,
        onClick: () => store.set({ expanded: true, view: 'timer' }),
      },
        h(TomatoGlyph),
        h('span', { className: 'pomo-pill-time' }, formatClock(remaining)),
        state.running ? h('span', { key: 'pulse', className: 'pomo-pulse', style: { background: color } }) : null,
      );

      const header = h('div', { className: 'pomo-head' },
        h('div', { className: 'pomo-phase' },
          h('span', { className: 'pomo-dot', style: { background: color } }),
          h('span', null, state.view === 'settings' ? t('settings') : t(phaseLabel(state.phase))),
          state.view === 'timer' ? h('span', { className: 'pomo-round' }, `${round}/${cycle}`) : null,
        ),
        h('div', { className: 'pomo-head-actions' },
          state.view === 'settings'
            ? h('button', {
              key: 'back',
              type: 'button',
              className: 'pomo-icon-btn',
              title: t('back'),
              'aria-label': t('back'),
              onClick: () => store.set({ view: 'timer' }),
            }, h(BackIcon))
            : h('button', {
              key: 'settings',
              type: 'button',
              className: 'pomo-icon-btn',
              title: t('settings'),
              'aria-label': t('settings'),
              onClick: () => store.set({ view: 'settings' }),
            }, h(SlidersIcon)),
          h('button', {
            key: 'collapse',
            type: 'button',
            className: 'pomo-icon-btn',
            title: t('collapse'),
            'aria-label': t('collapse'),
            onClick: () => store.set({ expanded: false }),
          }, h(ChevronDownIcon)),
        ),
      );

      const timerView = h('div', { className: 'pomo-body' },
        h('div', { className: 'pomo-ring' },
          h('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' },
            h('circle', {
              key: 'track',
              cx: 60,
              cy: 60,
              r: RING_RADIUS,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l1)',
              strokeWidth: 7,
            }),
            h('circle', {
              key: 'progress',
              cx: 60,
              cy: 60,
              r: RING_RADIUS,
              fill: 'none',
              stroke: color,
              strokeWidth: 7,
              strokeLinecap: 'round',
              strokeDasharray: RING_CIRCUMFERENCE,
              strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress),
              transform: 'rotate(-90 60 60)',
              style: { transition: 'stroke-dashoffset .3s linear, stroke .3s ease' },
            }),
          ),
          h('div', { className: 'pomo-ring-center' },
            h('div', { className: 'pomo-clock', role: 'timer', 'aria-live': 'off' }, formatClock(remaining)),
            h('div', { className: 'pomo-caption' }, t('today', { count: todayCount })),
          ),
        ),
        h('div', { className: 'pomo-controls' },
          h('button', {
            key: 'toggle',
            type: 'button',
            className: 'pomo-primary',
            onClick: toggle,
          }, state.running ? t('pause') : (remaining < total ? t('resume') : t('start'))),
          h('button', {
            key: 'reset',
            type: 'button',
            className: 'pomo-secondary',
            title: t('reset'),
            'aria-label': t('reset'),
            onClick: reset,
          }, h(ResetIcon)),
          h('button', {
            key: 'skip',
            type: 'button',
            className: 'pomo-secondary',
            title: t('skip'),
            'aria-label': t('skip'),
            onClick: skip,
          }, h(SkipIcon)),
        ),
      );

      const durationRows = DURATION_FIELDS.map((field) => {
        const value = settings[field.key];
        return h('div', { className: 'pomo-row', key: field.key },
          h('span', null, t(field.key)),
          h('div', { className: 'pomo-stepper' },
            h('button', {
              key: 'minus',
              type: 'button',
              className: 'pomo-step-btn',
              disabled: value <= field.min,
              'aria-label': `${t('decrease')} ${t(field.key)}`,
              onClick: () => updateSetting(field.key, clamp(value - field.step, field.min, field.max)),
            }, '\u2212'),
            h('span', { key: 'value', className: 'pomo-step-value' }, t('minutes', { value })),
            h('button', {
              key: 'plus',
              type: 'button',
              className: 'pomo-step-btn',
              disabled: value >= field.max,
              'aria-label': `${t('increase')} ${t(field.key)}`,
              onClick: () => updateSetting(field.key, clamp(value + field.step, field.min, field.max)),
            }, '+'),
          ),
        );
      });

      const switchRow = (key, label, checked, onChange) => h('div', { className: 'pomo-row', key },
        h('span', { className: 'pomo-switch-label' }, label),
        h('button', {
          type: 'button',
          role: 'switch',
          className: 'pomo-switch',
          'aria-checked': checked,
          'aria-label': label,
          title: label,
          onClick: onChange,
        }, h('span', { className: 'pomo-knob' })),
      );

      const settingsView = h('div', { className: 'pomo-settings' },
        h('div', { className: 'pomo-section', key: 'durations' }, t('durations')),
        durationRows,
        h('div', { className: 'pomo-section', key: 'options' }, t('options')),
        switchRow('autoStart', t('autoStart'), settings.autoStart, () => updateSetting('autoStart', !settings.autoStart)),
        switchRow('sound', t('sound'), settings.sound, () => updateSetting('sound', !settings.sound)),
      );

      const card = h('div', {
        key: 'card',
        className: 'pomo-card',
        role: 'region',
        'aria-label': t('label'),
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            store.set({ expanded: false, view: 'timer' });
          }
        },
      }, header, state.view === 'settings' ? settingsView : timerView);

      return h('div', {
        className: 'pomo-root',
        onPointerDown: () => ensureAudio(),
      }, root, collapsed ? pill : card, notice, musicChip);
    }

    /* ------------------------------------------------------------------ CSS */

    const CSS = `
.pomo-root{position:fixed;right:16px;top:16px;z-index:70;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.pomo-root *{box-sizing:border-box;font-family:inherit}
.pomo-pill{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:6px 12px 6px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:inherit;cursor:pointer;font:inherit;box-shadow:0 6px 20px rgba(0,0,0,.16);transition:border-color .15s ease,box-shadow .15s ease}
.pomo-pill:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 8px 24px rgba(0,0,0,.2)}
.pomo-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pomo-pill-time{font-variant-numeric:tabular-nums;font-weight:600;letter-spacing:.3px}
.pomo-pulse{width:6px;height:6px;border-radius:50%;animation:pomo-pulse 1.6s ease-in-out infinite}
@keyframes pomo-pulse{0%,100%{opacity:.3}50%{opacity:1}}
.pomo-card{pointer-events:auto;width:238px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:inherit;box-shadow:0 14px 36px rgba(0,0,0,.18);overflow:hidden}
.pomo-head{display:flex;align-items:center;gap:6px;padding:9px 8px 7px 12px}
.pomo-phase{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;min-width:0}
.pomo-dot{width:7px;height:7px;border-radius:50%;flex:none}
.pomo-round{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.pomo-head-actions{margin-left:auto;display:flex;gap:2px;flex:none}
.pomo-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pomo-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pomo-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pomo-body{display:flex;flex-direction:column;align-items:center;gap:10px;padding:0 12px 12px}
.pomo-ring{position:relative;width:148px;height:148px}
.pomo-ring svg{display:block;width:100%;height:100%}
.pomo-ring-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
.pomo-clock{font-size:29px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.5px}
.pomo-caption{font-size:11px;color:var(--dsw-alias-label-secondary)}
.pomo-controls{display:flex;align-items:center;gap:8px;width:100%}
.pomo-primary{flex:1;height:34px;border:0;border-radius:10px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.pomo-primary:hover{filter:brightness(1.06)}
.pomo-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pomo-secondary{flex:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pomo-secondary:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.pomo-secondary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pomo-settings{display:flex;flex-direction:column;gap:8px;padding:2px 12px 12px}
.pomo-section{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:4px 0 2px}
.pomo-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;min-height:24px}
.pomo-switch-label{flex:1;min-width:0}
.pomo-stepper{display:flex;align-items:center;gap:2px;flex:none}
.pomo-step-btn{width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.pomo-step-btn:hover:not([disabled]){border-color:var(--dsw-alias-border-l2)}
.pomo-step-btn[disabled]{opacity:.35;cursor:default}
.pomo-step-value{min-width:56px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.pomo-switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.pomo-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.pomo-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pomo-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}
.pomo-switch[aria-checked="true"] .pomo-knob{transform:translateX(14px);background:var(--dsw-alias-bg-base)}
.pomo-notice{pointer-events:none;max-width:240px;padding:8px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 10px 28px rgba(0,0,0,.18);animation:pomo-notice-in .2s ease-out}
@keyframes pomo-notice-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.pomo-music{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 10px 28px rgba(0,0,0,.18);animation:pomo-notice-in .2s ease-out}
.pomo-eq{display:flex;align-items:flex-end;gap:2px;height:12px;transform-origin:bottom}
.pomo-eq i{display:block;width:2.5px;border-radius:2px;background:var(--dsw-alias-brand-primary);transform-origin:bottom;animation:pomo-eq 1s ease-in-out infinite}
.pomo-eq i:nth-child(1){height:6px;animation-delay:-.2s}
.pomo-eq i:nth-child(2){height:11px;animation-delay:-.5s}
.pomo-eq i:nth-child(3){height:8px;animation-delay:-.8s}
@keyframes pomo-eq{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}
.pomo-music-text{white-space:nowrap}
.pomo-music-stop{flex:none;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer}
.pomo-music-stop:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.pomo-music-stop:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;

    /* ------------------------------------------------------------------ run */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        context = ctx;
        ensureStore();

        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'en', DICT.en),
            ctx.locale.register(NS, 'zh', DICT.zh),
          ];
          return () => {
            disposers.forEach((dispose) => {
              try {
                dispose();
              } catch (error) {
                /* already disposed */
              }
            });
          };
        }, 'pomodoro locale');

        ctx.effect(() => {
          if (engineTimer) window.clearInterval(engineTimer);
          engineTimer = window.setInterval(tick, TICK_MS);
          unsubscribePersist = store.subscribe(scheduleSave);
          document.addEventListener('visibilitychange', onVisibilityChange);
          tick();
          return () => {
            if (engineTimer) {
              window.clearInterval(engineTimer);
              engineTimer = 0;
            }
            if (noticeTimer) {
              window.clearTimeout(noticeTimer);
              noticeTimer = 0;
            }
            if (persistTimer) {
              window.clearTimeout(persistTimer);
              persistTimer = 0;
            }
            if (unsubscribePersist) {
              unsubscribePersist();
              unsubscribePersist = null;
            }
            document.removeEventListener('visibilitychange', onVisibilityChange);
            stopMusic(true);
            save();
          };
        }, 'pomodoro engine');

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'pomodoro-timer',
          order: 20,
          label: () => translate('label'),
        }, PomodoroWidget)), 'pomodoro slot');
      },
    };
  },
});
