import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { toast } from "sonner";

export type RecordingStep =
  | "idle"
  | "mic"
  | "websocket"
  | "audio-start"
  | "streaming"
  | "stopping"
  | "error";

export interface DebugStats {
  chunksSent: number;
  messagesReceived: number;
  lastError: string | null;
  lastErrorTime: Date | null;
  sessionStartTime: Date | null;
  connectionAttempts: number;
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface AudioRecordingReturn {
  currentStep: RecordingStep;
  isRecording: boolean;
  recordingDuration: number;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  analyser: AnalyserNode | null;
  debugStats: DebugStats;
  formatDuration: (seconds: number) => string;
  canAccessMicrophone: boolean;
  availableDevices: AudioDevice[];
  selectedDeviceId: string | null;
  setSelectedDeviceId: (deviceId: string | null) => void;
  refreshDevices: () => Promise<void>;
  requestPermission: () => Promise<void>;
  sampleRate: number;
  setSampleRate: (rate: number) => void;
}

export async function connectAudioRecordingWebSocket(
  signal?: AbortSignal,
): Promise<WebSocket> {
  const session = useSettingsStore.getState();
  const endpoint = apiClient.baseURL;
  const jwt = await apiClient.getJWT();
  const sessionChanged = () => {
    const current = useSettingsStore.getState();
    return signal?.aborted || endpoint !== apiClient.baseURL ||
      current.apiEndpoint !== session.apiEndpoint ||
      current.clientId !== session.clientId ||
      current.sessionRevision !== session.sessionRevision;
  };
  if (sessionChanged()) {
    throw new Error("Audio connection cancelled after a session change");
  }
  if (!jwt) throw new Error("Authentication is required for audio recording");
  const wsUrl = new URL(endpoint + "/ws_pcm");
  wsUrl.protocol = wsUrl.protocol.replace("http", "ws");

  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(wsUrl.toString(), [
      "mycelia",
      `mycelia.jwt.${jwt}`,
    ]);
    let settled = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      clearTimeout(timeout);
      clearTimeout(readyTimer);
      signal?.removeEventListener("abort", cancel);
      unsubscribe();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      dispose();
      ws.close();
      reject(new Error(message));
    };
    const cancel = () =>
      fail("Audio connection cancelled after a session change");
    const unsubscribe = useSettingsStore.subscribe(() => {
      if (sessionChanged()) cancel();
    });
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(
      () => fail("WebSocket connection timeout"),
      10000,
    );
    ws.onopen = () => {
      readyTimer = setTimeout(() => {
        if (sessionChanged()) {
          cancel();
          return;
        }
        if (settled) return;
        settled = true;
        dispose();
        resolve(ws);
      }, 100);
    };
    ws.onerror = () => fail("WebSocket connection failed");
    ws.onclose = () =>
      fail("WebSocket closed before audio recording was ready");
  });
}

