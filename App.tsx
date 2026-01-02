
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { FeedbackData, TranscriptionItem } from './types';
import { decodeBase64 } from './utils/audioUtils';

const WEBHOOK_URL = 'https://muhammadahmadme085-n8n.hf.space/webhook/voice-stream';
const STORAGE_KEY = 'ai_tutor_history_v5';

// Configuration for silence detection
const SILENCE_THRESHOLD = 15; // Volume threshold (0-255)
const SILENCE_DURATION = 1800; // 1.8 seconds of silence to auto-submit
const INITIAL_TIMEOUT = 4000; // 4 seconds of silence at start to cancel

type Screen = 'LANDING' | 'CONVERSATION' | 'ANALYSIS';

const App: React.FC = () => {
  const [screen, setScreen] = useState<Screen>('LANDING');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastFeedback, setLastFeedback] = useState<FeedbackData | null>(null);
  const [history, setHistory] = useState<TranscriptionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  
  // Detection Refs
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const speechDetectedRef = useRef<boolean>(false);
  const detectionFrameRef = useRef<number | null>(null);

  // Persistence Logic
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Local DB read error", e);
      }
    }
  }, []);

  useEffect(() => {
    if (history.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-20)));
    }
  }, [history]);

  // Calculate Peak Fluency from history
  const peakFluency = useMemo(() => {
    if (history.length === 0) return 0;
    return lastFeedback?.fluency_score || 0;
  }, [history, lastFeedback]);

  const stopAllAudio = () => {
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch (e) {}
      currentSourceRef.current = null;
    }
  };

  const playAudio = async (audioDataStr: string) => {
    if (!audioDataStr) return;
    stopAllAudio();
    
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      
      const audioData = decodeBase64(audioDataStr);
      if (audioData.length === 0) return;

      const audioBuffer = await ctx.decodeAudioData(audioData.buffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start(0);
      currentSourceRef.current = source;
    } catch (err) {
      console.error("Audio playback error:", err);
    }
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  };

  const sendAudio = async (blob: Blob) => {
    setIsProcessing(true);
    setError(null);

    try {
      const userAudioBase64 = await blobToBase64(blob);
      const formData = new FormData();
      formData.append('data', blob, 'recording.webm');

      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error("Tutor unavailable");
      
      const result = await response.json();
      
      let data = result;
      if (Array.isArray(result)) {
        data = result[0];
      }
      if (data && data.json) {
        data = data.json;
      }

      // Mapping logic: Support 'Fluency' (capitalized), 'fluency_score', or 'fluency'
      const rawFluency = data.Fluency !== undefined ? data.Fluency : (data.fluency_score || data.fluency);

      const feedback: FeedbackData = {
        corrected_sentence: data.corrected_sentence || "Great job!",
        mistake_explanation: data.mistake_explanation || "Your sentence was clear and correct.",
        confidence: data.confidence || 'confident',
        sentiment: data.sentiment || 'neutral',
        feedback: data.feedback || "Keep up the great work!",
        audio_base64: data.audio_base64,
        fluency_score: typeof rawFluency === 'number' ? rawFluency : 75,
        user_transcript: data.user_transcript || "Transcript unavailable"
      };

      setLastFeedback(feedback);
      
      const userItem: TranscriptionItem = {
        id: `u-${Date.now()}`,
        type: 'user',
        text: feedback.user_transcript!, 
        timestamp: Date.now(),
        audio_url: userAudioBase64,
        isBase64: true
      };

      const tutorItem: TranscriptionItem = {
        id: `t-${Date.now()}`,
        type: 'tutor',
        text: feedback.corrected_sentence,
        timestamp: Date.now(),
        audio_url: feedback.audio_base64,
        isBase64: true
      };

      setHistory(prev => [...prev, userItem, tutorItem]);
      if (feedback.audio_base64) playAudio(feedback.audio_base64);
      setScreen('ANALYSIS');
    } catch (err) {
      setError("Network error. Could not connect to the tutor.");
    } finally {
      setIsProcessing(false);
      setIsRecording(false);
    }
  };

  const monitorSilence = () => {
    if (!analyserRef.current) return;
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const average = sum / dataArray.length;

    if (average > SILENCE_THRESHOLD) {
      speechDetectedRef.current = true;
      silenceStartRef.current = null;
    } else {
      if (silenceStartRef.current === null) {
        silenceStartRef.current = Date.now();
      } else {
        const silentTime = Date.now() - silenceStartRef.current;
        
        if (speechDetectedRef.current && silentTime > SILENCE_DURATION) {
          stopRecording();
          return;
        }
        
        if (!speechDetectedRef.current && silentTime > INITIAL_TIMEOUT) {
          stopRecording(true);
          setError("No voice detected. Please try again.");
          return;
        }
      }
    }
    
    detectionFrameRef.current = requestAnimationFrame(monitorSilence);
  };

  const stopRecording = (cancel = false) => {
    if (detectionFrameRef.current) cancelAnimationFrame(detectionFrameRef.current);
    setIsRecording(false);
    
    if (cancel) {
      if (mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current?.stop();
    } else {
      mediaRecorderRef.current?.stop();
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      stopRecording();
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        if (!audioContextRef.current) audioContextRef.current = new AudioContext();
        const source = audioContextRef.current.createMediaStreamSource(stream);
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;

        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];
        speechDetectedRef.current = false;
        silenceStartRef.current = null;

        recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
        recorder.onstop = () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          if (audioChunksRef.current.length > 0) sendAudio(blob);
          stream.getTracks().forEach(track => track.stop());
        };

        recorder.start();
        setIsRecording(true);
        setScreen('CONVERSATION');
        monitorSilence();
      } catch (err) { setError("Microphone access required."); }
    }
  };

  const FluencyArc = ({ score }: { score: number }) => {
    const size = 180;
    const stroke = 12;
    const center = size / 2;
    const radius = center - 24;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (score / 100) * circ;

    return (
      <div className="flex flex-col items-center">
        <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="transform -rotate-90 overflow-visible">
            <circle cx={center} cy={center} r={radius} stroke="#ffffff10" strokeWidth={stroke} fill="none" />
            <circle cx={center} cy={center} r={radius} stroke="#0EA5E9" strokeWidth={stroke} fill="none" 
              strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" className="transition-all duration-1000 ease-out" 
              style={{ filter: 'drop-shadow(0 0 8px rgba(14, 165, 233, 0.4))' }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-5xl font-black text-white">{score}%</span>
          </div>
        </div>
        <span className="text-[11px] font-black text-sky-400 uppercase tracking-[0.3em] mt-2">Proficiency Level</span>
      </div>
    );
  };

  const renderLanding = () => (
    <div className="flex flex-col h-full bg-[#0B0E14] text-white overflow-hidden relative">
      <div className="flex-1 overflow-y-auto px-8 pt-16 pb-32 scrollbar-hide">
        <div className="flex flex-col items-center w-full max-w-xs mx-auto">
          <div className="relative mb-12">
            <div className="w-40 h-40 rounded-full bg-sky-500/5 flex items-center justify-center shadow-2xl animate-float ring-1 ring-white/10">
              <div className="w-28 h-28 bg-gradient-to-br from-sky-500 to-indigo-600 rounded-full flex items-center justify-center shadow-[0_0_60px_rgba(14,165,233,0.3)]">
                <svg className="w-14 h-14 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
            </div>
            <div className="absolute -bottom-1 right-4 bg-emerald-500 w-6 h-6 rounded-full border-[6px] border-[#0B0E14]"></div>
          </div>
          
          <h1 className="text-5xl font-black tracking-tighter mb-2 text-center leading-none">AI TUTOR</h1>
          <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.6em] mb-12">Fluent Voice Practice</p>
          
          <div className="w-full space-y-4 mb-8">
            <div className="p-6 bg-white/5 rounded-[2.5rem] border border-white/5 flex items-center justify-between">
              <div>
                <p className="text-sky-400 font-black text-[10px] uppercase tracking-widest mb-1">Peak Fluency</p>
                <p className="text-3xl font-black">{history.length > 0 ? `${peakFluency}%` : '--'}</p>
              </div>
              <div className="w-14 h-14 bg-sky-500/10 rounded-2xl flex items-center justify-center text-sky-500">
                 <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
              </div>
            </div>

            {history.length > 0 && (
              <div className="p-6 bg-white/5 rounded-[2.5rem] border border-white/5">
                <p className="text-gray-500 font-black text-[9px] uppercase tracking-widest mb-2">Learning Milestone</p>
                <div className="flex gap-1.5 mt-2">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className={`h-2 flex-1 rounded-full ${i < history.length / 2 ? 'bg-sky-500' : 'bg-white/10'}`}></div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="absolute bottom-12 left-8 right-8 z-20">
        <button onClick={() => setScreen('CONVERSATION')} className="w-full bg-sky-600 hover:bg-sky-500 py-6 rounded-full font-black text-sm uppercase tracking-[0.3em] shadow-[0_20px_60px_rgba(14,165,233,0.3)] transition-all active:scale-95">
          Resume Lesson
        </button>
      </div>
    </div>
  );

  const renderConversation = () => (
    <div className="flex flex-col h-screen bg-[#0B0E14] text-white relative overflow-hidden">
      <header className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-white/5 bg-[#0B0E14]/90 backdrop-blur-md sticky top-0 z-20">
        <button onClick={() => setScreen('LANDING')} className="p-2.5 bg-white/5 rounded-xl">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <div className="text-center">
          <h2 className="text-xs font-black uppercase tracking-widest text-sky-500">Practice Hub</h2>
          <p className="text-[9px] text-gray-500 font-bold uppercase mt-0.5">
            {isRecording ? (speechDetectedRef.current ? 'Listening...' : 'Watching for audio...') : 'Tap Mic to Speak'}
          </p>
        </div>
        <button onClick={() => { if(confirm("Clear history?")) {setHistory([]); localStorage.removeItem(STORAGE_KEY);} }} className="p-2.5 bg-white/5 rounded-xl text-rose-500">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>
      </header>

      <div className="flex-grow overflow-y-auto px-4 pt-6 pb-40 scrollbar-hide">
        {history.map((item) => (
          <div key={item.id} className={`flex w-full mb-6 ${item.type === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`relative max-w-[85%] px-4 py-3 rounded-2xl shadow-xl ${
              item.type === 'user' ? 'bg-[#005c4b] text-white rounded-tr-none' : 'bg-[#202c33] text-gray-100 rounded-tl-none border border-white/5'
            }`}>
              <p className="text-[14px] font-medium leading-relaxed mb-2 pr-6">{item.text}</p>
              <div className="flex items-center justify-between gap-4">
                 <span className="text-[9px] text-white/30 font-bold">
                   {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                 </span>
                 {item.audio_url && (
                   <button onClick={() => playAudio(item.audio_url!)} className={`flex items-center justify-center w-8 h-8 rounded-full shadow-lg ${item.type === 'user' ? 'bg-white/10' : 'bg-sky-500'}`}>
                     <svg className="w-4 h-4" fill="white" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
                   </button>
                 )}
              </div>
            </div>
          </div>
        ))}

        {isProcessing && (
          <div className="flex justify-start mb-4">
             <div className="bg-[#202c33] px-5 py-4 rounded-2xl rounded-tl-none flex items-center gap-3 border border-white/5">
                <div className="flex gap-1.5">
                   <div className="w-1.5 h-1.5 bg-sky-500 rounded-full animate-bounce"></div>
                   <div className="w-1.5 h-1.5 bg-sky-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                   <div className="w-1.5 h-1.5 bg-sky-500 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                </div>
                <span className="text-[10px] font-black text-sky-400 uppercase tracking-widest ml-1">Decoding...</span>
             </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-12 left-0 right-0 flex justify-center z-30 pointer-events-none">
        <button onClick={toggleRecording} disabled={isProcessing} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-2xl pointer-events-auto ${isRecording ? 'bg-rose-500 scale-110' : 'bg-sky-600'} ${isProcessing ? 'opacity-30' : ''}`}>
          {isRecording ? <div className="w-6 h-6 bg-white rounded-md"></div> : <svg className="w-10 h-10" fill="white" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg>}
        </button>
      </div>
    </div>
  );

  const renderAnalysis = () => (
    <div className="flex flex-col h-screen bg-[#0B0E14] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-white/5">
        <button onClick={() => setScreen('CONVERSATION')} className="p-2.5 bg-white/5 rounded-xl">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Voice Analysis</h3>
        <div className="w-10"></div>
      </header>

      <div className="flex-grow overflow-y-auto px-6 pb-40 pt-6 space-y-8 scrollbar-hide">
        <div className="bg-[#1E293B]/40 py-10 px-6 rounded-[3rem] border border-white/5 text-center shadow-inner relative">
           <FluencyArc score={lastFeedback?.fluency_score || 0} />
           
           <div className="flex justify-center gap-3 mt-10">
             <div className="px-4 py-2 bg-indigo-500/10 border border-indigo-500/20 rounded-full flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
               <span className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">{lastFeedback?.confidence || 'Confident'}</span>
             </div>
             <div className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
               <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest">{lastFeedback?.sentiment || 'Neutral'}</span>
             </div>
           </div>
        </div>

        <div className="p-6 bg-white/5 rounded-[2.5rem] border border-white/5 shadow-sm">
           <div className="flex items-center justify-between mb-5">
             <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em]">Speech Transcript</label>
             {history.find(h => h.id.startsWith('u-')) && (
               <button onClick={() => {
                 const lastUserItem = [...history].reverse().find(item => item.type === 'user');
                 if (lastUserItem?.audio_url) playAudio(lastUserItem.audio_url);
               }} className="flex items-center gap-2 text-[9px] font-black text-white bg-white/10 px-4 py-2 rounded-full uppercase active:scale-95 transition-all">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  Replay
               </button>
             )}
           </div>
           <p className="text-lg font-bold text-gray-300 leading-relaxed italic">"{lastFeedback?.user_transcript || "Transcript unavailable"}"</p>
        </div>

        <div className="p-8 bg-sky-600/10 rounded-[3rem] border border-sky-500/20 shadow-2xl shadow-sky-900/10">
          <label className="text-[10px] font-black text-sky-400 uppercase mb-5 block tracking-[0.2em]">Corrected Expression</label>
          <p className="text-2xl font-black leading-tight mb-8">"{lastFeedback?.corrected_sentence}"</p>
          {lastFeedback?.audio_base64 && (
             <button onClick={() => playAudio(lastFeedback!.audio_base64!)} className="w-full flex items-center justify-center gap-3 text-[11px] font-black uppercase bg-sky-600 text-white py-5 rounded-3xl shadow-xl shadow-sky-600/30 active:scale-95 transition-all">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
                Listen to Model
             </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-5">
           <div className="p-7 bg-white/5 rounded-[2.5rem] border border-white/5">
             <label className="text-[10px] font-black text-slate-500 uppercase mb-3 block tracking-widest">Feedback & Correction</label>
             <p className="text-sm font-medium leading-relaxed text-slate-300">{lastFeedback?.mistake_explanation}</p>
           </div>
           <div className="p-7 bg-indigo-500/5 rounded-[2.5rem] border border-indigo-500/10">
             <label className="text-[10px] font-black text-indigo-400/60 uppercase mb-3 block tracking-widest">Tutor Advice</label>
             <p className="text-[16px] font-black text-indigo-300 italic">"{lastFeedback?.feedback}"</p>
           </div>
        </div>
      </div>

      <div className="fixed bottom-10 left-8 right-8 z-40">
        <button onClick={() => setScreen('CONVERSATION')} className="w-full bg-white text-black py-6 rounded-full font-black text-xs uppercase tracking-[0.4em] shadow-2xl active:scale-95 transition-all">
          Back to Practice
        </button>
      </div>
    </div>
  );

  return (
    <div className="max-w-md mx-auto h-screen shadow-2xl overflow-hidden relative bg-[#0B0E14] antialiased border-x border-white/5">
      {screen === 'LANDING' && renderLanding()}
      {screen === 'CONVERSATION' && renderConversation()}
      {screen === 'ANALYSIS' && renderAnalysis()}

      {error && (
        <div className="fixed top-24 left-8 right-8 bg-rose-500 p-6 rounded-[2rem] text-[11px] font-black text-center z-[100] shadow-2xl uppercase tracking-widest animate-in fade-in slide-in-from-top-6">
          <div className="flex items-center justify-between">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="ml-4 p-2 bg-white/10 rounded-full">✕</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
