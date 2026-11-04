import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AudioLines, Download, LogIn, LogOut, Pause, Play, RotateCcw, Save, ShieldCheck, Trash2, Upload, Volume2, X } from "lucide-react";
import { createPreset, deletePreset, deleteTrack, downloadTrack, getPresets, getTracks, getViewer, updatePreset, updateTrackSettings, uploadTrack } from "./lib/api";
import { analyzeLoudness, connectAudioEffects, renderWav, updateAudioEffects, type LoudnessAnalysis } from "./lib/audio";
import type { AudioSettings, Environment, Preset, PresetInput, Viewer } from "./types";

const initialSettings: AudioSettings = {
  eq: { low: 0, lowMid: 0, highMid: 0, high: 0 },
  compressor: { threshold: -18, ratio: 4, attack: 0.003, release: 0.25 },
  limiterCeiling: -1,
};

const environments: { id: Environment; label: string; description: string }[] = [
  { id: "studio", label: "Studio", description: "Neutral referens" },
  { id: "car", label: "Bil", description: "Lätt bas- och närvarolyft" },
  { id: "phone", label: "Mobil", description: "Begränsat frekvensomfång" },
  { id: "laptop", label: "Dator", description: "Tunnare bas" },
  { id: "headphones", label: "Hörlurar", description: "Mjukare närvaro" },
];

const maxFileSize = 100 * 1024 * 1024;
const spotifyTargetLufs = -14;
const timeLabel = (time: number) => `${Math.floor(time / 60)}:${Math.floor(time % 60).toString().padStart(2, "0")}`;

