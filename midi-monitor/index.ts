/**
 * MIDI Monitor Extension for pi.
 *
 * Monitors BeatStep Pro MIDI input, extracts patterns,
 * displays them in a TUI widget, and provides tools for
 * the LLM to read and discuss patterns.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { MidiMonitor, noteName, type PatternData, type NoteInfo, type PatternStep, type MonitorStatus, type MidiDevices } from "./midi-engine.js";
import { type ChannelConfig, type VelocityStyler, renderWidget, renderPatternText, renderPatternLine, renderDrumLines } from "./renderer.js";

/** Parse a note name like "C3", "C#2", "Db1" to a MIDI note number. Returns -1 if invalid. */
function parseNoteToMidi(name: string): number {
	const NOTE_MAP: Record<string, number> = {
		"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "Fb": 4,
		"F": 5, "E#": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8,
		"A": 9, "A#": 10, "Bb": 10, "B": 11, "Cb": 11,
	};
	const m = name.trim().match(/^([A-Ga-g][#b]?)(\-?\d+)$/);
	if (!m) return -1;
	const pc = NOTE_MAP[m[1][0].toUpperCase() + m[1].slice(1)];
	if (pc === undefined) return -1;
	const octave = parseInt(m[2]);
	const midi = (octave + 1) * 12 + pc;
	return (midi >= 0 && midi <= 127) ? midi : -1;
}

// Session entry types
interface ChannelConfigEntry {
	configs: Record<number, ChannelConfig>;
}

interface ProjectEntry {
	name: string;
	configs: Record<number, ChannelConfig>;
}

export default function midiMonitorExtension(pi: ExtensionAPI) {
	let monitor: MidiMonitor | null = null;

	// Default channel config for BeatStep Pro (Seq1=Ch1, Seq2=Ch2, Drum=Ch10)
	let channelConfigs = new Map<number, ChannelConfig>([
		[1, { channel: 1, name: "Bass", type: "bass", patternLength: 16 }],
		[2, { channel: 2, name: "Lead", type: "lead", patternLength: 16 }],
		[10, { channel: 10, name: "Drums", type: "drums", patternLength: 16 }],
	]);
	let projectName = "";
	let widgetInterval: ReturnType<typeof setInterval> | null = null;
	let widgetEnabled = true;
	let currentCtx: ExtensionContext | null = null;

	// --- Monitor Management ---

	function startMonitor(): boolean {
		if (monitor) return true;

		try {
			monitor = new MidiMonitor();
			const opened = monitor.openPorts(); // auto-detect BeatStep Pro
			console.error(`[midi-monitor] Opened ports: ${JSON.stringify(opened)}`);
			return true;
		} catch (err: any) {
			console.error(`[midi-monitor] Failed to start: ${err.message}`);
			monitor = null;
			return false;
		}
	}

	function stopMonitor() {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
		}
		if (monitor) {
			monitor.closePorts();
			monitor = null;
		}
	}

	// --- Widget ---

	function updateWidget() {
		if (!monitor || !currentCtx?.hasUI || !widgetEnabled) return;

		try {
			const patterns = monitor.getAllPatterns();
			const status = { playing: monitor.playing, bpm: monitor.bpm };
			// Use factory function to bypass pi's 10-line widget limit
			// and to get access to theme for velocity styling
			currentCtx.ui.setWidget("midi-monitor", (_tui: unknown, theme: Theme) => {
				const style: VelocityStyler = (text, velocity) => {
					if (velocity <= 50) return theme.fg("dim", text);
					if (velocity > 100) return theme.bold(theme.fg("warning", text));
					return text;
				};
				const lines = renderWidget(patterns, channelConfigs, status, 120, style);
				const container = new Container();
				for (const line of lines) {
					container.addChild(new Text(line, 1, 0));
				}
				return container;
			});
		} catch {
			// Monitor may be restarting
		}
	}

	function startWidget() {
		if (widgetInterval) clearInterval(widgetInterval);
		widgetInterval = setInterval(updateWidget, 2000);
		updateWidget();
	}

	// --- State Persistence ---

	function persistConfig() {
		const configs: Record<number, ChannelConfig> = {};
		for (const [ch, cfg] of channelConfigs) {
			configs[ch] = cfg;
		}
		pi.appendEntry<ChannelConfigEntry>("midi-channel-config", { configs });
		if (projectName) {
			pi.appendEntry<ProjectEntry>("midi-project", { name: projectName, configs });
		}
	}

	const DEFAULT_CONFIGS = new Map<number, ChannelConfig>([
		[1, { channel: 1, name: "Bass", type: "bass", patternLength: 16 }],
		[2, { channel: 2, name: "Lead", type: "lead", patternLength: 16 }],
		[10, { channel: 10, name: "Drums", type: "drums", patternLength: 16 }],
	]);

	function restoreConfig(ctx: ExtensionContext) {
		channelConfigs = new Map(DEFAULT_CONFIGS);
		projectName = "";

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom") {
				if (entry.customType === "midi-channel-config") {
					const data = entry.data as ChannelConfigEntry;
					if (data?.configs) {
						channelConfigs.clear();
						for (const [ch, cfg] of Object.entries(data.configs)) {
							channelConfigs.set(parseInt(ch), cfg);
						}
					}
				}
				if (entry.customType === "midi-project") {
					const data = entry.data as ProjectEntry;
					if (data?.name) projectName = data.name;
					if (data?.configs) {
						channelConfigs.clear();
						for (const [ch, cfg] of Object.entries(data.configs)) {
							channelConfigs.set(parseInt(ch), cfg);
						}
					}
				}
			}
		}
	}

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		restoreConfig(ctx);

		const started = startMonitor();
		if (started && monitor) {
			// Apply pattern lengths from config
			for (const [ch, cfg] of channelConfigs) {
				if (cfg.patternLength) {
					monitor.setPatternLength(ch, cfg.patternLength);
				}
			}
			if (ctx.hasUI) {
				startWidget();
				ctx.ui.notify(
					"MIDI Monitor started. Press SHIFT+Play on BeatStep Pro to restart all sequences for pattern detection.",
					"info",
				);
			}
		} else {
			if (ctx.hasUI) {
				ctx.ui.notify("MIDI monitor failed to start. Check pi's stderr log for details.", "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		stopMonitor();
		currentCtx = null;
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreConfig(ctx);
	});

	// --- Keyboard Shortcut ---

	pi.registerShortcut("ctrl+shift+m", {
		description: "Toggle MIDI monitor widget",
		handler: async (ctx) => {
			widgetEnabled = !widgetEnabled;
			if (widgetEnabled) {
				startWidget();
				ctx.ui.notify("MIDI widget enabled", "info");
			} else {
				if (widgetInterval) clearInterval(widgetInterval);
				ctx.ui.setWidget("midi-monitor", undefined);
				ctx.ui.notify("MIDI widget hidden", "info");
			}
		},
	});

	// --- Tools ---

	pi.registerTool({
		name: "midi_list_devices",
		label: "MIDI Devices",
		description: "List available MIDI input/output ports and which ones are currently monitored",
		promptSnippet: "List MIDI devices connected to the system",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!monitor) {
				return {
					content: [{ type: "text", text: "MIDI monitor is not running. It starts automatically on session start." }],
					details: {},
				};
			}

			const devices = monitor.getDevices();
			const lines = [
				"## MIDI Devices",
				"",
				"### Inputs (receiving from):",
				...devices.inputs.map((p) => {
					const active = devices.active_inputs.includes(p) ? " ✅ (monitoring)" : "";
					return `- ${p}${active}`;
				}),
				"",
				"### Outputs (sending to):",
				...devices.outputs.map((p) => `- ${p}`),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: devices,
			};
		},
	});

	pi.registerTool({
		name: "midi_channel_config",
		label: "MIDI Channel Config",
		description:
			"Configure MIDI channel assignments. Set which instrument/role each channel has (e.g., channel 1 = acid bass, channel 10 = drums). " +
			"Use action 'set' to assign a channel, 'list' to show current config, 'remove' to unassign.",
		promptSnippet: "Configure MIDI channel assignments (bass, lead, drums, etc.)",
		parameters: Type.Object({
			action: StringEnum(["set", "list", "remove"] as const),
			channel: Type.Optional(Type.Number({ description: "MIDI channel number (1-16)" })),
			name: Type.Optional(Type.String({ description: "Instrument name, e.g. 'acid bass', 'lead synth'" })),
			type: Type.Optional(StringEnum(["bass", "lead", "drums", "pad", "fx", "other"] as const)),
			pattern_length: Type.Optional(
				Type.Number({ description: "Pattern length in steps (16, 32, or 64). Default: 16" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				if (channelConfigs.size === 0) {
					return {
						content: [{ type: "text", text: "No channels configured yet. Use action 'set' to assign instruments to channels." }],
						details: { configs: {} },
					};
				}
				const lines = [`## Channel Configuration${projectName ? ` (Project: ${projectName})` : ""}`, ""];
				for (const [ch, cfg] of [...channelConfigs.entries()].sort((a, b) => a[0] - b[0])) {
					lines.push(`- **Channel ${ch}**: ${cfg.name} (${cfg.type}) — ${cfg.patternLength ?? 16} steps`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { configs: Object.fromEntries(channelConfigs) },
				};
			}

			if (params.action === "remove") {
				if (!params.channel) {
					return { content: [{ type: "text", text: "Please specify a channel number to remove." }], details: {} };
				}
				channelConfigs.delete(params.channel);
				persistConfig();
				return {
					content: [{ type: "text", text: `Removed channel ${params.channel} configuration.` }],
					details: {},
				};
			}

			// action === "set"
			if (!params.channel || !params.name || !params.type) {
				return {
					content: [{ type: "text", text: "Please specify channel, name, and type for 'set' action." }],
					details: {},
				};
			}

			const cfg: ChannelConfig = {
				channel: params.channel,
				name: params.name,
				type: params.type,
				patternLength: params.pattern_length ?? 16,
			};
			channelConfigs.set(params.channel, cfg);
			persistConfig();

			if (monitor && cfg.patternLength) {
				monitor.setPatternLength(params.channel, cfg.patternLength);
			}

			return {
				content: [
					{
						type: "text",
						text: `Set channel ${params.channel}: **${params.name}** (${params.type}, ${cfg.patternLength} steps)`,
					},
				],
				details: { config: cfg },
			};
		},
	});

	pi.registerTool({
		name: "midi_read_pattern",
		label: "MIDI Read Pattern",
		description:
			"Read the currently detected MIDI pattern from a channel. Returns the step-by-step sequence " +
			"with note names, velocities, and gate lengths. Use this to see what the user is playing on their BeatStep Pro.",
		promptSnippet: "Read current MIDI pattern from a channel on BeatStep Pro",
		promptGuidelines: [
			"Use midi_read_pattern to see what the user is currently playing before suggesting changes.",
			"When discussing patterns, refer to steps by number (1-16) and notes by name (C3, E3, etc.).",
			"For acid bass patterns, pay attention to note slides (consecutive notes) and accent (high velocity).",
		],
		parameters: Type.Object({
			channel: Type.Optional(
				Type.Number({ description: "MIDI channel to read (1-16). Omit to read all channels with notes." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!monitor) {
				return {
					content: [{ type: "text", text: "MIDI monitor is not running." }],
					details: {},
				};
			}

			const status = monitor.getStatus();

			if (params.channel) {
				const pattern = monitor.getPattern(params.channel);
				const config = channelConfigs.get(params.channel);
				const text = renderPatternText(pattern, config);
				const header = status.playing ? `Playing at ${status.bpm} BPM\n\n` : "Stopped\n\n";
				return {
					content: [{ type: "text", text: header + text }],
					details: { status, pattern },
				};
			}

			// All channels
			const patterns = monitor.getAllPatterns();
			const sections: string[] = [];
			const header = status.playing ? `Playing at ${status.bpm} BPM` : "Stopped";
			sections.push(header);

			if (Object.keys(patterns).length === 0) {
				sections.push("\nNo patterns detected. Make sure BeatStep Pro is playing.");
			} else {
				for (const [chKey, pattern] of Object.entries(patterns)) {
					const chNum = parseInt(chKey);
					const config = channelConfigs.get(chNum);
					sections.push("");
					sections.push(renderPatternText(pattern, config));
				}
			}

			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: { status, patterns },
			};
		},
	});

	pi.registerTool({
		name: "midi_status",
		label: "MIDI Status",
		description: "Get the current MIDI monitor status: playing state, BPM, active channels.",
		promptSnippet: "Check MIDI monitor status (playing, BPM, channels)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!monitor) {
				return {
					content: [{ type: "text", text: "MIDI monitor is not running." }],
					details: {},
				};
			}

			const status = monitor.getStatus();
			const lines = [
				`## MIDI Monitor Status`,
				`- **State**: ${status.playing ? "▶ Playing" : "⏹ Stopped"}`,
				`- **BPM**: ${status.bpm || "unknown"}`,
				`- **Input ports**: ${status.input_ports.join(", ") || "none"}`,
				`- **Active channels**: ${status.active_channels.join(", ") || "none"}`,
				`- **Channels with notes**: ${status.channels_with_notes.join(", ") || "none"}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: status,
			};
		},
	});

	/** Build PatternData + ChannelConfig from tool params */
	function buildPatternFromParams(params: {
		name: string;
		type: "bass" | "lead" | "drums" | "pad" | "fx" | "other";
		pattern_length?: number;
		steps: { step: number; note: string; velocity?: number }[];
	}): { pattern: PatternData; config: ChannelConfig } {
		const patLen = params.pattern_length ?? 16;
		const stepMap = new Map<number, NoteInfo[]>();
		for (const s of params.steps) {
			const midi = parseNoteToMidi(s.note);
			if (midi < 0) continue;
			const info: NoteInfo = {
				note: midi,
				note_name: noteName(midi),
				velocity: s.velocity ?? 100,
				gate_pct: 50,
			};
			const existing = stepMap.get(s.step) ?? [];
			existing.push(info);
			stepMap.set(s.step, existing);
		}
		const steps: PatternStep[] = [];
		for (let i = 1; i <= patLen; i++) {
			steps.push({ step: i, notes: stepMap.get(i) ?? [] });
		}
		return {
			pattern: { channel: 0, steps, pattern_length: patLen, loop_count: 0, has_notes: stepMap.size > 0 },
			config: { channel: 0, name: params.name, type: params.type, patternLength: patLen },
		};
	}

	/** Render a pattern + config into styled TUI lines (same as widget). */
	function renderStyledPatternLines(
		pattern: PatternData,
		config: ChannelConfig,
		theme: Theme,
		maxWidth: number = 120,
	): string[] {
		const style: VelocityStyler = (text, velocity) => {
			if (velocity <= 50) return theme.fg("dim", text);
			if (velocity > 100) return theme.bold(theme.fg("warning", text));
			return text;
		};
		if (config.type === "drums") {
			return renderDrumLines(pattern, config, maxWidth, style);
		}
		return [renderPatternLine(pattern, config, maxWidth, style)];
	}

	pi.registerTool({
		name: "midi_render_pattern",
		label: "MIDI Render Pattern",
		description:
			"Render a proposed MIDI pattern using the same step-sequencer visualization as the live monitor widget. " +
			"Use this to visually present pattern ideas to the user. Provide steps as an array of {step, note, velocity} objects. " +
			"Empty steps are shown as '·'. Velocity affects visual weight: ≤50 = dim, 51-100 = normal, >100 = bold+accent. " +
			"The pattern is rendered as a styled TUI component in the chat (same look as the MIDI Monitor widget).",
		promptSnippet: "Render a proposed MIDI pattern visually for the user",
		promptGuidelines: [
			"Use midi_render_pattern to visually present pattern proposals to the user.",
			"For bass/lead: each step has one note (e.g. 'C3', 'D#2'). For drums: steps can have multiple notes (kick+hihat).",
			"Set velocity to convey dynamics: ghost notes ~40, normal ~80-100, accents ~120.",
			"Always render your proposals so the user can see them in the familiar step-sequencer format.",
			"The tool renders patterns as styled TUI components with velocity coloring directly in the chat — no need to copy the output into your message.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Pattern name, e.g. 'Acid Bass A', 'Minimal Techno Beat'" }),
			type: StringEnum(["bass", "lead", "drums", "pad", "fx", "other"] as const),
			pattern_length: Type.Optional(Type.Number({ description: "Pattern length in steps (default: 16)" })),
			steps: Type.Array(
				Type.Object({
					step: Type.Number({ description: "Step number (1-based)" }),
					note: Type.String({ description: "Note name, e.g. 'C3', 'F#2'. For drums use MIDI note names like 'C2' (kick=36), 'C#2' (snare=37), 'D2' (hihat=38)" }),
					velocity: Type.Optional(Type.Number({ description: "Velocity 1-127 (default: 100)" })),
				}),
				{ description: "Array of step events. Steps not listed are silent." },
			),
		}),
		// Custom TUI renderer — same velocity styling as the MIDI Monitor widget
		renderResult(result, _options, theme, _context) {
			const details = result.details as { pattern: PatternData; config: ChannelConfig } | undefined;
			if (!details?.pattern) {
				return new Text(result.content?.[0]?.text ?? "No pattern", 0, 0);
			}
			const { pattern, config } = details;
			const lines = renderStyledPatternLines(pattern, config, theme);
			const header = theme.bold(`${config.name}`) + theme.fg("muted", ` (${config.type}, ${pattern.pattern_length} steps)`);
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			for (const line of lines) {
				container.addChild(new Text(line, 0, 0));
			}
			return container;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { pattern, config } = buildPatternFromParams(params);

			// Plain text for LLM context (compact step notation)
			const noteSteps = params.steps.map(s => {
				const vel = s.velocity ?? 100;
				const accent = vel > 100 ? "!" : vel <= 50 ? "~" : "";
				return `${s.step}:${accent}${s.note}`;
			}).join(" ");

			return {
				content: [{ type: "text", text: `${params.name} (${params.type}, ${pattern.pattern_length} steps): ${noteSteps}` }],
				details: { pattern, config },
			};
		},
	});

	// --- Commands ---

	pi.registerCommand("project", {
		description: "Set up a MIDI project with channel assignments",
		handler: async (args, ctx) => {
			if (!args) {
				if (projectName) {
					ctx.ui.notify(`Current project: ${projectName}`, "info");
				} else {
					ctx.ui.notify("Usage: /project <name>  — then tell me your channel setup", "info");
				}
				return;
			}
			projectName = args.trim();
			persistConfig();
			ctx.ui.notify(`Project set: ${projectName}`, "success");
		},
	});

	pi.registerCommand("midi", {
		description: "MIDI monitor controls (start/stop/restart)",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();

			if (cmd === "stop") {
				stopMonitor();
				ctx.ui.setWidget("midi-monitor", undefined);
				ctx.ui.notify("MIDI monitor stopped", "info");
			} else if (cmd === "start" || cmd === "restart") {
				stopMonitor();
				const started = startMonitor();
				if (started) {
					startWidget();
					ctx.ui.notify("MIDI monitor started", "success");
				} else {
					ctx.ui.notify("Failed to start MIDI monitor", "error");
				}
			} else {
				ctx.ui.notify("Usage: /midi start|stop|restart", "info");
			}
		},
	});
}
