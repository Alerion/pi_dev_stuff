/**
 * Pattern rendering utilities for TUI widget and LLM text output.
 */

import type { PatternData } from "./midi-engine.js";

export interface ChannelConfig {
	channel: number;
	name: string;
	type: "bass" | "lead" | "drums" | "pad" | "fx" | "other";
	patternLength?: number;
}

// BeatStep Pro drum pad default mapping (can be customized)
// BSP drum pads send notes starting from C1 (36) by default
const DRUM_NAMES: Record<number, string> = {
	36: "Kick",        // C1  - Pad 1
	37: "Snare",       // C#1 - Pad 2
	38: "HiHat",       // D1  - Pad 3
	39: "HiHat Op",    // D#1 - Pad 4
	40: "Tom",         // E1  - Pad 5
	41: "Clap",        // F1  - Pad 6
	42: "Rim",         // F#1 - Pad 7
	43: "Bell",        // G1  - Pad 8
	44: "Perc 1",      // G#1 - Pad 9
	45: "Perc 2",      // A1  - Pad 10
	46: "Perc 3",      // A#1 - Pad 11
	47: "Perc 4",      // B1  - Pad 12
	48: "Kick Alt",    // C2  - Pad 13
	49: "Snare Alt",   // C#2 - Pad 14
	50: "HiHat Alt",   // D2  - Pad 15
	51: "Ride",        // D#2 - Pad 16
};

function drumName(midiNote: number, noteName: string): string {
	return DRUM_NAMES[midiNote] ?? noteName;
}

/**
 * Callback that applies visual weight to text based on MIDI velocity.
 * When not provided, text is returned unstyled.
 */
export type VelocityStyler = (text: string, velocity: number) => string;

const noStyle: VelocityStyler = (text) => text;

const TYPE_EMOJI: Record<string, string> = {
	bass: "🎵",
	lead: "🎹",
	drums: "🥁",
	pad: "🎶",
	fx: "✨",
	other: "🔊",
};

// Standard prefix width for all channel lines
const LABEL_WIDTH = 10;
const CELL_WIDTH = 4;

// Beat markers on downbeats (1, 5, 9, 13)
const BEAT_MARKERS = new Set([1, 5, 9, 13]);

function makePrefix(emoji: string, channel: number, label: string): string {
	return `${emoji} Ch${channel.toString().padStart(2)} ${label.padEnd(LABEL_WIDTH).slice(0, LABEL_WIDTH)} │ `;
}

function calcMaxSteps(prefixLen: number, maxWidth: number, patternLength: number): number {
	const stepsAvailable = maxWidth - prefixLen;
	return Math.min(patternLength, Math.floor(stepsAvailable / CELL_WIDTH));
}

/**
 * Render a single channel pattern as a compact step-sequencer line.
 */
export function renderPatternLine(
	pattern: PatternData,
	config: ChannelConfig | undefined,
	maxWidth: number,
	style: VelocityStyler = noStyle,
): string {
	const emoji = config ? (TYPE_EMOJI[config.type] || "🔊") : "🔊";
	const label = config?.name ?? `Ch${pattern.channel}`;
	const prefix = makePrefix(emoji, pattern.channel, label);
	const maxSteps = calcMaxSteps(prefix.length, maxWidth, pattern.pattern_length);

	let cells = "";
	for (let i = 0; i < maxSteps; i++) {
		const step = pattern.steps[i];
		if (!step || step.notes.length === 0) {
			cells += " ·  ";
		} else {
			const note = step.notes[0];
			const raw = note.note_name.padEnd(4).slice(0, 4);
			cells += style(raw, note.velocity);
		}
	}

	return prefix + cells;
}

/**
 * Render a drum channel as a tree: header row + one sub-row per active instrument.
 * Each sub-row shows hits as "x" and empty steps as "·".
 */