export default function App() {
  const [viewer, setViewer] = useState<Viewer>({ signedIn: false, email: null, isAdmin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tracks, setTracks] = useState<Awaited<ReturnType<typeof getTracks>>>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [settings, setSettings] = useState<AudioSettings>(initialSettings);
  const [environment, setEnvironment] = useState<Environment>("studio");
  const [bypassed, setBypassed] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState("");
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [currentTrackId, setCurrentTrackId] = useState("");
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [uploadingTrack, setUploadingTrack] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [gainReduction, setGainReduction] = useState({ compressor: 0, limiter: 0 });
  const [normalizeToSpotify, setNormalizeToSpotify] = useState(false);
  const [loudnessAnalysis, setLoudnessAnalysis] = useState<{
    audioBuffer: AudioBuffer;
    key: string;
    result: LoudnessAnalysis;
  } | null>(null);
  const [loudnessStatus, setLoudnessStatus] = useState<"idle" | "analyzing" | "ready" | "error">("idle");
  const [exporting, setExporting] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [savingTrackSettings, setSavingTrackSettings] = useState(false);
  const audioContext = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const effects = useRef<ReturnType<typeof connectAudioEffects> | null>(null);
  const savedTrackSettings = useRef("");
  const activeTrackId = useRef(currentTrackId);
  const activeTrackSettings = useRef("");
  const trackSettingsSaveQueue = useRef(Promise.resolve());
  const currentTimeRef = useRef(0);
  const loudnessRequest = useRef(0);
  const startedAt = useRef(0);
  const playbackOffset = useRef(0);
  const selectedFile = useRef<HTMLInputElement>(null);
  const trackSettingsKey = JSON.stringify({ settings, environment });
  const loudnessKey = JSON.stringify({ settings, environment, bypassed });
  const analysisMatchesCurrentAudio = loudnessAnalysis?.audioBuffer === audioBuffer && loudnessAnalysis.key === loudnessKey;
  const currentLoudness = analysisMatchesCurrentAudio ? loudnessAnalysis.result : null;
  const normalizationGain = normalizeToSpotify && currentLoudness ? currentLoudness.normalizationGain : 1;
  activeTrackId.current = currentTrackId;
  activeTrackSettings.current = trackSettingsKey;

  function setPlayhead(time: number) {
    currentTimeRef.current = time;
    setCurrentTime(time);
  }

  async function loadSavedTrack(trackId: string) {
    const track = tracks.find((item) => item.id === trackId);
    if (!track) return;
    setLoadingAudio(true);
    setError("");
    setNotice("");
    pausePlayback();
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      await context.resume();
      const decoded = await context.decodeAudioData(await downloadTrack(track.id));
      setAudioBuffer(decoded);
      setFileName(track.name);
      setLocalFile(null);
      const restoredSettings = track.settings ?? initialSettings;
      const restoredEnvironment = track.environment ?? "studio";
      setSettings(restoredSettings);
      setEnvironment(restoredEnvironment);
      savedTrackSettings.current = JSON.stringify({ settings: restoredSettings, environment: restoredEnvironment });
      setCurrentTrackId(track.id);
      setPlayhead(0);
      setNotice(`”${track.name}” öppnades från Azure-lagringen.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Det gick inte att öppna ljudfilen från Azure.");
    } finally {
      setLoadingAudio(false);
    }
  }

  async function saveTrackToAzure() {
    if (!localFile) return;
    setUploadingTrack(true);
    setUploadProgress(0);
    setError("");
    setNotice("");
    try {
      const saved = await uploadTrack(localFile, settings, environment, setUploadProgress);
      savedTrackSettings.current = JSON.stringify({ settings, environment });
      setTracks((current) => [saved, ...current]);
      setCurrentTrackId(saved.id);
      setLocalFile(null);
      setNotice(`”${saved.name}” sparades i privat Azure-lagring och kan öppnas på andra enheter.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Det gick inte att spara WAV-filen i Azure.");
    } finally {
      setUploadingTrack(false);
    }
  }

  async function removeTrack(trackId: string) {
    const track = tracks.find((item) => item.id === trackId);
    if (!track || !window.confirm(`Ta bort ”${track.name}” från Azure-lagringen?`)) return;
    setError("");
    try {
      await deleteTrack(trackId);
      setTracks((current) => current.filter((item) => item.id !== trackId));
      if (currentTrackId === trackId) {
        pausePlayback();
        setAudioBuffer(null);
        setFileName("");
        setCurrentTrackId("");
        setPlayhead(0);
      }
      setNotice(`”${track.name}” togs bort från Azure-lagringen.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Det gick inte att ta bort WAV-filen.");
    }
  }

  async function loadWorkspace() {
    setLoading(true);
    setError("");
    try {
      const account = await getViewer();
      setViewer(account);
      if (account.isAdmin) {
        const [savedPresets, savedTracks] = await Promise.all([getPresets(), getTracks()]);
        setPresets(savedPresets);
        setTracks(savedTracks);
      } else {
        setPresets([]);
        setTracks([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Arbetsytan kunde inte hämtas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadWorkspace(); }, []);

  useEffect(() => {
    updateAudioEffects(effects.current, audioContext.current, settings, environment, bypassed, normalizationGain);
  }, [settings, environment, bypassed, normalizationGain]);

  useEffect(() => {
    const requestId = ++loudnessRequest.current;
    if (!audioBuffer) {
      setLoudnessAnalysis(null);
      setLoudnessStatus("idle");
      return;
    }

    setLoudnessStatus("analyzing");
    const timer = window.setTimeout(() => {
      void analyzeLoudness(audioBuffer, settings, environment, bypassed).then((result) => {
        if (loudnessRequest.current !== requestId) return;
        setLoudnessAnalysis({ audioBuffer, key: loudnessKey, result });
        setLoudnessStatus("ready");
      }).catch(() => {
        if (loudnessRequest.current !== requestId) return;
        setLoudnessStatus("error");
      });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      loudnessRequest.current += 1;
    };
  }, [audioBuffer, settings, environment, bypassed, loudnessKey]);

  useEffect(() => {
    if (!viewer.isAdmin || !currentTrackId || trackSettingsKey === savedTrackSettings.current) return;
    const trackId = currentTrackId;
    const settingsToSave = settings;
    const environmentToSave = environment;
    const settingsKey = trackSettingsKey;
    const timer = window.setTimeout(() => {
      trackSettingsSaveQueue.current = trackSettingsSaveQueue.current.then(async () => {
        if (activeTrackId.current !== trackId || activeTrackSettings.current !== settingsKey) return;
        setSavingTrackSettings(true);
        try {
          const updated = await updateTrackSettings(trackId, settingsToSave, environmentToSave);
          setTracks((current) => current.map((track) => track.id === trackId ? updated : track));
          if (activeTrackId.current === trackId && activeTrackSettings.current === settingsKey) {
            savedTrackSettings.current = settingsKey;
          }
        } catch (cause) {
          if (activeTrackId.current === trackId && activeTrackSettings.current === settingsKey) {
            setError(cause instanceof Error ? cause.message : "Inställningarna kunde inte sparas för ljudfilen.");
          }
        } finally {
          if (activeTrackId.current === trackId) setSavingTrackSettings(false);
        }
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [currentTrackId, settings, environment, trackSettingsKey, viewer.isAdmin]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const context = audioContext.current;
      if (context) setPlayhead(Math.min(audioBuffer?.duration ?? 0, playbackOffset.current + context.currentTime - startedAt.current));
      const activeEffects = effects.current;
      if (activeEffects) {
        setGainReduction({
          compressor: Math.max(0, -activeEffects.compressor.reduction),
          limiter: Math.max(0, -activeEffects.limiter.reduction),
        });
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing, audioBuffer]);

  useEffect(() => () => {
    source.current?.stop();
    void audioContext.current?.close();
  }, []);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setNotice("");
    if (!file.name.toLowerCase().endsWith(".wav")) {
      setError("Välj en WAV-ljudfil.");
      return;
    }
    if (file.size > maxFileSize) {
      setError("Maximal filstorlek är 100 MiB.");
      return;
    }

    setLoadingAudio(true);
    pausePlayback();
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      await context.resume();
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      setAudioBuffer(decoded);
      setFileName(file.name);
      setLocalFile(file);
      setCurrentTrackId("");
      savedTrackSettings.current = "";
      setPlayhead(0);
      setNotice("Ljudfilen bearbetas bara i webbläsaren. Den har inte laddats upp till servern.");
    } catch {
      setError("Det gick inte att öppna WAV-filen. Kontrollera filen och webbläsarens minne.");
    } finally {
      setLoadingAudio(false);
    }
  }

  async function startPlayback() {
    if (!audioBuffer) return;
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      await context.resume();
      const player = context.createBufferSource();
      player.buffer = audioBuffer;
      effects.current = connectAudioEffects(player, context, settings, environment, bypassed, normalizationGain);
      setGainReduction({ compressor: 0, limiter: 0 });
      source.current = player;
      const offset = currentTimeRef.current >= audioBuffer.duration ? 0 : currentTimeRef.current;
      playbackOffset.current = offset;
      startedAt.current = context.currentTime;
      player.onended = () => {
        if (source.current !== player) return;
        source.current = null;
        effects.current = null;
        setGainReduction({ compressor: 0, limiter: 0 });
        setPlaying(false);
        setPlayhead(0);
      };
      player.start(0, offset);
      setPlaying(true);
    } catch {
      setError("Det gick inte att spela upp ljudet i den här webbläsaren.");
    }
  }

  function togglePlayback() {
    if (playing) pausePlayback();
    else void startPlayback();
  }

  function pausePlayback() {
    const player = source.current;
    if (player) {
      const context = audioContext.current;
      const elapsed = context ? context.currentTime - startedAt.current : 0;
      source.current = null;
      effects.current = null;
      setGainReduction({ compressor: 0, limiter: 0 });
      player.stop();
      setPlayhead(Math.min(audioBuffer?.duration ?? 0, playbackOffset.current + elapsed));
    }
    setPlaying(false);
  }

  function seek(time: number) {
    const wasPlaying = playing;
    if (wasPlaying) pausePlayback();
    setPlayhead(time);
    if (wasPlaying) window.setTimeout(() => { void startPlayback(); }, 0);
  }

  function resetSettings() {
    setSettings(initialSettings);
    setEnvironment("studio");
    setSelectedPresetId("");
    setPresetName("");
  }

  function applyPreset(preset: Preset | undefined) {
    setSelectedPresetId(preset?.id ?? "");
    setPresetName(preset?.name ?? "");
    if (preset) {
      setSettings(preset.settings);
      setEnvironment(preset.environment);
    }
  }

  async function saveCurrentPreset(updateExisting: boolean) {
    const name = presetName.trim();
    if (!name) {
      setError("Ange ett namn på förinställningen innan du sparar.");
      return;
    }
    setSavingPreset(true);
    setError("");
    setNotice("");
    const input: PresetInput = { name, settings, environment };
    try {
      const saved = updateExisting && selectedPresetId
        ? await updatePreset(selectedPresetId, input)
        : await createPreset(input);
      setPresets((current) => [...current.filter((preset) => preset.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name, "sv")));
      setSelectedPresetId(saved.id);
      setPresetName(saved.name);
      setNotice(`Förinställningen ”${saved.name}” sparades på servern.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Det gick inte att spara förinställningen.");
    } finally {
      setSavingPreset(false);
    }
  }

  async function removePreset() {
    const preset = presets.find((item) => item.id === selectedPresetId);
    if (!preset || !window.confirm(`Ta bort förinställningen ”${preset.name}”?`)) return;
    setSavingPreset(true);
    setError("");
    try {
      await deletePreset(preset.id);
      setPresets((current) => current.filter((item) => item.id !== preset.id));
      applyPreset(undefined);
      setNotice(`Förinställningen ”${preset.name}” togs bort.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Det gick inte att ta bort förinställningen.");
    } finally {
      setSavingPreset(false);
    }
  }

  async function exportAudio() {
    if (!audioBuffer) return;
    setExporting(true);
    setError("");
    try {
      const rendered = await renderWav(audioBuffer, settings, environment, bypassed, normalizationGain);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(rendered);
      const safeName = fileName.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/\.wav$/i, "") || "livemaster";
      link.download = `${safeName}-livemaster.wav`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
      setNotice(bypassed ? "Den obehandlade WAV-filen har laddats ned." : "Den bearbetade WAV-filen har laddats ned.");
    } catch {
      setError("Det gick inte att skapa den bearbetade ljudfilen. Prova med en kortare fil.");
    } finally {
      setExporting(false);
    }
  }

  function signIn() {
    if (import.meta.env.DEV) {
      const email = window.prompt("Lokal förhandsvisning – ange en e-postadress som finns i GLOBAL_ADMIN_EMAILS:");
      if (email) {
        localStorage.setItem("livemaster-dev-email", email.trim());
        void loadWorkspace();
      }
      return;
    }
    window.location.assign("/.auth/login/aad");
  }

  function signOut() {
    if (import.meta.env.DEV) {
      localStorage.removeItem("livemaster-dev-email");
      setViewer({ signedIn: false, email: null, isAdmin: false });
      setPresets([]);
      setTracks([]);
      setCurrentTrackId("");
      pausePlayback();
      return;
    }
    window.location.assign("/.auth/logout");
  }

  function updateEq(band: keyof AudioSettings["eq"], value: number) {
    setSettings((current) => ({ ...current, eq: { ...current.eq, [band]: value } }));
  }

  function updateCompressor(field: keyof AudioSettings["compressor"], value: number) {
    setSettings((current) => ({ ...current, compressor: { ...current.compressor, [field]: value } }));
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="Livemaster – etusivu"><span className="brand-icon"><AudioLines size={21} /></span><span>live<strong>master</strong></span></a>
      <span className="topbar-note">STEREO BUSS · KONTROLLRUM 01</span>
      {viewer.isAdmin
        ? <button className="account-button" onClick={signOut}><LogOut size={15} /> Logga ut</button>
        : viewer.signedIn
          ? <span className="account-label"><ShieldCheck size={15} /> Saknar administratörsbehörighet</span>
          : <button className="account-button" onClick={signIn}><LogIn size={15} /> Logga in</button>}
    </header>

    <main>
      <section className="intro">
        <div>
          <span className="eyebrow"><span className="status-dot" /> ANALOG SIGNALKEDJA · DIGITAL PRECISION</span>
          <h1>Lyssna.<br /><em>Justera. Jämför.</em></h1>
          <p>Ladda en WAV-fil, prova equalizer och dynamik och jämför hur mixen låter i olika lyssningsmiljöer.</p>
        </div>
        <div className="intro-art" aria-hidden="true"><div className="meter meter-one"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="meter meter-two"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="intro-disc"><AudioLines size={52} strokeWidth={1} /></div><span className="intro-caption">CLASS A · ANALOGT TÄNK · DIGITALT ARBETE</span></div>
        <div className="intro-foot"><span>EQ · KOMPRESSOR · LIMITER</span><span>UPPSPELNING · WAV-EXPORT</span><span>01 / LJUDVERKTYG</span></div>
      </section>

      {loading ? <div className="access-card">Kontrollerar inloggning…</div>
        : <div className="workspace">
          <section className="panel file-panel">
            <div className="panel-heading"><div><span className="eyebrow">01 / LJUDKÄLLA</span><h2>Ljudfil</h2></div><span className="panel-index"><AudioLines size={18} /></span></div>
            <input ref={selectedFile} className="visually-hidden" type="file" accept=".wav,audio/wav,audio/x-wav" onChange={(event) => void handleFile(event)} />
            <button className={`drop-zone${audioBuffer ? " loaded" : ""}`} onClick={() => selectedFile.current?.click()} disabled={loadingAudio}>
              <span className="upload-icon">{loadingAudio ? <span className="spinner" /> : <Upload size={23} />}</span>
              <strong>{loadingAudio ? "Öppnar WAV-filen…" : audioBuffer ? fileName : "Välj en WAV-fil"}</strong>
              <small>{audioBuffer ? `${audioBuffer.numberOfChannels} kanaler · ${Math.round(audioBuffer.sampleRate / 100) / 10} kHz · ${timeLabel(audioBuffer.duration)}` : "WAV · högst 100 MiB"}</small>
            </button>
            <div className="playback">
              <button className="play-button" onClick={togglePlayback} disabled={!audioBuffer || loadingAudio} aria-label={playing ? "Pausa uppspelningen" : "Starta uppspelningen"}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
              <span className="time-readout">{timeLabel(currentTime)}</span>
              <input className="seek-slider" type="range" min="0" max={audioBuffer?.duration ?? 0} step="0.01" value={currentTime} disabled={!audioBuffer} onChange={(event) => seek(Number(event.target.value))} aria-label="Uppspelningsposition" />
              <span className="time-readout">{timeLabel(audioBuffer?.duration ?? 0)}</span>
              <button className={`bypass-toggle${bypassed ? " active" : ""}`} type="button" onClick={() => setBypassed((value) => !value)} aria-pressed={bypassed} aria-label={bypassed ? "Stäng av A/B-bypass och lyssna på behandlat ljud" : "Aktivera A/B-bypass och lyssna på obehandlat ljud"}><span>A/B</span><small>{bypassed ? "OBEHANDLAT" : "BEHANDLAT"}</small></button>
            </div>
            <p className="privacy-note"><ShieldCheck size={14} /> Filer spelas upp i webbläsaren. Spara till Azure om du vill öppna dem på fler enheter.</p>
            {localFile && viewer.isAdmin && <button className="button button-dark save-track" onClick={() => void saveTrackToAzure()} disabled={uploadingTrack}>{uploadingTrack ? <span className="spinner" /> : <Save size={15} />}{uploadingTrack ? ` Sparar i Azure… ${uploadProgress}%` : " Spara i Azure"}</button>}
            {localFile && !viewer.isAdmin && <p className="privacy-note">Logga in som administratör för att spara WAV-filen i Azure. Lokal uppspelning och export fungerar utan inloggning.</p>}
            {currentTrackId && <p className="privacy-note">{savingTrackSettings ? "Inställningarna sparas för ljudfilen…" : "Inställningarna sparas automatiskt för den här ljudfilen."}</p>}
            {viewer.isAdmin
              ? <div className="saved-tracks">
                <span className="control-label">Sparade ljudfiler i Azure</span>
                {tracks.length ? tracks.map((track) => <div className={`saved-track${currentTrackId === track.id ? " active" : ""}`} key={track.id}>
                  <button className="saved-track-open" onClick={() => void loadSavedTrack(track.id)} disabled={loadingAudio}><span>{track.name}</span><small>{(track.size / 1024 / 1024).toFixed(1)} MB</small></button>
                  <button className="icon-action danger" onClick={() => void removeTrack(track.id)} aria-label={`Ta bort ${track.name} från Azure`}><Trash2 size={15} /></button>
                </div>) : <p className="empty-tracks">Inga ljudfiler har sparats ännu.</p>}
              </div>
              : <p className="privacy-note">Sparade Azure-filer kan öppnas och hanteras av administratörer.</p>}
          </section>

          {viewer.signedIn && <section className="panel preset-panel">
            <div className="panel-heading"><div><span className="eyebrow">02 / INSTÄLLNINGAR</span><h2>Förinställningar</h2></div><span className="panel-index">P</span></div>
            {viewer.isAdmin
              ? <>
                <label className="control-label" htmlFor="preset-select">Sparade förinställningar</label>
                <select id="preset-select" className="select-control" value={selectedPresetId} onChange={(event) => applyPreset(presets.find((preset) => preset.id === event.target.value))}>
                  <option value="">Välj en förinställning…</option>
                  {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
                <label className="control-label preset-name-label" htmlFor="preset-name">Namn på förinställning</label>
                <input id="preset-name" className="text-control" maxLength={60} value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Till exempel Referens 02" />
                <div className="preset-actions">
                  <button className="button button-dark" onClick={() => void saveCurrentPreset(false)} disabled={savingPreset}><Save size={15} /> Spara ny</button>
                  <button className="button button-light" onClick={() => void saveCurrentPreset(true)} disabled={savingPreset || !selectedPresetId}>Uppdatera vald</button>
                  {selectedPresetId && <button className="icon-action danger" onClick={() => void removePreset()} disabled={savingPreset} aria-label="Ta bort vald förinställning"><Trash2 size={16} /></button>}
                </div>
                <p className="privacy-note"><ShieldCheck size={14} /> Förinställningar delas av administratörer och sparas på servern.</p>
              </>
              : <div className="preset-access">
                <p className="panel-help">Equalizer, dynamik och miljöinställningar kan användas utan inloggning. Delade förinställningar kräver administratörsbehörighet.</p>
                {!viewer.signedIn && <button className="button button-dark" onClick={signIn}><LogIn size={15} /> Logga in som administratör</button>}
                {viewer.signedIn && <p className="privacy-note">Kontot {viewer.email ?? ""} saknar administratörsbehörighet.</p>}
              </div>}
          </section>}

          <section className="panel eq-panel">
            <div className="panel-heading"><div><span className="eyebrow">03 / FREKVENS</span><h2>Equalizer</h2></div><span className="unit-tag">±12 dB</span></div>
            <div className="eq-controls">
              <RangeControl label="Bas" value={settings.eq.low} min={-12} max={12} step={0.5} format={(value) => `${value > 0 ? "+" : ""}${value} dB`} onChange={(value) => updateEq("low", value)} />
              <RangeControl label="Låga mellanregister" value={settings.eq.lowMid} min={-12} max={12} step={0.5} format={(value) => `${value > 0 ? "+" : ""}${value} dB`} onChange={(value) => updateEq("lowMid", value)} />
              <RangeControl label="Höga mellanregister" value={settings.eq.highMid} min={-12} max={12} step={0.5} format={(value) => `${value > 0 ? "+" : ""}${value} dB`} onChange={(value) => updateEq("highMid", value)} />
              <RangeControl label="Diskant" value={settings.eq.high} min={-12} max={12} step={0.5} format={(value) => `${value > 0 ? "+" : ""}${value} dB`} onChange={(value) => updateEq("high", value)} />
            </div>
            <div className="eq-curve" aria-hidden="true"><span>20 Hz</span><i /><i /><i /><i /><i /><span>20 kHz</span></div>
          </section>

          <section className="panel dynamics-panel">
            <div className="panel-heading"><div><span className="eyebrow">04 / DYNAMIK</span><h2>Kompressor</h2></div><span className="panel-index"><Volume2 size={18} /></span></div>
            <div className="dynamics-controls">
              <RangeControl label="Tröskel" value={settings.compressor.threshold} min={-60} max={0} step={1} format={(value) => `${value} dB`} onChange={(value) => updateCompressor("threshold", value)} />
              <RangeControl label="Kompressionsgrad" value={settings.compressor.ratio} min={1} max={20} step={0.5} format={(value) => `${value}:1`} onChange={(value) => updateCompressor("ratio", value)} />
              <RangeControl label="Attack" value={settings.compressor.attack} min={0.001} max={1} step={0.001} format={(value) => `${Math.round(value * 1000)} ms`} onChange={(value) => updateCompressor("attack", value)} />
              <RangeControl label="Release" value={settings.compressor.release} min={0.01} max={1} step={0.01} format={(value) => `${Math.round(value * 1000)} ms`} onChange={(value) => updateCompressor("release", value)} />
            </div>
            <GainReductionMeter label="Nivåreduktion" ariaLabel="Kompressorns nivåreduktion" value={gainReduction.compressor} />
          </section>

          <section className="panel limiter-panel">
            <div className="panel-heading"><div><span className="eyebrow">05 / SIGNALTOPPAR</span><h2>Limiter</h2></div><span className="limit-badge">PEAK</span></div>
            <RangeControl label="Maxnivå" value={settings.limiterCeiling} min={-12} max={0} step={0.5} format={(value) => `${value} dBFS`} onChange={(value) => setSettings((current) => ({ ...current, limiterCeiling: value }))} />
            <GainReductionMeter label="Nivåreduktion" ariaLabel="Limiterns nivåreduktion" value={gainReduction.limiter} />
            <p className="panel-help">Sist i signalkedjan och begränsar signalens toppar.</p>
          </section>

          <section className="panel environment-panel">
            <div className="panel-heading"><div><span className="eyebrow">06 / LYSSNINGSTEST</span><h2>Lyssningsmiljö</h2></div><span className="panel-index">A/B</span></div>
            <div className="environment-grid">{environments.map((item) => <button key={item.id} className={`environment-option${environment === item.id ? " selected" : ""}`} onClick={() => setEnvironment(item.id)} aria-pressed={environment === item.id}><span>{item.label}</span><small>{item.description}</small></button>)}</div>
            <p className="simulation-note">En förenklad frekvenssimulering i webbläsaren – motsvarar inte mätningar från en viss enhet.</p>
          </section>

          <section className="panel loudness-panel">
            <div className="panel-heading"><div><span className="eyebrow">07 / LOUDNESS</span><h2>Ljudstyrka</h2></div><span className="unit-tag">LUFS</span></div>
            <div className="loudness-readout">
              <span>Integrerad nivå</span>
              <strong>{loudnessStatus === "analyzing" ? "Analyserar…" : loudnessStatus === "error" ? "Kunde inte mäta" : currentLoudness?.integratedLufs === null || !currentLoudness ? "— LUFS" : `${currentLoudness.integratedLufs.toFixed(1)} LUFS`}</strong>
            </div>
            <label className="normalize-option">
              <input
                type="checkbox"
                checked={normalizeToSpotify}
                disabled={!currentLoudness || currentLoudness.integratedLufs === null || loudnessStatus === "analyzing"}
                onChange={(event) => setNormalizeToSpotify(event.target.checked)}
              />
              <span>Normalisera mot Spotify ({spotifyTargetLufs} LUFS)</span>
            </label>
            {normalizeToSpotify && currentLoudness?.normalizedLufs !== null && currentLoudness?.normalizedLufs !== undefined && <p className="panel-help">Efter normalisering: {currentLoudness.normalizedLufs.toFixed(1)} LUFS. Toppnivån begränsas till säkert utrymme för limiterinställningen.</p>}
            <p className="panel-help">K-vägd integrerad loudness. Spotify kan justera uppspelningen efter sina egna inställningar; −14 LUFS är en jämförelsenivå, inte en garanti.</p>
          </section>

          <section className="export-bar">
            <div><span className="eyebrow">KLAR ATT LYSSNA?</span><p>Exportera den bearbetade mixen som en ny WAV-fil.</p></div>
            <div className="export-actions"><button className="button button-light" onClick={resetSettings}><RotateCcw size={15} /> Återställ</button><button className="button button-orange" onClick={() => void exportAudio()} disabled={!audioBuffer || exporting}>{exporting ? <span className="spinner" /> : <Download size={16} />}{exporting ? " Bearbetar…" : " Exportera WAV"}</button></div>
          </section>

          {error && <div className="alert" role="alert">{error}<button onClick={() => setError("")} aria-label="Stäng felmeddelande"><X size={15} /></button></div>}
          {notice && <div className="success-message" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Stäng meddelande"><X size={15} /></button></div>}
        </div>}
    </main>
    <footer className="footer"><a className="brand" href="#"><span className="brand-icon"><AudioLines size={18} /></span><span>live<strong>master</strong></span></a><span>LJUDVERKTYG · BYGGT FÖR WEBBLÄSAREN</span><span>© {new Date().getFullYear()}</span></footer>
  </div>;
}

function RangeControl({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void }) {
  const angle = -135 + ((value - min) / (max - min)) * 270;
  return <label className="range-control"><span className="range-label">{label}<output>{format(value)}</output></span><span className="knob">
    <span className="knob-track" />
    <span className="knob-cap"><i style={{ transform: `rotate(${angle}deg)` }} /></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} />
  </span><span className="range-endpoints"><small>{format(min)}</small><small>{format(max)}</small></span></label>;
}

function GainReductionMeter({ label, ariaLabel, value }: { label: string; ariaLabel: string; value: number }) {
  const displayedValue = Math.min(value, 24);
  return <div className="gain-reduction">
    <span>{label}</span>
    <div className="gain-reduction-track" role="meter" aria-label={ariaLabel} aria-valuemin={0} aria-valuemax={24} aria-valuenow={displayedValue} aria-valuetext={`${value.toFixed(1)} dB`}>
      <i style={{ width: `${(displayedValue / 24) * 100}%` }} />
    </div>
    <output>{value.toFixed(1)} dB</output>
  </div>;
}
