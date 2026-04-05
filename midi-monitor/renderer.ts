/**
 * Pattern rendering utilities for TUI widget and LLM text output.
 */

import type { PatternData } from "./ipc.js";

export interface ChannelConfig {
	channel: number;
	name: string;
	type: "bass" | "lead" | "drums" | "pad" | "fx" | "other";
	patternLength?: number;
}

const DRUM_ICONS: Record<string, string> = {
	// General MIDI drum map (common ones)
	C1: "K",  // Kick
	"C#1": "K", // Kick variant
	D1: "S",  // Snare
	"D#1": "S",
	E1: "S",  // Snare variant
	"F#1": "H", // Hi-hat closed
	"G#1": "H", // Hi-hat open
	"A#1": "H", // Hi-hat
	"C#2": "C", // Crash
	"D#2": "R", // Ride
	// Also map by note name for flexibility
	C2: "K",
	D2: "S",
	F2: "H",
	A2: "C",
};

const TYPE_EMOJI: Record<string, string> = {
	bass: "🎵",
	lead: "🎹",
	drums: "🥁",
	pad: "🎶",
	fx: "✨",
	other: "🔊",
};

/**
 * Render a single channel pattern as a compact step-sequencer line.
 */
export function renderPatternLine(
	pattern: PatternData,
	config: ChannelConfig | undefined,
	maxWidth: number,
): string {
	const emoji = config ? (TYPE_EMOJI[config.type] || "🔊") : "🔊";
	const label = config?.name ?? `Ch${pattern.channel}`;
	const isDrums = config?.type === "drums";

	// Build prefix
	const prefix = `${emoji} Ch${pattern.channel.toString().padStart(2)} ${label.padEnd(10).slice(0, 10)} │ `;

	const stepsAvailable = maxWidth - prefix.length;
	const cellWidth = isDrums ? 2 : 3; // drums are compact
	const maxSteps = Math.min(pattern.pattern_length, Math.floor(stepsAvailable / cellWidth));

	let cells = "";
	for (let i = 0; i < maxSteps; i++) {
		const step = pattern.steps[i];
		if (!step || step.notes.length === 0) {
			cells += isDrums ? "··" : " ·· ";
		} else if (isDrums) {
			// Show drum icon for first note
			const noteName = step.notes[0].note_name;
			const icon = DRUM_ICONS[noteName] ?? "x";
			cells += icon + (step.notes.length > 1 ? "+" : "·");
		} else {
			// Show note name (pad to 3 chars)
			const name = step.notes[0].note_name;
			cells += name.padEnd(4).slice(0, 4);
		}
	}

	return prefix + cells;
}

/**
 * Render all patterns as widget lines.
 */
export function renderWidget(
	patterns: Record<string, PatternData>,
	channelConfigs: Map<number, ChannelConfig>,
	status: { playing: boolean; bpm: number },
	maxWidth: number,
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
			lines.push(renderPatternLine(pat, config, maxWidth));
			rendered.add(chNum);
		}
	}

	// Unconfigured channels with notes
	for (const [chKey, pat] of Object.entries(patterns)) {
		const chNum = parseInt(chKey);
		if (!rendered.has(chNum) && pat.has_notes) {
			lines.push(renderPatternLine(pat, undefined, maxWidth));
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
