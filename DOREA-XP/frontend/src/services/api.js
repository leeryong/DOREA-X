// API Service

import axios from 'axios';
import { toast } from './toast';
import { clearProcessingHistorySession } from './processingHistorySession'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

const parseAuthoredAssetPath = (relativePath) => {
  if (typeof relativePath !== 'string') return null

  let assetName = null
  const relativeMatch = relativePath.match(/^\.\/assets\/([^/\\]+)$/)
  if (relativeMatch) {
    assetName = relativeMatch[1]
  } else {
    try {
      const url = new URL(relativePath, window.location.origin)
      const absoluteMatch = url.pathname.match(/^\/assets\/([^/\\]+)$/)
      assetName = absoluteMatch?.[1] ? decodeURIComponent(absoluteMatch[1]) : null
    } catch {
      assetName = null
    }
  }

  if (!assetName) return null
  // Reject traversal patterns
  if (assetName.includes('..') || assetName.includes('%2e') || assetName.includes('%2f') || assetName.includes('%5c')) {
    return null
  }
  return { assetName }
}

const parseDownloadFilename = (contentDisposition) => {
  if (typeof contentDisposition !== 'string' || !contentDisposition.trim()) return null

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim()
    } catch {
      return utf8Match[1].trim()
    }
  }

  const basicMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
  return basicMatch?.[1]?.trim() || null
}

// Request interceptor to add auth token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor: normalize API errors
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status
    const data = err?.response?.data
    const error_code = data?.error_code

    const message = data?.message || data?.detail || err?.message || '요청 처리 중 오류가 발생했습니다'
    const request_id = data?.request_id || err?.response?.headers?.['x-request-id']

    // Show toast for user-visible failures (skip if request opted out via _silent)
    if (status && status !== 401 && !err?.config?._silent) {
      (String(error_code || '').endsWith('_NOT_READY') ? toast.info : toast.error)(message, { request_id, error_code, status })
    }

    const authFailureCodes = new Set([
      'AUTH_INVALID_TOKEN',
      'AUTH_TOKEN_EXPIRED',
      'AUTH_NOT_AUTHENTICATED',
    ])
    const shouldForceLogout = status === 401 || (status === 403 && authFailureCodes.has(String(error_code || '')))
    if (shouldForceLogout) {
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
      clearProcessingHistorySession()
      toast.error('로그인이 필요합니다.', { request_id, error_code, status })
      if (window.location.pathname !== '/') window.location.href = '/'
    }

    return Promise.reject(err)
  }
)


export default api;

