import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Mic, Upload, Square, Copy, Check, Globe, FileAudio, Loader2, AlertCircle, X, Link as LinkIcon } from 'lucide-react';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'transcribe' | 'translate'>('transcribe');

  const apiKey = process.env.GEMINI_API_KEY;
  const isApiKeyMissing = !apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '';

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const startRecording = async () => {
    try {
      setError('');
      setUrlInput('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setAudioBlob(audioBlob);
        setFile(null); // Clear any uploaded file
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setError('Could not access microphone. Please ensure permissions are granted.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.size > 20 * 1024 * 1024) { // 20MB limit for browser base64 conversion
        setError('File is too large. Please select a file under 20MB.');
        return;
      }
      setFile(selectedFile);
      setAudioBlob(null); // Clear any recorded audio
      setUrlInput('');
      setError('');
    }
  };

  const clearInput = () => {
    setFile(null);
    setAudioBlob(null);
    setUrlInput('');
    setTranscription('');
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const fileToGenerativePart = async (blob: Blob, mimeType: string): Promise<any> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64Data = (reader.result as string).split(',')[1];
        resolve({
          inlineData: {
            data: base64Data,
            mimeType
          }
        });
      };
      reader.readAsDataURL(blob);
    });
  };

  const handleTranscribe = async () => {
    if (!file && !audioBlob && !urlInput) {
      setError('Please upload a file, record audio, or provide a URL first.');
      return;
    }

    setIsTranscribing(true);
    setError('');
    setTranscription('');

    try {
      let parts: any[] = [];
      let tools: any[] | undefined = undefined;

      const prompt = mode === 'translate' 
        ? 'Please translate the following audio/video to English. Provide only the translated text.'
        : 'Please transcribe the following audio/video in its original language. Provide only the transcription text.';

      if (file || audioBlob) {
        const inputBlob = file || audioBlob;
        const mimeType = file ? file.type : 'audio/webm';
        const audioPart = await fileToGenerativePart(inputBlob!, mimeType);
        parts = [audioPart, { text: prompt }];
      } else if (urlInput) {
        parts = [{ text: `${prompt}\n\nURL: ${urlInput}` }];
        tools = [{ urlContext: {} }];
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: { parts },
        config: tools ? { tools } : undefined,
      });

      setTranscription(response.text || 'No transcription generated.');
    } catch (err: any) {
      console.error('Transcription error:', err);
      let errorMessage = err.message || 'An error occurred during transcription.';
      
      // Try to parse JSON error messages from the API
      try {
        const parsedError = JSON.parse(errorMessage);
        if (parsedError.error && parsedError.error.message) {
          errorMessage = parsedError.error.message;
        }
      } catch (e) {
        // Not a JSON string, keep the original message
      }

      // Provide a more helpful message for API key issues
      if (errorMessage.includes('API key not valid') || errorMessage.includes('API_KEY_INVALID')) {
        errorMessage = 'Invalid API Key. Please ensure your Gemini API Key is correctly set in the AI Studio Secrets panel (the key icon in the menu).';
      }

      setError(errorMessage);
    } finally {
      setIsTranscribing(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcription);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#f5f5f5] font-sans text-gray-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-10 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600 text-white mb-6 shadow-lg">
            <Globe className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-3">Global Transcription</h1>
          <p className="text-gray-500 text-lg">Free, fast, and accurate transcription powered by Gemini AI.</p>
        </header>

        {isApiKeyMissing && (
          <div className="mb-8 p-6 bg-amber-50 border border-amber-200 rounded-2xl flex flex-col sm:flex-row items-start gap-4 shadow-sm">
            <div className="p-3 bg-amber-100 text-amber-600 rounded-xl shrink-0">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-amber-900 mb-1">API Key Required</h3>
              <p className="text-amber-800 mb-3">
                To use this app, you need to provide your own Gemini API key. The app is currently using a placeholder or missing key.
              </p>
              <ol className="list-decimal list-inside text-sm text-amber-700 space-y-1">
                <li>Click the <strong>Secrets</strong> icon (🔑) in the left sidebar of AI Studio.</li>
                <li>Find or create the secret named <code>GEMINI_API_KEY</code>.</li>
                <li>Paste your valid Gemini API key (get one free at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline font-medium hover:text-amber-900">Google AI Studio</a>).</li>
              </ol>
            </div>
          </div>
        )}

        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden mb-8">
          <div className="p-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {/* Record Option */}
              <div className={`relative rounded-2xl border-2 transition-all ${audioBlob ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100 hover:border-gray-200'} p-6 flex flex-col items-center justify-center text-center`}>
                {isRecording ? (
                  <div className="flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-4 animate-pulse">
                      <Mic className="w-8 h-8 text-red-600" />
                    </div>
                    <div className="text-2xl font-mono font-medium text-red-600 mb-4">
                      {formatTime(recordingTime)}
                    </div>
                    <button 
                      onClick={stopRecording}
                      className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-6 py-2.5 rounded-full font-medium transition-colors"
                    >
                      <Square className="w-4 h-4" /> Stop Recording
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                      <Mic className="w-8 h-8 text-gray-600" />
                    </div>
                    <h3 className="font-semibold mb-2">Record Audio</h3>
                    <p className="text-sm text-gray-500 mb-4">Use your microphone to record directly</p>
                    {audioBlob ? (
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-indigo-600 bg-indigo-100 px-3 py-1 rounded-full">
                          Recording saved ({formatTime(recordingTime)})
                        </span>
                        <button onClick={clearInput} className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button 
                        onClick={startRecording}
                        className="flex items-center gap-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-6 py-2.5 rounded-full font-medium transition-colors"
                      >
                        Start Recording
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Upload Option */}
              <div className={`relative rounded-2xl border-2 transition-all ${file ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100 hover:border-gray-200'} p-6 flex flex-col items-center justify-center text-center`}>
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileChange} 
                  accept="audio/*,video/*" 
                  className="hidden" 
                  id="file-upload"
                />
                <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                  <Upload className="w-8 h-8 text-gray-600" />
                </div>
                <h3 className="font-semibold mb-2">Upload File</h3>
                <p className="text-sm text-gray-500 mb-4">Audio or video file (max 20MB)</p>
                
                {file ? (
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-indigo-600 bg-indigo-100 px-3 py-1 rounded-full max-w-[200px]">
                      <FileAudio className="w-4 h-4 shrink-0" />
                      <span className="truncate">{file.name}</span>
                    </div>
                    <button onClick={clearInput} className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <label 
                    htmlFor="file-upload"
                    className="flex items-center gap-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-6 py-2.5 rounded-full font-medium transition-colors cursor-pointer"
                  >
                    Select File
                  </label>
                )}
              </div>

              {/* Paste Link Option */}
              <div className={`relative rounded-2xl border-2 transition-all ${urlInput ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100 hover:border-gray-200'} p-6 flex flex-col items-center justify-center text-center`}>
                <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                  <LinkIcon className="w-8 h-8 text-gray-600" />
                </div>
                <h3 className="font-semibold mb-2">Paste Link</h3>
                <p className="text-sm text-gray-500 mb-4">YouTube, Drive, or media URL</p>
                
                <input
                  type="url"
                  placeholder="https://..."
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setFile(null);
                    setAudioBlob(null);
                  }}
                  className="w-full px-4 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                />
              </div>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-gray-100">
              <div className="flex bg-gray-100 p-1 rounded-full w-full sm:w-auto">
                <button
                  onClick={() => setMode('transcribe')}
                  className={`flex-1 sm:flex-none px-6 py-2 rounded-full text-sm font-medium transition-all ${mode === 'transcribe' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Transcribe
                </button>
                <button
                  onClick={() => setMode('translate')}
                  className={`flex-1 sm:flex-none px-6 py-2 rounded-full text-sm font-medium transition-all ${mode === 'translate' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Translate to English
                </button>
              </div>

              <button
                onClick={handleTranscribe}
                disabled={(!file && !audioBlob && !urlInput) || isTranscribing || isRecording}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white px-8 py-3 rounded-full font-medium transition-colors"
              >
                {isTranscribing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" /> Processing...
                  </>
                ) : (
                  'Start Transcription'
                )}
              </button>
            </div>
          </div>
        </div>

        {transcription && (
          <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <FileAudio className="w-5 h-5 text-indigo-600" />
                Result
              </h3>
              <button
                onClick={copyToClipboard}
                className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 bg-white border border-gray-200 hover:border-gray-300 px-4 py-2 rounded-full transition-all"
              >
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied!' : 'Copy Text'}
              </button>
            </div>
            <div className="p-8">
              <div className="prose prose-indigo max-w-none">
                <p className="whitespace-pre-wrap text-gray-700 leading-relaxed text-lg">
                  {transcription}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
