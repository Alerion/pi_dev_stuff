#!/usr/bin/env python3
"""
MIDI Monitor for BeatStep Pro.
Runs as a background process, listens to MIDI input ports,
tracks notes per channel, detects repeating patterns via MIDI clock,
and exposes pattern data as JSON via a socket server.

Protocol: newline-delimited JSON over TCP (localhost).
Commands:
  {"cmd": "get_patterns"}              -> all detected patterns
  {"cmd": "get_pattern", "channel": N} -> pattern for channel N
  {"cmd": "get_devices"}               -> list MIDI ports
  {"cmd": "get_status"}                -> monitor status (bpm, playing, etc.)
  {"cmd": "set_ports", "inputs": [...]}-> set which input ports to listen on
  {"cmd": "quit"}                      -> shutdown
"""

import json
import sys
import threading
import time
import socket
import signal
import traceback
from collections import defaultdict

import mido

# --- Constants ---
PPQN = 24  # MIDI clock pulses per quarter note
STEPS_PER_BEAT = 4  # 16th note grid (standard step sequencer)
CLOCKS_PER_STEP = PPQN // STEPS_PER_BEAT  # = 6 clocks per 16th note
MAX_PATTERN_STEPS = 64
DEFAULT_PATTERN_STEPS = 16


class NoteEvent:
    """A single note event on the step grid."""
    __slots__ = ('note', 'velocity', 'gate_clocks', 'step')

    def __init__(self, note, velocity, step, gate_clocks=0):
        self.note = note
        self.velocity = velocity
        self.step = step
        self.gate_clocks = gate_clocks

    def to_dict(self):
        return {
            'note': self.note,
            'note_name': note_name(self.note),
            'velocity': self.velocity,
            'step': self.step,
            'gate_pct': min(100, round(self.gate_clocks / CLOCKS_PER_STEP * 100)) if self.gate_clocks > 0 else 50,
        }


