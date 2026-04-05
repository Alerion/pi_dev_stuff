/**
 * MIDI Monitor Engine — pure TypeScript replacement for midi_monitor.py.
 *
 * Uses @julusian/midi (RtMidi bindings) to listen for MIDI input,
 * track clock/transport, and detect repeating step-sequencer patterns.
 */

import midi from "@julusian/midi";

// --- Constants ---
const PPQN = 24; // MIDI clock pulses per quarter note
const STEPS_PER_BEAT = 4; // 16th note grid
const CLOCKS_PER_STEP = PPQN / STEPS_PER_BEAT; // 6 clocks per 16th note
const MAX_PATTERN_STEPS = 64;
const DEFAULT_PATTERN_STEPS = 16;
const BPM_AVERAGE_CLOCKS = 96; // 4 beats for averaging

// --- MIDI status bytes ---
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CLOCK = 0xf8;
const START = 0xfa;
const CONTINUE = 0xfb;
const STOP = 0xfc;

// --- Types (shared with the extension) ---

export interface NoteInfo {
	note: number;
	note_name: string;
	velocity: number;
	gate_pct: number;
}

export interface PatternStep {
	step: number;
	notes: NoteInfo[];
}

export interface PatternData {
	channel: number;
	steps: PatternStep[];
	pattern_length: number;
	loop_count: number;
	has_notes: boolean;
}

export interface MonitorStatus {
	playing: boolean;
	bpm: number;
	global_step: number;
	clock_count: number;
	input_ports: string[];
	active_channels: number[];
	channels_with_notes: number[];
}

export interface MidiDevices {
	inputs: string[];
	outputs: string[];
	active_inputs: string[];
}

// --- Helpers ---

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(midiNote: number): string {
	const octave = Math.floor(midiNote / 12) - 1;
	return `${NOTE_NAMES[midiNote % 12]}${octave}`;
}

// --- Note Event ---

interface NoteEvent {
	note: number;
	velocity: number;
	step: number;
	gateClocks: number;
}

function noteEventToInfo(e: NoteEvent): NoteInfo {
	return {
		note: e.note,
		note_name: noteName(e.note),
		velocity: e.velocity,
		gate_pct: e.gateClocks > 0 ? Math.min(100, Math.round((e.gateClocks / CLOCKS_PER_STEP) * 100)) : 50,
	};
}

// --- Channel Tracker ---

class ChannelTracker {
	channel: number;
	patternSteps: number = DEFAULT_PATTERN_STEPS;

	// Current loop's raw note events (step -> NoteEvent[])
	private currentEvents = new Map<number, NoteEvent[]>();
	// Last completed pattern (frozen after loop detection)
	private pattern: Map<number, NoteInfo[]> | null = null;
	// Active notes: noteNumber -> startStep
	private activeNotes = new Map<number, number>();
	// Loop pass counter
	loopCount = 0;
	// Previous loop's snapshot for comparison
	private prevSnapshot: Map<number, NoteInfo[]> | null = null;

	constructor(channel: number) {
		this.channel = channel;
	}

	noteOn(note: number, velocity: number, step: number) {
		if (velocity === 0) {
			this.noteOff(note, step);
			return;
		}
		this.activeNotes.set(note, step);
		const targetStep = step % this.patternSteps;
		const evt: NoteEvent = { note, velocity, step: targetStep, gateClocks: 0 };
		const list = this.currentEvents.get(targetStep);
		if (list) list.push(evt);
		else this.currentEvents.set(targetStep, [evt]);
	}

