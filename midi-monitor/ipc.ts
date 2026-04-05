/**
 * IPC client for the Python MIDI monitor backend.
 * Communicates via newline-delimited JSON over TCP.
 */

import { createConnection, type Socket } from "node:net";

export interface MidiDevices {
	inputs: string[];
	outputs: string[];
	active_inputs: string[];
}

export interface PatternStep {
	step: number;
	notes: {
		note: number;
		note_name: string;
		velocity: number;
		gate_pct: number;
	}[];
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

export class MidiIPC {
	private port: number;

	constructor(port: number) {
		this.port = port;
	}

	private async send(cmd: Record<string, unknown>): Promise<any> {
		return new Promise((resolve, reject) => {
			const sock: Socket = createConnection({ host: "127.0.0.1", port: this.port }, () => {
				sock.write(JSON.stringify(cmd) + "\n");
			});

			let buf = "";
			sock.on("data", (data) => {
				buf += data.toString();
				const nl = buf.indexOf("\n");
				if (nl >= 0) {
					const line = buf.slice(0, nl);
					sock.destroy();
					try {
						resolve(JSON.parse(line));
					} catch {
						reject(new Error(`Invalid JSON from monitor: ${line}`));
					}
				}
			});

			sock.on("error", (err) => reject(err));
			sock.setTimeout(5000, () => {
				sock.destroy();
				reject(new Error("Timeout connecting to MIDI monitor"));
			});
		});
	}

	async getDevices(): Promise<MidiDevices> {
		const res = await this.send({ cmd: "get_devices" });
		return res as MidiDevices;
	}

	async getPatterns(): Promise<Record<string, PatternData>> {
		const res = await this.send({ cmd: "get_patterns" });
		return res.patterns ?? {};
	}

	async getPattern(channel: number): Promise<PatternData> {
		const res = await this.send({ cmd: "get_pattern", channel });
		return res.pattern;
	}

	async getStatus(): Promise<MonitorStatus> {
		return (await this.send({ cmd: "get_status" })) as MonitorStatus;
	}

	async setPorts(inputs: string[]): Promise<string[]> {
		const res = await this.send({ cmd: "set_ports", inputs });
		return res.opened ?? [];
	}

	async setPatternLength(channel: number, length: number): Promise<void> {
		await this.send({ cmd: "set_pattern_length", channel, length });
	}

	async quit(): Promise<void> {
		try {
			await this.send({ cmd: "quit" });
		} catch {
			// Process may already be gone
		}
	}
}