def note_name(midi_note):
    """Convert MIDI note number to name like C3, D#4."""
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    octave = (midi_note // 12) - 1
    return f"{names[midi_note % 12]}{octave}"


class ChannelTracker:
    """Tracks notes for a single MIDI channel."""

    def __init__(self, channel):
        self.channel = channel
        # Current loop's raw note events (step -> list of NoteEvent)
        self.current_events = defaultdict(list)
        # Last completed pattern (frozen after loop detection)
        self.pattern = None
        self.pattern_steps = DEFAULT_PATTERN_STEPS
        # Active notes (note_number -> (step, clock_within_step))
        self.active_notes = {}
        # Step counter within current loop pass
        self.current_step = 0
        # Loop pass counter (how many times we've looped)
        self.loop_count = 0
        # Previous loop's events for comparison
        self.prev_events = None

    def note_on(self, note, velocity, step):
        """Record a note-on at the given step."""
        if velocity == 0:
            self.note_off(note, step)
            return
        self.active_notes[note] = (step, 0)
        evt = NoteEvent(note, velocity, step % self.pattern_steps)
        self.current_events[step % self.pattern_steps].append(evt)

    def note_off(self, note, step):
        """Record a note-off, compute gate length."""
        if note in self.active_notes:
            start_step, _ = self.active_notes.pop(note)
            # Find the corresponding event and set gate
            target_step = start_step % self.pattern_steps
            for evt in reversed(self.current_events.get(target_step, [])):
                if evt.note == note and evt.gate_clocks == 0:
                    gate_steps = step - start_step
                    evt.gate_clocks = max(1, gate_steps * CLOCKS_PER_STEP)
                    break

    def on_loop_boundary(self):
        """Called when we detect a loop boundary (pattern restarts)."""
        # Snapshot current events as the pattern
        pattern_data = {}
        for step, events in self.current_events.items():
            if step < self.pattern_steps:
                pattern_data[step] = [e.to_dict() for e in events]

        if self.prev_events is not None:
            # Check if pattern matches previous loop
            if self._patterns_match(self.prev_events, pattern_data):
                self.loop_count += 1
            else:
                self.loop_count = 1
        else:
            self.loop_count = 1

        self.pattern = pattern_data
        self.prev_events = pattern_data
        self.current_events = defaultdict(list)
        self.active_notes = {}

    def _patterns_match(self, a, b):
        """Compare two pattern snapshots."""
        if set(a.keys()) != set(b.keys()):
            return False
        for step in a:
            notes_a = sorted([(e['note'], e['velocity']) for e in a[step]])
            notes_b = sorted([(e['note'], e['velocity']) for e in b.get(step, [])])
            if notes_a != notes_b:
                return False
        return True

    def get_pattern_dict(self):
        """Return the current pattern as a serializable dict."""
        source = self.pattern if self.pattern else {}
        # Also include any in-progress events if no completed pattern yet
        if not self.pattern:
            source = {}
            for step, events in self.current_events.items():
                if step < self.pattern_steps:
                    source[step] = [e.to_dict() for e in events]

        steps = []
        for s in range(self.pattern_steps):
            notes = source.get(s, [])
            steps.append({
                'step': s + 1,
                'notes': notes
            })

        return {
            'channel': self.channel,
            'steps': steps,
            'pattern_length': self.pattern_steps,
            'loop_count': self.loop_count,
            'has_notes': any(len(source.get(s, [])) > 0 for s in range(self.pattern_steps)),
        }


class MidiMonitor:
    """Main MIDI monitor that manages ports and channels."""

    def __init__(self):
        self.channels = {}  # channel_num -> ChannelTracker
        self.input_ports = []  # list of open mido input ports
        self.input_port_names = []
        self.running = False
        self.playing = False
        self.clock_count = 0
        self.global_step = 0
        self.bpm = 0.0
        self._last_clock_time = None
        self._clock_times = []  # for BPM averaging
        self.lock = threading.Lock()

    def get_or_create_channel(self, ch):
        if ch not in self.channels:
            self.channels[ch] = ChannelTracker(ch)
        return self.channels[ch]

    def open_ports(self, port_names=None):
        """Open MIDI input ports. If names is None, open all BeatStep Pro ports."""
        self.close_ports()

        available = mido.get_input_names()
        if port_names is None:
            # Auto-detect BeatStep Pro ports
            port_names = [p for p in available if 'BeatStep Pro' in p or 'Arturia BeatStep Pro' in p]

        opened = []
        for name in port_names:
            if name in available:
                try:
                    port = mido.open_input(name, callback=self._on_message)
                    self.input_ports.append(port)
                    opened.append(name)
                except Exception as e:
                    print(f"Warning: Could not open {name}: {e}", file=sys.stderr)

        self.input_port_names = opened
        return opened

    def close_ports(self):
        for port in self.input_ports:
            try:
                port.close()
            except:
                pass
        self.input_ports = []
        self.input_port_names = []

    def _on_message(self, msg):
        """Callback for incoming MIDI messages."""
        with self.lock:
            try:
                self._process_message(msg)
            except Exception as e:
                print(f"Error processing MIDI: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)

    def _process_message(self, msg):
        if msg.type == 'clock':
            self._on_clock()
        elif msg.type == 'start':
            self._on_start()
        elif msg.type == 'stop':
            self._on_stop()
        elif msg.type == 'continue':
            self.playing = True
        elif msg.type == 'note_on':
            ch = self.get_or_create_channel(msg.channel + 1)  # 1-indexed
            ch.note_on(msg.note, msg.velocity, self.global_step)
        elif msg.type == 'note_off':
            ch = self.get_or_create_channel(msg.channel + 1)
            ch.note_off(msg.note, self.global_step)

    def _on_start(self):
        """MIDI Start message - reset everything."""
        self.playing = True
        self.clock_count = 0
        self.global_step = 0
        self._last_clock_time = time.perf_counter()
        self._clock_times = []
        # Signal loop boundary for all channels
        for ch in self.channels.values():
            ch.on_loop_boundary()
            ch.current_step = 0

    def _on_stop(self):
        self.playing = False
        # Freeze current state as pattern
        for ch in self.channels.values():
            if ch.current_events:
                ch.on_loop_boundary()

    def _on_clock(self):
        """Process MIDI clock tick (24 per quarter note)."""
        if not self.playing:
            return

        now = time.perf_counter()

        # BPM calculation
        if self._last_clock_time is not None:
            dt = now - self._last_clock_time
            self._clock_times.append(dt)
            # Keep last 96 clocks (4 beats) for averaging
            if len(self._clock_times) > 96:
                self._clock_times = self._clock_times[-96:]
            if len(self._clock_times) >= PPQN:
                avg_clock = sum(self._clock_times) / len(self._clock_times)
                self.bpm = round(60.0 / (avg_clock * PPQN), 1)
        self._last_clock_time = now

        self.clock_count += 1

        # Check if we've hit a new step (every CLOCKS_PER_STEP clocks)
        if self.clock_count % CLOCKS_PER_STEP == 0:
            self.global_step += 1

            # Check for loop boundary (every pattern_length steps)
            # Use the max pattern length across channels, default 16
            for ch in self.channels.values():
                ch.current_step = self.global_step % ch.pattern_steps
                if ch.current_step == 0 and self.global_step > 0:
                    ch.on_loop_boundary()

    def get_all_patterns(self):
        with self.lock:
            result = {}
            for ch_num, ch in sorted(self.channels.items()):
                pdata = ch.get_pattern_dict()
                if pdata['has_notes']:
                    result[ch_num] = pdata
            return result

    def get_pattern(self, channel):
        with self.lock:
            if channel in self.channels:
                return self.channels[channel].get_pattern_dict()
            return {'channel': channel, 'steps': [], 'pattern_length': DEFAULT_PATTERN_STEPS,
                    'loop_count': 0, 'has_notes': False}

    def get_status(self):
        with self.lock:
            return {
                'playing': self.playing,
                'bpm': self.bpm,
                'global_step': self.global_step,
                'clock_count': self.clock_count,
                'input_ports': self.input_port_names,
                'active_channels': sorted(self.channels.keys()),
                'channels_with_notes': sorted(
                    ch_num for ch_num, ch in self.channels.items()
                    if ch.get_pattern_dict()['has_notes']
                ),
            }

    def set_pattern_length(self, channel, length):
        """Set pattern length for a channel."""
        with self.lock:
            ch = self.get_or_create_channel(channel)
            ch.pattern_steps = min(MAX_PATTERN_STEPS, max(1, length))


class Server:
    """TCP server for IPC with the pi extension."""

    def __init__(self, monitor, port=0):
        self.monitor = monitor
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('127.0.0.1', port))
        self.server.listen(5)
        self.port = self.server.getsockname()[1]
        self.running = True

    def serve(self):
        self.server.settimeout(1.0)
        while self.running:
            try:
                conn, _ = self.server.accept()
                threading.Thread(target=self._handle_client, args=(conn,), daemon=True).start()
            except socket.timeout:
                continue
            except OSError:
                break

    def _handle_client(self, conn):
        try:
            conn.settimeout(5.0)
            buf = b''
            while self.running:
                data = conn.recv(4096)
                if not data:
                    break
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    response = self._handle_command(line.decode('utf-8').strip())
                    conn.sendall((json.dumps(response) + '\n').encode('utf-8'))
        except (socket.timeout, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            try:
                conn.close()
            except:
                pass

    def _handle_command(self, line):
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            return {'error': 'invalid json'}

        action = cmd.get('cmd', '')

        if action == 'get_patterns':
            return {'patterns': self.monitor.get_all_patterns()}
        elif action == 'get_pattern':
            ch = cmd.get('channel', 1)
            return {'pattern': self.monitor.get_pattern(ch)}
        elif action == 'get_devices':
            return {
                'inputs': mido.get_input_names(),
                'outputs': mido.get_output_names(),
                'active_inputs': self.monitor.input_port_names,
            }
        elif action == 'get_status':
            return self.monitor.get_status()
        elif action == 'set_ports':
            names = cmd.get('inputs')
            opened = self.monitor.open_ports(names)
            return {'opened': opened}
        elif action == 'set_pattern_length':
            ch = cmd.get('channel', 1)
            length = cmd.get('length', DEFAULT_PATTERN_STEPS)
            self.monitor.set_pattern_length(ch, length)
            return {'ok': True}
        elif action == 'quit':
            self.running = False
            self.monitor.close_ports()
            return {'ok': True}
        else:
            return {'error': f'unknown command: {action}'}

    def shutdown(self):
        self.running = False
        try:
            self.server.close()
        except:
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0

    monitor = MidiMonitor()
    server = Server(monitor, port=port)

    # Write the assigned port to stdout so the extension can read it
    print(f"PORT:{server.port}", flush=True)

    # Auto-open BeatStep Pro ports
    opened = monitor.open_ports()
    print(f"OPENED:{json.dumps(opened)}", flush=True)
    print("READY", flush=True)

    def shutdown_handler(signum, frame):
        server.shutdown()
        monitor.close_ports()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    try:
        server.serve()
    finally:
        monitor.close_ports()
        server.shutdown()


if __name__ == '__main__':
    main()