	noteOff(note: number, step: number) {
		const startStep = this.activeNotes.get(note);
		if (startStep === undefined) return;
		this.activeNotes.delete(note);

		const targetStep = startStep % this.patternSteps;
		const list = this.currentEvents.get(targetStep);
		if (!list) return;
		// Find the matching event (last one with same note and no gate yet)
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i].note === note && list[i].gateClocks === 0) {
				const gateSteps = step - startStep;
				list[i].gateClocks = Math.max(1, gateSteps * CLOCKS_PER_STEP);
				break;
			}
		}
	}

	onLoopBoundary() {
		// Snapshot current events
		const snapshot = new Map<number, NoteInfo[]>();
		for (const [step, events] of this.currentEvents) {
			if (step < this.patternSteps) {
				snapshot.set(step, events.map(noteEventToInfo));
			}
		}

		if (this.prevSnapshot !== null) {
			if (this.patternsMatch(this.prevSnapshot, snapshot)) {
				this.loopCount++;
			} else {
				this.loopCount = 1;
			}
		} else {
			this.loopCount = 1;
		}

		this.pattern = snapshot;
		this.prevSnapshot = snapshot;
		this.currentEvents = new Map();
		this.activeNotes = new Map();
	}

	private patternsMatch(a: Map<number, NoteInfo[]>, b: Map<number, NoteInfo[]>): boolean {
		const keysA = new Set(a.keys());
		const keysB = new Set(b.keys());
		if (keysA.size !== keysB.size) return false;
		for (const k of keysA) {
			if (!keysB.has(k)) return false;
			const notesA = (a.get(k) ?? []).map((n) => `${n.note}:${n.velocity}`).sort();
			const notesB = (b.get(k) ?? []).map((n) => `${n.note}:${n.velocity}`).sort();
			if (notesA.length !== notesB.length) return false;
			for (let i = 0; i < notesA.length; i++) {
				if (notesA[i] !== notesB[i]) return false;
			}
		}
		return true;
	}

	getPatternData(): PatternData {
		// Use completed pattern, or in-progress events if none yet
		let source: Map<number, NoteInfo[]>;
		if (this.pattern) {
			source = this.pattern;
		} else {
			source = new Map();
			for (const [step, events] of this.currentEvents) {
				if (step < this.patternSteps) {
					source.set(step, events.map(noteEventToInfo));
				}
			}
		}

		const steps: PatternStep[] = [];
		let hasNotes = false;
		for (let s = 0; s < this.patternSteps; s++) {
			const notes = source.get(s) ?? [];
			if (notes.length > 0) hasNotes = true;
			steps.push({ step: s + 1, notes });
		}

		return {
			channel: this.channel,
			steps,
			pattern_length: this.patternSteps,
			loop_count: this.loopCount,
			has_notes: hasNotes,
		};
	}
}

// --- Main MIDI Monitor ---

export class MidiMonitor {
	private channels = new Map<number, ChannelTracker>();
	private inputs: midi.Input[] = [];
	private inputPortNames: string[] = [];

	playing = false;
	private clockCount = 0;
	private globalStep = 0;
	bpm = 0;
	private lastClockTime: number | null = null;
	private clockIntervals: number[] = [];

	private getOrCreateChannel(ch: number): ChannelTracker {
		let tracker = this.channels.get(ch);
		if (!tracker) {
			tracker = new ChannelTracker(ch);
			this.channels.set(ch, tracker);
		}
		return tracker;
	}

	/**
	 * Open MIDI input ports. If names is undefined, auto-detect BeatStep Pro ports.
	 */
	openPorts(portNames?: string[]): string[] {
		this.closePorts();

		// Enumerate available inputs
		const probe = new midi.Input();
		const count = probe.getPortCount();
		const available: string[] = [];
		for (let i = 0; i < count; i++) {
			available.push(probe.getPortName(i));
		}
		probe.closePort();

		// Pick which to open
		const toOpen =
			portNames ??
			available.filter((p) => p.includes("BeatStep Pro") || p.includes("Arturia BeatStep"));

		const opened: string[] = [];
		for (const name of toOpen) {
			const idx = available.indexOf(name);
			if (idx < 0) continue;
			try {
				const inp = new midi.Input();
				// Receive sysex=false, timing/clock=true, active-sensing=false
				inp.ignoreTypes(true, false, true);
				inp.on("message", (_dt, msg) => this.onMessage(msg));
				inp.openPort(idx);
				this.inputs.push(inp);
				opened.push(name);
			} catch (err: any) {
				console.error(`[midi-monitor] Could not open ${name}: ${err.message}`);
			}
		}

		this.inputPortNames = opened;
		return opened;
	}

	closePorts() {
		for (const inp of this.inputs) {
			try {
				inp.closePort();
			} catch {}
		}
		this.inputs = [];
		this.inputPortNames = [];
	}

	// --- Message handling ---

