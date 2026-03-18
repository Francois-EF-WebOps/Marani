import React, { useState, useRef, useEffect } from 'react';
import { 
  Mic, Upload, Square, Copy, Check, Globe, FileAudio, Loader2, 
  AlertCircle, X, Link as LinkIcon, Zap, Shield, RefreshCw, 
  BarChart3, Settings, Info
} from 'lucide-react';

// API base URL (backend server)
const API_BASE = 'http://localhost:3001/api';

// Types
interface TranscriptionResult {
  success: boolean;
  mode: 'BATSY' | 'FLASH';
  transcript: string;
  clean_text: string;
  summary: string;
  key_points: string[];
  hooks: string[];
  metadata: {
    duration?: number;
    chunks?: number;
    provider?: string;
    processingTime: number;
    model?: string;
    confidence?: number;
    wordCount?: number;
  };
  source?: 'cache' | 'processing';
  cached?: boolean;
}

interface ProcessingOptions {
  mode: 'transcribe' | 'translate';
  includeSummary: boolean;
  includeKeyPoints: boolean;
  includeHooks: boolean;
  fastMode: boolean;
  costSavingMode: boolean;
  useCache: boolean;
}

export default function App() {
  // Input state
  const [file, setFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [inputMode, setInputMode] = useState<'file' | 'record' | 'url' | 'text'>('file');
  
  // Processing state
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  
  // Result state
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'text' | 'summary' | null>(null);
  
  // Options
  const [options, setOptions] = useState<ProcessingOptions>({
    mode: 'transcribe',
    includeSummary: true,
    includeKeyPoints: true,
    includeHooks: true,
    fastMode: false,
    costSavingMode: false,
    useCache: true,
  });
  
  // System health
  const [health, setHealth] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Fetch system health on mount
  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      const data = await res.json();
      setHealth(data);
    } catch (error) {
      console.error('Failed to fetch health:', error);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const startRecording = async () => {
    try {
      setError('');
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
        setFile(null);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err: any) {
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
      if (selectedFile.size > MAX_FILE_SIZE) {
        setError(`File is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`);
        return;
      }
      setFile(selectedFile);
      setAudioBlob(null);
      setUrlInput('');
      setTextInput('');
      setError('');
    }
  };

  const clearInput = () => {
    setFile(null);
    setAudioBlob(null);
    setUrlInput('');
    setTextInput('');
    setResult(null);
    setError('');
    setJobId(null);
    setProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const pollJobStatus = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/job/${id}`);
      const data = await res.json();
      
      if (data.job.status === 'completed') {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setResult(data.job.result);
        setIsProcessing(false);
        setProgress(100);
      } else if (data.job.status === 'failed') {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setError(data.job.error || 'Processing failed');
        setIsProcessing(false);
      } else {
        setProgress(data.job.progress || 0);
      }
    } catch (error) {
      console.error('Polling error:', error);
    }
  };

  const handleSubmit = async () => {
    const hasInput = file || audioBlob || urlInput || textInput;
    
    if (!hasInput) {
      setError('Please upload a file, record audio, provide a URL, or enter text.');
      return;
    }

    setIsProcessing(true);
    setError('');
    setResult(null);
    setProgress(0);

    try {
      const formData = new FormData();
      
      if (file) {
        formData.append('audio', file);
      } else if (audioBlob) {
        formData.append('audio', audioBlob, 'recording.webm');
      } else if (urlInput) {
        formData.append('url', urlInput);
      } else if (textInput) {
        formData.append('text', textInput);
      }

      // Add options (convert booleans to strings)
      formData.append('translate', String(options.mode === 'translate'));
      formData.append('includeSummary', String(options.includeSummary));
      formData.append('includeKeyPoints', String(options.includeKeyPoints));
      formData.append('includeHooks', String(options.includeHooks));
      formData.append('fastMode', String(options.fastMode));
      formData.append('costSavingMode', String(options.costSavingMode));
      formData.append('useCache', String(options.useCache));

      const res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Processing failed');
      }

      // If job is queued, poll for status
      if (data.jobId && data.source === 'processing') {
        setJobId(data.jobId);
        pollIntervalRef.current = window.setInterval(() => {
          pollJobStatus(data.jobId);
        }, 1000);
      } else {
        // Immediate result
        setResult(data);
        setIsProcessing(false);
        setProgress(100);
      }
    } catch (err: any) {
      console.error('Processing error:', err);
      setError(err.message || 'An error occurred during processing.');
      setIsProcessing(false);
    }
  };

  const copyToClipboard = async (text: string, field: 'text' | 'summary') => {
    await navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  };

  // Constants
  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
  const MAX_FILE_SIZE_MB = 100;

  const modeInfo = {
    BATSY: {
      icon: Shield,
      color: 'bg-blue-600',
      description: 'Heavy-duty mode for long audio files',
    },
    FLASH: {
      icon: Zap,
      color: 'bg-amber-500',
      description: 'Fast mode for short content',
    },
  };

  return (
    <div className="min-h-screen bg-[#f5f5f5] font-sans text-gray-900 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-10 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600 text-white mb-6 shadow-lg">
            <Globe className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-3">Marani Transcription</h1>
          <p className="text-gray-500 text-lg">Dual-mode AI transcription pipeline</p>
          
          {/* Health indicator */}
          {health && (
            <div className="mt-4 flex items-center justify-center gap-4 text-sm">
              <span className={`flex items-center gap-1 ${health.services.router.batSYAvailable ? 'text-green-600' : 'text-red-600'}`}>
                <Shield className="w-4 h-4" /> BATSY
              </span>
              <span className={`flex items-center gap-1 ${health.services.router.flashAvailable ? 'text-green-600' : 'text-red-600'}`}>
                <Zap className="w-4 h-4" /> FLASH
              </span>
              <span className="text-gray-400">|</span>
              <span className="text-gray-500">Cache: {health.services.cache.entries} entries</span>
              <button 
                onClick={() => setShowSettings(!showSettings)}
                className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700"
              >
                <Settings className="w-4 h-4" /> Settings
              </button>
            </div>
          )}
        </header>

        {/* Settings Panel */}
        {showSettings && (
          <div className="mb-8 p-6 bg-white rounded-2xl shadow-sm border border-gray-100">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Settings className="w-5 h-5" /> Processing Options
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-indigo-300 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={options.fastMode}
                  onChange={(e) => setOptions({ ...options, fastMode: e.target.checked })}
                  className="w-4 h-4 text-indigo-600"
                />
                <div>
                  <div className="font-medium flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" /> Fast Mode
                  </div>
                  <div className="text-sm text-gray-500">Prioritize speed over cost</div>
                </div>
              </label>
              
              <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-indigo-300 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={options.costSavingMode}
                  onChange={(e) => setOptions({ ...options, costSavingMode: e.target.checked })}
                  className="w-4 h-4 text-indigo-600"
                />
                <div>
                  <div className="font-medium flex items-center gap-2">
                    <Shield className="w-4 h-4 text-blue-600" /> Cost Saving Mode
                  </div>
                  <div className="text-sm text-gray-500">Minimize API usage</div>
                </div>
              </label>
              
              <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-indigo-300 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={options.useCache}
                  onChange={(e) => setOptions({ ...options, useCache: e.target.checked })}
                  className="w-4 h-4 text-indigo-600"
                />
                <div>
                  <div className="font-medium flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-green-600" /> Use Cache
                  </div>
                  <div className="text-sm text-gray-500">Skip reprocessing same content</div>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Main Card */}
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden mb-8">
          <div className="p-8">
            {/* Input Mode Tabs */}
            <div className="flex bg-gray-100 p-1 rounded-full mb-8 w-full sm:w-auto inline-flex">
              {[
                { id: 'file', label: 'Upload', icon: Upload },
                { id: 'record', label: 'Record', icon: Mic },
                { id: 'url', label: 'URL', icon: LinkIcon },
                { id: 'text', label: 'Text', icon: FileAudio },
              ].map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => setInputMode(mode.id as any)}
                  className={`flex items-center gap-2 px-6 py-2 rounded-full text-sm font-medium transition-all ${
                    inputMode === mode.id 
                      ? 'bg-white shadow-sm text-gray-900' 
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <mode.icon className="w-4 h-4" />
                  {mode.label}
                </button>
              ))}
            </div>

            {/* Input Options Grid */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
              {/* Record */}
              <div className={`md:col-span-1 rounded-2xl border-2 transition-all ${
                inputMode === 'record' ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100'
              } p-6`}>
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
                      <Square className="w-4 h-4" /> Stop
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                      <Mic className="w-8 h-8 text-gray-600" />
                    </div>
                    <h3 className="font-semibold mb-2">Record Audio</h3>
                    <p className="text-sm text-gray-500 mb-4 text-center">Use your microphone</p>
                    {audioBlob ? (
                      <div className="flex items-center gap-2 text-sm text-indigo-600">
                        <Check className="w-4 h-4" /> Recording saved
                        <button onClick={clearInput} className="p-1 hover:bg-gray-200 rounded">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setInputMode('record'); startRecording(); }}
                        className="text-indigo-600 hover:text-indigo-700 text-sm font-medium"
                      >
                        Start Recording →
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Upload */}
              <div className={`md:col-span-1 rounded-2xl border-2 transition-all ${
                inputMode === 'file' && file ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100'
              } p-6`}>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="audio/*,video/*"
                  className="hidden"
                  id="file-upload"
                />
                <div className="flex flex-col items-center">
                  <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                    <Upload className="w-8 h-8 text-gray-600" />
                  </div>
                  <h3 className="font-semibold mb-2">Upload File</h3>
                  <p className="text-sm text-gray-500 mb-4 text-center">Max {MAX_FILE_SIZE_MB}MB</p>
                  {file ? (
                    <div className="flex items-center gap-2 text-sm text-indigo-600">
                      <Check className="w-4 h-4" /> {file.name.slice(0, 20)}...
                      <button onClick={clearInput} className="p-1 hover:bg-gray-200 rounded">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <label
                      htmlFor="file-upload"
                      className="text-indigo-600 hover:text-indigo-700 text-sm font-medium cursor-pointer"
                    >
                      Select File →
                    </label>
                  )}
                </div>
              </div>

              {/* URL */}
              <div className={`md:col-span-1 rounded-2xl border-2 transition-all ${
                inputMode === 'url' && urlInput ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100'
              } p-6`}>
                <div className="flex flex-col items-center">
                  <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                    <LinkIcon className="w-8 h-8 text-gray-600" />
                  </div>
                  <h3 className="font-semibold mb-2">Paste URL</h3>
                  <p className="text-sm text-gray-500 mb-4 text-center">YouTube, Drive, etc.</p>
                  <input
                    type="url"
                    placeholder="https://..."
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value);
                      setInputMode('url');
                      setFile(null);
                      setAudioBlob(null);
                      setTextInput('');
                    }}
                    className="w-full px-4 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              {/* Text */}
              <div className={`md:col-span-1 rounded-2xl border-2 transition-all ${
                inputMode === 'text' && textInput ? 'border-indigo-600 bg-indigo-50/50' : 'border-gray-100'
              } p-6`}>
                <div className="flex flex-col items-center">
                  <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                    <FileAudio className="w-8 h-8 text-gray-600" />
                  </div>
                  <h3 className="font-semibold mb-2">Paste Text</h3>
                  <p className="text-sm text-gray-500 mb-4 text-center">Existing transcript</p>
                  <textarea
                    placeholder="Paste your text here..."
                    value={textInput}
                    onChange={(e) => {
                      setTextInput(e.target.value);
                      setInputMode('text');
                      setFile(null);
                      setAudioBlob(null);
                      setUrlInput('');
                    }}
                    className="w-full px-4 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                    rows={3}
                  />
                </div>
              </div>
            </div>

            {/* Error Display */}
            {error && (
              <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {/* Processing Options */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-gray-100">
              <div className="flex bg-gray-100 p-1 rounded-full w-full sm:w-auto">
                <button
                  onClick={() => setOptions({ ...options, mode: 'transcribe' })}
                  className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${
                    options.mode === 'transcribe' 
                      ? 'bg-white shadow-sm text-gray-900' 
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Transcribe
                </button>
                <button
                  onClick={() => setOptions({ ...options, mode: 'translate' })}
                  className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${
                    options.mode === 'translate' 
                      ? 'bg-white shadow-sm text-gray-900' 
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Translate
                </button>
              </div>

              <button
                onClick={handleSubmit}
                disabled={(!file && !audioBlob && !urlInput && !textInput) || isProcessing || isRecording}
                className={`w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3 rounded-full font-medium transition-colors ${
                  isProcessing 
                    ? 'bg-gray-200 text-gray-400' 
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                }`}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" /> 
                    {progress > 0 ? `${progress}%` : 'Processing...'}
                  </>
                ) : (
                  'Start Processing'
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Mode Badge */}
            <div className="flex items-center justify-between">
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-white ${modeInfo[result.mode].color}`}>
                {result.mode === 'BATSY' ? <Shield className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
                <span className="font-medium">{result.mode} Mode</span>
                {result.source === 'cache' && (
                  <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">Cached</span>
                )}
              </div>
              <div className="text-sm text-gray-500">
                Processed in {(result.metadata.processingTime / 1000).toFixed(1)}s
                {result.metadata.confidence && (
                  <span className="ml-2">• {(result.metadata.confidence * 100).toFixed(0)}% confidence</span>
                )}
              </div>
            </div>

            {/* Clean Transcript */}
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <FileAudio className="w-5 h-5 text-indigo-600" />
                  Transcript
                </h3>
                <button
                  onClick={() => copyToClipboard(result.clean_text, 'text')}
                  className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 bg-white border border-gray-200 hover:border-gray-300 px-4 py-2 rounded-full transition-all"
                >
                  {copied === 'text' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  {copied === 'text' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="p-8">
                <p className="whitespace-pre-wrap text-gray-700 leading-relaxed">
                  {result.clean_text}
                </p>
              </div>
            </div>

            {/* Summary */}
            {result.summary && (
              <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
                  <h3 className="font-semibold text-gray-900">Summary</h3>
                  <button
                    onClick={() => copyToClipboard(result.summary!, 'summary')}
                    className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 bg-white border border-gray-200 hover:border-gray-300 px-4 py-2 rounded-full transition-all"
                  >
                    {copied === 'summary' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                    {copied === 'summary' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className="p-8">
                  <p className="text-gray-700 leading-relaxed">{result.summary}</p>
                </div>
              </div>
            )}

            {/* Key Points & Hooks Grid */}
            {(result.key_points?.length > 0 || result.hooks?.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {result.key_points && result.key_points.length > 0 && (
                  <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                      <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                        <BarChart3 className="w-5 h-5 text-indigo-600" />
                        Key Points
                      </h3>
                    </div>
                    <div className="p-6">
                      <ul className="space-y-3">
                        {result.key_points.map((point, i) => (
                          <li key={i} className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-sm font-medium">
                              {i + 1}
                            </span>
                            <span className="text-gray-700">{point}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                {result.hooks && result.hooks.length > 0 && (
                  <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                      <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                        <Info className="w-5 h-5 text-amber-600" />
                        Hooks
                      </h3>
                    </div>
                    <div className="p-6">
                      <ul className="space-y-3">
                        {result.hooks.map((hook, i) => (
                          <li key={i} className="flex gap-3">
                            <span className="text-amber-500">"</span>
                            <span className="text-gray-700 italic">{hook}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Metadata */}
            <div className="bg-gray-50 rounded-2xl p-6 text-sm text-gray-500">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {result.metadata.duration && (
                  <div>
                    <div className="font-medium text-gray-700">Duration</div>
                    <div>{result.metadata.duration}s</div>
                  </div>
                )}
                {result.metadata.chunks && (
                  <div>
                    <div className="font-medium text-gray-700">Chunks</div>
                    <div>{result.metadata.chunks}</div>
                  </div>
                )}
                {result.metadata.provider && (
                  <div>
                    <div className="font-medium text-gray-700">Provider</div>
                    <div className="capitalize">{result.metadata.provider}</div>
                  </div>
                )}
                {result.metadata.wordCount && (
                  <div>
                    <div className="font-medium text-gray-700">Words</div>
                    <div>{result.metadata.wordCount.toLocaleString()}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