// File APIs
export const filesAPI = {
  upload: async (file, onProgress, knowledgeDbId) => {
    const formData = new FormData();
    formData.append('file', file);
    if (knowledgeDbId != null) {
      formData.append('knowledge_db_id', String(knowledgeDbId));
    }
    
    const response = await api.post('/files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(percent);
        }
      }
    });
    
    return response.data;
  },
  
  list: async (skip = 0, limit = 50, knowledgeDbId = null) => {
    const params = new URLSearchParams({
      skip: String(skip),
      limit: String(limit),
    })
    if (knowledgeDbId != null) {
      params.set('knowledge_db_id', String(knowledgeDbId))
    }
    const response = await api.get(`/files/?${params.toString()}`);
    return response.data;
  },
  
  get: async (fileId) => {
    const response = await api.get(`/files/${fileId}`);
    return response.data;
  },
  
  delete: async (fileId) => {
    const response = await api.delete(`/files/${fileId}`);
    return response.data;
  },
  
  getSegments: async (fileId) => {
    const response = await api.get(`/files/${fileId}/segments`);
    return response.data;
  },

  fetchSegmentPreviewBlob: async (fileId, segmentId) => {
    const response = await api.get(`/files/${fileId}/segments/${encodeURIComponent(segmentId)}/preview`, {
      responseType: 'blob',
      _silent: true,
    })
    return response.data
  },

  fetchPagePreviewBlob: async (fileId, pageNum) => {
    const response = await api.get(`/files/${fileId}/pages/${encodeURIComponent(pageNum)}/preview`, {
      responseType: 'blob',
      _silent: true,
    })
    return response.data
  },

  getViewerProfile: async (fileId) => {
    const response = await api.get(`/files/${fileId}/viewer-profile`, { _silent: true })
    return response.data
  },
  
  getPdfUrl: (fileId) => {
    return `${API_BASE_URL}/files/${fileId}/document.pdf`;
  },
  
  reprocess: async (fileId, { analysisProvider = null, silent } = {}) => {
    const body = analysisProvider ? { analysis_provider: analysisProvider } : null
    const response = await api.post(`/files/${fileId}/reprocess`, body, silent ? { _silent: true } : undefined);
    return response.data;
  },

  cancelAnalysis: async (fileId) => {
    const response = await api.post(`/files/${fileId}/cancel-analysis`)
    return response.data
  },
  
  getDeleteImpact: async (fileId) => {
    const response = await api.get(`/files/${fileId}/delete-impact`);
    return response.data;
  },

  // ========== Authored Document (Editor) APIs ==========
  saveAuthored: async (content, filename, fileId = null) => {
    const params = fileId ? `?file_id=${fileId}` : ''
    const response = await api.post(`/files/authored${params}`, { content, filename })
    return response.data
  },

  getAuthoredContent: async (fileId) => {
    const response = await api.get(`/files/authored/${fileId}/content`)
    return response.data
  },

  // ========== Authored Asset APIs ==========

  /**
   * Upload an image asset for an authored document.
   * @param {string} fileId - The authored document's file ID
   * @param {File} file - The image file to upload
   * @param {Function} [onProgress] - Optional upload progress callback (0-100)
   * @returns {Promise<{asset_name: string, markdown: string, size: number, mime_type: string}>}
   */
  uploadAuthoredAsset: async (fileId, file, onProgress) => {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post(`/files/authored/${fileId}/assets`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent)
        }
      }
    })
    return response.data
  },

  /**
   * Fetch an authored-document asset as a Blob (with Authorization header).
   * @param {string} fileId - The authored document's file ID
   * @param {string} assetName - The server-generated asset filename
   * @returns {Promise<Blob>}
   */
  fetchAuthoredAssetBlob: async (fileId, assetName) => {
    const response = await api.get(
      `/files/authored/${fileId}/assets/${encodeURIComponent(assetName)}`,
      { responseType: 'blob' }
    )
    return response.data
  },

  syncAuthoredAssets: async (fileId, content) => {
    const response = await api.post(`/files/authored/${fileId}/assets/sync`, { content }, { _silent: true })
    return response.data
  },

  /**
   * Parse a relative asset path from authored markdown into its asset name.
   * Only accepts the canonical form `./assets/<name>`.
   * @param {string} relativePath - e.g. "./assets/my-image-20260319-120000-abc12345.png"
   * @returns {{ assetName: string } | null} - null if path is invalid
   */
  parseAuthoredAssetPath: (relativePath) => {
    return parseAuthoredAssetPath(relativePath)
  },

  createDraft: async () => {
    const response = await api.post('/files/drafts')
    return response.data
  },

  cleanupDrafts: async () => {
    const response = await api.delete('/files/drafts', { _silent: true })
    return response.data
  },

  uploadDraftAsset: async (draftId, file, onProgress) => {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post(`/files/drafts/${encodeURIComponent(draftId)}/assets`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent)
        }
      }
    })
    return response.data
  },

  fetchDraftAssetBlob: async (draftId, assetName) => {
    const response = await api.get(
      `/files/drafts/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(assetName)}`,
      { responseType: 'blob' }
    )
    return response.data
  },

  commitDraft: async (draftId, content, filename) => {
    const response = await api.post(`/files/drafts/${encodeURIComponent(draftId)}/commit`, { content, filename })
    return response.data
  },
};

