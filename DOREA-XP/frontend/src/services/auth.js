// Auth Service

import axios from 'axios';
import { clearProcessingHistorySession, startProcessingHistorySession } from './processingHistorySession'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// Auth context management
let authContext = null;

export function getAuthContext() {
  return authContext;
}

// Login
export async function login(username, password) {
  const response = await axios.post(`${API_BASE_URL}/auth/login`, {
    username_or_email: username,
    password
  });
  
  if (response.data.access_token) {
    localStorage.setItem('access_token', response.data.access_token);
    localStorage.setItem('refresh_token', response.data.refresh_token);
    startProcessingHistorySession();
    
    // 사용자 정보 저장
    const userResponse = await getCurrentUser();
    authContext = userResponse;
    
    return response.data;
  }
  
  throw new Error(response.data.detail || '로그인 실패');
}

// Register
export async function register(username, email, password) {
  const response = await axios.post(`${API_BASE_URL}/auth/register`, {
    username,
    email,
    password
  });
  
  if (response.data.access_token) {
    localStorage.setItem('access_token', response.data.access_token);
    localStorage.setItem('refresh_token', response.data.refresh_token);
    startProcessingHistorySession();
    
    // 사용자 정보 저장
    const userResponse = await getCurrentUser();
    authContext = userResponse;
    
    return response.data;
  }
  
  throw new Error(response.data.detail || '회원가입 실패');
}

// Get current user
export async function getCurrentUser() {
  const token = localStorage.getItem('access_token');
  
  if (!token) {
    authContext = null;
    return null;
  }
  
  const response = await axios.get(`${API_BASE_URL}/auth/me`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  authContext = response.data;
  return response.data;
}

// Logout
export async function logout() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  clearProcessingHistorySession();
  authContext = null;
}
