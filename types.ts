
export interface FeedbackData {
  corrected_sentence: string;
  mistake_explanation: string;
  confidence: 'confident' | 'unsure' | 'confused';
  sentiment: 'positive' | 'neutral' | 'frustrated';
  feedback: string;
  audio_base64?: string;
  fluency_score?: number;
  user_transcript?: string; // What the user actually said
}

export interface TranscriptionItem {
  id: string;
  type: 'user' | 'tutor';
  text: string;
  timestamp: number;
  audio_url?: string; // Local blob URL or base64 for playback
  isBase64?: boolean;
}

export interface TutorState {
  isActive: boolean;
  isListening: boolean;
  lastFeedback: FeedbackData | null;
  history: TranscriptionItem[];
}