export const myDocumentsAPI = {
  list: async (skip = 0, limit = 50) => {
    const response = await api.get(`/files/my-documents/?skip=${skip}&limit=${limit}`)
    return response.data
  },

  get: async (fileId) => {
    const response = await api.get(`/files/my-documents/${fileId}`)
    return response.data
  },

  getPdfUrl: (fileId) => {
    return `${API_BASE_URL}/files/my-documents/${fileId}/document.pdf`
  },

  fetchPagePreviewBlob: async (fileId, pageNum) => {
    const response = await api.get(`/files/my-documents/${fileId}/pages/${encodeURIComponent(pageNum)}/preview`, {
      responseType: 'blob',
      _silent: true,
    })
    return response.data
  },

  getViewerProfile: async (fileId) => {
    const response = await api.get(`/files/my-documents/${fileId}/viewer-profile`, { _silent: true })
    return response.data
  },

  downloadOriginal: async (fileId) => {
    const response = await api.get(`/files/my-documents/${fileId}/download`, {
      responseType: 'blob'
    })
    return {
      blob: response.data,
      filename: parseDownloadFilename(response.headers?.['content-disposition']),
    }
  },

  upload: async (file, onProgress) => {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post('/files/my-documents/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent)
        }
      }
    })

    return response.data
  },

  delete: async (fileId) => {
    const response = await api.delete(`/files/my-documents/${fileId}`)
    return response.data
  },

  saveAuthored: async (content, filename, fileId = null) => {
    const params = fileId ? `?file_id=${fileId}` : ''
    const response = await api.post(`/files/authored${params}`, { content, filename })
    return response.data
  },

  getContent: async (fileId) => {
    const response = await api.get(`/files/authored/${fileId}/content`)
    return response.data
  },

  uploadAsset: async (fileId, file, onProgress) => {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post(`/files/authored/${fileId}/assets`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent)
        }
      }
    })
    return response.data
  },

  syncAssets: async (fileId, content) => {
    const response = await api.post(`/files/authored/${fileId}/assets/sync`, { content }, { _silent: true })
    return response.data
  },

  fetchAssetBlob: async (fileId, assetName) => {
    const response = await api.get(
      `/files/authored/${fileId}/assets/${encodeURIComponent(assetName)}`,
      { responseType: 'blob' }
    )
    return response.data
  },

  parseAssetPath: (relativePath) => {
    return parseAuthoredAssetPath(relativePath)
  },

  promoteToAnalysis: async (fileId, knowledgeDbId, analysisProvider = null) => {
    const response = await api.post(`/files/my-documents/${fileId}/analyze`, {
      knowledge_db_id: knowledgeDbId || null,
      analysis_provider: analysisProvider || null,
    })
    return response.data
  },

  moveToMyDocuments: async (fileId) => {
    const response = await api.post(`/files/${fileId}/move-to-my-documents`)
    return response.data
  }
}

// Folder APIs
export const foldersAPI = {
  list: async () => {
    const response = await api.get('/folders/');
    return response.data;
  },
  
  create: async (name, description, parentId) => {
    const response = await api.post('/folders/', {
      name,
      description,
      parent_id: parentId
    });
    return response.data;
  },
  
  delete: async (folderId) => {
    const response = await api.delete(`/folders/${folderId}`);
    return response.data;
  }
};

