// Cliente API do Echo — fala com FastAPI em https://echo.hovio.com.br
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

export const API_BASE = 'https://echo.hovio.com.br';

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
});

// Inject Bearer token em toda request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('echo_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 401 → limpar token e levar pra login
api.interceptors.response.use(
  (r) => r,
  async (err) => {
    if (err.response?.status === 401) {
      await SecureStore.deleteItemAsync('echo_token');
    }
    return Promise.reject(err);
  }
);

// === Auth ===
export async function login(email: string, password: string) {
  const r = await api.post('/api/auth/login', { email, password });
  await SecureStore.setItemAsync('echo_token', r.data.token);
  return r.data;
}

export async function register(name: string, email: string, password: string) {
  const r = await api.post('/api/auth/register', { name, email, password });
  await SecureStore.setItemAsync('echo_token', r.data.token);
  return r.data;
}

export async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
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

export function audioUrl(filename: string) {
  return `${API_BASE}${filename}`;
}

export function pageImageUrl(docId: string, page: number) {
  return `${API_BASE}/api/documents/${docId}/pages/${page}.png`;
}

export function coverUrl(docId: string) {
  return `${API_BASE}/api/covers/${docId}.png`;
}