export const useAudioRecording = (): AudioRecordingReturn => {
  const {
    preferredAudioDeviceId,
    setPreferredAudioDeviceId,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
  } = useSettingsStore();
  const [currentStep, setCurrentStep] = useState<RecordingStep>("idle");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [debugStats, setDebugStats] = useState<DebugStats>({
    chunksSent: 0,
    messagesReceived: 0,
    lastError: null,
    lastErrorTime: null,
    sessionStartTime: null,
    connectionAttempts: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const pendingConnectionAbortRef = useRef<AbortController | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const durationIntervalRef = useRef<number | undefined>(undefined);
  const keepAliveIntervalRef = useRef<number | undefined>(undefined);
  const chunkCountRef = useRef(0);
  const audioProcessingStartedRef = useRef(false);
  const isWebSocketReadyRef = useRef(false);
  const sessionStartTimeRef = useRef<Date | null>(null);
  const workletLoadedRef = useRef(false);
  const [availableDevices, setAvailableDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState<string | null>(
    preferredAudioDeviceId,
  );
  const [sampleRate, setSampleRate] = useState<number>(16000);

  const setSelectedDeviceId = useCallback((deviceId: string | null) => {
    setSelectedDeviceIdState(deviceId);
    setPreferredAudioDeviceId(deviceId);
  }, [setPreferredAudioDeviceId]);

  const isLocalhost = window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const isHttps = window.location.protocol === "https:";
  const canAccessMicrophone = isLocalhost || isHttps;

  const formatDuration = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }, []);

  const cleanup = useCallback(() => {
    pendingConnectionAbortRef.current?.abort();
    pendingConnectionAbortRef.current = null;
    audioProcessingStartedRef.current = false;
    isWebSocketReadyRef.current = false;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.port.close();
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (audioContextRef.current?.state !== "closed") {
      audioContextRef.current?.close();
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    workletLoadedRef.current = false;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = undefined;
    }

    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = undefined;
    }

    chunkCountRef.current = 0;
    sessionStartTimeRef.current = null;
  }, []);

  useEffect(() =>
    useSettingsStore.subscribe((next, previous) => {
      if (
        next.apiEndpoint !== previous.apiEndpoint ||
        next.clientId !== previous.clientId ||
        next.sessionRevision !== previous.sessionRevision
      ) {
        cleanup();
        setIsRecording(false);
        setCurrentStep("idle");
        setRecordingDuration(0);
      }
    }), [cleanup]);

  const refreshDevices = useCallback(async () => {
    let realDevices: AudioDevice[] = [];

    if (
      canAccessMicrophone && navigator.mediaDevices &&
      navigator.mediaDevices.enumerateDevices
    ) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        realDevices = devices
          .filter((device) =>
            device.kind === "audioinput" && device.deviceId !== ""
          )
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
            kind: device.kind as MediaDeviceKind,
          }));
      } catch (err) {
        console.error("Failed to enumerate devices:", err);
      }
    }

    const allDevices = realDevices;
    setAvailableDevices(allDevices);

    setSelectedDeviceIdState((prev) => {
      if (prev && allDevices.some((device) => device.deviceId === prev)) {
        return prev;
      }
      if (
        preferredAudioDeviceId &&
        allDevices.some((device) => device.deviceId === preferredAudioDeviceId)
      ) {
        return preferredAudioDeviceId;
      }
      if (allDevices.length > 0) {
        return allDevices[0].deviceId;
      }
      return null;
    });
  }, [canAccessMicrophone, preferredAudioDeviceId]);

  const requestPermission = useCallback(async () => {
    if (canAccessMicrophone && navigator.mediaDevices) {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        await refreshDevices();
      } catch (err) {
        console.error("Failed to get microphone permission:", err);
        toast.error(
          "Microphone permission denied. Please enable it in your browser settings.",
        );
      }
    }
  }, [canAccessMicrophone, refreshDevices]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  const getMicrophoneAccess = useCallback(async (): Promise<MediaStream> => {
    if (!canAccessMicrophone) {
      throw new Error("Microphone access requires HTTPS or localhost");
    }

    const audioConstraints: MediaTrackConstraints = {
      sampleRate: sampleRate,
      channelCount: 1,
      echoCancellation: echoCancellation,
      noiseSuppression: noiseSuppression,
      autoGainControl: autoGainControl,
    };

    if (selectedDeviceId) {
      audioConstraints.deviceId = { exact: selectedDeviceId };
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    mediaStreamRef.current = stream;
    return stream;
  }, [
    canAccessMicrophone,
    selectedDeviceId,
    sampleRate,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
  ]);

  const connectWebSocket = useCallback(async (): Promise<WebSocket> => {
    const controller = new AbortController();
    pendingConnectionAbortRef.current = controller;
    return await connectAudioRecordingWebSocket(controller.signal);
  }, []);

  const sendWyomingMessage = useCallback(
    (
      ws: WebSocket,
      type: string,
      data?: Record<string, unknown>,
      payloadLength?: number,
    ) => {
      if (
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      ) {
        console.warn(
          `Cannot send Wyoming message "${type}": WebSocket is ${
            ws.readyState === WebSocket.CLOSING ? "CLOSING" : "CLOSED"
          }`,
        );
        return false;
      }
      const header: Record<string, unknown> = { type };
      if (data) {
        header.data = data;
      }
      if (payloadLength !== undefined) {
        header.payload_length = payloadLength;
      }
      try {
        ws.send(JSON.stringify(header) + "\n");
        return true;
      } catch (error) {
        console.error(`Failed to send Wyoming message "${type}":`, error);
        return false;
      }
    },
    [],
  );

  const sendAudioChunk = useCallback((audioBytes: Uint8Array) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (wsRef.current.binaryType !== "arraybuffer") {
      wsRef.current.binaryType = "arraybuffer";
    }

    const header = {
      type: "audio-chunk",
      payload_length: audioBytes.length,
    };

    const headerText = JSON.stringify(header) + "\n";
    const headerBytes = new TextEncoder().encode(headerText);

    const combinedPacket = new Uint8Array(
      headerBytes.length + audioBytes.length,
    );
    combinedPacket.set(headerBytes, 0);
    combinedPacket.set(audioBytes, headerBytes.length);

    try {
      wsRef.current.send(combinedPacket);
      chunkCountRef.current++;
      setDebugStats((prev) => ({
        ...prev,
        chunksSent: prev.chunksSent + 1,
      }));
    } catch (error) {
      console.error("Failed to send audio chunk:", error);
      return false;
    }

    return true;
  }, []);

  const startAudioProcessing = useCallback(async (stream: MediaStream) => {
    if (audioProcessingStartedRef.current) return;

    if (!audioContextRef.current) {
      const audioContext =
        new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: sampleRate,
        });
      audioContextRef.current = audioContext;
    }

    const audioContext = audioContextRef.current;

    if (!workletLoadedRef.current) {
      try {
        await audioContext.audioWorklet.addModule("/pcm-processor.worklet.js");
        workletLoadedRef.current = true;
      } catch (error) {
        console.error("Failed to load AudioWorklet:", error);
        throw new Error("Failed to load audio processor");
      }
    }

    audioProcessingStartedRef.current = true;

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    const workletNode = new AudioWorkletNode(audioContext, "mic-processor");
    workletNodeRef.current = workletNode;

    workletNode.port.onmessage = (event) => {
      if (!audioProcessingStartedRef.current) return;
      const audioBuffer = event.data as ArrayBuffer;

      const float32Array = new Float32Array(audioBuffer);
      const audioBytes = new Uint8Array(
        float32Array.buffer,
        float32Array.byteOffset,
        float32Array.byteLength,
      );

      if (
        isWebSocketReadyRef.current &&
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        sendAudioChunk(audioBytes);
      }
    };

    source.connect(analyser);
    analyser.connect(workletNode);
    workletNode.connect(audioContext.destination);
  }, [sendAudioChunk, sampleRate]);

  const startRecording = useCallback(async () => {
    try {
      const initialSession = useSettingsStore.getState();
      setError(null);
      setCurrentStep("mic");

      const sessionStartTime = new Date();
      sessionStartTimeRef.current = sessionStartTime;

      const stream = await getMicrophoneAccess();
      const currentSession = useSettingsStore.getState();
      if (
        currentSession.apiEndpoint !== initialSession.apiEndpoint ||
        currentSession.clientId !== initialSession.clientId ||
        currentSession.sessionRevision !== initialSession.sessionRevision
      ) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Audio recording cancelled after a session change");
      }

      setIsRecording(true);
      setCurrentStep("websocket");

      setDebugStats((prev) => ({
        ...prev,
        sessionStartTime,
        connectionAttempts: prev.connectionAttempts + 1,
      }));

      const startTime = Date.now();
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration(
          Math.floor((Date.now() - sessionStartTime.getTime()) / 1000),
        );
      }, 1000) as unknown as number;

      await startAudioProcessing(stream);

      connectWebSocket().then((ws) => {
        wsRef.current = ws;
        isWebSocketReadyRef.current = true;

        const handleWebSocketError = () => {
          const errorMessage = "WebSocket connection error";
          setError(errorMessage);
          setCurrentStep("error");
          setIsRecording(false);
          setDebugStats((prev) => ({
            ...prev,
            lastError: errorMessage,
            lastErrorTime: new Date(),
          }));
          cleanup();
        };

        ws.onerror = handleWebSocketError;
        ws.onclose = () => {
          if (wsRef.current === ws) {
            handleWebSocketError();
          }
        };

        ws.onmessage = (event) => {
          if (typeof event.data === "string") {
            try {
              const message = JSON.parse(event.data);
              setDebugStats((prev) => ({
                ...prev,
                messagesReceived: prev.messagesReceived + 1,
              }));

              if (message.type === "error") {
                const errorMessage = message.message || "WebSocket error";
                setError(errorMessage);
                setCurrentStep("error");
                setIsRecording(false);
                setDebugStats((prev) => ({
                  ...prev,
                  lastError: errorMessage,
                  lastErrorTime: new Date(),
                }));
                cleanup();
              }
            } catch {
              // Ignore parse errors for non-JSON messages
            }
          }
        };

        setCurrentStep("audio-start");

        const sessionStartTimestamp = sessionStartTimeRef.current
          ? Math.floor(sessionStartTimeRef.current.getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        const audioFormat = {
          rate: sampleRate,
          width: 4,
          channels: 1,
          mode: "streaming",
          timestamp: sessionStartTimestamp,
        };

        const bitDepth = audioFormat.width * 8;

        console.log("Audio recording started with format:", {
          sampleRate: `${audioFormat.rate} Hz`,
          bitDepth: `${bitDepth} bit`,
          channels: audioFormat.channels,
          mode: audioFormat.mode,
          bytesPerSecond: `${
            audioFormat.rate * audioFormat.width * audioFormat.channels
          } bytes/s`,
          format: "Float32",
        });

        sendWyomingMessage(ws, "audio-start", audioFormat);

        setCurrentStep("streaming");

        keepAliveIntervalRef.current = setInterval(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            sendWyomingMessage(wsRef.current, "ping");
          }
        }, 30000) as unknown as number;
      }).catch((err) => {
        const errorMessage = err instanceof Error
          ? err.message
          : "Failed to connect WebSocket";
        setError(errorMessage);
        setCurrentStep("error");
        setIsRecording(false);
        setDebugStats((prev) => ({
          ...prev,
          lastError: errorMessage,
          lastErrorTime: new Date(),
        }));
        cleanup();
      });
    } catch (err) {
      const errorMessage = err instanceof Error
        ? err.message
        : "Failed to start recording";
      setError(errorMessage);
      setCurrentStep("error");
      setIsRecording(false);
      setDebugStats((prev) => ({
        ...prev,
        lastError: errorMessage,
        lastErrorTime: new Date(),
      }));
      cleanup();
    }
  }, [
    canAccessMicrophone,
    getMicrophoneAccess,
    connectWebSocket,
    sendWyomingMessage,
    startAudioProcessing,
    cleanup,
    sampleRate,
  ]);

  const stopRecording = useCallback(() => {
    if (!isRecording) return;

    setCurrentStep("stopping");

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      sendWyomingMessage(wsRef.current, "audio-stop");
    }

    cleanup();

    setIsRecording(false);
    setCurrentStep("idle");
    setRecordingDuration(0);
  }, [isRecording, sendWyomingMessage, cleanup]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    currentStep,
    isRecording,
    recordingDuration,
    error,
    startRecording,
    stopRecording,
    analyser: analyserRef.current,
    debugStats,
    formatDuration,
    canAccessMicrophone,
    availableDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    refreshDevices,
    requestPermission,
    sampleRate,
    setSampleRate,
  };
};