export function renderDrumLines(
	pattern: PatternData,
	config: ChannelConfig | undefined,
	maxWidth: number,
	style: VelocityStyler = noStyle,
): string[] {
	const emoji = TYPE_EMOJI.drums;
	const label = config?.name ?? `Ch${pattern.channel}`;

	// Collect all active MIDI notes across the pattern (with velocity per step)
	const activeNotes = new Map<number, { noteName: string; steps: Map<number, number> }>();
	for (const step of pattern.steps) {
		for (const note of step.notes) {
			let entry = activeNotes.get(note.note);
			if (!entry) {
				entry = { noteName: note.note_name, steps: new Map() };
				activeNotes.set(note.note, entry);
			}
			entry.steps.set(step.step, note.velocity); // 1-indexed step -> velocity
		}
	}

	if (activeNotes.size === 0) {
		return []; // No drum hits, skip entirely
	}

	// Sort by MIDI note number
	const sortedNotes = [...activeNotes.entries()].sort((a, b) => a[0] - b[0]);

	const headerPrefix = makePrefix(emoji, pattern.channel, label);
	const maxSteps = calcMaxSteps(headerPrefix.length, maxWidth, pattern.pattern_length);

	// Beat ruler on the drum header row
	let ruler = "";
	for (let i = 1; i <= maxSteps; i++) {
		if (BEAT_MARKERS.has(i)) {
			ruler += " ▼  ";
		} else {
			ruler += "    ";
		}
	}

	const lines: string[] = [];
	lines.push(headerPrefix + ruler);

	// Sub-rows: " ├ Kick (36)     │ "
	for (let idx = 0; idx < sortedNotes.length; idx++) {
		const [midiNote, entry] = sortedNotes[idx];
		const isLast = idx === sortedNotes.length - 1;
		const branch = isLast ? "└" : "├";
		const name = drumName(midiNote, entry.noteName);
		const subLabel = `${name} (${midiNote})`;
		const subPrefix = `${branch} ${subLabel.padEnd(16).slice(0, 16)} │ `;

		let cells = "";
		for (let i = 1; i <= maxSteps; i++) {
			const vel = entry.steps.get(i);
			if (vel !== undefined) {
				cells += style(" x  ", vel);
			} else {
				cells += " ·  ";
			}
		}

		lines.push(subPrefix + cells);
	}

	return lines;
}

/**
 * Render all patterns as widget lines.
 */
export function renderWidget(
	patterns: Record<string, PatternData>,
	channelConfigs: Map<number, ChannelConfig>,
	status: { playing: boolean; bpm: number },
	maxWidth: number,
	style: VelocityStyler = noStyle,
): string[] {
	const lines: string[] = [];

	// Header
	const playIcon = status.playing ? "▶" : "⏹";
	const bpmStr = status.bpm > 0 ? ` ${status.bpm} BPM` : "";
	lines.push(`${playIcon}${bpmStr}  MIDI Monitor`);

	// Render each configured channel, then any unconfigured ones
	const rendered = new Set<number>();

	// Configured channels first, in order
	for (const [chNum, config] of [...channelConfigs.entries()].sort((a, b) => a[0] - b[0])) {
		const pat = patterns[chNum.toString()];
		if (pat && pat.has_notes) {
			if (config.type === "drums") {
				lines.push(...renderDrumLines(pat, config, maxWidth, style));
			} else {
				lines.push(renderPatternLine(pat, config, maxWidth, style));
			}
			rendered.add(chNum);
		}
	}

	// Unconfigured channels with notes
	for (const [chKey, pat] of Object.entries(patterns)) {
		const chNum = parseInt(chKey);
		if (!rendered.has(chNum) && pat.has_notes) {
			lines.push(renderPatternLine(pat, undefined, maxWidth, style));
		}
	}

	if (lines.length === 1) {
		lines.push("  No patterns detected yet. Press play on BeatStep Pro.");
	}

	return lines;
}

/**
 * Render a pattern as detailed text for LLM consumption.
 */
export function renderPatternText(
	pattern: PatternData,
	config: ChannelConfig | undefined,
): string {
	const label = config?.name ?? `Channel ${pattern.channel}`;
	const type = config?.type ?? "unknown";
	const lines: string[] = [];

	lines.push(`## ${label} (Channel ${pattern.channel}, type: ${type})`);
	lines.push(`Pattern length: ${pattern.pattern_length} steps | Loops detected: ${pattern.loop_count}`);
	lines.push("");
	lines.push("```");
	lines.push("Step | Note     | Vel | Gate");
	lines.push("-----|----------|-----|-----");

	for (const step of pattern.steps) {
		const stepNum = step.step.toString().padStart(4);
		if (step.notes.length === 0) {
			lines.push(`${stepNum} | --       |     |`);
		} else {
			for (const note of step.notes) {
				const noteName = note.note_name.padEnd(8);
				const vel = note.velocity.toString().padStart(3);
				const gate = `${note.gate_pct}%`.padStart(4);
				lines.push(`${stepNum} | ${noteName} | ${vel} | ${gate}`);
			}
		}
	}

	lines.push("```");
	return lines.join("\n");
}
