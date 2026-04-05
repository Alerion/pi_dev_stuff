/**
 * MIDI Monitor Extension for pi.
 *
 * Monitors BeatStep Pro MIDI input, extracts patterns,
 * displays them in a TUI widget, and provides tools for
 * the LLM to read and discuss patterns.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { MidiIPC, type PatternData, type MonitorStatus } from "./ipc.js";
import { type ChannelConfig, renderWidget, renderPatternText } from "./renderer.js";

// Resolve path to midi_monitor.py relative to this file.
// jiti may provide import.meta.url as a file:// URL or a plain path.
function resolveExtDir(): string {
	const url = import.meta.url;
	if (url && url.startsWith("file:")) {
		try {
			return dirname(fileURLToPath(url));
		} catch {}
	}
	if (url) {
		return dirname(resolve(url));
	}
	// Fallback: use __dirname if available (CommonJS compat in jiti)
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	// Last resort: resolve from cwd
	return resolve(".");
}

const EXT_DIR = resolveExtDir();
// On Windows (Git Bash), backslashes in paths get mangled by spawn.
// Normalize to forward slashes so Python receives a valid path.
const PYTHON_SCRIPT = resolve(EXT_DIR, "midi_monitor.py").replace(/\\/g, "/");

// Find python executable - pi's Node process may not have the same PATH as the user's shell
async function findPython(): Promise<string> {
	const candidates = [
		"python",
		"python3",
		"C:/Users/user/AppData/Local/Programs/Python/Python311/python.exe",
	];
	for (const cmd of candidates) {
		try {
			const { execFileSync } = await import("node:child_process");
			execFileSync(cmd, ["--version"], { stdio: "pipe", timeout: 3000 });
			return cmd;
		} catch {}
	}
	return "python";
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
	let pythonProcess: ChildProcess | null = null;
	let ipc: MidiIPC | null = null;
	let channelConfigs = new Map<number, ChannelConfig>();
	let projectName = "";
	let widgetInterval: ReturnType<typeof setInterval> | null = null;
	let widgetEnabled = true;
	let currentCtx: ExtensionContext | null = null;

	// --- Process Management ---

	async function startMonitor(): Promise<boolean> {
		if (pythonProcess) return true;

		// Verify the script exists before spawning
		if (!existsSync(PYTHON_SCRIPT)) {
			console.error(`[midi-monitor] Python script not found at: ${PYTHON_SCRIPT}`);
			console.error(`[midi-monitor] EXT_DIR resolved to: ${EXT_DIR}`);
			console.error(`[midi-monitor] import.meta.url: ${import.meta.url}`);
			return false;
		}

		const pythonCmd = await findPython();
		console.error(`[midi-monitor] Using python: ${pythonCmd}`);
		console.error(`[midi-monitor] Script: ${PYTHON_SCRIPT}`);

		return new Promise((resolve) => {
			const proc = spawn(pythonCmd, [PYTHON_SCRIPT], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			let stdout = "";
			let stderrBuf = "";
			let resolved = false;

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
				// Split on \n and trim \r for Windows compatibility
				const lines = stdout.split("\n").map(l => l.replace(/\r$/, ""));

				for (const line of lines) {
					if (line.startsWith("PORT:") && !resolved) {
						const port = parseInt(line.slice(5));
						ipc = new MidiIPC(port);
					}
					if (line === "READY" && !resolved) {
						resolved = true;
						pythonProcess = proc;
						resolve(true);
					}
				}
			});

			proc.stderr?.on("data", (data) => {
				const text = data.toString().trim();
				stderrBuf += text + "\n";
				console.error(`[midi-monitor] ${text}`);
			});

			proc.on("error", (err) => {
				console.error(`[midi-monitor] spawn error: ${err.message}`);
				if (!resolved) {
					resolved = true;
					resolve(false);
				}
			});

			proc.on("exit", (code, sig) => {
				console.error(`[midi-monitor] Process exited: code=${code} signal=${sig}`);
				if (stderrBuf.trim()) console.error(`[midi-monitor] stderr: ${stderrBuf.trim()}`);
				pythonProcess = null;
				ipc = null;
				if (!resolved) {
					resolved = true;
					resolve(false);
				}
			});

			// Timeout after 10s
			setTimeout(() => {
				if (!resolved) {
					resolved = true;
					proc.kill();
					resolve(false);
				}
			}, 10000);
		});
	}

	async function stopMonitor() {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
		}
		if (ipc) {
			try {
				await ipc.quit();
			} catch {}
			ipc = null;
		}
		if (pythonProcess) {
			pythonProcess.kill();
			pythonProcess = null;
		}
	}

	// --- Widget ---

	async function updateWidget() {
		if (!ipc || !currentCtx?.hasUI || !widgetEnabled) return;

		try {
			const [patterns, status] = await Promise.all([
				ipc.getPatterns(),
				ipc.getStatus(),
			]);

			const lines = renderWidget(patterns, channelConfigs, status, 120);
			currentCtx.ui.setWidget("midi-monitor", lines);
		} catch {
			// Monitor may be restarting
		}
	}

	function startWidget() {
		if (widgetInterval) clearInterval(widgetInterval);
		// Update widget every 2 seconds
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

	function restoreConfig(ctx: ExtensionContext) {
		channelConfigs.clear();
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

		const started = await startMonitor();
		if (started) {
			// Apply pattern lengths from config
			for (const [ch, cfg] of channelConfigs) {
				if (cfg.patternLength && ipc) {
					await ipc.setPatternLength(ch, cfg.patternLength);
				}
			}
			if (ctx.hasUI) {
				startWidget();
				ctx.ui.notify("MIDI Monitor started. Press SHIFT+Play on BeatStep Pro to restart all sequences for pattern detection.", "info");
			}
		} else {
			if (ctx.hasUI) {
				ctx.ui.notify(`MIDI monitor failed. Check pi's stderr log for details. Script: ${PYTHON_SCRIPT}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await stopMonitor();
		currentCtx = null;
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreConfig(ctx);
	});

	// --- Keyboard Shortcut ---

	// Note: ctrl+m = Enter in terminals, so we use ctrl+shift+m
	pi.registerShortcut("ctrl+shift+m", {
		description: "Toggle MIDI monitor widget",
		handler: async (ctx) => {
			widgetEnabled = !widgetEnabled;
			if (widgetEnabled) {
				startWidget();
				ctx.ui.notify("MIDI widget enabled", "info");
			} else {
				if (widgetInterval) clearInterval(widgetInterval);
				ctx.ui.setWidget("midi-monitor", []);
				ctx.ui.notify("MIDI widget hidden", "info");
			}
		},
	});

	// --- Tools ---

	// Tool: List MIDI devices
	pi.registerTool({
		name: "midi_list_devices",
		label: "MIDI Devices",
		description: "List available MIDI input/output ports and which ones are currently monitored",
		promptSnippet: "List MIDI devices connected to the system",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!ipc) {
				return {
					content: [{ type: "text", text: "MIDI monitor is not running. It starts automatically on session start." }],
					details: {},
				};
			}

			const devices = await ipc.getDevices();
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

	// Tool: Configure channels
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
			type: Type.Optional(
				StringEnum(["bass", "lead", "drums", "pad", "fx", "other"] as const),
			),
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
					lines.push(
						`- **Channel ${ch}**: ${cfg.name} (${cfg.type}) — ${cfg.patternLength ?? 16} steps`,
					);
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

			// Update pattern length in monitor
			if (ipc && cfg.patternLength) {
				await ipc.setPatternLength(params.channel, cfg.patternLength);
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

	// Tool: Read pattern
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
			if (!ipc) {
				return {
					content: [{ type: "text", text: "MIDI monitor is not running." }],
					details: {},
				};
			}

			const status = await ipc.getStatus();

			if (params.channel) {
				const pattern = await ipc.getPattern(params.channel);
				const config = channelConfigs.get(params.channel);
				const text = renderPatternText(pattern, config);
				const header = status.playing ? `Playing at ${status.bpm} BPM\n\n` : "Stopped\n\n";
				return {
					content: [{ type: "text", text: header + text }],
					details: { status, pattern },
				};
			}

			// All channels
			const patterns = await ipc.getPatterns();
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

	// Tool: Get monitor status
	pi.registerTool({
		name: "midi_status",
		label: "MIDI Status",
		description: "Get the current MIDI monitor status: playing state, BPM, active channels.",
		promptSnippet: "Check MIDI monitor status (playing, BPM, channels)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!ipc) {
				return {
					content: [{ type: "text", text: "MIDI monitor is not running." }],
					details: {},
				};
			}

			const status = await ipc.getStatus();
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
				await stopMonitor();
				ctx.ui.setWidget("midi-monitor", []);
				ctx.ui.notify("MIDI monitor stopped", "info");
			} else if (cmd === "start" || cmd === "restart") {
				await stopMonitor();
				const started = await startMonitor();
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
