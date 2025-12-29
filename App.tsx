
import React, { useState, useRef, useEffect } from 'react';
import { FeedbackData, TranscriptionItem } from './types';
import { decodeBase64 } from './utils/audioUtils';

const WEBHOOK_URL = 'https://muhammadahmadme085-n8n.hf.space/webhook/voice-stream';
const STORAGE_KEY = 'ai_tutor_history_v4';

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

  // Database Logic (LocalStorage)
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("DB Load Error", e);
      }
    }
  }, []);

  useEffect(() => {
    if (history.length > 0) {
      // Limit to 20 messages to keep DB healthy
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-20)));
    }
  }, [history]);

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

      if (!response.ok) throw new Error("Connection failed");
      
      const result = await response.json();
      let data = Array.isArray(result) ? result[0] : result;
      if (data && data.json) data = data.json;

      const feedback: FeedbackData = {
        corrected_sentence: data.corrected_sentence || "I heard you!",
        mistake_explanation: data.mistake_explanation || "No major corrections.",
        confidence: data.confidence || 'confident',
        sentiment: data.sentiment || 'neutral',
        feedback: data.feedback || "Keep practicing!",
        audio_base64: data.audio_base64,
        fluency_score: data.fluency_score || 72,
        user_transcript: data.user_transcript || "Spoken Message"
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
      setError("Network error. Could not reach tutor.");
    } finally {
      setIsProcessing(false);
      setIsRecording(false);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
        recorder.onstop = () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          sendAudio(blob);
          stream.getTracks().forEach(track => track.stop());
        };
        recorder.start();
        setIsRecording(true);
        setScreen('CONVERSATION');
      } catch (err) { setError("Microphone access required."); }
    }
  };

  const FluencyArc = ({ score }: { score: number }) => {
    const size = 160;
    const stroke = 12;
    const center = size / 2;
    const radius = center - stroke;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (score / 100) * circ;

    return (
      <div className="relative flex items-center justify-center mx-auto" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="transform -rotate-90">
          <circle cx={center} cy={center} r={radius} stroke="#ffffff10" strokeWidth={stroke} fill="none" />
          <circle cx={center} cy={center} r={radius} stroke="#0EA5E9" strokeWidth={stroke} fill="none" 
            strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" className="transition-all duration-1000 ease-out" 
            style={{ filter: 'drop-shadow(0 0 4px #0EA5E9)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-black text-white">{score}%</span>
          <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Fluency</span>
        </div>
      </div>
    );
  };

  const renderLanding = () => (
    <div className="flex flex-col items-center justify-between min-h-screen px-8 py-16 bg-[#0B0E14] text-white">
      <div className="flex flex-col items-center mt-12 w-full max-w-xs">
        <div className="relative mb-12">
          <div className="w-40 h-40 rounded-full bg-sky-500/10 flex items-center justify-center shadow-2xl animate-float ring-1 ring-white/10">
            <div className="w-28 h-28 bg-gradient-to-br from-sky-500 to-indigo-600 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(14,165,233,0.3)]">
              <svg className="w-16 h-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
          </div>
          <div className="absolute -bottom-2 right-4 bg-emerald-500 w-6 h-6 rounded-full border-[6px] border-[#0B0E14] shadow-xl"></div>
        </div>
        
        <h1 className="text-4xl font-black tracking-tight mb-2">PRO TUTOR</h1>
        <p className="text-slate-400 text-[11px] font-black uppercase tracking-[0.4em] mb-8">AI Voice Intelligence</p>
        
        <div className="w-full grid grid-cols-2 gap-3 mb-12">
          <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-left">
            <p className="text-sky-400 font-black text-[10px] mb-1">BEST SCORE</p>
            <p className="text-xl font-bold">{history.length > 0 ? '89%' : '--'}</p>
          </div>
          <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-left">
            <p className="text-indigo-400 font-black text-[10px] mb-1">TOTAL CHATS</p>
            <p className="text-xl font-bold">{Math.floor(history.length / 2)}</p>
          </div>
        </div>
      </div>

      <button onClick={() => setScreen('CONVERSATION')} className="w-full max-w-sm bg-sky-500 hover:bg-sky-400 py-5 rounded-[2.5rem] font-black text-sm uppercase tracking-widest shadow-[0_10px_40px_rgba(14,165,233,0.3)] transition-all active:scale-95 mb-6">
        Open Learning Portal
      </button>
    </div>
  );

  const renderConversation = () => (
    <div className="flex flex-col h-screen bg-[#0B0E14] text-white">
      <header className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-white/5 bg-[#0B0E14]/90 backdrop-blur-sm sticky top-0 z-20">
        <button onClick={() => setScreen('LANDING')} className="p-2.5 bg-white/5 rounded-xl">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <div className="text-center">
          <h2 className="text-xs font-black uppercase tracking-widest text-sky-500">Live Practice</h2>
          <div className="flex items-center gap-1.5 justify-center">
             <div className={`w-1.5 h-1.5 rounded-full ${isRecording ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></div>
             <p className="text-[9px] text-gray-500 font-bold uppercase">{isRecording ? 'Recording...' : 'Online'}</p>
          </div>
        </div>
        <button onClick={() => { setHistory([]); localStorage.removeItem(STORAGE_KEY); }} className="p-2.5 bg-white/5 rounded-xl text-rose-500 active:scale-90">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>
      </header>

      <div className="flex-grow overflow-y-auto px-4 pt-6 pb-32 scrollbar-hide">
        {history.map((item) => (
          <div key={item.id} className={`flex w-full mb-5 ${item.type === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`relative max-w-[85%] px-4 py-3 rounded-2xl shadow-lg ${
              item.type === 'user' ? 'bg-[#005c4b] text-white rounded-tr-none' : 'bg-[#202c33] text-gray-100 rounded-tl-none border border-white/5'
            }`}>
              <p className="text-[14px] font-medium leading-relaxed mb-2 pr-6">{item.text}</p>
              <div className="flex items-center justify-between gap-4">
                 <span className="text-[10px] text-white/30 font-bold">
                   {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                 </span>
                 {item.audio_url && (
                   <button onClick={() => playAudio(item.audio_url!)} className={`flex items-center justify-center w-8 h-8 rounded-full shadow-inner ${item.type === 'user' ? 'bg-white/10' : 'bg-sky-500'}`}>
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
                <span className="text-[10px] font-black text-sky-400 uppercase tracking-widest ml-1">Analyzing your speech...</span>
             </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-10 left-0 right-0 flex justify-center pb-4">
        <button onClick={toggleRecording} disabled={isProcessing} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${isRecording ? 'bg-rose-500 scale-110 shadow-rose-500/40' : 'bg-sky-500 shadow-sky-500/40'} ${isProcessing ? 'opacity-30 grayscale' : ''}`}>
          {isRecording ? <div className="w-6 h-6 bg-white rounded-md"></div> : <svg className="w-10 h-10" fill="white" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg>}
        </button>
      </div>
    </div>
  );

  const renderAnalysis = () => (
    <div className="flex flex-col h-screen bg-[#0B0E14] text-white overflow-hidden">
      <header className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-white/5">
        <button onClick={() => setScreen('CONVERSATION')} className="p-2.5 bg-white/5 rounded-xl">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Session Analysis</h3>
        <div className="w-10"></div>
      </header>

      <div className="flex-grow overflow-y-auto px-6 pb-40 pt-6 space-y-6 scrollbar-hide">
        {/* Arc Container with more vertical space to prevent cutting */}
        <div className="bg-[#1E293B]/40 py-10 px-6 rounded-[3rem] border border-white/5 text-center shadow-inner relative">
           <FluencyArc score={lastFeedback?.fluency_score || 0} />
           
           <div className="flex justify-center gap-3 mt-8">
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

        {/* User Voice Replay */}
        <div className="p-6 bg-white/5 rounded-[2rem] border border-white/5">
           <div className="flex items-center justify-between mb-4">
             <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em]">What you said</label>
             {history.find(h => h.id.startsWith('u-')) && (
               <button onClick={() => {
                 const lastUserItem = [...history].reverse().find(item => item.type === 'user');
                 if (lastUserItem?.audio_url) playAudio(lastUserItem.audio_url);
               }} className="flex items-center gap-2 text-[9px] font-black text-white bg-sky-500/20 px-4 py-2 rounded-full uppercase active:scale-95 transition-all">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  Replay Voice
               </button>
             )}
           </div>
           <p className="text-[15px] font-bold text-gray-300 leading-relaxed italic">"{lastFeedback?.user_transcript}"</p>
        </div>

        {/* AI Correction */}
        <div className="p-7 bg-sky-600/10 rounded-[2.5rem] border border-sky-500/20 shadow-lg shadow-sky-500/5">
          <label className="text-[10px] font-black text-sky-400 uppercase mb-4 block tracking-widest">Natural Alternative</label>
          <p className="text-xl font-black leading-snug mb-6">"{lastFeedback?.corrected_sentence}"</p>
          {lastFeedback?.audio_base64 && (
             <button onClick={() => playAudio(lastFeedback!.audio_base64!)} className="w-full flex items-center justify-center gap-3 text-[10px] font-black uppercase bg-sky-500 text-white py-4 rounded-2xl shadow-xl shadow-sky-500/20 active:scale-95 transition-all">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
                Listen to Tutor
             </button>
          )}
        </div>

        {/* Feedback Breakdown */}
        <div className="grid grid-cols-1 gap-4">
           <div className="p-6 bg-slate-900/50 rounded-[2rem] border border-white/5">
             <label className="text-[10px] font-black text-slate-500 uppercase mb-3 block tracking-widest">Grammar Note</label>
             <p className="text-sm font-medium leading-relaxed text-slate-300">{lastFeedback?.mistake_explanation}</p>
           </div>
           <div className="p-6 bg-indigo-500/5 rounded-[2rem] border border-indigo-500/10">
             <label className="text-[10px] font-black text-indigo-400/60 uppercase mb-3 block tracking-widest">Coach's Pro Tip</label>
             <p className="text-[15px] font-black text-indigo-300 italic">"{lastFeedback?.feedback}"</p>
           </div>
        </div>
      </div>

      <div className="fixed bottom-10 left-6 right-6 z-30">
        <button onClick={() => setScreen('CONVERSATION')} className="w-full bg-white text-black py-5 rounded-[2.5rem] font-black text-xs uppercase tracking-[0.3em] shadow-2xl active:scale-95 transition-all">
          Continue Practice
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
        <div className="fixed top-24 left-8 right-8 bg-rose-500 p-5 rounded-3xl text-[10px] font-black text-center z-[100] shadow-2xl uppercase tracking-[0.2em] animate-in fade-in slide-in-from-top-4">
          {error}
        </div>
      )}
    </div>
  );
};

export default App;