	private onMessage(msg: number[]) {
		if (msg.length === 0) return;
		const status = msg[0];

		if (status === CLOCK) {
			this.onClock();
		} else if (status === START) {
			this.onStart();
		} else if (status === STOP) {
			this.onStop();
		} else if (status === CONTINUE) {
			this.playing = true;
		} else if ((status & 0xf0) === NOTE_ON && msg.length >= 3) {
			const ch = (status & 0x0f) + 1; // 1-indexed
			this.getOrCreateChannel(ch).noteOn(msg[1], msg[2], this.globalStep);
		} else if ((status & 0xf0) === NOTE_OFF && msg.length >= 3) {
			const ch = (status & 0x0f) + 1;
			this.getOrCreateChannel(ch).noteOff(msg[1], this.globalStep);
		}
	}

	private onStart() {
		this.playing = true;
		this.clockCount = 0;
		this.globalStep = 0;
		this.lastClockTime = performance.now();
		this.clockIntervals = [];
		for (const ch of this.channels.values()) {
			ch.onLoopBoundary();
		}
	}

	private onStop() {
		this.playing = false;
		for (const ch of this.channels.values()) {
			ch.onLoopBoundary();
		}
	}

	private onClock() {
		if (!this.playing) return;

		const now = performance.now();

		// BPM calculation
		if (this.lastClockTime !== null) {
			const dt = now - this.lastClockTime;
			this.clockIntervals.push(dt);
			if (this.clockIntervals.length > BPM_AVERAGE_CLOCKS) {
				this.clockIntervals = this.clockIntervals.slice(-BPM_AVERAGE_CLOCKS);
			}
			if (this.clockIntervals.length >= PPQN) {
				const avg = this.clockIntervals.reduce((a, b) => a + b, 0) / this.clockIntervals.length;
				this.bpm = Math.round((60000 / (avg * PPQN)) * 10) / 10;
			}
		}
		this.lastClockTime = now;

		this.clockCount++;

		if (this.clockCount % CLOCKS_PER_STEP === 0) {
			this.globalStep++;

			for (const ch of this.channels.values()) {
				const currentStep = this.globalStep % ch.patternSteps;
				if (currentStep === 0 && this.globalStep > 0) {
					ch.onLoopBoundary();
				}
			}
		}
	}

	// --- Public API ---

	getAllPatterns(): Record<string, PatternData> {
		const result: Record<string, PatternData> = {};
		for (const [chNum, ch] of [...this.channels.entries()].sort((a, b) => a[0] - b[0])) {
			const data = ch.getPatternData();
			if (data.has_notes) {
				result[chNum.toString()] = data;
			}
		}
		return result;
	}

	getPattern(channel: number): PatternData {
		const ch = this.channels.get(channel);
		if (ch) return ch.getPatternData();
		return {
			channel,
			steps: [],
			pattern_length: DEFAULT_PATTERN_STEPS,
			loop_count: 0,
			has_notes: false,
		};
	}

	getStatus(): MonitorStatus {
		const channelsWithNotes: number[] = [];
		for (const [chNum, ch] of this.channels) {
			if (ch.getPatternData().has_notes) channelsWithNotes.push(chNum);
		}
		return {
			playing: this.playing,
			bpm: this.bpm,
			global_step: this.globalStep,
			clock_count: this.clockCount,
			input_ports: this.inputPortNames,
			active_channels: [...this.channels.keys()].sort((a, b) => a - b),
			channels_with_notes: channelsWithNotes.sort((a, b) => a - b),
		};
	}

	getDevices(): MidiDevices {
		const inProbe = new midi.Input();
		const inCount = inProbe.getPortCount();
		const inputs: string[] = [];
		for (let i = 0; i < inCount; i++) inputs.push(inProbe.getPortName(i));
		inProbe.closePort();

		const outProbe = new midi.Output();
		const outCount = outProbe.getPortCount();
		const outputs: string[] = [];
		for (let i = 0; i < outCount; i++) outputs.push(outProbe.getPortName(i));
		outProbe.closePort();

		return {
			inputs,
			outputs,
			active_inputs: [...this.inputPortNames],
		};
	}

	setPatternLength(channel: number, length: number) {
		const ch = this.getOrCreateChannel(channel);
		ch.patternSteps = Math.min(MAX_PATTERN_STEPS, Math.max(1, length));
	}
}
