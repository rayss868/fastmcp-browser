// Runtime recording control. The initial target comes from FASTMCP_RECORD at
// module load, but a running server can start/stop recording to any file at
// runtime through the bridge control channel (see index.ts).
let activeFile: string | undefined = (() => {
  const file = process.env.FASTMCP_RECORD;
  return typeof file === 'string' && file ? file : undefined;
})();
let activeSince: number | null = activeFile ? Date.now() : null;

export function activeRecordFile(): string | undefined {
  return activeFile;
}

export function startRecording(file: string): { recording: true; file: string } {
  activeFile = file;
  activeSince = Date.now();
  return { recording: true, file };
}

export function stopRecording(): { recording: false; stopped: string | null } {
  const stopped = activeFile ?? null;
  activeFile = undefined;
  activeSince = null;
  return { recording: false, stopped };
}

export function recordingStatus(): { recording: boolean; file: string | null; since: number | null } {
  return { recording: Boolean(activeFile), file: activeFile ?? null, since: activeSince };
}
