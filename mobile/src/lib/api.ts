// Cliente API do Echo — fala com FastAPI em https://echo.hovio.com.br
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';

export const API_BASE = 'https://echo.hovio.com.br';

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
});

// Token em memoria: capa, pagina e audio sao carregados por componentes
// nativos (expo-image, track-player) que precisam do header na hora, sem
// poder esperar o SecureStore (que e assincrono).
let tokenEmMemoria: string | null = null;

export async function initAuthToken(): Promise<string | null> {
  tokenEmMemoria = await SecureStore.getItemAsync('echo_token').catch(() => null);
  return tokenEmMemoria;
}

/** Header de autenticacao para midia. Sem cookie no mobile — aqui e Bearer. */
export function authHeaders(): Record<string, string> | undefined {
  return tokenEmMemoria ? { Authorization: `Bearer ${tokenEmMemoria}` } : undefined;
}

// Inject Bearer token em toda request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('echo_token');
  if (token) {
    tokenEmMemoria = token;
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 401 → limpar token e levar pra login
api.interceptors.response.use(
  (r) => r,
  async (err) => {
    if (err.response?.status === 401) {
      // A sessão vence (30 dias, renovados pelo uso). Sem mandar para o login
      // aqui, o app ficaria numa tela de leitura que não carrega mais nada.
      tokenEmMemoria = null;
      await SecureStore.deleteItemAsync('echo_token').catch(() => {});
      try { router.replace('/login'); } catch {}
    }
    return Promise.reject(err);
  }
);

// === Auth ===
export async function login(email: string, password: string) {
  const r = await api.post('/api/auth/login', { email, password });
  tokenEmMemoria = r.data.token;
  await SecureStore.setItemAsync('echo_token', r.data.token);
  return r.data;
}

export async function register(name: string, email: string, password: string) {
  const r = await api.post('/api/auth/register', { name, email, password });
  tokenEmMemoria = r.data.token;
  await SecureStore.setItemAsync('echo_token', r.data.token);
  return r.data;
}

export async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  tokenEmMemoria = null;
  await SecureStore.deleteItemAsync('echo_token');
}

export async function getMe() {
  const r = await api.get('/api/auth/me');
  return r.data;
}

// === Documents ===
export type DocSummary = {
  id: string;
  title: string;
  total_pages: number;
  total_chunks: number;
  has_cover?: boolean;
  current_chunk?: number;
};

export type Chunk = {
  index: number;
  page: number;
  text: string;
  has_audio: boolean;
  duration_ms?: number;
};

export type DocDetail = {
  document: DocSummary;
  chunks: Chunk[];
  progress?: { current_chunk: number; position_ms: number };
  audio_ready: number;
  audio_total: number;
};

export async function listDocuments(): Promise<DocSummary[]> {
  const r = await api.get('/api/documents');
  return r.data.documents || [];
}

export async function getDocument(id: string): Promise<DocDetail> {
  const r = await api.get(`/api/documents/${id}`);
  return r.data;
}

export type TocItem = { level: number; title: string; page: number };

export async function getToc(docId: string): Promise<TocItem[]> {
  const r = await api.get(`/api/documents/${docId}/toc`);
  return r.data.toc || [];
}

// === Vozes ===
// As três pt-BR do Edge. A escolhida fica na CONTA (users.voice), então o
// app e a web mostram a mesma voz — localStorage não atravessaria aparelho.
export type Voz = { name: string; label: string; gender: string; locale: string };

export async function getVoices(): Promise<{ voices: Voz[]; selected: string }> {
  const r = await api.get('/api/voices', { params: { language: 'pt-BR' } });
  return { voices: r.data.voices || [], selected: r.data.selected };
}

export async function saveVoice(voice: string) {
  const r = await api.put('/api/voices/selected', { voice });
  return r.data;
}

export async function getChunkAudio(docId: string, chunkIndex: number, voice = '') {
  const r = await api.post(`/api/documents/${docId}/chunks/${chunkIndex}/audio`, null, {
    params: { rate: '+0%', pitch: '+0Hz', voice },
  });
  return r.data as {
    audio_url: string;
    boundaries: Array<{ offset_ms: number; duration_ms: number; text: string }>;
    text: string;
    cached: boolean;
    chunk_index: number;
    page: number;
  };
}

export async function getPageWords(docId: string, page: number) {
  const r = await api.get(`/api/documents/${docId}/pages/${page}/words`);
  return r.data.words as Array<{
    word: string;
    x0: number; y0: number; x1: number; y1: number;
  }>;
}

export async function saveProgress(docId: string, chunkIndex: number, positionMs = 0) {
  return api.put(`/api/documents/${docId}/progress`, null, {
    params: { current_chunk: chunkIndex, position_ms: positionMs },
  });
}

// A midia agora exige sessao no servidor. Na web quem autentica e o cookie
// httponly (img/audio nao mandam header); aqui nao ha cookie, entao vai o
// mesmo Bearer por header — expo-image aceita headers no source e o
// track-player aceita headers na track.
export function audioUrl(filename: string) {
  return `${API_BASE}${filename}`;
}

export function pageImageUrl(docId: string, page: number) {
  return { uri: `${API_BASE}/api/documents/${docId}/pages/${page}.png`, headers: authHeaders() };
}

export function coverUrl(docId: string) {
  return { uri: `${API_BASE}/api/covers/${docId}.png`, headers: authHeaders() };
}