// Chat APIs
export const chatsAPI = {
  // 사용자 전체 세션 목록 (파일 무관)
  listAllSessions: async (skip = 0, limit = 50) => {
    const response = await api.get(`/chats/sessions?skip=${skip}&limit=${limit}`);
    return response.data;
  },
  
  // 특정 파일의 세션 목록
  listSessions: async (fileId) => {
    const response = await api.get(`/chats/files/${fileId}`);
    return response.data;
  },
  
  createSession: async (fileId, sessionName) => {
    const response = await api.post('/chats/sessions', {
      file_id: fileId,
      session_name: sessionName
    });
    return response.data;
  },
  
  getMessages: async (sessionId) => {
    const response = await api.get(`/chats/sessions/${sessionId}/messages`);
    return response.data;
  },
  
  sendMessage: async (sessionId, content, selectedSegments, knowledgeDb, _memoryTempOff = false, mcpSkills = null, modelOverride = null) => {
    const body = {
      content,
      selected_segments: selectedSegments
    }
    if (knowledgeDb && knowledgeDb !== 'none') {
      body.knowledge_db = knowledgeDb
    }
    if (mcpSkills && Array.isArray(mcpSkills) && mcpSkills.length > 0) {
      body.mcp_skills = mcpSkills.map((s) => ({ id: s.id, name: s.name, display_name: s.display_name, server_type: s.server_type, description: s.description }))
    }
    if (modelOverride?.provider && modelOverride?.model) {
      body.model_override = { provider: modelOverride.provider, model: modelOverride.model }
    }
    const response = await api.post(`/chats/sessions/${sessionId}/messages`, body);
    return response.data;
  },
  
  deleteSession: async (sessionId) => {
    const response = await api.delete(`/chats/sessions/${sessionId}`);
    return response.data;
  },

  clearSessionMessages: async (sessionId) => {
    const response = await api.delete(`/chats/sessions/${sessionId}/messages`);
    return response.data;
  },
  
  deleteAllSessions: async () => {
    const response = await api.delete('/chats/sessions/all');
    return response.data;
  },
  
  renameSession: async (sessionId, sessionName) => {
    const response = await api.patch(`/chats/sessions/${sessionId}/rename`, {
      session_name: sessionName
    });
    return response.data;
  },
  
  // 첨부파일 API
  uploadAttachment: async (sessionId, file, metadataOrProgress, onProgress) => {
    const metadata = typeof metadataOrProgress === 'function' ? null : metadataOrProgress
    const progressHandler = typeof metadataOrProgress === 'function' ? metadataOrProgress : onProgress
    const formData = new FormData();
    formData.append('file', file);
    if (metadata && typeof metadata === 'object') {
      formData.append('metadata', JSON.stringify(metadata))
    }
    
    const response = await api.post(`/chats/sessions/${sessionId}/attachments`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      onUploadProgress: (progressEvent) => {
        if (progressHandler && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          progressHandler(percent);
        }
      }
    });
    return response.data;
  },
  
  getAttachmentUrl: (sessionId, attachmentId) => {
    return `${API_BASE_URL}/chats/sessions/${sessionId}/attachments/${attachmentId}`;
  },
  
  /**
   * Fetch attachment as blob (with Authorization header)
   * Use this instead of <img src={getAttachmentUrl()}> to avoid 401/403 issues
   * @param {number|string} sessionId
   * @param {string} attachmentId
   * @returns {Promise<Blob>}
   */
  fetchAttachmentBlob: async (sessionId, attachmentId) => {
    const response = await api.get(
      `/chats/sessions/${sessionId}/attachments/${attachmentId}`,
      { responseType: 'blob' }
    );
    return response.data;
  },
  
  deleteAttachment: async (sessionId, attachmentId) => {
    const response = await api.delete(`/chats/sessions/${sessionId}/attachments/${attachmentId}`);
    return response.data;
  },

  /**
   * Send message with SSE streaming
   * @param {number} sessionId
   * @param {string} content
   * @param {Array} selectedSegments
   * @param {Object} callbacks - { onStart, onDelta, onDone, onError, onProposal, onBrowserNavigate, onToolUse, onToolResult, onAgentStatus }
   * @returns {AbortController} - Call .abort() to cancel
   */
  sendMessageStream: (sessionId, content, selectedSegments, callbacks = {}, knowledgeDb = null, _memoryTempOff = false, mcpSkills = null, editorCommand = null, centerPanelMode = null, viewingContext = null, includeDocumentContent = false, modelOverride = null) => {
    const { onStart, onDelta, onDone, onError, onProposal, onToolUse, onToolResult, onAgentStatus } = callbacks;
    const controller = new AbortController();
    const token = localStorage.getItem('access_token');

    (async () => {
      try {
        const body = {
          content,
          selected_segments: selectedSegments,
          stream: true
        }
        if (knowledgeDb && knowledgeDb !== 'none') {
          body.knowledge_db = knowledgeDb
        }
        if (mcpSkills && Array.isArray(mcpSkills) && mcpSkills.length > 0) {
          body.mcp_skills = mcpSkills.map((s) => ({ id: s.id, name: s.name, display_name: s.display_name, server_type: s.server_type, description: s.description }))
        }
        if (editorCommand && typeof editorCommand === 'object') {
          body.editor_command = editorCommand
        }
        if (centerPanelMode) {
          body.center_panel_mode = centerPanelMode
        }
        if (viewingContext && typeof viewingContext === 'object') {
          body.viewing_context = viewingContext
        }
        if (includeDocumentContent) {
          body.include_document_content = true
        }
        if (modelOverride?.provider && modelOverride?.model) {
          body.model_override = { provider: modelOverride.provider, model: modelOverride.model }
        }
        const response = await fetch(`${API_BASE_URL}/chats/sessions/${sessionId}/messages/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const detail = errorData?.detail
          const errorMessage = (typeof detail === 'object' ? detail?.message : detail) || errorData?.message || `HTTP ${response.status}`;
          const errorCode = (typeof detail === 'object' ? detail?.error_code : null) || errorData?.error_code || ''
          onError?.({ message: errorMessage, error_code: errorCode, status: response.status });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = null; // Persist across reads — SSE event/data lines may arrive in separate TCP packets

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          
          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              try {
                const data = JSON.parse(dataStr);
                
                if (currentEvent === 'start') {
                  onStart?.(data);
                } else if (currentEvent === 'agent_status') {
                  onAgentStatus?.(data);
                } else if (currentEvent === 'delta') {
                  onDelta?.(data);
                } else if (currentEvent === 'done') {
                  onDone?.(data);
                } else if (currentEvent === 'error') {
                  onError?.(data);
                } else if (currentEvent === 'browser_navigate') {
                  onBrowserNavigate?.(data);
                } else if (currentEvent === 'tool_use') {
                  onToolUse?.(data);
                } else if (currentEvent === 'tool_result') {
                  onToolResult?.(data);
                } else if (currentEvent?.endsWith('_proposal')) {
                  // Handle all proposal event types: edit_proposal, rewrite_proposal, style_proposal, replace_proposal
                  onProposal?.({ ...data, proposal_type: currentEvent });
                }
              } catch (e) {
                // Ignore JSON parse errors
              }
              currentEvent = null;
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          // Cancelled by user - don't call onError
          return;
        }
        onError?.({ message: err.message || '스트리밍 연결 오류' });
      }
    })();

    return controller;
  }
};

// Quick Actions (사용자별 빠른 메뉴) APIs
export const quickActionsAPI = {
  get: async () => {
    const response = await api.get('/settings/user/quick-actions');
    return response.data;
  },
  update: async (actions) => {
    const response = await api.put('/settings/user/quick-actions', {
      actions,
    });
    return response.data;
  },
  reset: async () => {
    const response = await api.post('/settings/user/quick-actions/reset');
    return response.data;
  },
};

// ===== User Persona Settings API =====
export const userPersonaAPI = {
  /** 사용자 커스텀 페르소나 조회 */
  getPersona: async () => {
    const response = await api.get('/auth/me/settings');
    return response.data;
  },
  /** 사용자 커스텀 페르소나 업데이트 */
  updatePersona: async (personaMarkdown) => {
    const response = await api.put('/auth/me/settings', {
      persona_custom_markdown: personaMarkdown
    });
    return response.data;
  },
};

// ===== Admin AI Model Settings API =====
export const adminAiSettingsAPI = {
  /** 관리자 기본 페르소나 및 AI 모델 설정 조회 */
  getSettings: async () => {
    const response = await api.get('/settings/system/ai-model');
    return response.data;
  },
  /** 관리자 기본 페르소나 및 AI 모델 설정 업데이트 */
  updateSettings: async (data) => {
    const response = await api.put('/settings/system/ai-model', data);
    return response.data;
  },
  /** 관리자 기본 페르소나만 업데이트 */
  updatePersona: async (personaMarkdown) => {
    const response = await api.put('/settings/system/ai-model', {
      persona_default_markdown: personaMarkdown
    });
    return response.data;
  },
};

// ===== MCP API (KISTI-MCP read-only entries only) =====
export const mcpAPI = {
  listServers: async () => {
    const response = await api.get('/mcp/servers');
    return response.data;
  },
  listMyServers: async () => {
    const response = await api.get('/mcp/servers/me');
    return response.data;
  },
  health: async () => {
    const response = await api.get('/mcp/health');
    return response.data;
  },
  updatePreference: async (serverId, enabled) => {
    const response = await api.put(`/mcp/preferences/${serverId}`, { enabled });
    return response.data;
  },
  // MCP secret management — multi-key (admin only)
  updateSecret: async (serverId, secrets) => {
    const response = await api.put(`/mcp/servers/${serverId}/secret`, { secrets });
    return response.data;
  },
  getSecretStatus: async (serverId) => {
    const response = await api.get(`/mcp/servers/${serverId}/secret-status`);
    return response.data;
  },
};

// ===== Settings (Public) API =====
export const settingsPublicAPI = {
  /** 현재 문서 분석 provider 조회 (DOREA-XP: opendataloader 고정) */
  getAnalysisProvider: async () => {
    const response = await api.get('/settings/system/analysis-provider');
    return response.data;
  },
};

// ===== RHWP (한글) Service =====
// nginx가 /rhwp-api/* → rhwp-service:7700/api/*로 프록시한다. 인증/토큰 흐름
// 밖이라 fetch를 직접 쓴다 (axios 인터셉터의 Bearer 토큰 부착 없음).
export const rhwpAPI = {
  /** 빈 HWPX 바이트(ArrayBuffer)를 생성해 반환. 채팅에서 "넣어줘"가 왔는데
   * 에디터에 문서가 없을 때 자동으로 빈 문서를 띄울 용도. */
  fetchBlankHwpx: async (filename = '새 한글 문서.hwpx') => {
    const r = await fetch('/rhwp-api/blank-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, format: 'hwpx' }),
    });
    if (!r.ok) throw new Error(`blank-document failed: HTTP ${r.status}`);
    return r.arrayBuffer();
  },
};

